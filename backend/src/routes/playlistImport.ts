import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { playlistImportService } from "../services/playlistImportService";
import { logger } from "../utils/logger";

const router = Router();

const urlSchema = z.object({
    url: z.string().url(),
});

const executeSchema = z.object({
    url: z.string().url(),
    name: z.string().min(1).max(200).optional(),
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
 *                 description: Spotify or Deezer playlist URL
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
            if (
                err.message?.includes("Unsupported") ||
                err.message?.includes("not found")
            ) {
                return res
                    .status(400)
                    .json({ error: err.message });
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
 *     summary: Execute playlist import — create playlist with resolved tracks
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
 *                 description: Spotify or Deezer playlist URL
 *               name:
 *                 type: string
 *                 description: Custom playlist name (uses source name if omitted)
 *     responses:
 *       200:
 *         description: Created playlist details
 *       400:
 *         description: Invalid or unsupported URL
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
                    .json({ error: "Valid playlist URL is required" });
            }

            const userId = req.user!.id;
            const result = await playlistImportService.importPlaylist(
                userId,
                parsed.data.url,
                parsed.data.name || ""
            );
            res.json(result);
        } catch (err: any) {
            if (
                err.message?.includes("Unsupported") ||
                err.message?.includes("not found")
            ) {
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
