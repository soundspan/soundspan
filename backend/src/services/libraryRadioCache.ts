import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { LIBRARY_SURFACE_ALBUM_LOCATIONS } from "../utils/librarySorting";
import {
    TRACK_BROWSE_SQL,
    VISIBLE_TRACK_SQL,
} from "../utils/libraryRadioPredicates";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { findSimilarTracks } from "./hybridSimilarity";
import { getSearchCacheVersion } from "./searchCacheVersion";

const CACHE_TTL_SECONDS = 300;
const MIN_AGGREGATE_TRACKS = 15;
const MAX_GENRE_AGGREGATES = 20;
const cacheLogger = logger.child("LibraryRadioCache");
// This map coalesces fills only within one process. Multi-replica protection is out of scope.
const inFlightLoads = new Map<string, Promise<unknown>>();

/** Maximum analyzed scalar candidates scored for one multi-seed radio build. */
export const RADIO_SCALAR_CANDIDATE_LIMIT = 4_000;

/** Maximum embedding-ranked candidates retained for one source-track station. */
export const RADIO_ANN_CANDIDATE_LIMIT = 500;

export interface GenreRadioAggregate {
    genre: string;
    count: number;
}

export interface DecadeRadioAggregate {
    decade: number;
    count: number;
}

/** Analysis fields required by the multi-seed scalar scoring engine. */
export interface RadioScalarCandidate {
    id: string;
    bpm: number | null;
    energy: number | null;
    valence: number | null;
    arousal: number | null;
    danceability: number | null;
    keyScale: string | null;
    moodTags: string[];
    lastfmTags: string[];
    essentiaGenres: string[];
    instrumentalness: number | null;
    moodHappy: number | null;
    moodSad: number | null;
    moodRelaxed: number | null;
    moodAggressive: number | null;
    moodParty: number | null;
    moodAcoustic: number | null;
    moodElectronic: number | null;
    danceabilityMl: number | null;
    analysisMode: string | null;
    analysisVersion: string | null;
    album: { artistId: string };
}

interface GenreAggregateRow {
    genre: string;
    track_count: bigint;
}

interface DecadeAggregateRow {
    decade: number;
    track_count: bigint;
}

/** Builds the bounded, parameterized genre aggregate query. */
export function buildGenreAggregateQuery(): Prisma.Sql {
    return Prisma.sql`
        SELECT LOWER(g.genre) AS genre, COUNT(DISTINCT t.id) AS track_count
        FROM "Artist" ar
        CROSS JOIN LATERAL jsonb_array_elements_text(ar.genres::jsonb) AS g(genre)
        JOIN "Album" a ON a."artistId" = ar.id
        JOIN "Track" t ON t."albumId" = a.id
        WHERE ${VISIBLE_TRACK_SQL}
          AND ${TRACK_BROWSE_SQL}
          AND a.location IN (${Prisma.join([...LIBRARY_SURFACE_ALBUM_LOCATIONS])})
          AND ar.genres IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM "Artist" blocked_artist
              WHERE LOWER(blocked_artist.name) = LOWER(g.genre)
                 OR LOWER(blocked_artist."normalizedName") = LOWER(g.genre)
          )
        GROUP BY LOWER(g.genre)
        HAVING COUNT(DISTINCT t.id) >= ${MIN_AGGREGATE_TRACKS}
        ORDER BY track_count DESC
        LIMIT ${MAX_GENRE_AGGREGATES}
    `;
}

/** Builds the parameterized effective-year decade aggregate query. */
export function buildDecadeAggregateQuery(): Prisma.Sql {
    return Prisma.sql`
        SELECT
            FLOOR(COALESCE(a."displayYear", a."originalYear", a.year) / 10.0)::int * 10 AS decade,
            COUNT(t.id) AS track_count
        FROM "Album" a
        JOIN "Track" t ON t."albumId" = a.id
        WHERE ${VISIBLE_TRACK_SQL}
          AND ${TRACK_BROWSE_SQL}
          AND a.location IN (${Prisma.join([...LIBRARY_SURFACE_ALBUM_LOCATIONS])})
          AND COALESCE(a."displayYear", a."originalYear", a.year) IS NOT NULL
        GROUP BY decade
        HAVING COUNT(t.id) >= ${MIN_AGGREGATE_TRACKS}
        ORDER BY decade DESC
    `;
}

function isSafePositiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) > 0;
}

function isGenreAggregate(value: unknown): value is GenreRadioAggregate {
    if (typeof value !== "object" || value === null) return false;
    const row = value as Record<string, unknown>;
    return typeof row.genre === "string" && isSafePositiveInteger(row.count);
}

