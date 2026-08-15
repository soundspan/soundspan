import type {
    FederationCatalogTombstone,
    FederationMediaItemEnvelope,
    FederationMediaType,
} from "@soundspan/media-metadata-contract";
import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../utils/db";
import { ensureFederationIdentity } from "./federationPeers";
import { fetchEmbeddingsByTrackIds } from "./trackEmbeddings";

const EXPORTED_ALBUM_RELATION_WHERE = {
    location: "LIBRARY",
    peerId: null,
} satisfies Prisma.AlbumWhereInput;

const EXPORTED_ARTIST_WHERE = {
    peerId: null,
    albums: { some: EXPORTED_ALBUM_RELATION_WHERE },
} satisfies Prisma.ArtistWhereInput;

const EXPORTED_ALBUM_WHERE = {
    ...EXPORTED_ALBUM_RELATION_WHERE,
    artist: { peerId: null },
} satisfies Prisma.AlbumWhereInput;

const EXPORTED_TRACK_WHERE = {
    origin: "LOCAL",
    peerId: null,
    removedAt: null,
    album: EXPORTED_ALBUM_WHERE,
} satisfies Prisma.TrackWhereInput;

const artistSelect = {
    id: true,
    name: true,
    mbid: true,
    normalizedName: true,
    lastSynced: true,
} satisfies Prisma.ArtistSelect;

const albumSelect = {
    id: true,
    artistId: true,
    title: true,
    rgMbid: true,
    year: true,
    primaryType: true,
    lastSynced: true,
} satisfies Prisma.AlbumSelect;

const trackSelect = {
    id: true,
    albumId: true,
    title: true,
    discNo: true,
    trackNo: true,
    duration: true,
    mime: true,
    fileSize: true,
    recordingMbid: true,
    isrc: true,
    audioHash: true,
    updatedAt: true,
} satisfies Prisma.TrackSelect;

type ArtistRow = Prisma.ArtistGetPayload<{ select: typeof artistSelect }>;
type AlbumRow = Prisma.AlbumGetPayload<{ select: typeof albumSelect }>;
type TrackRow = Prisma.TrackGetPayload<{ select: typeof trackSelect }>;

/** Decoded high-water key for deterministic federation delta pagination. */
export interface FederationDeltaCursor {
    updatedAt: Date;
    id: string;
}

interface DeltaEvent {
    id: string;
    updatedAt: Date;
    envelope?: FederationMediaItemEnvelope;
    tombstone?: FederationCatalogTombstone;
}

/** Encodes a stable, opaque delta event key for the next request. */
export function encodeFederationDeltaCursor(
    cursor: FederationDeltaCursor,
): string {
    return Buffer.from(
        JSON.stringify({
            updatedAt: cursor.updatedAt.toISOString(),
            id: cursor.id,
        }),
    ).toString("base64url");
}

