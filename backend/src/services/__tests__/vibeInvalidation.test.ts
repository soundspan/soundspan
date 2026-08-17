import { invalidateVibeAnalysis } from "../vibeInvalidation";

describe("vibe analysis invalidation", () => {
    it("resets state and increments the generation in one update", async () => {
        const updateMany = jest.fn(async () => ({ count: 2 }));
        const now = new Date("2026-08-17T12:00:00.000Z");

        await expect(
            invalidateVibeAnalysis(
                { track: { updateMany } },
                { origin: "LOCAL" },
                now,
            ),
        ).resolves.toBe(2);

        expect(updateMany).toHaveBeenCalledWith({
            where: { origin: "LOCAL" },
            data: {
                vibeAnalysisStatus: "pending",
                vibeAnalysisError: null,
                vibeAnalysisRetryCount: 0,
                vibeAnalysisStartedAt: null,
                vibeAnalysisStatusUpdatedAt: now,
                vibeAnalysisGeneration: { increment: 1 },
            },
        });
    });
});
