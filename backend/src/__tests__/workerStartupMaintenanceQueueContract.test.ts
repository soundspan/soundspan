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
    SCHEDULER_JOB_IDS,
    SCHEDULER_JOB_TYPES,
} from "../workers/schedulerJobRegistry";
import { schedulerLaneForJob } from "../workers/schedulerPolicy";

describe("worker startup maintenance queue contract", () => {
    it("returns startup maintenance registrations with stable names and IDs", () => {
        const jobs = buildSchedulerJobs();
        const registrations = jobs.map(({ type, data, opts }) => ({
            type,
            mode: data.mode,
            jobId: opts.jobId,
            queue:
                schedulerLaneForJob(type) === "fast"
                    ? "worker-scheduler"
                    : "worker-scheduler-maintenance",
        }));

        expect(registrations).toEqual(
            expect.arrayContaining([
                {
                    type: SCHEDULER_JOB_TYPES.cacheWarmup,
                    mode: "startup",
                    jobId: SCHEDULER_JOB_IDS.cacheWarmupStartup,
                    queue: "worker-scheduler-maintenance",
                },
                {
                    type: SCHEDULER_JOB_TYPES.podcastCleanup,
                    mode: "startup",
                    jobId: SCHEDULER_JOB_IDS.podcastCleanupStartup,
                    queue: "worker-scheduler-maintenance",
                },
                {
                    type: SCHEDULER_JOB_TYPES.audiobookAutoSync,
                    mode: "startup",
                    jobId: SCHEDULER_JOB_IDS.audiobookAutoSyncStartup,
                    queue: "worker-scheduler-maintenance",
                },
                {
                    type: SCHEDULER_JOB_TYPES.downloadQueueReconcile,
                    mode: "startup",
                    jobId: SCHEDULER_JOB_IDS.downloadQueueReconcileStartup,
                    queue: "worker-scheduler-maintenance",
                },
                {
                    type: SCHEDULER_JOB_TYPES.artistCountsBackfill,
                    mode: "startup",
                    jobId: SCHEDULER_JOB_IDS.artistCountsBackfillStartup,
                    queue: "worker-scheduler-maintenance",
                },
                {
                    type: SCHEDULER_JOB_TYPES.imageBackfill,
                    mode: "startup",
                    jobId: SCHEDULER_JOB_IDS.imageBackfillStartup,
                    queue: "worker-scheduler-maintenance",
                },
            ]),
        );
    });
});
