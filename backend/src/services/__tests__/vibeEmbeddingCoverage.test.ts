const mockTrackCount = jest.fn();
const mockGetTargetSpaceId = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        track: { count: (...args: unknown[]) => mockTrackCount(...args) },
    },
}));

jest.mock("../embeddingSpaces", () => ({
    getVibeEmbeddingTargetSpaceId: (...args: unknown[]) =>
        mockGetTargetSpaceId(...args),
}));

import {
    createVibeEmbeddingCoverageRefresher,
    loadVibeEmbeddingCoverage,
} from "../vibeEmbeddingCoverage";

describe("vibe embedding coverage refresh", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("counts only eligible tracks in the active space", async () => {
        mockGetTargetSpaceId.mockResolvedValue("active-space");
        mockTrackCount
            .mockResolvedValueOnce(20)
            .mockResolvedValueOnce(12)
            .mockResolvedValueOnce(3);

        await expect(
            loadVibeEmbeddingCoverage("target-space"),
        ).resolves.toEqual({
            embedded: 12,
            pending: 5,
            failed: 3,
        });

        expect(mockTrackCount).toHaveBeenNthCalledWith(2, {
            where: {
                origin: "LOCAL",
                removedAt: null,
                filePath: { not: null },
                embeddings: { some: { spaceId: "target-space" } },
            },
        });
        expect(mockTrackCount).toHaveBeenNthCalledWith(3, {
            where: expect.objectContaining({
                origin: "LOCAL",
                removedAt: null,
                vibeAnalysisStatus: "failed",
                embeddings: { none: { spaceId: "target-space" } },
            }),
        });
    });

    it("loads and emits counts for the active space", async () => {
        const loadCoverage = jest.fn(async () => ({
            embedded: 12,
            pending: 4,
            failed: 1,
        }));
        const setCoverage = jest.fn();
        const refresh = createVibeEmbeddingCoverageRefresher({
            loadCoverage,
            setCoverage,
        });

        await refresh();

        expect(loadCoverage).toHaveBeenCalledTimes(1);
        expect(setCoverage).toHaveBeenCalledWith({
            embedded: 12,
            pending: 4,
            failed: 1,
        });
    });
});
