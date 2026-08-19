const groupBy = jest.fn();
const count = jest.fn();
const findMany = jest.fn();

jest.mock("../../../utils/db", () => ({
    prisma: { track: { groupBy, count, findMany } },
}));

import { getAnalysisCoverage } from "../analysisCoverage";

describe("library health analysis coverage", () => {
    beforeEach(() => jest.clearAllMocks());

    it("folds unknown statuses into pending and uses an independent total", async () => {
        groupBy
            .mockResolvedValueOnce([
                { analysisStatus: "completed", _count: 7 },
                { analysisStatus: "failed", _count: 1 },
                { analysisStatus: "retrying", _count: 2 },
            ])
            .mockResolvedValueOnce([
                { vibeAnalysisStatus: null, _count: 2 },
                { vibeAnalysisStatus: "pending", _count: 3 },
                { vibeAnalysisStatus: "completed", _count: 4 },
                { vibeAnalysisStatus: "retrying", _count: 1 },
            ]);
        count
            .mockResolvedValueOnce(10)
            .mockResolvedValueOnce(6)
            .mockResolvedValueOnce(4)
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

        expect(result.total).toBe(10);
        expect(result.analysisStatus.pending).toBe(2);
        expect(result.vibeAnalysisStatus.pending).toBe(6);
        expect(result.loudness).toEqual({ measured: 6, missing: 4 });
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
