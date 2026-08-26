import { logger } from "../utils/logger";
import { randomUUID } from "crypto";
import pLimit from "p-limit";
import { trackJobStart, trackJobEnd } from "../services/workerEventLoopMonitor";
import type Bull from "bull";
import {
    scanQueue,
    discoverQueue,
    imageQueue,
    validationQueue,
    schedulerQueue,
    schedulerMaintenanceQueue,
    genericImportQueue,
    federationQueue,
    albumDownloadQueue,
    artistExpansionQueue,
    scrobbleQueue,
} from "./queues";
import { processScan } from "./processors/scanProcessor";
import {
    processDiscoverWeekly,
    shutdownDiscoverProcessor,
} from "./processors/discoverProcessor";
import { processImageOptimization } from "./processors/imageProcessor";
import { processValidation } from "./processors/validationProcessor";
import {
    finalizeGenericImportQueueFailure,
    GENERIC_IMPORT_WORKER_CONCURRENCY,
    processGenericImport,
} from "./processors/genericImportProcessor";
import {
    ALBUM_DOWNLOAD_JOB_NAME,
    ALBUM_DOWNLOAD_WORKER_CONCURRENCY,
    type AlbumDownloadProcessOutcome,
    finalizeAlbumDownloadQueueFailure,
    processAlbumDownload,
    requeueAlbumDownloadAfterContention,
} from "./processors/albumDownloadProcessor";
import { processArtistDownloadExpansion } from "./processors/artistDownloadExpansionProcessor";
import { processScrobble } from "./processors/scrobbleProcessor";
import {
    recordAlbumDownloadOutcome,
    recordSchedulerJobDuration,
    recordSchedulerJobSuccess,
    recordSchedulerTimeout,
} from "../metrics";
import {
    ARTIST_DOWNLOAD_EXPANSION_JOB_NAME,
    recoverUnqueuedAlbumDownloads,
    recoverUnqueuedArtistDownloadExpansions,
} from "../services/albumDownloadQueueService";
import {
    startUnifiedEnrichmentWorker,
    stopUnifiedEnrichmentWorker,
} from "./unifiedEnrichment";
import {
    startMoodBucketWorker,
    stopMoodBucketWorker,
} from "./moodBucketWorker";
import { startVibeEmbedWorker, stopVibeEmbedWorker } from "./vibeEmbedWorker";
import {
    startTrackMappingStalenessWorker,
    stopTrackMappingStalenessWorker,
} from "./trackMappingStaleness";
import { config } from "../config";
import {
    startDiscoverWeeklyCron,
    stopDiscoverWeeklyCron,
    processDiscoverCronTick,
} from "./discoverCron";
import { runDataIntegrityCheck } from "./dataIntegrity";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { queueCleaner } from "../jobs/queueCleaner";
import { enrichmentStateService } from "../services/enrichmentState";
import { dataCacheService } from "../services/dataCache";
import { genericImportJobRunner } from "../services/genericImportJobRunner";
import type { ReconciliationCursor } from "../services/trackReconciliation";
import { processAudioHashBackfill } from "./processors/audioHashBackfillProcessor";
import { processLoudnessBackfill } from "./processors/loudnessBackfillProcessor";
import { processTrackRemovalPurge } from "./processors/trackRemovalPurgeProcessor";
import { processRequestFulfillmentBatch } from "./processors/requestFulfillmentProcessor";
import { processCatalogRetention } from "./processors/catalogRetentionProcessor";
import {
    REQUEST_FULFILLMENT_INTERVAL_MS,
    REQUEST_FULFILLMENT_JOB_ID,
    REQUEST_FULFILLMENT_JOB_NAME,
    requestFulfillmentRepeatSchedule,
} from "./requestFulfillmentSchedule";
import {
    registerFederationProcessors,
    registerFederationSchedules,
} from "./federationJobs";
import {
    buildSchedulerJobs,
    ONE_HOUR_MS,
    ONE_MINUTE_MS,
    SCHEDULER_JOB_TYPES,
} from "./schedulerJobRegistry";
import {
    AUDIOBOOK_SYNC_WORK_TIMEOUT_MS,
    runWithSchedulerClaim,
    SCHEDULER_CLAIM_OWNER_ID,
    shutdownSchedulerClaimRedis,
    withSchedulerClaimRedisRetry,
} from "../utils/schedulerClaim";
import { withTimeout } from "../utils/withTimeout";
import {
    closeCoalescedLibraryScanRedis,
    COALESCED_SCAN_JOB_ID,
    consumeCoalescedScanFollowUp,
} from "../services/coalescedLibraryScan";
import { registerQueueProcessorEvents } from "./queueEvents";
import {
    ConsecutiveFailureCircuitBreaker,
    RedisCircuitBreakerStore,
} from "../utils/circuitBreaker";
import { jitterFiveMinuteRepeat, schedulerLaneForJob } from "./schedulerPolicy";
import {
    SCHEDULER_METRIC_JOBS,
    type SchedulerMetricJob,
    type SchedulerTimeoutOperation,
} from "../metrics/schedulerMetrics";

const log = logger.child("WorkerScheduler");
const queueProcessorLog = log.child("QueueProcessor");
const startupLog = log.child("Startup");

const WORKER_PROCESSOR_ID = randomUUID();
const TRACK_RECONCILIATION_CURSOR_KEY =
    "scheduler:cursor:track-mapping-reconcile";
const MAX_RECONCILIATION_CURSOR_BYTES = 512;
const OBSERVABILITY_LOG_EVERY = 25;
const queueProcessorCounters = {
    active: 0,
    completed: 0,
    failed: 0,
};
const coalescedFollowUpConsumptions = new Set<Promise<void>>();
const fastSchedulerLane = pLimit(1);
const slowSchedulerLane = pLimit(1);
const reconciliationCircuitBreakerStore = new RedisCircuitBreakerStore(
    {
        eval: (script, numberOfKeys, key, ...args) =>
            withSchedulerClaimRedisRetry(
                "reconciliation circuit breaker transition",
                (client) => client.eval(script, numberOfKeys, key, ...args),
            ),
    },
    "scheduler:circuit-breaker:reconciliation:v1",
    30 * ONE_MINUTE_MS,
);
const reconciliationCircuitBreaker = new ConsecutiveFailureCircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 5 * ONE_MINUTE_MS,
    store: reconciliationCircuitBreakerStore,
    logger: log,
});

