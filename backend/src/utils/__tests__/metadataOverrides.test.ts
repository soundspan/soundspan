import {
    getAlbumDisplayCoverUrl,
    getAlbumDisplayTitle,
    getAlbumDisplayYear,
    getAlbumEffectiveGenres,
    getArtistDisplayHeroUrl,
    getArtistDisplayName,
    getArtistDisplaySummary,
    getArtistEffectiveGenres,
    getMergedGenres,
    getTrackDisplayNumber,
    getTrackDisplayTitle,
    hasOverrides,
} from "../metadataOverrides";

describe("metadataOverrides", () => {
    it("prefers override fields for artist, album, and track display values", () => {
        const artist = {
            name: "Canonical Artist",
            displayName: "User Artist",
            userSummary: "User summary",
            summary: "Canonical summary",
            userHeroUrl: "https://user.hero",
            heroUrl: "https://canonical.hero",
            hasUserOverrides: true,
        } as any;
        const album = {
            title: "Canonical Album",
            displayTitle: "User Album",
            year: 1999,
            displayYear: 2000,
            userCoverUrl: "https://user.cover",
            coverUrl: "https://canonical.cover",
            hasUserOverrides: true,
        } as any;
        const track = {
            title: "Canonical Track",
            displayTitle: "User Track",
            trackNo: 3,
            displayTrackNo: 9,
            hasUserOverrides: true,
        } as any;

        expect(getArtistDisplayName(artist)).toBe("User Artist");
        expect(getArtistDisplaySummary(artist)).toBe("User summary");
        expect(getArtistDisplayHeroUrl(artist)).toBe("https://user.hero");
        expect(getAlbumDisplayTitle(album)).toBe("User Album");
        expect(getAlbumDisplayYear(album)).toBe(2000);
        expect(getAlbumDisplayCoverUrl(album)).toBe("https://user.cover");
        expect(getTrackDisplayTitle(track)).toBe("User Track");
        expect(getTrackDisplayNumber(track)).toBe(9);
        expect(hasOverrides(track)).toBe(true);
    });

    it("falls back to canonical values when overrides are absent", () => {
        const artist = {
            name: "Canonical Artist",
            displayName: null,
            userSummary: null,
            summary: "Canonical summary",
            userHeroUrl: null,
            heroUrl: "https://canonical.hero",
            hasUserOverrides: false,
        } as any;
        const album = {
            title: "Canonical Album",
            displayTitle: null,
            year: 1984,
            displayYear: null,
            userCoverUrl: null,
            coverUrl: "https://canonical.cover",
            hasUserOverrides: false,
        } as any;
        const track = {
            title: "Canonical Track",
            displayTitle: null,
            trackNo: 7,
            displayTrackNo: null,
            hasUserOverrides: false,
        } as any;

        expect(getArtistDisplayName(artist)).toBe("Canonical Artist");
        expect(getArtistDisplaySummary(artist)).toBe("Canonical summary");
        expect(getArtistDisplayHeroUrl(artist)).toBe("https://canonical.hero");
        expect(getAlbumDisplayTitle(album)).toBe("Canonical Album");
        expect(getAlbumDisplayYear(album)).toBe(1984);
        expect(getAlbumDisplayCoverUrl(album)).toBe("https://canonical.cover");
        expect(getTrackDisplayTitle(track)).toBe("Canonical Track");
        expect(getTrackDisplayNumber(track)).toBe(7);
        expect(hasOverrides(album)).toBe(false);
    });

    it("returns null for display fields with no override and no canonical values", () => {
        const artist = {
            userSummary: null,
            summary: null,
            userHeroUrl: null,
            heroUrl: null,
        } as any;
        const album = {
            displayYear: null,
            year: null,
            userCoverUrl: null,
            coverUrl: null,
        } as any;

        expect(getArtistDisplaySummary(artist)).toBeNull();
        expect(getArtistDisplayHeroUrl(artist)).toBeNull();
        expect(getAlbumDisplayYear(album)).toBeNull();
        expect(getAlbumDisplayCoverUrl(album)).toBeNull();
    });

    it("merges user and canonical genres with de-duplication and user priority", () => {
        expect(
            getMergedGenres({
                genres: ["rock", "metal"],
                userGenres: ["metal", "ambient"],
            })
        ).toEqual(["metal", "ambient", "rock"]);
    });

    it("supports JSON genre payloads and effective genre helpers", () => {
        const artist = {
            genres: "[\"rock\",\"indie\"]",
            userGenres: "[\"indie\",\"shoegaze\"]",
        } as any;
        const album = {
            genres: ["soul"],
            userGenres: null,
        } as any;

        expect(getMergedGenres({ genres: null, userGenres: null })).toEqual([]);
        expect(getArtistEffectiveGenres(artist)).toEqual([
            "indie",
            "shoegaze",
            "rock",
        ]);
        expect(getAlbumEffectiveGenres(album)).toEqual(["soul"]);
    });
});

