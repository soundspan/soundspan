import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { playlistImportService } from "../services/playlistImportService";
import { logger } from "../utils/logger";

const router = Router();

const urlSchema = z.object({
    url: z.string().url(),
});

const resolvedTrackSchema = z
    .object({
        index: z.number(),
        artist: z.string(),
        title: z.string(),
        album: z.string().optional(),
        trackId: z.string().optional(),
        trackYtMusicId: z.string().optional(),
        trackTidalId: z.string().optional(),
        source: z.enum(["local", "youtube", "tidal", "unresolved"]),
        confidence: z.number(),
    })
    .refine(
        (t) => {
            if (t.source === "local") return !!t.trackId;
            if (t.source === "youtube") return !!t.trackYtMusicId;
            if (t.source === "tidal") return !!t.trackTidalId;
            return true; // unresolved has no ID requirement
        },
        {
            message:
                "Resolved track source/ID mismatch: local requires trackId, youtube requires trackYtMusicId, tidal requires trackTidalId",
        }
    );

const summarySchema = z.object({
    total: z.number(),
    local: z.number(),
    youtube: z.number(),
    tidal: z.number(),
    unresolved: z.number(),
});

const executeSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    previewData: z.object({
        playlistName: z.string(),
        resolved: z.array(resolvedTrackSchema),
        summary: summarySchema,
    }),
});

/**
 * @openapi
 * /api/import/preview:
 *   post:
 *     summary: Preview playlist import — resolve all tracks without creating playlist
 *     tags: [Import]
 *     security:
 *       - sessionAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               url:
 *                 type: string
 *                 description: Spotify, Deezer, YouTube Music, or Tidal playlist URL
 *     responses:
 *       200:
 *         description: Track resolution preview
 *       400:
 *         description: Invalid or unsupported URL
 *       401:
 *         description: Not authenticated
 */
router.post(
    "/preview",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const parsed = urlSchema.safeParse(req.body);
            if (!parsed.success) {
                return res
                    .status(400)
                    .json({ error: "Valid playlist URL is required" });
            }

            const userId = req.user!.id;
            const result = await playlistImportService.previewImport(
                userId,
                parsed.data.url
            );
            res.json(result);
        } catch (err: any) {
            const msg = err.message || "";
            if (
                msg.includes("Unsupported") ||
                msg.includes("not found") ||
                msg.includes("requires authentication")
            ) {
                return res
                    .status(400)
                    .json({ error: msg });
            }
            if (
                msg.includes("ECONNREFUSED") ||
                msg.includes("ETIMEDOUT") ||
                msg.includes("fetch failed") ||
                msg.includes("status code 5")
            ) {
                logger.warn("[Import] External service unavailable:", err);
                return res
                    .status(502)
                    .json({ error: "External service unavailable" });
            }
            logger.error("[Import] Preview failed:", err);
            res.status(500).json({ error: "Failed to preview import" });
        }
    }
);

/**
 * @openapi
 * /api/import/execute:
 *   post:
 *     summary: Execute playlist import — create playlist from preview data
 *     tags: [Import]
 *     security:
 *       - sessionAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - previewData
 *             properties:
 *               previewData:
 *                 type: object
 *                 description: Preview data from /api/import/preview
 *                 properties:
 *                   playlistName:
 *                     type: string
 *                   resolved:
 *                     type: array
 *                     items:
 *                       type: object
 *                   summary:
 *                     type: object
 *               name:
 *                 type: string
 *                 description: Custom playlist name (uses source name if omitted)
 *     responses:
 *       200:
 *         description: Created playlist details
 *       400:
 *         description: Invalid request body
 *       401:
 *         description: Not authenticated
 */
router.post(
    "/execute",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const parsed = executeSchema.safeParse(req.body);
            if (!parsed.success) {
                return res
                    .status(400)
                    .json({ error: "Valid previewData is required" });
            }

            const userId = req.user!.id;
            const result = await playlistImportService.importPlaylist(
                userId,
                parsed.data.previewData,
                parsed.data.name
            );
            res.json(result);
        } catch (err: any) {
            if (err.message?.includes("Invalid track reference")) {
                return res
                    .status(400)
                    .json({ error: err.message });
            }
            logger.error("[Import] Execute failed:", err);
            res.status(500).json({ error: "Failed to execute import" });
        }
    }
);

export default router;
