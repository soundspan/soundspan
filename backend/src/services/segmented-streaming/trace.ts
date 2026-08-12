import type { Request } from "express";
import {
    buildPlaybackRouteTraceErrorFields,
    buildPlaybackRouteTraceFields,
    playbackTraceDurationMs,
    playbackTraceEnabled,
} from "../playbackTrace";
import { logger } from "../../utils/logger";

const traceLogger = logger.child("SegmentedStreaming.Trace");

/** Whether segmented-streaming trace logs were enabled at module load. */
export const segmentedStreamingTraceEnabled = playbackTraceEnabled;

/** Return non-negative elapsed time for segmented-streaming trace work. */
export const segmentedTraceDurationMs = playbackTraceDurationMs;

/** Convert an unknown segmented-streaming failure into stable trace fields. */
export const toSegmentedTraceErrorFields = (
    error: unknown,
): { errorCode: string; errorMessage: string } => {
    const errorCode =
        typeof (error as NodeJS.ErrnoException | undefined)?.code === "string"
            ? ((error as NodeJS.ErrnoException).code as string)
            : "UNKNOWN_ERROR";
    const errorMessage =
        error instanceof Error
            ? error.message
            : String(error ?? "Unknown error");

    return {
        errorCode,
        errorMessage,
    };
};

/** Add route context to a segmented-streaming trace event. */
export const buildSegmentedRouteTraceFields = (
    req: Request,
    startedAtMs: number,
    fields: Record<string, unknown> = {},
): Record<string, unknown> =>
    buildPlaybackRouteTraceFields(req, startedAtMs, fields);

/** Add error and route context to a segmented-streaming trace event. */
export const buildSegmentedRouteTraceErrorFields = (
    req: Request,
    startedAtMs: number,
    errorFields: Record<string, unknown>,
    fields: Record<string, unknown> = {},
): Record<string, unknown> =>
    buildPlaybackRouteTraceErrorFields(req, startedAtMs, errorFields, fields);

/** Emit a gated trace event under the segmented-streaming logger identity. */
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
