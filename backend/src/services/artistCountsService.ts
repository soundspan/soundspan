/**
 * Artist Counts Service
 *
 * Maintains denormalized counts on the Artist model for fast filtering.
 * These counts enable O(1) library filtering instead of expensive JOINs.
 *
 * Counts maintained:
 * - libraryAlbumCount: Albums with location=LIBRARY that have tracks
 * - discoveryAlbumCount: Albums with location=DISCOVER that have tracks
 * - totalTrackCount: Total tracks across all albums
 * - remoteTrackCount: TrackTidal + TrackYtMusic linked to this artist
 */

import { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import {
    LOCAL_TRACK_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../utils/librarySorting";

const MAX_SCOPED_ARTISTS = 2_000_000;

interface ArtistCounts {
    libraryAlbumCount: number;
    discoveryAlbumCount: number;
    totalTrackCount: number;
    remoteTrackCount: number;
}

type ArtistCountWriteClient = Pick<Prisma.TransactionClient, "$executeRaw">;

/**
 * Calculate counts for a single artist
 */
export async function calculateArtistCounts(
    artistId: string,
): Promise<ArtistCounts> {
    const [
        libraryAlbums,
        discoveryAlbums,
        trackCount,
        tidalCount,
        ytMusicCount,
    ] = await Promise.all([
        prisma.album.count({
            where: {
                artistId,
                location: "LIBRARY",
                tracks: {
                    some: { ...TRACK_VISIBLE_WHERE, ...LOCAL_TRACK_WHERE },
                },
            },
        }),
        prisma.album.count({
            where: {
                artistId,
                location: "DISCOVER",
                tracks: {
                    some: { ...TRACK_VISIBLE_WHERE, ...LOCAL_TRACK_WHERE },
                },
            },
        }),
        prisma.track.count({
            where: {
                ...TRACK_VISIBLE_WHERE,
                ...LOCAL_TRACK_WHERE,
                album: { artistId },
            },
        }),
        prisma.trackTidal.count({
            where: { artistId },
        }),
        prisma.trackYtMusic.count({
            where: { artistId },
        }),
    ]);

    return {
        libraryAlbumCount: libraryAlbums,
        discoveryAlbumCount: discoveryAlbums,
        totalTrackCount: trackCount,
        remoteTrackCount: tidalCount + ytMusicCount,
    };
}

/**
 * Update counts for a single artist
 */
export async function updateArtistCounts(artistId: string): Promise<void> {
    try {
        const counts = await calculateArtistCounts(artistId);

        await prisma.artist.update({
            where: { id: artistId },
            data: {
                ...counts,
                countsLastUpdated: new Date(),
            },
        });
    } catch (error) {
        logger.error(
            `[ArtistCounts] Failed to update counts for ${artistId}:`,
            error,
        );
        throw error;
    }
}

/**
 * Update counts for multiple artists (batch operation)
 */
export async function updateMultipleArtistCounts(
    artistIds: readonly string[],
): Promise<{ updated: number; errors: number }> {
    const updated = await updateArtistCountSet(prisma, artistIds);
    return { updated, errors: 0 };
}

/** Recomputes only the supplied artists in one set-based statement. */
export async function updateArtistCountsInBatches(
    artistIds: readonly string[],
): Promise<{ updated: number; failed: number }> {
    const { updated, errors: failed } =
        await updateMultipleArtistCounts(artistIds);
    return { updated, failed };
}

/** Recomputes supplied artists through an existing transaction boundary. */
export async function updateArtistCountsInTransaction(
    transaction: ArtistCountWriteClient,
    artistIds: readonly string[],
): Promise<number> {
    return updateArtistCountSet(transaction, artistIds);
}

function artistScopeSql(artistIds?: readonly string[]): Prisma.Sql {
    if (artistIds === undefined) {
        return Prisma.sql`SELECT id FROM "Artist"`;
    }
    return Prisma.sql`
        SELECT DISTINCT id
        FROM unnest(${[...artistIds]}::text[]) AS scoped(id)
    `;
}

async function updateArtistCountSet(
    client: ArtistCountWriteClient,
    artistIds?: readonly string[],
): Promise<number> {
    if (artistIds && artistIds.length > MAX_SCOPED_ARTISTS) {
        throw new Error("Scoped artist count update exceeded the item bound");
    }
    if (artistIds?.length === 0) return 0;
    const scope = artistScopeSql(artistIds);
    const countsLastUpdated = new Date();
    return client.$executeRaw(Prisma.sql`
        WITH scope AS (${scope}),
        visible_local_albums AS (
            SELECT DISTINCT track."albumId"
            FROM "Track" AS track
            JOIN "Album" AS album ON album.id = track."albumId"
            JOIN scope ON scope.id = album."artistId"
            WHERE track.origin = 'LOCAL'
              AND track."removedAt" IS NULL
              AND album.location IN ('LIBRARY', 'DISCOVER', 'REMOTE', 'FEDERATED')
        ),
        album_counts AS (
            SELECT album."artistId",
                   COUNT(*) FILTER (WHERE album.location = 'LIBRARY')::integer
                       AS library_count,
                   COUNT(*) FILTER (WHERE album.location = 'DISCOVER')::integer
                       AS discovery_count
            FROM "Album" AS album
            JOIN scope ON scope.id = album."artistId"
            JOIN visible_local_albums ON visible_local_albums."albumId" = album.id
            GROUP BY album."artistId"
        ),
        track_counts AS (
            SELECT album."artistId", COUNT(*)::integer AS track_count
            FROM "Track" AS track
            JOIN "Album" AS album ON album.id = track."albumId"
            JOIN scope ON scope.id = album."artistId"
            WHERE track.origin = 'LOCAL'
              AND track."removedAt" IS NULL
              AND album.location IN ('LIBRARY', 'DISCOVER', 'REMOTE', 'FEDERATED')
            GROUP BY album."artistId"
        ),
        remote_counts AS (
            SELECT remote."artistId", COUNT(*)::integer AS remote_count
            FROM (
                SELECT tidal."artistId" FROM "TrackTidal" AS tidal
                JOIN scope ON scope.id = tidal."artistId"
                UNION ALL
                SELECT youtube."artistId" FROM "TrackYtMusic" AS youtube
                JOIN scope ON scope.id = youtube."artistId"
            ) AS remote
            GROUP BY remote."artistId"
        )
        UPDATE "Artist" AS artist
        SET "libraryAlbumCount" = COALESCE(album_counts.library_count, 0),
            "discoveryAlbumCount" = COALESCE(album_counts.discovery_count, 0),
            "totalTrackCount" = COALESCE(track_counts.track_count, 0),
            "remoteTrackCount" = COALESCE(remote_counts.remote_count, 0),
            "countsLastUpdated" = ${countsLastUpdated}
        FROM scope
        LEFT JOIN album_counts ON album_counts."artistId" = scope.id
        LEFT JOIN track_counts ON track_counts."artistId" = scope.id
        LEFT JOIN remote_counts ON remote_counts."artistId" = scope.id
        WHERE artist.id = scope.id
    `);
}

/**
 * Update counts for an artist by album ID (useful after album changes)
 */
export async function updateArtistCountsByAlbumId(
    albumId: string,
): Promise<void> {
    const album = await prisma.album.findUnique({
        where: { id: albumId },
        select: { artistId: true },
    });

    if (album) {
        await updateArtistCounts(album.artistId);
    }
}

/**
 * Update counts for an artist by track ID (useful after track changes)
 */
export async function updateArtistCountsByTrackId(
    trackId: string,
): Promise<void> {
    const track = await prisma.track.findUnique({
        where: { id: trackId, ...LOCAL_TRACK_WHERE },
        select: {
            album: {
                select: { artistId: true },
            },
        },
    });

    if (track?.album) {
        await updateArtistCounts(track.album.artistId);
    }
}

// Track backfill state
let isBackfillRunning = false;
let backfillProgress = { processed: 0, total: 0, errors: 0 };

/**
 * Check if backfill is currently running
 */
export function isBackfillInProgress(): boolean {
    return isBackfillRunning;
}

/**
 * Backfill counts for all artists with one set-based update.
 */
export async function backfillAllArtistCounts(
    onProgress?: (processed: number, total: number) => void,
): Promise<{ processed: number; errors: number }> {
    if (isBackfillRunning) {
        logger.warn("[ArtistCounts] Backfill already in progress, skipping");
        return { processed: 0, errors: 0 };
    }

    isBackfillRunning = true;
    backfillProgress = { processed: 0, total: 0, errors: 0 };

    try {
        const total = await prisma.artist.count();
        backfillProgress.total = total;
        logger.info(`[ArtistCounts] Starting backfill for ${total} artists`);
        backfillProgress.processed =
            total === 0 ? 0 : await updateArtistCountSet(prisma);
        onProgress?.(backfillProgress.processed, total);

        logger.info(
            `[ArtistCounts] Backfill complete: ${backfillProgress.processed} processed, ${backfillProgress.errors} errors`,
        );

        return {
            processed: backfillProgress.processed,
            errors: backfillProgress.errors,
        };
    } finally {
        isBackfillRunning = false;
    }
}

/**
 * Check if backfill is needed (any artist has null countsLastUpdated)
 */
export async function isBackfillNeeded(): Promise<boolean> {
    const unprocessed = await prisma.artist.count({
        where: { countsLastUpdated: null },
    });
    return unprocessed > 0;
}

/**
 * Get backfill progress
 */
export async function getBackfillProgress(): Promise<{
    processed: number;
    total: number;
    percent: number;
    isRunning: boolean;
    errors: number;
}> {
    if (isBackfillRunning) {
        return {
            processed: backfillProgress.processed,
            total: backfillProgress.total,
            percent:
                backfillProgress.total > 0
                    ? Math.round(
                          (backfillProgress.processed /
                              backfillProgress.total) *
                              100,
                      )
                    : 0,
            isRunning: true,
            errors: backfillProgress.errors,
        };
    }

    const [processed, total] = await Promise.all([
        prisma.artist.count({ where: { countsLastUpdated: { not: null } } }),
        prisma.artist.count(),
    ]);

    return {
        processed,
        total,
        percent: total > 0 ? Math.round((processed / total) * 100) : 100,
        isRunning: false,
        errors: 0,
    };
}

/**
 * Recalculate counts for all artists (force refresh)
 * Use sparingly - this resets countsLastUpdated to null first
 */
export async function forceRecalculateAllCounts(): Promise<void> {
    logger.info("[ArtistCounts] Force recalculating all counts...");

    // Reset countsLastUpdated to trigger backfill
    await prisma.artist.updateMany({
        data: { countsLastUpdated: null },
    });

    // Run backfill
    await backfillAllArtistCounts();
}