class SchedulerOperationTimeoutError extends Error {
    constructor(readonly operation: SchedulerTimeoutOperation) {
        super(`Scheduler operation timed out: ${operation}`);
        this.name = "SchedulerOperationTimeoutError";
    }
}

async function runSchedulerTimedOperation<T>(
    operation: SchedulerTimeoutOperation,
    timeoutMs: number,
    work: (signal: AbortSignal) => Promise<T>,
    timeoutLogger = log,
): Promise<T | undefined> {
    const result = await withTimeout(work, timeoutMs, operation, {
        result: true,
        logger: timeoutLogger,
    });
    if (result.ok) return result.value;
    recordSchedulerTimeout(operation);
    return undefined;
}

async function requireSchedulerTimedOperation<T>(
    operation: SchedulerTimeoutOperation,
    timeoutMs: number,
    work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    const value = await runSchedulerTimedOperation(operation, timeoutMs, work);
    if (value === undefined)
        throw new SchedulerOperationTimeoutError(operation);
    return value;
}

function consumeCoalescedFollowUpAfterSettlement(job: Bull.Job<any>): void {
    if (String(job.id) !== COALESCED_SCAN_JOB_ID) return;
    const consumption = consumeCoalescedScanFollowUp()
        .catch((error: unknown) => {
            log.warn(
                "Failed to consume coalesced scan follow-up after queue settlement",
                { error },
            );
        })
        .finally(() => {
            coalescedFollowUpConsumptions.delete(consumption);
        });
    coalescedFollowUpConsumptions.add(consumption);
}

function recordQueueProcessorEvent(
    queueName: string,
    event: "active" | "completed" | "failed",
    job: Bull.Job<any>,
): void {
    queueProcessorCounters[event] += 1;

    // Feed the event-loop stall watchdog's attribution registry (issue #43)
    const jobId = String(job?.id ?? "unknown");
    const jobName = String(job?.name ?? "unknown");
    if (event === "active") {
        trackJobStart(queueName, jobId, jobName);
        // Unconditional start breadcrumb for the heavy queues: a job that
        // pegs the loop until the kubelet kills the process never lets the
        // watchdog interval fire, so the last log line before death must
        // already name the culprit. Scheduler cycles, library scans, and
        // long-running album downloads need this; other queues stay sampled.
        if (
            queueName === "worker-scheduler" ||
            queueName === "worker-scheduler-maintenance" ||
            queueName === "library-scan" ||
            queueName === "album-download"
        ) {
            queueProcessorLog.info(
                `job-start queue=${queueName} jobId=${jobId} jobName=${jobName}`,
            );
        }
    } else {
        trackJobEnd(queueName, jobId);
    }

    if (
        event === "failed" ||
        queueProcessorCounters[event] % OBSERVABILITY_LOG_EVERY === 0
    ) {
        queueProcessorLog.info(
            `workerId=${WORKER_PROCESSOR_ID} event=${event} queue=${queueName} count=${queueProcessorCounters[event]} jobId=${job?.id ?? "unknown"} jobName=${job?.name ?? "unknown"}`,
        );
    }
}

function parseReconciliationCursor(value: string): ReconciliationCursor | null {
    if (value.length > MAX_RECONCILIATION_CURSOR_BYTES) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return null;
    }
    if (typeof parsed !== "object" || parsed === null) return null;

    const candidate = parsed as Record<string, unknown>;
    if (
        typeof candidate.id !== "string" ||
        candidate.id.length === 0 ||
        candidate.id.length > 128 ||
        typeof candidate.createdAt !== "string"
    ) {
        return null;
    }

    const createdAt = new Date(candidate.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { id: candidate.id, createdAt };
}

async function loadReconciliationCursor(): Promise<
    ReconciliationCursor | undefined
> {
    const stored = await withSchedulerClaimRedisRetry(
        "track reconciliation cursor load",
        (client) => client.get(TRACK_RECONCILIATION_CURSOR_KEY),
    );
    if (!stored) return undefined;

    const cursor = parseReconciliationCursor(stored);
    if (cursor) return cursor;

    log.warn("Discarding invalid persisted track reconciliation cursor");
    await withSchedulerClaimRedisRetry(
        "invalid track reconciliation cursor removal",
        (client) => client.del(TRACK_RECONCILIATION_CURSOR_KEY),
    );
    return undefined;
}

async function saveReconciliationCursor(
    cursor: ReconciliationCursor | null,
): Promise<void> {
    if (!cursor) {
        await withSchedulerClaimRedisRetry(
            "track reconciliation cursor clear",
            (client) => client.del(TRACK_RECONCILIATION_CURSOR_KEY),
        );
        return;
    }

    const stored = JSON.stringify({
        id: cursor.id,
        createdAt: cursor.createdAt.toISOString(),
    });
    await withSchedulerClaimRedisRetry(
        "track reconciliation cursor save",
        (client) => client.set(TRACK_RECONCILIATION_CURSOR_KEY, stored),
    );
}

async function processDataIntegrityJob(): Promise<boolean> {
    const claim = await runWithSchedulerClaim(
        "scheduler-claim:data-integrity",
        30 * ONE_MINUTE_MS,
        "data integrity check",
        async () => {
            await runDataIntegrityCheck();
        },
    );
    return claim.acquired;
}

async function processReconciliationJob(): Promise<boolean> {
    const claim = await runWithSchedulerClaim(
        "scheduler-claim:reconciliation-cycle",
        10 * ONE_MINUTE_MS,
        "download reconciliation cycle",
        async () => {
            if (!(await reconciliationCircuitBreaker.tryAcquire())) {
                log.warn(
                    "Skipping reconciliation while circuit breaker is open",
                    {
                        circuit: await reconciliationCircuitBreaker.snapshot(),
                    },
                );
                return false;
            }
            try {
                await runReconciliationCycle();
                await reconciliationCircuitBreaker.recordSuccess();
                return true;
            } catch (error) {
                await reconciliationCircuitBreaker.recordFailure();
                log.warn("Reconciliation failure recorded by circuit breaker", {
                    circuit: await reconciliationCircuitBreaker.snapshot(),
                    error,
                });
                throw error;
            }
        },
    );
    return claim.acquired && claim.value;
}

