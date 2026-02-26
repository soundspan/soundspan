import express from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import { logger } from "../utils/logger";
import { getRuntimeDrainState } from "../utils/runtimeLifecycle";
import {
    SEGMENTED_SESSION_TOKEN_QUERY_PARAM,
    SegmentedSessionError,
    type SegmentedSessionRecord,
    segmentedStreamingSessionService,
} from "../services/segmented-streaming/sessionService";
import {
    buildSegmentedRouteTraceFields,
    buildSegmentedRouteTraceErrorFields,
    logSegmentedStreamingTrace,
} from "../services/segmented-streaming/trace";

const router = express.Router();

const createSessionSchema = z.object({
    trackId: z.string().min(1),
    sourceType: z.enum(["local"]).optional(),
    desiredQuality: z.enum(["original", "high", "medium", "low"]).optional(),
    playbackContext: z.unknown().optional(),
});

const continuitySnapshotSchema = z.object({
    positionSec: z.number().finite().min(0).optional(),
    isPlaying: z.boolean().optional(),
    bufferedUntilSec: z.number().finite().min(0).optional(),
});

const clientMetricSchema = z.object({
    event: z.string().min(1).max(128),
    fields: z.record(z.unknown()).optional(),
});

const resolveSessionToken = (req: express.Request): string | null => {
    const queryValue = req.query?.[SEGMENTED_SESSION_TOKEN_QUERY_PARAM];
    if (typeof queryValue === "string" && queryValue.trim()) {
        return queryValue.trim();
    }

    const rawHeaderValue = req.headers?.["x-streaming-session-token"];
    if (typeof rawHeaderValue === "string" && rawHeaderValue.trim()) {
        return rawHeaderValue.trim();
    }

    if (
        Array.isArray(rawHeaderValue) &&
        typeof rawHeaderValue[0] === "string" &&
        rawHeaderValue[0].trim()
    ) {
        return rawHeaderValue[0].trim();
    }

    return null;
};

interface AuthorizeSegmentedSessionOptions {
    req: express.Request;
    res: express.Response;
    metricEvent: string;
    startedAtMs: number;
    metricFields?: Record<string, unknown>;
    tokenValidationOptions?: {
        allowSessionIdMismatch?: boolean;
    };
    onSessionResolved?: (session: SegmentedSessionRecord) => void;
    onSessionNotFound?: () => void;
}

