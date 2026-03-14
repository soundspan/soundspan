import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { playlistImportService } from "../services/playlistImportService";
import { importJobStore } from "../services/importJobStore";
import { genericImportJobRunner } from "../services/genericImportJobRunner";
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

const submitJobSchema = z.object({
    url: z.string().url(),
    name: z.string().min(1).max(200).optional(),
});

const reconnectJobSchema = z.object({
    url: z.string().url(),
});

const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

function buildNormalizedSource(sourceType: string, sourceId: string): string {
    return `${sourceType.trim().toLowerCase()}:${sourceId.trim()}`;
}

function toDefaultPlaylistName(sourceType: string): string {
    const normalized = sourceType.trim().toLowerCase();
    return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)} import`;
}

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
/**
 * @openapi
 * /api/import/jobs:
 *   post:
 *     summary: Submit a background generic import job for a provider URL
 *     tags: [Import]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: Existing active job returned for duplicate source submissions
 *       202:
 *         description: New generic import job created
 */
router.post(
    "/jobs",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const parsed = submitJobSchema.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({ error: "Valid playlist URL is required" });
            }

            const parsedSource = playlistImportService.parseSourceUrl(parsed.data.url);
            if (!parsedSource) {
                return res.status(400).json({ error: "Unsupported playlist URL" });
            }

            const userId = req.user!.id;
            const normalizedSource = buildNormalizedSource(
                parsedSource.source,
                parsedSource.id
            );
            const existingJob = await importJobStore.findActiveJobForSource(
                userId,
                normalizedSource
            );

            if (existingJob) {
                return res.status(200).json({
                    deduped: true,
                    job: existingJob,
                });
            }

            const job = await importJobStore.createJob({
                userId,
                sourceType: parsedSource.source,
                sourceId: parsedSource.id,
                sourceUrl: parsed.data.url,
                playlistName: toDefaultPlaylistName(parsedSource.source),
                requestedPlaylistName: parsed.data.name,
                status: "pending",
                progress: 0,
                summary: {
                    total: 0,
                    local: 0,
                    youtube: 0,
                    tidal: 0,
                    unresolved: 0,
                },
            });

            genericImportJobRunner.enqueue(job.id);

            res.status(202).json({
                deduped: false,
                job,
            });
        } catch (err) {
            logger.error("[Import] Job submit failed:", err);
            res.status(500).json({ error: "Failed to submit import job" });
        }
    }
);

/**
 * @openapi
 * /api/import/jobs:
 *   get:
 *     summary: List generic import jobs for the current user
 *     tags: [Import]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: User-scoped import jobs
 */
router.get(
    "/jobs",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const jobs = await importJobStore.listJobsForUser(req.user!.id);
            res.json({ jobs });
        } catch (err) {
            logger.error("[Import] Job list failed:", err);
            res.status(500).json({ error: "Failed to list import jobs" });
        }
    }
);

/**
 * @openapi
 * /api/import/jobs/{jobId}:
 *   get:
 *     summary: Get a generic import job by id
 *     tags: [Import]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: Job status payload
 *       403:
 *         description: Not authorized to view this job
 *       404:
 *         description: Import job not found
 */
router.get(
    "/jobs/:jobId",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const job = await importJobStore.getJob(req.params.jobId);
            if (!job) {
                return res.status(404).json({ error: "Import job not found" });
            }
            if (job.userId !== req.user!.id) {
                return res
                    .status(403)
                    .json({ error: "Not authorized to view this import job" });
            }

            res.json({ job });
        } catch (err) {
            logger.error("[Import] Job status failed:", err);
            res.status(500).json({ error: "Failed to load import job" });
        }
    }
);

/**
 * @openapi
 * /api/import/jobs/reconnect:
 *   post:
 *     summary: Reconnect to an active generic import job by source URL
 *     tags: [Import]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: Active generic import job
 *       404:
 *         description: No active job found for source
 */
router.post(
    "/jobs/reconnect",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const parsed = reconnectJobSchema.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({ error: "Valid playlist URL is required" });
            }

            const parsedSource = playlistImportService.parseSourceUrl(parsed.data.url);
            if (!parsedSource) {
                return res.status(400).json({ error: "Unsupported playlist URL" });
            }

            const normalizedSource = buildNormalizedSource(
                parsedSource.source,
                parsedSource.id
            );
            const job = await importJobStore.findActiveJobForSource(
                req.user!.id,
                normalizedSource
            );

            if (!job) {
                return res
                    .status(404)
                    .json({ error: "No active import job found for source" });
            }

            res.json({ job });
        } catch (err) {
            logger.error("[Import] Job reconnect failed:", err);
            res.status(500).json({ error: "Failed to reconnect import job" });
        }
    }
);

/**
 * @openapi
 * /api/import/jobs/{jobId}/cancel:
 *   post:
 *     summary: Cancel an active generic import job
 *     tags: [Import]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: Cancelled job payload
 *       403:
 *         description: Not authorized to cancel this job
 *       404:
 *         description: Import job not found
 *       409:
 *         description: Job already terminal
 */
router.post(
    "/jobs/:jobId/cancel",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const job = await importJobStore.getJob(req.params.jobId);
            if (!job) {
                return res.status(404).json({ error: "Import job not found" });
            }
            if (job.userId !== req.user!.id) {
                return res
                    .status(403)
                    .json({ error: "Not authorized to cancel this import job" });
            }
            if (TERMINAL_JOB_STATUSES.has(job.status)) {
                return res.status(409).json({
                    error: `Import job already ${job.status}`,
                });
            }

            const cancelledJob = await importJobStore.updateJob(job.id, {
                status: "cancelling",
                error: "Cancelled by user",
            });
            res.json({ job: cancelledJob });
        } catch (err) {
            logger.error("[Import] Job cancel failed:", err);
            res.status(500).json({ error: "Failed to cancel import job" });
        }
    }
);

const m3uPreviewSchema = z.object({
    name: z.string().min(1).max(200).optional(),
    content: z.string().min(1),
});

const M3U_CONTENT_MAX_BYTES = 2_000_000;

/**
 * @openapi
 * /api/import/m3u/preview:
 *   post:
 *     summary: Preview an M3U/M3U8 playlist file import against the local library
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
 *               - content
 *             properties:
 *               name:
 *                 type: string
 *                 description: Playlist name (defaults to "M3U import")
 *               content:
 *                 type: string
 *                 description: Raw M3U/M3U8 file content
 *     responses:
 *       200:
 *         description: Track resolution preview with local-library matching
 *       400:
 *         description: Invalid or missing content
 *       401:
 *         description: Not authenticated
 */
router.post(
    "/m3u/preview",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const parsed = m3uPreviewSchema.safeParse(req.body);
            if (!parsed.success) {
                return res
                    .status(400)
                    .json({ error: "Playlist file content is required" });
            }

            if (parsed.data.content.length > M3U_CONTENT_MAX_BYTES) {
                return res
                    .status(400)
                    .json({ error: "Playlist file content is too large" });
            }

            const playlistName = parsed.data.name || "M3U import";
            const result = await playlistImportService.previewM3UImport(
                playlistName,
                parsed.data.content
            );
            res.json(result);
        } catch (err: any) {
            logger.error("[Import] M3U preview failed:", err);
            res.status(500).json({ error: "Failed to preview M3U import" });
        }
    }
);

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
