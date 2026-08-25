import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireAuth } from "../middleware/auth";
import { resolveAlbumForExternalTrack } from "../services/trackAlbumResolution";
import { logger } from "../utils/logger";
import {
    sendInternalRouteError,
    sendRouteError,
} from "../utils/routeErrorResponse";

const router = Router();
const log = logger.child("MetadataRoutes");
const boundedQueryString = z.string().trim().min(1).max(256);
const trackAlbumQuerySchema = z.strictObject({
    artist: boundedQueryString,
    title: boundedQueryString,
    album: boundedQueryString.optional(),
});

router.use(requireAuth);

/**
 * @openapi
 * /api/metadata/track-album:
 *   get:
 *     summary: Resolve an external track to its MusicBrainz release-group album
 *     tags: [Metadata]
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     parameters:
 *       - { in: query, name: artist, required: true, schema: { type: string, minLength: 1, maxLength: 256 } }
 *       - { in: query, name: title, required: true, schema: { type: string, minLength: 1, maxLength: 256 } }
 *       - { in: query, name: album, schema: { type: string, minLength: 1, maxLength: 256 } }
 *     responses:
 *       200:
 *         description: Resolved release-group album
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [albumTitle, rgMbid, artistName, source]
 *               properties:
 *                 albumTitle: { type: string }
 *                 rgMbid: { type: string }
 *                 artistName: { type: string }
 *                 source: { type: string, enum: [musicbrainz-album, musicbrainz-recording, lastfm, deezer] }
 *       400: { description: Invalid query parameters }
 *       401: { description: Not authenticated }
 *       404: { description: Track album could not be resolved }
 *       503: { description: Track album resolution timed out }
 *       500: { description: Track album resolution failed }
 */
router.get(
    "/track-album",
    asyncHandler(async (req, res) => {
        const query = trackAlbumQuerySchema.safeParse(req.query);
        if (!query.success) {
            return sendRouteError(res, 400, "Invalid track album query", {
                code: "INVALID_QUERY",
            });
        }

        try {
            const result = await resolveAlbumForExternalTrack({
                artistName: query.data.artist,
                trackTitle: query.data.title,
                albumTitle: query.data.album,
            });
            if (result.status === "miss") {
                return sendRouteError(res, 404, "Track album not found", {
                    code: "TRACK_ALBUM_NOT_FOUND",
                });
            }
            if (result.status === "timeout") {
                return sendRouteError(
                    res,
                    503,
                    "Track album resolution timed out",
                    { code: "RESOLUTION_TIMEOUT" },
                );
            }
            return res.json(result.resolution);
        } catch (error) {
            log.error("Track album resolution failed", error);
            return sendInternalRouteError(res, "Failed to resolve track album");
        }
    }),
);

export default router;
