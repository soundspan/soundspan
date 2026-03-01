import { logger } from "../utils/logger";
import { randomUUID } from "crypto";
import type Bull from "bull";
import type Redis from "ioredis";
import {
    scanQueue,
    discoverQueue,
    imageQueue,
    validationQueue,
    schedulerQueue,
} from "./queues";
import { processScan } from "./processors/scanProcessor";
import {
    processDiscoverWeekly,
    shutdownDiscoverProcessor,
} from "./processors/discoverProcessor";
import { processImageOptimization } from "./processors/imageProcessor";
import { processValidation } from "./processors/validationProcessor";
import {
    startUnifiedEnrichmentWorker,
    stopUnifiedEnrichmentWorker,
} from "./unifiedEnrichment";
import {
    startMoodBucketWorker,
    stopMoodBucketWorker,
} from "./moodBucketWorker";
import { downloadQueueManager } from "../services/downloadQueue";
import { prisma } from "../utils/db";
import {
    startDiscoverWeeklyCron,
    processDiscoverCronTick,
} from "./discoverCron";
import { runDataIntegrityCheck } from "./dataIntegrity";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { queueCleaner } from "../jobs/queueCleaner";
import { enrichmentStateService } from "../services/enrichmentState";
import { createIORedisClient } from "../utils/ioredis";
import { dataCacheService } from "../services/dataCache";

const WORKER_PROCESSOR_ID = randomUUID();
let schedulerLockRedis: Redis = createIORedisClient("worker-scheduler-locks");
const schedulerLockOwnerId = `${WORKER_PROCESSOR_ID}:scheduler-claims`;
const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const SCHEDULER_CLAIM_RETRY_ATTEMPTS = 3;
const OBSERVABILITY_LOG_EVERY = 25;
const DEFAULT_SCHEDULER_SKIP_WARN_THRESHOLD = 3;
const parsedSchedulerSkipWarnThreshold = Number.parseInt(
    process.env.SCHEDULER_CLAIM_SKIP_WARN_THRESHOLD ||
        `${DEFAULT_SCHEDULER_SKIP_WARN_THRESHOLD}`,
    10
);
const SCHEDULER_SKIP_WARN_THRESHOLD =
    Number.isFinite(parsedSchedulerSkipWarnThreshold) &&
    parsedSchedulerSkipWarnThreshold > 0
        ? parsedSchedulerSkipWarnThreshold
        : DEFAULT_SCHEDULER_SKIP_WARN_THRESHOLD;
const schedulerClaimSkipCounts = new Map<string, number>();
const schedulerClaimCounters = {
    acquired: 0,
    skipped: 0,
    failedAcquire: 0,
    failedRelease: 0,
    retryRecoveries: 0,
};
const queueProcessorCounters = {
    active: 0,
    completed: 0,
    failed: 0,
};

function logSchedulerClaimObservability(context: string): void {
    logger.info(
        `[SchedulerClaim/Observability] context=${context} workerId=${WORKER_PROCESSOR_ID} owner=${schedulerLockOwnerId} acquired=${schedulerClaimCounters.acquired} skipped=${schedulerClaimCounters.skipped} failedAcquire=${schedulerClaimCounters.failedAcquire} failedRelease=${schedulerClaimCounters.failedRelease} retryRecoveries=${schedulerClaimCounters.retryRecoveries}`
    );
}

function maybeLogSchedulerClaimObservability(context: string): void {
    const totalEvents =
        schedulerClaimCounters.acquired +
        schedulerClaimCounters.skipped +
        schedulerClaimCounters.failedAcquire +
        schedulerClaimCounters.failedRelease;
    if (totalEvents > 0 && totalEvents % OBSERVABILITY_LOG_EVERY === 0) {
        logSchedulerClaimObservability(context);
    }
}

function recordQueueProcessorEvent(
    queueName: string,
    event: "active" | "completed" | "failed",
    job: Bull.Job<any>
): void {
    queueProcessorCounters[event] += 1;

    if (
        event === "failed" ||
        queueProcessorCounters[event] % OBSERVABILITY_LOG_EVERY === 0
    ) {
        logger.info(
            `[QueueProcessor/Observability] workerId=${WORKER_PROCESSOR_ID} event=${event} queue=${queueName} count=${queueProcessorCounters[event]} jobId=${job?.id ?? "unknown"} jobName=${job?.name ?? "unknown"}`
        );
    }
}

