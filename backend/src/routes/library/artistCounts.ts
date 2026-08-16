import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../middleware/asyncHandler";
import { logger } from "../../utils/logger";
import {
    backfillAllArtistCounts,
    isBackfillNeeded,
    getBackfillProgress,
    isBackfillInProgress,
} from "../../services/artistCountsService";

/**
 * Router segment for artistCounts routes registered at this position.
 */
export const artistCountsRouter = Router();
/**
 * @openapi
 * /api/library/artist-counts/status:
 *   get:
 *     summary: Check artist counts backfill status
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Backfill status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 needsBackfill:
 *                   type: boolean
 *       401:
 *         description: Not authenticated
 */
// GET /library/artist-counts/status - Check artist counts backfill status
/**
 * Handles GET /api/library/artist-counts/status.
 */
export async function handleGetArtistCountsStatus(req: Request, res: Response) {
    const [needsBackfill, progress] = await Promise.all([
        isBackfillNeeded(),
        getBackfillProgress(),
    ]);

    res.json({
        needsBackfill,
        ...progress,
    });
}

artistCountsRouter.get(
    "/artist-counts/status",
    asyncHandler(handleGetArtistCountsStatus),
);

/**
 * @openapi
 * /api/library/artist-counts/backfill:
 *   post:
 *     summary: Trigger artist counts backfill
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Backfill started or already in progress
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
// POST /library/artist-counts/backfill - Trigger artist counts backfill
/**
 * Handles POST /api/library/artist-counts/backfill.
 */
export async function handleStartArtistCountsBackfill(
    req: Request,
    res: Response,
) {
    if (isBackfillInProgress()) {
        return res.json({
            message: "Backfill already in progress",
            status: "processing",
        });
    }

    // Return immediately, run backfill in background
    res.json({ message: "Backfill started", status: "processing" });

    // Run backfill (non-blocking)
    backfillAllArtistCounts((processed, total) => {
        if (processed % 100 === 0) {
            logger.debug(`[ArtistCounts] Progress: ${processed}/${total}`);
        }
    }).catch((error) => {
        logger.error("[ArtistCounts] Backfill failed:", error);
    });
}

artistCountsRouter.post(
    "/artist-counts/backfill",
    asyncHandler(handleStartArtistCountsBackfill),
);
