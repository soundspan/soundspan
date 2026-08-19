const groupBy = jest.fn();
const findMany = jest.fn();
jest.mock("../../../utils/db", () => ({
    prisma: { track: { groupBy, findMany } },
}));

import { deriveBitrateKbps, loadStorageAnalytics } from "../storageAnalytics";

describe("library health storage analytics", () => {
    beforeEach(() => jest.clearAllMocks());

    it.each([0, null])("guards duration %s", (duration) => {
        expect(deriveBitrateKbps(8_000_000, duration)).toBeNull();
    });

    it("groups formats and ranks artists", async () => {
        groupBy.mockResolvedValueOnce([
            {
                mime: "audio/mpeg",
                _count: { _all: 2 },
                _sum: { fileSize: 16_000_000 },
            },
        ]);
        findMany.mockResolvedValueOnce([
            {
                mime: "audio/mpeg",
                fileSize: 8_000_000,
                duration: 320,
                album: { artist: { id: "a1", name: "Artist" } },
            },
            {
                mime: "audio/mpeg",
                fileSize: 8_000_000,
                duration: 0,
                album: { artist: { id: "a1", name: "Artist" } },
            },
        ]);

        const result = await loadStorageAnalytics();

        expect(result.formats[0]).toEqual(
            expect.objectContaining({
                trackCount: 2,
                totalFileSize: 16_000_000,
                averageBitrateKbps: 200,
                bitrateSampleSize: 1,
            }),
        );
        expect(result.topArtists[0]).toEqual({
            artistId: "a1",
            artistName: "Artist",
            trackCount: 2,
            totalFileSize: 16_000_000,
        });
    });
});
