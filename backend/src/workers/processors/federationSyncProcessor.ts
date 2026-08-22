import type { Job } from "bull";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
    createFederationClient,
    FederationEpochMismatchError,
    FederationHttpError,
    FederationStaleCursorError,
    type FederationEnvelope,
    type FederationManifest,
} from "../../services/federationClient";
import {
    backfillAllArtistCounts,
    updateArtistCountsInBatches,
} from "../../services/artistCountsService";
import { trackMappingService } from "../../services/trackMappingService";
import { outboundClientOptions } from "../../services/federationPeers";
import { decodeFederationIdentity } from "../../utils/federationDedup";
import { upsertTrackEmbedding } from "../../services/trackEmbeddings";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { clearTrackTranscodeCache } from "../../services/trackReplacement";
import {
    getActiveSpace,
    NoActiveEmbeddingSpaceError,
    type ActiveEmbeddingSpace,
} from "../../services/embeddingSpaces";
import { type ParsedFederationEmbeddingSpaceIdentity } from "../../services/federationEmbeddingSpace";
import {
    createFederationPageState,
    groupFederationPage,
    syncedFederationTrackValues,
    type AlbumEnvelope,
    type ArtistEnvelope,
    type AudiobookEnvelope,
    type GroupedPage,
    type PageState,
    type PodcastEnvelope,
    type RebindTrackRow,
    type RemoteAlbumRow,
    type RemoteArtistRow,
    type RemoteTrackRow,
    type TrackEnvelope,
} from "./federationSyncPage";
import { recordAppliedFederationEmbeddingOutcome } from "./federationEmbeddingPageMetrics";
import {
    decideFederationSyncEmbeddingPage,
    mergeFederationEmbeddingOutcome,
    type FederationEmbeddingOutcome,
} from "./federationSyncEmbeddingOutcome";
import { refreshFederationPresence } from "./federationSyncPresence";
import { getAvailableFederationConsumerPeer } from "./federationSyncPeer";

const log = logger.child("FederationSyncProcessor");
const OVERLAP_MS = 5 * 60 * 1_000;
const MAX_REMOTE_PAGES = 10_000;
const CLEANUP_BATCH_SIZE = 200;
const MAX_CLEANUP_PAGES = 10_000;
const MAX_SEEN_ITEMS = 2_000_000;
const jobDataSchema = z.strictObject({
    peerId: z.string().trim().min(1).max(128),
});
type MediaType = FederationEnvelope["mediaType"];
type ParentMediaType = "artist" | "album";
interface SyncCounts {
    artists: number;
    albums: number;
    tracks: number;
    podcasts: number;
    audiobooks: number;
    tombstones: number;
}
interface SyncContext {
    peerId: string;
    startedAtMs: number;
    scopes: string[];
    counts: SyncCounts;
    seen: Record<MediaType, Set<string>>;
    albumRgMbids: Map<string, string>;
    unavailableParents: Record<ParentMediaType, Set<string>>;
    warnedParents: Set<string>;
    touchedArtistIds: Set<string>;
    skippedInvalid: number;
    skippedUnknownTombstones: number;
    localEmbeddingSpace: ActiveEmbeddingSpace | null;
    embeddingWarningEmitted: boolean;
    lastEmbeddingOutcome: FederationEmbeddingOutcome;
}
/** Bounded summary of one completed peer sync. */
export interface FederationSyncResult extends SyncCounts {
    mode: "full" | "incremental";
    cursor: string;
    skippedInvalid: number;
    skippedUnknownTombstones: number;
}
function newSyncContext(
    peerId: string,
    scopes: string[],
    localEmbeddingSpace: ActiveEmbeddingSpace | null,
    startedAtMs: number,
): SyncContext {
    return {
        peerId,
        startedAtMs,
        scopes,
        counts: {
            artists: 0,
            albums: 0,
            tracks: 0,
            podcasts: 0,
            audiobooks: 0,
            tombstones: 0,
        },
        seen: {
            artist: new Set(),
            album: new Set(),
            track: new Set(),
            podcast: new Set(),
            audiobook: new Set(),
        },
        albumRgMbids: new Map(),
        unavailableParents: { artist: new Set(), album: new Set() },
        warnedParents: new Set(),
        touchedArtistIds: new Set(),
        skippedInvalid: 0,
        skippedUnknownTombstones: 0,
        localEmbeddingSpace,
        embeddingWarningEmitted: localEmbeddingSpace === null,
        lastEmbeddingOutcome: null,
    };
}
async function resolveLocalEmbeddingSpace(
    peerId: string,
): Promise<ActiveEmbeddingSpace | null> {
    try {
        return await getActiveSpace();
    } catch (error) {
        if (!(error instanceof NoActiveEmbeddingSpaceError)) throw error;
        log.warn(
            "Skipping federation embeddings because no local embedding space is active",
            { peerId },
        );
        return null;
    }
}
function incrementCount(context: SyncContext, mediaType: MediaType): void {
    if (mediaType === "artist") context.counts.artists += 1;
    else if (mediaType === "album") context.counts.albums += 1;
    else if (mediaType === "track") context.counts.tracks += 1;
    else if (mediaType === "podcast") context.counts.podcasts += 1;
    else context.counts.audiobooks += 1;
}
function rememberSeen(context: SyncContext, item: FederationEnvelope): void {
    const seen = context.seen[item.mediaType];
    if (seen.size >= MAX_SEEN_ITEMS) {
        throw new Error("Federation full sync exceeded the item bound");
    }
    seen.add(item.id);
}
function placeholderIdentity(peerId: string, value: string): string {
    const encoded = Buffer.from(value, "utf8").toString("base64url");
    return `federation:${peerId}:${encoded}`;
}
function warnParentRecovery(
    context: SyncContext,
    mediaType: ParentMediaType,
    remoteId: string,
    action: string,
): void {
    const key = `${mediaType}:${remoteId}`;
    if (context.warnedParents.has(key)) return;
    context.warnedParents.add(key);
    log.warn(
        `peerId=${context.peerId} missing parent ${mediaType}=${remoteId}; ${action}`,
    );
}
function isMissingExportedParent(error: unknown): boolean {
    return error instanceof FederationHttpError && error.status === 404;
}
async function hasArtistCollision(
    context: SyncContext,
    state: PageState,
    item: ArtistEnvelope,
): Promise<boolean> {
    if (state.loadedArtistMbids.has(item.attributes.mbid)) {
        return state.artistCollisionRemoteIds.has(item.id);
    }
    const collision = await prisma.artist.findFirst({
        where: {
            mbid: item.attributes.mbid,
            NOT: { peerId: context.peerId, remoteId: item.id },
        },
        select: { id: true },
    });
    return collision !== null;
}
async function upsertArtist(
    context: SyncContext,
    state: PageState,
    item: ArtistEnvelope,
): Promise<RemoteArtistRow> {
    const existing = state.artists.get(item.id);
    const collision = await hasArtistCollision(context, state, item);
    const mbid =
        existing?.mbid ??
        (collision
            ? placeholderIdentity(context.peerId, item.attributes.mbid)
            : item.attributes.mbid);
    const row = await prisma.artist.upsert({
        where: {
            peerId_remoteId: { peerId: context.peerId, remoteId: item.id },
        },
        create: {
            peerId: context.peerId,
            remoteId: item.id,
            mbid,
            name: item.attributes.name,
            normalizedName: item.attributes.normalizedName,
            lastSynced: new Date(item.updatedAt),
        },
        update: {
            name: item.attributes.name,
            normalizedName: item.attributes.normalizedName,
            lastSynced: new Date(item.updatedAt),
        },
        select: { id: true, remoteId: true, mbid: true },
    });
    const normalized = { ...row, remoteId: row.remoteId ?? item.id };
    state.artists.set(item.id, normalized);
    context.touchedArtistIds.add(row.id);
    return normalized;
}
async function ensureRemoteArtistId(
    context: SyncContext,
    state: PageState,
    client: ReturnType<typeof createFederationClient>,
    remoteId: string,
    remember: boolean,
): Promise<string | null> {
    const existing = state.artists.get(remoteId);
    if (existing) return existing.id;
    if (context.unavailableParents.artist.has(remoteId)) {
        warnParentRecovery(context, "artist", remoteId, "skipping child");
        return null;
    }
    warnParentRecovery(context, "artist", remoteId, "fetching directly");
    let parent: FederationEnvelope;
    try {
        parent = await client.getCatalogItem("artist", remoteId);
    } catch (error) {
        if (!isMissingExportedParent(error)) throw error;
        context.unavailableParents.artist.add(remoteId);
        return null;
    }
    if (parent.mediaType !== "artist") {
        throw new Error("Federation host returned the wrong parent type");
    }
    const imported = await upsertArtist(context, state, parent);
    if (remember) rememberSeen(context, parent);
    return imported.id;
}
async function resolveAlbumRgMbid(
    context: SyncContext,
    state: PageState,
    item: AlbumEnvelope,
): Promise<string> {
    const existing = state.albums.get(item.id);
    if (existing) return existing.rgMbid;
    if (state.loadedAlbumRgMbids.has(item.attributes.rgMbid)) {
        return state.albumCollisionRemoteIds.has(item.id)
            ? placeholderIdentity(context.peerId, item.attributes.rgMbid)
            : item.attributes.rgMbid;
    }
    const collision = await prisma.album.findFirst({
        where: {
            rgMbid: item.attributes.rgMbid,
            NOT: { peerId: context.peerId, remoteId: item.id },
        },
        select: { id: true },
    });
    return collision
        ? placeholderIdentity(context.peerId, item.attributes.rgMbid)
        : item.attributes.rgMbid;
}