const authorizeSegmentedSessionRequest = async ({
    req,
    res,
    metricEvent,
    startedAtMs,
    metricFields = {},
    tokenValidationOptions,
    onSessionResolved,
    onSessionNotFound,
}: AuthorizeSegmentedSessionOptions): Promise<SegmentedSessionRecord | null> => {
    const sessionId = req.params.sessionId;
    const userId = req.user?.id;
    if (!userId) {
        logSegmentedStreamingMetric(metricEvent, {
            status: "reject",
            reason: "unauthorized",
            sessionId,
            ...metricFields,
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        res.status(401).json({ error: "Unauthorized" });
        return null;
    }

    const session = await segmentedStreamingSessionService.getAuthorizedSession(
        sessionId,
        userId,
    );
    if (!session) {
        logSegmentedStreamingMetric(metricEvent, {
            status: "reject",
            reason: "session_not_found",
            sessionId,
            ...metricFields,
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        onSessionNotFound?.();
        res.status(404).json({ error: "Streaming session not found" });
        return null;
    }

    onSessionResolved?.(session);
    const sessionToken = resolveSessionToken(req);
    if (tokenValidationOptions) {
        segmentedStreamingSessionService.validateSessionToken(
            session,
            sessionToken,
            tokenValidationOptions,
        );
    } else {
        segmentedStreamingSessionService.validateSessionToken(session, sessionToken);
    }

    return session;
};

const toSegmentedSessionError = (error: unknown): SegmentedSessionError | null => {
    if (error instanceof SegmentedSessionError) {
        return error;
    }

    if (
        error &&
        typeof error === "object" &&
        typeof (error as { message?: unknown }).message === "string" &&
        typeof (error as { statusCode?: unknown }).statusCode === "number" &&
        typeof (error as { code?: unknown }).code === "string"
    ) {
        return error as SegmentedSessionError;
    }

    return null;
};

const SEGMENTED_STREAMING_METRIC_PREFIX = "[SegmentedStreaming][Metric]";

const logSegmentedStreamingMetric = (
    event: string,
    fields: Record<string, unknown>,
): void => {
    logger.info(`${SEGMENTED_STREAMING_METRIC_PREFIX} ${event}`, fields);
};

const segmentedMetricDurationMs = (startedAtMs: number): number =>
    Math.max(0, Date.now() - startedAtMs);

const getSegmentedMetricErrorFields = (
    error: unknown,
): { errorCode: string; errorMessage: string; statusCode?: number } => {
    const segmentedError = toSegmentedSessionError(error);
    if (segmentedError) {
        return {
            errorCode: segmentedError.code,
            errorMessage: segmentedError.message,
            statusCode: segmentedError.statusCode,
        };
    }

    const maybeErrorCode = (error as NodeJS.ErrnoException | undefined)?.code;
    const errorCode =
        typeof maybeErrorCode === "string" ? maybeErrorCode : "UNKNOWN_ERROR";
    const errorMessage =
        error instanceof Error ? error.message : String(error ?? "Unknown error");

    return {
        errorCode,
        errorMessage,
    };
};

const handleSegmentFetch = async (
    req: express.Request,
    res: express.Response,
): Promise<express.Response> => {
    const startedAtMs = Date.now();
    let sourceType: string | undefined;
    try {
        const session = await authorizeSegmentedSessionRequest({
            req,
            res,
            metricEvent: "segment.fetch",
            startedAtMs,
            metricFields: {
                segmentName: req.params.segmentName,
            },
            tokenValidationOptions: {
                allowSessionIdMismatch: true,
            },
            onSessionResolved: (authorizedSession) => {
                sourceType = authorizedSession.sourceType;
            },
            onSessionNotFound: () => {
                logSegmentedStreamingTrace(
                    "route.segment.reject",
                    buildSegmentedRouteTraceFields(req, startedAtMs, {
                        reason: "session_not_found",
                        sessionId: req.params.sessionId,
                        segmentName: req.params.segmentName,
                    }),
                );
            },
        });
        if (!session) {
            return res;
        }

        const segmentPath = await segmentedStreamingSessionService.waitForSegmentReady(
            session,
            req.params.segmentName,
        );
        res.setHeader("Cache-Control", "private, max-age=30");
        const segmentNameLower = req.params.segmentName.toLowerCase();
        res.type(
            segmentNameLower.endsWith(".webm")
                ? "video/webm"
                : "video/iso.segment",
        );
        logSegmentedStreamingMetric("segment.fetch", {
            status: "success",
            sessionId: session.sessionId,
            sourceType: session.sourceType,
            segmentName: req.params.segmentName,
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        logSegmentedStreamingTrace(
            "route.segment.success",
            buildSegmentedRouteTraceFields(req, startedAtMs, {
                sessionId: session.sessionId,
                sourceType: session.sourceType,
                segmentName: req.params.segmentName,
            }),
        );
        res.sendFile(segmentPath);
        return res;
    } catch (error) {
        const errorFields = getSegmentedMetricErrorFields(error);
        logSegmentedStreamingMetric("segment.fetch", {
            status: "error",
            sessionId: req.params.sessionId,
            sourceType,
            segmentName: req.params.segmentName,
            ...errorFields,
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        logSegmentedStreamingTrace(
            "route.segment.error",
            buildSegmentedRouteTraceErrorFields(req, startedAtMs, errorFields, {
                sessionId: req.params.sessionId,
                sourceType,
                segmentName: req.params.segmentName,
            }),
        );
        const segmentedError = toSegmentedSessionError(error);
        if (segmentedError) {
            return res.status(segmentedError.statusCode).json({
                error: segmentedError.message,
                code: segmentedError.code,
            });
        }

        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return res.status(404).json({ error: "Segment not found" });
        }

        logger.error("[SegmentedStreaming] Failed to load segment:", error);
        return res.status(500).json({ error: "Failed to load segment" });
    }
};

router.post("/v1/sessions", requireAuth, async (req, res) => {
    const startedAtMs = Date.now();
    try {
        if (getRuntimeDrainState()) {
            logSegmentedStreamingMetric("session.create", {
                status: "reject",
                reason: "draining",
                latencyMs: segmentedMetricDurationMs(startedAtMs),
            });
            return res.status(503).json({
                error: "Streaming service is draining",
                code: "STREAMING_DRAINING",
            });
        }

        const userId = req.user?.id;
        if (!userId) {
            logSegmentedStreamingMetric("session.create", {
                status: "reject",
                reason: "unauthorized",
                latencyMs: segmentedMetricDurationMs(startedAtMs),
            });
            return res.status(401).json({ error: "Unauthorized" });
        }

        const parsedBody = createSessionSchema.safeParse(req.body ?? {});
        if (!parsedBody.success) {
            logSegmentedStreamingMetric("session.create", {
                status: "reject",
                reason: "invalid_request",
                latencyMs: segmentedMetricDurationMs(startedAtMs),
            });
            return res.status(400).json({
                error: "Invalid request body",
                details: parsedBody.error.flatten(),
            });
        }

        const sourceType = parsedBody.data.sourceType ?? "local";
        const session = await segmentedStreamingSessionService.createLocalSession({
            userId,
            trackId: parsedBody.data.trackId,
            desiredQuality: parsedBody.data.desiredQuality,
        });

        logSegmentedStreamingMetric("session.create", {
            status: "success",
            sourceType,
            sessionId: session.sessionId,
            quality: parsedBody.data.desiredQuality ?? "medium",
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        return res.status(201).json(session);
    } catch (error) {
        const errorFields = getSegmentedMetricErrorFields(error);
        logSegmentedStreamingMetric("session.create", {
            status: "error",
            ...errorFields,
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        const segmentedError = toSegmentedSessionError(error);
        if (segmentedError) {
            return res.status(segmentedError.statusCode).json({
                error: segmentedError.message,
                code: segmentedError.code,
            });
        }

        logger.error("[SegmentedStreaming] Failed to create session:", error);
        return res.status(500).json({
            error: "Failed to create segmented streaming session",
        });
    }
});

router.get("/v1/sessions/:sessionId/manifest.mpd", requireAuth, async (req, res) => {
    const startedAtMs = Date.now();
    let sourceType: string | undefined;
    try {
        const session = await authorizeSegmentedSessionRequest({
            req,
            res,
            metricEvent: "manifest.fetch",
            startedAtMs,
            tokenValidationOptions: {
                allowSessionIdMismatch: true,
            },
            onSessionResolved: (authorizedSession) => {
                sourceType = authorizedSession.sourceType;
            },
        });
        if (!session) {
            return res;
        }

        await segmentedStreamingSessionService.waitForManifestReady(session);
        res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
        res.type("application/dash+xml");
        logSegmentedStreamingMetric("manifest.fetch", {
            status: "success",
            sessionId: session.sessionId,
            sourceType: session.sourceType,
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        logSegmentedStreamingTrace(
            "route.manifest.success",
            buildSegmentedRouteTraceFields(req, startedAtMs, {
                sessionId: session.sessionId,
                sourceType: session.sourceType,
            }),
        );
        return res.sendFile(session.manifestPath);
    } catch (error) {
        const errorFields = getSegmentedMetricErrorFields(error);
        logSegmentedStreamingMetric("manifest.fetch", {
            status: "error",
            sessionId: req.params.sessionId,
            sourceType,
            ...errorFields,
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        logSegmentedStreamingTrace(
            "route.manifest.error",
            buildSegmentedRouteTraceErrorFields(req, startedAtMs, errorFields, {
                sessionId: req.params.sessionId,
                sourceType,
            }),
        );
        const segmentedError = toSegmentedSessionError(error);
        if (segmentedError) {
            return res.status(segmentedError.statusCode).json({
                error: segmentedError.message,
                code: segmentedError.code,
            });
        }

        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return res.status(404).json({ error: "Manifest not found" });
        }

        logger.error("[SegmentedStreaming] Failed to load manifest:", error);
        return res.status(500).json({ error: "Failed to load manifest" });
    }
});

router.get(
    "/v1/sessions/:sessionId/segments/:segmentName",
    requireAuth,
    handleSegmentFetch,
);

router.get(
    "/v1/sessions/:sessionId/:segmentName([A-Za-z0-9_.-]+\\.(?:m4s|webm))",
    requireAuth,
    handleSegmentFetch,
);

router.post("/v1/sessions/:sessionId/heartbeat", requireAuth, async (req, res) => {
    const startedAtMs = Date.now();
    let sourceType: string | undefined;
    try {
        const userId = req.user?.id;
        if (!userId) {
            logSegmentedStreamingMetric("session.heartbeat", {
                status: "reject",
                reason: "unauthorized",
                sessionId: req.params.sessionId,
                latencyMs: segmentedMetricDurationMs(startedAtMs),
            });
            return res.status(401).json({ error: "Unauthorized" });
        }

        const parsedBody = continuitySnapshotSchema.safeParse(req.body ?? {});
        if (!parsedBody.success) {
            logSegmentedStreamingMetric("session.heartbeat", {
                status: "reject",
                reason: "invalid_request",
                sessionId: req.params.sessionId,
                latencyMs: segmentedMetricDurationMs(startedAtMs),
            });
            return res.status(400).json({
                error: "Invalid request body",
                details: parsedBody.error.flatten(),
            });
        }

        const session = await authorizeSegmentedSessionRequest({
            req,
            res,
            metricEvent: "session.heartbeat",
            startedAtMs,
            onSessionResolved: (authorizedSession) => {
                sourceType = authorizedSession.sourceType;
            },
        });
        if (!session) {
            return res;
        }

        const heartbeat = await segmentedStreamingSessionService.heartbeatSession(
            session,
            parsedBody.data,
        );
        logSegmentedStreamingMetric("session.heartbeat", {
            status: "success",
            sessionId: session.sessionId,
            sourceType: session.sourceType,
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        return res.status(200).json(heartbeat);
    } catch (error) {
        logSegmentedStreamingMetric("session.heartbeat", {
            status: "error",
            sessionId: req.params.sessionId,
            sourceType,
            ...getSegmentedMetricErrorFields(error),
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        const segmentedError = toSegmentedSessionError(error);
        if (segmentedError) {
            return res.status(segmentedError.statusCode).json({
                error: segmentedError.message,
                code: segmentedError.code,
            });
        }

        logger.error("[SegmentedStreaming] Failed to process heartbeat:", error);
        return res.status(500).json({ error: "Failed to process streaming heartbeat" });
    }
});

router.post("/v1/sessions/:sessionId/handoff", requireAuth, async (req, res) => {
    const startedAtMs = Date.now();
    let sourceType: string | undefined;
    logSegmentedStreamingMetric("session.handoff", {
        status: "start",
        sessionId: req.params.sessionId,
        latencyMs: segmentedMetricDurationMs(startedAtMs),
    });
    try {
        const userId = req.user?.id;
        if (!userId) {
            logSegmentedStreamingMetric("session.handoff", {
                status: "reject",
                reason: "unauthorized",
                sessionId: req.params.sessionId,
                latencyMs: segmentedMetricDurationMs(startedAtMs),
            });
            return res.status(401).json({ error: "Unauthorized" });
        }

        const parsedBody = continuitySnapshotSchema.safeParse(req.body ?? {});
        if (!parsedBody.success) {
            logSegmentedStreamingMetric("session.handoff", {
                status: "reject",
                reason: "invalid_request",
                sessionId: req.params.sessionId,
                latencyMs: segmentedMetricDurationMs(startedAtMs),
            });
            return res.status(400).json({
                error: "Invalid request body",
                details: parsedBody.error.flatten(),
            });
        }

        const session = await authorizeSegmentedSessionRequest({
            req,
            res,
            metricEvent: "session.handoff",
            startedAtMs,
            onSessionResolved: (authorizedSession) => {
                sourceType = authorizedSession.sourceType;
            },
        });
        if (!session) {
            return res;
        }

        const handoff = await segmentedStreamingSessionService.createHandoffSession(
            session,
            parsedBody.data,
        );
        logSegmentedStreamingMetric("session.handoff", {
            status: "success",
            sessionId: handoff.sessionId,
            previousSessionId: handoff.previousSessionId,
            sourceType: handoff.playbackProfile?.sourceType ?? sourceType,
            resumeAtSec: handoff.resumeAtSec,
            shouldPlay: handoff.shouldPlay,
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        return res.status(201).json(handoff);
    } catch (error) {
        logSegmentedStreamingMetric("session.handoff", {
            status: "error",
            sessionId: req.params.sessionId,
            sourceType,
            ...getSegmentedMetricErrorFields(error),
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        const segmentedError = toSegmentedSessionError(error);
        if (segmentedError) {
            return res.status(segmentedError.statusCode).json({
                error: segmentedError.message,
                code: segmentedError.code,
            });
        }

        logger.error("[SegmentedStreaming] Failed to process handoff:", error);
        return res.status(500).json({ error: "Failed to process streaming handoff" });
    }
});

router.post("/v1/client-metrics", requireAuth, async (req, res) => {
    const startedAtMs = Date.now();
    try {
        const userId = req.user?.id;
        if (!userId) {
            logSegmentedStreamingMetric("client.signal", {
                status: "reject",
                reason: "unauthorized",
                latencyMs: segmentedMetricDurationMs(startedAtMs),
            });
            return res.status(401).json({ error: "Unauthorized" });
        }

        const parsedBody = clientMetricSchema.safeParse(req.body ?? {});
        if (!parsedBody.success) {
            logSegmentedStreamingMetric("client.signal", {
                status: "reject",
                reason: "invalid_request",
                latencyMs: segmentedMetricDurationMs(startedAtMs),
            });
            return res.status(400).json({
                error: "Invalid request body",
                details: parsedBody.error.flatten(),
            });
        }

        const fields = parsedBody.data.fields ?? {};
        const sessionId =
            typeof fields.sessionId === "string" ? fields.sessionId : undefined;
        const sourceType =
            typeof fields.sourceType === "string" ? fields.sourceType : undefined;
        const trackId =
            typeof fields.trackId === "string" ? fields.trackId : undefined;
        const startupTimelineFields: Record<string, unknown> = {};
        if (parsedBody.data.event === "player.startup_timeline") {
            const eventFields = fields as Record<string, unknown>;
            const stringFieldNames = ["outcome", "initSource", "firstChunkName"] as const;
            for (const fieldName of stringFieldNames) {
                const value = eventFields[fieldName];
                if (typeof value === "string" && value.length > 0) {
                    startupTimelineFields[fieldName] = value;
                }
            }
            const numericFieldNames = [
                "loadId",
                "startupRetryCount",
                "createLatencyMs",
                "createToManifestMs",
                "manifestToFirstChunkMs",
                "firstChunkToAudibleMs",
                "totalToAudibleMs",
            ] as const;
            for (const fieldName of numericFieldNames) {
                const value = eventFields[fieldName];
                if (typeof value === "number" && Number.isFinite(value)) {
                    startupTimelineFields[fieldName] = value;
                }
            }
        }

        logSegmentedStreamingMetric("client.signal", {
            status: "success",
            event: parsedBody.data.event,
            sessionId,
            sourceType,
            trackId,
            userId,
            ...startupTimelineFields,
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        logSegmentedStreamingTrace(
            "route.client.signal",
            buildSegmentedRouteTraceFields(req, startedAtMs, {
                event: parsedBody.data.event,
                sessionId,
                sourceType,
                trackId,
                userId,
                fields,
            }),
        );

        return res.status(202).json({ accepted: true });
    } catch (error) {
        logSegmentedStreamingMetric("client.signal", {
            status: "error",
            ...getSegmentedMetricErrorFields(error),
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        logger.error("[SegmentedStreaming] Failed to ingest client signal:", error);
        return res.status(500).json({ error: "Failed to ingest client signal" });
    }
});

export default router;
