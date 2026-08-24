/**
 * YouTube Routes
 *
 * Exposes the sidecar's /yt/ endpoints to the frontend for regular YouTube
 * video streaming and downloading. All routes require session authentication
 * but do NOT require YouTube Music OAuth — they work with any YouTube URL.
 * Download endpoints (start/status/list/cancel) additionally require the
 * admin role, matching the app-wide admin-only download model; info and
 * streaming stay available to every authenticated user.
 *
 * Endpoints:
 * - GET  /api/youtube/info?url=   — Video metadata
 * - GET  /api/youtube/stream/:videoId — Proxied audio stream
 * - POST /api/youtube/download    — Start a background download job (202, admin)
 * - GET  /api/youtube/download/:jobId — Poll job status (admin); queues a
 *   library scan once when the job completes
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import {
    requireAuth,
    requireAuthOrToken,
    requireAdmin,
} from "../middleware/auth";
import {
    youtubeDownloadService,
    watchYouTubeDownloadJobUntilTerminal,
} from "../services/youtubeDownload";
import { requestCoalescedLibraryScan } from "../services/coalescedLibraryScan";
import { logger } from "../utils/logger";
import { sendRouteError } from "./routeErrorResponse";

const router = Router();
const downloadWatcherLogger = logger.child("YouTubeDownloadWatcher");

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
            return res.status(400).json({ error: err.issues[0].message });
        }
        if (err.response?.status === 400) {
            return res.status(400).json({
                error: err.response?.data?.detail || "Invalid YouTube URL",
            });
        }
        if (err.response?.status === 404) {
            return res.status(404).json({ error: "Video not found" });
        }
        logger.error("[YouTube Route] Info fetch failed:", err.message);
        return res.status(502).json({ error: "Failed to fetch video info" });
    }
});

// ── Playlist / Channel Enumeration ────────────────────────────────

const playlistInfoQuerySchema = z.object({
    url: z.string().min(1, "url is required"),
});

/**
 * @openapi
 * /api/youtube/playlist-info:
 *   get:
 *     summary: Enumerate a YouTube playlist or channel for bulk download
 *     description: >
 *       Returns a bounded, truncation-aware list of video entries the UI
 *       fans out into individual download jobs. Rejects single-video URLs
 *       and auto-generated radio/mix lists with 422.
 *     tags: [YouTube]
 *     parameters:
 *       - in: query
 *         name: url
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Playlist/channel entries (with truncated flag)
 *       400:
 *         description: Missing url
 *       422:
 *         description: URL is a single video or an un-enumerable mix/radio
 *       502:
 *         description: Sidecar unavailable
 */
router.get(
    "/playlist-info",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const { url } = playlistInfoQuerySchema.parse(req.query);
            const info = await youtubeDownloadService.getPlaylistInfo(url);
            return res.json(info);
        } catch (err: any) {
            if (err instanceof z.ZodError) {
                return res.status(400).json({ error: err.issues[0].message });
            }
            if (err.response?.status === 422) {
                return res.status(422).json({
                    error:
                        err.response?.data?.detail ||
                        "URL is not a downloadable playlist or channel",
                });
            }
            if (err.response?.status === 404) {
                return res
                    .status(404)
                    .json({ error: "Playlist or channel not found" });
            }
            logger.error(
                "[YouTube Route] Playlist info fetch failed:",
                err.message,
            );
            return res
                .status(502)
                .json({ error: "Failed to enumerate playlist or channel" });
        }
    },
);

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
    async (req: Request<{ videoId: string }>, res: Response) => {
        try {
            const { videoId } = req.params;
            const quality = (
                (req.query.quality as string) || "HIGH"
            ).toUpperCase();
            const rangeHeader = req.headers.range;

            const proxyRes = await youtubeDownloadService.getStreamProxy(
                videoId,
                quality,
                rangeHeader,
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
                    `[YouTube Route] Upstream stream error for ${videoId}: ${streamErr.message}`,
                );
                if (!res.headersSent) {
                    res.status(502).json({ error: "Upstream stream failed" });
                } else {
                    res.end();
                }
            });
            // Clean up upstream stream when client disconnects
            res.on("close", () => {
                if (
                    proxyRes.data &&
                    typeof proxyRes.data.destroy === "function" &&
                    !proxyRes.data.destroyed
                ) {
                    proxyRes.data.destroy();
                }
            });
            proxyRes.data.pipe(res);
        } catch (err: any) {
            if (err.response?.status === 404) {
                return res.status(404).json({ error: "Stream not found" });
            }
            if (err.response?.status === 451) {
                return sendRouteError(
                    res,
                    451,
                    "This content requires age verification and cannot be streamed.",
                );
            }
            logger.error("[YouTube Route] Stream proxy failed:", err.message);
            return res.status(500).json({ error: "Failed to stream audio" });
        }
    },
);