/** Decodes and validates the structural parts of a federation delta cursor. */
export function decodeFederationDeltaCursor(
    value: string,
): FederationDeltaCursor {
    const parsed: unknown = JSON.parse(
        Buffer.from(value, "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object")
        throw new Error("Invalid delta cursor");
    const record = parsed as Record<string, unknown>;
    const updatedAt = new Date(String(record.updatedAt));
    if (
        !Number.isFinite(updatedAt.getTime()) ||
        typeof record.id !== "string" ||
        !record.id
    ) {
        throw new Error("Invalid delta cursor");
    }
    return { updatedAt, id: record.id };
}

function artistEnvelope(row: ArtistRow): FederationMediaItemEnvelope {
    return {
        id: row.id,
        mediaType: "artist",
        updatedAt: row.lastSynced,
        attributes: {
            name: row.name,
            mbid: row.mbid,
            normalizedName: row.normalizedName,
        },
    };
}

function albumEnvelope(row: AlbumRow): FederationMediaItemEnvelope {
    return {
        id: row.id,
        mediaType: "album",
        updatedAt: row.lastSynced,
        parentRef: row.artistId,
        attributes: {
            title: row.title,
            rgMbid: row.rgMbid,
            year: row.year,
            primaryType: row.primaryType,
        },
    };
}

function trackEnvelope(
    row: TrackRow,
    embedding?: number[],
): FederationMediaItemEnvelope {
    return {
        id: row.id,
        mediaType: "track",
        updatedAt: row.updatedAt,
        parentRef: row.albumId,
        attributes: {
            title: row.title,
            discNo: row.discNo,
            trackNo: row.trackNo,
            duration: row.duration,
            mime: row.mime,
            fileSize: row.fileSize,
            recordingMbid: row.recordingMbid,
            isrc: row.isrc,
            audioHash: row.audioHash,
            ...(embedding ? { embedding } : {}),
        },
    };
}

async function embeddingMap(rows: readonly TrackRow[], include: boolean) {
    if (!include || rows.length === 0) return new Map<string, number[]>();
    const embeddings = await fetchEmbeddingsByTrackIds(
        rows.map((row) => row.id),
    );
    return new Map(embeddings.map((row) => [row.trackId, row.embedding]));
}

async function loadArtistItems(cursor: string | undefined, limit: number) {
    return prisma.artist.findMany({
        where: {
            ...EXPORTED_ARTIST_WHERE,
            ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: limit + 1,
        select: artistSelect,
    });
}

async function loadAlbumItems(cursor: string | undefined, limit: number) {
    return prisma.album.findMany({
        where: {
            ...EXPORTED_ALBUM_WHERE,
            ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: limit + 1,
        select: albumSelect,
    });
}

async function loadTrackItems(cursor: string | undefined, limit: number) {
    return prisma.track.findMany({
        where: {
            ...EXPORTED_TRACK_WHERE,
            ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: limit + 1,
        select: trackSelect,
    });
}

function itemPage(items: FederationMediaItemEnvelope[], limit: number) {
    const page = items.slice(0, limit);
    return {
        items: page,
        nextCursor:
            items.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
}

/** Returns one bounded id-keyset page in the generic federation envelope. */
export async function getFederationCatalogItems(input: {
    mediaType: FederationMediaType;
    cursor?: string;
    limit: number;
    includeEmbeddings: boolean;
}) {
    if (input.mediaType === "artist") {
        const rows = await loadArtistItems(input.cursor, input.limit);
        return itemPage(rows.map(artistEnvelope), input.limit);
    }
    if (input.mediaType === "album") {
        const rows = await loadAlbumItems(input.cursor, input.limit);
        return itemPage(rows.map(albumEnvelope), input.limit);
    }
    const rows = await loadTrackItems(input.cursor, input.limit);
    const embeddings = await embeddingMap(rows, input.includeEmbeddings);
    return itemPage(
        rows.map((row) => trackEnvelope(row, embeddings.get(row.id))),
        input.limit,
    );
}

/** Builds instance identity and visible local-library counts for federation v1. */
export async function getFederationManifest(embeddingsAvailable: boolean) {
    const identity = await ensureFederationIdentity();
    const [artists, albums, tracks] = await Promise.all([
        prisma.artist.count({ where: EXPORTED_ARTIST_WHERE }),
        prisma.album.count({ where: EXPORTED_ALBUM_WHERE }),
        prisma.track.count({ where: EXPORTED_TRACK_WHERE }),
    ]);
    return {
        instanceId: identity.federationInstanceId,
        name: config.federation.instanceName,
        version: config.appVersion,
        catalogEpoch: identity.catalogEpoch,
        mediaTypes: ["artist", "album", "track"] as FederationMediaType[],
        counts: { artists, albums, tracks },
        embeddingsAvailable,
    };
}

function cursorPredicate(
    field: "lastSynced" | "updatedAt" | "deletedAt",
    cursor?: FederationDeltaCursor,
) {
    if (!cursor) return {};
    return {
        OR: [
            { [field]: { gt: cursor.updatedAt } },
            { [field]: cursor.updatedAt, id: { gt: cursor.id } },
        ],
    };
}

async function loadArtistDelta(
    since: Date,
    until: Date,
    cursor: FederationDeltaCursor | undefined,
    take: number,
) {
    return prisma.artist.findMany({
        where: {
            ...EXPORTED_ARTIST_WHERE,
            AND: [
                { lastSynced: { gt: since, lte: until } },
                cursorPredicate("lastSynced", cursor),
            ],
        },
        orderBy: [{ lastSynced: "asc" }, { id: "asc" }],
        take,
        select: artistSelect,
    });
}

async function loadAlbumDelta(
    since: Date,
    until: Date,
    cursor: FederationDeltaCursor | undefined,
    take: number,
) {
    return prisma.album.findMany({
        where: {
            ...EXPORTED_ALBUM_WHERE,
            AND: [
                { lastSynced: { gt: since, lte: until } },
                cursorPredicate("lastSynced", cursor),
            ],
        },
        orderBy: [{ lastSynced: "asc" }, { id: "asc" }],
        take,
        select: albumSelect,
    });
}

async function loadTrackDelta(
    since: Date,
    until: Date,
    cursor: FederationDeltaCursor | undefined,
    take: number,
) {
    return prisma.track.findMany({
        where: {
            ...EXPORTED_TRACK_WHERE,
            AND: [
                { updatedAt: { gt: since, lte: until } },
                cursorPredicate("updatedAt", cursor),
            ],
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take,
        select: trackSelect,
    });
}

async function loadTombstoneDelta(
    since: Date,
    until: Date,
    cursor: FederationDeltaCursor | undefined,
    take: number,
) {
    return prisma.federationTombstone.findMany({
        where: {
            entityType: { in: ["artist", "album", "track"] },
            AND: [
                { deletedAt: { gt: since, lte: until } },
                cursorPredicate("deletedAt", cursor),
            ],
        },
        orderBy: [{ deletedAt: "asc" }, { id: "asc" }],
        take,
        select: { id: true, entityType: true, entityId: true, deletedAt: true },
    });
}

function compareDeltaEvents(left: DeltaEvent, right: DeltaEvent): number {
    const timeOrder = left.updatedAt.getTime() - right.updatedAt.getTime();
    return timeOrder || left.id.localeCompare(right.id);
}

async function buildDeltaEvents(input: {
    since: Date;
    until: Date;
    cursor?: FederationDeltaCursor;
    limit: number;
    includeEmbeddings: boolean;
}): Promise<DeltaEvent[]> {
    const take = input.limit + 1;
    const [artists, albums, tracks, tombstones] = await Promise.all([
        loadArtistDelta(input.since, input.until, input.cursor, take),
        loadAlbumDelta(input.since, input.until, input.cursor, take),
        loadTrackDelta(input.since, input.until, input.cursor, take),
        loadTombstoneDelta(input.since, input.until, input.cursor, take),
    ]);
    const embeddings = await embeddingMap(tracks, input.includeEmbeddings);
    return [
        ...artists.map((row) => ({
            id: row.id,
            updatedAt: row.lastSynced,
            envelope: artistEnvelope(row),
        })),
        ...albums.map((row) => ({
            id: row.id,
            updatedAt: row.lastSynced,
            envelope: albumEnvelope(row),
        })),
        ...tracks.map((row) => ({
            id: row.id,
            updatedAt: row.updatedAt,
            envelope: trackEnvelope(row, embeddings.get(row.id)),
        })),
        ...tombstones.map((row) => ({
            id: row.id,
            updatedAt: row.deletedAt,
            tombstone: {
                entityType: row.entityType as FederationMediaType,
                entityId: row.entityId,
                deletedAt: row.deletedAt,
            },
        })),
    ].sort(compareDeltaEvents);
}

/** Returns a bounded merged delta page, or a typed epoch mismatch result. */
export async function getFederationCatalogDelta(input: {
    since: Date;
    epoch: string;
    cursor?: FederationDeltaCursor;
    limit: number;
    includeEmbeddings: boolean;
    now?: Date;
}) {
    const identity = await ensureFederationIdentity();
    if (input.epoch !== identity.catalogEpoch) {
        return {
            kind: "epochMismatch" as const,
            currentEpoch: identity.catalogEpoch,
        };
    }
    const snapshotAt = input.now ?? new Date();
    const events = await buildDeltaEvents({ ...input, until: snapshotAt });
    const page = events.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
        kind: "ok" as const,
        changes: page.flatMap((event) =>
            event.envelope ? [event.envelope] : [],
        ),
        tombstones: page.flatMap((event) =>
            event.tombstone ? [event.tombstone] : [],
        ),
        nextCursor:
            events.length > input.limit && last
                ? encodeFederationDeltaCursor({
                      updatedAt: last.updatedAt,
                      id: last.id,
                  })
                : null,
        nextSince: snapshotAt,
    };
}

/** Finds an album only when it is eligible for direct host export. */
export async function findExportedFederationAlbum(albumId: string) {
    return prisma.album.findFirst({
        where: { id: albumId, ...EXPORTED_ALBUM_WHERE },
        select: { id: true },
    });
}

/** Finds stream metadata only for an eligible local visible track. */
export async function findExportedFederationTrack(trackId: string) {
    return prisma.track.findFirst({
        where: { id: trackId, ...EXPORTED_TRACK_WHERE },
        select: { id: true, filePath: true, fileModified: true, mime: true },
    });
}
