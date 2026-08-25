import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { resolveArtistForRemoteTrack } from "./artistResolutionService";
import { resolveAlbumForRemoteTrack } from "./albumResolutionService";
import { backfillAllArtistCounts } from "./artistCountsService";
import type { MappingProvider } from "./remoteProviders/types";

const log =
    typeof (logger as { child?: unknown }).child === "function"
        ? logger.child("RemoteTrackBackfill")
        : logger;

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 100;
const MAX_BACKFILL_ITERATIONS = 100_000;

interface RemoteTrackRow {
    id: string;
    title: string;
    artist: string;
    album: string;
    artistId: string | null;
}

interface BackfillPhaseConfig {
    label: "TrackTidal" | "TrackYtMusic";
    albumSource: MappingProvider;
    findBatch: (lastId: string) => Promise<RemoteTrackRow[]>;
    update: (
        id: string,
        artistId: string,
        albumId: string | null,
    ) => Promise<unknown>;
    startingErrors: number;
}

interface BackfillPhaseResult {
    processed: number;
    errors: number;
}

let isRunning = false;

/**
 * Check if a remote track backfill is currently running.
 */
export function isRemoteBackfillInProgress(): boolean {
    return isRunning;
}

async function backfillPhase(
    config: BackfillPhaseConfig,
): Promise<BackfillPhaseResult> {
    let processed = 0;
    let errors = 0;
    let lastId = "";

    for (let iteration = 0; iteration < MAX_BACKFILL_ITERATIONS; iteration++) {
        const batch = await config.findBatch(lastId);
        if (batch.length === 0) return { processed, errors };
        lastId = batch[batch.length - 1].id;

        let batchResolved = 0;
        for (const row of batch) {
            try {
                const artistResult = row.artistId
                    ? { id: row.artistId }
                    : await resolveArtistForRemoteTrack(row.artist);
                const albumResult = await resolveAlbumForRemoteTrack(
                    row.album,
                    artistResult.id,
                    config.albumSource,
                    { artistName: row.artist, trackTitle: row.title },
                );
                await config.update(
                    row.id,
                    artistResult.id,
                    albumResult?.id ?? null,
                );
                processed++;
                batchResolved++;
            } catch (err) {
                log.warn(`Failed to resolve ${config.label} id=${row.id}`, err);
                errors++;
            }
        }

        if (batchResolved === 0) {
            log.warn(
                `${config.label} backfill: entire batch of ${batch.length} failed, stopping`,
            );
            return { processed, errors };
        }
        if (processed % 200 === 0 && processed > 0) {
            log.info(
                `${config.label} backfill progress: ${processed} processed, ${config.startingErrors + errors} errors`,
            );
        }
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }

    log.warn(
        `${config.label} backfill exceeded ${MAX_BACKFILL_ITERATIONS} iterations, stopping`,
    );
    return { processed, errors };
}

function findTidalBatch(lastId: string): Promise<RemoteTrackRow[]> {
    return prisma.trackTidal.findMany({
        where: {
            AND: [
                { OR: [{ artistId: null }, { albumId: null }] },
                { id: { gt: lastId } },
            ],
        },
        take: BATCH_SIZE,
        orderBy: { id: "asc" },
        select: {
            id: true,
            title: true,
            artist: true,
            album: true,
            artistId: true,
        },
    });
}

function findYtMusicBatch(lastId: string): Promise<RemoteTrackRow[]> {
    return prisma.trackYtMusic.findMany({
        where: {
            AND: [
                { OR: [{ artistId: null }, { albumId: null }] },
                { id: { gt: lastId } },
            ],
        },
        take: BATCH_SIZE,
        orderBy: { id: "asc" },
        select: {
            id: true,
            title: true,
            artist: true,
            album: true,
            artistId: true,
        },
    });
}

async function runRemoteBackfill(): Promise<{
    tidalProcessed: number;
    ytMusicProcessed: number;
    errors: number;
}> {
    log.info("Starting remote track backfill: TrackTidal phase");
    const tidal = await backfillPhase({
        label: "TrackTidal",
        albumSource: "tidal",
        findBatch: findTidalBatch,
        update: (id, artistId, albumId) =>
            prisma.trackTidal.update({
                where: { id },
                data: { artistId, albumId },
            }),
        startingErrors: 0,
    });
    log.info(`TrackTidal backfill complete: ${tidal.processed} processed`);

    log.info("Starting remote track backfill: TrackYtMusic phase");
    const ytMusic = await backfillPhase({
        label: "TrackYtMusic",
        albumSource: "youtube",
        findBatch: findYtMusicBatch,
        update: (id, artistId, albumId) =>
            prisma.trackYtMusic.update({
                where: { id },
                data: { artistId, albumId },
            }),
        startingErrors: tidal.errors,
    });
    log.info(`TrackYtMusic backfill complete: ${ytMusic.processed} processed`);

    const errors = tidal.errors + ytMusic.errors;
    if (tidal.processed > 0 || ytMusic.processed > 0) {
        log.info("Refreshing artist counts after remote track backfill");
        await backfillAllArtistCounts();
    }
    log.info(
        `Remote track backfill complete: tidal=${tidal.processed}, ytMusic=${ytMusic.processed}, errors=${errors}`,
    );
    return {
        tidalProcessed: tidal.processed,
        ytMusicProcessed: ytMusic.processed,
        errors,
    };
}

/**
 * Backfill artist and album entity links for existing remote tracks
 * that have artistId IS NULL or albumId IS NULL.
 *
 * Processes TrackTidal first, then TrackYtMusic.
 * Uses ID cursor pagination so unresolved rows are visited at most once.
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
    try {
        return await runRemoteBackfill();
    } finally {
        isRunning = false;
    }
}
