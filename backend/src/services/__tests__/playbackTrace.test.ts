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
const mockRootLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn((scope: string) => {
        if (scope === "Playback.Metric") return mockPlaybackMetricLogger;
        if (scope === "Playback.Trace") return mockPlaybackTraceLogger;
        throw new Error(`Unexpected logger scope: ${scope}`);
    }),
};

jest.mock("../../utils/logger", () => ({
    logger: mockRootLogger,
}));

jest.mock("../../config", () => ({
    config: {
        streaming: {
            get traceEnabled() {
                const truthy = new Set(["1", "true", "yes", "on"]);
                const value = process.env.STREAMING_TRACE_LOGS;
                return truthy.has(value?.trim().toLowerCase() || "");
            },
        },
    },
}));

describe("playback trace identity", () => {
    const originalStreamingTraceLogs = process.env.STREAMING_TRACE_LOGS;
    const originalRemovedTraceAlias =
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
        if (originalRemovedTraceAlias === undefined) {
            delete process.env.SEGMENTED_STREAMING_TRACE_LOGS;
        } else {
            process.env.SEGMENTED_STREAMING_TRACE_LOGS =
                originalRemovedTraceAlias;
        }
    });

    it("uses STREAMING_TRACE_LOGS as the playback trace gate", async () => {
        process.env.STREAMING_TRACE_LOGS = "true";
        const playbackTrace = await import("../playbackTrace");

        playbackTrace.logPlaybackMetric("client.signal", {
            event: "player.engine_startup",
        });
        playbackTrace.logPlaybackTrace("playback.client.signal", {
            event: "player.engine_startup",
            fields: { activeEngine: "native" },
        });

        expect(mockRootLogger.child).toHaveBeenCalledWith("Playback.Metric");
        expect(mockRootLogger.child).toHaveBeenCalledWith("Playback.Trace");
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
    });

    it("ignores the removed trace alias", async () => {
        process.env.SEGMENTED_STREAMING_TRACE_LOGS = "true";
        const playbackTrace = await import("../playbackTrace");

        playbackTrace.logPlaybackTrace("playback.client.signal", {
            event: "player.engine_startup",
        });

        expect(playbackTrace.playbackTraceEnabled).toBe(false);
        expect(mockPlaybackTraceLogger.info).not.toHaveBeenCalled();
    });
});