async function runReconciliationCycle(): Promise<void> {
    const { lidarrService } = await import("../services/lidarr");
    const snapshot = await requireSchedulerTimedOperation(
        "getReconciliationSnapshot",
        30_000,
        (signal) => lidarrService.getReconciliationSnapshot(signal),
    );

    const staleCount = await requireSchedulerTimedOperation(
        "markStaleJobsAsFailed",
        120_000,
        () => simpleDownloadManager.markStaleJobsAsFailed(snapshot),
    );
    if (staleCount > 0) {
        log.debug(
            `Periodic cleanup: marked ${staleCount} stale download(s) as failed`,
        );
    }

    const lidarrResult = await requireSchedulerTimedOperation(
        "reconcileWithLidarr",
        120_000,
        () => simpleDownloadManager.reconcileWithLidarr(snapshot),
    );
    if (lidarrResult.reconciled > 0) {
        log.debug(
            `Periodic reconcile: ${lidarrResult.reconciled} job(s) matched in Lidarr`,
        );
    }

    const localResult = await requireSchedulerTimedOperation(
        "reconcileWithLocalLibrary",
        120_000,
        () => queueCleaner.reconcileWithLocalLibrary(),
    );
    if (localResult.reconciled > 0) {
        log.debug(
            `Periodic reconcile: ${localResult.reconciled} job(s) matched in local library`,
        );
    }

    const syncResult = await requireSchedulerTimedOperation(
        "syncWithLidarrQueue",
        120_000,
        () => simpleDownloadManager.syncWithLidarrQueue(snapshot),
    );
    if (syncResult.cancelled > 0) {
        log.debug(
            `Periodic sync: ${syncResult.cancelled} job(s) synced with Lidarr queue`,
        );
    }
}

async function processAlbumDownloadRecoveryJob(): Promise<boolean> {
    const claim = await runWithSchedulerClaim(
        "scheduler-claim:album-download-recovery",
        5 * ONE_MINUTE_MS,
        "album download recovery",
        async () => {
            const recovered = await recoverUnqueuedAlbumDownloads();
            if (recovered > 0) {
                log.info(`Recovered ${recovered} unqueued album downloads`);
            }
            const recoveredArtists =
                await recoverUnqueuedArtistDownloadExpansions();
            if (recoveredArtists > 0) {
                log.info(
                    `Recovered ${recoveredArtists} unqueued artist expansions`,
                );
            }
        },
    );
    return claim.acquired;
}

async function processCatalogRetentionJob(): Promise<boolean> {
    const claim = await runWithSchedulerClaim(
        "scheduler-claim:catalog-retention",
        30 * ONE_MINUTE_MS,
        "catalog retention sweep",
        processCatalogRetention,
    );
    return claim.acquired;
}

async function processLidarrCleanupJob(
    mode: "startup" | "repeat",
): Promise<boolean> {
    const claim = await runWithSchedulerClaim(
        "scheduler-claim:lidarr-cleanup-cycle",
        5 * ONE_MINUTE_MS,
        mode === "startup"
            ? "initial Lidarr queue cleanup"
            : "Lidarr queue cleanup cycle",
        async () => {
            if (mode === "startup") {
                log.debug("Running initial Lidarr queue cleanup...");
            }

            const result = await runSchedulerTimedOperation(
                "clearLidarrQueue",
                180_000,
                (signal) => simpleDownloadManager.clearLidarrQueue(signal),
            );

            if (!result) {
                return false;
            }

            if (result.removed > 0) {
                const prefix =
                    mode === "startup"
                        ? "Initial cleanup"
                        : "Periodic Lidarr cleanup";
                log.debug(
                    `${prefix}: removed ${result.removed} stuck download(s)`,
                );
            } else if (mode === "startup") {
                log.debug("Initial cleanup: queue is clean");
            }
            return true;
        },
    );
    return claim.acquired && claim.value;
}

async function processCacheWarmupJob(): Promise<boolean> {
    const claim = await runWithSchedulerClaim(
        "scheduler-claim:cache-warmup-startup",
        30 * ONE_MINUTE_MS,
        "startup cache warmup",
        async () => {
            const result = await runSchedulerTimedOperation(
                "warmupCache",
                15 * ONE_MINUTE_MS,
                async () => {
                    await dataCacheService.warmupCache();
                    return true;
                },
            );
            return result === true;
        },
    );
    return claim.acquired && claim.value;
}

async function processPodcastCleanupJob(
    mode: "startup" | "repeat",
): Promise<boolean> {
    const claim = await runWithSchedulerClaim(
        "scheduler-claim:podcast-cleanup",
        30 * ONE_MINUTE_MS,
        mode === "startup"
            ? "startup podcast cache cleanup"
            : "podcast cache cleanup",
        async () => {
            const { cleanupExpiredCache } =
                await import("../services/podcastDownload");
            const result = await runSchedulerTimedOperation(
                "cleanupExpiredCache",
                10 * ONE_MINUTE_MS,
                async () => {
                    await cleanupExpiredCache();
                    return true;
                },
            );
            return result === true;
        },
    );
    return claim.acquired && claim.value;
}

const REPEAT_SYNC_FAILURE_WARN_INTERVAL_MS = ONE_HOUR_MS;
let lastAudiobookRepeatFailureWarnAt = 0;

