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
import { z } from "zod";
import { requireAuth, requireAuthOrToken } from "../middleware/auth";
import { tidalStreamingService } from "../services/tidalStreaming";
import { prisma } from "../utils/db";
import { encrypt, decrypt } from "../utils/encryption";
import { logger } from "../utils/logger";
import { trackMappingService } from "../services/trackMappingService";
import { coalesceInFlightByKey } from "../utils/singleflight";
import { config } from "../config";

const router = Router();
const OAUTH_CACHE_TTL_MS = config.nodeEnv === "test" ? 0 : 60_000;
const OAUTH_NEGATIVE_CACHE_TTL_MS = config.nodeEnv === "test" ? 0 : 15_000;
const tidalOauthSessionCache = new Map<
    string,
    { authenticated: boolean; expiresAt: number }
>();
const tidalOauthRestoreInFlight = new Map<string, Promise<boolean>>();
const tidalOauthClearInFlight = new Map<string, Promise<void>>();
const tidalOauthCredentialInFlight = new Map<string, Set<Promise<unknown>>>();
const tidalOauthGeneration = new Map<string, number>();
const setTidalOAuthCache = (
    userId: string,
    authenticated: boolean,
    ttlMs = OAUTH_CACHE_TTL_MS,
) => {
    if (ttlMs <= 0) {
        tidalOauthSessionCache.delete(userId);
        return;
    }
    if (!authenticated) {
        // Cache negative results with a shorter TTL so non-linked users
        // don't hit sidecar/DB on every browse/stream request, while still
        // picking up new OAuth links within a reasonable window.
        tidalOauthSessionCache.set(userId, {
            authenticated: false,
            expiresAt: Date.now() + OAUTH_NEGATIVE_CACHE_TTL_MS,
        });
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

const invalidateTidalOAuthGeneration = (userId: string): number => {
    const generation = (tidalOauthGeneration.get(userId) ?? 0) + 1;
    tidalOauthGeneration.set(userId, generation);
    tidalOauthSessionCache.delete(userId);
    return generation;
};

const getTidalOAuthGeneration = (userId: string): number =>
    tidalOauthGeneration.get(userId) ?? 0;

const isCurrentTidalOAuthGeneration = (
    userId: string,
    generation: number,
): boolean => getTidalOAuthGeneration(userId) === generation;

function trackTidalOAuthCredentialOperation<T>(
    userId: string,
    factory: () => Promise<T>,
): Promise<T> {
    const operations =
        tidalOauthCredentialInFlight.get(userId) ?? new Set<Promise<unknown>>();
    tidalOauthCredentialInFlight.set(userId, operations);

    let trackedOperation: Promise<T>;
    trackedOperation = Promise.resolve()
        .then(factory)
        .finally(() => {
            operations.delete(trackedOperation);
            if (operations.size === 0) {
                tidalOauthCredentialInFlight.delete(userId);
            }
        });
    operations.add(trackedOperation);
    return trackedOperation;
}

async function runTidalOAuthCredentialOperation<T>(
    userId: string,
    factory: (generation: number) => Promise<T>,
): Promise<T> {
    const clearInFlight = tidalOauthClearInFlight.get(userId);
    if (clearInFlight) {
        await clearInFlight;
    }

    const generation = getTidalOAuthGeneration(userId);
    return trackTidalOAuthCredentialOperation(userId, () =>
        factory(generation),
    );
}

// ── Guard middleware ───────────────────────────────────────────────

/**
 * Require that TIDAL streaming is enabled (admin toggle) AND the
 * sidecar is reachable.
 */
async function requireTidalStreamingEnabled(
    req: Request,
    res: Response,
    next: Function,
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

    return runTidalOAuthCredentialOperation(userId, (generation) =>
        coalesceInFlightByKey(tidalOauthRestoreInFlight, userId, () =>
            restoreTidalUserOAuth(userId, generation),
        ),
    );
}

async function finishTidalOAuthRestore(
    userId: string,
    generation: number,
    authenticated: boolean,
): Promise<boolean> {
    if (isCurrentTidalOAuthGeneration(userId, generation)) {
        setTidalOAuthCache(userId, authenticated);
        return authenticated;
    }

    await tidalStreamingService.clearAuth(userId);
    return false;
}

async function restoreTidalUserOAuth(
    userId: string,
    generation: number,
): Promise<boolean> {
    // This authenticated client carries the internal secret; a bare request
    // would 403 and be misread as a missing sidecar session.
    try {
        const authenticated =
            await tidalStreamingService.checkSidecarAuthStatus(userId);
        if (!isCurrentTidalOAuthGeneration(userId, generation)) {
            return finishTidalOAuthRestore(userId, generation, false);
        }
        if (authenticated) {
            return finishTidalOAuthRestore(userId, generation, true);
        }
    } catch {
        // Sidecar might not have the session, try to restore.
    }

    const userSettings = await prisma.userSettings.findUnique({
        where: { userId },
        select: { tidalOAuthJson: true },
    });
    if (!isCurrentTidalOAuthGeneration(userId, generation)) {
        return finishTidalOAuthRestore(userId, generation, false);
    }
    if (!userSettings?.tidalOAuthJson) {
        return finishTidalOAuthRestore(userId, generation, false);
    }

    let oauthJson: string;
    try {
        oauthJson = decrypt(userSettings.tidalOAuthJson);
    } catch {
        oauthJson = userSettings.tidalOAuthJson;
    }

    const restored = await tidalStreamingService.restoreOAuth(
        userId,
        oauthJson,
    );
    return finishTidalOAuthRestore(userId, generation, restored);
}

async function clearTidalUserOAuth(userId: string): Promise<void> {
    const existingClear = tidalOauthClearInFlight.get(userId);
    if (existingClear) {
        return existingClear;
    }

    const generation = invalidateTidalOAuthGeneration(userId);
    const pendingCredentials = [
        ...(tidalOauthCredentialInFlight.get(userId) ?? []),
    ];
    const clearOperation = performTidalOAuthClear(
        userId,
        generation,
        pendingCredentials,
    ).finally(() => {
        if (tidalOauthClearInFlight.get(userId) === clearOperation) {
            tidalOauthClearInFlight.delete(userId);
        }
    });
    tidalOauthClearInFlight.set(userId, clearOperation);
    return clearOperation;
}

async function performTidalOAuthClear(
    userId: string,
    generation: number,
    pendingCredentials: ReadonlyArray<Promise<unknown>>,
): Promise<void> {
    await Promise.allSettled(pendingCredentials);
    await prisma.userSettings.update({
        where: { userId },
        data: { tidalOAuthJson: null },
    });
    await tidalStreamingService.clearAuth(userId);
    if (isCurrentTidalOAuthGeneration(userId, generation)) {
        setTidalOAuthCache(userId, false);
    }
}

async function rollbackTidalOAuthCredential(userId: string): Promise<void> {
    await prisma.userSettings.update({
        where: { userId },
        data: { tidalOAuthJson: null },
    });
    await tidalStreamingService.clearAuth(userId);
}

async function persistTidalOAuthCredential(
    userId: string,
    generation: number,
    oauthJson: string,
): Promise<boolean> {
    const encryptedOAuth = encrypt(oauthJson);
    if (!isCurrentTidalOAuthGeneration(userId, generation)) return false;

    await prisma.userSettings.upsert({
        where: { userId },
        update: { tidalOAuthJson: encryptedOAuth },
        create: { userId, tidalOAuthJson: encryptedOAuth },
    });
    if (!isCurrentTidalOAuthGeneration(userId, generation)) {
        await rollbackTidalOAuthCredential(userId);
        return false;
    }

    await tidalStreamingService.restoreOAuth(userId, oauthJson);
    if (!isCurrentTidalOAuthGeneration(userId, generation)) {
        await rollbackTidalOAuthCredential(userId);
        return false;
    }

    setTidalOAuthCache(userId, true);
    return true;
}

type TidalOAuthPollResponse =
    | { status: "pending" }
    | {
          status: "success";
          username: string | undefined;
          country_code: string;
      };

async function pollTidalOAuthCredential(
    userId: string,
    generation: number,
    deviceCode: string,
): Promise<TidalOAuthPollResponse> {
    if (!isCurrentTidalOAuthGeneration(userId, generation)) {
        return { status: "pending" };
    }
    const tokens = await tidalStreamingService.pollDeviceAuth(deviceCode);
    if (!tokens) return { status: "pending" };

    const oauthJson = JSON.stringify({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        tidal_user_id: tokens.user_id,
        country_code: tokens.country_code,
        username: tokens.username,
    });
    const persisted = await persistTidalOAuthCredential(
        userId,
        generation,
        oauthJson,
    );
    if (!persisted) return { status: "pending" };

    return {
        status: "success",
        username: tokens.username,
        country_code: tokens.country_code,
    };
}

// ── Routes ─────────────────────────────────────────────────────────

// Auth is applied per-route so that stream endpoints can use
// requireAuthOrToken (query-param token for the audio element).

/**
 * @openapi
 * /api/tidal-streaming/status:
 *   get:
 *     summary: Check TIDAL streaming availability for the current user
 *     tags: [TIDAL Streaming]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: TIDAL streaming status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                 available:
 *                   type: boolean
 *                 authenticated:
 *                   type: boolean
 *                 credentialsConfigured:
 *                   type: boolean
 *       401:
 *         description: Not authenticated
 */
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
        const authenticated =
            enabled && available ? await ensureUserOAuth(userId) : false;

        res.json({
            enabled,
            available,
            authenticated,
            credentialsConfigured: authStatus.credentialsConfigured,
        });
    } catch (err: any) {
        logger.error("[TIDAL-STREAM] Status check failed:", err.message);
        res.status(500).json({ error: "Failed to check TIDAL status" });
    }
});

