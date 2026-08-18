import type { Request, Response } from "express";
import { discoverQueue } from "../../workers/queues";
import { logger } from "../../utils/logger";
import { sendInternalRouteError } from "../routeErrorResponse";

interface DiscoverQueuePayload {
    userId: string;
}

function isDiscoverQueuePayload(value: unknown): value is DiscoverQueuePayload {
    if (typeof value !== "object" || value === null) return false;
    return "userId" in value && typeof value.userId === "string";
}

/** Handles recommendation-mode discovery batch status. */
export async function handleModernBatchStatus(
    req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        const userId = req.user!.id;
        const jobs = await discoverQueue.getJobs(
            ["active", "waiting", "delayed"],
            0,
            200,
        );
        const activeJob = jobs.find(
            (job) =>
                isDiscoverQueuePayload(job.data) && job.data.userId === userId,
        );

        if (!activeJob) {
            return res.json({ active: false, status: null, progress: null });
        }

        const state = await activeJob.getState();
        const rawProgress = activeJob.progress();
        const progress =
            typeof rawProgress === "number"
                ? Math.max(0, Math.min(100, Math.round(rawProgress)))
                : 0;

        return res.json({
            active: true,
            status: "generating",
            batchId: String(activeJob.id),
            progress,
            completed: progress,
            failed: 0,
            total: 100,
            queueState: state,
        });
    } catch (error) {
        logger.error("Get batch status error:", error);
        sendInternalRouteError(res, "Failed to get batch status");
    }
}
