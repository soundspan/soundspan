const logger = {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};
jest.mock("../../utils/logger", () => ({
    logger,
}));

const prisma = {
    user: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
    artist: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
    album: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
    ownedAlbum: {
        upsert: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({
    prisma,
}));

const lastFmService = {
    getArtistInfo: jest.fn(),
    getSimilarArtists: jest.fn(),
    getAlbumInfo: jest.fn(),
};
jest.mock("../lastfm", () => ({
    lastFmService,
}));

const musicBrainzService = {
    searchArtist: jest.fn(),
    getReleaseGroups: jest.fn(),
    getReleaseGroup: jest.fn(),
    getRelease: jest.fn(),
};
jest.mock("../musicbrainz", () => ({
    musicBrainzService,
}));

const imageProviderService = {
    getArtistImage: jest.fn(),
    getAlbumCover: jest.fn(),
};
jest.mock("../imageProvider", () => ({
    imageProviderService,
}));

const mockDownloadAndStoreImage = jest.fn();
const mockIsNativePath = jest.fn();
jest.mock("../imageStorage", () => ({
    downloadAndStoreImage: (...args: any[]) => mockDownloadAndStoreImage(...args),
    isNativePath: (...args: any[]) => mockIsNativePath(...args),
}));

import { EnrichmentService } from "../enrichment";

describe("enrichment service behavior", () => {
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

    it("merges persisted settings with defaults and updates settings payloads", async () => {
        const service = new EnrichmentService();
        prisma.user.findUnique.mockResolvedValueOnce({
            enrichmentSettings: JSON.stringify({
                enabled: true,
                sources: { lastfm: false },
                rateLimit: { maxRequestsPerMinute: 75 },
                matchingConfidence: "strict",
            }),
        });

        const settings = await service.getSettings("user-1");
        expect(settings).toEqual({
            enabled: true,
            autoEnrichOnScan: false,
            sources: {
                musicbrainz: true,
                lastfm: false,
                coverArtArchive: true,
            },
            rateLimit: {
                maxRequestsPerMinute: 75,
                respectApiLimits: true,
            },
            overwriteExisting: false,
            matchingConfidence: "strict",
        });

        prisma.user.findUnique.mockResolvedValueOnce({
            enrichmentSettings: {
                enabled: false,
                sources: { coverArtArchive: false },
                rateLimit: { respectApiLimits: false },
            },
        });
        const updated = await service.updateSettings("user-1", {
            enabled: true,
            autoEnrichOnScan: true,
        });

        expect(updated).toEqual(
            expect.objectContaining({
                enabled: true,
                autoEnrichOnScan: true,
                sources: expect.objectContaining({
                    coverArtArchive: false,
                }),
                rateLimit: expect.objectContaining({
                    respectApiLimits: false,
                }),
            })
        );
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: "user-1" },
            data: {
                enrichmentSettings: expect.any(String),
            },
        });
    });

    it("enriches artist metadata with MusicBrainz, Last.fm, and image provider data", async () => {
        const service = new EnrichmentService();
        prisma.artist.findUnique.mockResolvedValueOnce({
            id: "artist-1",
            name: "Artist A",
            mbid: "temp-artist-a",
        });
        musicBrainzService.searchArtist.mockResolvedValueOnce([
            { id: "mbid-artist-a" },
        ]);
        lastFmService.getArtistInfo.mockResolvedValueOnce({
            bio: { summary: "Bio Summary" },
            tags: {
                tag: [
                    { name: "rock" },
                    { name: "alternative" },
                    { name: "indie" },
                    { name: "extra" },
                ],
            },
        });
        lastFmService.getSimilarArtists.mockResolvedValueOnce([
            { name: "Similar 1" },
            { name: "Similar 2" },
        ]);
        imageProviderService.getArtistImage.mockResolvedValueOnce({
            url: "https://images/artist-a.jpg",
            source: "deezer",
        });

        const result = await service.enrichArtist("artist-1", {
            enabled: true,
            autoEnrichOnScan: true,
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
            matchingConfidence: "moderate",
        });

        expect(result).toEqual(
            expect.objectContaining({
                mbid: "mbid-artist-a",
                bio: "Bio Summary",
                tags: ["rock", "alternative", "indie", "extra"],
                genres: ["rock", "alternative", "indie"],
                similarArtists: ["Similar 1", "Similar 2"],
                heroUrl: "https://images/artist-a.jpg",
            })
        );
        expect(result?.confidence).toBeCloseTo(0.9, 5);
    });

    it("returns null for disabled artist enrichment and throws when artist is missing", async () => {
        const service = new EnrichmentService();

        await expect(service.enrichArtist("artist-1")).resolves.toBeNull();

        prisma.artist.findUnique.mockResolvedValueOnce(null);
        await expect(
            service.enrichArtist("missing-artist", {
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
                matchingConfidence: "moderate",
            })
        ).rejects.toThrow("Artist missing-artist not found");
    });

    it("handles artist enrichment source failures without aborting", async () => {
        const service = new EnrichmentService();
        prisma.artist.findUnique.mockResolvedValueOnce({
            id: "artist-2",
            name: "Artist B",
            mbid: "mbid-existing",
        });
        lastFmService.getArtistInfo.mockRejectedValueOnce(new Error("lastfm down"));
        imageProviderService.getArtistImage.mockRejectedValueOnce(
            new Error("image down")
        );

        await expect(
            service.enrichArtist("artist-2", {
                enabled: true,
                autoEnrichOnScan: false,
                sources: {
                    musicbrainz: false,
                    lastfm: true,
                    coverArtArchive: true,
                },
                rateLimit: {
                    maxRequestsPerMinute: 30,
                    respectApiLimits: true,
                },
                overwriteExisting: false,
                matchingConfidence: "moderate",
            })
        ).resolves.toEqual({ confidence: 0 });
    });

    it("enriches album metadata including MBID, labels, tags, and cover art", async () => {
        const service = new EnrichmentService();
        prisma.album.findUnique.mockResolvedValueOnce({
            id: "album-1",
            title: "My Album",
            artist: {
                name: "Artist A",
                mbid: "artist-mbid",
            },
        });
        musicBrainzService.getReleaseGroups.mockResolvedValueOnce([
            {
                id: "rg-1",
                title: "My Album!",
                "primary-type": "Album",
                "first-release-date": "2001-02-03",
            },
        ]);
        musicBrainzService.getReleaseGroup.mockResolvedValueOnce({
            releases: [{ id: "release-1" }],
        });
        musicBrainzService.getRelease.mockResolvedValueOnce({
            "label-info": [{ label: { name: "Label A" } }],
        });
        lastFmService.getAlbumInfo.mockResolvedValueOnce({
            tags: { tag: [{ name: "metal" }, { name: "progressive" }] },
            tracks: { track: [{}, {}, {}] },
        });
        imageProviderService.getAlbumCover.mockResolvedValueOnce({
            url: "https://images/album-a.jpg",
            source: "musicbrainz",
        });

        const result = await service.enrichAlbum("album-1", {
            enabled: true,
            autoEnrichOnScan: true,
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
            matchingConfidence: "moderate",
        });

        expect(result).toEqual({
            rgMbid: "rg-1",
            albumType: "Album",
            releaseDate: new Date("2001-02-03"),
            label: "Label A",
            tags: ["metal", "progressive"],
            genres: ["metal", "progressive"],
            trackCount: 3,
            coverUrl: "https://images/album-a.jpg",
            confidence: 1,
        });
    });

    it("returns null for disabled album enrichment and throws when album is missing", async () => {
        const service = new EnrichmentService();

        await expect(service.enrichAlbum("album-1")).resolves.toBeNull();

        prisma.album.findUnique.mockResolvedValueOnce(null);
        await expect(
            service.enrichAlbum("missing-album", {
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
                matchingConfidence: "moderate",
            })
        ).rejects.toThrow("Album missing-album not found");
    });

    it("applies artist enrichment while handling MBID conflicts and native/external hero urls", async () => {
        const service = new EnrichmentService();
        prisma.artist.findUnique.mockResolvedValueOnce({
            id: "artist-other",
            name: "Other Artist",
        });
        mockIsNativePath.mockReturnValueOnce(false).mockReturnValueOnce(true);
        mockDownloadAndStoreImage.mockResolvedValueOnce("/covers/artist-1.jpg");

        await service.applyArtistEnrichment("artist-1", {
            mbid: "mbid-dup",
            bio: "Artist Bio",
            heroUrl: "https://images/external.jpg",
            genres: ["rock", "indie"],
            confidence: 0.8,
        });

        expect(prisma.artist.update).toHaveBeenCalledWith({
            where: { id: "artist-1" },
            data: {
                summary: "Artist Bio",
                heroUrl: "/covers/artist-1.jpg",
                genres: ["rock", "indie"],
            },
        });

        await service.applyArtistEnrichment("artist-1", {
            heroUrl: "/local/native/path.jpg",
            confidence: 0.2,
        });
        expect(prisma.artist.update).toHaveBeenLastCalledWith({
            where: { id: "artist-1" },
            data: {
                heroUrl: "/local/native/path.jpg",
            },
        });
    });

    it("applies album enrichment, persists owned albums for MBIDs, and skips empty updates", async () => {
        const service = new EnrichmentService();
        mockIsNativePath.mockReturnValue(false);
        mockDownloadAndStoreImage.mockResolvedValueOnce(null);
        prisma.album.findUnique.mockResolvedValueOnce({
            artistId: "artist-1",
        });

        await service.applyAlbumEnrichment("album-1", {
            rgMbid: "rg-1",
            coverUrl: "https://images/external-cover.jpg",
            releaseDate: new Date("1999-05-06"),
            label: "Label Z",
            genres: ["jazz"],
            confidence: 0.9,
        });

        expect(prisma.album.update).toHaveBeenCalledWith({
            where: { id: "album-1" },
            data: {
                rgMbid: "rg-1",
                coverUrl: "https://images/external-cover.jpg",
                originalYear: 1999,
                year: 1999,
                label: "Label Z",
                genres: ["jazz"],
            },
        });
        expect(prisma.ownedAlbum.upsert).toHaveBeenCalledWith({
            where: {
                artistId_rgMbid: {
                    artistId: "artist-1",
                    rgMbid: "rg-1",
                },
            },
            create: {
                artistId: "artist-1",
                rgMbid: "rg-1",
                source: "enrichment",
            },
            update: {},
        });

        await service.applyAlbumEnrichment("album-2", {
            confidence: 0.1,
        });
        expect(prisma.album.update).toHaveBeenCalledTimes(1);
    });
});
