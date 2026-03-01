/**
 * YouTube Music Routes
 *
 * Exposes the ytmusic-streamer sidecar's functionality to the frontend.
 * All routes require authentication. Each user connects their own
 * YouTube Music account — OAuth credentials are stored per-user in
 * UserSettings.ytMusicOAuthJson.
 *
 * The /stream/:videoId endpoint proxies audio bytes from the sidecar
 * so that IP-locked YouTube URLs work correctly.
 */

import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { requireAuth, requireAuthOrToken } from "../middleware/auth";
import {
    ytMusicService,
    normalizeYtMusicStreamQuality,
} from "../services/youtubeMusic";
import { getSystemSettings } from "../utils/systemSettings";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { trackMappingService } from "../services/trackMappingService";
import { encrypt, decrypt } from "../utils/encryption";
import {
    ytMusicSearchLimiter,
    ytMusicStreamLimiter,
} from "../middleware/rateLimiter";

const router = Router();
const OAUTH_CACHE_TTL_MS = process.env.NODE_ENV === "test" ? 0 : 60_000;
const DEFAULT_YTMUSIC_STREAM_QUALITY = "high";
const ytOauthSessionCache = new Map<
    string,
    { authenticated: boolean; expiresAt: number }
>();
const ytOauthRestoreInFlight = new Map<string, Promise<boolean>>();

const setYtOAuthCache = (
    userId: string,
    authenticated: boolean,
    ttlMs = OAUTH_CACHE_TTL_MS
) => {
    if (!authenticated || ttlMs <= 0) {
        ytOauthSessionCache.delete(userId);
        return;
    }
    ytOauthSessionCache.set(userId, {
        authenticated,
        expiresAt: Date.now() + ttlMs,
    });
};

const getCachedYtOAuth = (userId: string): boolean | null => {
    const entry = ytOauthSessionCache.get(userId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        ytOauthSessionCache.delete(userId);
        return null;
    }
    return entry.authenticated;
};

const invalidateYtOAuthCache = (userId: string) => {
    ytOauthSessionCache.delete(userId);
    ytOauthRestoreInFlight.delete(userId);
};

// ── Guard middleware ───────────────────────────────────────────────

async function requireYtMusicEnabled(
    req: Request,
    res: Response,
    next: NextFunction
) {
    try {
        const settings = await getSystemSettings();
        if (!settings.ytMusicEnabled) {
            return res
                .status(403)
                .json({ error: "YouTube Music integration is not enabled" });
        }
        next();
    } catch (err) {
        logger.error("[YTMusic Route] Failed to check settings:", err);
        res.status(500).json({ error: "Internal server error" });
    }
}

/**
 * Ensure the user's OAuth credentials from the DB are synced to the
 * sidecar. Called lazily on each request so we don't need a startup
 * restore block. The sidecar caches instances, so this is a no-op
 * if already restored.
 */
async function ensureUserOAuth(userId: string): Promise<boolean> {
    const cached = getCachedYtOAuth(userId);
    if (cached !== null) {
        return cached;
    }

    const existingInFlight = ytOauthRestoreInFlight.get(userId);
    if (existingInFlight) {
        return existingInFlight;
    }

    const restorePromise = (async () => {
        try {
            // Quick check — is the sidecar already aware of this user?
            const status = await ytMusicService.getAuthStatus(userId);
            if (status.authenticated) {
                setYtOAuthCache(userId, true);
                return true;
            }

            // Not authenticated in sidecar — try restoring from DB
            const userSettings = await prisma.userSettings.findUnique({
                where: { userId },
                select: { ytMusicOAuthJson: true },
            });

            if (!userSettings?.ytMusicOAuthJson) {
                setYtOAuthCache(userId, false);
                return false;
            }

            const oauthJson = decrypt(userSettings.ytMusicOAuthJson);
            if (!oauthJson) {
                setYtOAuthCache(userId, false);
                return false;
            }

            // Also pass client credentials so the sidecar can build OAuthCredentials
            const systemSettings = await getSystemSettings();
            await ytMusicService.restoreOAuthWithCredentials(
                userId,
                oauthJson,
                systemSettings?.ytMusicClientId || undefined,
                systemSettings?.ytMusicClientSecret || undefined
            );
            logger.info(`[YTMusic] Restored OAuth credentials for user ${userId}`);
            setYtOAuthCache(userId, true);
            return true;
        } catch (err) {
            logger.debug(`[YTMusic] OAuth restore failed for user ${userId}:`, err);
            setYtOAuthCache(userId, false);
            return false;
        }
    })().finally(() => {
        ytOauthRestoreInFlight.delete(userId);
    });

    ytOauthRestoreInFlight.set(userId, restorePromise);
    return restorePromise;
}