async function upsertAlbum(
    context: SyncContext,
    state: PageState,
    item: AlbumEnvelope,
    client: ReturnType<typeof createFederationClient>,
    remember: boolean,
): Promise<boolean> {
    const artistId = await ensureRemoteArtistId(
        context,
        state,
        client,
        item.parentRef,
        remember,
    );
    if (!artistId) {
        context.unavailableParents.album.add(item.id);
        return false;
    }
    const rgMbid = await resolveAlbumRgMbid(context, state, item);
    const row = await prisma.album.upsert({
        where: {
            peerId_remoteId: { peerId: context.peerId, remoteId: item.id },
        },
        create: {
            peerId: context.peerId,
            remoteId: item.id,
            artistId,
            rgMbid,
            title: item.attributes.title,
            year: item.attributes.year,
            primaryType: item.attributes.primaryType,
            location: "FEDERATED",
            lastSynced: new Date(item.updatedAt),
        },
        update: {
            artistId,
            title: item.attributes.title,
            year: item.attributes.year,
            primaryType: item.attributes.primaryType,
            lastSynced: new Date(item.updatedAt),
        },
        select: { id: true, remoteId: true, rgMbid: true, artistId: true },
    });
    state.albums.set(item.id, { ...row, remoteId: row.remoteId ?? item.id });
    context.albumRgMbids.set(item.id, item.attributes.rgMbid);
    context.touchedArtistIds.add(artistId);
    return true;
}

