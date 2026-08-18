import type { Request, Response } from "express";
import { prisma } from "../../../utils/db";
import { logger } from "../../../utils/logger";
import { sendInternalRouteError } from "../../routeErrorResponse";

// Deprecated legacy discovery code is frozen: no fixes; removal is planned.

/** Handles frozen legacy discovery batch status. */
export async function handleLegacyBatchStatus(
    req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        const userId = req.user!.id;
        // Find any active batch for this user
        const activeBatch = await prisma.discoveryBatch.findFirst({
            where: {
                userId,
                status: { in: ["downloading", "scanning"] },
            },
            include: {
                jobs: {
                    select: {
                        status: true,
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });

        if (!activeBatch) {
            return res.json({
                active: false,
                status: null,
                progress: null,
            });
        }

        const completedJobs = activeBatch.jobs.filter(
            (j) => j.status === "completed",
        ).length;
        const failedJobs = activeBatch.jobs.filter(
            (j) => j.status === "failed" || j.status === "exhausted",
        ).length;
        const totalJobs = activeBatch.jobs.length;
        const progress =
            totalJobs > 0
                ? Math.round(((completedJobs + failedJobs) / totalJobs) * 100)
                : 0;

        res.json({
            active: true,
            status: activeBatch.status,
            batchId: activeBatch.id,
            progress,
            completed: completedJobs,
            failed: failedJobs,
            total: totalJobs,
        });
    } catch (error) {
        logger.error("Get batch status error:", error);
        sendInternalRouteError(res, "Failed to get batch status");
    }
}
