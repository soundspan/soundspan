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
    manifestProfile: z.enum(["startup_single", "steady_state_dual"]).optional(),
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

interface SegmentedStartupCorrelationFields {
    startupLoadId?: number;
    startupCorrelationId?: string;
}

const SEGMENTED_STARTUP_LOAD_ID_HEADER = "x-segmented-startup-load-id";
const SEGMENTED_STARTUP_CORRELATION_ID_HEADER =
    "x-segmented-startup-correlation-id";

const resolveOptionalRequestHeader = (
    req: express.Request,
    headerName: string,
): string | null => {
    const headerValue = req.headers?.[headerName];
    if (typeof headerValue === "string" && headerValue.trim()) {
        return headerValue.trim();
    }
    if (
        Array.isArray(headerValue) &&
        typeof headerValue[0] === "string" &&
        headerValue[0].trim()
    ) {
        return headerValue[0].trim();
    }
    return null;
};

const resolveSegmentedStartupCorrelationFields = (
    req: express.Request,
): SegmentedStartupCorrelationFields => {
    const startupCorrelationId = resolveOptionalRequestHeader(
        req,
        SEGMENTED_STARTUP_CORRELATION_ID_HEADER,
    );
    const rawStartupLoadId = resolveOptionalRequestHeader(
        req,
        SEGMENTED_STARTUP_LOAD_ID_HEADER,
    );
    const parsedStartupLoadId =
        rawStartupLoadId === null ? Number.NaN : Number(rawStartupLoadId);

    return {
        startupLoadId: Number.isFinite(parsedStartupLoadId)
            ? parsedStartupLoadId
            : undefined,
        startupCorrelationId: startupCorrelationId ?? undefined,
    };
};

type SegmentedStartupHintStage = "session_create" | "manifest" | "segment";
type SegmentedStartupHintState = "waiting" | "blocked" | "failed";

interface SegmentedStartupHint {
    stage: SegmentedStartupHintStage;
    state: SegmentedStartupHintState;
    transient: boolean;
    reason: string;
    retryAfterMs: number | null;
}

interface SegmentedStartupHintProfile {
    state: SegmentedStartupHintState;
    transient: boolean;
    reason: string;
    retryAfterMs: number | null;
}

const SEGMENTED_STARTUP_DEFAULT_RETRY_AFTER_MS = 1_000;
const SEGMENTED_STARTUP_ASSET_BUILD_FAILED_REASON = "asset_build_failed";

const SEGMENTED_STARTUP_TRANSIENT_ASSET_BUILD_FAILURE_PATTERNS = [
    /\bEAGAIN\b/i,
    /\bECONNRESET\b/i,
    /\bECONNREFUSED\b/i,
    /\bEPIPE\b/i,
    /\bETIMEDOUT\b/i,
    /\bENET(?:DOWN|UNREACH)\b/i,
    /\bEHOSTUNREACH\b/i,
    /\btimed out\b/i,
    /\btimeout\b/i,
    /resource temporarily unavailable/i,
    /temporar(?:y|ily) unavailable/i,
] as const;

const isTransientAssetBuildFailureMessage = (
    errorMessage: string | undefined,
): boolean => {
    if (!errorMessage) {
        return false;
    }

    return SEGMENTED_STARTUP_TRANSIENT_ASSET_BUILD_FAILURE_PATTERNS.some(
        (pattern) => pattern.test(errorMessage),
    );
};

const resolveAssetBuildFailedStartupHintProfile = (
    errorMessage: string | undefined,
): SegmentedStartupHintProfile =>
    isTransientAssetBuildFailureMessage(errorMessage)
        ? {
              state: "waiting",
              transient: true,
              reason: SEGMENTED_STARTUP_ASSET_BUILD_FAILED_REASON,
              retryAfterMs: SEGMENTED_STARTUP_DEFAULT_RETRY_AFTER_MS,
          }
        : {
              state: "failed",
              transient: false,
              reason: SEGMENTED_STARTUP_ASSET_BUILD_FAILED_REASON,
              retryAfterMs: null,
          };

