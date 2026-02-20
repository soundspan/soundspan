/**
 * TIDAL Streaming Routes
 *
 * Per-user TIDAL streaming endpoints. Mirrors the YouTube Music
 * streaming pattern: each user connects their own TIDAL account
 * via device-code OAuth. Admin must have TIDAL enabled for the
 * streaming option to appear.
 *
 * Routes:
 *   GET  /status                - Check if TIDAL streaming is available
 *   POST /auth/device-code      - Initiate device code OAuth
 *   POST /auth/device-code/poll - Poll for auth completion
 *   POST /auth/save-token       - Save OAuth token manually
 *   POST /auth/clear            - Clear user's TIDAL auth
 *   POST /search                - Search TIDAL
 *   POST /match                 - Match a single track
 *   POST /match-batch           - Batch match tracks (gap-fill)
 *   GET  /stream-info/:trackId  - Stream metadata (quality, codec)
 *   GET  /stream/:trackId       - Audio stream proxy
 */

import { Router, Request, Response } from "express";
import axios from "axios";
import { z } from "zod";
import {
    requireAuth,
    requireAuthOrToken,
} from "../middleware/auth";
import { tidalStreamingService } from "../services/tidalStreaming";
import { prisma } from "../utils/db";
import { encrypt, decrypt } from "../utils/encryption";
import { logger } from "../utils/logger";

const router = Router();
const OAUTH_CACHE_TTL_MS = process.env.NODE_ENV === "test" ? 0 : 60_000;
const USER_QUALITY_CACHE_TTL_MS = process.env.NODE_ENV === "test" ? 0 : 60_000;
const tidalOauthSessionCache = new Map<
    string,
    { authenticated: boolean; expiresAt: number }
>();
const tidalOauthRestoreInFlight = new Map<string, Promise<boolean>>();
const userQualityCache = new Map<string, { quality: string; expiresAt: number }>();

const setTidalOAuthCache = (
    userId: string,
    authenticated: boolean,
    ttlMs = OAUTH_CACHE_TTL_MS
) => {
    if (!authenticated || ttlMs <= 0) {
        tidalOauthSessionCache.delete(userId);
        return;
    }
    tidalOauthSessionCache.set(userId, {
        authenticated,
        expiresAt: Date.now() + ttlMs,
    });
};

const getCachedTidalOAuth = (userId: string): boolean | null => {
    const entry = tidalOauthSessionCache.get(userId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        tidalOauthSessionCache.delete(userId);
        return null;
    }
    return entry.authenticated;
};

const invalidateTidalUserCaches = (userId: string) => {
    tidalOauthSessionCache.delete(userId);
    tidalOauthRestoreInFlight.delete(userId);
    userQualityCache.delete(userId);
};

async function getUserPreferredTidalQuality(userId: string): Promise<string> {
    if (USER_QUALITY_CACHE_TTL_MS > 0) {
        const cached = userQualityCache.get(userId);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.quality;
        }
    }

    try {
        const userSettings = await prisma.userSettings.findUnique({
            where: { userId },
            select: { tidalStreamingQuality: true },
        });
        const quality = userSettings?.tidalStreamingQuality || "HIGH";
        if (USER_QUALITY_CACHE_TTL_MS > 0) {
            userQualityCache.set(userId, {
                quality,
                expiresAt: Date.now() + USER_QUALITY_CACHE_TTL_MS,
            });
        }
        return quality;
    } catch {
        return "HIGH";
    }
}

// ── Guard middleware ───────────────────────────────────────────────

/**
 * Require that TIDAL streaming is enabled (admin toggle) AND the
 * sidecar is reachable.
 */
async function requireTidalStreamingEnabled(
    req: Request,
    res: Response,
    next: Function
) {
    const enabled = await tidalStreamingService.isEnabled();
    if (!enabled) {
        return res.status(404).json({
            error: "TIDAL streaming is not enabled",
        });
    }
    const available = await tidalStreamingService.isAvailable();
    if (!available) {
        return res.status(503).json({
            error: "TIDAL service is not available",
        });
    }
    next();
}

// ── Lazy OAuth restore ────────────────────────────────────────────

