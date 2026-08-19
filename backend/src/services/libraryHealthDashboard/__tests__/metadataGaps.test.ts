const albumCount = jest.fn();
const albumFindMany = jest.fn();
const artistCount = jest.fn();
const trackCount = jest.fn();
const trackFindMany = jest.fn();

jest.mock("../../../utils/db", () => ({
    prisma: {
        album: { count: albumCount, findMany: albumFindMany },
        artist: { count: artistCount },
        track: { count: trackCount, findMany: trackFindMany },
    },
}));

import { getMetadataGapSummary, listMetadataGap } from "../metadataGaps";

describe("library health metadata gaps", () => {
    beforeEach(() => jest.clearAllMocks());

    it("excludes remote temporary identities from missing MBID counts", async () => {
        artistCount.mockResolvedValueOnce(3);
        albumCount.mockResolvedValueOnce(4);
        albumFindMany.mockResolvedValueOnce([]);

        const result = await listMetadataGap("missing-mbid", {
            limit: 50,
            offset: 0,
        });

        expect(artistCount).toHaveBeenCalledWith({
            where: expect.objectContaining({
                AND: expect.arrayContaining([
                    { mbid: { startsWith: "temp-" } },
                    { NOT: { mbid: { startsWith: "temp-remote-" } } },
                ]),
            }),
        });
        expect(albumCount).toHaveBeenCalledWith({
            where: expect.objectContaining({
                AND: expect.arrayContaining([
                    { rgMbid: { startsWith: "temp-" } },
                    { NOT: { rgMbid: { startsWith: "remote:" } } },
                ]),
            }),
        });
        expect(result.counts).toEqual({ artists: 3, albums: 4 });
    });

    it("treats absent lyrics and negative-cache rows as missing", async () => {
        trackCount.mockResolvedValueOnce(2);
        trackFindMany.mockResolvedValueOnce([]);

        await listMetadataGap("missing-lyrics", { limit: 20, offset: 0 });

        expect(trackCount).toHaveBeenCalledWith({
            where: expect.objectContaining({
                origin: "LOCAL",
                removedAt: null,
                OR: [{ lyrics: null }, { lyrics: { source: "none" } }],
            }),
        });
    });

    it("returns all gap counts for the summary", async () => {
        albumCount.mockResolvedValueOnce(2).mockResolvedValueOnce(4);
        artistCount.mockResolvedValueOnce(1).mockResolvedValueOnce(3);
        trackCount.mockResolvedValueOnce(5).mockResolvedValueOnce(6);

        await expect(getMetadataGapSummary()).resolves.toEqual({
            missingArt: { albums: 2, artists: 1 },
            missingMbid: { albums: 4, artists: 3 },
            missingGenres: 5,
            missingLyrics: 6,
        });
    });
});
