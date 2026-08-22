import { prisma } from "../utils/db";
import {
    recordFederationPlaylistCopy,
    recordFederationPlaylistFetch,
    recordFederationPlaylistFollow,
    type FederationPlaylistFetchOutcome,
} from "../metrics";
import type { FederationPlaylistTrack } from "../utils/federationPlaylistSchemas";
import {
    createFederationClient,
    FederationHttpError,
    FederationResponseError,
} from "./federationClient";
import { outboundClientOptions } from "./federationPeers";
import { playlistImportService } from "./playlistImportService";
import {
    formatPlaylistDetailTrack,
    normalizeLocalTrack,
    type UnifiedLocalTrackRecord,
} from "./unifiedTrackResponse";

const PEER_LIMIT = 500;
const FAN_OUT_CONCURRENCY = 3;
const PEER_PLAYLIST_TIMEOUT_MS = 5_000;
const REMOTE_PAGE_LIMIT = 100;

type ActivePeer = {
    id: string;
    name: string;
    baseUrl: string;
    outboundToken: string;
};
type FollowRecord = {
    id: string;
    peerId: string;
    remoteId: string;
    name: string;
    createdAt: Date;
    peer: {
        id: string;
        name: string;
        baseUrl: string | null;
        outboundToken: string | null;
        outboundStatus: string | null;
        scopes: string[];
    };
};
type ResolvedTrackIdentity = {
    id: string;
    remoteId: string | null;
    dedupOfTrackId: string | null;
};

const resolvedTrackPayloadSelect = {
    id: true,
    title: true,
    duration: true,
    trackNo: true,
    loudnessLufs: true,
    truePeakDb: true,
    filePath: true,
    displayTitle: true,
    origin: true,
    federationPeer: {
        select: { id: true, name: true, outboundStatus: true },
    },
    album: {
        select: {
            id: true,
            title: true,
            coverUrl: true,
            albumLoudnessLufs: true,
            albumTruePeakDb: true,
            artist: { select: { id: true, name: true, mbid: true } },
        },
    },
} as const;

/** Closed consumer-visible peer playlist dependency error vocabulary. */
export type PeerPlaylistErrorClass = Exclude<
    FederationPlaylistFetchOutcome,
    "success"
>;

/** Stable failure used by single-peer playlist operations. */
export class PeerPlaylistError extends Error {
    constructor(readonly errorClass: PeerPlaylistErrorClass) {
        super("Peer playlist request failed");
        this.name = "PeerPlaylistError";
    }
}

function classifyPeerError(error: unknown): PeerPlaylistErrorClass {
    if (error instanceof FederationResponseError) return "invalid_response";
    if (error instanceof FederationHttpError) {
        if (
            error.transportCode === "ETIMEDOUT" ||
            error.transportCode === "ECONNABORTED" ||
            error.transportCode === "ERR_CANCELED"
        ) {
            return "timeout";
        }
        if (error.status === 401 || error.status === 403) return "unauthorized";
        if (error.status === 404) return "not_found";
        if (error.status === null) return "offline";
        return "failure";
    }
    const code =
        typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : "";
    if (code === "ETIMEDOUT" || error instanceof DOMException) return "timeout";
    return "failure";
}

async function activeSocialPeers(): Promise<ActivePeer[]> {
    return prisma.federationPeer.findMany({
        where: {
            direction: { in: ["CONSUMER", "BOTH"] },
            outboundStatus: "ACTIVE",
            scopes: { has: "social:read" },
            baseUrl: { not: null },
            outboundToken: { not: null },
        },
        orderBy: { id: "asc" },
        take: PEER_LIMIT,
        select: {
            id: true,
            name: true,
            baseUrl: true,
            outboundToken: true,
        },
    }) as Promise<ActivePeer[]>;
}

