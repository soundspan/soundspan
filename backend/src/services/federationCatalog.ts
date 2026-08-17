import type {
    FederationCatalogTombstone,
    FederationAudiobookAttributes,
    FederationMediaItemEnvelope,
    FederationMediaType,
    FederationPodcastAttributes,
    FederationTrackAttributes,
} from "@soundspan/media-metadata-contract";
import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { recordFederationEmbeddingExportOutcome } from "../metrics";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { ensureFederationIdentity } from "./federationPeers";
import { fetchEmbeddingsByTrackIds } from "./trackEmbeddings";
import { getActiveSpace, NoActiveEmbeddingSpaceError } from "./embeddingSpaces";
import {
    canExportFederationEmbeddings,
    federationEmbeddingSpaceIdentity,
    type FederationEmbeddingSpaceIdentity,
} from "./federationEmbeddingSpace";
import { encodeFederationEmbeddingSpaceHeader } from "./federationEmbeddingSpaceHeader";

const log = logger.child("FederationCatalog");
const LEGACY_EXPORT_WARNING_INTERVAL_MS = 60_000;
const legacyExportWarningAt = new Map<string, number>();

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

const EXPORTED_PODCAST_WHERE = {} satisfies Prisma.PodcastWhereInput;

const EXPORTED_AUDIOBOOK_WHERE = {
    peerId: null,
} satisfies Prisma.AudiobookWhereInput;

const artistSelect = {
    id: true,
    name: true,
    mbid: true,
    normalizedName: true,
    updatedAt: true,
} satisfies Prisma.ArtistSelect;

const albumSelect = {
    id: true,
    artistId: true,
    title: true,
    rgMbid: true,
    year: true,
    primaryType: true,
    updatedAt: true,
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
    bpm: true,
    beatsCount: true,
    key: true,
    keyScale: true,
    keyStrength: true,
    energy: true,
    loudness: true,
    dynamicRange: true,
    danceability: true,
    valence: true,
    arousal: true,
    instrumentalness: true,
    acousticness: true,
    speechiness: true,
    moodHappy: true,
    moodSad: true,
    moodRelaxed: true,
    moodAggressive: true,
    moodParty: true,
    moodAcoustic: true,
    moodElectronic: true,
    danceabilityMl: true,
    moodTags: true,
    essentiaGenres: true,
    lastfmTags: true,
    updatedAt: true,
} satisfies Prisma.TrackSelect;

const podcastSelect = {
    id: true,
    feedUrl: true,
    title: true,
    author: true,
    description: true,
    imageUrl: true,
    itunesId: true,
    updatedAt: true,
} satisfies Prisma.PodcastSelect;

const audiobookSelect = {
    id: true,
    title: true,
    author: true,
    narrator: true,
    duration: true,
    description: true,
    asin: true,
    isbn: true,
    coverUrl: true,
    localCoverPath: true,
    updatedAt: true,
} satisfies Prisma.AudiobookSelect;

type ArtistRow = Prisma.ArtistGetPayload<{ select: typeof artistSelect }>;
type AlbumRow = Prisma.AlbumGetPayload<{ select: typeof albumSelect }>;
type TrackRow = Prisma.TrackGetPayload<{ select: typeof trackSelect }>;
type PodcastRow = Prisma.PodcastGetPayload<{ select: typeof podcastSelect }>;
type AudiobookRow = Prisma.AudiobookGetPayload<{
    select: typeof audiobookSelect;
}>;

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

interface DeltaRows {
    artists: ArtistRow[];
    albums: AlbumRow[];
    tracks: TrackRow[];
    podcasts: PodcastRow[];
    audiobooks: AudiobookRow[];
    tombstones: Array<{
        id: string;
        entityType: string;
        entityId: string;
        deletedAt: Date;
    }>;
}

/** Internal response metadata kept outside the strict federation JSON body. */
export interface FederationCatalogResponse<T> {
    body: T;
    embeddingSpaceHeaderValue?: string;
}

interface EmbeddingExport {
    embeddings: ReadonlyMap<string, number[]>;
    embeddingSpace?: FederationEmbeddingSpaceIdentity;
}

