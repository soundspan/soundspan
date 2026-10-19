import { filterDistinctDiscographyAlbums } from "../library/artistPageMatching";

describe("artist page discography album matching", () => {
    const musicBrainzAlbum = { title: "The Album", rgMbid: "rg-musicbrainz" };

    it("drops a release-group match from a differently titled placeholder", () => {
        const result = filterDistinctDiscographyAlbums(
            [
                {
                    title: "Streaming title",
                    source: "remote",
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

    it("keeps a MusicBrainz card that only matches a remote placeholder by title", () => {
        const result = filterDistinctDiscographyAlbums(
            [
                {
                    title: "The Album",
                    source: "remote",
                    rgMbid: "remote:placeholder",
                    matchedRgMbid: null,
                },
            ],
            [musicBrainzAlbum],
        );

        expect(result).toEqual([musicBrainzAlbum]);
    });

    it("keeps a same-title MusicBrainz card when the placeholder matched another release group", () => {
        const result = filterDistinctDiscographyAlbums(
            [
                {
                    title: "The Album",
                    source: "remote",
                    rgMbid: "remote:placeholder",
                    matchedRgMbid: "rg-other-edition",
                },
            ],
            [musicBrainzAlbum],
        );

        expect(result).toEqual([musicBrainzAlbum]);
    });

    it("hides a MusicBrainz card that matches a database album by title", () => {
        const result = filterDistinctDiscographyAlbums(
            [{ title: "The Album", source: "database" }],
            [musicBrainzAlbum],
        );

        expect(result).toEqual([]);
    });

    it("keeps the existing edition-stripped title rule", () => {
        const result = filterDistinctDiscographyAlbums(
            [{ title: "The Album (Deluxe Edition)", source: "database" }],
            [musicBrainzAlbum],
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
