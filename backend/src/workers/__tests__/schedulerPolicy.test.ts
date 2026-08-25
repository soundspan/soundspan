jest.mock("../../config", () => ({
    config: {
        workers: { loudnessBackfillBatchSize: 100 },
    },
}));

import {
    FIVE_MINUTE_JITTER_MAX_SECONDS,
    jitterFiveMinuteRepeat,
    schedulerLaneForJob,
} from "../schedulerPolicy";
import { SCHEDULER_JOB_TYPES } from "../schedulerJobTypes";

describe("scheduler policy", () => {
    it("routes reconciliation, recovery, and Lidarr cleanup to the fast lane", () => {
        expect(schedulerLaneForJob(SCHEDULER_JOB_TYPES.reconciliation)).toBe(
            "fast",
        );
        expect(
            schedulerLaneForJob(SCHEDULER_JOB_TYPES.albumDownloadRecovery),
        ).toBe("fast");
        expect(schedulerLaneForJob(SCHEDULER_JOB_TYPES.lidarrCleanup)).toBe(
            "fast",
        );
        expect(schedulerLaneForJob(SCHEDULER_JOB_TYPES.dataIntegrity)).toBe(
            "slow",
        );
        expect(schedulerLaneForJob("unknown-job")).toBe("unknown");
    });

    it("converts five-minute repeats to stable bounded cron offsets", () => {
        const first = jitterFiveMinuteRepeat("scheduler:job-a", {
            every: 5 * 60_000,
        });
        const repeated = jitterFiveMinuteRepeat("scheduler:job-a", {
            every: 5 * 60_000,
        });
        if (!("cron" in first)) throw new Error("expected cron jitter");
        const seconds = Number(first.cron.split(" ")[0]);

        expect(first).toEqual(repeated);
        expect(seconds).toBeGreaterThanOrEqual(1);
        expect(seconds).toBeLessThanOrEqual(FIVE_MINUTE_JITTER_MAX_SECONDS);
        expect(first).toEqual({ cron: `${seconds} */5 * * * *` });
    });

    it("leaves other cadences unchanged", () => {
        expect(
            jitterFiveMinuteRepeat("scheduler:hourly", { every: 60 * 60_000 }),
        ).toEqual({ every: 60 * 60_000 });
    });
});
