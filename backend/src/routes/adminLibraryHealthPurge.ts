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
