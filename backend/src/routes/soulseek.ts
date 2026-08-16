import { logger } from "../utils/logger";

/**
 * Soulseek routes - Direct connection via slsk-client
 * Supports both general searches (for UI) and track-specific searches (for downloads)
 */

import { Router, type Response } from "express";
import { requireAdmin, requireAuth } from "../middleware/auth";
import {
    soulseekService,
    SearchResult,
    SearchTrackResult,
} from "../services/soulseek";
import { getSystemSettings } from "../utils/systemSettings";
import { randomUUID } from "crypto";
import { sendRouteError } from "./routeErrorResponse";

const router = Router();
const searchLog = logger.child("SoulseekUiSearch");

const UI_SEARCH_TIMEOUT_MS = 15_000;
const SEARCH_RATE_WINDOW_MS = 60_000;
const MAX_SEARCHES_PER_USER_PER_WINDOW = 10;
const MAX_GLOBAL_SEARCHES_PER_WINDOW = 60;
const MAX_CONCURRENT_SEARCHES = 4;
const MAX_CONCURRENT_SEARCHES_PER_USER = 2;
const MAX_QUEUED_SEARCHES = 20;
const MAX_QUEUED_SEARCHES_PER_USER = 4;
const MAX_SEARCH_SESSIONS = 100;
const MAX_RESULTS_PER_SESSION = 100;
const MAX_TRACKED_RATE_USERS = 256;

// In-memory store for search results (with TTL cleanup)
interface SearchSession {
    query: string;
    results: SearchResult[];
    createdAt: Date;
    userId: string;
}

interface SearchJob {
    searchId: string;
    query: string;
    userId: string;
}

interface RateWindow {
    count: number;
    startedAt: number;
}

const searchSessions = new Map<string, SearchSession>();
const searchQueue: SearchJob[] = [];
const activeSearchesByUser = new Map<string, number>();
const queuedSearchesByUser = new Map<string, number>();
const userRateWindows = new Map<string, RateWindow>();
const globalRateWindow: RateWindow = { count: 0, startedAt: Date.now() };
let activeSearches = 0;
const SEARCH_SESSION_TTL = 5 * 60 * 1000; // 5 minutes

function cleanupExpiredSearchSessions(now: number): void {
    let inspected = 0;
    for (const [searchId, session] of searchSessions.entries()) {
        if (inspected >= MAX_SEARCH_SESSIONS) break;
        inspected += 1;
        if (now - session.createdAt.getTime() > SEARCH_SESSION_TTL) {
            searchSessions.delete(searchId);
        }
    }
}

function removeOldestSearchSession(): void {
    const oldestSearchId = searchSessions.keys().next().value;
    if (typeof oldestSearchId === "string") {
        searchSessions.delete(oldestSearchId);
    }
}

function storeSearchSession(
    searchId: string,
    query: string,
    userId: string,
): void {
    cleanupExpiredSearchSessions(Date.now());
    if (searchSessions.size >= MAX_SEARCH_SESSIONS) {
        removeOldestSearchSession();
    }
    searchSessions.set(searchId, {
        query,
        results: [],
        createdAt: new Date(),
        userId,
    });
}

// Cleanup old search sessions every minute
const searchSessionCleanupTimer = setInterval(() => {
    cleanupExpiredSearchSessions(Date.now());
}, 60000);
searchSessionCleanupTimer.unref?.();

function refreshRateWindow(window: RateWindow, now: number): void {
    if (now - window.startedAt >= SEARCH_RATE_WINDOW_MS) {
        window.count = 0;
        window.startedAt = now;
    }
}

function getUserRateWindow(userId: string, now: number): RateWindow {
    const existing = userRateWindows.get(userId);
    if (existing) {
        refreshRateWindow(existing, now);
        userRateWindows.delete(userId);
        userRateWindows.set(userId, existing);
        return existing;
    }
    if (userRateWindows.size >= MAX_TRACKED_RATE_USERS) {
        const oldestUserId = userRateWindows.keys().next().value;
        if (typeof oldestUserId === "string")
            userRateWindows.delete(oldestUserId);
    }
    const created = { count: 0, startedAt: now };
    userRateWindows.set(userId, created);
    return created;
}

function getRateLimitRetryAfter(userId: string, now: number): number | null {
    refreshRateWindow(globalRateWindow, now);
    if (globalRateWindow.count >= MAX_GLOBAL_SEARCHES_PER_WINDOW) {
        return globalRateWindow.startedAt + SEARCH_RATE_WINDOW_MS - now;
    }
    const userWindow = getUserRateWindow(userId, now);
    if (userWindow.count >= MAX_SEARCHES_PER_USER_PER_WINDOW) {
        return userWindow.startedAt + SEARCH_RATE_WINDOW_MS - now;
    }
    return null;
}

