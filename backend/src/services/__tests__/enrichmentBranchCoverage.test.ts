const logger = {
    debug: jest.fn(),
    error: jest.fn(),
};
jest.mock("../../utils/logger", () => ({ logger }));

const prisma = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    artist: { findUnique: jest.fn(), update: jest.fn() },
    album: { findUnique: jest.fn(), update: jest.fn() },
    ownedAlbum: { upsert: jest.fn() },
};
jest.mock("../../utils/db", () => ({ prisma }));

const lastFmService = {
    getArtistInfo: jest.fn(),
    getSimilarArtists: jest.fn(),
    getAlbumInfo: jest.fn(),
};
jest.mock("../lastfm", () => ({ lastFmService }));

const musicBrainzService = {
    searchArtist: jest.fn(),
    getReleaseGroups: jest.fn(),
    getReleaseGroup: jest.fn(),
    getRelease: jest.fn(),
};
jest.mock("../musicbrainz", () => ({ musicBrainzService }));

const imageProviderService = {
    getArtistImage: jest.fn(),
    getAlbumCover: jest.fn(),
};
jest.mock("../imageProvider", () => ({ imageProviderService }));

const mockDownloadAndStoreImage = jest.fn();
const mockIsNativePath = jest.fn();
jest.mock("../imageStorage", () => ({
    downloadAndStoreImage: (...args: unknown[]) => mockDownloadAndStoreImage(...args),
    isNativePath: (...args: unknown[]) => mockIsNativePath(...args),
}));

import { EnrichmentService } from "../enrichment";

const enabledConfig = {
    enabled: true,
    autoEnrichOnScan: false,
    sources: {
        musicbrainz: true,
        lastfm: true,
        coverArtArchive: true,
    },
    rateLimit: {
        maxRequestsPerMinute: 30,
        respectApiLimits: true,
    },
    overwriteExisting: false,
    matchingConfidence: "moderate" as const,
};

