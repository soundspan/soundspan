import type { Request } from "express";
import { createLogger, logger } from "../../utils/logger";

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);
const traceLogger =
    typeof createLogger === "function"
        ? createLogger("SegmentedStreaming.Trace")
        : logger;

const isTruthy = (value: string | undefined): boolean => {
    const normalized = value?.trim().toLowerCase();
    return normalized ? TRUTHY_VALUES.has(normalized) : false;
};

const resolveTraceEnabled = (): boolean =>
    isTruthy(process.env.STREAMING_TRACE_LOGS) ||
    isTruthy(process.env.SEGMENTED_STREAMING_TRACE_LOGS);

export const segmentedStreamingTraceEnabled = resolveTraceEnabled();

export const segmentedTraceDurationMs = (startedAtMs: number): number =>
    Math.max(0, Date.now() - startedAtMs);

export const toSegmentedTraceErrorFields = (
    error: unknown,
): { errorCode: string; errorMessage: string } => {
    const errorCode =
        typeof (error as NodeJS.ErrnoException | undefined)?.code === "string"
            ? ((error as NodeJS.ErrnoException).code as string)
            : "UNKNOWN_ERROR";
    const errorMessage =
        error instanceof Error ? error.message : String(error ?? "Unknown error");

    return {
        errorCode,
        errorMessage,
    };
};

export const buildSegmentedRouteTraceFields = (
    req: Request,
    startedAtMs: number,
    fields: Record<string, unknown> = {},
): Record<string, unknown> => ({
    ...fields,
    requestPath: req.originalUrl || req.path,
    latencyMs: segmentedTraceDurationMs(startedAtMs),
});

export const buildSegmentedRouteTraceErrorFields = (
    req: Request,
    startedAtMs: number,
    errorFields: Record<string, unknown>,
    fields: Record<string, unknown> = {},
): Record<string, unknown> => ({
    ...fields,
    requestPath: req.originalUrl || req.path,
    ...errorFields,
    latencyMs: segmentedTraceDurationMs(startedAtMs),
});

export const logSegmentedStreamingTrace = (
    event: string,
    fields: Record<string, unknown> = {},
): void => {
    if (!segmentedStreamingTraceEnabled) {
        return;
    }

    traceLogger.info(event, {
        timestamp: new Date().toISOString(),
        ...fields,
    });
};