async function processAudiobookAutoSyncJob(
    mode: "startup" | "repeat",
): Promise<boolean> {
    const { getSystemSettings } = await import("../utils/systemSettings");
    const settings = await getSystemSettings();
    if (!settings?.audiobookshelfEnabled || !settings?.audiobookshelfUrl) {
        if (mode === "startup") {
            startupLog.debug(
                "Audiobookshelf is disabled or unconfigured - skipping auto-sync",
            );
        }
        return false;
    }
    const { audiobookCacheService } =
        await import("../services/audiobookCache");
    let result;
    try {
        result = await runSchedulerTimedOperation(
            "audiobookCacheService.syncMissing",
            AUDIOBOOK_SYNC_WORK_TIMEOUT_MS,
            () => audiobookCacheService.syncMissing(),
            log,
        );
    } catch (error) {
        if (mode === "startup") throw error;
        const now = Date.now();
        const message =
            "Repeat audiobook auto-sync failed; will retry on the next cycle";
        if (
            now - lastAudiobookRepeatFailureWarnAt >=
            REPEAT_SYNC_FAILURE_WARN_INTERVAL_MS
        ) {
            lastAudiobookRepeatFailureWarnAt = now;
            startupLog.warn(message, error);
        } else {
            startupLog.debug(message, error);
        }
        return false;
    }
    if (
        result &&
        (mode === "startup" || result.synced || result.deleted || result.failed)
    ) {
        startupLog.debug(
            `Audiobook auto-sync complete: ${result.synced} new, ${result.skipped} already cached or skipped, ${result.deleted} deleted, ${result.failed} failed`,
        );
    }
    return result !== undefined;
}

async function processDownloadQueueReconcileJob(): Promise<boolean> {
    const claim = await runWithSchedulerClaim(
        "scheduler-claim:download-queue-reconcile-startup",
        30 * ONE_MINUTE_MS,
        "startup download queue reconciliation",
        async () => {
            const result = await runSchedulerTimedOperation(
                "albumDownloadQueue.getJobCounts",
                20 * ONE_MINUTE_MS,
                () => albumDownloadQueue.getJobCounts(),
            );

            if (result) {
                log.debug(
                    `Album download queue ready: ${result.active} active, ${result.waiting} waiting, ${result.delayed} delayed`,
                );
            }
            return result !== undefined;
        },
    );
    return claim.acquired && claim.value;
}

async function processArtistCountsBackfillJob(): Promise<boolean> {
    const claim = await runWithSchedulerClaim(
        "scheduler-claim:artist-counts-backfill-startup",
        3 * ONE_HOUR_MS,
        "startup artist-counts backfill",
        async () => {
            const { isBackfillNeeded, backfillAllArtistCounts } =
                await import("../services/artistCountsService");
            const needsBackfill = await isBackfillNeeded();
            if (!needsBackfill) {
                startupLog.debug("Artist counts already populated");
                return true;
            }

            startupLog.info(
                "Artist counts need backfilling, starting in background...",
            );

            const result = await runSchedulerTimedOperation(
                "backfillAllArtistCounts",
                3 * ONE_HOUR_MS,
                () => backfillAllArtistCounts(),
            );

            if (result) {
                startupLog.info(
                    `Artist counts backfill complete: ${result.processed} processed, ${result.errors} errors`,
                );
            }
            return result !== undefined;
        },
    );
    return claim.acquired && claim.value;
}

async function processImageBackfillJob(): Promise<boolean> {
    const claim = await runWithSchedulerClaim(
        "scheduler-claim:image-backfill-startup",
        6 * ONE_HOUR_MS,
        "startup image backfill",
        async () => {
            const { isImageBackfillNeeded, backfillAllImages } =
                await import("../services/imageBackfill");
            const status = await isImageBackfillNeeded();
            if (!status.needed) {
                startupLog.debug("All images already stored locally");
                return true;
            }

            startupLog.info(
                `Image backfill needed: ${status.artistsWithExternalUrls} artists, ${status.albumsWithExternalUrls} albums with external URLs`,
            );

            const completed = await runSchedulerTimedOperation(
                "backfillAllImages",
                6 * ONE_HOUR_MS,
                async () => {
                    await backfillAllImages();
                    return true;
                },
            );

            if (completed) {
                startupLog.info("Image backfill complete");
            }
            return completed === true;
        },
    );
    return claim.acquired && claim.value;
}

async function processTrackMappingReconcileJob(): Promise<boolean> {
    const claim = await runWithSchedulerClaim(
        "scheduler-claim:track-mapping-reconcile",
        ONE_HOUR_MS,
        "track mapping reconciliation",
        async () => {
            const { trackReconciliationService } =
                await import("../services/trackReconciliation");
            const orphanResult =
                await trackReconciliationService.reconcileOrphans();
            if (orphanResult.created > 0) {
                log.info(
                    `Created ${orphanResult.created} mappings for orphaned provider rows`,
                );
            }

            const startAfter = await loadReconciliationCursor();
            const window = await trackReconciliationService.reconcileWindow(
                startAfter ? { startAfter } : {},
            );
            await saveReconciliationCursor(window.nextCursor);
            const { result } = window;
            if (result.linked > 0) {
                log.info(
                    `Linked ${result.linked} mappings to local tracks (${result.skipped} skipped)`,
                );
            } else if (result.processed > 0) {
                log.debug(`No new links found (${result.processed} checked)`);
            }

            const upgradeResult =
                await trackReconciliationService.reconcileYoutubeToTidal();
            if (upgradeResult.upgraded > 0) {
                log.info(
                    `Upgraded ${upgradeResult.upgraded} YT mappings to TIDAL (${upgradeResult.skipped} skipped)`,
                );
            } else if (upgradeResult.processed > 0) {
                log.debug(
                    `No YT->TIDAL upgrades found (${upgradeResult.processed} checked)`,
                );
            }
        },
    );
    return claim.acquired;
}

async function processRemoteTrackMetadataRefreshJob(): Promise<boolean> {
    const claim = await runWithSchedulerClaim(
        "scheduler-claim:remote-track-metadata-refresh",
        ONE_HOUR_MS,
        "remote track metadata refresh",
        async () => {
            const { remoteTrackMetadataRefreshService } =
                await import("../services/remoteTrackMetadataRefresh");
            const result =
                await remoteTrackMetadataRefreshService.refreshUnknownMetadata();
            if (result.updated > 0 || result.failed > 0) {
                log.info(
                    `Updated ${result.updated} remote tracks, ${result.failed} failed`,
                );
            }
        },
    );
    return claim.acquired;
}

async function registerSchedulerJobs(): Promise<void> {
    await schedulerQueue.isReady();
    await schedulerMaintenanceQueue.isReady();
    registerSchedulerProcessors();

    const schedulerJobs = buildSchedulerJobs();
    for (const job of schedulerJobs) {
        await registerSchedulerJob(job);
    }
    if (config.features.requests) {
        await registerSchedulerJob(requestFulfillmentRepeatSchedule);
        return;
    }
    await removeRequestFulfillmentSchedules();
    log.info(
        "Music requests disabled (FEATURE_REQUESTS=false); fulfillment scheduler not registered",
    );
}