describe("enrichment branch coverage", () => {
    beforeEach(() => {
        jest.clearAllMocks();

        prisma.user.findUnique.mockResolvedValue(null);
        prisma.user.update.mockResolvedValue({});
        prisma.artist.findUnique.mockResolvedValue(null);
        prisma.artist.update.mockResolvedValue({});
        prisma.album.findUnique.mockResolvedValue(null);
        prisma.album.update.mockResolvedValue({});
        prisma.ownedAlbum.upsert.mockResolvedValue({});

        musicBrainzService.searchArtist.mockResolvedValue([]);
        musicBrainzService.getReleaseGroups.mockResolvedValue([]);
        musicBrainzService.getReleaseGroup.mockResolvedValue(null);
        musicBrainzService.getRelease.mockResolvedValue(null);

        lastFmService.getArtistInfo.mockResolvedValue(null);
        lastFmService.getSimilarArtists.mockResolvedValue([]);
        lastFmService.getAlbumInfo.mockResolvedValue(null);

        imageProviderService.getArtistImage.mockResolvedValue(null);
        imageProviderService.getAlbumCover.mockResolvedValue(null);

        mockDownloadAndStoreImage.mockResolvedValue(null);
        mockIsNativePath.mockReturnValue(false);
    });

    it("getSettings returns defaults and deeply merges partial nested object settings", async () => {
        const service = new EnrichmentService();

        await expect(service.getSettings("u0")).resolves.toEqual(
            expect.objectContaining({ enabled: false, sources: expect.any(Object) })
        );

        prisma.user.findUnique.mockResolvedValueOnce({
            enrichmentSettings: {
                enabled: true,
                sources: { lastfm: false },
                rateLimit: { respectApiLimits: false },
            },
        });

        await expect(service.getSettings("u1")).resolves.toEqual(
            expect.objectContaining({
                enabled: true,
                sources: {
                    musicbrainz: true,
                    lastfm: false,
                    coverArtArchive: true,
                },
                rateLimit: {
                    maxRequestsPerMinute: 30,
                    respectApiLimits: false,
                },
            })
        );
    });

    it("enrichArtist skips musicbrainz on stable mbid and handles lastfm/image failures", async () => {
        const service = new EnrichmentService();

        prisma.artist.findUnique.mockResolvedValueOnce({
            id: "artist-1",
            name: "Artist One",
            mbid: "mbid-stable",
        });
        lastFmService.getArtistInfo.mockRejectedValueOnce(new Error("lastfm timeout"));
        imageProviderService.getArtistImage.mockRejectedValueOnce(
            new Error("image provider timeout")
        );

        const result = await service.enrichArtist("artist-1", enabledConfig);
        expect(result).toEqual({ confidence: 0 });
        expect(musicBrainzService.searchArtist).not.toHaveBeenCalled();
        expect(lastFmService.getArtistInfo).toHaveBeenCalledWith("Artist One", "mbid-stable");
    });

    it("enrichArtist uses undefined/empty fallback for temp mbids and maps minimal lastfm data", async () => {
        const service = new EnrichmentService();

        prisma.artist.findUnique.mockResolvedValueOnce({
            id: "artist-2",
            name: "Artist Temp",
            mbid: "temp-artist",
        });
        musicBrainzService.searchArtist.mockResolvedValueOnce([]);
        lastFmService.getArtistInfo.mockResolvedValueOnce({
            bio: {},
            tags: undefined,
        });
        lastFmService.getSimilarArtists.mockResolvedValueOnce([]);

        const result = await service.enrichArtist("artist-2", enabledConfig);
        expect(result).toEqual({ bio: undefined, tags: [], genres: [], similarArtists: [], confidence: 0.3 });
        expect(lastFmService.getArtistInfo).toHaveBeenCalledWith("Artist Temp", undefined);
        expect(lastFmService.getSimilarArtists).toHaveBeenCalledWith("", "Artist Temp", 10);
    });

    it("enrichAlbum handles title normalization match, label lookup failure, and cover failure", async () => {
        const service = new EnrichmentService();

        prisma.album.findUnique.mockResolvedValueOnce({
            id: "album-1",
            title: "My Album!",
            artist: { name: "Artist A", mbid: "artist-mbid" },
        });
        musicBrainzService.getReleaseGroups.mockResolvedValueOnce([
            {
                id: "rg-1",
                title: "My Album",
                "primary-type": "Album",
                "first-release-date": "2000-01-02",
            },
        ]);
        musicBrainzService.getReleaseGroup.mockResolvedValueOnce({
            releases: [{ id: "release-1" }],
        });
        musicBrainzService.getRelease.mockRejectedValueOnce(new Error("release fetch failed"));
        lastFmService.getAlbumInfo.mockResolvedValueOnce({ tags: undefined, tracks: undefined });
        imageProviderService.getAlbumCover.mockRejectedValueOnce(new Error("cover timeout"));

        const result = await service.enrichAlbum("album-1", enabledConfig);
        expect(result).toEqual({
            rgMbid: "rg-1",
            albumType: "Album",
            releaseDate: new Date("2000-01-02"),
            tags: [],
            genres: [],
            trackCount: undefined,
            confidence: 0.8,
        });
    });

    it("applyArtistEnrichment skips update for empty payload and falls back to remote hero when download fails", async () => {
        const service = new EnrichmentService();

        await service.applyArtistEnrichment("artist-a", { confidence: 0.1 });
        expect(prisma.artist.update).not.toHaveBeenCalled();

        prisma.artist.findUnique.mockResolvedValueOnce(null);
        mockIsNativePath.mockReturnValueOnce(false);
        mockDownloadAndStoreImage.mockResolvedValueOnce(null);

        await service.applyArtistEnrichment("artist-a", {
            mbid: "unique-mbid",
            heroUrl: "https://remote/hero.jpg",
            genres: [],
            confidence: 0.9,
        });

        expect(prisma.artist.update).toHaveBeenCalledWith({
            where: { id: "artist-a" },
            data: {
                mbid: "unique-mbid",
                heroUrl: "https://remote/hero.jpg",
            },
        });
    });

    it("applyAlbumEnrichment respects native cover paths and skips ownedAlbum upsert when album missing", async () => {
        const service = new EnrichmentService();
        mockIsNativePath.mockReturnValueOnce(true);
        prisma.album.findUnique.mockResolvedValueOnce(null);

        await service.applyAlbumEnrichment("album-x", {
            rgMbid: "rg-x",
            coverUrl: "/native/cover.jpg",
            releaseDate: new Date("1998-09-10"),
            genres: ["electronic"],
            confidence: 1,
        });

        expect(prisma.album.update).toHaveBeenCalledWith({
            where: { id: "album-x" },
            data: {
                rgMbid: "rg-x",
                coverUrl: "/native/cover.jpg",
                originalYear: 1998,
                year: 1998,
                genres: ["electronic"],
            },
        });
        expect(prisma.ownedAlbum.upsert).not.toHaveBeenCalled();
    });
});
