import { logger } from "../utils/logger";
import { randomUUID } from "crypto";
import { trackJobStart, trackJobEnd } from "../services/workerEventLoopMonitor";
import type Bull from "bull";
import {
    scanQueue,
    discoverQueue,
    imageQueue,
    validationQueue,
    schedulerQueue,
    genericImportQueue,
    federationQueue,
    albumDownloadQueue,
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
    finalizeAlbumDownloadQueueFailure,
    processAlbumDownload,
} from "./processors/albumDownloadProcessor";
import { recordAlbumDownloadOutcome } from "../metrics";
import { recoverUnqueuedAlbumDownloads } from "../services/albumDownloadQueueService";
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
import { downloadQueueManager } from "../services/downloadQueue";
import { config } from "../config";
import { prisma } from "../utils/db";
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

async function processDataIntegrityJob(): Promise<void> {
    await runWithSchedulerClaim(
        "scheduler-claim:data-integrity",
        30 * ONE_MINUTE_MS,
        "data integrity check",
        async () => {
            await runDataIntegrityCheck();
        },
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
                "getReconciliationSnapshot",
            );

            const staleCount = await withTimeout(
                () => simpleDownloadManager.markStaleJobsAsFailed(snapshot),
                120_000,
                "markStaleJobsAsFailed",
            );
            if (staleCount && staleCount > 0) {
                log.debug(
                    `Periodic cleanup: marked ${staleCount} stale download(s) as failed`,
                );
            }

            const lidarrResult = await withTimeout(
                () => simpleDownloadManager.reconcileWithLidarr(snapshot),
                120_000,
                "reconcileWithLidarr",
            );
            if (lidarrResult && lidarrResult.reconciled > 0) {
                log.debug(
                    `Periodic reconcile: ${lidarrResult.reconciled} job(s) matched in Lidarr`,
                );
            }

            const localResult = await withTimeout(
                () => queueCleaner.reconcileWithLocalLibrary(),
                120_000,
                "reconcileWithLocalLibrary",
            );
            if (localResult && localResult.reconciled > 0) {
                log.debug(
                    `Periodic reconcile: ${localResult.reconciled} job(s) matched in local library`,
                );
            }

            const syncResult = await withTimeout(
                () => simpleDownloadManager.syncWithLidarrQueue(snapshot),
                120_000,
                "syncWithLidarrQueue",
            );
            if (syncResult && syncResult.cancelled > 0) {
                log.debug(
                    `Periodic sync: ${syncResult.cancelled} job(s) synced with Lidarr queue`,
                );
            }
        },
    );
}

async function processAlbumDownloadRecoveryJob(): Promise<void> {
    await runWithSchedulerClaim(
        "scheduler-claim:album-download-recovery",
        5 * ONE_MINUTE_MS,
        "album download recovery",
        async () => {
            const recovered = await recoverUnqueuedAlbumDownloads();
            if (recovered > 0) {
                log.info(`Recovered ${recovered} unqueued album downloads`);
            }
        },
    );
}

async function processLidarrCleanupJob(
    mode: "startup" | "repeat",
): Promise<void> {
    await runWithSchedulerClaim(
        "scheduler-claim:lidarr-cleanup-cycle",
        5 * ONE_MINUTE_MS,
        mode === "startup"
            ? "initial Lidarr queue cleanup"
            : "Lidarr queue cleanup cycle",
        async () => {
            if (mode === "startup") {
                log.debug("Running initial Lidarr queue cleanup...");
            }

            const result = await withTimeout(
                () => simpleDownloadManager.clearLidarrQueue(),
                180_000,
                "clearLidarrQueue",
            );

            if (!result) {
                return;
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
        },
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
                "warmupCache",
            );
        },
    );
}

async function processPodcastCleanupJob(
    mode: "startup" | "repeat",
): Promise<void> {
    await runWithSchedulerClaim(
        "scheduler-claim:podcast-cleanup",
        30 * ONE_MINUTE_MS,
        mode === "startup"
            ? "startup podcast cache cleanup"
            : "podcast cache cleanup",
        async () => {
            const { cleanupExpiredCache } =
                await import("../services/podcastDownload");
            await withTimeout(
                () => cleanupExpiredCache(),
                10 * ONE_MINUTE_MS,
                "cleanupExpiredCache",
            );
        },
    );
}

const REPEAT_SYNC_FAILURE_WARN_INTERVAL_MS = ONE_HOUR_MS;
let lastAudiobookRepeatFailureWarnAt = 0;

