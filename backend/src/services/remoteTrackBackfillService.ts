import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { resolveArtistForRemoteTrack } from "./artistResolutionService";
import { resolveAlbumForRemoteTrack } from "./albumResolutionService";
import { backfillAllArtistCounts } from "./artistCountsService";

const log =
    typeof (logger as { child?: unknown }).child === "function"
        ? logger.child("RemoteTrackBackfill")
        : logger;

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 100;

let isRunning = false;

/**
 * Check if a remote track backfill is currently running.
 */
export function isRemoteBackfillInProgress(): boolean {
    return isRunning;
}

/**
 * Backfill artist and album entity links for existing remote tracks
 * that have artistId IS NULL or albumId IS NULL.
 *
 * Processes TrackTidal first, then TrackYtMusic.
 * Uses re-query pagination (no cursor) because successfully resolved rows
 * fall out of the `artistId: null` filter naturally.
 * After completion, refreshes denormalized artist counts.
 */
export async function backfillRemoteArtistAlbumLinks(): Promise<{
    tidalProcessed: number;
    ytMusicProcessed: number;
    errors: number;
}> {
    if (isRunning) {
        log.warn("Remote track backfill already in progress, skipping");
        return { tidalProcessed: 0, ytMusicProcessed: 0, errors: 0 };
    }

    isRunning = true;
    let tidalProcessed = 0;
    let ytMusicProcessed = 0;
    let errors = 0;

    try {
        // Phase 1: TrackTidal rows needing resolution
        log.info("Starting remote track backfill: TrackTidal phase");

        while (true) {
            const batch = await prisma.trackTidal.findMany({
                where: { OR: [{ artistId: null }, { albumId: null }] },
                take: BATCH_SIZE,
                orderBy: { id: "asc" },
                select: { id: true, artist: true, album: true, artistId: true },
            });

            if (batch.length === 0) break;

            let batchResolved = 0;
            for (const row of batch) {
                try {
                    const artistResult = row.artistId
                        ? { id: row.artistId }
                        : await resolveArtistForRemoteTrack(row.artist);
                    const albumResult = row.album
                        ? await resolveAlbumForRemoteTrack(row.album, artistResult.id, "tidal")
                        : null;

                    await prisma.trackTidal.update({
                        where: { id: row.id },
                        data: {
                            artistId: artistResult.id,
                            albumId: albumResult?.id ?? null,
                        },
                    });
                    tidalProcessed++;
                    batchResolved++;
                } catch (err) {
                    log.warn(`Failed to resolve TrackTidal id=${row.id}`, err);
                    errors++;
                }
            }

            // Safety: if no rows were resolved in this batch, all failed — break
            // to avoid infinite loop
            if (batchResolved === 0) {
                log.warn(`TrackTidal backfill: entire batch of ${batch.length} failed, stopping`);
                break;
            }

            if (tidalProcessed % 200 === 0 && tidalProcessed > 0) {
                log.info(`TrackTidal backfill progress: ${tidalProcessed} processed, ${errors} errors`);
            }

            await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
        }

        log.info(`TrackTidal backfill complete: ${tidalProcessed} processed`);

        // Phase 2: TrackYtMusic rows needing resolution
        log.info("Starting remote track backfill: TrackYtMusic phase");

        while (true) {
            const batch = await prisma.trackYtMusic.findMany({
                where: { OR: [{ artistId: null }, { albumId: null }] },
                take: BATCH_SIZE,
                orderBy: { id: "asc" },
                select: { id: true, artist: true, album: true, artistId: true },
            });

            if (batch.length === 0) break;

            let batchResolved = 0;
            for (const row of batch) {
                try {
                    const artistResult = row.artistId
                        ? { id: row.artistId }
                        : await resolveArtistForRemoteTrack(row.artist);
                    const albumResult = row.album
                        ? await resolveAlbumForRemoteTrack(row.album, artistResult.id, "youtube")
                        : null;

                    await prisma.trackYtMusic.update({
                        where: { id: row.id },
                        data: {
                            artistId: artistResult.id,
                            albumId: albumResult?.id ?? null,
                        },
                    });
                    ytMusicProcessed++;
                    batchResolved++;
                } catch (err) {
                    log.warn(`Failed to resolve TrackYtMusic id=${row.id}`, err);
                    errors++;
                }
            }

            if (batchResolved === 0) {
                log.warn(`TrackYtMusic backfill: entire batch of ${batch.length} failed, stopping`);
                break;
            }

            if (ytMusicProcessed % 200 === 0 && ytMusicProcessed > 0) {
                log.info(`TrackYtMusic backfill progress: ${ytMusicProcessed} processed, ${errors} errors`);
            }

            await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
        }

        log.info(`TrackYtMusic backfill complete: ${ytMusicProcessed} processed`);

        // Phase 3: Refresh denormalized artist counts
        if (tidalProcessed > 0 || ytMusicProcessed > 0) {
            log.info("Refreshing artist counts after remote track backfill");
            await backfillAllArtistCounts();
        }

        log.info(
            `Remote track backfill complete: tidal=${tidalProcessed}, ytMusic=${ytMusicProcessed}, errors=${errors}`
        );

        return { tidalProcessed, ytMusicProcessed, errors };
    } finally {
        isRunning = false;
    }
}
