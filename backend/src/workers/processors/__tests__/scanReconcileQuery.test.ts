const mockQueryRaw = jest.fn();
const mockTrackGroupBy = jest.fn();

jest.mock("../../../utils/db", () => ({
    prisma: {
        $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
        track: {
            groupBy: (...args: unknown[]) => mockTrackGroupBy(...args),
        },
    },
}));

import {
    buildScanReconcileCandidateQuery,
    buildScanReconcilePatterns,
    candidateMatchesJob,
    chunkScanReconcilePatterns,
    loadScanReconcileCandidates,
    SCAN_RECONCILE_CANDIDATE_FETCH_LIMIT,
    SCAN_RECONCILE_PATTERN_CHUNK_SIZE,
} from "../scanReconcileQuery";

describe("scan reconciliation query construction", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("escapes LIKE metacharacters and preserves contains matching", () => {
        expect(buildScanReconcilePatterns(["100%_\\ Mix", "plain"])).toEqual([
            "%100\\%\\_\\\\ Mix%",
            "%plain%",
        ]);
    });

    it("chunks patterns at the bounded query size", () => {
        const patterns = Array.from(
            { length: SCAN_RECONCILE_PATTERN_CHUNK_SIZE * 2 + 5 },
            (_unused, index) => `%artist-${index}%`,
        );

        expect(
            chunkScanReconcilePatterns(patterns).map((chunk) => chunk.length),
        ).toEqual([
            SCAN_RECONCILE_PATTERN_CHUNK_SIZE,
            SCAN_RECONCILE_PATTERN_CHUNK_SIZE,
            5,
        ]);
    });

    it("binds one pattern array and the candidate sentinel limit", () => {
        const patterns = ["%first%", "%second%"];
        const query = buildScanReconcileCandidateQuery(patterns);

        expect(query.text).toContain("ar.name ILIKE ANY($1::text[])");
        expect(query.text).toContain('ORDER BY al."updatedAt" DESC, al.id ASC');
        expect(query.text).toContain("al.location IN ('LIBRARY', 'DISCOVER')");
        expect(query.text).not.toContain("COUNT(*)");
        expect(query.text).toContain("LIMIT $2");
        expect(query.text).not.toContain(" OR ");
        expect(query.values).toEqual([
            patterns,
            SCAN_RECONCILE_CANDIDATE_FETCH_LIMIT,
        ]);
    });

    it("adds one bounded active-local track count to each candidate", async () => {
        mockQueryRaw.mockResolvedValueOnce([
            { id: "album-1", title: "One", artistName: "Artist" },
            { id: "album-2", title: "Two", artistName: "Artist" },
        ]);
        mockTrackGroupBy.mockResolvedValueOnce([
            { albumId: "album-1", _count: { _all: 3 } },
        ]);

        await expect(loadScanReconcileCandidates(["artis"])).resolves.toEqual([
            {
                id: "album-1",
                title: "One",
                artistName: "Artist",
                trackCount: 3,
            },
            {
                id: "album-2",
                title: "Two",
                artistName: "Artist",
                trackCount: 0,
            },
        ]);
        expect(mockTrackGroupBy).toHaveBeenCalledTimes(1);
        expect(mockTrackGroupBy).toHaveBeenCalledWith({
            by: ["albumId"],
            where: {
                albumId: { in: ["album-1", "album-2"] },
                origin: "LOCAL",
                removedAt: null,
                album: { location: { in: ["LIBRARY", "DISCOVER"] } },
            },
            _count: { _all: true },
        });
    });

    it("requires the matched album to meet a known expected track count", () => {
        const job = {
            id: "job-1",
            discoveryBatchId: null,
            artistName: "The National",
            albumTitle: "Boxer",
            expectedTracks: 14,
        };
        const partialCandidate = {
            id: "album-1",
            title: "Boxer Deluxe",
            artistName: "The National",
            trackCount: 1,
        };

        expect(candidateMatchesJob(job, [partialCandidate])).toBe(false);
        expect(
            candidateMatchesJob(job, [{ ...partialCandidate, trackCount: 14 }]),
        ).toBe(true);
    });

    it("keeps presence-only matching when the expected count is unknown", () => {
        expect(
            candidateMatchesJob(
                {
                    id: "job-1",
                    discoveryBatchId: null,
                    artistName: "Beatles",
                    albumTitle: "Abbey Road",
                    expectedTracks: null,
                },
                [
                    {
                        id: "album-1",
                        title: "Abbey Road (Remastered)",
                        artistName: "The Beatles",
                        trackCount: 1,
                    },
                ],
            ),
        ).toBe(true);
    });

    it("rejects empty and oversized pattern chunks", () => {
        expect(() => buildScanReconcileCandidateQuery([])).toThrow(RangeError);
        expect(() =>
            buildScanReconcileCandidateQuery(
                Array.from(
                    { length: SCAN_RECONCILE_PATTERN_CHUNK_SIZE + 1 },
                    () => "%artist%",
                ),
            ),
        ).toThrow(RangeError);
    });
});
