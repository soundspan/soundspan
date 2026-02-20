const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

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

export const logSegmentedStreamingTrace = (
    event: string,
    fields: Record<string, unknown> = {},
): void => {
    if (!segmentedStreamingTraceEnabled) {
        return;
    }

    console.info("[SegmentedStreaming][Trace] " + event, {
        timestamp: new Date().toISOString(),
        ...fields,
    });
};
