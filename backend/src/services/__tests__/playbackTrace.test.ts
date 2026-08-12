const mockPlaybackTraceLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
const mockPlaybackMetricLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
const mockSegmentedTraceLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
const mockRootLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn((scope: string) => {
        if (scope === "Playback.Metric") return mockPlaybackMetricLogger;
        if (scope === "Playback.Trace") return mockPlaybackTraceLogger;
        if (scope === "SegmentedStreaming.Trace") {
            return mockSegmentedTraceLogger;
        }
        throw new Error(`Unexpected logger scope: ${scope}`);
    }),
};

jest.mock("../../utils/logger", () => ({
    logger: mockRootLogger,
}));

jest.mock("../../config", () => ({
    config: {
        segmentedStreaming: {
            get traceEnabled() {
                const truthy = new Set(["1", "true", "yes", "on"]);
                return [
                    process.env.STREAMING_TRACE_LOGS,
                    process.env.SEGMENTED_STREAMING_TRACE_LOGS,
                ].some((value) =>
                    truthy.has(value?.trim().toLowerCase() || ""),
                );
            },
        },
    },
}));

describe("playback trace identity", () => {
    const originalStreamingTraceLogs = process.env.STREAMING_TRACE_LOGS;
    const originalSegmentedStreamingTraceLogs =
        process.env.SEGMENTED_STREAMING_TRACE_LOGS;

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        delete process.env.STREAMING_TRACE_LOGS;
        delete process.env.SEGMENTED_STREAMING_TRACE_LOGS;
    });

    afterAll(() => {
        if (originalStreamingTraceLogs === undefined) {
            delete process.env.STREAMING_TRACE_LOGS;
        } else {
            process.env.STREAMING_TRACE_LOGS = originalStreamingTraceLogs;
        }
        if (originalSegmentedStreamingTraceLogs === undefined) {
            delete process.env.SEGMENTED_STREAMING_TRACE_LOGS;
        } else {
            process.env.SEGMENTED_STREAMING_TRACE_LOGS =
                originalSegmentedStreamingTraceLogs;
        }
    });

    it.each([
        "STREAMING_TRACE_LOGS",
        "SEGMENTED_STREAMING_TRACE_LOGS",
    ] as const)(
        "keeps %s as a gate for neutral and segmented playback traces",
        async (environmentVariable) => {
            process.env[environmentVariable] = "true";

            const playbackTrace = await import("../playbackTrace");
            const segmentedTrace = await import("../segmented-streaming/trace");

            playbackTrace.logPlaybackMetric("client.signal", {
                event: "player.engine_startup",
            });
            playbackTrace.logPlaybackTrace("playback.client.signal", {
                event: "player.engine_startup",
                fields: { activeEngine: "native" },
            });
            segmentedTrace.logSegmentedStreamingTrace("route.segment.success", {
                segmentName: "chunk-0-00001.m4s",
            });

            expect(mockRootLogger.child).toHaveBeenCalledWith(
                "Playback.Metric",
            );
            expect(mockRootLogger.child).toHaveBeenCalledWith("Playback.Trace");
            expect(mockRootLogger.child).toHaveBeenCalledWith(
                "SegmentedStreaming.Trace",
            );
            expect(mockPlaybackMetricLogger.info).toHaveBeenCalledWith(
                "client.signal",
                { event: "player.engine_startup" },
            );
            expect(mockPlaybackTraceLogger.info).toHaveBeenCalledWith(
                "playback.client.signal",
                expect.objectContaining({
                    timestamp: expect.any(String),
                    event: "player.engine_startup",
                    fields: { activeEngine: "native" },
                }),
            );
            expect(mockSegmentedTraceLogger.info).toHaveBeenCalledWith(
                "route.segment.success",
                expect.objectContaining({
                    timestamp: expect.any(String),
                    segmentName: "chunk-0-00001.m4s",
                }),
            );
        },
    );
});