async function requireUserOAuth(
    userId: string,
    res: Response
): Promise<boolean> {
    const ok = await ensureUserOAuth(userId);
    if (!ok) {
        setYtOAuthCache(userId, false);
        res.status(401).json({
            error: "YouTube Music authentication expired or missing. Please reconnect your account.",
        });
        return false;
    }
    return true;
}

function handleYtMusicAuthError(
    res: Response,
    err: any,
    userId?: string
): boolean {
    if (err?.response?.status !== 401) return false;
    if (userId) {
        setYtOAuthCache(userId, false);
    } else {
        ytOauthSessionCache.clear();
        ytOauthRestoreInFlight.clear();
    }
    res.status(401).json({
        error: "YouTube Music authentication expired or invalid. Please reconnect your account.",
    });
    return true;
}

const getRequestedStreamQuality = (rawQuality: unknown): string | undefined => {
    if (typeof rawQuality !== "string") {
        return undefined;
    }
    const trimmed = rawQuality.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

async function resolveYtMusicStreamQuality(
    userId: string,
    rawRequestedQuality: unknown
): Promise<string> {
    const requestedQuality = getRequestedStreamQuality(rawRequestedQuality);
    if (requestedQuality) {
        return requestedQuality;
    }

    try {
        const settings = await prisma.userSettings.findUnique({
            where: { userId },
            select: { ytMusicQuality: true },
        });
        return (
            normalizeYtMusicStreamQuality(settings?.ytMusicQuality) ??
            DEFAULT_YTMUSIC_STREAM_QUALITY
        );
    } catch (error) {
        logger.warn(
            `[YTMusic] Failed to read user quality preference for user ${userId}; falling back to ${DEFAULT_YTMUSIC_STREAM_QUALITY}`,
            error
        );
        return DEFAULT_YTMUSIC_STREAM_QUALITY;
    }
}

// ── Status ─────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/ytmusic/status:
 *   get:
 *     summary: Check YouTube Music integration and authentication status
 *     tags: [YouTube Music]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: YouTube Music status including enabled, available, and authentication state
 *       401:
 *         description: Not authenticated
 */
router.get(
    "/status",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            const settings = await getSystemSettings();
            const available = await ytMusicService.isAvailable();

            if (!available) {
                return res.json({
                    enabled: settings.ytMusicEnabled,
                    available: false,
                    authenticated: false,
                    credentialsConfigured: !!(settings?.ytMusicClientId && settings?.ytMusicClientSecret),
                });
            }

            // Try to restore OAuth if needed, then check status
            await ensureUserOAuth(userId);
            const authStatus = await ytMusicService.getAuthStatus(userId);

            return res.json({
                enabled: settings.ytMusicEnabled,
                available: true,
                credentialsConfigured: !!(settings?.ytMusicClientId && settings?.ytMusicClientSecret),
                ...authStatus,
            });
        } catch (err) {
            logger.error("[YTMusic Route] Status check failed:", err);
            res.status(500).json({ error: "Failed to check YouTube Music status" });
        }
    }
);

// ── OAuth Device Code Flow (per-user) ──────────────────────────────