// ── Download ──────────────────────────────────────────────────────

/** Canonical 11-character YouTube video id (same format the frontend validates). */
const YOUTUBE_VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;

const downloadBodySchema = z.object({
    videoId: z
        .string()
        .regex(
            YOUTUBE_VIDEO_ID_REGEX,
            "videoId must be an 11-character YouTube video id",
        ),
    format: z.enum(["mp3", "opus", "flac", "m4a"]).default("mp3"),
    quality: z.enum(["LOW", "MEDIUM", "HIGH", "LOSSLESS"]).default("HIGH"),
    // Optional grouping label (playlist/channel title) for bulk runs.
    source: z.string().max(300).optional(),
    // Bulk source type. Only "channel" downloads are collapsed to a single
    // artist on import; "playlist" downloads keep each track's native artist.
    sourceKind: z.enum(["channel", "playlist"]).optional(),
});

/**
 * @openapi
 * /api/youtube/download:
 *   post:
 *     summary: Start a background YouTube audio download job (admin only)
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
 *       202:
 *         description: >
 *           Download job accepted. The backend watches the job server-side
 *           and queues a library scan when it completes (or immediately when
 *           the file already existed on disk); poll
 *           GET /api/youtube/download/{jobId} for UI progress.
 *       400:
 *         description: Invalid request body
 *       403:
 *         description: Authenticated but not an admin
 *       502:
 *         description: Sidecar unavailable or rejected the download
 */
router.post(
    "/download",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
        try {
            const { videoId, format, quality, source, sourceKind } =
                downloadBodySchema.parse(req.body);
            const userId = req.user!.id;

            logger.info(
                `[YouTube Route] Download requested: ${videoId} (${format}, ${quality})`,
            );

            const job = await youtubeDownloadService.startDownload(
                videoId,
                format,
                quality,
                source,
                sourceKind,
            );

            if (job.status === "completed") {
                // Idempotency hit — the file is already on disk, but it may
                // never have been imported (failed scan, out-of-band file), so
                // always queue a scan.
                await enqueueLibraryScanForDownloadJob(job.jobId, userId);
            } else {
                watchDownloadJobAndQueueScan(job.jobId, userId);
            }

            return res.status(202).json(job);
        } catch (err: any) {
            if (err instanceof z.ZodError) {
                return res.status(400).json({ error: err.issues[0].message });
            }
            if (err.response?.status === 400) {
                return res.status(400).json({
                    error:
                        err.response?.data?.detail ||
                        "Invalid download request",
                });
            }
            logger.error("[YouTube Route] Download start failed:", err.message);
            return res.status(502).json({
                error: err.response?.data?.detail || "Download failed",
            });
        }
    },
);

// Jobs that have already triggered a library scan, so the server-side
// watcher and repeated status polls enqueue the scan exactly once per job.
// In-memory is fine: jobs themselves are in-memory on the sidecar and lost
// together on restart.
const scannedDownloadJobIds = new Set<string>();

/**
 * Upper bound on remembered download-job ids. The sidecar prunes terminal
 * jobs after 6h, so anything still referenced by a poll fits comfortably
 * within this window; oldest ids are evicted first (insertion order).
 */