function isRetryableSchedulerClaimError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return (
        message.includes("Connection is closed") ||
        message.includes("Connection is in closing state") ||
        message.includes("ECONNRESET") ||
        message.includes("ETIMEDOUT") ||
        message.includes("EPIPE")
    );
}

function recreateSchedulerLockRedisClient(): void {
    try {
        schedulerLockRedis.disconnect();
    } catch {
        // no-op
    }

    schedulerLockRedis = createIORedisClient("worker-scheduler-locks");
}

async function withSchedulerClaimRedisRetry<T>(
    operationName: string,
    operation: () => Promise<T>
): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            if (
                !isRetryableSchedulerClaimError(error) ||
                attempt === SCHEDULER_CLAIM_RETRY_ATTEMPTS
            ) {
                throw error;
            }

            logger.warn(
                `[SchedulerClaim] ${operationName} failed due to Redis connection closure (attempt ${attempt}/${SCHEDULER_CLAIM_RETRY_ATTEMPTS}); recreating client and retrying`,
                error
            );
            schedulerClaimCounters.retryRecoveries += 1;

            recreateSchedulerLockRedisClient();
            await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
    }
}

const SCHEDULER_JOB_TYPES = {
    dataIntegrity: "data-integrity-check",
    reconciliation: "download-reconciliation-cycle",
    lidarrCleanup: "lidarr-cleanup-cycle",
    cacheWarmup: "cache-warmup-startup",
    podcastCleanup: "podcast-cache-cleanup",
    audiobookAutoSync: "audiobook-auto-sync-startup",
    downloadQueueReconcile: "download-queue-reconcile-startup",
    artistCountsBackfill: "artist-counts-backfill-startup",
    imageBackfill: "image-backfill-startup",
    trackMappingReconcile: "track-mapping-reconcile",
} as const;

const SCHEDULER_JOB_IDS = {
    dataIntegrityStartup: "scheduler:data-integrity:startup",
    dataIntegrityRepeat: "scheduler:data-integrity:repeat",
    reconciliationStartup: "scheduler:reconciliation:startup",
    reconciliationRepeat: "scheduler:reconciliation:repeat",
    lidarrCleanupStartup: "scheduler:lidarr-cleanup:startup",
    lidarrCleanupRepeat: "scheduler:lidarr-cleanup:repeat",
    cacheWarmupStartup: "scheduler:cache-warmup:startup",
    podcastCleanupStartup: "scheduler:podcast-cleanup:startup",
    podcastCleanupRepeat: "scheduler:podcast-cleanup:repeat",
    audiobookAutoSyncStartup: "scheduler:audiobook-auto-sync:startup",
    downloadQueueReconcileStartup: "scheduler:download-queue-reconcile:startup",
    artistCountsBackfillStartup: "scheduler:artist-counts-backfill:startup",
    imageBackfillStartup: "scheduler:image-backfill:startup",
    trackMappingReconcileStartup: "scheduler:track-mapping-reconcile:startup",
    trackMappingReconcileRepeat: "scheduler:track-mapping-reconcile:repeat",
} as const;

