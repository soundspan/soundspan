import type { Request, Response } from "express";
import { prisma } from "../../../utils/db";
import { logger } from "../../../utils/logger";
import { discoverQueue } from "../../../workers/queues";
import { sendInternalRouteError } from "../../routeErrorResponse";

// Deprecated legacy discovery code is frozen: no fixes; removal is planned.

/** Handles frozen legacy manual discovery generation. */
export async function handleLegacyGenerate(
    req: Request,
    res: Response,
): Promise<Response | void> {
    try {
        const userId = req.user!.id;
        // Check for existing active batch
        const existingBatch = await prisma.discoveryBatch.findFirst({
            where: {
                userId,
                status: { in: ["downloading", "scanning"] },
            },
        });

        if (existingBatch) {
            return res.status(409).json({
                error: "Generation already in progress",
                batchId: existingBatch.id,
                status: existingBatch.status,
            });
        }

        logger.debug(
            `\n Queuing Discover Weekly generation for user ${userId}`,
        );

        // Add generation job to queue
        const job = await discoverQueue.add({ userId });

        res.json({
            message: "Discover Weekly generation started",
            jobId: job.id,
        });
    } catch (error) {
        logger.error("Generate Discover Weekly error:", error);
        sendInternalRouteError(res, "Failed to start generation");
    }
}
