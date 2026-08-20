import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { recordProviderTrackGcPass } from "../metrics";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { cleanupOrphanedLibraryEntities } from "./libraryOrphanCleanup";
import {
    providerTrackCollectableWhere,
    providerTrackRetentionCutoff,
} from "./providerTrackRetention";

const log = logger.child("ProviderTrackGc");
const PROVIDER_BATCH_SIZE = 100;
// Fifty small transactions bound lock time while draining migration-sized backlogs.
const MAX_PROVIDER_GC_PASSES = 50;
const PROVIDER_BACKLOG_GAUGE_CAP = 50_000;
const EMPTY_COUNTS = { tidal: 0, youtube: 0 } as const;

interface ProviderTrackCandidates {
    tidal: Array<{ id: string }>;
    youtube: Array<{ id: string }>;
}

type ProviderTrackCounts = { tidal: number; youtube: number };

interface ProviderTrackBacklog {
    backlog: ProviderTrackCounts;
    oldestCollectableAgeSeconds: ProviderTrackCounts;
}

interface ProviderTrackDrainProgress {
    selected: ProviderTrackCounts;
    deleted: ProviderTrackCounts;
}

/** Summary of one bounded provider-track garbage collection pass. */
export interface ProviderTrackGcResult {
    selected: { tidal: number; youtube: number };
    deleted: { tidal: number; youtube: number };
    orphanedParents: { albums: number; artists: number };
}

/** Optional deterministic inputs for one provider-track GC pass. */
export interface ProviderTrackGcOptions {
    now?: Date;
    retentionDays?: number;
}

async function loadCandidates(cutoff: Date): Promise<ProviderTrackCandidates> {
    const where = providerTrackCollectableWhere(cutoff);
    const [tidal, youtube] = await Promise.all([
        prisma.trackTidal.findMany({
            where,
            orderBy: { id: "asc" },
            take: PROVIDER_BATCH_SIZE,
            select: { id: true },
        }),
        prisma.trackYtMusic.findMany({
            where,
            orderBy: { id: "asc" },
            take: PROVIDER_BATCH_SIZE,
            select: { id: true },
        }),
    ]);
    return { tidal, youtube };
}

async function deleteUnlinkedMappings(
    transaction: Prisma.TransactionClient,
    candidates: ProviderTrackCandidates,
    cutoff: Date,
): Promise<void> {
    const where = providerTrackCollectableWhere(cutoff);
    const tidalIds = candidates.tidal.map((track) => track.id);
    const youtubeIds = candidates.youtube.map((track) => track.id);
    await transaction.trackMapping.deleteMany({
        where: {
            trackId: null,
            OR: [
                {
                    trackYtMusicId: null,
                    trackTidal: { id: { in: tidalIds }, ...where },
                },
                {
                    trackTidalId: null,
                    trackYtMusic: { id: { in: youtubeIds }, ...where },
                },
                {
                    trackTidal: { id: { in: tidalIds }, ...where },
                    trackYtMusic: { id: { in: youtubeIds }, ...where },
                },
            ],
        },
    });
}

async function deleteCandidates(
    candidates: ProviderTrackCandidates,
    cutoff: Date,
): Promise<{ tidal: number; youtube: number }> {
    return prisma.$transaction(async (transaction) => {
        await deleteUnlinkedMappings(transaction, candidates, cutoff);
        const where = providerTrackCollectableWhere(cutoff);
        const tidal = await transaction.trackTidal.deleteMany({
            where: {
                id: { in: candidates.tidal.map((track) => track.id) },
                ...where,
            },
        });
        const youtube = await transaction.trackYtMusic.deleteMany({
            where: {
                id: { in: candidates.youtube.map((track) => track.id) },
                ...where,
            },
        });
        return { tidal: tidal.count, youtube: youtube.count };
    });
}

function elapsedSeconds(startedAt: bigint): number {
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
}

function addCounts(
    total: ProviderTrackCounts,
    addition: ProviderTrackCounts,
): ProviderTrackCounts {
    return {
        tidal: total.tidal + addition.tidal,
        youtube: total.youtube + addition.youtube,
    };
}

async function drainCandidates(
    cutoff: Date,
    progress: ProviderTrackDrainProgress,
): Promise<{
    selected: ProviderTrackCounts;
    deleted: ProviderTrackCounts;
    passes: number;
    reachedCeiling: boolean;
}> {
    for (let pass = 1; pass <= MAX_PROVIDER_GC_PASSES; pass += 1) {
        const candidates = await loadCandidates(cutoff);
        const passSelected = {
            tidal: candidates.tidal.length,
            youtube: candidates.youtube.length,
        };
        if (passSelected.tidal === 0 && passSelected.youtube === 0) {
            return {
                ...progress,
                passes: pass,
                reachedCeiling: false,
            };
        }
        const passDeleted = await deleteCandidates(candidates, cutoff);
        progress.selected = addCounts(progress.selected, passSelected);
        progress.deleted = addCounts(progress.deleted, passDeleted);
        log.info("Provider track garbage collection batch completed", {
            pass,
            selectedTidal: passSelected.tidal,
            selectedYoutube: passSelected.youtube,
            deletedTidal: passDeleted.tidal,
            deletedYoutube: passDeleted.youtube,
        });
        if (
            passSelected.tidal < PROVIDER_BATCH_SIZE &&
            passSelected.youtube < PROVIDER_BATCH_SIZE
        ) {
            return {
                ...progress,
                passes: pass,
                reachedCeiling: false,
            };
        }
    }
    return {
        ...progress,
        passes: MAX_PROVIDER_GC_PASSES,
        reachedCeiling: true,
    };
}

