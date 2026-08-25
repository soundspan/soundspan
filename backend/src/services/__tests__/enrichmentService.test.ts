const prisma = {
    user: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({ prisma }));

const enrichArtistFields = jest.fn();
const applyArtistEnrichmentFields = jest.fn();
const enrichAlbumFields = jest.fn();
const applyAlbumEnrichmentFields = jest.fn();

jest.mock("../metadata/artistEnrichmentFields", () => ({
    enrichArtistFields,
    applyArtistEnrichmentFields,
}));
jest.mock("../metadata/albumEnrichmentFields", () => ({
    enrichAlbumFields,
    applyAlbumEnrichmentFields,
}));

import { EnrichmentService, type EnrichmentSettings } from "../enrichment";

const enabledSettings: EnrichmentSettings = {
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
};

describe("enrichment service compatibility facade", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.user.findUnique.mockResolvedValue(null);
        prisma.user.update.mockResolvedValue({});
        enrichArtistFields.mockResolvedValue({ confidence: 0.8 });
        enrichAlbumFields.mockResolvedValue({ confidence: 0.7 });
        applyArtistEnrichmentFields.mockResolvedValue(undefined);
        applyAlbumEnrichmentFields.mockResolvedValue(undefined);
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

        await expect(service.getSettings("user-1")).resolves.toEqual({
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
            enrichmentSettings: enabledSettings,
        });
        const updated = await service.updateSettings("user-1", {
            enabled: false,
        });

        expect(updated.enabled).toBe(false);
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: "user-1" },
            data: { enrichmentSettings: JSON.stringify(updated) },
        });
    });

    it("delegates enabled artist and album enrichment to shared field modules", async () => {
        const service = new EnrichmentService();

        await expect(
            service.enrichArtist("artist-1", enabledSettings),
        ).resolves.toEqual({ confidence: 0.8 });
        await expect(
            service.enrichAlbum("album-1", enabledSettings),
        ).resolves.toEqual({ confidence: 0.7 });

        expect(enrichArtistFields).toHaveBeenCalledWith("artist-1");
        expect(enrichAlbumFields).toHaveBeenCalledWith("album-1");
    });

    it("preserves disabled enrichment and delegates compatibility writes", async () => {
        const service = new EnrichmentService();
        await expect(service.enrichArtist("artist-1")).resolves.toBeNull();
        await expect(service.enrichAlbum("album-1")).resolves.toBeNull();

        const artistData = { confidence: 0.2, genres: ["rock"] };
        const albumData = { confidence: 0.2, genres: ["jazz"] };
        await service.applyArtistEnrichment("artist-1", artistData);
        await service.applyAlbumEnrichment("album-1", albumData);

        expect(applyArtistEnrichmentFields).toHaveBeenCalledWith(
            "artist-1",
            artistData,
        );
        expect(applyAlbumEnrichmentFields).toHaveBeenCalledWith(
            "album-1",
            albumData,
        );
    });
});
