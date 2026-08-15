import type { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { decodeFederationIdentity } from "../utils/federationDedup";
import { trackMappingService } from "./trackMappingService";

const arbitrationTrackSelect = {
    id: true,
    title: true,
    dedupPinned: true,
    dedupOfTrackId: true,
    audioHash: true,
    recordingMbid: true,
    isrc: true,
    discNo: true,
    trackNo: true,
    album: {
        select: {
            title: true,
            rgMbid: true,
            artist: { select: { name: true } },
        },
    },
    dedupOfTrack: {
        select: {
            id: true,
            title: true,
            album: {
                select: {
                    title: true,
                    artist: { select: { name: true } },
                },
            },
            mappings: {
                where: { source: "federation", stale: false },
                orderBy: [{ confidence: "desc" }, { id: "asc" }],
                take: 1,
                select: { confidence: true },
            },
        },
    },
} satisfies Prisma.TrackSelect;

type ArbitrationTrackRow = Prisma.TrackGetPayload<{
    select: typeof arbitrationTrackSelect;
}>;
type PrismaClient = Prisma.TransactionClient | typeof prisma;

/** Administrator-selected dedup action for one materialized peer track. */
export type FederationDedupAction =
    | { action: "link"; localTrackId: string }
    | { action: "unlink" }
    | { action: "reset" };

interface StandardMatch {
    id: string;
    confidence: number;
}

function publicTrack(track: {
    id: string;
    title: string;
    album: { title: string; artist: { name: string } };
}) {
    return {
        id: track.id,
        title: track.title,
        album: { title: track.album.title },
        artist: { name: track.album.artist.name },
    };
}

function confidenceTier(confidence: number | null) {
    if (confidence === null) return null;
    if (confidence >= 1) return "audioHash" as const;
    if (confidence >= 0.95) return "recordingMbid" as const;
    if (confidence >= 0.9) return "isrc" as const;
    if (confidence >= 0.8) return "albumPosition" as const;
    return null;
}

function arbitrationItem(row: ArbitrationTrackRow) {
    const confidence = row.dedupOfTrack?.mappings[0]?.confidence ?? null;
    return {
        federatedTrack: publicTrack(row),
        localTrack: row.dedupOfTrack ? publicTrack(row.dedupOfTrack) : null,
        tier: confidenceTier(confidence),
        confidence,
        pinned: row.dedupPinned,
    };
}

async function loadArbitrationTrack(
    client: PrismaClient,
    trackId: string,
): Promise<ArbitrationTrackRow | null> {
    return client.track.findFirst({
        where: {
            id: trackId,
            origin: "FEDERATED",
            peerId: { not: null },
            removedAt: null,
        },
        select: arbitrationTrackSelect,
    });
}

/** Lists a bounded keyset page of linked or manually pinned peer tracks. */
export async function listFederationPeerDedup(input: {
    peerId: string;
    cursor?: string;
    limit: number;
}) {
    const peer = await prisma.federationPeer.findUnique({
        where: { id: input.peerId },
        select: { id: true },
    });
    if (!peer) return null;
    const rows = await prisma.track.findMany({
        where: {
            peerId: input.peerId,
            origin: "FEDERATED",
            removedAt: null,
            ...(input.cursor ? { id: { gt: input.cursor } } : {}),
            OR: [{ dedupOfTrackId: { not: null } }, { dedupPinned: true }],
        },
        orderBy: { id: "asc" },
        take: input.limit + 1,
        select: arbitrationTrackSelect,
    });
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    return {
        items: page.map(arbitrationItem),
        nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
}

async function findLocalTrack(
    client: PrismaClient,
    trackId: string,
): Promise<{ id: string } | null> {
    return client.track.findFirst({
        where: { id: trackId, origin: "LOCAL", removedAt: null },
        select: { id: true },
    });
}

async function findTierMatch(
    client: PrismaClient,
    where: Prisma.TrackWhereInput | null,
    confidence: number,
): Promise<StandardMatch | null> {
    if (!where) return null;
    const row = await client.track.findFirst({
        where: { ...where, origin: "LOCAL", removedAt: null },
        orderBy: { id: "asc" },
        select: { id: true },
    });
    return row ? { id: row.id, confidence } : null;
}

async function findStandardMatch(
    client: PrismaClient,
    track: ArbitrationTrackRow,
): Promise<StandardMatch | null> {
    const tiers: Array<[Prisma.TrackWhereInput | null, number]> = [
        [track.audioHash ? { audioHash: track.audioHash } : null, 1],
        [
            track.recordingMbid ? { recordingMbid: track.recordingMbid } : null,
            0.95,
        ],
        [track.isrc ? { isrc: track.isrc } : null, 0.9],
        [
            {
                discNo: track.discNo,
                trackNo: track.trackNo,
                album: {
                    rgMbid: decodeFederationIdentity(track.album.rgMbid),
                    location: "LIBRARY",
                },
            },
            0.8,
        ],
    ];
    for (let index = 0; index < tiers.length; index += 1) {
        const match = await findTierMatch(
            client,
            tiers[index][0],
            tiers[index][1],
        );
        if (match) return match;
    }
    return null;
}

async function applyArbitration(
    client: PrismaClient,
    track: ArbitrationTrackRow,
    action: FederationDedupAction,
): Promise<StandardMatch | null | undefined> {
    let target: StandardMatch | null | undefined;
    if (action.action === "link") {
        const local = await findLocalTrack(client, action.localTrackId);
        if (!local) return undefined;
        target = { id: local.id, confidence: 0 };
    } else if (action.action === "reset") {
        target = await findStandardMatch(client, track);
    } else {
        target = null;
    }
    const updated = await client.track.updateMany({
        where: { id: track.id, origin: "FEDERATED", peerId: { not: null } },
        data: {
            dedupOfTrackId: target?.id ?? null,
            dedupPinned: action.action !== "reset",
        },
    });
    return updated.count === 1 ? target : undefined;
}

/** Pins, unpins, or resets one federated track's local-wins arbitration. */
export async function arbitrateFederationTrackDedup(
    trackId: string,
    action: FederationDedupAction,
) {
    const result = await prisma.$transaction(async (transaction) => {
        const track = await loadArbitrationTrack(transaction, trackId);
        if (!track) return undefined;
        return applyArbitration(transaction, track, action);
    });
    if (result === undefined) return null;
    if (action.action === "reset" && result) {
        await trackMappingService.createMapping({
            trackId: result.id,
            confidence: result.confidence,
            source: "federation",
        });
    }
    const updated = await loadArbitrationTrack(prisma, trackId);
    return updated ? arbitrationItem(updated) : null;
}
