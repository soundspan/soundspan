import type Bull from "bull";
import { loudnessBackfillRepeatSchedule } from "./loudnessBackfillSchedule";
import { AUDIO_HASH_BACKFILL_JOB_NAME } from "./processors/audioHashBackfillProcessor";
import { LOUDNESS_BACKFILL_JOB_NAME } from "./processors/loudnessBackfillProcessor";
import { TRACK_REMOVAL_PURGE_JOB_NAME } from "./processors/trackRemovalPurgeProcessor";

/** Milliseconds in one minute for scheduler intervals and timeouts. */
export const ONE_MINUTE_MS = 60_000;

/** Milliseconds in one hour for scheduler intervals and timeouts. */
export const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

/** Bull job names handled by the worker scheduler. */
export const SCHEDULER_JOB_TYPES = {
    dataIntegrity: "data-integrity-check",
    reconciliation: "download-reconciliation-cycle",
    albumDownloadRecovery: "album-download-recovery-cycle",
    catalogRetention: "catalog-retention-sweep",
    lidarrCleanup: "lidarr-cleanup-cycle",
    cacheWarmup: "cache-warmup-startup",
    podcastCleanup: "podcast-cache-cleanup",
    audiobookAutoSync: "audiobook-auto-sync-startup",
    downloadQueueReconcile: "download-queue-reconcile-startup",
    artistCountsBackfill: "artist-counts-backfill-startup",
    imageBackfill: "image-backfill-startup",
    audioHashBackfill: AUDIO_HASH_BACKFILL_JOB_NAME,
    loudnessBackfill: LOUDNESS_BACKFILL_JOB_NAME,
    trackRemovalPurge: TRACK_REMOVAL_PURGE_JOB_NAME,
    trackMappingReconcile: "track-mapping-reconcile",
    remoteTrackMetadataRefresh: "remote-track-metadata-refresh",
} as const;

/** Stable Bull job IDs used to deduplicate scheduler registrations. */
export const SCHEDULER_JOB_IDS = {
    dataIntegrityStartup: "scheduler:data-integrity:startup",
    dataIntegrityRepeat: "scheduler:data-integrity:repeat",
    reconciliationStartup: "scheduler:reconciliation:startup",
    reconciliationRepeat: "scheduler:reconciliation:repeat",
    albumDownloadRecoveryStartup: "scheduler:album-download-recovery:startup",
    albumDownloadRecoveryRepeat: "scheduler:album-download-recovery:repeat",
    catalogRetentionStartup: "scheduler:catalog-retention:startup",
    catalogRetentionRepeat: "scheduler:catalog-retention:repeat",
    lidarrCleanupStartup: "scheduler:lidarr-cleanup:startup",
    lidarrCleanupRepeat: "scheduler:lidarr-cleanup:repeat",
    cacheWarmupStartup: "scheduler:cache-warmup:startup",
    podcastCleanupStartup: "scheduler:podcast-cleanup:startup",
    podcastCleanupRepeat: "scheduler:podcast-cleanup:repeat",
    audiobookAutoSyncStartup: "scheduler:audiobook-auto-sync:startup",
    audiobookAutoSyncRepeat: "scheduler:audiobook-auto-sync:repeat",
    downloadQueueReconcileStartup: "scheduler:download-queue-reconcile:startup",
    artistCountsBackfillStartup: "scheduler:artist-counts-backfill:startup",
    imageBackfillStartup: "scheduler:image-backfill:startup",
    audioHashBackfillStartup: "scheduler:audio-hash-backfill:startup",
    loudnessBackfillStartup: "scheduler:loudness-backfill:startup",
    trackRemovalPurgeStartup: "scheduler:track-removal-purge:startup",
    trackRemovalPurgeRepeat: "scheduler:track-removal-purge:repeat",
    trackMappingReconcileStartup: "scheduler:track-mapping-reconcile:startup",
    trackMappingReconcileRepeat: "scheduler:track-mapping-reconcile:repeat",
    remoteTrackMetadataRefreshStartup:
        "scheduler:remote-track-metadata-refresh:startup",
    remoteTrackMetadataRefreshRepeat:
        "scheduler:remote-track-metadata-refresh:repeat",
} as const;

type SchedulerRegistration = {
    type: (typeof SCHEDULER_JOB_TYPES)[keyof typeof SCHEDULER_JOB_TYPES];
    data: { mode: "startup" | "repeat"; sweepStartedAt?: string };
    opts: Bull.JobOptions;
};

function analysisBackfillStartupJob(
    type: SchedulerRegistration["type"],
    jobId: string,
    delay: number,
): SchedulerRegistration {
    return {
        type,
        data: { mode: "startup", sweepStartedAt: new Date().toISOString() },
        opts: {
            jobId,
            delay,
            attempts: 3,
            backoff: { type: "exponential", delay: 5_000 },
            removeOnComplete: true,
            removeOnFail: 10,
        },
    };
}

/** Build scheduler registrations in their required Bull enqueue order. */
export function buildSchedulerJobs(): SchedulerRegistration[] {
    return [
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
            type: SCHEDULER_JOB_TYPES.albumDownloadRecovery,
            data: { mode: "startup" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.albumDownloadRecoveryStartup,
                delay: ONE_MINUTE_MS,
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.catalogRetention,
            data: { mode: "startup" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.catalogRetentionStartup,
                delay: 2 * ONE_MINUTE_MS,
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.catalogRetention,
            data: { mode: "repeat" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.catalogRetentionRepeat,
                repeat: { every: ONE_HOUR_MS },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.albumDownloadRecovery,
            data: { mode: "repeat" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.albumDownloadRecoveryRepeat,
                repeat: { every: 5 * ONE_MINUTE_MS },
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
            type: SCHEDULER_JOB_TYPES.audiobookAutoSync,
            data: { mode: "repeat" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.audiobookAutoSyncRepeat,
                repeat: { every: 5 * ONE_MINUTE_MS },
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
        analysisBackfillStartupJob(
            SCHEDULER_JOB_TYPES.audioHashBackfill,
            SCHEDULER_JOB_IDS.audioHashBackfillStartup,
            50_000,
        ),
        analysisBackfillStartupJob(
            SCHEDULER_JOB_TYPES.loudnessBackfill,
            SCHEDULER_JOB_IDS.loudnessBackfillStartup,
            55_000,
        ),
        loudnessBackfillRepeatSchedule,
        {
            type: SCHEDULER_JOB_TYPES.trackRemovalPurge,
            data: { mode: "startup" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.trackRemovalPurgeStartup,
                delay: ONE_MINUTE_MS,
                attempts: 3,
                backoff: { type: "exponential", delay: 5_000 },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.trackRemovalPurge,
            data: { mode: "repeat" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.trackRemovalPurgeRepeat,
                repeat: { every: 24 * ONE_HOUR_MS },
                attempts: 3,
                backoff: { type: "exponential", delay: 5_000 },
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
        {
            type: SCHEDULER_JOB_TYPES.remoteTrackMetadataRefresh,
            data: { mode: "startup" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.remoteTrackMetadataRefreshStartup,
                delay: 90_000,
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
        {
            type: SCHEDULER_JOB_TYPES.remoteTrackMetadataRefresh,
            data: { mode: "repeat" },
            opts: {
                jobId: SCHEDULER_JOB_IDS.remoteTrackMetadataRefreshRepeat,
                repeat: { every: 12 * ONE_HOUR_MS },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        },
    ];
}