/**
 * Ensure the user's TIDAL OAuth credentials are loaded into the
 * sidecar. Called before any per-user streaming request.
 */
async function ensureUserOAuth(userId: string): Promise<boolean> {
    const cached = getCachedTidalOAuth(userId);
    if (cached !== null) {
        return cached;
    }

    const existingInFlight = tidalOauthRestoreInFlight.get(userId);
    if (existingInFlight) {
        return existingInFlight;
    }

    const restorePromise = (async () => {
        // Check if sidecar already has this user's session
        try {
            const { data } = await axios.get(
                `${process.env.TIDAL_SIDECAR_URL || "http://127.0.0.1:8585"}/user/auth/status?user_id=${encodeURIComponent(userId)}`,
                { timeout: 5000 }
            );
            if (data.authenticated) {
                setTidalOAuthCache(userId, true);
                return true;
            }
        } catch {
            // Sidecar might not have the session, try to restore
        }

        // Load from DB and restore
        const userSettings = await prisma.userSettings.findUnique({
            where: { userId },
            select: { tidalOAuthJson: true },
        });
        if (!userSettings?.tidalOAuthJson) {
            setTidalOAuthCache(userId, false);
            return false;
        }

        let oauthJson: string;
        try {
            oauthJson = decrypt(userSettings.tidalOAuthJson);
        } catch {
            oauthJson = userSettings.tidalOAuthJson;
        }

        const restored = await tidalStreamingService.restoreOAuth(userId, oauthJson);
        setTidalOAuthCache(userId, restored);
        return restored;
    })().finally(() => {
        tidalOauthRestoreInFlight.delete(userId);
    });

    tidalOauthRestoreInFlight.set(userId, restorePromise);
    return restorePromise;
}

// ── Routes ─────────────────────────────────────────────────────────

// Auth is applied per-route so that stream endpoints can use
// requireAuthOrToken (query-param token for the audio element).

/**
 * GET /status
 * Check TIDAL streaming availability for the current user.
 */
router.get("/status", requireAuth, async (req: Request, res: Response) => {
    try {
        const userId = req.user!.id;
        const [enabled, available, authStatus] = await Promise.all([
            tidalStreamingService.isEnabled(),
            tidalStreamingService.isAvailable(),
            tidalStreamingService.getAuthStatus(userId),
        ]);

        res.json({
            enabled,
            available,
            authenticated: authStatus.authenticated,
            credentialsConfigured: authStatus.credentialsConfigured,
        });
    } catch (err: any) {
        logger.error("[TIDAL-STREAM] Status check failed:", err.message);
        res.status(500).json({ error: "Failed to check TIDAL status" });
    }
});

/**
 * POST /auth/device-code
 * Initiate device-code OAuth flow for the current user.
 */
router.post(
    "/auth/device-code",
    requireAuth,
    requireTidalStreamingEnabled,
    async (req: Request, res: Response) => {
        try {
            const deviceAuth = await tidalStreamingService.initiateDeviceAuth();
            res.json({
                device_code: deviceAuth.device_code,
                user_code: deviceAuth.user_code,
                verification_uri: deviceAuth.verification_uri,
                verification_uri_complete: deviceAuth.verification_uri_complete,
                expires_in: deviceAuth.expires_in,
                interval: deviceAuth.interval,
            });
        } catch (err: any) {
            logger.error("[TIDAL-STREAM] Device auth failed:", err.message);
            res.status(500).json({ error: "Failed to initiate TIDAL auth" });
        }
    }
);

/**
 * POST /auth/device-code/poll
 * Poll for device-code auth completion.
 */