async function activeSocialPeer(peerId: string): Promise<ActivePeer | null> {
    return prisma.federationPeer.findFirst({
        where: {
            id: peerId,
            direction: { in: ["CONSUMER", "BOTH"] },
            outboundStatus: "ACTIVE",
            scopes: { has: "social:read" },
            baseUrl: { not: null },
            outboundToken: { not: null },
        },
        select: {
            id: true,
            name: true,
            baseUrl: true,
            outboundToken: true,
        },
    }) as Promise<ActivePeer | null>;
}

async function mapWithPeerConcurrency<T, R>(
    values: readonly T[],
    worker: (value: T) => Promise<R>,
): Promise<R[]> {
    if (values.length > PEER_LIMIT) throw new RangeError("Too many peers");
    const results = new Array<R>(values.length);
    let nextIndex = 0;
    async function runWorker(): Promise<void> {
        for (let attempt = 0; attempt < PEER_LIMIT; attempt += 1) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= values.length) return;
            results[index] = await worker(values[index]);
        }
    }
    const workerCount = Math.min(FAN_OUT_CONCURRENCY, values.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return results;
}

function peerClient(peer: ActivePeer) {
    return createFederationClient(peer, outboundClientOptions());
}

async function fetchPlaylistPage(peer: ActivePeer) {
    const signal = AbortSignal.timeout(PEER_PLAYLIST_TIMEOUT_MS);
    try {
        const page = await peerClient(peer).getPlaylists(
            { offset: 0, limit: REMOTE_PAGE_LIMIT },
            signal,
        );
        recordFederationPlaylistFetch(peer.id, "success");
        return {
            playlists: page.playlists.map((playlist) => ({
                ...playlist,
                peer: { id: peer.id, name: peer.name },
            })),
            peerError: null,
        };
    } catch (error) {
        const errorClass = classifyPeerError(error);
        recordFederationPlaylistFetch(peer.id, errorClass);
        return {
            playlists: [],
            peerError: { peerId: peer.id, peerName: peer.name, errorClass },
        };
    }
}

/** Fans out one bounded page request to active social-scoped peers. */
export async function browseFederationPeerPlaylists() {
    const peers = await activeSocialPeers();
    const results = await mapWithPeerConcurrency(peers, fetchPlaylistPage);
    return {
        playlists: results.flatMap((result) => result.playlists),
        errors: results.flatMap((result) =>
            result.peerError ? [result.peerError] : [],
        ),
    };
}

async function fetchPeerPlaylist(peer: ActivePeer, remoteId: string) {
    const signal = AbortSignal.timeout(PEER_PLAYLIST_TIMEOUT_MS);
    try {
        const detail = await peerClient(peer).getPlaylist(remoteId, signal);
        recordFederationPlaylistFetch(peer.id, "success");
        return detail;
    } catch (error) {
        const errorClass = classifyPeerError(error);
        recordFederationPlaylistFetch(peer.id, errorClass);
        throw new PeerPlaylistError(errorClass);
    }
}

async function requireActivePeer(peerId: string): Promise<ActivePeer> {
    const peer = await activeSocialPeer(peerId);
    if (!peer) throw new PeerPlaylistError("offline");
    return peer;
}

async function loadResolvedTrackPayloads(trackIds: readonly string[]) {
    if (trackIds.length === 0)
        return new Map<string, Record<string, unknown>>();
    const rows = await prisma.track.findMany({
        where: { id: { in: [...trackIds] }, removedAt: null },
        select: resolvedTrackPayloadSelect,
    });
    return new Map(
        rows.map((row) => [
            row.id,
            formatPlaylistDetailTrack(
                normalizeLocalTrack(row as UnifiedLocalTrackRecord),
            ),
        ]),
    );
}

function resolvedTrackIds(
    tracks: readonly FederationPlaylistTrack[],
    byRemoteId: ReadonlyMap<string | null, ResolvedTrackIdentity>,
): string[] {
    return [
        ...new Set(
            tracks.flatMap((track) => {
                const row = byRemoteId.get(track.remoteTrackId);
                if (!row) return [];
                return row.dedupOfTrackId
                    ? [row.dedupOfTrackId, row.id]
                    : [row.id];
            }),
        ),
    ];
}