function recordRateAdmission(userId: string, now: number): void {
    refreshRateWindow(globalRateWindow, now);
    globalRateWindow.count += 1;
    getUserRateWindow(userId, now).count += 1;
}

function canStartSearch(userId: string): boolean {
    return (
        activeSearches < MAX_CONCURRENT_SEARCHES &&
        (activeSearchesByUser.get(userId) ?? 0) <
            MAX_CONCURRENT_SEARCHES_PER_USER
    );
}

function canQueueSearch(userId: string): boolean {
    return (
        searchQueue.length < MAX_QUEUED_SEARCHES &&
        (queuedSearchesByUser.get(userId) ?? 0) < MAX_QUEUED_SEARCHES_PER_USER
    );
}

function changeUserCount(
    counts: Map<string, number>,
    userId: string,
    delta: 1 | -1,
): void {
    const next = (counts.get(userId) ?? 0) + delta;
    if (next <= 0) {
        counts.delete(userId);
        return;
    }
    counts.set(userId, next);
}

function enqueueSearch(job: SearchJob): void {
    searchQueue.push(job);
    changeUserCount(queuedSearchesByUser, job.userId, 1);
}

function dequeueSearch(): SearchJob | undefined {
    const job = searchQueue.shift();
    if (job) changeUserCount(queuedSearchesByUser, job.userId, -1);
    return job;
}

function retainSearchResults(job: SearchJob, result: SearchTrackResult): void {
    const session = searchSessions.get(job.searchId);
    if (!session || !result.found || !Array.isArray(result.allMatches)) return;
    session.results = result.allMatches
        .slice(0, MAX_RESULTS_PER_SESSION)
        .map((match) => ({
            user: match.username,
            file: match.fullPath,
            size: match.size,
            slots: true,
            bitrate: match.bitRate,
            speed: 0,
        }));
    searchLog.debug("UI search completed", {
        resultCount: session.results.length,
        searchId: job.searchId,
        userId: job.userId,
    });
}

async function runSearch(job: SearchJob): Promise<void> {
    try {
        const result = await soulseekService.searchTrack(
            job.query,
            "",
            false,
            UI_SEARCH_TIMEOUT_MS,
        );
        retainSearchResults(job, result);
    } catch (error) {
        searchLog.error("UI search failed", {
            error,
            searchId: job.searchId,
            userId: job.userId,
        });
    } finally {
        finishSearch(job);
    }
}

function startSearch(job: SearchJob): void {
    activeSearches += 1;
    changeUserCount(activeSearchesByUser, job.userId, 1);
    void runSearch(job).catch((error) => {
        searchLog.error("UI search supervisor failed", {
            error,
            searchId: job.searchId,
            userId: job.userId,
        });
    });
}

function drainSearchQueue(): void {
    const jobsToInspect = Math.min(searchQueue.length, MAX_QUEUED_SEARCHES);
    for (let index = 0; index < jobsToInspect; index += 1) {
        if (activeSearches >= MAX_CONCURRENT_SEARCHES) break;
        const job = dequeueSearch();
        if (!job) break;
        if (!searchSessions.has(job.searchId)) continue;
        if (!canStartSearch(job.userId)) {
            enqueueSearch(job);
            continue;
        }
        startSearch(job);
    }
}

function finishSearch(job: SearchJob): void {
    activeSearches = Math.max(0, activeSearches - 1);
    changeUserCount(activeSearchesByUser, job.userId, -1);
    drainSearchQueue();
}

function admitSearch(job: SearchJob): boolean {
    if (canStartSearch(job.userId)) {
        startSearch(job);
        return true;
    }
    if (!canQueueSearch(job.userId)) return false;
    enqueueSearch(job);
    return true;
}

function sendRateLimitError(res: Response, retryAfterMs: number): Response {
    const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    res.setHeader("Retry-After", String(retryAfterSeconds));
    return sendRouteError(
        res,
        429,
        "Too many Soulseek searches. Please try again later.",
    );
}

function sendCapacityError(res: Response): Response {
    res.setHeader("Retry-After", String(UI_SEARCH_TIMEOUT_MS / 1000));
    return sendRouteError(
        res,
        503,
        "Soulseek search capacity is full. Please try again later.",
    );
}

// Middleware to check if Soulseek credentials are configured
async function requireSoulseekConfigured(req: any, res: any, next: any) {
    try {
        const available = await soulseekService.isAvailable();

        if (!available) {
            return res.status(403).json({
                error: "Soulseek credentials not configured. Add username/password in System Settings.",
            });
        }

        next();
    } catch (error) {
        logger.error("Error checking Soulseek settings:", error);
        res.status(500).json({ error: "Failed to check settings" });
    }
}