function isDecadeAggregate(value: unknown): value is DecadeRadioAggregate {
    if (typeof value !== "object" || value === null) return false;
    const row = value as Record<string, unknown>;
    return Number.isSafeInteger(row.decade) && isSafePositiveInteger(row.count);
}

function isNullableNumber(value: unknown): value is number | null {
    return (
        value === null || (typeof value === "number" && Number.isFinite(value))
    );
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
    return (
        Array.isArray(value) && value.every((item) => typeof item === "string")
    );
}

function isScalarCandidate(value: unknown): value is RadioScalarCandidate {
    if (typeof value !== "object" || value === null) return false;
    const row = value as Record<string, unknown>;
    const album = row.album as Record<string, unknown> | undefined;
    const numericFields = [
        "bpm",
        "energy",
        "valence",
        "arousal",
        "danceability",
        "instrumentalness",
        "moodHappy",
        "moodSad",
        "moodRelaxed",
        "moodAggressive",
        "moodParty",
        "moodAcoustic",
        "moodElectronic",
        "danceabilityMl",
    ];
    return (
        typeof row.id === "string" &&
        numericFields.every((field) => isNullableNumber(row[field])) &&
        isNullableString(row.keyScale) &&
        isNullableString(row.analysisMode) &&
        isNullableString(row.analysisVersion) &&
        isStringArray(row.moodTags) &&
        isStringArray(row.lastfmTags) &&
        isStringArray(row.essentiaGenres) &&
        typeof album?.artistId === "string"
    );
}

async function readCache<T>(
    cacheKey: string,
    validate: (value: unknown) => value is T,
): Promise<T | null> {
    try {
        const cached = await redisClient.get(cacheKey);
        if (cached === null) return null;
        const parsed: unknown = JSON.parse(cached);
        if (validate(parsed)) return parsed;
        cacheLogger.warn("Invalid library radio cache payload", { cacheKey });
    } catch (error) {
        cacheLogger.warn("Library radio cache read failed", { error });
    }
    return null;
}

async function writeCache(cacheKey: string, value: unknown): Promise<void> {
    try {
        await redisClient.setEx(
            cacheKey,
            CACHE_TTL_SECONDS,
            JSON.stringify(value),
        );
    } catch (error) {
        cacheLogger.warn("Library radio cache write failed", { error });
    }
}

async function cacheKey(name: string): Promise<string> {
    const version = await getSearchCacheVersion();
    return `${name}:v${version}`;
}

async function coalesceCacheLoad<T>(
    key: string,
    validate: (value: unknown) => value is T,
    load: () => Promise<T>,
): Promise<T> {
    const existing = inFlightLoads.get(key);
    if (existing) {
        const value = await existing;
        if (!validate(value)) {
            throw new TypeError("In-flight library radio cache type mismatch");
        }
        return value;
    }
    const pending = (async () => {
        try {
            return await load();
        } finally {
            inFlightLoads.delete(key);
        }
    })();
    inFlightLoads.set(key, pending);
    return pending;
}

function loadCachedValue<T>(
    key: string,
    validate: (value: unknown) => value is T,
    fill: () => Promise<T>,
): Promise<T> {
    return coalesceCacheLoad(key, validate, async () => {
        const cached = await readCache(key, validate);
        if (cached) return cached;
        const value = await fill();
        await writeCache(key, value);
        return value;
    });
}

function normalizeCount(value: bigint): number {
    const count = Number(value);
    if (!isSafePositiveInteger(count)) {
        throw new RangeError(
            "Radio aggregate count is outside the safe integer range",
        );
    }
    return count;
}

/** Loads the versioned genre aggregate snapshot. */
export async function loadGenreRadioAggregates(): Promise<
    GenreRadioAggregate[]
> {
    const key = await cacheKey("library:genres");
    return loadCachedValue(
        key,
        (value): value is GenreRadioAggregate[] =>
            Array.isArray(value) && value.every(isGenreAggregate),
        async () => {
            const rows = await prisma.$queryRaw<GenreAggregateRow[]>(
                buildGenreAggregateQuery(),
            );
            return rows.map((row) => ({
                genre: row.genre,
                count: normalizeCount(row.track_count),
            }));
        },
    );
}

/** Loads the versioned effective-year decade aggregate snapshot. */
export async function loadDecadeRadioAggregates(): Promise<
    DecadeRadioAggregate[]
> {
    const key = await cacheKey("library:decades");
    return loadCachedValue(
        key,
        (value): value is DecadeRadioAggregate[] =>
            Array.isArray(value) && value.every(isDecadeAggregate),
        async () => {
            const rows = await prisma.$queryRaw<DecadeAggregateRow[]>(
                buildDecadeAggregateQuery(),
            );
            return rows.map((row) => ({
                decade: Number(row.decade),
                count: normalizeCount(row.track_count),
            }));
        },
    );
}

