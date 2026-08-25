const log = {
    debug: jest.fn(),
    error: jest.fn(),
};

jest.mock("../../../utils/logger", () => ({
    logger: { child: jest.fn(() => log) },
}));

const prisma = {
    artist: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
};

jest.mock("../../../utils/db", () => ({ prisma }));

const musicBrainzService = {
    searchArtist: jest.fn(),
};

jest.mock("../../musicbrainz", () => ({ musicBrainzService }));

const wikidataService = {
    getArtistInfo: jest.fn(),
};

jest.mock("../../wikidata", () => ({ wikidataService }));

const lastFmService = {
    getArtistInfo: jest.fn(),
    getSimilarArtists: jest.fn(),
};

jest.mock("../../lastfm", () => ({ lastFmService }));

const resolveArtistImage = jest.fn();

jest.mock("../artistImageResolver", () => ({ resolveArtistImage }));

const downloadAndStoreImage = jest.fn();
const isNativePath = jest.fn();

jest.mock("../../imageStorage", () => ({
    downloadAndStoreImage,
    isNativePath,
}));

import {
    applyArtistEnrichmentFields,
    enrichArtistFields,
    resolveArtistEnrichmentFields,
} from "../artistEnrichmentFields";

const ARTIST_MBID = "11111111-1111-4111-8111-111111111111";

describe("artist enrichment fields", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.artist.findUnique.mockResolvedValue(null);
        prisma.artist.update.mockResolvedValue({});
        musicBrainzService.searchArtist.mockResolvedValue([]);
        wikidataService.getArtistInfo.mockResolvedValue({});
        lastFmService.getArtistInfo.mockResolvedValue(null);
        lastFmService.getSimilarArtists.mockResolvedValue([]);
        resolveArtistImage.mockResolvedValue(null);
        downloadAndStoreImage.mockResolvedValue(null);
        isNativePath.mockReturnValue(false);
    });

    it("prefers Wikidata summary and keeps the top five Last.fm genres", async () => {
        wikidataService.getArtistInfo.mockResolvedValueOnce({
            summary: "Wikidata summary",
        });
        lastFmService.getArtistInfo.mockResolvedValueOnce({
            bio: { summary: "Last.fm summary" },
            tags: {
                tag: [
                    { name: "rock" },
                    { name: "indie" },
                    { name: "alternative" },
                    { name: "shoegaze" },
                    { name: "dream pop" },
                    { name: "sixth" },
                ],
            },
        });
        resolveArtistImage.mockResolvedValueOnce({
            url: "https://images.example/artist.jpg",
            source: "wikidata",
        });

        const result = await resolveArtistEnrichmentFields({
            id: "artist-1",
            name: "Artist One",
            mbid: ARTIST_MBID,
        });

        expect(result).toEqual(
            expect.objectContaining({
                bio: "Wikidata summary",
                tags: [
                    "rock",
                    "indie",
                    "alternative",
                    "shoegaze",
                    "dream pop",
                    "sixth",
                ],
                genres: [
                    "rock",
                    "indie",
                    "alternative",
                    "shoegaze",
                    "dream pop",
                ],
                heroUrl: "https://images.example/artist.jpg",
            }),
        );
        expect(lastFmService.getArtistInfo).toHaveBeenCalledWith(
            "Artist One",
            ARTIST_MBID,
        );
    });

    it("falls back from Wikidata to Last.fm bio content", async () => {
        wikidataService.getArtistInfo.mockResolvedValueOnce({});
        lastFmService.getArtistInfo.mockResolvedValueOnce({
            bio: { content: "Last.fm content" },
            tags: { tag: [] },
        });

        const result = await resolveArtistEnrichmentFields({
            id: "artist-2",
            name: "Artist Two",
            mbid: ARTIST_MBID,
        });

        expect(result.bio).toBe("Last.fm content");
    });

    it("tolerates missing and failing providers", async () => {
        wikidataService.getArtistInfo.mockRejectedValueOnce(
            new Error("wikidata unavailable"),
        );
        lastFmService.getArtistInfo.mockRejectedValueOnce(
            new Error("lastfm unavailable"),
        );
        resolveArtistImage.mockRejectedValueOnce(
            new Error("images unavailable"),
        );

        await expect(
            resolveArtistEnrichmentFields({
                id: "artist-3",
                name: "Artist Three",
                mbid: ARTIST_MBID,
            }),
        ).resolves.toEqual({ confidence: 0 });
    });

    it("loads admin enrichment and applies the worker-owned column mapping", async () => {
        prisma.artist.findUnique
            .mockResolvedValueOnce({
                id: "artist-4",
                name: "Artist Four",
                mbid: ARTIST_MBID,
            })
            .mockResolvedValueOnce(null);
        wikidataService.getArtistInfo.mockResolvedValueOnce({
            summary: "Shared summary",
        });
        lastFmService.getArtistInfo.mockResolvedValueOnce({
            tags: { tag: [{ name: "ambient" }] },
        });
        resolveArtistImage.mockResolvedValueOnce({
            url: "https://images.example/shared.jpg",
            source: "deezer",
        });
        downloadAndStoreImage.mockResolvedValueOnce("/images/artist-4.jpg");

        const data = await enrichArtistFields("artist-4");
        await applyArtistEnrichmentFields("artist-4", data);

        expect(prisma.artist.update).toHaveBeenCalledWith({
            where: { id: "artist-4" },
            data: {
                summary: "Shared summary",
                heroUrl: "/images/artist-4.jpg",
                genres: ["ambient"],
            },
        });
    });
});
