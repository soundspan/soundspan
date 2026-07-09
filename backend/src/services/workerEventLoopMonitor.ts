import { monitorEventLoopDelay } from "perf_hooks";
import { logger } from "../utils/logger";

/**
 * Worker event-loop stall watchdog (issue #43).
 *
 * The worker's liveness probe (`/health/live`) answers unconditionally, so a
 * probe timeout always means the event loop itself was blocked. Historically
 * that ended in a kubelet kill with no indication of WHICH job pegged the
 * loop. This module samples `monitorEventLoopDelay` and, when the observed
 * delay crosses a threshold, logs a warning naming the Bull jobs that were
 * active during the stall — so the next incident names its culprit instead
 * of requiring log archaeology.
 *
 * The registry is fed by the queue observability handlers in
 * `workers/index.ts` (every queue already routes `active`/`completed`/
 * `failed` events through one function). Attribution is best-effort:
 * concurrent jobs all get listed.
 */

export interface ActiveJobRecord {
    queue: string;
    jobId: string;
    jobName: string;
    startedAtMs: number;
}

export interface EventLoopSampleMs {
    maxMs: number;
    p99Ms: number;
    meanMs: number;
}

export interface StallWarning {
    message: string;
}

const activeJobs = new Map<string, ActiveJobRecord>();

function jobKey(queue: string, jobId: string): string {
    return `${queue}:${jobId}`;
}

export function trackJobStart(
    queue: string,
    jobId: string,
    jobName: string,
    startedAtMs: number = Date.now()
): void {
    activeJobs.set(jobKey(queue, jobId), {
        queue,
        jobId,
        jobName,
        startedAtMs,
    });
}

export function trackJobEnd(queue: string, jobId: string): void {
    activeJobs.delete(jobKey(queue, jobId));
}

export function getActiveJobs(): ActiveJobRecord[] {
    return Array.from(activeJobs.values());
}

export function clearActiveJobsForTest(): void {
    activeJobs.clear();
}

/**
 * Pure decision: given a sampled event-loop delay window and the jobs active
 * at evaluation time, produce a stall warning or null.
 */
export function evaluateEventLoopSample(
    sample: EventLoopSampleMs,
    jobs: ActiveJobRecord[],
    warnThresholdMs: number,
    nowMs: number
): StallWarning | null {
    if (sample.maxMs < warnThresholdMs) return null;

    const jobList =
        jobs.length === 0
            ? "none"
            : jobs
                  .map((job) => {
                      const ageSeconds = Math.max(
                          0,
                          Math.round((nowMs - job.startedAtMs) / 1000)
                      );
                      return `${job.queue}/${job.jobName}#${job.jobId} age=${ageSeconds}s`;
                  })
                  .join(", ");

    return {
        message:
            `[WorkerEventLoop] stall detected: max=${Math.round(sample.maxMs)}ms ` +
            `p99=${Math.round(sample.p99Ms)}ms mean=${Math.round(sample.meanMs)}ms ` +
            `activeJobs=${jobList}`,
    };
}

interface HistogramLike {
    max: number;
    mean: number;
    percentile(p: number): number;
    reset(): void;
}

const NS_PER_MS = 1e6;

/**
 * One sampling tick: read the histogram (nanoseconds), evaluate, warn if
 * stalled, and reset the window either way.
 */
export function runMonitorTick(
    histogram: HistogramLike,
    warnThresholdMs: number,
    now: () => number = Date.now
): void {
    const sample: EventLoopSampleMs = {
        maxMs: histogram.max / NS_PER_MS,
        p99Ms: histogram.percentile(99) / NS_PER_MS,
        meanMs: histogram.mean / NS_PER_MS,
    };

    const warning = evaluateEventLoopSample(
        sample,
        getActiveJobs(),
        warnThresholdMs,
        now()
    );
    if (warning) {
        logger.warn(warning.message);
    }

    histogram.reset();
}

let stopMonitor: (() => void) | null = null;

export interface WorkerEventLoopMonitorOptions {
    warnThresholdMs: number;
    sampleIntervalMs: number;
}

/**
 * Start the watchdog. Idempotent; returns a stop function. The interval is
 * unref'd so it never keeps the process alive. Options come from
 * `config.workerEventLoop` at the call site — this module stays free of the
 * config import chain so it can be unit-tested without a database.
 */
export function startWorkerEventLoopMonitor(
    options?: Partial<WorkerEventLoopMonitorOptions>
): () => void {
    if (stopMonitor) return stopMonitor;

    const warnThresholdMs = options?.warnThresholdMs ?? 1000;
    const sampleIntervalMs = options?.sampleIntervalMs ?? 5000;

    const histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();

    const interval = setInterval(() => {
        runMonitorTick(histogram, warnThresholdMs);
    }, sampleIntervalMs);
    interval.unref();

    logger.info(
        `[WorkerEventLoop] stall watchdog started (warn>=${warnThresholdMs}ms, sample every ${sampleIntervalMs}ms)`
    );

    stopMonitor = () => {
        clearInterval(interval);
        histogram.disable();
        stopMonitor = null;
    };
    return stopMonitor;
}