/**
 * @openapi
 * /api/ytmusic/auth/device-code:
 *   post:
 *     summary: Initiate OAuth device code flow for YouTube Music authentication
 *     tags: [YouTube Music]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: Device code and verification URL for user authorization
 *       400:
 *         description: YouTube Music client credentials not configured
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: YouTube Music integration is not enabled
 */
router.post(
    "/auth/device-code",
    requireAuth,
    requireYtMusicEnabled,
    async (req: Request, res: Response) => {
        try {
            const settings = await getSystemSettings();
            if (!settings?.ytMusicClientId || !settings?.ytMusicClientSecret) {
                return res.status(400).json({
                    error: "YouTube Music Client ID and Secret must be configured by an admin first",
                });
            }

            const result = await ytMusicService.initiateDeviceAuth(
                settings.ytMusicClientId,
                settings.ytMusicClientSecret
            );

            res.json(result);
        } catch (err: any) {
            logger.error("[YTMusic Route] Device code initiation failed:", err);
            res.status(500).json({
                error: err.response?.data?.detail || "Failed to initiate device code flow",
            });
        }
    }
);

/**
 * @openapi
 * /api/ytmusic/auth/device-code/poll:
 *   post:
 *     summary: Poll device code authorization status for YouTube Music OAuth
 *     tags: [YouTube Music]
 *     security:
 *       - sessionAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [deviceCode]
 *             properties:
 *               deviceCode:
 *                 type: string
 *     responses:
 *       200:
 *         description: Poll result with authorization status
 *       400:
 *         description: Missing deviceCode or client credentials not configured
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: YouTube Music integration is not enabled
 */
router.post(
    "/auth/device-code/poll",
    requireAuth,
    requireYtMusicEnabled,
    async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            const { deviceCode } = req.body;

            if (!deviceCode) {
                return res.status(400).json({ error: "deviceCode is required" });
            }

            const settings = await getSystemSettings();
            if (!settings?.ytMusicClientId || !settings?.ytMusicClientSecret) {
                return res.status(400).json({
                    error: "YouTube Music Client ID and Secret not configured",
                });
            }

            const result = await ytMusicService.pollDeviceAuth(
                userId,
                settings.ytMusicClientId,
                settings.ytMusicClientSecret,
                deviceCode
            );

            // If we got a successful token, save it encrypted in the DB
            if (result.status === "success" && result.oauth_json) {
                await prisma.userSettings.upsert({
                    where: { userId },
                    create: {
                        userId,
                        ytMusicOAuthJson: encrypt(result.oauth_json),
                    },
                    update: {
                        ytMusicOAuthJson: encrypt(result.oauth_json),
                    },
                });
                setYtOAuthCache(userId, true);
                logger.info(`[YTMusic] Device code auth completed for user ${userId}`);
            }

            // Don't send raw oauth_json to the frontend
            res.json({
                status: result.status,
                error: result.error,
            });
        } catch (err: any) {
            logger.error("[YTMusic Route] Device code poll failed:", err);
            res.status(500).json({
                error: err.response?.data?.detail || "Failed to poll device code",
            });
        }
    }
);

/**
 * @openapi
 * /api/ytmusic/auth/save-token:
 *   post:
 *     summary: Save OAuth token JSON for YouTube Music authentication
 *     tags: [YouTube Music]
 *     security:
 *       - sessionAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [oauthJson]
 *             properties:
 *               oauthJson:
 *                 type: string
 *                 description: OAuth credentials as a JSON string
 *     responses:
 *       200:
 *         description: OAuth token saved successfully
 *       400:
 *         description: Missing or invalid oauthJson
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: YouTube Music integration is not enabled
 */
