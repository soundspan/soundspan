import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuthOrToken } from "../middleware/auth";
import { z } from "zod";
import { spotifyService } from "../services/spotify";
import { spotifyImportService } from "../services/spotifyImport";
import { deezerService } from "../services/deezer";
import { readSessionLog, getSessionLogPath } from "../utils/playlistLogger";

const router = Router();

// All routes require authentication
router.use(requireAuthOrToken);

// Validation schemas
const parseUrlSchema = z.object({
    url: z.string().url(),
});

const importSchema = z.object({
    spotifyPlaylistId: z.string(),
    url: z.string().url().optional(),
    playlistName: z.string().min(1).max(200),
    albumMbidsToDownload: z.array(z.string()),
});

/**
 * @openapi
 * /api/spotify/parse:
 *   post:
 *     summary: Parse a Spotify URL and return basic info
 *     tags: [Spotify]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url]
 *             properties:
 *               url:
 *                 type: string
 *                 format: uri
 *     responses:
 *       200:
 *         description: Parsed Spotify URL info
 *       400:
 *         description: Invalid URL or unsupported type
 *       401:
 *         description: Not authenticated
 */
/**
 * POST /api/spotify/parse
 * Parse a Spotify URL and return basic info
 */
router.post("/parse", async (req, res) => {
    try {
        const { url } = parseUrlSchema.parse(req.body);

        const parsed = spotifyService.parseUrl(url);
        if (!parsed) {
            return res.status(400).json({
                error: "Invalid Spotify URL. Please provide a valid playlist URL.",
            });
        }

        // For now, only support playlists
        if (parsed.type !== "playlist") {
            return res.status(400).json({
                error: `Only playlist imports are supported. Got: ${parsed.type}`,
            });
        }

        res.json({
            type: parsed.type,
            id: parsed.id,
            url: `https://open.spotify.com/playlist/${parsed.id}`,
        });
    } catch (error: any) {
        logger.error("Spotify parse error:", error);
        if (error.name === "ZodError") {
            return res.status(400).json({ error: "Invalid request body" });
        }
        res.status(500).json({ error: error.message || "Failed to parse URL" });
    }
});

/**
 * @openapi
 * /api/spotify/preview:
 *   post:
 *     summary: Generate a preview of what will be imported from a Spotify or Deezer playlist
 *     tags: [Spotify]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url]
 *             properties:
 *               url:
 *                 type: string
 *                 format: uri
 *     responses:
 *       200:
 *         description: Import preview with track matching summary
 *       400:
 *         description: Invalid request body or Deezer playlist URL
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Deezer playlist not found
 */
/**
 * POST /api/spotify/preview
 * Generate a preview of what will be imported from a Spotify or Deezer playlist
 */
router.post("/preview", async (req, res) => {
    try {
        const { url } = parseUrlSchema.parse(req.body);

        logger.debug(`[Playlist Import] Generating preview for: ${url}`);

        // Detect if it's a Deezer URL
        if (url.includes("deezer.com")) {
            // Extract playlist ID from Deezer URL
            const deezerMatch = url.match(/playlist[\/:](\d+)/);
            if (!deezerMatch) {
                return res
                    .status(400)
                    .json({ error: "Invalid Deezer playlist URL" });
            }

            const playlistId = deezerMatch[1];
            const deezerPlaylist = await deezerService.getPlaylist(playlistId);

            if (!deezerPlaylist) {
                return res
                    .status(404)
                    .json({ error: "Deezer playlist not found" });
            }

            // Convert Deezer format to Spotify Import format
            const preview =
                await spotifyImportService.generatePreviewFromDeezer(
                    deezerPlaylist
                );

            logger.debug(
                `[Playlist Import] Deezer preview generated: ${preview.summary.total} tracks, ${preview.summary.inLibrary} in library`
            );
            res.json(preview);
        } else {
            // Handle Spotify URL
            const preview = await spotifyImportService.generatePreview(url);

            logger.debug(
                `[Spotify Import] Preview generated: ${preview.summary.total} tracks, ${preview.summary.inLibrary} in library`
            );
            res.json(preview);
        }
    } catch (error: any) {
        logger.error("Playlist preview error:", error);
        if (error.name === "ZodError") {
            return res.status(400).json({ error: "Invalid request body" });
        }
        res.status(500).json({
            error: error.message || "Failed to generate preview",
        });
    }
});

/**
 * @openapi
 * /api/spotify/import:
 *   post:
 *     summary: Start importing a Spotify playlist
 *     tags: [Spotify]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [spotifyPlaylistId, playlistName, albumMbidsToDownload]
 *             properties:
 *               spotifyPlaylistId:
 *                 type: string
 *               url:
 *                 type: string
 *                 format: uri
 *               playlistName:
 *                 type: string
 *               albumMbidsToDownload:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Import job started
 *       400:
 *         description: Invalid request body
 *       401:
 *         description: Not authenticated
 */
/**
 * POST /api/spotify/import
 * Start importing a Spotify playlist
 */
