const mockTrackCount = jest.fn();
const mockTrackGroupBy = jest.fn();
const mockEmbeddingFindFirst = jest.fn();
const mockSpaceFindUnique = jest.fn();
const mockGetTargetSpaceId = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        track: {
            count: (...args: unknown[]) => mockTrackCount(...args),
            groupBy: (...args: unknown[]) => mockTrackGroupBy(...args),
        },
        trackEmbedding: {
            findFirst: (...args: unknown[]) => mockEmbeddingFindFirst(...args),
        },
        embeddingSpace: {
            findUnique: (...args: unknown[]) => mockSpaceFindUnique(...args),
        },
    },
}));

jest.mock("../embeddingSpaces", () => ({
    getVibeEmbeddingTargetSpaceId: (...args: unknown[]) =>
        mockGetTargetSpaceId(...args),
}));

import {
    createVibeEmbeddingCoverageRefresher,
    loadVibeEmbeddingCoverage,
    loadVibeSpaceVectorState,
} from "../vibeEmbeddingCoverage";

describe("vibe embedding coverage refresh", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("counts only eligible tracks in the active space", async () => {
        mockGetTargetSpaceId.mockResolvedValue("active-space");
        mockTrackCount.mockResolvedValueOnce(12);
        mockTrackGroupBy.mockResolvedValueOnce([
            { vibeAnalysisStatus: "pending", _count: 5 },
            { vibeAnalysisStatus: "failed", _count: 3 },
        ]);

        await expect(
            loadVibeEmbeddingCoverage("target-space"),
        ).resolves.toEqual({
            embedded: 12,
            pending: 5,
            failed: 3,
        });

        expect(mockTrackCount).toHaveBeenCalledWith({
            where: {
                origin: "LOCAL",
                removedAt: null,
                filePath: { not: null },
                embeddings: { some: { spaceId: "target-space" } },
            },
        });
        expect(mockTrackGroupBy).toHaveBeenCalledWith({
            by: ["vibeAnalysisStatus"],
            where: expect.objectContaining({
                origin: "LOCAL",
                removedAt: null,
                embeddings: { none: { spaceId: "target-space" } },
            }),
            _count: true,
        });
        expect(mockTrackCount).toHaveBeenCalledTimes(1);
        expect(mockTrackGroupBy).toHaveBeenCalledTimes(1);
    });

    it("checks active-space emptiness with an existence query", async () => {
        mockEmbeddingFindFirst.mockResolvedValueOnce({ trackId: "track-1" });
        mockSpaceFindUnique.mockResolvedValueOnce({ hadVectors: true });

        await expect(loadVibeSpaceVectorState("space-active")).resolves.toEqual(
            { hasVectors: true, hadVectors: true },
        );

        expect(mockEmbeddingFindFirst).toHaveBeenNthCalledWith(1, {
            where: { spaceId: "space-active" },
            select: { trackId: true },
        });
        expect(mockSpaceFindUnique).toHaveBeenCalledWith({
            where: { id: "space-active" },
            select: { hadVectors: true },
        });
        expect(mockTrackCount).not.toHaveBeenCalled();
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