/**
 * @openapi
 * /api/soulseek/status:
 *   get:
 *     summary: Check Soulseek connection status
 *     tags: [Soulseek]
 *     responses:
 *       200:
 *         description: Soulseek connection status including enabled, connected, and username
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /soulseek/status
 * Check connection status
 */
router.get("/status", requireAuth, async (req, res) => {
    try {
        const available = await soulseekService.isAvailable();

        if (!available) {
            return res.json({
                enabled: false,
                connected: false,
                message: "Soulseek credentials not configured",
            });
        }

        const status = await soulseekService.getStatus();

        res.json({
            enabled: true,
            connected: status.connected,
            username: status.username,
        });
    } catch (error: any) {
        logger.error("Soulseek status error:", error.message);
        res.status(500).json({
            error: "Failed to get Soulseek status",
        });
    }
});

/**
 * @openapi
 * /api/soulseek/connect:
 *   post:
 *     summary: Manually trigger connection to the Soulseek network
 *     tags: [Soulseek]
 *     responses:
 *       200:
 *         description: Successfully connected to Soulseek network
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Soulseek credentials not configured
 */
/**
 * POST /soulseek/connect
 * Manually trigger connection to Soulseek network
 */
router.post(
    "/connect",
    requireAuth,
    requireSoulseekConfigured,
    async (req, res) => {
        try {
            await soulseekService.connect();

            res.json({
                success: true,
                message: "Connected to Soulseek network",
            });
        } catch (error: any) {
            logger.error("Soulseek connect error:", error.message);
            res.status(500).json({
                error: "Failed to connect to Soulseek",
            });
        }
    },
);

/**
 * @openapi
 * /api/soulseek/search:
 *   post:
 *     summary: Start an async Soulseek search for files
 *     tags: [Soulseek]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               query:
 *                 type: string
 *                 description: Freeform search query
 *               artist:
 *                 type: string
 *                 description: Artist name (used with title for track-specific search)
 *               title:
 *                 type: string
 *                 description: Track title (used with artist for track-specific search)
 *     responses:
 *       200:
 *         description: Search accepted; returns searchId for polling results
 *       400:
 *         description: Missing query or artist/title parameters
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Soulseek credentials not configured
 *       429:
 *         description: Per-user or global search rate limit exceeded
 *       503:
 *         description: Search concurrency queue is at capacity
 */
/**
 * POST /soulseek/search
 * General search - supports both freeform queries and track-specific searches
 * Returns a searchId for polling results (async pattern)
 */
router.post(
    "/search",
    requireAuth,
    requireSoulseekConfigured,
    async (req, res) => {
        try {
            const { query, artist, title } = req.body;

            // Support both query formats for backward compatibility
            let searchQuery: string;

            if (query) {
                // General search (from UI search bar)
                searchQuery = query;
            } else if (artist && title) {
                // Track-specific search (for downloads)
                searchQuery = `${artist} ${title}`;
            } else {
                return res.status(400).json({
                    error: "Either 'query' or both 'artist' and 'title' are required",
                });
            }

            const userId = req.user?.id;
            if (!userId) {
                return sendRouteError(res, 401, "Not authenticated");
            }

            const now = Date.now();
            const retryAfterMs = getRateLimitRetryAfter(userId, now);
            if (retryAfterMs !== null) {
                searchLog.warn("UI search rate limit exceeded", { userId });
                return sendRateLimitError(res, retryAfterMs);
            }

            const job = { searchId: randomUUID(), query: searchQuery, userId };
            if (!canStartSearch(userId) && !canQueueSearch(userId)) {
                searchLog.warn("UI search capacity exhausted", { userId });
                return sendCapacityError(res);
            }

            storeSearchSession(job.searchId, searchQuery, userId);
            recordRateAdmission(userId, now);
            if (!admitSearch(job)) {
                searchSessions.delete(job.searchId);
                return sendCapacityError(res);
            }

            res.json({
                searchId: job.searchId,
                message: "Search started",
            });
        } catch (error) {
            searchLog.error("UI search admission failed", {
                error,
            });
            return sendRouteError(res, 500, "Search failed");
        }
    },
);

/**
 * @openapi
 * /api/soulseek/search/{searchId}:
 *   get:
 *     summary: Get results for an ongoing Soulseek search
 *     tags: [Soulseek]
 *     parameters:
 *       - in: path
 *         name: searchId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Search results with file metadata
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Search not found or expired
 */
/**
 * GET /soulseek/search/:searchId
 * Get results for an ongoing search
 */