async function ensureRemoteAlbum(
    context: SyncContext,
    state: PageState,
    client: ReturnType<typeof createFederationClient>,
    remoteId: string,
    remember: boolean,
): Promise<RemoteAlbumRow | null> {
    const existing = state.albums.get(remoteId);
    if (existing) {
        return {
            ...existing,
            rgMbid:
                context.albumRgMbids.get(remoteId) ??
                decodeFederationIdentity(existing.rgMbid),
        };
    }
    if (context.unavailableParents.album.has(remoteId)) {
        warnParentRecovery(context, "album", remoteId, "skipping child");
        return null;
    }
    warnParentRecovery(context, "album", remoteId, "fetching directly");
    let parent: FederationEnvelope;
    try {
        parent = await client.getCatalogItem("album", remoteId);
    } catch (error) {
        if (!isMissingExportedParent(error)) throw error;
        context.unavailableParents.album.add(remoteId);
        return null;
    }
    if (parent.mediaType !== "album") {
        throw new Error("Federation host returned the wrong parent type");
    }
    const applied = await upsertAlbum(context, state, parent, client, remember);
    if (!applied) return null;
    const imported = state.albums.get(remoteId);
    if (!imported) throw new Error("Federation album parent import failed");
    if (remember) rememberSeen(context, parent);
    return {
        ...imported,
        rgMbid:
            context.albumRgMbids.get(remoteId) ??
            decodeFederationIdentity(imported.rgMbid),
    };
}

type DedupMatch = { id: string; confidence: number };

interface DedupIndex {
    audioHash: Map<string, string>;
    recordingMbid: Map<string, string>;
    isrc: Map<string, string>;
    position: Map<string, string>;
}

function uniqueValues(values: Array<string | null>): string[] {
    return [
        ...new Set(values.filter((value): value is string => Boolean(value))),
    ];
}

function setFirst(map: Map<string, string>, key: string, id: string): void {
    if (!map.has(key)) map.set(key, id);
}

function positionKey(rgMbid: string, discNo: number, trackNo: number): string {
    return JSON.stringify([rgMbid, discNo, trackNo]);
}

const LOCAL_DEDUP_WHERE = { origin: "LOCAL" as const, removedAt: null };

async function loadAudioDedupMatches(
    tracks: readonly TrackEnvelope[],
    target: Map<string, string>,
): Promise<void> {
    const values = uniqueValues(
        tracks.map((item) => item.attributes.audioHash),
    );
    if (values.length === 0) return;
    const rows = await prisma.track.findMany({
        where: { ...LOCAL_DEDUP_WHERE, audioHash: { in: values } },
        orderBy: { id: "asc" },
        select: { id: true, audioHash: true },
    });
    for (const row of rows) {
        if (row.audioHash) setFirst(target, row.audioHash, row.id);
    }
}

async function loadRecordingDedupMatches(
    tracks: readonly TrackEnvelope[],
    target: Map<string, string>,
): Promise<void> {
    const values = uniqueValues(
        tracks.map((item) => item.attributes.recordingMbid),
    );
    if (values.length === 0) return;
    const rows = await prisma.track.findMany({
        where: { ...LOCAL_DEDUP_WHERE, recordingMbid: { in: values } },
        orderBy: { id: "asc" },
        select: { id: true, recordingMbid: true },
    });
    for (const row of rows) {
        if (row.recordingMbid) setFirst(target, row.recordingMbid, row.id);
    }
}

async function loadIsrcDedupMatches(
    tracks: readonly TrackEnvelope[],
    target: Map<string, string>,
): Promise<void> {
    const values = uniqueValues(tracks.map((item) => item.attributes.isrc));
    if (values.length === 0) return;
    const rows = await prisma.track.findMany({
        where: { ...LOCAL_DEDUP_WHERE, isrc: { in: values } },
        orderBy: { id: "asc" },
        select: { id: true, isrc: true },
    });
    for (const row of rows) {
        if (row.isrc) setFirst(target, row.isrc, row.id);
    }
}

async function loadPositionDedupMatches(
    tracks: readonly TrackEnvelope[],
    albums: ReadonlyMap<string, RemoteAlbumRow>,
    target: Map<string, string>,
): Promise<void> {
    const positional = tracks.flatMap((item) => {
        const album = albums.get(item.parentRef);
        return album
            ? [
                  {
                      discNo: item.attributes.discNo,
                      trackNo: item.attributes.trackNo,
                      album: {
                          rgMbid: album.rgMbid,
                          location: "LIBRARY" as const,
                      },
                  },
              ]
            : [];
    });
    if (positional.length === 0) return;
    const rows = await prisma.track.findMany({
        where: { ...LOCAL_DEDUP_WHERE, OR: positional },
        orderBy: { id: "asc" },
        select: {
            id: true,
            discNo: true,
            trackNo: true,
            album: { select: { rgMbid: true } },
        },
    });
    for (const row of rows) {
        const key = positionKey(row.album.rgMbid, row.discNo, row.trackNo);
        setFirst(target, key, row.id);
    }
}

async function loadDedupIndex(
    tracks: readonly TrackEnvelope[],
    albums: ReadonlyMap<string, RemoteAlbumRow>,
): Promise<DedupIndex> {
    const index: DedupIndex = {
        audioHash: new Map(),
        recordingMbid: new Map(),
        isrc: new Map(),
        position: new Map(),
    };
    await loadAudioDedupMatches(tracks, index.audioHash);
    await loadRecordingDedupMatches(tracks, index.recordingMbid);
    await loadIsrcDedupMatches(tracks, index.isrc);
    await loadPositionDedupMatches(tracks, albums, index.position);
    return index;
}

function findDedupMatch(
    index: DedupIndex,
    item: TrackEnvelope,
    albumRgMbid: string,
): DedupMatch | null {
    const attributes = item.attributes;
    const audio = attributes.audioHash
        ? index.audioHash.get(attributes.audioHash)
        : undefined;
    if (audio) return { id: audio, confidence: 1 };
    const recording = attributes.recordingMbid
        ? index.recordingMbid.get(attributes.recordingMbid)
        : undefined;
    if (recording) return { id: recording, confidence: 0.95 };
    const isrc = attributes.isrc ? index.isrc.get(attributes.isrc) : undefined;
    if (isrc) return { id: isrc, confidence: 0.9 };
    const positional = index.position.get(
        positionKey(albumRgMbid, attributes.discNo, attributes.trackNo),
    );
    return positional ? { id: positional, confidence: 0.8 } : null;
}

