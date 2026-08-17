const mockTrackCount = jest.fn();
const mockTrackGroupBy = jest.fn();
const mockEmbeddingFindFirst = jest.fn();
const mockSpaceFindUnique = jest.fn();
const mockGetTargetSpaceId = jest.fn();
const mockQueryRaw = jest.fn();
const mockTransaction = jest.fn();
const mockSetCoverage = jest.fn();
const mockCollectionErrorInc = jest.fn();

jest.mock("../../metrics", () => ({
    metricsRegistry: {
        getSingleMetric: () => ({ inc: mockCollectionErrorInc }),
    },
    setVibeEmbeddingCoverage: (...args: unknown[]) => mockSetCoverage(...args),
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
        $transaction: (...args: unknown[]) => mockTransaction(...args),
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
    refreshVibeEmbeddingCoverage,
} from "../vibeEmbeddingCoverage";

describe("vibe embedding coverage refresh", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockQueryRaw.mockResolvedValue([{ set_config: "10000" }]);
        mockTransaction.mockImplementation(async (queries: unknown[]) =>
            Promise.all(queries),
        );
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
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
        expect(mockQueryRaw.mock.calls[0]?.[1]).toBe("10000");
        expect(mockTransaction).toHaveBeenCalledTimes(1);
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

    it("retains the previous sample when the bounded query times out", async () => {
        const previous = { embedded: 10, pending: 5, failed: 1 };
        mockTrackCount.mockResolvedValueOnce(12);
        mockTrackGroupBy.mockResolvedValueOnce([]);
        mockTransaction.mockRejectedValueOnce({
            code: "P2010",
            meta: { code: "57014" },
        });

        await expect(
            refreshVibeEmbeddingCoverage("target-space", previous),
        ).resolves.toEqual(previous);

        expect(mockSetCoverage).not.toHaveBeenCalled();
        expect(mockCollectionErrorInc).toHaveBeenCalledWith({
            collector: "vibe_embedding_coverage",
        });
    });
});