router.post(
    "/auth/save-token",
    requireAuth,
    requireYtMusicEnabled,
    async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            const { oauthJson } = req.body;

            if (!oauthJson) {
                return res.status(400).json({ error: "oauthJson is required" });
            }

            // Validate it's proper JSON
            try {
                JSON.parse(oauthJson);
            } catch {
                return res.status(400).json({ error: "Invalid JSON in oauthJson" });
            }

            // Encrypt and save to UserSettings
            await prisma.userSettings.upsert({
                where: { userId },
                create: {
                    userId,
                    ytMusicOAuthJson: encrypt(oauthJson),
                },
                update: {
                    ytMusicOAuthJson: encrypt(oauthJson),
                },
            });

            // Restore to sidecar so it's immediately usable
            const settings = await getSystemSettings();
            await ytMusicService.restoreOAuthWithCredentials(
                userId,
                oauthJson,
                settings?.ytMusicClientId || undefined,
                settings?.ytMusicClientSecret || undefined
            );
            setYtOAuthCache(userId, true);

            logger.info(`[YTMusic] OAuth credentials saved for user ${userId}`);
            res.json({ success: true });
        } catch (err: any) {
            logger.error("[YTMusic Route] Save OAuth token failed:", err);
            res.status(500).json({
                error: err.response?.data?.detail || "Failed to save OAuth token",
            });
        }
    }
);

/**
 * @openapi
 * /api/ytmusic/auth/clear:
 *   post:
 *     summary: Clear YouTube Music OAuth credentials for the current user
 *     tags: [YouTube Music]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: OAuth credentials cleared successfully
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: YouTube Music integration is not enabled
 */
router.post(
    "/auth/clear",
    requireAuth,
    requireYtMusicEnabled,
    async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;

            // Clear from sidecar
            await ytMusicService.clearAuth(userId);

            // Clear from database
            await prisma.userSettings.upsert({
                where: { userId },
                create: { userId, ytMusicOAuthJson: null },
                update: { ytMusicOAuthJson: null },
            });
            invalidateYtOAuthCache(userId);
            setYtOAuthCache(userId, false);

            logger.info(`[YTMusic] OAuth credentials cleared for user ${userId}`);
            res.json({ success: true });
        } catch (err: any) {
            logger.error("[YTMusic Route] Clear auth failed:", err);
            res.status(500).json({
                error: err.response?.data?.detail || "Failed to clear auth",
            });
        }
    }
);

// ── Search ─────────────────────────────────────────────────────────
// Search and gap-fill matching intentionally skip requireUserOAuth:
// the sidecar executes these operations with public clients so user OAuth
// search history is not affected.

/**
 * @openapi
 * /api/ytmusic/search:
 *   post:
 *     summary: Search YouTube Music catalog
 *     tags: [YouTube Music]
 *     security:
 *       - sessionAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [query]
 *             properties:
 *               query:
 *                 type: string
 *               filter:
 *                 type: string
 *     responses:
 *       200:
 *         description: Search results from YouTube Music
 *       400:
 *         description: Missing query parameter
 *       401:
 *         description: Not authenticated or YouTube Music auth expired
 *       403:
 *         description: YouTube Music integration is not enabled
 */
router.post(
    "/search",
    requireAuth,
    requireYtMusicEnabled,
    ytMusicSearchLimiter,
    async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;

            const { query, filter } = req.body;
            if (!query) {
                return res.status(400).json({ error: "query is required" });
            }
            const result = await ytMusicService.searchCanonical(
                userId,
                query,
                filter
            );
            res.json(result);
        } catch (err: any) {
            if (handleYtMusicAuthError(res, err)) return;
            logger.error("[YTMusic Route] Search failed:", err);
            res.status(500).json({
                error: err.response?.data?.detail || "Search failed",
            });
        }
    }
);

// ── Browse ─────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/ytmusic/album/{browseId}:
 *   get:
 *     summary: Get YouTube Music album details by browse ID
 *     tags: [YouTube Music]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: path
 *         name: browseId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Album details from YouTube Music
 *       401:
 *         description: Not authenticated or YouTube Music auth expired
 *       403:
 *         description: YouTube Music integration is not enabled
 */