const MAX_SCANNED_DOWNLOAD_JOB_IDS = 1000;

interface ActiveDownloadWatcher {
    sleepTimer: ReturnType<typeof setTimeout> | null;
}

/** Maximum concurrent server-side download watchers retained by this module. */
const MAX_ACTIVE_DOWNLOAD_WATCHERS = 1000;

/** Active server-side download watchers, keyed by sidecar job id. */
const activeDownloadWatchers = new Map<string, ActiveDownloadWatcher>();

/**
 * Remember `jobId` in `seen`, evicting the oldest remembered ids (Sets
 * iterate in insertion order) once `maxSize` is exceeded, so the dedupe set
 * cannot grow without bound over the process lifetime.
 */
export function rememberBoundedJobId(
    seen: Set<string>,
    jobId: string,
    maxSize: number,
): void {
    seen.add(jobId);
    while (seen.size > maxSize) {
        const oldest = seen.values().next().value;
        if (oldest === undefined) {
            break;
        }
        seen.delete(oldest);
    }
}

/**
 * Queue a (coalesced) library scan for a completed download job exactly
 * once. Removes the job from the dedupe set again when the enqueue fails so
 * a later caller (watcher retry or status poll) can try again.
 */
async function enqueueLibraryScanForDownloadJob(
    jobId: string,
    userId: string,
): Promise<void> {
    if (scannedDownloadJobIds.has(jobId)) {
        return;
    }
    rememberBoundedJobId(
        scannedDownloadJobIds,
        jobId,
        MAX_SCANNED_DOWNLOAD_JOB_IDS,
    );
    try {
        await requestCoalescedLibraryScan(userId, "youtube-download");
        logger.debug(
            `[YouTube Route] Library scan requested after download job ${jobId}`,
        );
    } catch (scanErr: any) {
        // Allow a later watcher tick / status poll to retry the enqueue.
        scannedDownloadJobIds.delete(jobId);
        logger.warn(
            `[YouTube Route] Failed to queue library scan: ${scanErr.message}`,
        );
    }
}

/**
 * Fire-and-forget server-side watch of a download job. Guarantees the
 * library scan fires on completion even when the browser that started the
 * download stopped polling (navigation, tab close) — important for
 * multi-hour downloads.
 */
function watchDownloadJobAndQueueScan(jobId: string, userId: string): void {
    if (activeDownloadWatchers.has(jobId)) {
        return;
    }
    if (activeDownloadWatchers.size >= MAX_ACTIVE_DOWNLOAD_WATCHERS) {
        downloadWatcherLogger.warn("Active watcher registry is full", {
            jobId,
            maxWatchers: MAX_ACTIVE_DOWNLOAD_WATCHERS,
        });
        return;
    }

    const watcher: ActiveDownloadWatcher = { sleepTimer: null };
    activeDownloadWatchers.set(jobId, watcher);
    void runDownloadWatcher(jobId, userId, watcher);
}

/** Run one registered watcher and always release its timer and registry slot. */
async function runDownloadWatcher(
    jobId: string,
    userId: string,
    watcher: ActiveDownloadWatcher,
): Promise<void> {
    try {
        const outcome = await watchYouTubeDownloadJobUntilTerminal(
            jobId,
            (id) => youtubeDownloadService.getDownloadJobStatus(id),
            { sleep: createWatcherSleep(watcher) },
        );
        if (outcome === "completed") {
            await enqueueLibraryScanForDownloadJob(jobId, userId);
        }
    } catch (watchErr: unknown) {
        downloadWatcherLogger.warn("Download job watcher crashed", {
            jobId,
            error: watchErr,
        });
    } finally {
        clearWatcherSleep(watcher);
        if (activeDownloadWatchers.get(jobId) === watcher) {
            activeDownloadWatchers.delete(jobId);
        }
    }
}

