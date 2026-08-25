import type Bull from "bull";
import { createHash } from "node:crypto";
import { REQUEST_FULFILLMENT_JOB_NAME } from "./requestFulfillmentSchedule";
import { SCHEDULER_JOB_TYPES } from "./schedulerJobTypes";

export type SchedulerLane = "fast" | "slow" | "unknown";
type BullRepeatOptions = NonNullable<Bull.JobOptions["repeat"]>;
export const FIVE_MINUTE_JITTER_MAX_SECONDS = 45;
const FIVE_MINUTE_MS = 5 * 60_000;

const FAST_JOB_NAMES = new Set<string>([
    SCHEDULER_JOB_TYPES.reconciliation,
    SCHEDULER_JOB_TYPES.albumDownloadRecovery,
    SCHEDULER_JOB_TYPES.lidarrCleanup,
]);
const SLOW_JOB_NAMES = new Set<string>([
    ...Object.values(SCHEDULER_JOB_TYPES),
    REQUEST_FULFILLMENT_JOB_NAME,
    "podcast-cleanup",
    "audiobook-auto-sync",
    "download-queue-reconcile",
    "artist-counts-backfill",
    "image-backfill",
    "track-mapping-reconcile",
    "remote-track-metadata-refresh",
]);

/** Selects the isolated scheduler capacity lane for one persisted job name. */
export function schedulerLaneForJob(jobName: string): SchedulerLane {
    if (FAST_JOB_NAMES.has(jobName)) return "fast";
    if (SLOW_JOB_NAMES.has(jobName)) return "slow";
    return "unknown";
}

function stableJitterSeconds(jobId: string): number {
    const digest = createHash("sha256").update(jobId).digest();
    return (digest.readUInt32BE(0) % FIVE_MINUTE_JITTER_MAX_SECONDS) + 1;
}

/** Converts five-minute Bull intervals to stable second-offset cron schedules. */
export function jitterFiveMinuteRepeat(
    jobId: string,
    repeat: BullRepeatOptions,
): BullRepeatOptions {
    if (!("every" in repeat) || repeat.every !== FIVE_MINUTE_MS) return repeat;
    const seconds = stableJitterSeconds(jobId);
    return { cron: `${seconds} */5 * * * *` };
}
