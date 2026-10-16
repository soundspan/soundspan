import {
    mergeRemoteAlbumWhere,
    mergeRemoteArtistWhere,
    shouldLoadRemoteLibrary,
} from "../browseQuery";

describe("remote library browse query decisions", () => {
    it("loads remote membership only for remote-capable filters", () => {
        expect(shouldLoadRemoteLibrary("remote", "discovery")).toBe(true);
        expect(shouldLoadRemoteLibrary("all", "owned")).toBe(true);
        expect(shouldLoadRemoteLibrary("all", "all")).toBe(true);
        expect(shouldLoadRemoteLibrary("all", "discovery")).toBe(false);
        expect(shouldLoadRemoteLibrary("local", "owned")).toBe(false);
    });

    it("adds remote artist ids to an existing OR", () => {
        expect(
            mergeRemoteArtistWhere(
                { OR: [{ libraryAlbumCount: { gt: 0 } }] },
                "all",
                ["remote-artist"],
            ),
        ).toEqual({
            OR: [
                { libraryAlbumCount: { gt: 0 } },
                { id: { in: ["remote-artist"] } },
            ],
        });
    });

    it("wraps the album union before applying artist scope", () => {
        expect(
            mergeRemoteAlbumWhere(
                { location: "LIBRARY" },
                "all",
                ["remote-album"],
                "artist-1",
            ),
        ).toEqual({
            AND: [
                {
                    OR: [
                        { location: "LIBRARY" },
                        {
                            location: "REMOTE",
                            id: { in: ["remote-album"] },
                        },
                    ],
                },
                { artistId: "artist-1" },
            ],
        });
    });
});