type SchedulerRegistrationInput = {
    type: string;
    data: Record<string, unknown>;
    opts: Bull.JobOptions;
};

type SchedulerBullQueue = typeof schedulerQueue;

function isFiveMinuteRepeat(opts: Bull.JobOptions): boolean {
    return Boolean(
        opts.repeat &&
        "every" in opts.repeat &&
        opts.repeat.every === REQUEST_FULFILLMENT_INTERVAL_MS,
    );
}

function prepareSchedulerRegistration<T extends SchedulerRegistrationInput>(
    job: T,
): T {
    if (!isFiveMinuteRepeat(job.opts)) return job;
    const jobId = String(job.opts.jobId);
    return {
        ...job,
        opts: {
            ...job.opts,
            repeat: jitterFiveMinuteRepeat(jobId, job.opts.repeat!),
        },
    };
}

async function removeLegacyFiveMinuteRepeat(
    job: SchedulerRegistrationInput,
): Promise<void> {
    if (!isFiveMinuteRepeat(job.opts)) return;
    await schedulerQueue.removeRepeatable(job.type, {
        every: REQUEST_FULFILLMENT_INTERVAL_MS,
        jobId: job.opts.jobId,
    });
}

function schedulerQueueForJob(jobName: string): SchedulerBullQueue {
    return schedulerLaneForJob(jobName) === "fast"
        ? schedulerQueue
        : schedulerMaintenanceQueue;
}

async function runSchedulerRegistrationStep(
    step: string,
    operation: () => Promise<unknown>,
): Promise<void> {
    try {
        await operation();
    } catch (error) {
        log.warn(`Failed scheduler registration step: ${step}`, { error });
    }
}

async function removeSlowRepeatFromFastQueue(
    job: SchedulerRegistrationInput,
): Promise<void> {
    if (schedulerLaneForJob(job.type) !== "slow" || !job.opts.repeat) return;
    await schedulerQueue.removeRepeatable(job.type, {
        ...job.opts.repeat,
        jobId: job.opts.jobId,
    });
}

async function registerSchedulerJob(
    job: SchedulerRegistrationInput,
): Promise<void> {
    const prepared = prepareSchedulerRegistration(job);
    const targetQueue = schedulerQueueForJob(prepared.type);
    await runSchedulerRegistrationStep(
        `remove legacy repeat for ${job.type}`,
        () => removeLegacyFiveMinuteRepeat(job),
    );
    await runSchedulerRegistrationStep(
        `remove old fast-queue repeat for ${prepared.type}`,
        () => removeSlowRepeatFromFastQueue(prepared),
    );
    await runSchedulerRegistrationStep(`register ${prepared.type}`, () =>
        targetQueue.add(prepared.type, prepared.data, prepared.opts),
    );
}

async function removeRequestFulfillmentSchedules(): Promise<void> {
    const jittered = jitterFiveMinuteRepeat(REQUEST_FULFILLMENT_JOB_ID, {
        every: REQUEST_FULFILLMENT_INTERVAL_MS,
    });
    for (const queue of [schedulerQueue, schedulerMaintenanceQueue]) {
        await runSchedulerRegistrationStep(
            `remove disabled request interval from ${queue.name}`,
            () =>
                queue.removeRepeatable(REQUEST_FULFILLMENT_JOB_NAME, {
                    every: REQUEST_FULFILLMENT_INTERVAL_MS,
                    jobId: REQUEST_FULFILLMENT_JOB_ID,
                }),
        );
        await runSchedulerRegistrationStep(
            `remove disabled request cron from ${queue.name}`,
            () =>
                queue.removeRepeatable(REQUEST_FULFILLMENT_JOB_NAME, {
                    ...jittered,
                    jobId: REQUEST_FULFILLMENT_JOB_ID,
                }),
        );
    }
}

function registerQueueProcessors(): void {
    queueProcessorLog.info(
        `workerId=${WORKER_PROCESSOR_ID} owner=${SCHEDULER_CLAIM_OWNER_ID} hostname=${process.env.HOSTNAME ?? "unknown"} pid=${process.pid}`,
    );
    scanQueue.process("scan", processScan);
    if (config.features.discovery) {
        discoverQueue.process("discover-recommendation", processDiscoverWeekly);
        discoverQueue.process("discover-cron-tick", processDiscoverCronTick);
        // Keep legacy unnamed handler for older callers that still enqueue without a job name.
        discoverQueue.process(processDiscoverWeekly);
    } else {
        log.info(
            "Discovery disabled (DISCOVERY_ENABLED=false); discover queue processors not registered",
        );
    }
    imageQueue.process(processImageOptimization);
    validationQueue.process(processValidation);
    genericImportQueue.process(
        "*",
        GENERIC_IMPORT_WORKER_CONCURRENCY,
        processGenericImport,
    );
    albumDownloadQueue.process(
        ALBUM_DOWNLOAD_JOB_NAME,
        ALBUM_DOWNLOAD_WORKER_CONCURRENCY,
        processAlbumDownload,
    );
    artistExpansionQueue.process(
        ARTIST_DOWNLOAD_EXPANSION_JOB_NAME,
        processArtistDownloadExpansion,
    );
    // Legacy drain: process expansion jobs admitted to album-download before upgrade.
    albumDownloadQueue.process(
        ARTIST_DOWNLOAD_EXPANSION_JOB_NAME,
        ALBUM_DOWNLOAD_WORKER_CONCURRENCY,
        processArtistDownloadExpansion,
    );
    if (config.features.federation) {
        registerFederationProcessors();
    } else {
        log.info(
            "Federation disabled (FEDERATION_ENABLED=false); federation processors and schedules not registered",
        );
    }
    scrobbleQueue.process("submit", 4, processScrobble);
}
async function processPrimarySchedulerJob(
    job: Bull.Job<any>,
    mode: "startup" | "repeat",
): Promise<boolean | null> {
    switch (job?.name) {
        case SCHEDULER_JOB_TYPES.dataIntegrity:
            return processDataIntegrityJob();
        case SCHEDULER_JOB_TYPES.reconciliation:
            return processReconciliationJob();
        case SCHEDULER_JOB_TYPES.albumDownloadRecovery:
            return processAlbumDownloadRecoveryJob();
        case SCHEDULER_JOB_TYPES.catalogRetention:
            return processCatalogRetentionJob();
        case SCHEDULER_JOB_TYPES.lidarrCleanup:
            return processLidarrCleanupJob(mode);
        case SCHEDULER_JOB_TYPES.cacheWarmup:
            return processCacheWarmupJob();
        case SCHEDULER_JOB_TYPES.podcastCleanup:
        case "podcast-cleanup":
            return processPodcastCleanupJob(mode);
        case SCHEDULER_JOB_TYPES.audiobookAutoSync:
        case "audiobook-auto-sync":
            return processAudiobookAutoSyncJob(mode);
        default:
            return null;
    }
}

