import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../middleware/asyncHandler";
import { logger } from "../../utils/logger";
import {
    isImageBackfillNeeded,
    getImageBackfillProgress,
    backfillAllImages,
} from "../../services/imageBackfill";

/**
 * Router segment for imageBackfill routes registered at this position.
 */
export const imageBackfillRouter = Router();
/**
 * @openapi
 * /api/library/image-backfill/status:
 *   get:
 *     summary: Check image backfill status
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Image backfill status and progress
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       401:
 *         description: Not authenticated
 */
// GET /library/image-backfill/status - Check image backfill status
/**
 * Handles GET /api/library/image-backfill/status.
 */
export async function handleGetImageBackfillStatus(
    req: Request,
    res: Response,
) {
    const [status, progress] = await Promise.all([
        isImageBackfillNeeded(),
        getImageBackfillProgress(),
    ]);

    res.json({
        ...status,
        ...progress,
    });
}

imageBackfillRouter.get(
    "/image-backfill/status",
    asyncHandler(handleGetImageBackfillStatus),
);

/**
 * @openapi
 * /api/library/image-backfill/start:
 *   post:
 *     summary: Trigger image backfill for artists and albums
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Image backfill started or already in progress
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 status:
 *                   type: string
 *       401:
 *         description: Not authenticated
 */
// POST /library/image-backfill/start - Trigger image backfill
/**
 * Handles POST /api/library/image-backfill/start.
 */
export async function handleStartImageBackfill(req: Request, res: Response) {
    const progress = getImageBackfillProgress();
    if (progress.inProgress) {
        return res.json({
            message: "Image backfill already in progress",
            status: "processing",
            progress,
        });
    }

    // Return immediately, run backfill in background
    res.json({ message: "Image backfill started", status: "processing" });

    // Run backfill (non-blocking)
    backfillAllImages().catch((error) => {
        logger.error("[ImageBackfill] Backfill failed:", error);
    });
}

imageBackfillRouter.post(
    "/image-backfill/start",
    asyncHandler(handleStartImageBackfill),
);