interface EmbeddingExportRequest {
    include: boolean;
    peerId?: string;
    acceptsEmbeddingSpace?: boolean;
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
        updatedAt: row.updatedAt,
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
        updatedAt: row.updatedAt,
        parentRef: row.artistId,
        attributes: {
            title: row.title,
            rgMbid: row.rgMbid,
            year: row.year,
            primaryType: row.primaryType,
        },
    };
}

function trackAudioFeatures(
    row: TrackRow,
): Pick<
    FederationTrackAttributes,
    keyof Omit<
        FederationTrackAttributes,
        | "title"
        | "discNo"
        | "trackNo"
        | "duration"
        | "mime"
        | "fileSize"
        | "recordingMbid"
        | "isrc"
        | "audioHash"
        | "embedding"
    >
> {
    return {
        bpm: row.bpm,
        beatsCount: row.beatsCount,
        key: row.key,
        keyScale: row.keyScale,
        keyStrength: row.keyStrength,
        energy: row.energy,
        loudness: row.loudness,
        dynamicRange: row.dynamicRange,
        danceability: row.danceability,
        valence: row.valence,
        arousal: row.arousal,
        instrumentalness: row.instrumentalness,
        acousticness: row.acousticness,
        speechiness: row.speechiness,
        moodHappy: row.moodHappy,
        moodSad: row.moodSad,
        moodRelaxed: row.moodRelaxed,
        moodAggressive: row.moodAggressive,
        moodParty: row.moodParty,
        moodAcoustic: row.moodAcoustic,
        moodElectronic: row.moodElectronic,
        danceabilityMl: row.danceabilityMl,
        moodTags: row.moodTags,
        essentiaGenres: row.essentiaGenres,
        lastfmTags: row.lastfmTags,
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
            ...trackAudioFeatures(row),
            ...(embedding ? { embedding } : {}),
        } satisfies FederationTrackAttributes,
    };
}

function podcastEnvelope(row: PodcastRow): FederationMediaItemEnvelope {
    return {
        id: row.id,
        mediaType: "podcast",
        updatedAt: row.updatedAt,
        attributes: {
            feedUrl: row.feedUrl,
            title: row.title,
            author: row.author,
            description: row.description,
            imageUrl: row.imageUrl,
            itunesId: row.itunesId,
        } satisfies FederationPodcastAttributes,
    };
}

function audiobookEnvelope(row: AudiobookRow): FederationMediaItemEnvelope {
    return {
        id: row.id,
        mediaType: "audiobook",
        updatedAt: row.updatedAt,
        attributes: {
            title: row.title,
            author: row.author,
            narrator: row.narrator,
            duration: row.duration,
            description: row.description,
            asin: row.asin,
            isbn: row.isbn,
            coverUrl: Boolean(row.coverUrl || row.localCoverPath),
        } satisfies FederationAudiobookAttributes,
    };
}

function warnSuppressedLegacyExport(
    peerId: string | undefined,
    activeSpaceId: string,
): void {
    const warningKey = peerId ?? "unknown-peer";
    const now = Date.now();
    const previous = legacyExportWarningAt.get(warningKey);
    if (
        previous !== undefined &&
        now - previous < LEGACY_EXPORT_WARNING_INTERVAL_MS
    ) {
        return;
    }
    legacyExportWarningAt.set(warningKey, now);
    log.warn(
        "Suppressing federation embeddings for a peer without embedding-space support",
        { peerId: warningKey, activeSpaceId },
    );
}