async function processMaintenanceSchedulerJob(
    job: Bull.Job<any>,
): Promise<boolean | null> {
    switch (job?.name) {
        case SCHEDULER_JOB_TYPES.downloadQueueReconcile:
        case "download-queue-reconcile":
            return processDownloadQueueReconcileJob();
        case SCHEDULER_JOB_TYPES.artistCountsBackfill:
        case "artist-counts-backfill":
            return processArtistCountsBackfillJob();
        case SCHEDULER_JOB_TYPES.imageBackfill:
        case "image-backfill":
            return processImageBackfillJob();
        case SCHEDULER_JOB_TYPES.audioHashBackfill:
            await processAudioHashBackfill(job);
            return true;
        case SCHEDULER_JOB_TYPES.loudnessBackfill:
            await processLoudnessBackfill(job);
            return true;
        case SCHEDULER_JOB_TYPES.trackRemovalPurge:
            await processTrackRemovalPurge(job);
            return true;
        case SCHEDULER_JOB_TYPES.trackMappingReconcile:
        case "track-mapping-reconcile":
            return processTrackMappingReconcileJob();
        case SCHEDULER_JOB_TYPES.remoteTrackMetadataRefresh:
        case "remote-track-metadata-refresh":
            return processRemoteTrackMetadataRefreshJob();
        case REQUEST_FULFILLMENT_JOB_NAME:
            if (config.features.requests) {
                await processRequestFulfillmentBatch();
                return true;
            }
            return false;
        default:
            return null;
    }
}

async function processSchedulerJob(job: Bull.Job<any>): Promise<boolean> {
    const mode = job?.data?.mode === "startup" ? "startup" : "repeat";
    const primary = await processPrimarySchedulerJob(job, mode);
    if (primary !== null) return primary;
    const maintenance = await processMaintenanceSchedulerJob(job);
    if (maintenance !== null) return maintenance;
    log.warn(
        `Scheduler wildcard received unknown job type "${job?.name ?? "unknown"}" (jobId=${job?.id ?? "unknown"}); skipping`,
    );
    return false;
}

function canonicalSchedulerMetricJob(
    jobName: string,
): SchedulerMetricJob | null {
    const aliases: Record<string, SchedulerMetricJob> = {
        "podcast-cleanup": SCHEDULER_JOB_TYPES.podcastCleanup,
        "audiobook-auto-sync": SCHEDULER_JOB_TYPES.audiobookAutoSync,
        "download-queue-reconcile": SCHEDULER_JOB_TYPES.downloadQueueReconcile,
        "artist-counts-backfill": SCHEDULER_JOB_TYPES.artistCountsBackfill,
        "image-backfill": SCHEDULER_JOB_TYPES.imageBackfill,
        "track-mapping-reconcile": SCHEDULER_JOB_TYPES.trackMappingReconcile,
        "remote-track-metadata-refresh":
            SCHEDULER_JOB_TYPES.remoteTrackMetadataRefresh,
    };
    if (aliases[jobName]) return aliases[jobName];
    return SCHEDULER_METRIC_JOBS.includes(jobName as SchedulerMetricJob)
        ? (jobName as SchedulerMetricJob)
        : null;
}

async function processSchedulerJobWithMetrics(
    job: Bull.Job<any>,
): Promise<void> {
    const metricJob = canonicalSchedulerMetricJob(String(job?.name ?? ""));
    const startedAt = process.hrtime.bigint();
    try {
        const executed = await processSchedulerJob(job);
        if (metricJob && executed) {
            recordSchedulerJobSuccess(metricJob, Date.now() / 1_000);
        }
    } catch (err) {
        log.error(
            `Scheduler processor failed (${job?.name ?? "unknown"}):`,
            err,
        );
        throw err;
    } finally {
        if (metricJob) {
            const durationSeconds =
                Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
            recordSchedulerJobDuration(metricJob, durationSeconds);
        }
    }
}

function processSchedulerLaneJob(job: Bull.Job<any>): Promise<void> {
    const lane = schedulerLaneForJob(String(job?.name ?? ""));
    if (lane === "fast") {
        return fastSchedulerLane(() => processSchedulerJobWithMetrics(job));
    }
    return slowSchedulerLane(() => processSchedulerJobWithMetrics(job));
}

function registerSchedulerProcessors(): void {
    for (const jobName of SCHEDULER_METRIC_JOBS) {
        schedulerQueueForJob(jobName).process(
            jobName,
            1,
            processSchedulerLaneJob,
        );
    }
    // Retain the wildcard as a compatibility fallback for legacy persisted names.
    schedulerQueue.process("*", processSchedulerLaneJob);
}

function startBackgroundWorkers(): void {
    startUnifiedEnrichmentWorker().catch((err) => {
        log.error("Failed to start unified enrichment worker:", err);
    });

    startVibeEmbedWorker()
        .then((started) => {
            if (!started) {
                log.info(
                    "Vibe provider embedding worker not started; provider mode or audio analysis is disabled",
                );
            }
        })
        .catch((error: unknown) => {
            log.error("Failed to start vibe provider embedding worker", error);
        });

    // Start mood bucket worker
    // Assigns newly analyzed tracks to mood buckets for fast mood mix generation
    if (config.features.audioAnalysis) {
        startMoodBucketWorker().catch((err) => {
            log.error("Failed to start mood bucket worker:", err);
        });
    } else {
        log.info(
            "Audio analysis disabled (AUDIO_ANALYSIS_ENABLED=false); mood bucket worker not started",
        );
    }
    startTrackMappingStalenessWorker();
}

