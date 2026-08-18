import type { Request, Response } from "express";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { schedulerQueue } from "../workers/queues";
import { TRACK_REMOVAL_PURGE_JOB_NAME } from "../workers/processors/trackRemovalPurgeProcessor";
import { sendInternalRouteError } from "./routeErrorResponse";

const log = logger.child("AdminLibraryHealthPurge");
const PURGE_NOW_JOB_ID = "scheduler:track-removal-purge:purge-now";
const PURGE_NOW_JOB_OPTIONS = {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 5_000 },
    jobId: PURGE_NOW_JOB_ID,
    removeOnComplete: true,
    removeOnFail: 10,
};

async function countRemovedLocalTracks(): Promise<number> {
    return prisma.track.count({
        where: {
            origin: "LOCAL",
            removedAt: { not: null },
        },
    });
}

async function addPurgeAt(cutoff: Date): Promise<void> {
    await schedulerQueue.add(
        TRACK_REMOVAL_PURGE_JOB_NAME,
        { cutoffAt: cutoff.toISOString() },
        PURGE_NOW_JOB_OPTIONS,
    );
}

async function enqueuePurgeAt(cutoff: Date): Promise<void> {
    const existingJob = await schedulerQueue.getJob(PURGE_NOW_JOB_ID);
    if (!existingJob) {
        await addPurgeAt(cutoff);
        return;
    }

    const state = await existingJob.getState();
    if (state === "active") {
        // The running sweep covers removals before its cutoff; a residual
        // window after that cutoff requires a later purge request.
        return;
    }

    try {
        await existingJob.remove();
        await addPurgeAt(cutoff);
    } catch (error) {
        log.warn("Purge-now replacement raced job state; retrying add:", error);
        await addPurgeAt(cutoff);
    }
}

const PURGE_STATES_IN_FLIGHT = new Set(["waiting", "delayed", "active"]);
const FAILED_SCAN_LIMIT = 50;
const FAILURE_REASON_LIMIT = 200;

function boundedFailureReason(reason: string | undefined): string {
    if (!reason) return "Purge job failed";
    const firstLine =
        reason
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.length > 0) ?? "Purge job failed";
    return firstLine.slice(0, FAILURE_REASON_LIMIT);
}

const FAILURE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

async function findLatestPurgeFailure(): Promise<string | null> {
    const failed = await schedulerQueue.getFailed(0, FAILED_SCAN_LIMIT);
    const cutoff = Date.now() - FAILURE_MAX_AGE_MS;
    for (const job of failed) {
        if (job?.name !== TRACK_REMOVAL_PURGE_JOB_NAME) continue;
        const finishedOn = job.finishedOn ?? job.timestamp;
        if (typeof finishedOn === "number" && finishedOn < cutoff) continue;
        return boundedFailureReason(job.failedReason);
    }
    return null;
}

async function isPurgeInFlight(): Promise<boolean> {
    const purgeNowJob = await schedulerQueue.getJob(PURGE_NOW_JOB_ID);
    if (purgeNowJob) {
        const state = await purgeNowJob.getState();
        if (PURGE_STATES_IN_FLIGHT.has(state)) return true;
    }
    const active = await schedulerQueue.getJobs(
        ["active"],
        0,
        FAILED_SCAN_LIMIT,
    );
    return active.some((job) => job?.name === TRACK_REMOVAL_PURGE_JOB_NAME);
}

/**
 * Reports live purge progress: how many soft-removed tracks remain, whether
 * a purge page is queued or running, and the last purge failure if any.
 */
export async function handlePurgeRemovedStatus(
    _req: Request,
    res: Response,
): Promise<Response> {
    try {
        const [remaining, purging, lastFailure] = await Promise.all([
            countRemovedLocalTracks(),
            isPurgeInFlight(),
            findLatestPurgeFailure(),
        ]);
        return res.json({ remaining, purging, lastFailure });
    } catch (error) {
        log.error("Purge status error:", error);
        return sendInternalRouteError(res, "Failed to read purge status");
    }
}

/** Enqueues one singleton sweep that purges all currently removed local tracks. */
export async function handlePurgeRemovedTracksNow(
    _req: Request,
    res: Response,
): Promise<Response> {
    try {
        const matched = await countRemovedLocalTracks();
        if (matched === 0) {
            return res.json({ enqueued: false, matched });
        }

        await enqueuePurgeAt(new Date());
        return res.json({ enqueued: true, matched });
    } catch (error) {
        log.error("Enqueue removed track purge error:", error);
        return sendInternalRouteError(
            res,
            "Failed to enqueue removed track purge",
        );
    }
}