const SEGMENTED_STARTUP_HINT_BY_CODE: Record<string, SegmentedStartupHintProfile> = {
    STREAMING_DRAINING: {
        state: "waiting",
        transient: true,
        reason: "runtime_draining",
        retryAfterMs: SEGMENTED_STARTUP_DEFAULT_RETRY_AFTER_MS,
    },
    STREAMING_ASSET_NOT_READY: {
        state: "waiting",
        transient: true,
        reason: "asset_not_ready",
        retryAfterMs: SEGMENTED_STARTUP_DEFAULT_RETRY_AFTER_MS,
    },
    STREAMING_ASSET_BUILD_FAILED: {
        state: "failed",
        transient: false,
        reason: SEGMENTED_STARTUP_ASSET_BUILD_FAILED_REASON,
        retryAfterMs: null,
    },
    STREAMING_SESSION_TOKEN_REQUIRED: {
        state: "blocked",
        transient: false,
        reason: "session_token_required",
        retryAfterMs: null,
    },
    STREAMING_SESSION_TOKEN_INVALID: {
        state: "blocked",
        transient: false,
        reason: "session_token_invalid",
        retryAfterMs: null,
    },
    STREAMING_SESSION_TOKEN_EXPIRED: {
        state: "blocked",
        transient: false,
        reason: "session_token_expired",
        retryAfterMs: null,
    },
    STREAMING_SESSION_TOKEN_SCOPE_MISMATCH: {
        state: "blocked",
        transient: false,
        reason: "session_token_scope_mismatch",
        retryAfterMs: null,
    },
};

const SEGMENTED_STARTUP_HINT_BY_REASON: Record<string, SegmentedStartupHintProfile> = {
    unauthorized: {
        state: "blocked",
        transient: false,
        reason: "unauthorized",
        retryAfterMs: null,
    },
    invalid_request: {
        state: "failed",
        transient: false,
        reason: "invalid_request",
        retryAfterMs: null,
    },
    session_not_found: {
        state: "failed",
        transient: false,
        reason: "session_not_found",
        retryAfterMs: null,
    },
    manifest_not_found: {
        state: "failed",
        transient: false,
        reason: "manifest_not_found",
        retryAfterMs: null,
    },
    segment_not_found: {
        state: "failed",
        transient: false,
        reason: "segment_not_found",
        retryAfterMs: null,
    },
    runtime_draining: {
        state: "waiting",
        transient: true,
        reason: "runtime_draining",
        retryAfterMs: SEGMENTED_STARTUP_DEFAULT_RETRY_AFTER_MS,
    },
    asset_not_ready: {
        state: "waiting",
        transient: true,
        reason: "asset_not_ready",
        retryAfterMs: SEGMENTED_STARTUP_DEFAULT_RETRY_AFTER_MS,
    },
};

const normalizeSegmentedStartupReason = (
    value: string | undefined,
): string | null => {
    if (!value) {
        return null;
    }

    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return normalized.length > 0 ? normalized : null;
};