function registerScanQueueEvents(): void {
    registerQueueProcessorEvents(scanQueue, "library-scan", {
        record: recordQueueProcessorEvent,
        recordFailedWithoutJob: true,
        active: (job) => {
            log.debug(
                ` Scan job ${job.id} started (workerId=${WORKER_PROCESSOR_ID})`,
            );
        },
        completed: (job, result) => {
            consumeCoalescedFollowUpAfterSettlement(job);
            log.debug(
                `Scan job ${job.id} completed: +${result.tracksAdded} ~${result.tracksUpdated} -${result.tracksRemoved} (workerId=${WORKER_PROCESSOR_ID})`,
            );
        },
        failed: (job, error) => {
            consumeCoalescedFollowUpAfterSettlement(job!);
            log.error(
                `Scan job ${job!.id} failed (workerId=${WORKER_PROCESSOR_ID}):`,
                error.message,
            );
        },
    });
}

function registerDiscoverQueueEvents(): void {
    registerQueueProcessorEvents(discoverQueue, "discover-weekly", {
        record: recordQueueProcessorEvent,
        recordFailedWithoutJob: true,
        active: (job) => {
            log.debug(
                ` Discover job ${job.id} started for user ${job.data.userId} (workerId=${WORKER_PROCESSOR_ID})`,
            );
        },
        completed: (job, result) => {
            if (result.success) {
                log.debug(
                    `Discover job ${job.id} completed: ${result.playlistName} (${result.songCount} songs) (workerId=${WORKER_PROCESSOR_ID})`,
                );
                return;
            }
            log.debug(
                `Discover job ${job.id} failed: ${result.error} (workerId=${WORKER_PROCESSOR_ID})`,
            );
        },
        failed: (job, error) => {
            log.error(
                `Discover job ${job!.id} failed (workerId=${WORKER_PROCESSOR_ID}):`,
                error.message,
            );
        },
    });
}

function registerMediaQueueEvents(): void {
    registerQueueProcessorEvents(imageQueue, "image-optimization", {
        record: recordQueueProcessorEvent,
        recordFailedWithoutJob: true,
        completed: (job, result) => {
            log.debug(
                `Image job ${job.id} completed: ${
                    result.success ? "success" : result.error
                } (workerId=${WORKER_PROCESSOR_ID})`,
            );
        },
        failed: (job, error) => {
            log.error(
                `Image job ${job!.id} failed (workerId=${WORKER_PROCESSOR_ID}):`,
                error.message,
            );
        },
    });

    registerQueueProcessorEvents(validationQueue, "file-validation", {
        record: recordQueueProcessorEvent,
        recordFailedWithoutJob: true,
        active: (job) => {
            log.debug(
                ` Validation job ${job.id} started (workerId=${WORKER_PROCESSOR_ID})`,
            );
        },
        completed: (job, result) => {
            log.debug(
                `Validation job ${job.id} completed: ${result.tracksChecked} checked, ${result.tracksRemoved} removed (workerId=${WORKER_PROCESSOR_ID})`,
            );
        },
        failed: (job, error) => {
            log.error(
                ` Validation job ${job!.id} failed (workerId=${WORKER_PROCESSOR_ID}):`,
                error.message,
            );
        },
    });
}

function handleAlbumDownloadQueueCompletion(
    job: Bull.Job<unknown>,
    result: AlbumDownloadProcessOutcome | undefined,
): void {
    if (result?.kind !== "contention-wait") {
        recordAlbumDownloadOutcome("completed");
        return;
    }
    void requeueAlbumDownloadAfterContention(job, result).catch((error) => {
        queueProcessorLog.error(
            "Failed to re-enqueue contended album download",
            { jobId: job.id, error },
        );
    });
}

function registerImportQueueEvents(): void {
    registerQueueProcessorEvents(genericImportQueue, "generic-import", {
        record: recordQueueProcessorEvent,
        failed: (job, error) => {
            if (!job) {
                queueProcessorLog.error(
                    "Generic import queue failure had no job",
                    {
                        error,
                    },
                );
                return;
            }
            void finalizeGenericImportQueueFailure(job, error).catch(
                (finalizationError) => {
                    queueProcessorLog.error(
                        "Failed to finalize exhausted generic import job",
                        { jobId: job.id, error: finalizationError },
                    );
                },
            );
        },
    });

    registerQueueProcessorEvents(albumDownloadQueue, "album-download", {
        record: recordQueueProcessorEvent,
        completed: handleAlbumDownloadQueueCompletion,
        failed: (job, error) => {
            if (!job) {
                queueProcessorLog.error(
                    "Album download queue failure had no job",
                    {
                        error,
                    },
                );
                return;
            }
            void handleAlbumDownloadQueueFailure(job, error).catch(
                (finalizationError) => {
                    queueProcessorLog.error(
                        "Failed to classify or finalize album download queue failure",
                        { jobId: job.id, error: finalizationError },
                    );
                },
            );
        },
    });

    registerQueueProcessorEvents(
        artistExpansionQueue,
        "worker-artist-expansion",
        { record: recordQueueProcessorEvent },
    );

    albumDownloadQueue.on("stalled", () => {
        recordAlbumDownloadOutcome("retried");
    });
}

async function handleAlbumDownloadQueueFailure(
    job: Bull.Job<any>,
    error: Error,
): Promise<void> {
    const state = await job.getState();
    if (state !== "failed") {
        recordAlbumDownloadOutcome("retried");
        return;
    }
    recordAlbumDownloadOutcome("failed");
    await finalizeAlbumDownloadQueueFailure(job, error, state);
}