/**
 * @openapi
 * /api/tidal-streaming/auth/device-code:
 *   post:
 *     summary: Initiate TIDAL device-code OAuth flow
 *     tags: [TIDAL Streaming]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Device code and verification URI
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 device_code:
 *                   type: string
 *                 user_code:
 *                   type: string
 *                 verification_uri:
 *                   type: string
 *                 verification_uri_complete:
 *                   type: string
 *                 expires_in:
 *                   type: integer
 *                 interval:
 *                   type: integer
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: TIDAL streaming is not enabled
 *       503:
 *         description: TIDAL service is not available
 */
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
    },
);

/**
 * @openapi
 * /api/tidal-streaming/auth/device-code/poll:
 *   post:
 *     summary: Poll for TIDAL device-code auth completion
 *     tags: [TIDAL Streaming]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - deviceCode
 *             properties:
 *               deviceCode:
 *                 type: string
 *     responses:
 *       200:
 *         description: Auth status (pending or success with username)
 *       400:
 *         description: deviceCode is required
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: TIDAL streaming is not enabled
 *       503:
 *         description: TIDAL service is not available
 */
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
            const result = await runTidalOAuthCredentialOperation(
                userId,
                (generation) =>
                    pollTidalOAuthCredential(
                        userId,
                        generation,
                        parsed.data.deviceCode,
                    ),
            );
            res.json(result);
        } catch (err: unknown) {
            logger.error(
                "[TIDAL-STREAM] Poll auth failed:",
                err instanceof Error ? err.message : String(err),
            );
            res.status(500).json({
                status: "error",
                error: "Device-code poll failed",
            });
        }
    },
);