async function runWithSchedulerClaim(
    claimKey: string,
    ttlMs: number,
    operationName: string,
    operation: () => Promise<void>
): Promise<void> {
    const claimToken = `${schedulerLockOwnerId}:${Date.now()}:${Math.random()}`;
    const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));

    try {
        const acquired = await withSchedulerClaimRedisRetry(
            `claim acquire for ${operationName}`,
            () =>
                schedulerLockRedis.set(
                    claimKey,
                    claimToken,
                    "EX",
                    ttlSeconds,
                    "NX"
                )
        );

        if (acquired !== "OK") {
            const skippedCount =
                (schedulerClaimSkipCounts.get(claimKey) ?? 0) + 1;
            schedulerClaimSkipCounts.set(claimKey, skippedCount);

            if (skippedCount >= SCHEDULER_SKIP_WARN_THRESHOLD) {
                schedulerClaimCounters.skipped += 1;
                logger.warn(
                    `[SchedulerClaim/SLO] ${operationName} skipped ${skippedCount} consecutive time(s); claim held by another worker (owner=${schedulerLockOwnerId}, workerId=${WORKER_PROCESSOR_ID})`
                );
            } else {
                schedulerClaimCounters.skipped += 1;
                logger.debug(
                    `[SchedulerClaim] Skipping ${operationName}; claim is held by another worker (owner=${schedulerLockOwnerId}, workerId=${WORKER_PROCESSOR_ID})`
                );
            }
            maybeLogSchedulerClaimObservability("skip");
            return;
        }

        schedulerClaimSkipCounts.delete(claimKey);
        schedulerClaimCounters.acquired += 1;
        logger.debug(
            `[SchedulerClaim] Acquired claim for ${operationName} (claimKey=${claimKey}, owner=${schedulerLockOwnerId}, workerId=${WORKER_PROCESSOR_ID})`
        );
        maybeLogSchedulerClaimObservability("acquire");
    } catch (err) {
        schedulerClaimCounters.failedAcquire += 1;
        logger.error(
            `[SchedulerClaim] Failed to claim ${operationName}; skipping cycle (owner=${schedulerLockOwnerId}, workerId=${WORKER_PROCESSOR_ID})`,
            err
        );
        maybeLogSchedulerClaimObservability("failed-acquire");
        return;
    }

    try {
        await operation();
    } finally {
        try {
            await withSchedulerClaimRedisRetry(
                `claim release for ${operationName}`,
                () =>
                    schedulerLockRedis.eval(
                        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
                        1,
                        claimKey,
                        claimToken
                    )
            );
        } catch (err) {
            schedulerClaimCounters.failedRelease += 1;
            logger.warn(
                `[SchedulerClaim] Failed to release claim for ${operationName} (owner=${schedulerLockOwnerId}, workerId=${WORKER_PROCESSOR_ID})`,
                err
            );
            maybeLogSchedulerClaimObservability("failed-release");
        }
    }
}

/**
 * Wrap an async operation with a timeout to prevent indefinite hangs
 * Returns undefined if the operation times out (does not throw)
 */
