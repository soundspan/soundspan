import { buildAlbumSearchQueries } from "../albumSearchQueries";

describe("buildAlbumSearchQueries", () => {
    it.each([
        {
            artistName: "Drake",
            albumTitle: "Take Care",
            expected: ["Drake Take Care"],
        },
        {
            artistName: "Ed Sheeran",
            albumTitle: "×",
            expected: ["Ed Sheeran ×", "Ed Sheeran x"],
        },
        {
            artistName: "Ed Sheeran",
            albumTitle: "−",
            expected: [
                "Ed Sheeran −",
                "Ed Sheeran -",
                "Ed Sheeran minus",
                "Ed Sheeran",
            ],
        },
        {
            artistName: "Sigur Rós",
            albumTitle: "( )",
            expected: ["Sigur Rós ( )", "Sigur Rós"],
        },
    ])(
        "builds the ordered queries for $artistName / $albumTitle",
        ({ artistName, albumTitle, expected }) => {
            expect(buildAlbumSearchQueries(artistName, albumTitle)).toEqual(
                expected,
            );
        },
    );

    it("deduplicates queries after whitespace normalization", () => {
        expect(buildAlbumSearchQueries("Drake", "Take\u00a0Care")).toEqual([
            "Drake Take Care",
        ]);
    });

    it.each([
        {
            artistName: " ",
            albumTitle: "Take Care",
            expected: ["Take Care"],
        },
        {
            artistName: "Drake",
            albumTitle: "\t",
            expected: ["Drake"],
        },
        { artistName: " ", albumTitle: "\t", expected: [""] },
    ])(
        "returns only the trimmed first query for empty inputs",
        ({ artistName, albumTitle, expected }) => {
            expect(buildAlbumSearchQueries(artistName, albumTitle)).toEqual(
                expected,
            );
        },
    );
});
