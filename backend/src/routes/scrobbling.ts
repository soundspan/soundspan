import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireAuth } from "../middleware/auth";
import { authLimiter } from "../middleware/rateLimiter";
import { validate, type ValidatedRequest } from "../middleware/validate";
import {
    completeLastFmAuth,
    disconnectScrobbler,
    getScrobblingStatus,
    InvalidListenBrainzTokenError,
    LastFmAuthStateError,
    LastFmServerConfigurationError,
    saveListenBrainzToken,
    setScrobblerEnabled,
    startLastFmAuth,
} from "../services/scrobbleConnections";
import { sendRouteError } from "../utils/routeErrorResponse";

const router = Router();
router.use(requireAuth);

const tokenBody = z.strictObject({ token: z.string().trim().min(1).max(2048) });
const enabledBody = z.strictObject({ enabled: z.boolean() });

type TokenRequest = ValidatedRequest<{ body: typeof tokenBody }>;
type EnabledRequest = ValidatedRequest<{ body: typeof enabledBody }>;

function sendLastFmKnownError(
    error: unknown,
    res: Parameters<typeof sendRouteError>[0],
): boolean {
    if (error instanceof LastFmServerConfigurationError) {
        sendRouteError(res, 409, error.message);
        return true;
    }
    if (error instanceof LastFmAuthStateError) {
        sendRouteError(res, 409, error.message);
        return true;
    }
    return false;
}

/**
 * @openapi
 * /api/scrobbling:
 *   get:
 *     summary: Get the authenticated user's scrobbling connection status
 *     tags: [Scrobbling]
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     responses:
 *       200: { description: Non-secret connection status }
 *       401: { description: Not authenticated }
 */
router.get(
    "/",
    asyncHandler(async (req, res) => {
        res.json(await getScrobblingStatus(req.user!.id));
    }),
);

/**
 * @openapi
 * /api/scrobbling/listenbrainz:
 *   put:
 *     summary: Validate and connect a ListenBrainz user token
 *     tags: [Scrobbling]
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     responses:
 *       200: { description: ListenBrainz connected }
 *       400: { description: Invalid request }
 *       422: { description: ListenBrainz rejected the token }
 *       401: { description: Not authenticated }
 *   delete:
 *     summary: Disconnect ListenBrainz
 *     tags: [Scrobbling]
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     responses:
 *       204: { description: Disconnected }
 *       401: { description: Not authenticated }
 */
router.put(
    "/listenbrainz",
    authLimiter,
    validate({ body: tokenBody }),
    asyncHandler(async (req, res) => {
        try {
            await saveListenBrainzToken(
                req.user!.id,
                (req as TokenRequest).valid.body.token,
            );
            res.json({ connected: true, enabled: true });
        } catch (error: unknown) {
            if (error instanceof InvalidListenBrainzTokenError) {
                sendRouteError(res, 422, "ListenBrainz rejected the token");
                return;
            }
            throw error;
        }
    }),
);

router.delete(
    "/listenbrainz",
    asyncHandler(async (req, res) => {
        await disconnectScrobbler(req.user!.id, "listenbrainz");
        res.status(204).end();
    }),
);

/**
 * @openapi
 * /api/scrobbling/listenbrainz/enabled:
 *   patch:
 *     summary: Enable or disable ListenBrainz forwarding
 *     tags: [Scrobbling]
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     responses:
 *       200: { description: Updated state }
 *       400: { description: Invalid request }
 *       409: { description: ListenBrainz is not connected }
 *       401: { description: Not authenticated }
 */
router.patch(
    "/listenbrainz/enabled",
    validate({ body: enabledBody }),
    asyncHandler(async (req, res) => {
        const enabled = (req as EnabledRequest).valid.body.enabled;
        if (
            !(await setScrobblerEnabled(req.user!.id, "listenbrainz", enabled))
        ) {
            sendRouteError(res, 409, "ListenBrainz is not connected");
            return;
        }
        res.json({ connected: true, enabled });
    }),
);

/**
 * @openapi
 * /api/scrobbling/lastfm/start-auth:
 *   post:
 *     summary: Start Last.fm browser authorization
 *     tags: [Scrobbling]
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     responses:
 *       200: { description: Last.fm approval URL }
 *       409: { description: Server credentials are missing }
 *       401: { description: Not authenticated }
 */
router.post(
    "/lastfm/start-auth",
    authLimiter,
    asyncHandler(async (req, res) => {
        try {
            res.json({ approvalUrl: await startLastFmAuth(req.user!.id) });
        } catch (error: unknown) {
            if (!sendLastFmKnownError(error, res)) throw error;
        }
    }),
);

/**
 * @openapi
 * /api/scrobbling/lastfm/complete-auth:
 *   post:
 *     summary: Complete an approved Last.fm authorization
 *     tags: [Scrobbling]
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     responses:
 *       200: { description: Last.fm connected }
 *       409: { description: Server credentials or pending authorization are missing }
 *       401: { description: Not authenticated }
 */
router.post(
    "/lastfm/complete-auth",
    authLimiter,
    asyncHandler(async (req, res) => {
        try {
            const username = await completeLastFmAuth(req.user!.id);
            res.json({ connected: true, enabled: true, username });
        } catch (error: unknown) {
            if (!sendLastFmKnownError(error, res)) throw error;
        }
    }),
);

/**
 * @openapi
 * /api/scrobbling/lastfm:
 *   delete:
 *     summary: Disconnect Last.fm
 *     tags: [Scrobbling]
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     responses:
 *       204: { description: Disconnected }
 *       401: { description: Not authenticated }
 */
router.delete(
    "/lastfm",
    asyncHandler(async (req, res) => {
        await disconnectScrobbler(req.user!.id, "lastfm");
        res.status(204).end();
    }),
);

/**
 * @openapi
 * /api/scrobbling/lastfm/enabled:
 *   patch:
 *     summary: Enable or disable Last.fm forwarding
 *     tags: [Scrobbling]
 *     security: [{ bearerAuth: [] }, { apiKeyAuth: [] }]
 *     responses:
 *       200: { description: Updated state }
 *       400: { description: Invalid request }
 *       409: { description: Last.fm is not connected }
 *       401: { description: Not authenticated }
 */
router.patch(
    "/lastfm/enabled",
    validate({ body: enabledBody }),
    asyncHandler(async (req, res) => {
        const enabled = (req as EnabledRequest).valid.body.enabled;
        if (!(await setScrobblerEnabled(req.user!.id, "lastfm", enabled))) {
            sendRouteError(res, 409, "Last.fm is not connected");
            return;
        }
        res.json({ connected: true, enabled });
    }),
);

export default router;