async function loadEmbeddingExport(
    rows: readonly TrackRow[],
    request: EmbeddingExportRequest,
): Promise<EmbeddingExport> {
    const empty = { embeddings: new Map<string, number[]>() };
    if (!request.include || rows.length === 0) return empty;
    try {
        const activeSpace = await getActiveSpace();
        if (
            !canExportFederationEmbeddings(
                request.acceptsEmbeddingSpace ?? false,
                activeSpace,
            )
        ) {
            recordFederationEmbeddingExportOutcome("suppressed_legacy_peer");
            warnSuppressedLegacyExport(request.peerId, activeSpace.id);
            return empty;
        }
        const embeddingSpace = federationEmbeddingSpaceIdentity(activeSpace);
        const embeddings = await fetchEmbeddingsByTrackIds(
            rows.map((row) => row.id),
        );
        return {
            embeddings: new Map(
                embeddings.map((row) => [row.trackId, row.embedding]),
            ),
            embeddingSpace,
        };
    } catch (error) {
        if (!(error instanceof NoActiveEmbeddingSpaceError)) throw error;
        log.warn(
            "Serving federation catalog metadata without embeddings because no active embedding space is configured",
        );
        return empty;
    }
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

async function loadPodcastItems(cursor: string | undefined, limit: number) {
    return prisma.podcast.findMany({
        where: {
            ...EXPORTED_PODCAST_WHERE,
            ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: limit + 1,
        select: podcastSelect,
    });
}

async function loadAudiobookItems(cursor: string | undefined, limit: number) {
    return prisma.audiobook.findMany({
        where: {
            ...EXPORTED_AUDIOBOOK_WHERE,
            ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: "asc" },
        take: limit + 1,
        select: audiobookSelect,
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

function carriesEmbeddings(
    items: readonly FederationMediaItemEnvelope[],
): boolean {
    return items.some(
        (item) =>
            item.mediaType === "track" &&
            item.attributes.embedding !== undefined,
    );
}

function catalogResponse<T>(
    body: T,
    embeddingSpace?: FederationEmbeddingSpaceIdentity,
): FederationCatalogResponse<T> {
    return {
        body,
        ...(embeddingSpace
            ? {
                  embeddingSpaceHeaderValue:
                      encodeFederationEmbeddingSpaceHeader(embeddingSpace),
              }
            : {}),
    };
}

/** Returns one bounded id-keyset page in the generic federation envelope. */
export async function getFederationCatalogItems(input: {
    mediaType: FederationMediaType;
    cursor?: string;
    limit: number;
    includeEmbeddings: boolean;
    peerId?: string;
    acceptsEmbeddingSpace?: boolean;
}) {
    if (input.mediaType === "artist") {
        const rows = await loadArtistItems(input.cursor, input.limit);
        return catalogResponse(itemPage(rows.map(artistEnvelope), input.limit));
    }
    if (input.mediaType === "album") {
        const rows = await loadAlbumItems(input.cursor, input.limit);
        return catalogResponse(itemPage(rows.map(albumEnvelope), input.limit));
    }
    if (input.mediaType === "podcast") {
        const rows = await loadPodcastItems(input.cursor, input.limit);
        return catalogResponse(
            itemPage(rows.map(podcastEnvelope), input.limit),
        );
    }
    if (input.mediaType === "audiobook") {
        const rows = await loadAudiobookItems(input.cursor, input.limit);
        return catalogResponse(
            itemPage(rows.map(audiobookEnvelope), input.limit),
        );
    }
    const rows = await loadTrackItems(input.cursor, input.limit);
    const embeddingExport = await loadEmbeddingExport(rows, {
        include: input.includeEmbeddings,
        peerId: input.peerId,
        acceptsEmbeddingSpace: input.acceptsEmbeddingSpace,
    });
    const body = itemPage(
        rows.map((row) =>
            trackEnvelope(row, embeddingExport.embeddings.get(row.id)),
        ),
        input.limit,
    );
    return catalogResponse(
        body,
        carriesEmbeddings(body.items)
            ? embeddingExport.embeddingSpace
            : undefined,
    );
}

/** Returns one visible catalog item for missing-parent recovery. */
export async function getFederationCatalogItem(input: {
    mediaType: FederationMediaType;
    id: string;
    includeEmbeddings: boolean;
    peerId?: string;
    acceptsEmbeddingSpace?: boolean;
}): Promise<FederationCatalogResponse<FederationMediaItemEnvelope> | null> {
    if (input.mediaType === "artist") {
        const row = await prisma.artist.findFirst({
            where: { id: input.id, ...EXPORTED_ARTIST_WHERE },
            select: artistSelect,
        });
        return row ? catalogResponse(artistEnvelope(row)) : null;
    }
    if (input.mediaType === "album") {
        const row = await prisma.album.findFirst({
            where: { id: input.id, ...EXPORTED_ALBUM_WHERE },
            select: albumSelect,
        });
        return row ? catalogResponse(albumEnvelope(row)) : null;
    }
    if (input.mediaType === "podcast") {
        const row = await prisma.podcast.findFirst({
            where: { id: input.id, ...EXPORTED_PODCAST_WHERE },
            select: podcastSelect,
        });
        return row ? catalogResponse(podcastEnvelope(row)) : null;
    }
    if (input.mediaType === "audiobook") {
        const row = await prisma.audiobook.findFirst({
            where: { id: input.id, ...EXPORTED_AUDIOBOOK_WHERE },
            select: audiobookSelect,
        });
        return row ? catalogResponse(audiobookEnvelope(row)) : null;
    }
    const row = await prisma.track.findFirst({
        where: { id: input.id, ...EXPORTED_TRACK_WHERE },
        select: trackSelect,
    });
    if (!row) return null;
    const embeddingExport = await loadEmbeddingExport([row], {
        include: input.includeEmbeddings,
        peerId: input.peerId,
        acceptsEmbeddingSpace: input.acceptsEmbeddingSpace,
    });
    const body = trackEnvelope(row, embeddingExport.embeddings.get(row.id));
    return catalogResponse(
        body,
        carriesEmbeddings([body]) ? embeddingExport.embeddingSpace : undefined,
    );
}

/** Builds instance identity and visible local-library counts for federation v1. */
export async function getFederationManifest(
    embeddingsAvailable: boolean,
    now: Date = new Date(),
) {
    const identity = await ensureFederationIdentity();
    const [artists, albums, tracks, podcasts, audiobooks] = await Promise.all([
        prisma.artist.count({ where: EXPORTED_ARTIST_WHERE }),
        prisma.album.count({ where: EXPORTED_ALBUM_WHERE }),
        prisma.track.count({ where: EXPORTED_TRACK_WHERE }),
        prisma.podcast.count({ where: EXPORTED_PODCAST_WHERE }),
        prisma.audiobook.count({ where: EXPORTED_AUDIOBOOK_WHERE }),
    ]);
    return {
        instanceId: identity.federationInstanceId,
        name: config.federation.instanceName,
        version: config.appVersion,
        catalogEpoch: identity.catalogEpoch,
        mediaTypes: [
            "artist",
            "album",
            "track",
            "podcast",
            "audiobook",
        ] as FederationMediaType[],
        counts: { artists, albums, tracks, podcasts, audiobooks },
        embeddingsAvailable,
        serverTime: now,
    };
}

function cursorPredicate(
    field: "updatedAt" | "deletedAt",
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
                { updatedAt: { gt: since, lte: until } },
                cursorPredicate("updatedAt", cursor),
            ],
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
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
                { updatedAt: { gt: since, lte: until } },
                cursorPredicate("updatedAt", cursor),
            ],
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
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

async function loadPodcastDelta(
    since: Date,
    until: Date,
    cursor: FederationDeltaCursor | undefined,
    take: number,
) {
    return prisma.podcast.findMany({
        where: {
            ...EXPORTED_PODCAST_WHERE,
            AND: [
                { updatedAt: { gt: since, lte: until } },
                cursorPredicate("updatedAt", cursor),
            ],
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take,
        select: podcastSelect,
    });
}

async function loadAudiobookDelta(
    since: Date,
    until: Date,
    cursor: FederationDeltaCursor | undefined,
    take: number,
) {
    return prisma.audiobook.findMany({
        where: {
            ...EXPORTED_AUDIOBOOK_WHERE,
            AND: [
                { updatedAt: { gt: since, lte: until } },
                cursorPredicate("updatedAt", cursor),
            ],
        },
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        take,
        select: audiobookSelect,
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
            entityType: {
                in: ["artist", "album", "track", "podcast", "audiobook"],
            },
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
    if (timeOrder !== 0) return timeOrder;
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
}

function mergeDeltaEvents(
    rows: DeltaRows,
    embeddingExport: EmbeddingExport,
): DeltaEvent[] {
    return [
        ...rows.artists.map((row) => ({
            id: row.id,
            updatedAt: row.updatedAt,
            envelope: artistEnvelope(row),
        })),
        ...rows.albums.map((row) => ({
            id: row.id,
            updatedAt: row.updatedAt,
            envelope: albumEnvelope(row),
        })),
        ...rows.tracks.map((row) => ({
            id: row.id,
            updatedAt: row.updatedAt,
            envelope: trackEnvelope(
                row,
                embeddingExport.embeddings.get(row.id),
            ),
        })),
        ...rows.podcasts.map((row) => ({
            id: row.id,
            updatedAt: row.updatedAt,
            envelope: podcastEnvelope(row),
        })),
        ...rows.audiobooks.map((row) => ({
            id: row.id,
            updatedAt: row.updatedAt,
            envelope: audiobookEnvelope(row),
        })),
        ...rows.tombstones.map((row) => ({
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

async function buildDeltaEvents(input: {
    since: Date;
    until: Date;
    cursor?: FederationDeltaCursor;
    limit: number;
    includeEmbeddings: boolean;
    peerId?: string;
    acceptsEmbeddingSpace?: boolean;
}): Promise<{
    events: DeltaEvent[];
    embeddingSpace?: FederationEmbeddingSpaceIdentity;
}> {
    const take = input.limit + 1;
    const [artists, albums, tracks, podcasts, audiobooks, tombstones] =
        await Promise.all([
            loadArtistDelta(input.since, input.until, input.cursor, take),
            loadAlbumDelta(input.since, input.until, input.cursor, take),
            loadTrackDelta(input.since, input.until, input.cursor, take),
            loadPodcastDelta(input.since, input.until, input.cursor, take),
            loadAudiobookDelta(input.since, input.until, input.cursor, take),
            loadTombstoneDelta(input.since, input.until, input.cursor, take),
        ]);
    const embeddingExport = await loadEmbeddingExport(tracks, {
        include: input.includeEmbeddings,
        peerId: input.peerId,
        acceptsEmbeddingSpace: input.acceptsEmbeddingSpace,
    });
    const events = mergeDeltaEvents(
        { artists, albums, tracks, podcasts, audiobooks, tombstones },
        embeddingExport,
    );
    return { events, embeddingSpace: embeddingExport.embeddingSpace };
}

/** Returns a bounded merged delta page, or a typed epoch mismatch result. */
export async function getFederationCatalogDelta(input: {
    since: Date;
    epoch: string;
    cursor?: FederationDeltaCursor;
    limit: number;
    includeEmbeddings: boolean;
    peerId?: string;
    acceptsEmbeddingSpace?: boolean;
    now?: Date;
}) {
    const identity = await ensureFederationIdentity();
    if (input.epoch !== identity.catalogEpoch) {
        return catalogResponse({
            kind: "epochMismatch" as const,
            currentEpoch: identity.catalogEpoch,
        });
    }
    const snapshotAt = input.now ?? new Date();
    const retainedDays = Math.max(
        0,
        config.workers.federationTombstoneRetentionDays - 2,
    );
    const oldestCursor = new Date(
        snapshotAt.getTime() - retainedDays * 24 * 60 * 60 * 1_000,
    );
    if (input.since < oldestCursor) {
        return catalogResponse({
            kind: "staleCursor" as const,
            currentEpoch: identity.catalogEpoch,
        });
    }
    const deltaExport = await buildDeltaEvents({ ...input, until: snapshotAt });
    const events = deltaExport.events;
    const page = events.slice(0, input.limit);
    const last = page[page.length - 1];
    const body = {
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
    return catalogResponse(
        body,
        carriesEmbeddings(body.changes)
            ? deltaExport.embeddingSpace
            : undefined,
    );
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

/** Finds an audiobook only when it is eligible for direct host export. */
export async function findExportedFederationAudiobook(audiobookId: string) {
    return prisma.audiobook.findFirst({
        where: { id: audiobookId, ...EXPORTED_AUDIOBOOK_WHERE },
        select: {
            id: true,
            localCoverPath: true,
            coverUrl: true,
        },
    });
}