/**
 * @openapi
 * /api/tidal-streaming/auth/save-token:
 *   post:
 *     summary: Save a TIDAL OAuth token manually
 *     tags: [TIDAL Streaming]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - oauthJson
 *             properties:
 *               oauthJson:
 *                 type: string
 *     responses:
 *       200:
 *         description: Token saved successfully
 *       400:
 *         description: oauthJson is required
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: TIDAL streaming is not enabled
 *       503:
 *         description: TIDAL service is not available
 */
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
            const success = await runTidalOAuthCredentialOperation(
                userId,
                (generation) =>
                    persistTidalOAuthCredential(
                        userId,
                        generation,
                        parsed.data.oauthJson,
                    ),
            );
            res.json({ success });
        } catch (err: any) {
            logger.error("[TIDAL-STREAM] Save token failed:", err.message);
            res.status(500).json({ error: "Failed to save TIDAL token" });
        }
    },
);

/**
 * @openapi
 * /api/tidal-streaming/auth/clear:
 *   post:
 *     summary: Clear the user's TIDAL auth credentials
 *     tags: [TIDAL Streaming]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: TIDAL auth cleared
 *       401:
 *         description: Not authenticated
 */
/**
 * POST /auth/clear
 * Clear user's TIDAL auth credentials.
 */