async function withTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    operationName: string
): Promise<T | undefined> {
    let timeoutId: NodeJS.Timeout | undefined;
    let timedOut = false;

    const timeoutPromise = new Promise<undefined>((resolve) => {
        timeoutId = setTimeout(() => {
            timedOut = true;
            logger.warn(
                `Operation timed out after ${timeoutMs}ms: ${operationName}`
            );
            resolve(undefined);
        }, timeoutMs);
    });

    try {
        const result = await Promise.race([operation(), timeoutPromise]);
        if (!timedOut && timeoutId) {
            clearTimeout(timeoutId);
        }
        return result;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

async function processDataIntegrityJob(): Promise<void> {
    await runWithSchedulerClaim(
        "scheduler-claim:data-integrity",
        30 * ONE_MINUTE_MS,
        "data integrity check",
        async () => {
            await runDataIntegrityCheck();
        }
    );
}

async function processReconciliationJob(): Promise<void> {
    await runWithSchedulerClaim(
        "scheduler-claim:reconciliation-cycle",
        10 * ONE_MINUTE_MS,
        "download reconciliation cycle",
        async () => {
            const { lidarrService } = await import("../services/lidarr");
            const snapshot = await withTimeout(
                () => lidarrService.getReconciliationSnapshot(),
                30_000,
                "getReconciliationSnapshot"
            );

            const staleCount = await withTimeout(
                () => simpleDownloadManager.markStaleJobsAsFailed(snapshot),
                120_000,
                "markStaleJobsAsFailed"
            );
            if (staleCount && staleCount > 0) {
                logger.debug(
                    `Periodic cleanup: marked ${staleCount} stale download(s) as failed`
                );
            }

            const lidarrResult = await withTimeout(
                () => simpleDownloadManager.reconcileWithLidarr(snapshot),
                120_000,
                "reconcileWithLidarr"
            );
            if (lidarrResult && lidarrResult.reconciled > 0) {
                logger.debug(
                    `Periodic reconcile: ${lidarrResult.reconciled} job(s) matched in Lidarr`
                );
            }

            const localResult = await withTimeout(
                () => queueCleaner.reconcileWithLocalLibrary(),
                120_000,
                "reconcileWithLocalLibrary"
            );
            if (localResult && localResult.reconciled > 0) {
                logger.debug(
                    `Periodic reconcile: ${localResult.reconciled} job(s) matched in local library`
                );
            }

            const syncResult = await withTimeout(
                () => simpleDownloadManager.syncWithLidarrQueue(snapshot),
                120_000,
                "syncWithLidarrQueue"
            );
            if (syncResult && syncResult.cancelled > 0) {
                logger.debug(
                    `Periodic sync: ${syncResult.cancelled} job(s) synced with Lidarr queue`
                );
            }
        }
    );
}

async function processLidarrCleanupJob(
    mode: "startup" | "repeat"
): Promise<void> {
    await runWithSchedulerClaim(
        "scheduler-claim:lidarr-cleanup-cycle",
        5 * ONE_MINUTE_MS,
        mode === "startup"
            ? "initial Lidarr queue cleanup"
            : "Lidarr queue cleanup cycle",
        async () => {
            if (mode === "startup") {
                logger.debug("Running initial Lidarr queue cleanup...");
            }

            const result = await withTimeout(
                () => simpleDownloadManager.clearLidarrQueue(),
                180_000,
                "clearLidarrQueue"
            );

            if (!result) {
                return;
            }

            if (result.removed > 0) {
                const prefix =
                    mode === "startup"
                        ? "Initial cleanup"
                        : "Periodic Lidarr cleanup";
                logger.debug(
                    `${prefix}: removed ${result.removed} stuck download(s)`
                );
            } else if (mode === "startup") {
                logger.debug("Initial cleanup: queue is clean");
            }
        }
    );
}

async function processCacheWarmupJob(): Promise<void> {
    await runWithSchedulerClaim(
        "scheduler-claim:cache-warmup-startup",
        30 * ONE_MINUTE_MS,
        "startup cache warmup",
        async () => {
            await withTimeout(
                () => dataCacheService.warmupCache(),
                15 * ONE_MINUTE_MS,
                "warmupCache"
            );
        }
    );
}

async function processPodcastCleanupJob(mode: "startup" | "repeat"): Promise<void> {
    await runWithSchedulerClaim(
        "scheduler-claim:podcast-cleanup",
        30 * ONE_MINUTE_MS,
        mode === "startup"
            ? "startup podcast cache cleanup"
            : "podcast cache cleanup",
        async () => {
            const { cleanupExpiredCache } = await import("../services/podcastDownload");
            await withTimeout(
                () => cleanupExpiredCache(),
                10 * ONE_MINUTE_MS,
                "cleanupExpiredCache"
            );
        }
    );
}

async function processAudiobookAutoSyncJob(): Promise<void> {
    await runWithSchedulerClaim(
        "scheduler-claim:audiobook-auto-sync-startup",
        2 * ONE_HOUR_MS,
        "startup audiobook auto-sync",
        async () => {
            const { getSystemSettings } = await import("../utils/systemSettings");
            const settings = await getSystemSettings();

            if (!settings?.audiobookshelfEnabled || !settings?.audiobookshelfUrl) {
                logger.debug(
                    "[STARTUP] Audiobookshelf is disabled or unconfigured - skipping auto-sync"
                );
                return;
            }

            const cachedCount = await prisma.audiobook.count();
            if (cachedCount > 0) {
                logger.debug(
                    `[STARTUP] Audiobook cache has ${cachedCount} entries - skipping auto-sync`
                );
                return;
            }

            logger.debug(
                "[STARTUP] Audiobook cache is empty - auto-syncing from Audiobookshelf..."
            );

            const { audiobookCacheService } = await import(
                "../services/audiobookCache"
            );
            const result = await withTimeout(
                () => audiobookCacheService.syncAll(),
                2 * ONE_HOUR_MS,
                "audiobookCacheService.syncAll"
            );

            if (result) {
                logger.debug(
                    `[STARTUP] Audiobook auto-sync complete: ${result.synced} audiobooks cached`
                );
            }
        }
    );
}

async function processDownloadQueueReconcileJob(): Promise<void> {
    await runWithSchedulerClaim(
        "scheduler-claim:download-queue-reconcile-startup",
        30 * ONE_MINUTE_MS,
        "startup download queue reconciliation",
        async () => {
            const result = await withTimeout(
                () => downloadQueueManager.reconcileOnStartup(),
                20 * ONE_MINUTE_MS,
                "downloadQueueManager.reconcileOnStartup"
            );

            if (result) {
                logger.debug(
                    `Download queue reconciled: ${result.loaded} active, ${result.failed} marked failed`
                );
            }
        }
    );
}

async function processArtistCountsBackfillJob(): Promise<void> {
    await runWithSchedulerClaim(
        "scheduler-claim:artist-counts-backfill-startup",
        3 * ONE_HOUR_MS,
        "startup artist-counts backfill",
        async () => {
            const { isBackfillNeeded, backfillAllArtistCounts } = await import(
                "../services/artistCountsService"
            );
            const needsBackfill = await isBackfillNeeded();
            if (!needsBackfill) {
                logger.debug("[STARTUP] Artist counts already populated");
                return;
            }

            logger.info(
                "[STARTUP] Artist counts need backfilling, starting in background..."
            );

            const result = await withTimeout(
                () => backfillAllArtistCounts(),
                3 * ONE_HOUR_MS,
                "backfillAllArtistCounts"
            );

            if (result) {
                logger.info(
                    `[STARTUP] Artist counts backfill complete: ${result.processed} processed, ${result.errors} errors`
                );
            }
        }
    );
}

async function processImageBackfillJob(): Promise<void> {
    await runWithSchedulerClaim(
        "scheduler-claim:image-backfill-startup",
        6 * ONE_HOUR_MS,
        "startup image backfill",
        async () => {
            const { isImageBackfillNeeded, backfillAllImages } = await import(
                "../services/imageBackfill"
            );
            const status = await isImageBackfillNeeded();
            if (!status.needed) {
                logger.debug("[STARTUP] All images already stored locally");
                return;
            }

            logger.info(
                `[STARTUP] Image backfill needed: ${status.artistsWithExternalUrls} artists, ${status.albumsWithExternalUrls} albums with external URLs`
            );

            const completed = await withTimeout(
                async () => {
                    await backfillAllImages();
                    return true;
                },
                6 * ONE_HOUR_MS,
                "backfillAllImages"
            );

            if (completed) {
                logger.info("[STARTUP] Image backfill complete");
            }
        }
    );
}

async function processTrackMappingReconcileJob(): Promise<void> {
    await runWithSchedulerClaim(
        "scheduler-claim:track-mapping-reconcile",
        ONE_HOUR_MS,
        "track mapping reconciliation",
        async () => {
            const { trackReconciliationService } = await import(
                "../services/trackReconciliation"
            );
            const result = await trackReconciliationService.reconcile();
            if (result.linked > 0) {
                logger.info(
                    `[TrackMappingReconcile] Linked ${result.linked} mappings to local tracks (${result.skipped} skipped)`
                );
            } else if (result.processed > 0) {
                logger.debug(
                    `[TrackMappingReconcile] No new links found (${result.processed} checked)`
                );
            }
        }
    );
}

async function registerSchedulerJobs(): Promise<void> {
    await schedulerQueue.isReady();

    const schedulerJobs: Array<{
        type: (typeof SCHEDULER_JOB_TYPES)[keyof typeof SCHEDULER_JOB_TYPES];
        data: { mode: "startup" | "repeat" };
        opts: Bull.JobOptions;
    }> = [
        {
            type: SCHEDULER_JOB_TYPES.dataIntegrity,
            data: { mode: "startup" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.dataIntegrityStartup,
                delay: 10_000,
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.dataIntegrity,
            data: { mode: "repeat" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.dataIntegrityRepeat,
                repeat: { every: 24 * ONE_HOUR_MS },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.reconciliation,
            data: { mode: "startup" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.reconciliationStartup,
                delay: 2 * ONE_MINUTE_MS,
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.reconciliation,
            data: { mode: "repeat" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.reconciliationRepeat,
                repeat: { every: 2 * ONE_MINUTE_MS },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.lidarrCleanup,
            data: { mode: "startup" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.lidarrCleanupStartup,
                delay: 30_000,
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.lidarrCleanup,
            data: { mode: "repeat" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.lidarrCleanupRepeat,
                repeat: { every: 5 * ONE_MINUTE_MS },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.cacheWarmup,
            data: { mode: "startup" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.cacheWarmupStartup,
                delay: 5_000,
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.podcastCleanup,
            data: { mode: "startup" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.podcastCleanupStartup,
                delay: 15_000,
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.podcastCleanup,
            data: { mode: "repeat" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.podcastCleanupRepeat,
                repeat: { every: 24 * ONE_HOUR_MS },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.audiobookAutoSync,
            data: { mode: "startup" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.audiobookAutoSyncStartup,
                delay: 20_000,
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.downloadQueueReconcile,
            data: { mode: "startup" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.downloadQueueReconcileStartup,
                delay: 25_000,
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.artistCountsBackfill,
            data: { mode: "startup" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.artistCountsBackfillStartup,
                delay: 30_000,
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.imageBackfill,
            data: { mode: "startup" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.imageBackfillStartup,
                delay: 40_000,
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.trackMappingReconcile,
            data: { mode: "startup" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.trackMappingReconcileStartup,
                delay: 45_000,
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.trackMappingReconcile,
            data: { mode: "repeat" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.trackMappingReconcileRepeat,
                repeat: { every: 6 * ONE_HOUR_MS },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
    ];

    for (const job of schedulerJobs) {
        await schedulerQueue.add(job.type, job.data, job.opts);
    }
}

// Register processors with named job types
logger.info(
    `[QueueProcessor/Identity] workerId=${WORKER_PROCESSOR_ID} owner=${schedulerLockOwnerId} hostname=${process.env.HOSTNAME ?? "unknown"} pid=${process.pid}`
);
scanQueue.process("scan", processScan);
discoverQueue.process("discover-recommendation", processDiscoverWeekly);
discoverQueue.process("discover-cron-tick", processDiscoverCronTick);
// Keep legacy unnamed handler for older callers that still enqueue without a job name.
discoverQueue.process(processDiscoverWeekly);
imageQueue.process(processImageOptimization);
validationQueue.process(processValidation);
async function processSchedulerJob(job: Bull.Job<any>): Promise<void> {
    const mode = job?.data?.mode === "startup" ? "startup" : "repeat";

    switch (job?.name) {
        case SCHEDULER_JOB_TYPES.dataIntegrity:
            await processDataIntegrityJob();
            break;
        case SCHEDULER_JOB_TYPES.reconciliation:
            await processReconciliationJob();
            break;
        case SCHEDULER_JOB_TYPES.lidarrCleanup:
            await processLidarrCleanupJob(mode);
            break;
        case SCHEDULER_JOB_TYPES.cacheWarmup:
            await processCacheWarmupJob();
            break;
        case SCHEDULER_JOB_TYPES.podcastCleanup:
        case "podcast-cleanup":
            await processPodcastCleanupJob(mode);
            break;
        case SCHEDULER_JOB_TYPES.audiobookAutoSync:
        case "audiobook-auto-sync":
            await processAudiobookAutoSyncJob();
            break;
        case SCHEDULER_JOB_TYPES.downloadQueueReconcile:
        case "download-queue-reconcile":
            await processDownloadQueueReconcileJob();
            break;
        case SCHEDULER_JOB_TYPES.artistCountsBackfill:
        case "artist-counts-backfill":
            await processArtistCountsBackfillJob();
            break;
        case SCHEDULER_JOB_TYPES.imageBackfill:
        case "image-backfill":
            await processImageBackfillJob();
            break;
        case SCHEDULER_JOB_TYPES.trackMappingReconcile:
        case "track-mapping-reconcile":
            await processTrackMappingReconcileJob();
            break;
        default:
            logger.warn(
                `Scheduler wildcard received unknown job type "${job?.name ?? "unknown"}" (jobId=${job?.id ?? "unknown"}); skipping`
            );
            break;
    }
}

// Safety net + primary scheduler processor:
// Use a single wildcard processor so startup does not attach many pre-ready listeners
// on the same queue client (which can trip Node's max-listener warning threshold).
schedulerQueue.process("*", async (job: Bull.Job<any>) => {
    try {
        await processSchedulerJob(job);
    } catch (err) {
        logger.error(
            `Scheduler processor failed (${job?.name ?? "unknown"}):`,
            err
        );
        throw err;
    }
});

// Register download queue callback for unavailable albums
downloadQueueManager.onUnavailableAlbum(async (info) => {
    logger.debug(
        ` Recording unavailable album: ${info.artistName} - ${info.albumTitle}`
    );

    if (!info.userId) {
        logger.debug(` No userId provided, skipping database record`);
        return;
    }

    try {
        // Get week start date from discovery album if it exists
        const discoveryAlbum = await prisma.discoveryAlbum.findFirst({
            where: { rgMbid: info.albumMbid },
            orderBy: { downloadedAt: "desc" },
        });

        await prisma.unavailableAlbum.create({
            data: {
                userId: info.userId,
                artistName: info.artistName,
                albumTitle: info.albumTitle,
                albumMbid: info.albumMbid,
                artistMbid: info.artistMbid,
                similarity: info.similarity || 0,
                tier: info.tier || "unknown",
                weekStartDate: discoveryAlbum?.weekStartDate || new Date(),
                attemptNumber: 0,
            },
        });

        logger.debug(`   Recorded in database`);
    } catch (error: any) {
        // Handle duplicate entries (album already marked as unavailable)
        if (error.code === "P2002") {
            logger.debug(`     Album already marked as unavailable`);
        } else {
            logger.error(
                ` Failed to record unavailable album:`,
                error.message
            );
        }
    }
});

// Start unified enrichment worker
// Handles: artist metadata, track tags (Last.fm), audio analysis queueing (Essentia)
startUnifiedEnrichmentWorker().catch((err) => {
    logger.error("Failed to start unified enrichment worker:", err);
});

// Start mood bucket worker
// Assigns newly analyzed tracks to mood buckets for fast mood mix generation
startMoodBucketWorker().catch((err) => {
    logger.error("Failed to start mood bucket worker:", err);
});

// Event handlers for scan queue
scanQueue.on("completed", (job, result) => {
    recordQueueProcessorEvent("library-scan", "completed", job);
    logger.debug(
        `Scan job ${job.id} completed: +${result.tracksAdded} ~${result.tracksUpdated} -${result.tracksRemoved} (workerId=${WORKER_PROCESSOR_ID})`
    );
});

scanQueue.on("failed", (job, err) => {
    recordQueueProcessorEvent("library-scan", "failed", job);
    logger.error(`Scan job ${job.id} failed (workerId=${WORKER_PROCESSOR_ID}):`, err.message);
});

scanQueue.on("active", (job) => {
    recordQueueProcessorEvent("library-scan", "active", job);
    logger.debug(` Scan job ${job.id} started (workerId=${WORKER_PROCESSOR_ID})`);
});

// Event handlers for discover queue
discoverQueue.on("completed", (job, result) => {
    recordQueueProcessorEvent("discover-weekly", "completed", job);
    if (result.success) {
        logger.debug(
            `Discover job ${job.id} completed: ${result.playlistName} (${result.songCount} songs) (workerId=${WORKER_PROCESSOR_ID})`
        );
    } else {
        logger.debug(`Discover job ${job.id} failed: ${result.error} (workerId=${WORKER_PROCESSOR_ID})`);
    }
});

discoverQueue.on("failed", (job, err) => {
    recordQueueProcessorEvent("discover-weekly", "failed", job);
    logger.error(`Discover job ${job.id} failed (workerId=${WORKER_PROCESSOR_ID}):`, err.message);
});

discoverQueue.on("active", (job) => {
    recordQueueProcessorEvent("discover-weekly", "active", job);
    logger.debug(
        ` Discover job ${job.id} started for user ${job.data.userId} (workerId=${WORKER_PROCESSOR_ID})`
    );
});

// Event handlers for image queue
imageQueue.on("completed", (job, result) => {
    recordQueueProcessorEvent("image-optimization", "completed", job);
    logger.debug(
        `Image job ${job.id} completed: ${
            result.success ? "success" : result.error
        } (workerId=${WORKER_PROCESSOR_ID})`
    );
});

imageQueue.on("failed", (job, err) => {
    recordQueueProcessorEvent("image-optimization", "failed", job);
    logger.error(`Image job ${job.id} failed (workerId=${WORKER_PROCESSOR_ID}):`, err.message);
});

// Event handlers for validation queue
validationQueue.on("completed", (job, result) => {
    recordQueueProcessorEvent("file-validation", "completed", job);
    logger.debug(
        `Validation job ${job.id} completed: ${result.tracksChecked} checked, ${result.tracksRemoved} removed (workerId=${WORKER_PROCESSOR_ID})`
    );
});

validationQueue.on("failed", (job, err) => {
    recordQueueProcessorEvent("file-validation", "failed", job);
    logger.error(` Validation job ${job.id} failed (workerId=${WORKER_PROCESSOR_ID}):`, err.message);
});

validationQueue.on("active", (job) => {
    recordQueueProcessorEvent("file-validation", "active", job);
    logger.debug(` Validation job ${job.id} started (workerId=${WORKER_PROCESSOR_ID})`);
});

schedulerQueue.on("completed", (job) => {
    recordQueueProcessorEvent("worker-scheduler", "completed", job);
    logger.debug(
        `Scheduler job ${job.id} completed (${job.name}) (workerId=${WORKER_PROCESSOR_ID})`
    );
});

schedulerQueue.on("failed", (job, err) => {
    if (job) {
        recordQueueProcessorEvent("worker-scheduler", "failed", job);
    }
    logger.error(
        `Scheduler job ${job?.id ?? "unknown"} failed (${job?.name ?? "unknown"}) (workerId=${WORKER_PROCESSOR_ID}):`,
        err.message
    );
});

logger.debug("Worker processors registered and event handlers attached");

// Start Discovery Weekly cron scheduler (Sundays at 8 PM)
startDiscoverWeeklyCron();
logger.debug("Discover Weekly scheduler registered");

registerSchedulerJobs()
    .then(() => {
        logger.debug(
            "Scheduler queue jobs registered (data-integrity, reconciliation, lidarr-cleanup, startup maintenance)"
        );
    })
    .catch((err) => {
        logger.error("Failed to register scheduler queue jobs:", err);
    });

/**
 * Gracefully shutdown all workers and cleanup resources
 */
export async function shutdownWorkers(): Promise<void> {
    logger.debug("Shutting down workers...");

    // Stop unified enrichment worker
    await stopUnifiedEnrichmentWorker();

    // Stop mood bucket worker
    stopMoodBucketWorker();

    // Shutdown download queue manager
    downloadQueueManager.shutdown();

    // Remove all event listeners to prevent memory leaks
    scanQueue.removeAllListeners();
    discoverQueue.removeAllListeners();
    imageQueue.removeAllListeners();
    validationQueue.removeAllListeners();
    schedulerQueue.removeAllListeners();

    // Close all queues gracefully
    await Promise.all([
        scanQueue.close(),
        discoverQueue.close(),
        imageQueue.close(),
        validationQueue.close(),
        schedulerQueue.close(),
    ]);

    // Disconnect enrichment state service Redis connections (2 connections)
    try {
        await enrichmentStateService.disconnect();
        logger.debug("Enrichment state service disconnected");
    } catch (err) {
        logger.error("Failed to disconnect enrichment state service:", err);
    }

    // Disconnect discover processor lock Redis connection
    try {
        await shutdownDiscoverProcessor();
        logger.debug("Discover processor lock Redis disconnected");
    } catch (err) {
        logger.error("Failed to disconnect discover processor Redis:", err);
    }

    // Disconnect worker scheduler lock Redis connection
    try {
        await schedulerLockRedis.quit();
        logger.debug("Worker scheduler lock Redis disconnected");
    } catch (err) {
        logger.error("Failed to disconnect worker scheduler lock Redis:", err);
    }

    logger.debug("Workers shutdown complete");
}

// Export queues for use in other modules
export {
    scanQueue,
    discoverQueue,
    imageQueue,
    validationQueue,
    schedulerQueue,
};