async function applyTrackDedup(
    trackId: string,
    match: DedupMatch | null,
): Promise<void> {
    const updated = await prisma.track.updateMany({
        where: { id: trackId, dedupPinned: false },
        data: { dedupOfTrackId: match?.id ?? null },
    });
    if (!match || updated.count !== 1) return;
    await trackMappingService.createMapping({
        trackId: match.id,
        confidence: match.confidence,
        source: "federation",
    });
}

async function rebindFederatedTrack(
    state: PageState,
    item: TrackEnvelope,
): Promise<RemoteTrackRow | null> {
    const current = state.tracks.get(item.id);
    if (current) return current;
    const prior = state.rebindTracks.get(item.id);
    if (!prior) return null;
    await prisma.track.update({
        where: { id: prior.id },
        data: { remoteId: item.id },
    });
    const rebound = {
        id: prior.id,
        remoteId: item.id,
        audioHash: prior.audioHash,
    };
    state.tracks.set(item.id, rebound);
    return rebound;
}

async function upsertTrack(
    context: SyncContext,
    item: TrackEnvelope,
    album: RemoteAlbumRow,
    existing: RemoteTrackRow | null,
    match: DedupMatch | null,
    storeEmbedding: boolean,
): Promise<void> {
    const attributes = item.attributes;
    const hashChanged =
        attributes.audioHash !== undefined &&
        existing !== null &&
        existing.audioHash !== attributes.audioHash;
    const values = syncedFederationTrackValues(item, album.id);
    const row = await prisma.track.upsert({
        where: {
            peerId_remoteId: { peerId: context.peerId, remoteId: item.id },
        },
        create: {
            peerId: context.peerId,
            remoteId: item.id,
            ...values,
        },
        update: values,
        select: { id: true },
    });
    if (hashChanged) await clearTrackTranscodeCache(row.id);
    await applyTrackDedup(row.id, match);
    const space = context.localEmbeddingSpace;
    if (attributes.embedding && storeEmbedding && space)
        await upsertTrackEmbedding(row.id, attributes.embedding, space.id);
    context.touchedArtistIds.add(album.artistId);
}

async function loadArtistPageState(
    context: SyncContext,
    grouped: GroupedPage,
    state: PageState,
): Promise<void> {
    const remoteIds = uniqueValues([
        ...grouped.artists.map((item) => item.id),
        ...grouped.albums.map((item) => item.parentRef),
    ]);
    const mbids = uniqueValues(
        grouped.artists.map((item) => item.attributes.mbid),
    );
    for (const mbid of mbids) state.loadedArtistMbids.add(mbid);
    if (remoteIds.length === 0 && mbids.length === 0) return;
    const rows = await prisma.artist.findMany({
        where: {
            OR: [
                { peerId: context.peerId, remoteId: { in: remoteIds } },
                { mbid: { in: mbids } },
            ],
        },
        select: { id: true, peerId: true, remoteId: true, mbid: true },
    });
    for (const row of rows) {
        if (row.peerId === context.peerId && row.remoteId) {
            state.artists.set(row.remoteId, { ...row, remoteId: row.remoteId });
        }
    }
    for (const item of grouped.artists) {
        const duplicateInPage = grouped.artists.some(
            (candidate) =>
                candidate.id < item.id &&
                candidate.attributes.mbid === item.attributes.mbid,
        );
        const collision = rows.some(
            (row) =>
                row.mbid === item.attributes.mbid &&
                (row.peerId !== context.peerId || row.remoteId !== item.id),
        );
        if (collision || duplicateInPage) {
            state.artistCollisionRemoteIds.add(item.id);
        }
    }
}

async function loadAlbumPageState(
    context: SyncContext,
    grouped: GroupedPage,
    state: PageState,
): Promise<void> {
    const remoteIds = uniqueValues([
        ...grouped.albums.map((item) => item.id),
        ...grouped.tracks.map((item) => item.parentRef),
    ]);
    const rgMbids = uniqueValues(
        grouped.albums.map((item) => item.attributes.rgMbid),
    );
    for (const rgMbid of rgMbids) state.loadedAlbumRgMbids.add(rgMbid);
    if (remoteIds.length === 0 && rgMbids.length === 0) return;
    const rows = await prisma.album.findMany({
        where: {
            OR: [
                { peerId: context.peerId, remoteId: { in: remoteIds } },
                { rgMbid: { in: rgMbids } },
            ],
        },
        select: {
            id: true,
            peerId: true,
            remoteId: true,
            rgMbid: true,
            artistId: true,
        },
    });
    for (const row of rows) {
        if (row.peerId === context.peerId && row.remoteId) {
            state.albums.set(row.remoteId, { ...row, remoteId: row.remoteId });
        }
    }
    for (const item of grouped.albums) {
        const duplicateInPage = grouped.albums.some(
            (candidate) =>
                candidate.id < item.id &&
                candidate.attributes.rgMbid === item.attributes.rgMbid,
        );
        const collision = rows.some(
            (row) =>
                row.rgMbid === item.attributes.rgMbid &&
                (row.peerId !== context.peerId || row.remoteId !== item.id),
        );
        if (collision || duplicateInPage) {
            state.albumCollisionRemoteIds.add(item.id);
        }
    }
}

async function loadTrackPageState(
    context: SyncContext,
    grouped: GroupedPage,
    state: PageState,
): Promise<void> {
    const remoteIds = grouped.tracks.map((item) => item.id);
    if (remoteIds.length === 0) return;
    const rows = await prisma.track.findMany({
        where: { peerId: context.peerId, remoteId: { in: remoteIds } },
        select: { id: true, remoteId: true, audioHash: true },
    });
    for (const row of rows) {
        if (row.remoteId) {
            state.tracks.set(row.remoteId, { ...row, remoteId: row.remoteId });
        }
    }
}

