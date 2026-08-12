import type { Request } from "express";
import { logger } from "../utils/logger";

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);
const playbackMetricLogger = logger.child("Playback.Metric");
const playbackTraceLogger = logger.child("Playback.Trace");

const isTruthy = (value: string | undefined): boolean => {
    const normalized = value?.trim().toLowerCase();
    return normalized ? TRUTHY_VALUES.has(normalized) : false;
};

const resolveTraceEnabled = (): boolean =>
    isTruthy(process.env.STREAMING_TRACE_LOGS) ||
    isTruthy(process.env.SEGMENTED_STREAMING_TRACE_LOGS);

/** Whether playback trace logs were enabled when this module loaded. */
export const playbackTraceEnabled = resolveTraceEnabled();

/** Return the non-negative elapsed time for a playback trace operation. */
export const playbackTraceDurationMs = (startedAtMs: number): number =>
    Math.max(0, Date.now() - startedAtMs);

/** Add request-path and latency context to playback trace fields. */
export const buildPlaybackRouteTraceFields = (
    req: Request,
    startedAtMs: number,
    fields: Record<string, unknown> = {},
): Record<string, unknown> => ({
    ...fields,
    requestPath: req.originalUrl || req.path,
    latencyMs: playbackTraceDurationMs(startedAtMs),
});

/** Add error, request-path, and latency context to playback trace fields. */
export const buildPlaybackRouteTraceErrorFields = (
    req: Request,
    startedAtMs: number,
    errorFields: Record<string, unknown>,
    fields: Record<string, unknown> = {},
): Record<string, unknown> => ({
    ...fields,
    requestPath: req.originalUrl || req.path,
    ...errorFields,
    latencyMs: playbackTraceDurationMs(startedAtMs),
});

/** Emit an always-on playback metric through the neutral metric logger. */
export const logPlaybackMetric = (
    event: string,
    fields: Record<string, unknown>,
): void => {
    playbackMetricLogger.info(event, fields);
};

/** Emit a gated playback trace event through the neutral trace logger. */
export const logPlaybackTrace = (
    event: string,
    fields: Record<string, unknown> = {},
): void => {
    if (!playbackTraceEnabled) {
        return;
    }

    playbackTraceLogger.info(event, {
        timestamp: new Date().toISOString(),
        ...fields,
    });
};
