const findMany = jest.fn();
jest.mock("../../../utils/db", () => ({ prisma: { track: { findMany } } }));

import {
    getQualityOutliers,
    loadLossyAlbumQualityStats,
    LOSSY_AUDIO_MIMES,
} from "../qualityOutliers";

describe("library health quality outliers", () => {
    beforeEach(() => jest.clearAllMocks());

    it("uses supported lossy MIME types, ignores zero duration, and clamps pagination", async () => {
        findMany.mockResolvedValueOnce([
            {
                fileSize: 4_000_000,
                duration: 200,
                album: {
                    id: "al1",
                    title: "Album",
                    artist: { id: "a1", name: "Artist" },
                },
            },
            {
                fileSize: 9_000_000,
                duration: 0,
                album: {
                    id: "al1",
                    title: "Album",
                    artist: { id: "a1", name: "Artist" },
                },
            },
        ]);

        const stats = await loadLossyAlbumQualityStats();
        const result = getQualityOutliers(stats, 192, {
            limit: 200,
            offset: -4,
        });

        expect(findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    mime: { in: [...LOSSY_AUDIO_MIMES] },
                }),
            }),
        );
        expect(result).toEqual(
            expect.objectContaining({
                limit: 100,
                offset: 0,
                total: 1,
                items: [expect.objectContaining({ averageBitrateKbps: 160 })],
            }),
        );
    });
});