router.post(
    "/auth/device-code/poll",
    requireAuth,
    requireTidalStreamingEnabled,
    async (req: Request, res: Response) => {
        const schema = z.object({ deviceCode: z.string() });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: "deviceCode is required" });
        }

        const userId = req.user!.id;

        try {
            const tokens = await tidalStreamingService.pollDeviceAuth(
                parsed.data.deviceCode
            );

            if (!tokens) {
                return res.json({ status: "pending" });
            }

            // Save encrypted OAuth JSON to UserSettings
            const oauthJson = JSON.stringify({
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                tidal_user_id: tokens.user_id,
                country_code: tokens.country_code,
                username: tokens.username,
            });

            await prisma.userSettings.upsert({
                where: { userId },
                update: { tidalOAuthJson: encrypt(oauthJson) },
                create: {
                    userId,
                    tidalOAuthJson: encrypt(oauthJson),
                },
            });

            // Restore to sidecar immediately
            await tidalStreamingService.restoreOAuth(userId, oauthJson);
            setTidalOAuthCache(userId, true);

            res.json({
                status: "success",
                username: tokens.username,
                country_code: tokens.country_code,
            });
        } catch (err: any) {
            logger.error("[TIDAL-STREAM] Poll auth failed:", err.message);
            res.status(500).json({
                status: "error",
                error: err.message,
            });
        }
    }
);

/**
 * POST /auth/save-token
 * Save TIDAL OAuth token manually (e.g. from external auth).
 */
router.post(
    "/auth/save-token",
    requireAuth,
    requireTidalStreamingEnabled,
    async (req: Request, res: Response) => {
        const schema = z.object({ oauthJson: z.string() });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: "oauthJson is required" });
        }

        const userId = req.user!.id;

        try {
            await prisma.userSettings.upsert({
                where: { userId },
                update: { tidalOAuthJson: encrypt(parsed.data.oauthJson) },
                create: {
                    userId,
                    tidalOAuthJson: encrypt(parsed.data.oauthJson),
                },
            });

            // Restore to sidecar
            await tidalStreamingService.restoreOAuth(
                userId,
                parsed.data.oauthJson
            );
            setTidalOAuthCache(userId, true);

            res.json({ success: true });
        } catch (err: any) {
            logger.error("[TIDAL-STREAM] Save token failed:", err.message);
            res.status(500).json({ error: "Failed to save TIDAL token" });
        }
    }
);

/**
 * POST /auth/clear
 * Clear user's TIDAL auth credentials.
 */
router.post("/auth/clear", requireAuth, async (req: Request, res: Response) => {
    const userId = req.user!.id;

    try {
        // Clear from DB
        await prisma.userSettings.update({
            where: { userId },
            data: { tidalOAuthJson: null },
        });

        // Clear from sidecar
        await tidalStreamingService.clearAuth(userId);
        invalidateTidalUserCaches(userId);
        setTidalOAuthCache(userId, false);

        res.json({ success: true });
    } catch (err: any) {
        logger.error("[TIDAL-STREAM] Clear auth failed:", err.message);
        res.status(500).json({ error: "Failed to clear TIDAL auth" });
    }
});

/**
 * POST /search
 * Search TIDAL using the user's credentials.
 */
router.post(
    "/search",
    requireAuth,
    requireTidalStreamingEnabled,
    async (req: Request, res: Response) => {
        const userId = req.user!.id;
        const schema = z.object({
            query: z.string(),
            filter: z.string().optional(),
        });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: "query is required" });
        }

        try {
            const hasAuth = await ensureUserOAuth(userId);
            if (!hasAuth) {
                return res
                    .status(401)
                    .json({ error: "Not authenticated to TIDAL" });
            }

            const results = await tidalStreamingService.search(
                userId,
                parsed.data.query
            );
            res.json(results);
        } catch (err: any) {
            logger.error("[TIDAL-STREAM] Search failed:", err.message);
            res.status(500).json({ error: "TIDAL search failed" });
        }
    }
);

/**
 * POST /match
 * Match a single track against TIDAL (gap-fill).
 */