async function processAudiobookAutoSyncJob(
    mode: "startup" | "repeat",
): Promise<void> {
    const { getSystemSettings } = await import("../utils/systemSettings");
    const settings = await getSystemSettings();
    if (!settings?.audiobookshelfEnabled || !settings?.audiobookshelfUrl) {
        if (mode === "startup") {
            startupLog.debug(
                "Audiobookshelf is disabled or unconfigured - skipping auto-sync",
            );
        }
        return;
    }
    const { audiobookCacheService } =
        await import("../services/audiobookCache");
    let result;
    try {
        result = await withTimeout(
            () => audiobookCacheService.syncMissing(),
            AUDIOBOOK_SYNC_WORK_TIMEOUT_MS,
            "audiobookCacheService.syncMissing",
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
        return;
    }
    if (result && (mode === "startup" || result.synced || result.failed)) {
        startupLog.debug(
            `Audiobook auto-sync complete: ${result.synced} new, ${result.skipped} already cached, ${result.failed} failed`,
        );
    }
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
                "downloadQueueManager.reconcileOnStartup",
            );

            if (result) {
                log.debug(
                    `Download queue reconciled: ${result.loaded} active, ${result.failed} marked failed`,
                );
            }
        },
    );
}

async function processArtistCountsBackfillJob(): Promise<void> {
    await runWithSchedulerClaim(
        "scheduler-claim:artist-counts-backfill-startup",
        3 * ONE_HOUR_MS,
        "startup artist-counts backfill",
        async () => {
            const { isBackfillNeeded, backfillAllArtistCounts } =
                await import("../services/artistCountsService");
            const needsBackfill = await isBackfillNeeded();
            if (!needsBackfill) {
                startupLog.debug("Artist counts already populated");
                return;
            }

            startupLog.info(
                "Artist counts need backfilling, starting in background...",
            );

            const result = await withTimeout(
                () => backfillAllArtistCounts(),
                3 * ONE_HOUR_MS,
                "backfillAllArtistCounts",
            );

            if (result) {
                startupLog.info(
                    `Artist counts backfill complete: ${result.processed} processed, ${result.errors} errors`,
                );
            }
        },
    );
}

async function processImageBackfillJob(): Promise<void> {
    await runWithSchedulerClaim(
        "scheduler-claim:image-backfill-startup",
        6 * ONE_HOUR_MS,
        "startup image backfill",
        async () => {
            const { isImageBackfillNeeded, backfillAllImages } =
                await import("../services/imageBackfill");
            const status = await isImageBackfillNeeded();
            if (!status.needed) {
                startupLog.debug("All images already stored locally");
                return;
            }

            startupLog.info(
                `Image backfill needed: ${status.artistsWithExternalUrls} artists, ${status.albumsWithExternalUrls} albums with external URLs`,
            );

            const completed = await withTimeout(
                async () => {
                    await backfillAllImages();
                    return true;
                },
                6 * ONE_HOUR_MS,
                "backfillAllImages",
            );

            if (completed) {
                startupLog.info("Image backfill complete");
            }
        },
    );
}

