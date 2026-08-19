import type Bull from "bull";
import { LOUDNESS_BACKFILL_JOB_NAME } from "./processors/loudnessBackfillProcessor";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** Durable Bull schedule that emits one jittered loudness sweep tick every six hours. */
export const loudnessBackfillRepeatSchedule = {
    type: LOUDNESS_BACKFILL_JOB_NAME,
    data: { mode: "repeat" as const },
    opts: {
        jobId: "scheduler:loudness-backfill:repeat",
        repeat: { every: SIX_HOURS_MS },
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: 10,
    },
} as const satisfies {
    type: typeof LOUDNESS_BACKFILL_JOB_NAME;
    data: { mode: "repeat" };
    opts: Bull.JobOptions;
};
