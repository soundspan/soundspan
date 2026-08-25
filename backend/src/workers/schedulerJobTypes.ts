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
    audioHashBackfill: "track-audio-hash-backfill",
    loudnessBackfill: "track-loudness-backfill",
    trackRemovalPurge: "track-removal-purge",
    trackMappingReconcile: "track-mapping-reconcile",
    remoteTrackMetadataRefresh: "remote-track-metadata-refresh",
} as const;

/** Persisted scheduler job name accepted by the canonical dispatcher. */
export type SchedulerJobType =
    (typeof SCHEDULER_JOB_TYPES)[keyof typeof SCHEDULER_JOB_TYPES];