async function processTrackMappingReconcileJob(): Promise<void> {
    await runWithSchedulerClaim(
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
}

async function processRemoteTrackMetadataRefreshJob(): Promise<void> {
    await runWithSchedulerClaim(
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
}

async function registerSchedulerJobs(): Promise<void> {
    await schedulerQueue.isReady();

    const schedulerJobs = buildSchedulerJobs();
    for (const job of schedulerJobs) {
        await schedulerQueue.add(job.type, job.data, job.opts);
    }
    if (config.features.requests) {
        const job = requestFulfillmentRepeatSchedule;
        await schedulerQueue.add(job.type, job.data, job.opts);
        return;
    }
    await schedulerQueue.removeRepeatable(REQUEST_FULFILLMENT_JOB_NAME, {
        every: REQUEST_FULFILLMENT_INTERVAL_MS,
        jobId: REQUEST_FULFILLMENT_JOB_ID,
    });
    log.info(
        "Music requests disabled (FEATURE_REQUESTS=false); fulfillment scheduler not registered",
    );
}

// Register processors with named job types
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
if (config.features.federation) {
    registerFederationProcessors();
} else {
    log.info(
        "Federation disabled (FEDERATION_ENABLED=false); federation processors and schedules not registered",
    );
}
async function processSchedulerJob(job: Bull.Job<any>): Promise<void> {
    const mode = job?.data?.mode === "startup" ? "startup" : "repeat";

    switch (job?.name) {
        case SCHEDULER_JOB_TYPES.dataIntegrity:
            await processDataIntegrityJob();
            break;
        case SCHEDULER_JOB_TYPES.reconciliation:
            await processReconciliationJob();
            break;
        case SCHEDULER_JOB_TYPES.albumDownloadRecovery:
            await processAlbumDownloadRecoveryJob();
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
            await processAudiobookAutoSyncJob(mode);
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
        case SCHEDULER_JOB_TYPES.audioHashBackfill:
            await processAudioHashBackfill(job);
            break;
        case SCHEDULER_JOB_TYPES.loudnessBackfill:
            await processLoudnessBackfill(job);
            break;
        case SCHEDULER_JOB_TYPES.trackRemovalPurge:
            await processTrackRemovalPurge(job);
            break;
        case SCHEDULER_JOB_TYPES.trackMappingReconcile:
        case "track-mapping-reconcile":
            await processTrackMappingReconcileJob();
            break;
        case SCHEDULER_JOB_TYPES.remoteTrackMetadataRefresh:
        case "remote-track-metadata-refresh":
            await processRemoteTrackMetadataRefreshJob();
            break;
        case REQUEST_FULFILLMENT_JOB_NAME:
            if (config.features.requests) {
                await processRequestFulfillmentBatch();
            }
            break;
        default:
            log.warn(
                `Scheduler wildcard received unknown job type "${job?.name ?? "unknown"}" (jobId=${job?.id ?? "unknown"}); skipping`,
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
        log.error(
            `Scheduler processor failed (${job?.name ?? "unknown"}):`,
            err,
        );
        throw err;
    }
});

// Register download queue callback for unavailable albums
downloadQueueManager.onUnavailableAlbum(async (info) => {
    log.debug(
        ` Recording unavailable album: ${info.artistName} - ${info.albumTitle}`,
    );

    if (!info.userId) {
        log.debug(` No userId provided, skipping database record`);
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

        log.debug(`   Recorded in database`);
    } catch (error: any) {
        // Handle duplicate entries (album already marked as unavailable)
        if (error.code === "P2002") {
            log.debug(`     Album already marked as unavailable`);
        } else {
            log.error(` Failed to record unavailable album:`, error.message);
        }
    }
});

// Start unified enrichment worker
// Handles: artist metadata, track tags (Last.fm), audio analysis queueing (Essentia)
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

// Event handlers for scan queue
scanQueue.on("completed", (job, result) => {
    recordQueueProcessorEvent("library-scan", "completed", job);
    log.debug(
        `Scan job ${job.id} completed: +${result.tracksAdded} ~${result.tracksUpdated} -${result.tracksRemoved} (workerId=${WORKER_PROCESSOR_ID})`,
    );
});

scanQueue.on("failed", (job, err) => {
    recordQueueProcessorEvent("library-scan", "failed", job);
    log.error(
        `Scan job ${job.id} failed (workerId=${WORKER_PROCESSOR_ID}):`,
        err.message,
    );
});

scanQueue.on("active", (job) => {
    recordQueueProcessorEvent("library-scan", "active", job);
    log.debug(` Scan job ${job.id} started (workerId=${WORKER_PROCESSOR_ID})`);
});

// Event handlers for discover queue
discoverQueue.on("completed", (job, result) => {
    recordQueueProcessorEvent("discover-weekly", "completed", job);
    if (result.success) {
        log.debug(
            `Discover job ${job.id} completed: ${result.playlistName} (${result.songCount} songs) (workerId=${WORKER_PROCESSOR_ID})`,
        );
    } else {
        log.debug(
            `Discover job ${job.id} failed: ${result.error} (workerId=${WORKER_PROCESSOR_ID})`,
        );
    }
});

discoverQueue.on("failed", (job, err) => {
    recordQueueProcessorEvent("discover-weekly", "failed", job);
    log.error(
        `Discover job ${job.id} failed (workerId=${WORKER_PROCESSOR_ID}):`,
        err.message,
    );
});

discoverQueue.on("active", (job) => {
    recordQueueProcessorEvent("discover-weekly", "active", job);
    log.debug(
        ` Discover job ${job.id} started for user ${job.data.userId} (workerId=${WORKER_PROCESSOR_ID})`,
    );
});

// Event handlers for image queue
imageQueue.on("completed", (job, result) => {
    recordQueueProcessorEvent("image-optimization", "completed", job);
    log.debug(
        `Image job ${job.id} completed: ${
            result.success ? "success" : result.error
        } (workerId=${WORKER_PROCESSOR_ID})`,
    );
});

imageQueue.on("failed", (job, err) => {
    recordQueueProcessorEvent("image-optimization", "failed", job);
    log.error(
        `Image job ${job.id} failed (workerId=${WORKER_PROCESSOR_ID}):`,
        err.message,
    );
});

imageQueue.on("active", (job) => {
    recordQueueProcessorEvent("image-optimization", "active", job);
});

// Event handlers for validation queue
validationQueue.on("completed", (job, result) => {
    recordQueueProcessorEvent("file-validation", "completed", job);
    log.debug(
        `Validation job ${job.id} completed: ${result.tracksChecked} checked, ${result.tracksRemoved} removed (workerId=${WORKER_PROCESSOR_ID})`,
    );
});

validationQueue.on("failed", (job, err) => {
    recordQueueProcessorEvent("file-validation", "failed", job);
    log.error(
        ` Validation job ${job.id} failed (workerId=${WORKER_PROCESSOR_ID}):`,
        err.message,
    );
});

validationQueue.on("active", (job) => {
    recordQueueProcessorEvent("file-validation", "active", job);
    log.debug(
        ` Validation job ${job.id} started (workerId=${WORKER_PROCESSOR_ID})`,
    );
});

genericImportQueue.on("active", (job) => {
    recordQueueProcessorEvent("generic-import", "active", job);
});

genericImportQueue.on("completed", (job) => {
    recordQueueProcessorEvent("generic-import", "completed", job);
});

genericImportQueue.on("failed", (job, error) => {
    if (!job) {
        queueProcessorLog.error("Generic import queue failure had no job", {
            error,
        });
        return;
    }
    recordQueueProcessorEvent("generic-import", "failed", job);
    void finalizeGenericImportQueueFailure(job, error).catch(
        (finalizationError) => {
            queueProcessorLog.error(
                "Failed to finalize exhausted generic import job",
                {
                    jobId: job.id,
                    error: finalizationError,
                },
            );
        },
    );
});

albumDownloadQueue.on("active", (job) => {
    recordQueueProcessorEvent("album-download", "active", job);
});

albumDownloadQueue.on("completed", (job) => {
    recordQueueProcessorEvent("album-download", "completed", job);
    recordAlbumDownloadOutcome("completed");
});

albumDownloadQueue.on("stalled", () => {
    recordAlbumDownloadOutcome("retried");
});

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

albumDownloadQueue.on("failed", (job, error) => {
    if (!job) {
        queueProcessorLog.error("Album download queue failure had no job", {
            error,
        });
        return;
    }
    recordQueueProcessorEvent("album-download", "failed", job);
    void handleAlbumDownloadQueueFailure(job, error).catch(
        (finalizationError) => {
            queueProcessorLog.error(
                "Failed to classify or finalize album download queue failure",
                { jobId: job.id, error: finalizationError },
            );
        },
    );
});

// The scheduler queue runs the heavy maintenance cycles (metadata refresh,
// reconciliation, artist-count backfills) — the primary stall suspects — so
// it MUST feed the event-loop watchdog's attribution registry.
schedulerQueue.on("active", (job) => {
    recordQueueProcessorEvent("worker-scheduler", "active", job);
});

schedulerQueue.on("completed", (job) => {
    recordQueueProcessorEvent("worker-scheduler", "completed", job);
    log.debug(
        `Scheduler job ${job.id} completed (${job.name}) (workerId=${WORKER_PROCESSOR_ID})`,
    );
});

schedulerQueue.on("failed", (job, err) => {
    if (job) {
        recordQueueProcessorEvent("worker-scheduler", "failed", job);
    }
    log.error(
        `Scheduler job ${job?.id ?? "unknown"} failed (${job?.name ?? "unknown"}) (workerId=${WORKER_PROCESSOR_ID}):`,
        err.message,
    );
});

log.debug("Worker processors registered and event handlers attached");

// Start Discovery Weekly cron scheduler (Sundays at 8 PM)
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

    // Shutdown download queue manager
    downloadQueueManager.shutdown();

    // Drain the album processor while its finalizer listener is still active.
    await albumDownloadQueue.close();

    // Remove all event listeners to prevent memory leaks
    scanQueue.removeAllListeners();
    discoverQueue.removeAllListeners();
    imageQueue.removeAllListeners();
    validationQueue.removeAllListeners();
    schedulerQueue.removeAllListeners();
    genericImportQueue.removeAllListeners();
    federationQueue.removeAllListeners();
    albumDownloadQueue.removeAllListeners();

    // Close all queues gracefully
    await Promise.all([
        scanQueue.close(),
        discoverQueue.close(),
        imageQueue.close(),
        validationQueue.close(),
        schedulerQueue.close(),
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
    genericImportQueue,
    federationQueue,
    albumDownloadQueue,
};
