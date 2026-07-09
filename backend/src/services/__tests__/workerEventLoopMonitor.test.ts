jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

import {
    evaluateEventLoopSample,
    trackJobStart,
    trackJobEnd,
    getActiveJobs,
    clearActiveJobsForTest,
    runMonitorTick,
    type EventLoopSampleMs,
} from "../workerEventLoopMonitor";
import { logger } from "../../utils/logger";

const mockWarn = logger.warn as jest.Mock;

const sample = (overrides: Partial<EventLoopSampleMs> = {}): EventLoopSampleMs => ({
    maxMs: 10,
    p99Ms: 5,
    meanMs: 2,
    ...overrides,
});

describe("active job registry", () => {
    beforeEach(() => {
        clearActiveJobsForTest();
    });

    it("tracks job start and end", () => {
        trackJobStart("library-scan", "16", "scan", 1_000);
        expect(getActiveJobs()).toEqual([
            expect.objectContaining({
                queue: "library-scan",
                jobId: "16",
                jobName: "scan",
                startedAtMs: 1_000,
            }),
        ]);

        trackJobEnd("library-scan", "16");
        expect(getActiveJobs()).toEqual([]);
    });

    it("ignores ends for unknown jobs and keys jobs by queue+id", () => {
        trackJobStart("worker-scheduler", "a", "lidarr-cleanup-cycle", 0);
        trackJobEnd("library-scan", "a");
        expect(getActiveJobs()).toHaveLength(1);
    });
});

describe("evaluateEventLoopSample", () => {
    beforeEach(() => {
        clearActiveJobsForTest();
    });

    it("returns null below the threshold", () => {
        expect(
            evaluateEventLoopSample(sample({ maxMs: 999 }), [], 1000, 0)
        ).toBeNull();
    });

    it("names the active jobs with their age when the loop stalls", () => {
        trackJobStart("worker-scheduler", "r1", "download-reconciliation-cycle", 5_000);
        const warning = evaluateEventLoopSample(
            sample({ maxMs: 2400, p99Ms: 1800 }),
            getActiveJobs(),
            1000,
            65_000
        );

        expect(warning).not.toBeNull();
        expect(warning!.message).toContain("max=2400ms");
        expect(warning!.message).toContain("p99=1800ms");
        expect(warning!.message).toContain(
            "worker-scheduler/download-reconciliation-cycle#r1 age=60s"
        );
    });

    it("says none when the loop stalls with no attributed job", () => {
        const warning = evaluateEventLoopSample(
            sample({ maxMs: 1500 }),
            [],
            1000,
            0
        );
        expect(warning!.message).toContain("activeJobs=none");
    });
});

describe("runMonitorTick", () => {
    beforeEach(() => {
        clearActiveJobsForTest();
        mockWarn.mockClear();
    });

    const NS_PER_MS = 1_000_000;

    const histogramLike = (maxMs: number) => ({
        max: maxMs * NS_PER_MS,
        mean: 2 * NS_PER_MS,
        percentile: jest.fn(() => 3 * NS_PER_MS),
        reset: jest.fn(),
    });

    it("warns and resets the histogram on a stall", () => {
        const h = histogramLike(3000);
        runMonitorTick(h, 1000, () => 0);

        expect(mockWarn).toHaveBeenCalledWith(
            expect.stringContaining("max=3000ms")
        );
        expect(h.reset).toHaveBeenCalled();
    });

    it("stays silent and still resets below the threshold", () => {
        const h = histogramLike(200);
        runMonitorTick(h, 1000, () => 0);

        expect(mockWarn).not.toHaveBeenCalled();
        expect(h.reset).toHaveBeenCalled();
    });
});
