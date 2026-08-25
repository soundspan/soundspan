import { isRealArtistMbid, rgMbidKind } from "../musicIds";

describe("music ID helpers", () => {
    describe("isRealArtistMbid", () => {
        it.each([
            "0383dadf-2a4e-4d10-a46a-e9e041da8eb3",
            "0383DADF-2A4E-4D10-A46A-E9E041DA8EB3",
        ])("accepts a syntactically valid MusicBrainz artist ID", (mbid) => {
            expect(isRealArtistMbid(mbid)).toBe(true);
        });

        it.each([
            null,
            undefined,
            "",
            "not-an-mbid",
            "temp-artist-1",
            "temp-remote-artist-1",
            "remote:artist-1",
            "federation:artist-1",
        ])("rejects non-MusicBrainz artist identity %p", (mbid) => {
            expect(isRealArtistMbid(mbid)).toBe(false);
        });
    });

    describe("rgMbidKind", () => {
        it.each([
            ["0383dadf-2a4e-4d10-a46a-e9e041da8eb3", "musicbrainz"],
            ["remote:album-123", "remote"],
            ["federation:peer:album-123", "federation"],
            ["temp-album-123", "temp"],
            ["temp-remote-album-123", "temp"],
        ] as const)("classifies %s as %s", (rgMbid, expected) => {
            expect(rgMbidKind(rgMbid)).toBe(expected);
        });
    });
});