router.get(
    "/album/:browseId",
    requireAuth,
    requireYtMusicEnabled,
    async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            if (!(await requireUserOAuth(userId, res))) return;
            const album = await ytMusicService.getAlbum(userId, req.params.browseId);
            res.json(album);
        } catch (err: any) {
            if (handleYtMusicAuthError(res, err)) return;
            logger.error("[YTMusic Route] Get album failed:", err);
            res.status(500).json({
                error: err.response?.data?.detail || "Failed to get album",
            });
        }
    }
);

/**
 * @openapi
 * /api/ytmusic/artist/{channelId}:
 *   get:
 *     summary: Get YouTube Music artist details by channel ID
 *     tags: [YouTube Music]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Artist details from YouTube Music
 *       401:
 *         description: Not authenticated or YouTube Music auth expired
 *       403:
 *         description: YouTube Music integration is not enabled
 */
router.get(
    "/artist/:channelId",
    requireAuth,
    requireYtMusicEnabled,
    async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            if (!(await requireUserOAuth(userId, res))) return;
            const artist = await ytMusicService.getArtist(userId, req.params.channelId);
            res.json(artist);
        } catch (err: any) {
            if (handleYtMusicAuthError(res, err)) return;
            logger.error("[YTMusic Route] Get artist failed:", err);
            res.status(500).json({
                error: err.response?.data?.detail || "Failed to get artist",
            });
        }
    }
);

/**
 * @openapi
 * /api/ytmusic/song/{videoId}:
 *   get:
 *     summary: Get YouTube Music song details by video ID
 *     tags: [YouTube Music]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: path
 *         name: videoId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Song details from YouTube Music
 *       401:
 *         description: Not authenticated or YouTube Music auth expired
 *       403:
 *         description: YouTube Music integration is not enabled
 */
router.get(
    "/song/:videoId",
    requireAuth,
    requireYtMusicEnabled,
    async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            if (!(await requireUserOAuth(userId, res))) return;
            const song = await ytMusicService.getSong(userId, req.params.videoId);
            res.json(song);
        } catch (err: any) {
            if (handleYtMusicAuthError(res, err)) return;
            logger.error("[YTMusic Route] Get song failed:", err);
            res.status(500).json({
                error: err.response?.data?.detail || "Failed to get song",
            });
        }
    }
);

// ── Stream Info ────────────────────────────────────────────────────
// Returns metadata about a YT Music stream (bitrate, codec, etc.)
// without proxying the actual audio bytes. Used by the player UI
// to display quality information.

/**
 * @openapi
 * /api/ytmusic/stream-info/{videoId}:
 *   get:
 *     summary: Get stream metadata (bitrate, codec, duration) for a YouTube Music track
 *     tags: [YouTube Music]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
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
 *         description: Requested stream quality (e.g. high, low)
 *     responses:
 *       200:
 *         description: Stream metadata including bitrate, codec, and duration
 *       401:
 *         description: Not authenticated or YouTube Music auth expired
 *       403:
 *         description: YouTube Music integration is not enabled
 *       404:
 *         description: Stream not found
 *       451:
 *         description: Content is age-restricted and cannot be streamed
 */
router.get(
    "/stream-info/:videoId",
    requireAuthOrToken,
    requireYtMusicEnabled,
    ytMusicStreamLimiter,
    async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            if (!(await requireUserOAuth(userId, res))) return;

            const { videoId } = req.params;
            const quality = await resolveYtMusicStreamQuality(
                userId,
                req.query.quality
            );

            const info = await ytMusicService.getStreamInfo(
                userId,
                videoId,
                quality
            );

            res.json({
                videoId: info.videoId,
                abr: info.abr,
                acodec: info.acodec,
                duration: info.duration,
                content_type: info.content_type,
            });
        } catch (err: any) {
            if (err.response?.status === 404) {
                return res.status(404).json({ error: "Stream not found" });
            }
            if (err.response?.status === 451) {
                return res.status(451).json({
                    error: "age_restricted",
                    message: "This content requires age verification and cannot be streamed via YouTube Music.",
                });
            }
            if (handleYtMusicAuthError(res, err)) return;
            logger.error("[YTMusic Route] Stream info failed:", err);
            res.status(500).json({
                error: "Failed to get stream info",
            });
        }
    }
);