router.post("/auth/clear", requireAuth, async (req: Request, res: Response) => {
    const userId = req.user!.id;

    try {
        await clearTidalUserOAuth(userId);

        res.json({ success: true });
    } catch (err: any) {
        logger.error("[TIDAL-STREAM] Clear auth failed:", err.message);
        res.status(500).json({ error: "Failed to clear TIDAL auth" });
    }
});

/**
 * @openapi
 * /api/tidal-streaming/search:
 *   post:
 *     summary: Search TIDAL catalog using the user's credentials
 *     tags: [TIDAL Streaming]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - query
 *             properties:
 *               query:
 *                 type: string
 *               filter:
 *                 type: string
 *     responses:
 *       200:
 *         description: TIDAL search results
 *       400:
 *         description: query is required
 *       401:
 *         description: Not authenticated or not authenticated to TIDAL
 *       404:
 *         description: TIDAL streaming is not enabled
 *       503:
 *         description: TIDAL service is not available
 */
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
                parsed.data.query,
            );
            res.json(results);
        } catch (err: any) {
            logger.error("[TIDAL-STREAM] Search failed:", err.message);
            res.status(500).json({ error: "TIDAL search failed" });
        }
    },
);

/**
 * @openapi
 * /api/tidal-streaming/match:
 *   post:
 *     summary: Match a single track against the TIDAL catalog
 *     tags: [TIDAL Streaming]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - artist
 *               - title
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
 *         description: Matched TIDAL track or null
 *       400:
 *         description: artist and title are required
 *       401:
 *         description: Not authenticated or not authenticated to TIDAL
 *       404:
 *         description: TIDAL streaming is not enabled
 *       503:
 *         description: TIDAL service is not available
 */
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
                parsed.data.isrc,
            );
            res.json({ match });
        } catch (err: any) {
            logger.error("[TIDAL-STREAM] Match failed:", err.message);
            res.status(500).json({ error: "TIDAL match failed" });
        }
    },
);

/**
 * @openapi
 * /api/tidal-streaming/match-batch:
 *   post:
 *     summary: Batch match tracks against TIDAL for album gap-fill
 *     tags: [TIDAL Streaming]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - tracks
 *             properties:
 *               tracks:
 *                 type: array
 *                 maxItems: 50
 *                 items:
 *                   type: object
 *                   required:
 *                     - artist
 *                     - title
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
 *         description: Array of matched TIDAL tracks
 *       400:
 *         description: tracks array is required
 *       401:
 *         description: Not authenticated or not authenticated to TIDAL
 *       404:
 *         description: TIDAL streaming is not enabled
 *       503:
 *         description: TIDAL service is not available
 */
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
                    }),
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
                parsed.data.tracks,
            );

            // Fire-and-forget: persist matched tracks as TrackTidal rows
            Promise.resolve().then(async () => {
                try {
                    for (let i = 0; i < matches.length; i++) {
                        const match = matches[i];
                        if (!match) continue;
                        const inputTrack = parsed.data.tracks[i];
                        await trackMappingService.upsertTrackTidal({
                            tidalId: match.id,
                            title: match.title,
                            artist: match.artist,
                            album: inputTrack.albumTitle || "",
                            duration: match.duration,
                            isrc: match.isrc,
                        });
                    }
                } catch (err) {
                    logger.warn(
                        "[TIDAL-STREAM] Failed to persist gap-fill TrackTidal rows:",
                        err,
                    );
                }
            });

            res.json({ matches });
        } catch (err: any) {
            logger.error("[TIDAL-STREAM] Batch match failed:", err.message);
            res.status(500).json({ error: "TIDAL batch match failed" });
        }
    },
);

