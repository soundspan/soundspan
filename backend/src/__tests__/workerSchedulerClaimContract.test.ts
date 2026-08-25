jest.mock("../workers/loudnessBackfillSchedule", () => ({
    loudnessBackfillRepeatSchedule: {
        type: "track-loudness-backfill",
        data: { mode: "repeat" },
        opts: {
            jobId: "scheduler:loudness-backfill:repeat",
            repeat: { every: 6 * 60 * 60 * 1_000 },
        },
    },
}));

import {
    buildSchedulerJobs,
    ONE_HOUR_MS,
    ONE_MINUTE_MS,
    SCHEDULER_JOB_IDS,
    SCHEDULER_JOB_TYPES,
} from "../workers/schedulerJobRegistry";

describe("worker scheduler registration contract", () => {
    it("returns stable queue-backed repeat schedules", () => {
        const repeatJobs = buildSchedulerJobs().filter(
            (job) => job.data.mode === "repeat",
        );
        const repeatById = new Map(
            repeatJobs.map((job) => [job.opts.jobId, job]),
        );

        expect(repeatById.get(SCHEDULER_JOB_IDS.dataIntegrityRepeat)).toEqual(
            expect.objectContaining({
                type: SCHEDULER_JOB_TYPES.dataIntegrity,
                opts: expect.objectContaining({
                    repeat: { every: 24 * ONE_HOUR_MS },
                }),
            }),
        );
        expect(repeatById.get(SCHEDULER_JOB_IDS.reconciliationRepeat)).toEqual(
            expect.objectContaining({
                type: SCHEDULER_JOB_TYPES.reconciliation,
                opts: expect.objectContaining({
                    repeat: { every: 2 * ONE_MINUTE_MS },
                }),
            }),
        );
        expect(
            repeatById.get(SCHEDULER_JOB_IDS.albumDownloadRecoveryRepeat),
        ).toEqual(
            expect.objectContaining({
                type: SCHEDULER_JOB_TYPES.albumDownloadRecovery,
                opts: expect.objectContaining({
                    repeat: { every: 5 * ONE_MINUTE_MS },
                }),
            }),
        );
    });
});