// ── Stream Proxy ───────────────────────────────────────────────────
// This is the critical endpoint: the frontend requests audio from here,
// and we pipe it from the sidecar. This avoids exposing IP-locked
// YouTube CDN URLs directly to the browser.

/**
 * @openapi
 * /api/ytmusic/stream/{videoId}:
 *   get:
 *     summary: Proxy audio stream from YouTube Music sidecar
 *     tags: [YouTube Music]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
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
 *         description: Requested stream quality (e.g. high, low)
 *     responses:
 *       200:
 *         description: Audio stream bytes piped from the YouTube Music sidecar
 *         content:
 *           audio/*:
 *             schema:
 *               type: string
 *               format: binary
 *       206:
 *         description: Partial content (range request)
 *       401:
 *         description: Not authenticated or YouTube Music auth expired
 *       403:
 *         description: YouTube Music integration is not enabled
 *       404:
 *         description: Stream not found
 *       451:
 *         description: Content is age-restricted and cannot be streamed
 */
router.get(
    "/stream/:videoId",
    requireAuthOrToken,
    requireYtMusicEnabled,
    ytMusicStreamLimiter,
    async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            if (!(await requireUserOAuth(userId, res))) return;

            const { videoId } = req.params;
            const quality = await resolveYtMusicStreamQuality(
                userId,
                req.query.quality
            );
            const rangeHeader = req.headers.range;

            const proxyRes = await ytMusicService.getStreamProxy(
                userId,
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

            // Pipe the audio stream to the client
            // Handle upstream errors gracefully — if the sidecar drops the
            // connection mid-stream the browser will retry with a new Range.
            proxyRes.data.on("error", (streamErr: Error) => {
                logger.warn(
                    `[YTMusic Route] Upstream stream error for ${videoId}: ${streamErr.message}`
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
                    message: "This content requires age verification and cannot be streamed via YouTube Music.",
                });
            }
            if (handleYtMusicAuthError(res, err)) return;
            logger.error("[YTMusic Route] Stream proxy failed:", err);
            res.status(500).json({
                error: "Failed to stream audio",
            });
        }
    }
);

// ── Library ────────────────────────────────────────────────────────

/**
 * @openapi
 * /api/ytmusic/library/songs:
 *   get:
 *     summary: Get songs from the user's YouTube Music library
 *     tags: [YouTube Music]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of songs to return
 *     responses:
 *       200:
 *         description: List of library songs
 *       401:
 *         description: Not authenticated or YouTube Music auth expired
 *       403:
 *         description: YouTube Music integration is not enabled
 */
router.get(
    "/library/songs",
    requireAuth,
    requireYtMusicEnabled,
    async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            if (!(await requireUserOAuth(userId, res))) return;
            const limit = parseInt(req.query.limit as string) || 100;
            const songs = await ytMusicService.getLibrarySongs(userId, limit);
            res.json({ songs });
        } catch (err: any) {
            if (handleYtMusicAuthError(res, err)) return;
            logger.error("[YTMusic Route] Library songs failed:", err);
            res.status(500).json({
                error: err.response?.data?.detail || "Failed to get library songs",
            });
        }
    }
);

/**
 * @openapi
 * /api/ytmusic/library/albums:
 *   get:
 *     summary: Get albums from the user's YouTube Music library
 *     tags: [YouTube Music]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of albums to return
 *     responses:
 *       200:
 *         description: List of library albums
 *       401:
 *         description: Not authenticated or YouTube Music auth expired
 *       403:
 *         description: YouTube Music integration is not enabled
 */
