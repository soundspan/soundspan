/**
 * YouTube Routes
 *
 * Exposes the sidecar's /yt/ endpoints to the frontend for regular YouTube
 * video streaming and downloading. All routes require session authentication
 * but do NOT require YouTube Music OAuth — they work with any YouTube URL.
 *
 * Endpoints:
 * - GET  /api/youtube/info?url=   — Video metadata
 * - GET  /api/youtube/stream/:videoId — Proxied audio stream
 * - POST /api/youtube/download    — Download audio to disk + scan into library
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requireAuthOrToken } from "../middleware/auth";
import { youtubeDownloadService } from "../services/youtubeDownload";
import { logger } from "../utils/logger";

const router = Router();

// ── Video Info ────────────────────────────────────────────────────

const infoQuerySchema = z.object({
    url: z.string().min(1, "url is required"),
});

/**
 * @openapi
 * /api/youtube/info:
 *   get:
 *     summary: Get YouTube video metadata
 *     tags: [YouTube]
 *     parameters:
 *       - in: query
 *         name: url
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Video metadata
 */
router.get("/info", requireAuth, async (req: Request, res: Response) => {
    try {
        const { url } = infoQuerySchema.parse(req.query);
        const info = await youtubeDownloadService.getVideoInfo(url);
        return res.json(info);
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ error: err.errors[0].message });
        }
        if (err.response?.status === 400) {
            return res
                .status(400)
                .json({ error: err.response?.data?.detail || "Invalid YouTube URL" });
        }
        if (err.response?.status === 404) {
            return res.status(404).json({ error: "Video not found" });
        }
        logger.error("[YouTube Route] Info fetch failed:", err.message);
        return res.status(502).json({ error: "Failed to fetch video info" });
    }
});

// ── Audio Stream Proxy ────────────────────────────────────────────

/**
 * @openapi
 * /api/youtube/stream/{videoId}:
 *   get:
 *     summary: Stream audio from a YouTube video
 *     tags: [YouTube]
 *     parameters:
 *       - in: path
 *         name: videoId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: quality
 *         schema:
 *           type: string
 *           enum: [LOW, MEDIUM, HIGH, LOSSLESS]
 *     responses:
 *       200:
 *         description: Audio stream
 *       206:
 *         description: Partial content (Range request)
 */
router.get(
    "/stream/:videoId",
    requireAuthOrToken,
    async (req: Request, res: Response) => {
        try {
            const { videoId } = req.params;
            const quality = (
                (req.query.quality as string) || "HIGH"
            ).toUpperCase();
            const rangeHeader = req.headers.range;

            const proxyRes = await youtubeDownloadService.getStreamProxy(
                videoId,
                quality,
                rangeHeader
            );

            // Forward status code and relevant headers
            res.status(proxyRes.status);

            const forwardHeaders = [
                "content-type",
                "content-length",
                "content-range",
                "accept-ranges",
            ];
            for (const header of forwardHeaders) {
                const value = proxyRes.headers[header];
                if (value) res.setHeader(header, value);
            }

            proxyRes.data.on("error", (streamErr: Error) => {
                logger.warn(
                    `[YouTube Route] Upstream stream error for ${videoId}: ${streamErr.message}`
                );
                if (!res.headersSent) {
                    res.status(502).json({ error: "Upstream stream failed" });
                } else {
                    res.end();
                }
            });
            proxyRes.data.pipe(res);
        } catch (err: any) {
            if (err.response?.status === 404) {
                return res.status(404).json({ error: "Stream not found" });
            }
            if (err.response?.status === 451) {
                return res.status(451).json({
                    error: "age_restricted",
                    message:
                        "This content requires age verification and cannot be streamed.",
                });
            }
            logger.error("[YouTube Route] Stream proxy failed:", err.message);
            return res.status(500).json({ error: "Failed to stream audio" });
        }
    }
);

// ── Download ──────────────────────────────────────────────────────

const downloadBodySchema = z.object({
    videoId: z.string().min(1),
    format: z.enum(["mp3", "opus", "flac", "m4a"]).default("mp3"),
    quality: z.enum(["LOW", "MEDIUM", "HIGH", "LOSSLESS"]).default("HIGH"),
});

/**
 * @openapi
 * /api/youtube/download:
 *   post:
 *     summary: Download YouTube audio to library
 *     tags: [YouTube]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               videoId:
 *                 type: string
 *               format:
 *                 type: string
 *                 enum: [mp3, opus, flac, m4a]
 *               quality:
 *                 type: string
 *                 enum: [LOW, MEDIUM, HIGH, LOSSLESS]
 *     responses:
 *       200:
 *         description: Download result with file path and track info
 */
router.post("/download", requireAuth, async (req: Request, res: Response) => {
    try {
        const { videoId, format, quality } = downloadBodySchema.parse(req.body);

        logger.info(
            `[YouTube Route] Download requested: ${videoId} (${format}, ${quality})`
        );

        const result = await youtubeDownloadService.downloadVideo(
            videoId,
            format,
            quality
        );

        if (!result.success) {
            return res.status(502).json({ error: "Download failed" });
        }

        // Trigger a library scan so the downloaded file appears in the library.
        // We do this asynchronously — the download response returns immediately.
        try {
            const { scanQueue } = await import("../workers/queues");
            const { prisma } = await import("../utils/db");

            const user = req.user?.id
                ? { id: req.user.id }
                : await prisma.user.findFirst();

            if (user) {
                await scanQueue.add("scan", {
                    userId: user.id,
                    source: "youtube-download",
                });
                logger.debug(
                    `[YouTube Route] Library scan queued after download of ${videoId}`
                );
            }
        } catch (scanErr: any) {
            logger.warn(
                `[YouTube Route] Failed to queue library scan: ${scanErr.message}`
            );
        }

        return res.json(result);
    } catch (err: any) {
        if (err instanceof z.ZodError) {
            return res.status(400).json({ error: err.errors[0].message });
        }
        logger.error("[YouTube Route] Download failed:", err.message);
        return res
            .status(502)
            .json({ error: err.response?.data?.detail || "Download failed" });
    }
});

export default router;