function unresolvableTrack(track: FederationPlaylistTrack) {
    return {
        ...track,
        trackId: null,
        resolution: "unresolvable" as const,
        isResolvable: false,
        track: null,
        playback: {
            isPlayable: false,
            reason: "missing_provider_track",
            message:
                "Playback is unavailable because this peer track has not been materialized locally.",
        },
    };
}

function resolvedTrack(
    track: FederationPlaylistTrack,
    row: ResolvedTrackIdentity | undefined,
    payloadByTrackId: ReadonlyMap<string, Record<string, unknown>>,
) {
    if (!row) return unresolvableTrack(track);
    const localPayload = row.dedupOfTrackId
        ? payloadByTrackId.get(row.dedupOfTrackId)
        : undefined;
    const trackId = localPayload ? row.dedupOfTrackId : row.id;
    const payload = localPayload ?? payloadByTrackId.get(row.id);
    if (!payload) return unresolvableTrack(track);
    return {
        ...track,
        trackId,
        resolution: localPayload ? ("local" as const) : ("federated" as const),
        isResolvable: true,
        track: payload,
        playback: { isPlayable: true, reason: null, message: null },
    };
}

/** Resolves peer track identities through existing materialized dedup links. */
export async function resolveFederationPlaylistTracks(
    peerId: string,
    tracks: readonly FederationPlaylistTrack[],
) {
    const remoteIds = [...new Set(tracks.map((track) => track.remoteTrackId))];
    const rows = await prisma.track.findMany({
        where: {
            peerId,
            remoteId: { in: remoteIds },
            origin: "FEDERATED",
            removedAt: null,
        },
        select: { id: true, remoteId: true, dedupOfTrackId: true },
    });
    const byRemoteId = new Map<string | null, ResolvedTrackIdentity>(
        rows.map((row) => [row.remoteId, row]),
    );
    const trackIds = resolvedTrackIds(tracks, byRemoteId);
    const payloadByTrackId = await loadResolvedTrackPayloads(trackIds);
    return tracks.map((track) =>
        resolvedTrack(
            track,
            byRemoteId.get(track.remoteTrackId),
            payloadByTrackId,
        ),
    );
}

/** Fetches and resolves one playlist from an active social-scoped peer. */
export async function getFederationPeerPlaylist(
    peerId: string,
    remoteId: string,
) {
    const peer = await requireActivePeer(peerId);
    const detail = await fetchPeerPlaylist(peer, remoteId);
    return {
        peer: { id: peer.id, name: peer.name },
        playlist: {
            ...detail.playlist,
            tracks: await resolveFederationPlaylistTracks(
                peer.id,
                detail.playlist.tracks,
            ),
        },
    };
}

/** Idempotently follows one live peer playlist for a local user. */
export async function followFederationPeerPlaylist(
    userId: string,
    peerId: string,
    remoteId: string,
) {
    try {
        const peer = await requireActivePeer(peerId);
        const detail = await fetchPeerPlaylist(peer, remoteId);
        const follow = await prisma.federationPlaylistFollow.upsert({
            where: { userId_peerId_remoteId: { userId, peerId, remoteId } },
            create: {
                userId,
                peerId,
                remoteId,
                name: detail.playlist.name,
            },
            update: { name: detail.playlist.name },
            select: { id: true },
        });
        recordFederationPlaylistFollow(peerId, "followed");
        return { followed: true, followId: follow.id };
    } catch (error) {
        recordFederationPlaylistFollow(peerId, "failure");
        throw error;
    }
}

/** Removes only the caller's matching peer playlist follow. */
export async function unfollowFederationPeerPlaylist(
    userId: string,
    peerId: string,
    remoteId: string,
) {
    try {
        await prisma.federationPlaylistFollow.deleteMany({
            where: { userId, peerId, remoteId },
        });
        recordFederationPlaylistFollow(peerId, "unfollowed");
        return { followed: false };
    } catch (error) {
        recordFederationPlaylistFollow(peerId, "failure");
        throw error;
    }
}