router.post(
    "/match",
    requireAuth,
    requireTidalStreamingEnabled,
    async (req: Request, res: Response) => {
        const userId = req.user!.id;
        const schema = z.object({
            artist: z.string(),
            title: z.string(),
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

        try {
            const hasAuth = await ensureUserOAuth(userId);
            if (!hasAuth) {
                return res
                    .status(401)
                    .json({ error: "Not authenticated to TIDAL" });
            }

            const match = await tidalStreamingService.findMatchForTrack(
                userId,
                parsed.data.artist,
                parsed.data.title,
                parsed.data.albumTitle,
                parsed.data.duration,
                parsed.data.isrc
            );
            res.json({ match });
        } catch (err: any) {
            logger.error("[TIDAL-STREAM] Match failed:", err.message);
            res.status(500).json({ error: "TIDAL match failed" });
        }
    }
);

/**
 * POST /match-batch
 * Batch match tracks against TIDAL (gap-fill for albums).
 */
router.post(
    "/match-batch",
    requireAuth,
    requireTidalStreamingEnabled,
    async (req: Request, res: Response) => {
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
                .max(50),
        });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ error: "tracks array is required" });
        }

        try {
            const hasAuth = await ensureUserOAuth(userId);
            if (!hasAuth) {
                return res
                    .status(401)
                    .json({ error: "Not authenticated to TIDAL" });
            }

            const matches = await tidalStreamingService.findMatchesForAlbum(
                userId,
                parsed.data.tracks
            );
            res.json({ matches });
        } catch (err: any) {
            logger.error("[TIDAL-STREAM] Batch match failed:", err.message);
            res.status(500).json({ error: "TIDAL batch match failed" });
        }
    }
);

/**
 * GET /stream-info/:trackId
 * Get stream metadata (quality, codec, etc.)
 */
router.get(
    "/stream-info/:trackId",
    requireAuthOrToken,
    requireTidalStreamingEnabled,
    async (req: Request, res: Response) => {
        const userId = req.user!.id;
        const trackId = parseInt(req.params.trackId, 10);
        if (isNaN(trackId)) {
            return res.status(400).json({ error: "Invalid trackId" });
        }

        let quality = req.query.quality as string | undefined;

        try {
            const hasAuth = await ensureUserOAuth(userId);
            if (!hasAuth) {
                setTidalOAuthCache(userId, false);
                return res
                    .status(401)
                    .json({ error: "Not authenticated to TIDAL" });
            }

            if (!quality) {
                quality = await getUserPreferredTidalQuality(userId);
            }

            const info = await tidalStreamingService.getStreamInfo(
                userId,
                trackId,
                quality
            );
            res.json(info);
        } catch (err: any) {
            if (err?.response?.status === 401) {
                setTidalOAuthCache(userId, false);
            }
            logger.error("[TIDAL-STREAM] Stream info failed:", err.message);
            res.status(500).json({ error: "Failed to get stream info" });
        }
    }
);

/**
 * GET /stream/:trackId
 * Proxy audio stream from TIDAL to the browser.
 * Uses requireAuthOrToken so the audio element can authenticate
 * via query parameter.
 */
router.get(
    "/stream/:trackId",
    requireAuthOrToken,
    async (req: Request, res: Response) => {
        const userId = req.user!.id;
        const trackId = parseInt(req.params.trackId, 10);
        if (isNaN(trackId)) {
            return res.status(400).json({ error: "Invalid trackId" });
        }

        // Get user's preferred quality
        let quality = req.query.quality as string | undefined;
        if (!quality) {
            quality = await getUserPreferredTidalQuality(userId);
        }

        try {
            const hasAuth = await ensureUserOAuth(userId);
            if (!hasAuth) {
                setTidalOAuthCache(userId, false);
                return res
                    .status(401)
                    .json({ error: "Not authenticated to TIDAL" });
            }

            const rangeHeader = req.headers.range;
            const stream = await tidalStreamingService.getStreamProxy(
                userId,
                trackId,
                quality,
                rangeHeader
            );

            // Forward response headers
            const responseHeaders: Record<string, string> = {
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-cache",
            };

            if (stream.headers["content-type"]) {
                responseHeaders["Content-Type"] = stream.headers["content-type"];
            }
            if (stream.headers["content-range"]) {
                responseHeaders["Content-Range"] = stream.headers["content-range"];
            }

            res.status(stream.status);
            Object.entries(responseHeaders).forEach(([key, value]) => {
                res.setHeader(key, value);
            });

            stream.data.pipe(res);
        } catch (err: any) {
            if (err?.response?.status === 401) {
                setTidalOAuthCache(userId, false);
            }
            logger.error(
                `[TIDAL-STREAM] Stream proxy failed for track ${trackId}:`,
                err.message
            );
            if (!res.headersSent) {
                res.status(500).json({ error: "Stream failed" });
            }
        }
    }
);

export default router;
