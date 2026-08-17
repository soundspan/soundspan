jest.mock("../../config", () => ({
    config: { music: { transcodeCachePath: "/tmp/soundspan-test-cache" } },
}));

jest.mock("../../utils/logger", () => ({
    logger: { child: () => ({ warn: jest.fn() }) },
}));

jest.mock("../../utils/db", () => ({ prisma: {} }));

import { applyTrackReplacement } from "../trackReplacement";

describe("track replacement", () => {
    it("invalidates vibe work with a generation increment in the transaction", async () => {
        const transaction = {
            track: { updateMany: jest.fn(async () => ({ count: 1 })) },
            trackEmbedding: {
                deleteMany: jest.fn(async () => ({ count: 1 })),
            },
            transcodedFile: {
                findMany: jest.fn(async () => [{ cachePath: "track.opus" }]),
                deleteMany: jest.fn(async () => ({ count: 1 })),
            },
        };

        await expect(
            applyTrackReplacement(transaction as never, "track-1"),
        ).resolves.toEqual(["track.opus"]);

        expect(transaction.track.updateMany).toHaveBeenCalledWith({
            where: { id: "track-1" },
            data: expect.objectContaining({
                analysisStatus: "pending",
                vibeAnalysisStatus: "pending",
                vibeAnalysisGeneration: { increment: 1 },
            }),
        });
    });
});
