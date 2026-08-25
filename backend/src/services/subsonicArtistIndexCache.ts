import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { redisClient } from "../utils/redis";
import { getSearchCacheVersion } from "./searchCacheVersion";

const CACHE_KEY_PREFIX = "subsonic:artist-index";
const CACHE_TTL_SECONDS = 300;
const cacheLogger = logger.child("SubsonicArtistIndexCache");

/** Artist fields shared by the cached Subsonic browse surfaces. */
export interface SubsonicArtistIndexEntry {
    id: string;
    name: string;
    heroUrl: string | null;
    albumCount: number;
}

/** Version-namespaced snapshot used by Subsonic artist browse handlers. */
export interface SubsonicArtistIndexSnapshot {
    artists: SubsonicArtistIndexEntry[];
    lastModified: number;
}

function isArtistEntry(value: unknown): value is SubsonicArtistIndexEntry {
    if (typeof value !== "object" || value === null) return false;
    const entry = value as Record<string, unknown>;
    return (
        typeof entry.id === "string" &&
        typeof entry.name === "string" &&
        (typeof entry.heroUrl === "string" || entry.heroUrl === null) &&
        Number.isSafeInteger(entry.albumCount) &&
        Number(entry.albumCount) > 0
    );
}

function isSnapshot(value: unknown): value is SubsonicArtistIndexSnapshot {
    if (typeof value !== "object" || value === null) return false;
    const snapshot = value as Record<string, unknown>;
    return (
        Array.isArray(snapshot.artists) &&
        snapshot.artists.every(isArtistEntry) &&
        Number.isSafeInteger(snapshot.lastModified) &&
        Number(snapshot.lastModified) > 0
    );
}

async function readCachedSnapshot(
    cacheKey: string,
): Promise<SubsonicArtistIndexSnapshot | null> {
    try {
        const cached = await redisClient.get(cacheKey);
        if (cached === null) return null;
        const parsed: unknown = JSON.parse(cached);
        if (isSnapshot(parsed)) return parsed;
        cacheLogger.warn("Invalid cached artist index payload", { cacheKey });
    } catch (error) {
        cacheLogger.warn("Artist index cache read failed", { error });
    }
    return null;
}

async function loadDatabaseSnapshot(): Promise<SubsonicArtistIndexSnapshot> {
    const rows = await prisma.artist.findMany({
        where: { libraryAlbumCount: { gt: 0 } },
        select: {
            id: true,
            name: true,
            heroUrl: true,
            lastSynced: true,
            libraryAlbumCount: true,
        },
        orderBy: { name: "asc" },
    });
    const lastModified =
        rows.reduce(
            (latest, artist) =>
                Math.max(latest, artist.lastSynced?.getTime() ?? 0),
            0,
        ) || Date.now();
    return {
        artists: rows.map((artist) => ({
            id: artist.id,
            name: artist.name,
            heroUrl: artist.heroUrl,
            albumCount: artist.libraryAlbumCount,
        })),
        lastModified,
    };
}

async function writeCachedSnapshot(
    cacheKey: string,
    snapshot: SubsonicArtistIndexSnapshot,
): Promise<void> {
    try {
        await redisClient.setEx(
            cacheKey,
            CACHE_TTL_SECONDS,
            JSON.stringify(snapshot),
        );
    } catch (error) {
        cacheLogger.warn("Artist index cache write failed", { error });
    }
}

/** Loads the cached artist browse snapshot or rebuilds it from denormalized counts. */
export async function loadSubsonicArtistIndexSnapshot(): Promise<SubsonicArtistIndexSnapshot> {
    const version = await getSearchCacheVersion();
    const cacheKey = `${CACHE_KEY_PREFIX}:v${version}`;
    const cached = await readCachedSnapshot(cacheKey);
    if (cached) return cached;
    const snapshot = await loadDatabaseSnapshot();
    await writeCachedSnapshot(cacheKey, snapshot);
    return snapshot;
}