const resolveSegmentedStartupHint = ({
    stage,
    statusCode,
    code,
    reason,
    errorMessage,
}: {
    stage: SegmentedStartupHintStage;
    statusCode: number;
    code?: string;
    reason?: string;
    errorMessage?: string;
}): SegmentedStartupHint => {
    const normalizedReason = normalizeSegmentedStartupReason(reason);
    const profileByCode =
        code === "STREAMING_ASSET_BUILD_FAILED"
            ? resolveAssetBuildFailedStartupHintProfile(errorMessage)
            : code
              ? SEGMENTED_STARTUP_HINT_BY_CODE[code]
              : undefined;
    const profileByReason = normalizedReason
        ? SEGMENTED_STARTUP_HINT_BY_REASON[normalizedReason]
        : undefined;
    const fallbackReason =
        normalizedReason ??
        normalizeSegmentedStartupReason(code) ??
        (statusCode >= 500 ? "startup_unavailable" : "startup_rejected");
    const fallbackProfile: SegmentedStartupHintProfile =
        statusCode === 429 || statusCode === 503
            ? {
                  state: "waiting",
                  transient: true,
                  reason: fallbackReason,
                  retryAfterMs: SEGMENTED_STARTUP_DEFAULT_RETRY_AFTER_MS,
              }
            : statusCode === 401 || statusCode === 403
              ? {
                    state: "blocked",
                    transient: false,
                    reason: fallbackReason,
                    retryAfterMs: null,
                }
              : {
                    state: "failed",
                    transient: false,
                    reason: fallbackReason,
                    retryAfterMs: null,
                };
    const resolvedProfile = profileByCode ?? profileByReason ?? fallbackProfile;

    return {
        stage,
        state: resolvedProfile.state,
        transient: resolvedProfile.transient,
        reason: resolvedProfile.reason,
        retryAfterMs: resolvedProfile.retryAfterMs,
    };
};

const respondWithSegmentedStartupError = ({
    res,
    stage,
    statusCode,
    error,
    code,
    reason,
    details,
}: {
    res: express.Response;
    stage: SegmentedStartupHintStage;
    statusCode: number;
    error: string;
    code?: string;
    reason?: string;
    details?: unknown;
}): express.Response => {
    const startupHint = resolveSegmentedStartupHint({
        stage,
        statusCode,
        code,
        reason,
        errorMessage: error,
    });
    if (
        startupHint.transient &&
        typeof startupHint.retryAfterMs === "number" &&
        startupHint.retryAfterMs > 0
    ) {
        res.setHeader(
            "Retry-After",
            String(Math.max(1, Math.ceil(startupHint.retryAfterMs / 1_000))),
        );
    }

    const payload: Record<string, unknown> = {
        error,
        startupHint,
    };
    if (code) {
        payload.code = code;
    }
    if (typeof details !== "undefined") {
        payload.details = details;
    }

    return res.status(statusCode).json(payload);
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
    startupHintStage?: SegmentedStartupHintStage;
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
    startupHintStage,
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
        /* istanbul ignore else -- non-startup callers pre-check auth before invoking this helper */
        if (startupHintStage) {
            respondWithSegmentedStartupError({
                res,
                stage: startupHintStage,
                statusCode: 401,
                error: "Unauthorized",
                reason: "unauthorized",
            });
        } else {
            res.status(401).json({ error: "Unauthorized" });
        }
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
        if (startupHintStage) {
            respondWithSegmentedStartupError({
                res,
                stage: startupHintStage,
                statusCode: 404,
                error: "Streaming session not found",
                reason: "session_not_found",
            });
        } else {
            res.status(404).json({ error: "Streaming session not found" });
        }
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

interface SegmentedSendFileErrorResponseProfile {
    notFoundError: string;
    notFoundReason: string;
    loadFailedError: string;
    loadFailedReason: string;
}

interface HandleSegmentedSendFileErrorOptions {
    req: express.Request;
    res: express.Response;
    error: unknown;
    stage: "manifest" | "segment";
    metricEvent: "manifest.fetch" | "segment.fetch";
    startedAtMs: number;
    sessionId: string;
    sourceType?: string;
    startupCorrelationFields: SegmentedStartupCorrelationFields;
    segmentName?: string;
    responseProfile: SegmentedSendFileErrorResponseProfile;
}

const handleSegmentedSendFileError = ({
    req,
    res,
    error,
    stage,
    metricEvent,
    startedAtMs,
    sessionId,
    sourceType,
    startupCorrelationFields,
    segmentName,
    responseProfile,
}: HandleSegmentedSendFileErrorOptions): express.Response => {
    const errorFields = getSegmentedMetricErrorFields(error);
    const metricFields: Record<string, unknown> = {
        status: "error",
        sessionId,
        sourceType,
        ...startupCorrelationFields,
        ...errorFields,
        latencyMs: segmentedMetricDurationMs(startedAtMs),
    };
    if (stage === "segment") {
        metricFields.segmentName = segmentName;
    }
    logSegmentedStreamingMetric(metricEvent, metricFields);

    const traceFields: Record<string, unknown> = {
        sessionId,
        sourceType,
        ...startupCorrelationFields,
    };
    if (stage === "segment") {
        traceFields.segmentName = segmentName;
    }
    logSegmentedStreamingTrace(
        stage === "manifest" ? "route.manifest.error" : "route.segment.error",
        buildSegmentedRouteTraceErrorFields(req, startedAtMs, errorFields, traceFields),
    );

    if (res.headersSent) {
        logger.error(
            `[SegmentedStreaming] ${stage} sendFile failed after headers were sent:`,
            error,
        );
        return res;
    }

    const segmentedError = toSegmentedSessionError(error);
    if (segmentedError) {
        return respondWithSegmentedStartupError({
            res,
            stage,
            statusCode: segmentedError.statusCode,
            error: segmentedError.message,
            code: segmentedError.code,
        });
    }

    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return respondWithSegmentedStartupError({
            res,
            stage,
            statusCode: 404,
            error: responseProfile.notFoundError,
            reason: responseProfile.notFoundReason,
        });
    }

    logger.error(`[SegmentedStreaming] Failed to send ${stage}:`, error);
    return respondWithSegmentedStartupError({
        res,
        stage,
        statusCode: 500,
        error: responseProfile.loadFailedError,
        reason: responseProfile.loadFailedReason,
    });
};

