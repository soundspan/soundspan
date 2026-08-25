import type { Request, Response } from "express";
import { discoverQueue } from "../../workers/queues";
import { logger } from "../../utils/logger";
import {
    sendInternalRouteError,
    sendRouteError,
} from "../../utils/routeErrorResponse";

const ACTIVE_JOB_STATES = new Set(["active", "waiting", "delayed", "paused"]);

async function removeStaleManualJob(
    manualJobId: string,
    job: { remove: () => Promise<void> },
): Promise<void> {
    await job.remove().catch((error: unknown) => {
        logger.warn(
            `[Discover] Failed to remove stale manual job ${manualJobId}:`,
            error,
        );
    });
}

/** Handles recommendation-mode manual discovery generation. */
export async function handleModernGenerate(
    req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        const userId = req.user!.id;
        const manualJobId = `discover:manual:${userId}`;
        const existingJob = await discoverQueue.getJob(manualJobId);

        if (existingJob) {
            const state = await existingJob.getState();
            if (ACTIVE_JOB_STATES.has(state)) {
                return res.status(409).json({
                    error: "Generation already in progress",
                    jobId: existingJob.id,
                    status: state,
                });
            }
            await removeStaleManualJob(manualJobId, existingJob);
        }

        const job = await discoverQueue.add(
            "discover-recommendation",
            { userId },
            { jobId: manualJobId },
        );
        return res.json({
            message: "Discover Weekly recommendation generation started",
            jobId: job.id,
        });
    } catch (error) {
        logger.error("Generate Discover Weekly error:", error);
        sendInternalRouteError(res, "Failed to start generation");
    }
}

/** Handles discovery generation job-status requests for both modes. */
export async function handleGenerateStatus(
    req: Request<{ jobId: string }>,
    res: Response,
): Promise<Response | void> {
    try {
        const job = await discoverQueue.getJob(req.params.jobId);
        if (!job) return sendRouteError(res, 404, "Job not found");

        const state = await job.getState();
        const progress = job.progress();
        const result = job.returnvalue;
        return res.json({ status: state, progress, result });
    } catch (error) {
        logger.error("Get generation status error:", error);
        sendInternalRouteError(res, "Failed to get job status");
    }
}