router.get(
    "/library/albums",
    requireAuth,
    requireYtMusicEnabled,
    async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;
            if (!(await requireUserOAuth(userId, res))) return;
            const limit = parseInt(req.query.limit as string) || 100;
            const albums = await ytMusicService.getLibraryAlbums(userId, limit);
            res.json({ albums });
        } catch (err: any) {
            if (handleYtMusicAuthError(res, err)) return;
            logger.error("[YTMusic Route] Library albums failed:", err);
            res.status(500).json({
                error: err.response?.data?.detail || "Failed to get library albums",
            });
        }
    }
);

// ── Gap-Fill Match ─────────────────────────────────────────────────

/**
 * @openapi
 * /api/ytmusic/match:
 *   post:
 *     summary: Find the best YouTube Music match for a given track
 *     tags: [YouTube Music]
 *     security:
 *       - sessionAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [artist, title]
 *             properties:
 *               artist:
 *                 type: string
 *               title:
 *                 type: string
 *               albumTitle:
 *                 type: string
 *               duration:
 *                 type: number
 *               isrc:
 *                 type: string
 *     responses:
 *       200:
 *         description: Best matching track from YouTube Music
 *       400:
 *         description: Missing required artist and title fields
 *       401:
 *         description: Not authenticated or YouTube Music auth expired
 *       403:
 *         description: YouTube Music integration is not enabled
 */
router.post(
    "/match",
    requireAuth,
    requireYtMusicEnabled,
    ytMusicSearchLimiter,
    async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;

            const schema = z.object({
                artist: z.string().min(1),
                title: z.string().min(1),
                albumTitle: z.string().optional(),
                duration: z.number().positive().optional(),
                isrc: z.string().trim().min(6).max(20).optional(),
            });
            const parsed = schema.safeParse(req.body);
            if (!parsed.success) {
                return res
                    .status(400)
                    .json({ error: "artist and title are required" });
            }
            const match = await ytMusicService.findMatchForTrack(
                userId,
                parsed.data.artist,
                parsed.data.title,
                parsed.data.albumTitle,
                parsed.data.duration,
                parsed.data.isrc
            );
            res.json({ match });
        } catch (err: any) {
            if (handleYtMusicAuthError(res, err)) return;
            logger.error("[YTMusic Route] Match failed:", err);
            res.status(500).json({
                error: "Failed to find matching track",
            });
        }
    }
);

// ── Batch Gap-Fill Match ───────────────────────────────────────────

/**
 * @openapi
 * /api/ytmusic/match-batch:
 *   post:
 *     summary: Batch-match multiple tracks against YouTube Music catalog
 *     tags: [YouTube Music]
 *     security:
 *       - sessionAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tracks]
 *             properties:
 *               tracks:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 50
 *                 items:
 *                   type: object
 *                   properties:
 *                     artist:
 *                       type: string
 *                     title:
 *                       type: string
 *                     albumTitle:
 *                       type: string
 *                     duration:
 *                       type: number
 *                     isrc:
 *                       type: string
 *     responses:
 *       200:
 *         description: Matches keyed by index for each input track
 *       400:
 *         description: Invalid or missing tracks array
 *       401:
 *         description: Not authenticated or YouTube Music auth expired
 *       403:
 *         description: YouTube Music integration is not enabled
 */