router.post("/import", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const { spotifyPlaylistId, url, playlistName, albumMbidsToDownload } =
            importSchema.parse(req.body);
        const userId = req.user.id;

        // Re-generate preview to ensure fresh data
        const effectiveUrl =
            url?.trim() ||
            `https://open.spotify.com/playlist/${spotifyPlaylistId}`;

        let preview;
        if (effectiveUrl.includes("deezer.com")) {
            const deezerMatch = effectiveUrl.match(/playlist[\/:](\d+)/);
            if (!deezerMatch) {
                return res
                    .status(400)
                    .json({ error: "Invalid Deezer playlist URL" });
            }
            const playlistId = deezerMatch[1];
            const deezerPlaylist = await deezerService.getPlaylist(playlistId);
            if (!deezerPlaylist) {
                return res
                    .status(404)
                    .json({ error: "Deezer playlist not found" });
            }
            preview = await spotifyImportService.generatePreviewFromDeezer(
                deezerPlaylist
            );
        } else {
            preview = await spotifyImportService.generatePreview(effectiveUrl);
        }

        logger.debug(
            `[Spotify Import] Starting import for user ${userId}: ${playlistName}`
        );
        logger.debug(
            `[Spotify Import] Resolution-only import: ignoring ${albumMbidsToDownload.length} selected download album(s)`
        );

        const job = await spotifyImportService.startImport(
            userId,
            spotifyPlaylistId,
            playlistName,
            [],
            preview
        );

        res.json({
            jobId: job.id,
            status: job.status,
            message: "Import started",
        });
    } catch (error: any) {
        logger.error("Spotify import error:", error);
        if (error.name === "ZodError") {
            return res.status(400).json({ error: "Invalid request body" });
        }
        res.status(500).json({
            error: error.message || "Failed to start import",
        });
    }
});

/**
 * @openapi
 * /api/spotify/import/{jobId}/status:
 *   get:
 *     summary: Get the status of an import job
 *     tags: [Spotify]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Import job status
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Not authorized to view this job
 *       404:
 *         description: Import job not found
 */
/**
 * GET /api/spotify/import/:jobId/status
 * Get the status of an import job
 */
router.get("/import/:jobId/status", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const { jobId } = req.params;
        const userId = req.user.id;

        const job = await spotifyImportService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ error: "Import job not found" });
        }

        // Ensure user owns this job
        if (job.userId !== userId) {
            return res
                .status(403)
                .json({ error: "Not authorized to view this job" });
        }

        res.json(job);
    } catch (error: any) {
        logger.error("Spotify job status error:", error);
        res.status(500).json({
            error: error.message || "Failed to get job status",
        });
    }
});

/**
 * @openapi
 * /api/spotify/imports:
 *   get:
 *     summary: Get all import jobs for the current user
 *     tags: [Spotify]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of import jobs
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /api/spotify/imports
 * Get all import jobs for the current user
 */
router.get("/imports", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;
        const jobs = await spotifyImportService.getUserJobs(userId);
        res.json(jobs);
    } catch (error: any) {
        logger.error("Spotify imports error:", error);
        res.status(500).json({
            error: error.message || "Failed to get imports",
        });
    }
});

/**
 * @openapi
 * /api/spotify/import/{jobId}/refresh:
 *   post:
 *     summary: Re-match pending tracks and add newly downloaded ones to the playlist
 *     tags: [Spotify]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Refresh result with count of newly added tracks
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Not authorized to refresh this job
 *       404:
 *         description: Import job not found
 */
/**
 * POST /api/spotify/import/:jobId/refresh
 * Re-match pending tracks and add newly downloaded ones to the playlist
 */
router.post("/import/:jobId/refresh", async (req, res) => {
    try {
        const { jobId } = req.params;
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });
        const userId = req.user.id;

        const job = await spotifyImportService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ error: "Import job not found" });
        }

        // Ensure user owns this job
        if (job.userId !== userId) {
            return res
                .status(403)
                .json({ error: "Not authorized to refresh this job" });
        }

        const result = await spotifyImportService.refreshJobMatches(jobId);

        res.json({
            message:
                result.added > 0
                    ? `Added ${result.added} newly downloaded track(s)`
                    : "No new tracks found yet. Albums may still be downloading.",
            added: result.added,
            total: result.total,
        });
    } catch (error: any) {
        logger.error("Spotify refresh error:", error);
        res.status(500).json({
            error: error.message || "Failed to refresh tracks",
        });
    }
});

/**
 * @openapi
 * /api/spotify/import/{jobId}/cancel:
 *   post:
 *     summary: Cancel an import job and create playlist with whatever succeeded
 *     tags: [Spotify]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Import cancelled with partial playlist creation info
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Not authorized to cancel this job
 *       404:
 *         description: Import job not found
 */
/**
 * POST /api/spotify/import/:jobId/cancel
 * Cancel an import job and create playlist with whatever succeeded
 */
router.post("/import/:jobId/cancel", async (req, res) => {
    try {
        const { jobId } = req.params;
        const userId = req.user!.id;

        const job = await spotifyImportService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ error: "Import job not found" });
        }

        // Ensure user owns this job
        if (job.userId !== userId) {
            return res
                .status(403)
                .json({ error: "Not authorized to cancel this job" });
        }

        const result = await spotifyImportService.cancelJob(jobId);

        res.json({
            message: result.playlistCreated
                ? `Import cancelled. Playlist created with ${result.tracksMatched} track(s).`
                : "Import cancelled. No tracks were downloaded.",
            playlistId: result.playlistId,
            tracksMatched: result.tracksMatched,
        });
    } catch (error: any) {
        logger.error("Spotify cancel error:", error);
        res.status(500).json({
            error: error.message || "Failed to cancel import",
        });
    }
});

/**
 * @openapi
 * /api/spotify/import/session-log:
 *   get:
 *     summary: Get the current session log for debugging import issues
 *     tags: [Spotify]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Session log content and file path
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /api/spotify/import/session-log
 * Get the current session log for debugging import issues
 */
router.get("/import/session-log", async (req, res) => {
    try {
        const log = readSessionLog();
        const logPath = getSessionLogPath();

        res.json({
            path: logPath,
            content: log,
        });
    } catch (error: any) {
        logger.error("Session log error:", error);
        res.status(500).json({
            error: error.message || "Failed to read session log",
        });
    }
});

export default router;
