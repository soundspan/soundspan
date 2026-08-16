import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../middleware/asyncHandler";
import { prisma, Prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    backfillRemoteArtistAlbumLinks,
    isRemoteBackfillInProgress,
} from "../../services/remoteTrackBackfillService";

/**
 * Router segment for metadataBackfill routes registered at this position.
 */
export const metadataBackfillRouter = Router();
/**
 * @openapi
 * /api/library/backfill-genres:
 *   post:
 *     summary: Backfill genres for artists missing genre data
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Genre backfill result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 count:
 *                   type: integer
 *                 artists:
 *                   type: array
 *                   items:
 *                     type: string
 *       401:
 *         description: Not authenticated
 */
// POST /library/backfill-genres - Backfill genres for artists missing them
/**
 * Handles POST /api/library/backfill-genres.
 */
export async function handleBackfillGenres(req: Request, res: Response) {
    // Find artists that have been enriched but have no genres
    const artistsToBackfill = await prisma.artist.findMany({
        where: {
            enrichmentStatus: "completed",
            OR: [
                { genres: { equals: Prisma.DbNull } },
                { genres: { equals: [] } },
            ],
        },
        select: { id: true, name: true, mbid: true },
        take: 50, // Process in batches
    });

    if (artistsToBackfill.length === 0) {
        return res.json({
            message: "No artists need genre backfill",
            count: 0,
        });
    }

    // Reset these artists to pending so enrichment worker re-processes them
    const result = await prisma.artist.updateMany({
        where: {
            id: { in: artistsToBackfill.map((a) => a.id) },
        },
        data: {
            enrichmentStatus: "pending",
            lastEnriched: null,
        },
    });

    logger.info(
        `[Backfill] Reset ${result.count} artists for genre enrichment`,
    );

    res.json({
        message: `Reset ${result.count} artists for genre enrichment`,
        count: result.count,
        artists: artistsToBackfill.map((a) => a.name).slice(0, 10),
    });
}

metadataBackfillRouter.post(
    "/backfill-genres",
    asyncHandler(handleBackfillGenres),
);

/**
 * @openapi
 * /api/library/backfill-remote-artists:
 *   post:
 *     summary: Backfill artist/album entity links for existing remote tracks
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
// POST /library/backfill-remote-artists - Backfill artist/album links for remote tracks
/**
 * Handles POST /api/library/backfill-remote-artists.
 */
export async function handleBackfillRemoteArtists(req: Request, res: Response) {
    if (isRemoteBackfillInProgress()) {
        return res.json({
            message: "Remote artist backfill already in progress",
            status: "processing",
        });
    }

    // Return immediately, run backfill in background
    res.json({
        message: "Remote artist backfill started",
        status: "processing",
    });

    // Run backfill (non-blocking)
    backfillRemoteArtistAlbumLinks().catch((error) => {
        logger.error("[RemoteBackfill] Backfill failed:", error);
    });
}

metadataBackfillRouter.post(
    "/backfill-remote-artists",
    asyncHandler(handleBackfillRemoteArtists),
);