router.get<{ searchId: string }>(
    "/search/:searchId",
    requireAuth,
    async (req, res) => {
        try {
            const { searchId } = req.params;
            const session = searchSessions.get(searchId);

            if (!session) {
                return res.status(404).json({
                    error: "Search not found or expired",
                    results: [],
                    count: 0,
                });
            }

            if (session.userId !== req.user!.id) {
                return res.status(404).json({
                    error: "Search not found or expired",
                    results: [],
                    count: 0,
                });
            }

            // Format results for frontend
            const formattedResults = session.results.map((r) => {
                const filename = r.file.split(/[/\\]/).pop() || r.file;
                const format = filename.toLowerCase().endsWith(".flac")
                    ? "flac"
                    : "mp3";

                // Try to parse artist and album from path
                const pathParts = r.file.split(/[/\\]/);
                const parsedArtist =
                    pathParts.length > 2
                        ? pathParts[pathParts.length - 3]
                        : undefined;
                const parsedAlbum =
                    pathParts.length > 1
                        ? pathParts[pathParts.length - 2]
                        : undefined;

                // Extract title from filename: strip extension, track number prefix, and leading dash/space
                const nameWithoutExt = filename.replace(/\.[^.]+$/, "");
                const parsedTitle =
                    nameWithoutExt
                        .replace(/^\d+[\s.\-_]*/, "") // Remove leading track number
                        .replace(/^\s*-\s*/, "") // Remove leading dash
                        .trim() || undefined;

                return {
                    username: r.user,
                    path: r.file,
                    filename,
                    size: r.size,
                    bitrate: r.bitrate || 0,
                    format,
                    parsedArtist,
                    parsedAlbum,
                    parsedTitle,
                };
            });

            res.json({
                results: formattedResults,
                count: formattedResults.length,
            });
        } catch (error: any) {
            logger.error("Get search results error:", error.message);
            res.status(500).json({
                error: "Failed to get results",
            });
        }
    },
);

/**
 * @openapi
 * /api/soulseek/download:
 *   post:
 *     summary: Download a track from Soulseek (admin only)
 *     tags: [Soulseek]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               artist:
 *                 type: string
 *               title:
 *                 type: string
 *               album:
 *                 type: string
 *               filepath:
 *                 type: string
 *               filename:
 *                 type: string
 *     responses:
 *       200:
 *         description: Download completed with file path
 *       400:
 *         description: Music path not configured
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Authenticated but not an admin, or Soulseek credentials not configured
 *       404:
 *         description: Download failed or file not found
 */
/**
 * POST /soulseek/download
 * Download a track directly
 */
router.post(
    "/download",
    requireAuth,
    requireAdmin,
    requireSoulseekConfigured,
    async (req, res) => {
        try {
            const { artist, title, album, filepath, filename } = req.body;

            // Derive artist/title from filename if not provided
            let resolvedArtist = artist;
            let resolvedTitle = title;

            if (!resolvedArtist || !resolvedTitle) {
                // Try to extract from filename (strip extension and track number)
                const name = (filename || filepath?.split(/[/\\]/).pop() || "")
                    .replace(/\.[^.]+$/, "")
                    .replace(/^\d+[\s.\-_]*/, "")
                    .trim();

                if (!resolvedTitle) resolvedTitle = name || "Unknown";
                if (!resolvedArtist) resolvedArtist = "Unknown";
                logger.warn(
                    `[Soulseek] Derived artist/title from filename: "${resolvedArtist}" - "${resolvedTitle}"`,
                );
            }

            const settings = await getSystemSettings();
            const musicPath = settings?.musicPath;

            if (!musicPath) {
                return res.status(400).json({
                    error: "Music path not configured",
                });
            }

            logger.debug(
                `[Soulseek] Downloading: "${resolvedArtist} - ${resolvedTitle}"`,
            );

            const result = await soulseekService.searchAndDownload(
                resolvedArtist,
                resolvedTitle,
                album || "Unknown Album",
                musicPath,
            );

            if (result.success) {
                res.json({
                    success: true,
                    filePath: result.filePath,
                });
            } else {
                sendRouteError(res, 404, result.error || "Download failed");
            }
        } catch (error: any) {
            logger.error("Soulseek download error:", error.message);
            res.status(500).json({
                error: "Download failed",
            });
        }
    },
);

/**
 * @openapi
 * /api/soulseek/disconnect:
 *   post:
 *     summary: Disconnect from the Soulseek network
 *     tags: [Soulseek]
 *     responses:
 *       200:
 *         description: Successfully disconnected from Soulseek
 *       401:
 *         description: Not authenticated
 */
/**
 * POST /soulseek/disconnect
 * Disconnect from Soulseek network
 */
router.post("/disconnect", requireAuth, async (req, res) => {
    try {
        soulseekService.disconnect();
        res.json({ success: true, message: "Disconnected" });
    } catch (error: any) {
        logger.error("[Soulseek] Disconnect error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

export default router;
