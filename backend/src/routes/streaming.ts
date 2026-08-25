/** Playback client-signal ingest. The DASH session surface was removed per issue #534. */
import express from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import {
    buildPlaybackRouteTraceFields,
    logPlaybackMetric,
    logPlaybackTrace,
    playbackTraceDurationMs,
} from "../services/playbackTrace";
import { logger } from "../utils/logger";
import {
    sendInternalRouteError,
    sendRouteError,
} from "../utils/routeErrorResponse";

const router = express.Router();
const playbackRouteLogger = logger.child("Playback");

const clientMetricSchema = z.object({
    event: z.string().min(1).max(128),
    fields: z.record(z.string(), z.unknown()).optional(),
});

function optionalStringField(
    fields: Record<string, unknown>,
    name: string,
): string | undefined {
    const value = fields[name];
    return typeof value === "string" ? value : undefined;
}

function rejectClientMetric(
    res: express.Response,
    startedAtMs: number,
    statusCode: 400 | 401,
    reason: "invalid_request" | "unauthorized",
    details?: unknown,
): express.Response {
    logPlaybackMetric("client.signal", {
        status: "reject",
        reason,
        latencyMs: playbackTraceDurationMs(startedAtMs),
    });
    return sendRouteError(
        res,
        statusCode,
        statusCode === 401 ? "Unauthorized" : "Invalid request body",
        details === undefined ? undefined : { details },
    );
}

function acceptClientMetric(
    req: express.Request,
    res: express.Response,
    startedAtMs: number,
    userId: string,
    data: z.infer<typeof clientMetricSchema>,
): express.Response {
    const { event } = data;
    const fields = data.fields ?? {};
    const sessionId = optionalStringField(fields, "sessionId");
    const sourceType = optionalStringField(fields, "sourceType");
    const trackId = optionalStringField(fields, "trackId");
    logPlaybackMetric("client.signal", {
        status: "success",
        event,
        sessionId,
        sourceType,
        trackId,
        userId,
        latencyMs: playbackTraceDurationMs(startedAtMs),
    });
    logPlaybackTrace(
        "playback.client.signal",
        buildPlaybackRouteTraceFields(req, startedAtMs, {
            event,
            sessionId,
            sourceType,
            trackId,
            userId,
            fields,
        }),
    );
    return res.status(202).json({ accepted: true });
}

function handleClientMetric(
    req: express.Request,
    res: express.Response,
): express.Response {
    const startedAtMs = Date.now();
    try {
        const userId = req.user?.id;
        if (!userId) {
            return rejectClientMetric(res, startedAtMs, 401, "unauthorized");
        }

        const parsedBody = clientMetricSchema.safeParse(req.body ?? {});
        if (!parsedBody.success) {
            return rejectClientMetric(
                res,
                startedAtMs,
                400,
                "invalid_request",
                parsedBody.error.flatten(),
            );
        }
        return acceptClientMetric(
            req,
            res,
            startedAtMs,
            userId,
            parsedBody.data,
        );
    } catch (error) {
        logPlaybackMetric("client.signal", {
            status: "error",
            latencyMs: playbackTraceDurationMs(startedAtMs),
        });
        playbackRouteLogger.error("Failed to ingest client signal", error);
        return sendInternalRouteError(res, "Failed to ingest client signal");
    }
}

/**
 * @openapi
 * /api/streaming/v1/client-metrics:
 *   post:
 *     summary: Ingest client-side playback metrics and signals
 *     tags: [Streaming]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - event
 *             properties:
 *               event:
 *                 type: string
 *                 maxLength: 128
 *               fields:
 *                 type: object
 *     responses:
 *       202:
 *         description: Playback signal accepted
 *       400:
 *         description: Invalid request body
 *       401:
 *         description: Not authenticated
 */
router.post("/v1/client-metrics", requireAuth, handleClientMetric);

export default router;