/** Create a sequential polling delay owned by one registered watcher. */
function createWatcherSleep(
    watcher: ActiveDownloadWatcher,
): (delayMs: number) => Promise<void> {
    return (delayMs) =>
        new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                if (watcher.sleepTimer === timer) {
                    watcher.sleepTimer = null;
                }
                resolve();
            }, delayMs);
            watcher.sleepTimer = timer;
            timer.unref?.();
        });
}

/** Clear the pending delay, if the watcher is settling before it fires. */
function clearWatcherSleep(watcher: ActiveDownloadWatcher): void {
    if (watcher.sleepTimer === null) {
        return;
    }
    clearTimeout(watcher.sleepTimer);
    watcher.sleepTimer = null;
}

/**
 * @openapi
 * /api/youtube/download/{jobId}:
 *   get:
 *     summary: Get YouTube download job status (admin only)
 *     description: >
 *       Proxies the sidecar's job store for UI progress. The library scan
 *       is normally queued by the server-side job watcher; as a fallback
 *       (e.g. after a backend restart mid-download), a poll that observes
 *       the job as completed also queues the scan (once per job).
 *     tags: [YouTube]
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Job status (queued, downloading, processing, completed, failed)
 *       403:
 *         description: Authenticated but not an admin
 *       404:
 *         description: Unknown job id (e.g. sidecar restarted)
 *       502:
 *         description: Sidecar unavailable
 */
router.get(
    "/download/:jobId",
    requireAuth,
    requireAdmin,
    async (req: Request<{ jobId: string }>, res: Response) => {
        try {
            const { jobId } = req.params;
            const job =
                await youtubeDownloadService.getDownloadJobStatus(jobId);

            if (job.status === "completed") {
                await enqueueLibraryScanForDownloadJob(job.jobId, req.user!.id);
            }

            return res.json(job);
        } catch (err: any) {
            if (err.response?.status === 404) {
                return res
                    .status(404)
                    .json({ error: "Download job not found" });
            }
            logger.error(
                "[YouTube Route] Download status fetch failed:",
                err.message,
            );
            return res
                .status(502)
                .json({ error: "Failed to fetch download status" });
        }
    },
);

// ── Downloads view (list + cancel) ────────────────────────────────

/**
 * @openapi
 * /api/youtube/downloads:
 *   get:
 *     summary: List YouTube download jobs (active + recent) for the UI (admin only)
 *     tags: [YouTube]
 *     responses:
 *       200:
 *         description: Array of download jobs (newest first)
 *       403:
 *         description: Authenticated but not an admin
 *       502:
 *         description: Sidecar unavailable
 */
router.get(
    "/downloads",
    requireAuth,
    requireAdmin,
    async (_req: Request, res: Response) => {
        try {
            const jobs = await youtubeDownloadService.listDownloads();
            return res.json({ jobs });
        } catch (err: any) {
            logger.error("[YouTube Route] Downloads list failed:", err.message);
            return res.status(502).json({ error: "Failed to list downloads" });
        }
    },
);

/**
 * @openapi
 * /api/youtube/downloads/{jobId}:
 *   delete:
 *     summary: Cancel a YouTube download job (admin only)
 *     tags: [YouTube]
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Updated job (cancelled / cancel requested)
 *       403:
 *         description: Authenticated but not an admin
 *       404:
 *         description: Unknown job id
 *       502:
 *         description: Sidecar unavailable
 */
router.delete(
    "/downloads/:jobId",
    requireAuth,
    requireAdmin,
    async (req: Request<{ jobId: string }>, res: Response) => {
        try {
            const { jobId } = req.params;
            const job = await youtubeDownloadService.cancelDownload(jobId);
            return res.json(job);
        } catch (err: any) {
            if (err.response?.status === 404) {
                return res
                    .status(404)
                    .json({ error: "Download job not found" });
            }
            logger.error(
                "[YouTube Route] Download cancel failed:",
                err.message,
            );
            return res.status(502).json({ error: "Failed to cancel download" });
        }
    },
);

export default router;