function collectableAgeSeconds(now: Date, createdAt?: Date): number {
    if (!createdAt) return 0;
    return Math.max(0, (now.getTime() - createdAt.getTime()) / 1000);
}

async function loadBacklog(
    cutoff: Date,
    now: Date,
): Promise<ProviderTrackBacklog> {
    const where = providerTrackCollectableWhere(cutoff);
    const [tidal, youtube, oldestTidal, oldestYoutube] = await Promise.all([
        prisma.trackTidal.count({
            where,
            take: PROVIDER_BACKLOG_GAUGE_CAP,
        }),
        prisma.trackYtMusic.count({
            where,
            take: PROVIDER_BACKLOG_GAUGE_CAP,
        }),
        prisma.trackTidal.findFirst({
            where,
            orderBy: { createdAt: "asc" },
            select: { createdAt: true },
        }),
        prisma.trackYtMusic.findFirst({
            where,
            orderBy: { createdAt: "asc" },
            select: { createdAt: true },
        }),
    ]);
    return {
        backlog: { tidal, youtube },
        oldestCollectableAgeSeconds: {
            tidal: collectableAgeSeconds(now, oldestTidal?.createdAt),
            youtube: collectableAgeSeconds(now, oldestYoutube?.createdAt),
        },
    };
}

async function completeCollection(
    drain: Awaited<ReturnType<typeof drainCandidates>>,
    cutoff: Date,
    now: Date,
    retentionDays: number,
    startedAt: bigint,
): Promise<ProviderTrackGcResult> {
    const orphans = await cleanupOrphanedLibraryEntities(now);
    const backlog = await loadBacklog(cutoff, now);
    const durationSeconds = elapsedSeconds(startedAt);
    recordProviderTrackGcPass(
        "success",
        durationSeconds,
        drain.deleted,
        backlog,
    );
    log.info("Provider track garbage collection pass completed", {
        cutoff: cutoff.toISOString(),
        retentionDays,
        passes: drain.passes,
        selectedTidal: drain.selected.tidal,
        selectedYoutube: drain.selected.youtube,
        deletedTidal: drain.deleted.tidal,
        deletedYoutube: drain.deleted.youtube,
        backlogTidal: backlog.backlog.tidal,
        backlogYoutube: backlog.backlog.youtube,
        oldestCollectableTidalSeconds:
            backlog.oldestCollectableAgeSeconds.tidal,
        oldestCollectableYoutubeSeconds:
            backlog.oldestCollectableAgeSeconds.youtube,
        orphanedAlbums: orphans.albumsDeleted,
        orphanedArtists: orphans.artistsDeleted,
        durationMs: Math.round(durationSeconds * 1000),
    });
    return {
        selected: drain.selected,
        deleted: drain.deleted,
        orphanedParents: {
            albums: orphans.albumsDeleted,
            artists: orphans.artistsDeleted,
        },
    };
}

/** Drains bounded provider batches and cleans their catalog parents. */
export async function collectProviderTracks(
    options: ProviderTrackGcOptions = {},
): Promise<ProviderTrackGcResult> {
    const startedAt = process.hrtime.bigint();
    const now = options.now ?? new Date();
    const retentionDays =
        options.retentionDays ?? config.workers.providerTrackRetentionDays;
    const cutoff = providerTrackRetentionCutoff(now, retentionDays);
    const progress: ProviderTrackDrainProgress = {
        selected: { ...EMPTY_COUNTS },
        deleted: { ...EMPTY_COUNTS },
    };

    try {
        const drain = await drainCandidates(cutoff, progress);
        if (drain.reachedCeiling) {
            log.warn(
                "Provider track garbage collection reached its safety ceiling",
                {
                    maxPasses: MAX_PROVIDER_GC_PASSES,
                    maxRowsPerProvider:
                        MAX_PROVIDER_GC_PASSES * PROVIDER_BATCH_SIZE,
                },
            );
        }
        return await completeCollection(
            drain,
            cutoff,
            now,
            retentionDays,
            startedAt,
        );
    } catch (error) {
        const durationSeconds = elapsedSeconds(startedAt);
        recordProviderTrackGcPass("failure", durationSeconds, progress.deleted);
        log.error("Provider track garbage collection pass failed", {
            retentionDays,
            deletedTidal: progress.deleted.tidal,
            deletedYoutube: progress.deleted.youtube,
            durationMs: Math.round(durationSeconds * 1000),
            error,
        });
        throw error;
    }
}