function followBase(follow: FollowRecord) {
    return {
        id: follow.id,
        peerId: follow.peerId,
        peerName: follow.peer.name,
        remoteId: follow.remoteId,
        createdAt: follow.createdAt.toISOString(),
    };
}

function activeFollowPeer(follow: FollowRecord): ActivePeer | null {
    const { baseUrl, outboundToken } = follow.peer;
    if (
        follow.peer.outboundStatus !== "ACTIVE" ||
        !follow.peer.scopes.includes("social:read") ||
        baseUrl === null ||
        outboundToken === null
    ) {
        return null;
    }
    return {
        id: follow.peer.id,
        name: follow.peer.name,
        baseUrl,
        outboundToken,
    };
}

function failedFollow(
    follow: FollowRecord,
    errorClass: PeerPlaylistErrorClass,
) {
    return {
        ...followBase(follow),
        name: follow.name,
        playlist: null,
        errorClass,
    };
}

async function resolveFollow(follow: FollowRecord) {
    const peer = activeFollowPeer(follow);
    if (!peer) return failedFollow(follow, "offline");
    try {
        const detail = await fetchPeerPlaylist(peer, follow.remoteId);
        const tracks = await resolveFederationPlaylistTracks(
            follow.peerId,
            detail.playlist.tracks,
        );
        return {
            ...followBase(follow),
            name: detail.playlist.name,
            playlist: { ...detail.playlist, tracks },
            errorClass: null,
        };
    } catch (error) {
        const errorClass =
            error instanceof PeerPlaylistError
                ? error.errorClass
                : classifyPeerError(error);
        return failedFollow(follow, errorClass);
    }
}

/** Resolves each followed playlist live and retains per-playlist failures. */
export async function listFollowedFederationPeerPlaylists(userId: string) {
    const follows = await prisma.federationPlaylistFollow.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: PEER_LIMIT,
        select: {
            id: true,
            peerId: true,
            remoteId: true,
            name: true,
            createdAt: true,
            peer: {
                select: {
                    id: true,
                    name: true,
                    baseUrl: true,
                    outboundToken: true,
                    outboundStatus: true,
                    scopes: true,
                },
            },
        },
    });
    return { playlists: await mapWithPeerConcurrency(follows, resolveFollow) };
}

function copyableTracks(
    tracks: Awaited<ReturnType<typeof resolveFederationPlaylistTracks>>,
) {
    const selected: Array<{
        index: number;
        artist: string;
        title: string;
        album: string;
        trackId: string;
        source: "local";
        confidence: number;
    }> = [];
    const seenTrackIds = new Set<string>();
    for (let index = 0; index < 1_000; index += 1) {
        const track = tracks[index];
        if (!track) break;
        if (!track.trackId || seenTrackIds.has(track.trackId)) continue;
        seenTrackIds.add(track.trackId);
        selected.push({
            index,
            artist: track.artist,
            title: track.title,
            album: track.album,
            trackId: track.trackId,
            source: "local",
            confidence: 100,
        });
    }
    return selected;
}

/** Snapshots resolvable peer tracks through the standard playlist import path. */
export async function copyFederationPeerPlaylist(
    userId: string,
    peerId: string,
    remoteId: string,
) {
    try {
        const peer = await requireActivePeer(peerId);
        const detail = await fetchPeerPlaylist(peer, remoteId);
        const tracks = await resolveFederationPlaylistTracks(
            peerId,
            detail.playlist.tracks,
        );
        const resolved = copyableTracks(tracks);
        const copied = resolved.length;
        const skipped = tracks.length - copied;
        const name = `${detail.playlist.name} (from ${peer.name})`;
        const result = await playlistImportService.importPlaylist(userId, {
            playlistName: name,
            resolved,
            summary: {
                total: tracks.length,
                local: copied,
                youtube: 0,
                tidal: 0,
                unresolved: skipped,
            },
        });
        recordFederationPlaylistCopy(peerId, "success");
        return { playlistId: result.playlistId, copied, skipped };
    } catch (error) {
        recordFederationPlaylistCopy(peerId, "failure");
        throw error;
    }
}