// The scheduler queue runs the heavy maintenance cycles (metadata refresh,
// reconciliation, artist-count backfills) — the primary stall suspects — so
// it MUST feed the event-loop watchdog's attribution registry.
function registerSchedulerQueueEvents(): void {
    registerQueueProcessorEvents(schedulerQueue, "worker-scheduler", {
        record: recordQueueProcessorEvent,
        completed: (job) => {
            log.debug(
                `Scheduler job ${job.id} completed (${job.name}) (workerId=${WORKER_PROCESSOR_ID})`,
            );
        },
        failed: (job, error) => {
            log.error(
                `Scheduler job ${job?.id ?? "unknown"} failed (${job?.name ?? "unknown"}) (workerId=${WORKER_PROCESSOR_ID}):`,
                error.message,
            );
        },
    });

    registerQueueProcessorEvents(
        schedulerMaintenanceQueue,
        "worker-scheduler-maintenance",
        {
            record: recordQueueProcessorEvent,
            completed: (job) => {
                log.debug(
                    `Scheduler maintenance job ${job.id} completed (${job.name}) (workerId=${WORKER_PROCESSOR_ID})`,
                );
            },
            failed: (job, error) => {
                log.error(
                    `Scheduler maintenance job ${job?.id ?? "unknown"} failed (${job?.name ?? "unknown"}) (workerId=${WORKER_PROCESSOR_ID}):`,
                    error.message,
                );
            },
        },
    );
}

// analysisQueue has no processor in this module, so processor-event wiring remains owner-local.
// federationQueue processing is owned by federationJobs; no generic wiring is added here.

function startWorkerSchedules(): void {
    if (config.features.discovery) {
        startDiscoverWeeklyCron();
        log.debug("Discover Weekly scheduler registered");
    } else {
        // Remove the repeatable cron job persisted in Redis by a previous run with
        // the flag on, so no stale schedule lingers (or replays as a backlog the
        // moment the flag is re-enabled).
        stopDiscoverWeeklyCron();
        void discoverQueue
            .getJobCounts()
            .then((counts) => {
                const backlog = (counts.waiting ?? 0) + (counts.delayed ?? 0);
                if (backlog > 0) {
                    log.warn(
                        `Discovery disabled with ${backlog} discover job(s) still in Redis; they will not be processed until DISCOVERY_ENABLED=true`,
                    );
                }
            })
            .catch((error: any) => {
                log.warn(
                    "Failed to inspect leftover discover queue backlog:",
                    error.message || error,
                );
            });
        log.info(
            "Discovery disabled (DISCOVERY_ENABLED=false); Discover Weekly scheduler not registered",
        );
    }

    registerSchedulerJobs()
        .then(() => {
            log.debug(
                "Scheduler queue jobs registered (data-integrity, reconciliation, lidarr-cleanup, startup maintenance)",
            );
        })
        .catch((err) => {
            log.error("Failed to register scheduler queue jobs:", err);
        });

    if (config.features.federation) {
        registerFederationSchedules().catch((error: unknown) => {
            log.error("Failed to register federation schedules", error);
        });
    }

    genericImportJobRunner.registerRecoveryJobs().catch((error) => {
        log.error("Failed to register generic import recovery jobs", { error });
    });
}

let workersStarted = false;

/** Register processors, listeners, and background schedules exactly once. */
export function startWorkers(): void {
    if (workersStarted) return;
    registerQueueProcessors();
    startBackgroundWorkers();
    registerScanQueueEvents();
    registerDiscoverQueueEvents();
    registerMediaQueueEvents();
    registerImportQueueEvents();
    registerSchedulerQueueEvents();
    log.debug("Worker processors registered and event handlers attached");
    startWorkerSchedules();
    workersStarted = true;
}

/**
 * Gracefully shutdown all workers and cleanup resources
 */
export async function shutdownWorkers(): Promise<void> {
    log.debug("Shutting down workers...");

    // Stop unified enrichment worker
    await stopUnifiedEnrichmentWorker();

    // Stop intake and drain provider-owned audio embedding work.
    await stopVibeEmbedWorker();

    // Stop mood bucket worker
    stopMoodBucketWorker();

    stopTrackMappingStalenessWorker();

    // Drain expansion first because it can still admit new album jobs.
    await artistExpansionQueue.close();

    await scrobbleQueue.close();

    // Drain the album processor while its finalizer listener is still active.
    await albumDownloadQueue.close();

    // Drain scan jobs and their settlement follow-ups before listener removal.
    await scanQueue.close();
    await withTimeout(
        () => Promise.allSettled(Array.from(coalescedFollowUpConsumptions)),
        ONE_MINUTE_MS,
        "coalesced scan follow-up drain",
        log,
    );

    // Remove all event listeners to prevent memory leaks
    scanQueue.removeAllListeners();
    discoverQueue.removeAllListeners();
    imageQueue.removeAllListeners();
    validationQueue.removeAllListeners();
    schedulerQueue.removeAllListeners();
    schedulerMaintenanceQueue.removeAllListeners();
    genericImportQueue.removeAllListeners();
    federationQueue.removeAllListeners();
    albumDownloadQueue.removeAllListeners();
    artistExpansionQueue.removeAllListeners();
    scrobbleQueue.removeAllListeners();

    // Close all queues gracefully
    await Promise.all([
        discoverQueue.close(),
        imageQueue.close(),
        validationQueue.close(),
        schedulerQueue.close(),
        schedulerMaintenanceQueue.close(),
        genericImportQueue.close(),
        federationQueue.close(),
    ]);

    // Disconnect enrichment state service Redis connections (2 connections)
    try {
        await enrichmentStateService.disconnect();
        log.debug("Enrichment state service disconnected");
    } catch (err) {
        log.error("Failed to disconnect enrichment state service:", err);
    }

    await closeCoalescedLibraryScanRedis();
    log.debug("Coalesced library scan Redis disconnected");

    // Disconnect discover processor lock Redis connection
    try {
        await shutdownDiscoverProcessor();
        log.debug("Discover processor lock Redis disconnected");
    } catch (err) {
        log.error("Failed to disconnect discover processor Redis:", err);
    }

    // Disconnect worker scheduler lock Redis connection
    try {
        await shutdownSchedulerClaimRedis();
        log.debug("Worker scheduler lock Redis disconnected");
    } catch (err) {
        log.error("Failed to disconnect worker scheduler lock Redis:", err);
    }

    log.debug("Workers shutdown complete");
}

// Export queues for use in other modules
export {
    scanQueue,
    discoverQueue,
    imageQueue,
    validationQueue,
    schedulerQueue,
    schedulerMaintenanceQueue,
    genericImportQueue,
    federationQueue,
    albumDownloadQueue,
    artistExpansionQueue,
    scrobbleQueue,
};
