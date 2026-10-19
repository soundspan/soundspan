import { filterDistinctDiscographyAlbums } from "../library/artistPageMatching";

describe("artist page discography album matching", () => {
    it("drops a release-group match from a differently titled placeholder", () => {
        const result = filterDistinctDiscographyAlbums(
            [
                {
                    title: "Streaming title",
                    rgMbid: "remote:placeholder",
                    matchedRgMbid: "rg-held",
                },
            ],
            [{ title: "MusicBrainz title", rgMbid: "rg-held" }],
        );

        expect(result).toEqual([]);
    });

    it("drops a direct release-group match with a different title", () => {
        const result = filterDistinctDiscographyAlbums(
            [{ title: "Library title", rgMbid: "rg-library" }],
            [{ title: "MusicBrainz title", rgMbid: "rg-library" }],
        );

        expect(result).toEqual([]);
    });

    it("keeps the existing edition-stripped title rule", () => {
        const result = filterDistinctDiscographyAlbums(
            [{ title: "The Album (Deluxe Edition)" }],
            [{ title: "The Album", rgMbid: "rg-other" }],
        );

        expect(result).toEqual([]);
    });

    it("keeps unrelated release groups and titles", () => {
        const remote = { title: "Other Album", rgMbid: "rg-other" };

        expect(
            filterDistinctDiscographyAlbums(
                [
                    {
                        title: "Library Album",
                        rgMbid: "rg-library",
                        matchedRgMbid: "rg-held",
                    },
                ],
                [remote],
            ),
        ).toEqual([remote]);
    });
});