const handleSegmentFetch = async (
    req: express.Request,
    res: express.Response,
): Promise<express.Response> => {
    const startedAtMs = Date.now();
    const startupCorrelationFields = resolveSegmentedStartupCorrelationFields(req);
    let sourceType: string | undefined;
    try {
        const session = await authorizeSegmentedSessionRequest({
            req,
            res,
            metricEvent: "segment.fetch",
            startedAtMs,
            metricFields: {
                segmentName: req.params.segmentName,
                ...startupCorrelationFields,
            },
            tokenValidationOptions: {
                allowSessionIdMismatch: true,
            },
            startupHintStage: "segment",
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
                        ...startupCorrelationFields,
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
        res.sendFile(segmentPath, (error) => {
            if (error) {
                handleSegmentedSendFileError({
                    req,
                    res,
                    error,
                    stage: "segment",
                    metricEvent: "segment.fetch",
                    startedAtMs,
                    sessionId: session.sessionId,
                    sourceType: session.sourceType,
                    startupCorrelationFields,
                    segmentName: req.params.segmentName,
                    responseProfile: {
                        notFoundError: "Segment not found",
                        notFoundReason: "segment_not_found",
                        loadFailedError: "Failed to load segment",
                        loadFailedReason: "segment_load_failed",
                    },
                });
                return;
            }

            logSegmentedStreamingMetric("segment.fetch", {
                status: "success",
                sessionId: session.sessionId,
                sourceType: session.sourceType,
                segmentName: req.params.segmentName,
                ...startupCorrelationFields,
                latencyMs: segmentedMetricDurationMs(startedAtMs),
            });
            logSegmentedStreamingTrace(
                "route.segment.success",
                buildSegmentedRouteTraceFields(req, startedAtMs, {
                    sessionId: session.sessionId,
                    sourceType: session.sourceType,
                    segmentName: req.params.segmentName,
                    ...startupCorrelationFields,
                }),
            );
        });
        return res;
    } catch (error) {
        const errorFields = getSegmentedMetricErrorFields(error);
        logSegmentedStreamingMetric("segment.fetch", {
            status: "error",
            sessionId: req.params.sessionId,
            sourceType,
            segmentName: req.params.segmentName,
            ...startupCorrelationFields,
            ...errorFields,
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        logSegmentedStreamingTrace(
            "route.segment.error",
            buildSegmentedRouteTraceErrorFields(req, startedAtMs, errorFields, {
                sessionId: req.params.sessionId,
                sourceType,
                segmentName: req.params.segmentName,
                ...startupCorrelationFields,
            }),
        );
        const segmentedError = toSegmentedSessionError(error);
        if (segmentedError) {
            return respondWithSegmentedStartupError({
                res,
                stage: "segment",
                statusCode: segmentedError.statusCode,
                error: segmentedError.message,
                code: segmentedError.code,
            });
        }

        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return respondWithSegmentedStartupError({
                res,
                stage: "segment",
                statusCode: 404,
                error: "Segment not found",
                reason: "segment_not_found",
            });
        }

        logger.error("[SegmentedStreaming] Failed to load segment:", error);
        return respondWithSegmentedStartupError({
            res,
            stage: "segment",
            statusCode: 500,
            error: "Failed to load segment",
            reason: "segment_load_failed",
        });
    }
};

router.post("/v1/sessions", requireAuth, async (req, res) => {
    const startedAtMs = Date.now();
    const startupCorrelationFields = resolveSegmentedStartupCorrelationFields(req);
    try {
        if (getRuntimeDrainState()) {
            logSegmentedStreamingMetric("session.create", {
                status: "reject",
                reason: "draining",
                ...startupCorrelationFields,
                latencyMs: segmentedMetricDurationMs(startedAtMs),
            });
            return respondWithSegmentedStartupError({
                res,
                stage: "session_create",
                statusCode: 503,
                error: "Streaming service is draining",
                code: "STREAMING_DRAINING",
                reason: "runtime_draining",
            });
        }

        const userId = req.user?.id;
        if (!userId) {
            logSegmentedStreamingMetric("session.create", {
                status: "reject",
                reason: "unauthorized",
                ...startupCorrelationFields,
                latencyMs: segmentedMetricDurationMs(startedAtMs),
            });
            return respondWithSegmentedStartupError({
                res,
                stage: "session_create",
                statusCode: 401,
                error: "Unauthorized",
                reason: "unauthorized",
            });
        }

        const parsedBody = createSessionSchema.safeParse(req.body ?? {});
        if (!parsedBody.success) {
            logSegmentedStreamingMetric("session.create", {
                status: "reject",
                reason: "invalid_request",
                ...startupCorrelationFields,
                latencyMs: segmentedMetricDurationMs(startedAtMs),
            });
            return respondWithSegmentedStartupError({
                res,
                stage: "session_create",
                statusCode: 400,
                error: "Invalid request body",
                reason: "invalid_request",
                details: parsedBody.error.flatten(),
            });
        }

        const sourceType = parsedBody.data.sourceType ?? "local";
        const session = await segmentedStreamingSessionService.createLocalSession({
            userId,
            trackId: parsedBody.data.trackId,
            desiredQuality: parsedBody.data.desiredQuality,
            manifestProfile: parsedBody.data.manifestProfile,
        });

        logSegmentedStreamingMetric("session.create", {
            status: "success",
            sourceType,
            sessionId: session.sessionId,
            quality: session.playbackProfile?.quality ?? "unknown",
            requestedQuality: parsedBody.data.desiredQuality ?? null,
            qualitySource: parsedBody.data.desiredQuality
                ? "request"
                : "user_settings_or_default",
            manifestProfile:
                session.playbackProfile?.manifestProfile ?? "unknown",
            requestedManifestProfile: parsedBody.data.manifestProfile ?? null,
            ...startupCorrelationFields,
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        return res.status(201).json(session);
    } catch (error) {
        const errorFields = getSegmentedMetricErrorFields(error);
        logSegmentedStreamingMetric("session.create", {
            status: "error",
            ...startupCorrelationFields,
            ...errorFields,
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        const segmentedError = toSegmentedSessionError(error);
        if (segmentedError) {
            return respondWithSegmentedStartupError({
                res,
                stage: "session_create",
                statusCode: segmentedError.statusCode,
                error: segmentedError.message,
                code: segmentedError.code,
            });
        }

        logger.error("[SegmentedStreaming] Failed to create session:", error);
        return respondWithSegmentedStartupError({
            res,
            stage: "session_create",
            statusCode: 500,
            error: "Failed to create segmented streaming session",
            reason: "session_create_failed",
        });
    }
});

router.get("/v1/sessions/:sessionId/manifest.mpd", requireAuth, async (req, res) => {
    const startedAtMs = Date.now();
    const startupCorrelationFields = resolveSegmentedStartupCorrelationFields(req);
    let sourceType: string | undefined;
    try {
        const session = await authorizeSegmentedSessionRequest({
            req,
            res,
            metricEvent: "manifest.fetch",
            startedAtMs,
            metricFields: {
                ...startupCorrelationFields,
            },
            tokenValidationOptions: {
                allowSessionIdMismatch: true,
            },
            startupHintStage: "manifest",
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
        res.sendFile(session.manifestPath, (error) => {
            if (error) {
                handleSegmentedSendFileError({
                    req,
                    res,
                    error,
                    stage: "manifest",
                    metricEvent: "manifest.fetch",
                    startedAtMs,
                    sessionId: session.sessionId,
                    sourceType: session.sourceType,
                    startupCorrelationFields,
                    responseProfile: {
                        notFoundError: "Manifest not found",
                        notFoundReason: "manifest_not_found",
                        loadFailedError: "Failed to load manifest",
                        loadFailedReason: "manifest_load_failed",
                    },
                });
                return;
            }

            logSegmentedStreamingMetric("manifest.fetch", {
                status: "success",
                sessionId: session.sessionId,
                sourceType: session.sourceType,
                ...startupCorrelationFields,
                latencyMs: segmentedMetricDurationMs(startedAtMs),
            });
            logSegmentedStreamingTrace(
                "route.manifest.success",
                buildSegmentedRouteTraceFields(req, startedAtMs, {
                    sessionId: session.sessionId,
                    sourceType: session.sourceType,
                    ...startupCorrelationFields,
                }),
            );
        });
        return res;
    } catch (error) {
        const errorFields = getSegmentedMetricErrorFields(error);
        logSegmentedStreamingMetric("manifest.fetch", {
            status: "error",
            sessionId: req.params.sessionId,
            sourceType,
            ...startupCorrelationFields,
            ...errorFields,
            latencyMs: segmentedMetricDurationMs(startedAtMs),
        });
        logSegmentedStreamingTrace(
            "route.manifest.error",
            buildSegmentedRouteTraceErrorFields(req, startedAtMs, errorFields, {
                sessionId: req.params.sessionId,
                sourceType,
                ...startupCorrelationFields,
            }),
        );
        const segmentedError = toSegmentedSessionError(error);
        if (segmentedError) {
            return respondWithSegmentedStartupError({
                res,
                stage: "manifest",
                statusCode: segmentedError.statusCode,
                error: segmentedError.message,
                code: segmentedError.code,
            });
        }

        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return respondWithSegmentedStartupError({
                res,
                stage: "manifest",
                statusCode: 404,
                error: "Manifest not found",
                reason: "manifest_not_found",
            });
        }

        logger.error("[SegmentedStreaming] Failed to load manifest:", error);
        return respondWithSegmentedStartupError({
            res,
            stage: "manifest",
            statusCode: 500,
            error: "Failed to load manifest",
            reason: "manifest_load_failed",
        });
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
            const stringFieldNames = [
                "outcome",
                "initSource",
                "firstChunkName",
                "startupCorrelationId",
                "cmcdObjectType",
            ] as const;
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
                "retryBudgetMax",
                "retryBudgetRemaining",
                "startupRecoveryWindowMs",
                "startupSessionResetsUsed",
                "startupSessionResetsMax",
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

        if (
            parsedBody.data.event === "player.playback_error" ||
            parsedBody.data.event === "player.segment_quarantined" ||
            parsedBody.data.event === "session.prewarm_validation_failed"
        ) {
            segmentedStreamingSessionService.schedulePlaybackErrorRepair({
                userId,
                sessionId,
                trackId,
                sourceType,
            });
        }

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
