import {
    parseArtistAlbumSubject,
    stripAlbumYearSuffix,
} from "../downloadSubject";

describe("download subject utilities", () => {
    it("preserves dashes within an album title", () => {
        expect(
            parseArtistAlbumSubject("Artist - Album - Deluxe Edition"),
        ).toEqual({ artist: "Artist", album: "Album - Deluxe Edition" });
    });

    it("falls back to the subject for both fields without a delimiter", () => {
        expect(parseArtistAlbumSubject("Single Subject")).toEqual({
            artist: "Single Subject",
            album: "Single Subject",
        });
    });

    it("can preserve legacy subject whitespace for behavior-identical migrations", () => {
        expect(
            parseArtistAlbumSubject(" Artist - Album ", { trim: false }),
        ).toEqual({ artist: " Artist", album: "Album " });
    });

    it("strips only a trailing four-digit album year", () => {
        expect(stripAlbumYearSuffix("Album - Deluxe (2024)")).toBe(
            "Album - Deluxe",
        );
        expect(stripAlbumYearSuffix("Album (Remaster)")).toBe(
            "Album (Remaster)",
        );
    });
});