function trackRebindIdentity(item: TrackEnvelope, albumId: string) {
    const attributes = item.attributes;
    return [
        ...(attributes.audioHash ? [{ audioHash: attributes.audioHash }] : []),
        ...(attributes.recordingMbid
            ? [{ recordingMbid: attributes.recordingMbid }]
            : []),
        ...(attributes.isrc ? [{ isrc: attributes.isrc }] : []),
        {
            albumId,
            discNo: attributes.discNo,
            trackNo: attributes.trackNo,
        },
    ];
}

function matchesRebindCandidate(
    row: RebindTrackRow,
    item: TrackEnvelope,
    albumId: string,
): boolean {
    const attributes = item.attributes;
    return (
        (Boolean(attributes.audioHash) &&
            row.audioHash === attributes.audioHash) ||
        (Boolean(attributes.recordingMbid) &&
            row.recordingMbid === attributes.recordingMbid) ||
        (Boolean(attributes.isrc) && row.isrc === attributes.isrc) ||
        (row.albumId === albumId &&
            row.discNo === attributes.discNo &&
            row.trackNo === attributes.trackNo)
    );
}

async function loadTrackRebindPageState(
    context: SyncContext,
    state: PageState,
    items: readonly TrackEnvelope[],
    resolvedAlbums: ReadonlyMap<string, RemoteAlbumRow>,
): Promise<void> {
    const missing = items.filter((item) => !state.tracks.has(item.id));
    if (missing.length === 0) return;
    const rows = await prisma.track.findMany({
        where: {
            peerId: context.peerId,
            origin: "FEDERATED",
            removedAt: null,
            OR: missing.flatMap((item) => {
                const album = resolvedAlbums.get(item.id);
                return album ? trackRebindIdentity(item, album.id) : [];
            }),
        },
        orderBy: { id: "asc" },
        select: {
            id: true,
            audioHash: true,
            recordingMbid: true,
            isrc: true,
            albumId: true,
            discNo: true,
            trackNo: true,
        },
    });
    for (const item of missing) {
        const album = resolvedAlbums.get(item.id);
        if (!album) continue;
        const prior = rows.find((row) =>
            matchesRebindCandidate(row, item, album.id),
        );
        if (prior) state.rebindTracks.set(item.id, prior);
    }
}

async function loadPageState(
    context: SyncContext,
    grouped: GroupedPage,
): Promise<PageState> {
    const state = createFederationPageState();
    await Promise.all([
        loadArtistPageState(context, grouped, state),
        loadAlbumPageState(context, grouped, state),
        loadTrackPageState(context, grouped, state),
    ]);
    return state;
}

function recordApplied(
    context: SyncContext,
    item: FederationEnvelope,
    remember: boolean,
): void {
    if (remember) rememberSeen(context, item);
    incrementCount(context, item.mediaType);
}

async function applyArtists(
    context: SyncContext,
    state: PageState,
    items: readonly ArtistEnvelope[],
    remember: boolean,
): Promise<void> {
    for (const item of items) {
        await upsertArtist(context, state, item);
        recordApplied(context, item, remember);
    }
}

async function applyAlbums(
    context: SyncContext,
    state: PageState,
    client: ReturnType<typeof createFederationClient>,
    items: readonly AlbumEnvelope[],
    remember: boolean,
): Promise<void> {
    for (const item of items) {
        if (!(await upsertAlbum(context, state, item, client, remember))) {
            context.skippedInvalid += 1;
            continue;
        }
        recordApplied(context, item, remember);
    }
}

async function resolveTrackAlbums(
    context: SyncContext,
    state: PageState,
    client: ReturnType<typeof createFederationClient>,
    items: readonly TrackEnvelope[],
    remember: boolean,
): Promise<Map<string, RemoteAlbumRow>> {
    const resolved = new Map<string, RemoteAlbumRow>();
    for (const item of items) {
        const album = await ensureRemoteAlbum(
            context,
            state,
            client,
            item.parentRef,
            remember,
        );
        if (album) resolved.set(item.id, album);
        else context.skippedInvalid += 1;
    }
    return resolved;
}

async function applyTracks(
    context: SyncContext,
    state: PageState,
    items: readonly TrackEnvelope[],
    resolvedAlbums: ReadonlyMap<string, RemoteAlbumRow>,
    remember: boolean,
    storeEmbeddings: boolean,
): Promise<void> {
    await loadTrackRebindPageState(context, state, items, resolvedAlbums);
    const albums = new Map(state.albums);
    for (const item of items) {
        const album = resolvedAlbums.get(item.id);
        if (album) albums.set(item.parentRef, album);
    }
    const dedup = await loadDedupIndex(items, albums);
    for (const item of items) {
        const album = resolvedAlbums.get(item.id);
        if (!album) continue;
        const existing = await rebindFederatedTrack(state, item);
        await upsertTrack(
            context,
            item,
            album,
            existing,
            findDedupMatch(dedup, item, album.rgMbid),
            storeEmbeddings,
        );
        recordApplied(context, item, remember);
    }
}

async function applyPodcasts(
    context: SyncContext,
    items: readonly PodcastEnvelope[],
    remember: boolean,
): Promise<void> {
    for (const item of items) {
        const values = {
            feedUrl: item.attributes.feedUrl,
            title: item.attributes.title,
            author: item.attributes.author,
            imageUrl: item.attributes.imageUrl,
            updatedAt: new Date(item.updatedAt),
        };
        await prisma.federationPodcastListing.upsert({
            where: {
                peerId_remoteId: {
                    peerId: context.peerId,
                    remoteId: item.id,
                },
            },
            create: {
                peerId: context.peerId,
                remoteId: item.id,
                ...values,
            },
            update: values,
        });
        recordApplied(context, item, remember);
    }
}

function syncedAudiobookValues(item: AudiobookEnvelope) {
    return {
        title: item.attributes.title,
        author: item.attributes.author,
        narrator: item.attributes.narrator,
        duration: item.attributes.duration,
        description: item.attributes.description,
        asin: item.attributes.asin,
        isbn: item.attributes.isbn,
        coverUrl: item.attributes.coverUrl ? "federation" : null,
        localCoverPath: null,
        audioUrl: item.id,
        genres: [],
        tags: [],
        updatedAt: new Date(item.updatedAt),
        lastSyncedAt: new Date(item.updatedAt),
    };
}

