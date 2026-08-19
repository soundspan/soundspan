const groupBy = jest.fn();
const count = jest.fn();
const findMany = jest.fn();

jest.mock("../../../utils/db", () => ({
    prisma: { track: { groupBy, count, findMany } },
}));

import { getAnalysisCoverage } from "../analysisCoverage";

describe("library health analysis coverage", () => {
    beforeEach(() => jest.clearAllMocks());

    it("normalizes null vibe status to pending and paginates failures", async () => {
        groupBy
            .mockResolvedValueOnce([
                { analysisStatus: "completed", _count: 7 },
                { analysisStatus: "failed", _count: 1 },
            ])
            .mockResolvedValueOnce([
                { vibeAnalysisStatus: null, _count: 2 },
                { vibeAnalysisStatus: "pending", _count: 3 },
                { vibeAnalysisStatus: "completed", _count: 4 },
            ]);
        count
            .mockResolvedValueOnce(5)
            .mockResolvedValueOnce(3)
            .mockResolvedValueOnce(1);
        findMany.mockResolvedValueOnce([
            {
                id: "t1",
                title: "Failed",
                analysisError: "decode",
                album: { title: "Album", artist: { name: "Artist" } },
            },
        ]);

        const result = await getAnalysisCoverage({ limit: 10, offset: 5 });

        expect(result.vibeAnalysisStatus.pending).toBe(5);
        expect(result.loudness).toEqual({ measured: 5, missing: 3 });
        expect(result.failed.items[0]).toEqual({
            id: "t1",
            title: "Failed",
            artistName: "Artist",
            albumTitle: "Album",
            analysisError: "decode",
        });
        expect(findMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 10, skip: 5 }),
        );
    });
});
