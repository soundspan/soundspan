import { Counter, Gauge, Histogram, type Registry } from "prom-client";
import { REQUEST_FULFILLMENT_JOB_NAME } from "../workers/requestFulfillmentSchedule";
import { SCHEDULER_JOB_TYPES } from "../workers/schedulerJobTypes";

/** Closed scheduler job label vocabulary accepted by metrics. */
export const SCHEDULER_METRIC_JOBS = [
    ...Object.values(SCHEDULER_JOB_TYPES),
    REQUEST_FULFILLMENT_JOB_NAME,
] as const;
export type SchedulerMetricJob = (typeof SCHEDULER_METRIC_JOBS)[number];

/** Closed operation vocabulary for scheduler-owned timeout events. */
export const SCHEDULER_TIMEOUT_OPERATIONS = [
    "getReconciliationSnapshot",
    "markStaleJobsAsFailed",
    "reconcileWithLidarr",
    "reconcileWithLocalLibrary",
    "syncWithLidarrQueue",
    "clearLidarrQueue",
    "warmupCache",
    "cleanupExpiredCache",
    "audiobookCacheService.syncMissing",
    "downloadQueueManager.reconcileOnStartup",
    "backfillAllArtistCounts",
    "backfillAllImages",
] as const;
export type SchedulerTimeoutOperation =
    (typeof SCHEDULER_TIMEOUT_OPERATIONS)[number];

/** Registers bounded scheduler reliability and duration instruments. */
export function createSchedulerMetrics(registry: Registry) {
    return {
        timeouts: new Counter({
            name: "soundspan_scheduler_timeouts_total",
            help: "Scheduler-owned operation timeouts by bounded operation name.",
            labelNames: ["operation"] as const,
            registers: [registry],
        }),
        jobDuration: new Histogram({
            name: "soundspan_scheduler_job_duration_seconds",
            help: "Scheduler job execution duration by bounded persisted job name.",
            labelNames: ["job"] as const,
            buckets: [
                0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 900, 3_600, 7_200, 14_400,
                21_600,
            ],
            registers: [registry],
        }),
        lastSuccess: new Gauge({
            name: "soundspan_scheduler_job_last_success_timestamp_seconds",
            help: "Unix timestamp of the last successful scheduler job execution.",
            labelNames: ["job"] as const,
            registers: [registry],
        }),
    };
}