async function applyAudiobooks(
    context: SyncContext,
    items: readonly AudiobookEnvelope[],
    remember: boolean,
): Promise<void> {
    for (const item of items) {
        const values = syncedAudiobookValues(item);
        await prisma.audiobook.upsert({
            where: {
                peerId_remoteId: {
                    peerId: context.peerId,
                    remoteId: item.id,
                },
            },
            create: {
                id: `fed:${randomUUID()}`,
                peerId: context.peerId,
                remoteId: item.id,
                ...values,
            },
            update: values,
        });
        recordApplied(context, item, remember);
    }
}

async function applyChanges(
    context: SyncContext,
    client: ReturnType<typeof createFederationClient>,
    items: readonly FederationEnvelope[],
    remember: boolean,
    pageEmbeddingSpace?: ParsedFederationEmbeddingSpaceIdentity,
): Promise<void> {
    const grouped = groupFederationPage(items);
    const embeddingOutcome = decideFederationSyncEmbeddingPage(
        context,
        grouped.tracks.some((item) => item.attributes.embedding !== undefined),
        pageEmbeddingSpace,
        (message, details) => log.warn(message, details),
    );
    const state = await loadPageState(context, grouped);
    await applyArtists(context, state, grouped.artists, remember);
    await applyAlbums(context, state, client, grouped.albums, remember);
    const resolvedAlbums = await resolveTrackAlbums(
        context,
        state,
        client,
        grouped.tracks,
        remember,
    );
    const validTracks = grouped.tracks.filter((item) =>
        resolvedAlbums.has(item.id),
    );
    await applyTracks(
        context,
        state,
        validTracks,
        resolvedAlbums,
        remember,
        embeddingOutcome === "stored",
    );
    await applyPodcasts(context, grouped.podcasts, remember);
    await applyAudiobooks(context, grouped.audiobooks, remember);
    recordAppliedFederationEmbeddingOutcome(embeddingOutcome, validTracks);
    context.lastEmbeddingOutcome = mergeFederationEmbeddingOutcome(
        context.lastEmbeddingOutcome,
        embeddingOutcome,
    );
}

const fullProgressSchema = z.strictObject({
    phase: z.literal("full"),
    mediaType: z.enum([
        "artist",
        "album",
        "track",
        "podcast",
        "audiobook",
        "cleanup",
    ]),
    cursor: z.string().min(1).max(512).nullable(),
    serverTime: z.iso.datetime({ offset: true }),
    epoch: z.string().min(1).max(128),
});
type FullProgress = z.infer<typeof fullProgressSchema>;
type FullMediaType = FullProgress["mediaType"];
const FULL_TYPES: readonly MediaType[] = [
    "artist",
    "album",
    "track",
    "podcast",
    "audiobook",
];

function parseFullProgress(value: string | null): FullProgress | null {
    if (!value?.startsWith("{")) return null;
    try {
        const parsed: unknown = JSON.parse(value);
        const result = fullProgressSchema.safeParse(parsed);
        return result.success ? result.data : null;
    } catch (_error: unknown) {
        return null;
    }
}

async function saveFullProgress(
    context: SyncContext,
    progress: FullProgress,
): Promise<void> {
    await prisma.federationPeer.update({
        where: { id: context.peerId },
        data: {
            lastSyncCursor: JSON.stringify(progress),
            catalogEpoch: progress.epoch,
        },
    });
}

function nextFullType(mediaType: MediaType): FullMediaType {
    if (mediaType === "artist") return "album";
    if (mediaType === "album") return "track";
    if (mediaType === "track") return "podcast";
    if (mediaType === "podcast") return "audiobook";
    return "cleanup";
}

async function syncFullType(
    context: SyncContext,
    client: ReturnType<typeof createFederationClient>,
    progress: FullProgress,
): Promise<void> {
    if (progress.mediaType === "cleanup") return;
    let cursor = progress.cursor ?? undefined;
    for (let page = 0; page < MAX_REMOTE_PAGES; page += 1) {
        const result = await client.getCatalogItems(progress.mediaType, cursor);
        context.skippedInvalid += result.skippedInvalid ?? 0;
        await applyChanges(
            context,
            client,
            result.items,
            true,
            result.embeddingSpace,
        );
        const next: FullProgress = {
            ...progress,
            mediaType: result.nextCursor
                ? progress.mediaType
                : nextFullType(progress.mediaType),
            cursor: result.nextCursor,
        };
        await saveFullProgress(context, next);
        if (!result.nextCursor) return;
        cursor = result.nextCursor;
    }
    throw new Error("Federation full sync exceeded the page bound");
}

type CleanupRow = { id: string; remoteId: string | null };
type CleanupLoader = (cursor?: string) => Promise<CleanupRow[]>;
type CleanupDelete = (ids: string[]) => Promise<unknown>;

async function cleanupUnseen(
    seen: ReadonlySet<string>,
    load: CleanupLoader,
    remove: CleanupDelete,
): Promise<void> {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CLEANUP_PAGES; page += 1) {
        const rows = await load(cursor);
        if (rows.length === 0) return;
        const unseenIds = rows
            .filter((row) => !row.remoteId || !seen.has(row.remoteId))
            .map((row) => row.id);
        if (unseenIds.length > 0) await remove(unseenIds);
        cursor = rows[rows.length - 1].id;
    }
    throw new Error("Federation cleanup exceeded the page bound");
}

