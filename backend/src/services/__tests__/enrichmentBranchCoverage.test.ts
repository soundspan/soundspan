const prisma = {
    user: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({ prisma }));
jest.mock("../metadata/artistEnrichmentFields", () => ({
    enrichArtistFields: jest.fn(),
    applyArtistEnrichmentFields: jest.fn(),
}));
jest.mock("../metadata/albumEnrichmentFields", () => ({
    enrichAlbumFields: jest.fn(),
    applyAlbumEnrichmentFields: jest.fn(),
}));

import { EnrichmentService } from "../enrichment";

describe("enrichment settings normalization", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.user.findUnique.mockResolvedValue(null);
        prisma.user.update.mockResolvedValue({});
    });

    it("returns independent defaults when no persisted settings exist", async () => {
        const service = new EnrichmentService();
        const first = await service.getSettings("user-1");
        const second = await service.getSettings("user-2");

        expect(first).toEqual(second);
        expect(first).not.toBe(second);
        expect(first).toEqual(
            expect.objectContaining({
                enabled: false,
                sources: expect.objectContaining({ lastfm: true }),
            }),
        );
    });

    it("falls back safely for invalid persisted field types", async () => {
        prisma.user.findUnique.mockResolvedValueOnce({
            enrichmentSettings: {
                enabled: "yes",
                sources: null,
                rateLimit: { maxRequestsPerMinute: "fast" },
                matchingConfidence: "unknown",
            },
        });

        await expect(
            new EnrichmentService().getSettings("user-1"),
        ).resolves.toEqual(
            expect.objectContaining({
                enabled: false,
                matchingConfidence: "moderate",
                sources: {
                    musicbrainz: true,
                    lastfm: true,
                    coverArtArchive: true,
                },
                rateLimit: {
                    maxRequestsPerMinute: 30,
                    respectApiLimits: true,
                },
            }),
        );
    });
});
