import {
    VARIOUS_ARTISTS_CANONICAL,
    VARIOUS_ARTISTS_MBID,
    canonicalizeVariousArtists,
    isVariousArtistsById,
    hasDiacritics,
    getPreferredArtistName,
    normalizeArtistName,
    normalizeAlbumTitle,
    stripAlbumEdition,
    areArtistNamesSimilar,
    findBestArtistMatch,
    extractPrimaryArtist,
    parseArtistFromPath,
} from "../artistNormalization";

describe("artistNormalization utilities", () => {
    it("canonicalizes various-artists aliases and preserves non-matches", () => {
        expect(VARIOUS_ARTISTS_MBID).toBe(
            "89ad4ac3-39f7-470e-963a-56509c546377"
        );
        expect(canonicalizeVariousArtists("V.A.")).toBe(
            VARIOUS_ARTISTS_CANONICAL
        );
        expect(canonicalizeVariousArtists("<Various Artists>")).toBe(
            VARIOUS_ARTISTS_CANONICAL
        );
        expect(canonicalizeVariousArtists("Single Artist")).toBe("Single Artist");
    });

    it("detects platform-specific various-artists ids", () => {
        expect(isVariousArtistsById("deezer", 5080)).toBe(true);
        expect(isVariousArtistsById("deezer", "5080")).toBe(true);
        expect(isVariousArtistsById("spotify", "5080")).toBe(false);
    });

    it("handles diacritics and preferred-name selection", () => {
        expect(hasDiacritics("Ólafur")).toBe(true);
        expect(hasDiacritics("Olafur")).toBe(false);
        expect(getPreferredArtistName("Olafur Arnalds", "Ólafur Arnalds")).toBe(
            "Ólafur Arnalds"
        );
        expect(getPreferredArtistName("Short", "Longer Name")).toBe(
            "Longer Name"
        );
    });

    it("normalizes artist and album names", () => {
        expect(normalizeArtistName(" Of  Mice & Men ")).toBe("of mice and men");
        expect(normalizeArtistName("Björk")).toBe("bjork");
        expect(normalizeArtistName(null as any)).toBe("");
        expect(normalizeAlbumTitle("  A Love Supreme  ")).toBe("a love supreme");
        expect(normalizeAlbumTitle(null as any)).toBe("");
    });

    it("strips album edition markers and guards oversized input", () => {
        expect(stripAlbumEdition("Abbey Road (2019 Remaster)")).toBe("Abbey Road");
        expect(stripAlbumEdition("In Rainbows [Deluxe Edition]")).toBe(
            "In Rainbows"
        );
        expect(stripAlbumEdition("Album Name - Expanded Edition")).toBe(
            "Album Name"
        );
        expect(stripAlbumEdition("Record (2020)")).toBe("Record");

        const huge = ` ${"x".repeat(501)} `;
        expect(stripAlbumEdition(huge)).toBe("x".repeat(501));
    });

    it("supports fuzzy artist similarity and best-match lookup", () => {
        expect(areArtistNamesSimilar("The Weeknd", "The Weekend", 70)).toBe(true);
        expect(areArtistNamesSimilar("Miles Davis", "Metallica", 90)).toBe(false);
        expect(areArtistNamesSimilar(null as any, "Artist", 80)).toBe(false);

        expect(
            findBestArtistMatch(
                "The Weekend",
                ["Metallica", "The Weeknd", "Boards of Canada"],
                70
            )
        ).toBe("The Weeknd");
        expect(
            findBestArtistMatch("No Match", ["Metallica", "Daft Punk"], 95)
        ).toBeNull();
        expect(findBestArtistMatch("Anything", [], 50)).toBeNull();
    });

    it("extracts primary artists while preserving known band-name patterns", () => {
        expect(extractPrimaryArtist("Artist feat. Someone")).toBe("Artist");
        expect(extractPrimaryArtist("Artist ft. Someone")).toBe("Artist");
        expect(extractPrimaryArtist("CHVRCHES & Robert Smith")).toBe("CHVRCHES");
        expect(extractPrimaryArtist("Artist, Guest Artist")).toBe("Artist");

        expect(extractPrimaryArtist("Earth, Wind & Fire")).toBe(
            "Earth, Wind & Fire"
        );
        expect(extractPrimaryArtist("The Naked and Famous")).toBe(
            "The Naked and Famous"
        );
        expect(extractPrimaryArtist("Of Mice & Men")).toBe("Of Mice & Men");
        expect(extractPrimaryArtist("")).toBe("Unknown Artist");
    });

    it("parses artist names from common folder path patterns", () => {
        expect(parseArtistFromPath("Artist Name - Album Name (2022) FLAC")).toBe(
            "Artist Name"
        );
        expect(
            parseArtistFromPath("Artist.Name-Album.Name-24BIT-FLAC-2023-GROUP")
        ).toBe("Artist.Name");
        expect(parseArtistFromPath("FLAC-2023")).toBe("FLAC");
        expect(parseArtistFromPath("")).toBeNull();
    });
});