router.post(
    "/match-batch",
    requireAuth,
    requireYtMusicEnabled,
    ytMusicSearchLimiter,
    async (req: Request, res: Response) => {
        try {
            const userId = req.user!.id;

            const schema = z.object({
                tracks: z
                    .array(
                        z.object({
                            artist: z.string(),
                            title: z.string(),
                            albumTitle: z.string().optional(),
                            duration: z.number().positive().optional(),
                            isrc: z.string().trim().min(6).max(20).optional(),
                        })
                    )
                    .min(1)
                    .max(50),
            });
            const parsed = schema.safeParse(req.body);
            if (!parsed.success) {
                return res
                    .status(400)
                    .json({ error: "tracks array is required" });
            }

            const matches = await ytMusicService.findMatchesForAlbum(
                userId,
                parsed.data.tracks
            );

            // Fire-and-forget: persist matched tracks as TrackYtMusic rows
            // TrackMapping rows are created when the frontend sends trackIds
            // via the track-mappings/batch endpoint or album-level fetch
            Promise.resolve().then(async () => {
                try {
                    for (let i = 0; i < matches.length; i++) {
                        const match = matches[i];
                        if (!match) continue;
                        const inputTrack = parsed.data.tracks[i];
                        await trackMappingService.upsertTrackYtMusic({
                            videoId: match.videoId,
                            title: match.title,
                            artist: inputTrack.artist,
                            album: inputTrack.albumTitle || "",
                            duration: match.duration,
                        });
                    }
                } catch (err) {
                    logger.warn("[YTMusic Route] Failed to persist gap-fill TrackYtMusic rows:", err);
                }
            });

            // Return matches keyed by index for easy lookup
            res.json({ matches });
        } catch (err: any) {
            if (handleYtMusicAuthError(res, err)) return;
            logger.error("[YTMusic Route] Batch match failed:", err);
            res.status(500).json({
                error: "Failed to batch-match tracks",
            });
        }
    }
);

// ── Public Stream Routes (no user OAuth required) ─────────────────
// These endpoints use the "__public__" user_id sentinel to bypass
// OAuth on the sidecar. yt-dlp extraction is unauthenticated.
// Users must still be logged into Soundspan (requireAuthOrToken)
// and YT Music must be admin-enabled (requireYtMusicEnabled).

/**
 * @openapi
 * /api/ytmusic/stream-info-public/{videoId}:
 *   get:
 *     summary: Get stream metadata without YT Music OAuth
 *     tags: [YouTube Music]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: videoId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Stream metadata
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: YouTube Music integration is not enabled
 */
router.get(
    "/stream-info-public/:videoId",
    requireAuthOrToken,
    requireYtMusicEnabled,
    ytMusicStreamLimiter,
    async (req: Request, res: Response) => {
        try {
            const { videoId } = req.params;
            const quality = normalizeYtMusicStreamQuality(
                (req.query.quality as string) || "HIGH"
            );

            const info = await ytMusicService.getStreamInfo(
                "__public__",
                videoId,
                quality
            );

            res.json({
                videoId: info.videoId,
                abr: info.abr,
                acodec: info.acodec,
                duration: info.duration,
                content_type: info.content_type,
            });
        } catch (err: any) {
            if (err.response?.status === 404) {
                return res.status(404).json({ error: "Stream not found" });
            }
            if (err.response?.status === 451) {
                return res.status(451).json({
                    error: "age_restricted",
                    message: "This content requires age verification and cannot be streamed via YouTube Music.",
                });
            }
            logger.error("[YTMusic Route] Public stream info failed:", err);
            res.status(500).json({
                error: "Failed to get stream info",
            });
        }
    }
);

/**
 * @openapi
 * /api/ytmusic/stream-public/{videoId}:
 *   get:
 *     summary: Proxy audio stream without YT Music OAuth
 *     tags: [YouTube Music]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
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
 *     responses:
 *       200:
 *         description: Audio stream bytes
 *       206:
 *         description: Partial content (range request)
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: YouTube Music integration is not enabled
 */
router.get(
    "/stream-public/:videoId",
    requireAuthOrToken,
    requireYtMusicEnabled,
    ytMusicStreamLimiter,
    async (req: Request, res: Response) => {
        try {
            const { videoId } = req.params;
            const quality = normalizeYtMusicStreamQuality(
                (req.query.quality as string) || "HIGH"
            );
            const rangeHeader = req.headers.range;

            const proxyRes = await ytMusicService.getStreamProxy(
                "__public__",
                videoId,
                quality,
                rangeHeader
            );

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
                    `[YTMusic Route] Public upstream stream error for ${videoId}: ${streamErr.message}`
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
                    message: "This content requires age verification and cannot be streamed via YouTube Music.",
                });
            }
            logger.error("[YTMusic Route] Public stream proxy failed:", err);
            res.status(500).json({
                error: "Failed to stream audio",
            });
        }
    }
);

export default router;