const scalarCandidateSelect = {
    id: true,
    bpm: true,
    energy: true,
    valence: true,
    arousal: true,
    danceability: true,
    keyScale: true,
    moodTags: true,
    lastfmTags: true,
    essentiaGenres: true,
    instrumentalness: true,
    moodHappy: true,
    moodSad: true,
    moodRelaxed: true,
    moodAggressive: true,
    moodParty: true,
    moodAcoustic: true,
    moodElectronic: true,
    danceabilityMl: true,
    analysisMode: true,
    analysisVersion: true,
    album: { select: { artistId: true } },
} as const;

function toScalarCandidate(row: RadioScalarCandidate): RadioScalarCandidate {
    return {
        id: row.id,
        bpm: row.bpm,
        energy: row.energy,
        valence: row.valence,
        arousal: row.arousal,
        danceability: row.danceability,
        keyScale: row.keyScale,
        moodTags: row.moodTags,
        lastfmTags: row.lastfmTags,
        essentiaGenres: row.essentiaGenres,
        instrumentalness: row.instrumentalness,
        moodHappy: row.moodHappy,
        moodSad: row.moodSad,
        moodRelaxed: row.moodRelaxed,
        moodAggressive: row.moodAggressive,
        moodParty: row.moodParty,
        moodAcoustic: row.moodAcoustic,
        moodElectronic: row.moodElectronic,
        danceabilityMl: row.danceabilityMl,
        analysisMode: row.analysisMode,
        analysisVersion: row.analysisVersion,
        album: { artistId: row.album.artistId },
    };
}

async function loadScalarCandidatesFromDatabase(): Promise<
    RadioScalarCandidate[]
> {
    const rows = await prisma.track.findMany({
        where: {
            analysisStatus: "completed",
            removedAt: null,
            album: {
                location: { in: [...LIBRARY_SURFACE_ALBUM_LOCATIONS] },
            },
            OR: [
                { origin: "LOCAL" },
                {
                    origin: "FEDERATED",
                    OR: [
                        { dedupOfTrackId: null },
                        { federationPeer: { showDedupedCopies: true } },
                        { dedupOfTrack: { removedAt: { not: null } } },
                    ],
                },
            ],
        },
        select: scalarCandidateSelect,
        orderBy: { id: "asc" },
        take: RADIO_SCALAR_CANDIDATE_LIMIT,
    });
    return rows.map(toScalarCandidate);
}

/** Loads the cached, composite-index-filtered scalar candidate pool. */
export async function loadScalarRadioCandidatePool(): Promise<
    RadioScalarCandidate[]
> {
    const key = await cacheKey("library:radio:scalar");
    return loadCachedValue(
        key,
        (value): value is RadioScalarCandidate[] =>
            Array.isArray(value) &&
            value.length <= RADIO_SCALAR_CANDIDATE_LIMIT &&
            value.every(isScalarCandidate),
        loadScalarCandidatesFromDatabase,
    );
}

function isVibeIdPool(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.length <= RADIO_ANN_CANDIDATE_LIMIT &&
        value.every((id) => typeof id === "string" && id.length > 0)
    );
}

function isRadioIdPool(value: unknown): value is string[] {
    return (
        Array.isArray(value) &&
        value.length <= RADIO_SCALAR_CANDIDATE_LIMIT &&
        value.every((id) => typeof id === "string" && id.length > 0)
    );
}

/** Loads a versioned candidate ID pool while leaving final shuffling to callers. */
export async function loadRadioIdCandidatePool(
    discriminator: string,
    loader: () => Promise<string[]>,
): Promise<string[]> {
    const version = await getSearchCacheVersion();
    const escapedDiscriminator = encodeURIComponent(discriminator);
    const key = `library:radio:ids:v${version}:${escapedDiscriminator}`;
    return loadCachedValue(key, isRadioIdPool, async () =>
        (await loader()).slice(0, RADIO_SCALAR_CANDIDATE_LIMIT),
    );
}

/** Loads an embedding-ranked candidate ID pool for one source track. */
export async function loadVibeRadioCandidateIds(
    sourceTrackId: string,
): Promise<string[]> {
    const version = await getSearchCacheVersion();
    const escapedId = encodeURIComponent(sourceTrackId);
    const key = `library:radio:vibe:v${version}:${escapedId}`;
    return loadCachedValue(key, isVibeIdPool, async () => {
        const similar = await findSimilarTracks(
            sourceTrackId,
            RADIO_ANN_CANDIDATE_LIMIT,
        );
        return similar.map((track) => track.id);
    });
}
