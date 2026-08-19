jest.mock("../processors/loudnessBackfillProcessor", () => ({
    LOUDNESS_BACKFILL_JOB_NAME: "track-loudness-backfill",
}));

import { loudnessBackfillRepeatSchedule } from "../loudnessBackfillSchedule";

describe("loudness backfill schedule", () => {
    it("registers a bounded six-hour repeat tick", () => {
        expect(loudnessBackfillRepeatSchedule).toEqual({
            type: "track-loudness-backfill",
            data: { mode: "repeat" },
            opts: {
                jobId: "scheduler:loudness-backfill:repeat",
                repeat: { every: 6 * 60 * 60 * 1000 },
                attempts: 3,
                backoff: { type: "exponential", delay: 5_000 },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        });
    });
});