async function cleanupFullSync(context: SyncContext): Promise<void> {
    const query = (cursor?: string) => ({
        where: {
            peerId: context.peerId,
            ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" as const },
        take: CLEANUP_BATCH_SIZE,
        select: { id: true, remoteId: true },
    });
    await cleanupUnseen(
        context.seen.audiobook,
        (cursor) => prisma.audiobook.findMany(query(cursor)),
        (ids) =>
            prisma.audiobook.deleteMany({
                where: { id: { in: ids }, peerId: context.peerId },
            }),
    );
    await cleanupUnseen(
        context.seen.podcast,
        (cursor) => prisma.federationPodcastListing.findMany(query(cursor)),
        (ids) =>
            prisma.federationPodcastListing.deleteMany({
                where: { id: { in: ids }, peerId: context.peerId },
            }),
    );
    await cleanupUnseen(
        context.seen.track,
        (cursor) => prisma.track.findMany(query(cursor)),
        (ids) =>
            prisma.track.deleteMany({
                where: { id: { in: ids }, peerId: context.peerId },
            }),
    );
    await cleanupUnseen(
        context.seen.album,
        (cursor) => prisma.album.findMany(query(cursor)),
        (ids) =>
            prisma.album.deleteMany({
                where: { id: { in: ids }, peerId: context.peerId },
            }),
    );
    await cleanupUnseen(
        context.seen.artist,
        (cursor) => prisma.artist.findMany(query(cursor)),
        (ids) =>
            prisma.artist.deleteMany({
                where: { id: { in: ids }, peerId: context.peerId },
            }),
    );
}

async function collectFreshHostIds(
    context: SyncContext,
    client: ReturnType<typeof createFederationClient>,
    advertisedTypes: ReadonlySet<MediaType>,
): Promise<void> {
    for (const mediaType of FULL_TYPES) {
        if (!advertisedTypes.has(mediaType)) continue;
        context.seen[mediaType].clear();
        let cursor: string | undefined;
        for (let page = 0; page < MAX_REMOTE_PAGES; page += 1) {
            const result = await client.getCatalogItems(mediaType, cursor);
            for (const item of result.items) rememberSeen(context, item);
            if (!result.nextCursor) break;
            cursor = result.nextCursor;
            if (page + 1 === MAX_REMOTE_PAGES) {
                throw new Error(
                    "Federation cleanup scan exceeded the page bound",
                );
            }
        }
    }
}

async function applyTombstones(
    context: SyncContext,
    tombstones: readonly { entityType: MediaType; entityId: string }[],
): Promise<void> {
    const idsFor = (type: MediaType) =>
        tombstones
            .filter((item) => item.entityType === type)
            .map((item) => item.entityId);
    const trackIds = idsFor("track");
    const albumIds = idsFor("album");
    const artistIds = idsFor("artist");
    const podcastIds = idsFor("podcast");
    const audiobookIds = idsFor("audiobook");
    if (audiobookIds.length > 0) {
        await prisma.audiobook.deleteMany({
            where: {
                peerId: context.peerId,
                remoteId: { in: audiobookIds },
            },
        });
    }
    if (podcastIds.length > 0) {
        await prisma.federationPodcastListing.deleteMany({
            where: { peerId: context.peerId, remoteId: { in: podcastIds } },
        });
    }
    if (trackIds.length > 0) {
        const rows = await prisma.track.findMany({
            where: { peerId: context.peerId, remoteId: { in: trackIds } },
            select: { album: { select: { artistId: true } } },
        });
        for (const row of rows) {
            context.touchedArtistIds.add(row.album.artistId);
        }
        await prisma.track.deleteMany({
            where: { peerId: context.peerId, remoteId: { in: trackIds } },
        });
    }
    if (albumIds.length > 0) {
        const rows = await prisma.album.findMany({
            where: { peerId: context.peerId, remoteId: { in: albumIds } },
            select: { artistId: true },
        });
        for (const row of rows) context.touchedArtistIds.add(row.artistId);
        await prisma.album.deleteMany({
            where: { peerId: context.peerId, remoteId: { in: albumIds } },
        });
    }
    if (artistIds.length > 0) {
        await prisma.artist.deleteMany({
            where: { peerId: context.peerId, remoteId: { in: artistIds } },
        });
    }
    context.counts.tombstones += tombstones.length;
}

async function finishSync(
    context: SyncContext,
    mode: FederationSyncResult["mode"],
    cursor: string,
    catalogEpoch: string,
): Promise<FederationSyncResult> {
    const completedAtMs = Date.now();
    const completedAt = new Date(completedAtMs);
    const changed =
        context.counts.artists +
        context.counts.albums +
        context.counts.tracks +
        context.counts.podcasts +
        context.counts.audiobooks +
        context.counts.tombstones;
    if (changed > 0 && mode === "full") await backfillAllArtistCounts();
    if (changed > 0 && mode === "incremental") {
        await updateArtistCountsInBatches([...context.touchedArtistIds].sort());
    }
    await prisma.federationPeer.update({
        where: { id: context.peerId },
        data: {
            lastSyncCursor: cursor,
            catalogEpoch,
            lastSeenAt: completedAt,
            lastSyncSuccessAt: completedAt,
            lastSyncDurationMs: Math.max(
                0,
                completedAtMs - context.startedAtMs,
            ),
            outboundStatus: "ACTIVE",
            ...(context.lastEmbeddingOutcome === null
                ? {}
                : { lastEmbeddingOutcome: context.lastEmbeddingOutcome }),
        },
    });
    log.info(
        `peerId=${context.peerId} mode=${mode} cursor=${cursor} artists=${context.counts.artists} albums=${context.counts.albums} tracks=${context.counts.tracks} podcasts=${context.counts.podcasts} audiobooks=${context.counts.audiobooks} tombstones=${context.counts.tombstones} skippedInvalid=${context.skippedInvalid} skippedUnknownTombstones=${context.skippedUnknownTombstones}`,
    );
    return {
        mode,
        cursor,
        ...context.counts,
        skippedInvalid: context.skippedInvalid,
        skippedUnknownTombstones: context.skippedUnknownTombstones,
    };
}

function fullSyncCursor(manifest: FederationManifest, fallback: Date): string {
    if (manifest.serverTime) {
        const serverTime = new Date(manifest.serverTime);
        if (Number.isFinite(serverTime.getTime()))
            return serverTime.toISOString();
    }
    log.warn("Federation manifest lacks serverTime; using the local clock");
    return fallback.toISOString();
}

function advertisedFullTypeSet(
    context: SyncContext,
    manifestMediaTypes: FederationManifest["mediaTypes"],
): ReadonlySet<MediaType> {
    const advertisedTypes = new Set<MediaType>(manifestMediaTypes);
    const skippedTypes = FULL_TYPES.filter(
        (mediaType) => !advertisedTypes.has(mediaType),
    );
    if (skippedTypes.length > 0) {
        log.info(
            `peerId=${context.peerId} skipping unadvertised media types: ${skippedTypes.join(",")}`,
        );
    }
    return advertisedTypes;
}

async function runFullSync(
    context: SyncContext,
    client: ReturnType<typeof createFederationClient>,
    progress: FullProgress,
    resumed: boolean,
    manifestMediaTypes: FederationManifest["mediaTypes"],
): Promise<FederationSyncResult> {
    const advertisedTypes = advertisedFullTypeSet(context, manifestMediaTypes);
    const startIndex =
        progress.mediaType === "cleanup"
            ? FULL_TYPES.length
            : FULL_TYPES.indexOf(progress.mediaType);
    for (let index = 0; index < FULL_TYPES.length; index += 1) {
        if (index < startIndex) continue;
        if (!advertisedTypes.has(FULL_TYPES[index])) continue;
        await syncFullType(context, client, {
            ...progress,
            mediaType: FULL_TYPES[index],
            cursor: index === startIndex ? progress.cursor : null,
        });
    }
    if (resumed) {
        await collectFreshHostIds(context, client, advertisedTypes);
    }
    await cleanupFullSync(context);
    return finishSync(context, "full", progress.serverTime, progress.epoch);
}

function newFullProgress(
    manifest: FederationManifest,
    startedAt: Date,
): FullProgress {
    return {
        phase: "full",
        mediaType: "artist",
        cursor: null,
        serverTime: fullSyncCursor(manifest, startedAt),
        epoch: manifest.catalogEpoch,
    };
}

async function runIncrementalSync(
    context: SyncContext,
    client: ReturnType<typeof createFederationClient>,
    cursor: string,
    catalogEpoch: string,
): Promise<FederationSyncResult> {
    const cursorDate = new Date(cursor);
    if (!Number.isFinite(cursorDate.getTime())) {
        throw new FederationEpochMismatchError(catalogEpoch);
    }
    const since = new Date(cursorDate.getTime() - OVERLAP_MS);
    let pageCursor: string | undefined;
    let nextSince = cursorDate;
    for (let page = 0; page < MAX_REMOTE_PAGES; page += 1) {
        const result = await client.getCatalogDelta({
            since,
            epoch: catalogEpoch,
            cursor: pageCursor,
        });
        context.skippedInvalid += result.skippedInvalid ?? 0;
        context.skippedUnknownTombstones +=
            result.skippedUnknownTombstones ?? 0;
        await applyChanges(
            context,
            client,
            result.changes,
            false,
            result.embeddingSpace,
        );
        await applyTombstones(context, result.tombstones);
        nextSince = new Date(result.nextSince);
        if (!result.nextCursor) {
            return finishSync(
                context,
                "incremental",
                nextSince.toISOString(),
                catalogEpoch,
            );
        }
        pageCursor = result.nextCursor;
    }
    throw new Error("Federation delta sync exceeded the page bound");
}

async function runFederationCatalogSync(
    peer: Awaited<ReturnType<typeof getAvailableFederationConsumerPeer>>,
    client: ReturnType<typeof createFederationClient>,
    startedAt: Date,
): Promise<FederationSyncResult> {
    const manifest = await client.getManifest();
    const localEmbeddingSpace = await resolveLocalEmbeddingSpace(peer.id);
    const context = newSyncContext(
        peer.id,
        peer.scopes,
        localEmbeddingSpace,
        startedAt.getTime(),
    );
    const fullProgress = parseFullProgress(peer.lastSyncCursor);
    if (
        fullProgress &&
        fullProgress.epoch === manifest.catalogEpoch &&
        peer.catalogEpoch === fullProgress.epoch
    ) {
        return runFullSync(
            context,
            client,
            fullProgress,
            true,
            manifest.mediaTypes,
        );
    }
    if (
        !peer.lastSyncCursor ||
        !peer.catalogEpoch ||
        peer.catalogEpoch !== manifest.catalogEpoch ||
        fullProgress
    ) {
        return runFullSync(
            context,
            client,
            newFullProgress(manifest, startedAt),
            false,
            manifest.mediaTypes,
        );
    }
    try {
        return await runIncrementalSync(
            context,
            client,
            peer.lastSyncCursor,
            peer.catalogEpoch,
        );
    } catch (error) {
        if (
            !(error instanceof FederationEpochMismatchError) &&
            !(error instanceof FederationStaleCursorError)
        ) {
            throw error;
        }
        await prisma.federationPeer.update({
            where: { id: peer.id },
            data: { lastSyncCursor: null, catalogEpoch: error.currentEpoch },
        });
        const refreshedManifest = await client.getManifest();
        return runFullSync(
            context,
            client,
            newFullProgress(refreshedManifest, startedAt),
            false,
            refreshedManifest.mediaTypes,
        );
    }
}

/** Runs one serialized, resumable full or incremental consumer-peer sync. */
export async function processFederationSync(
    job: Job<{ peerId: string }>,
): Promise<FederationSyncResult> {
    const data = jobDataSchema.parse(job.data);
    const peer = await getAvailableFederationConsumerPeer(data.peerId);
    const startedAt = new Date();
    const client = createFederationClient(peer, outboundClientOptions());
    const result = await runFederationCatalogSync(peer, client, startedAt);
    await refreshFederationPresence(peer, client);
    return result;
}