/**
 * @openapi
 * /api/tidal-streaming/stream-info/{trackId}:
 *   get:
 *     summary: Get TIDAL stream metadata (quality, codec, etc.)
 *     tags: [TIDAL Streaming]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: trackId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: quality
 *         schema:
 *           type: string
 *         description: Desired stream quality (defaults to user preference)
 *     responses:
 *       200:
 *         description: Stream info including quality and codec details
 *       400:
 *         description: Invalid trackId
 *       401:
 *         description: Not authenticated or not authenticated to TIDAL
 *       404:
 *         description: TIDAL streaming is not enabled
 *       503:
 *         description: TIDAL service is not available
 */
/**
 * GET /stream-info/:trackId
 * Get stream metadata (quality, codec, etc.)
 */
router.get(
    "/stream-info/:trackId",
    requireAuthOrToken,
    requireTidalStreamingEnabled,
    async (req: Request<{ trackId: string }>, res: Response) => {
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
                quality =
                    await tidalStreamingService.getUserPreferredQuality(userId);
            }

            const info = await tidalStreamingService.getStreamInfo(
                userId,
                trackId,
                quality,
            );
            res.json(info);
        } catch (err: any) {
            if (err?.response?.status === 401) {
                setTidalOAuthCache(userId, false);
            }
            logger.error("[TIDAL-STREAM] Stream info failed:", err.message);
            res.status(500).json({ error: "Failed to get stream info" });
        }
    },
);

/**
 * @openapi
 * /api/tidal-streaming/stream/{trackId}:
 *   get:
 *     summary: Proxy audio stream from TIDAL to the browser
 *     tags: [TIDAL Streaming]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: trackId
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: quality
 *         schema:
 *           type: string
 *         description: Desired stream quality (defaults to user preference)
 *       - in: header
 *         name: Range
 *         schema:
 *           type: string
 *         description: HTTP range header for partial content
 *     responses:
 *       200:
 *         description: Audio stream data
 *       206:
 *         description: Partial audio stream data (range request)
 *       400:
 *         description: Invalid trackId
 *       401:
 *         description: Not authenticated or not authenticated to TIDAL
 */
/**
 * GET /stream/:trackId
 * Proxy audio stream from TIDAL to the browser.
 * Uses requireAuthOrToken so the audio element can authenticate
 * via query parameter.
 */
router.get(
    "/stream/:trackId",
    requireAuthOrToken,
    async (req: Request<{ trackId: string }>, res: Response) => {
        const userId = req.user!.id;
        const trackId = parseInt(req.params.trackId, 10);
        if (isNaN(trackId)) {
            return res.status(400).json({ error: "Invalid trackId" });
        }

        // Get user's preferred quality
        let quality = req.query.quality as string | undefined;
        if (!quality) {
            quality =
                await tidalStreamingService.getUserPreferredQuality(userId);
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
                rangeHeader,
            );

            // Forward response headers
            const responseHeaders: Record<string, string> = {
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-cache",
            };

            if (stream.headers["content-type"]) {
                responseHeaders["Content-Type"] =
                    stream.headers["content-type"];
            }
            if (stream.headers["content-range"]) {
                responseHeaders["Content-Range"] =
                    stream.headers["content-range"];
            }

            res.status(stream.status);
            Object.entries(responseHeaders).forEach(([key, value]) => {
                res.setHeader(key, value);
            });

            stream.data.on("error", (streamErr: Error) => {
                logger.warn(
                    `[TIDAL-STREAM] Upstream stream error for track ${trackId}: ${streamErr.message}`,
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
                    stream.data &&
                    typeof stream.data.destroy === "function" &&
                    !stream.data.destroyed
                ) {
                    stream.data.destroy();
                }
            });
            stream.data.pipe(res);
        } catch (err: any) {
            if (err?.response?.status === 401) {
                setTidalOAuthCache(userId, false);
            }
            logger.error(
                `[TIDAL-STREAM] Stream proxy failed for track ${trackId}:`,
                err.message,
            );
            if (!res.headersSent) {
                res.status(500).json({ error: "Stream failed" });
            }
        }
    },
);

export default router;
