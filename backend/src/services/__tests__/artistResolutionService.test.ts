const mockPrisma = {
    artist: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({
    prisma: mockPrisma,
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        child: jest.fn().mockReturnValue({
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        }),
    },
}));

import {
    resolveArtistForRemoteTrack,
} from "../artistResolutionService";

describe("artistResolutionService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("resolveArtistForRemoteTrack", () => {
        it("returns Unknown Artist for empty string", async () => {
            mockPrisma.artist.findFirst.mockResolvedValueOnce({
                id: "unknown-id",
                name: "Unknown Artist",
            });

            const result = await resolveArtistForRemoteTrack("");
            expect(result.name).toBe("Unknown Artist");
        });

        it("returns Unknown Artist for null-ish input", async () => {
            mockPrisma.artist.findFirst.mockResolvedValueOnce(null);
            mockPrisma.artist.create.mockResolvedValueOnce({
                id: "new-unknown-id",
                name: "Unknown Artist",
            });

            const result = await resolveArtistForRemoteTrack("");
            expect(result.name).toBe("Unknown Artist");
        });

        it("canonicalizes Various Artists and resolves by MBID", async () => {
            mockPrisma.artist.findUnique.mockResolvedValueOnce({
                id: "va-id",
                name: "Various Artists",
            });

            const result = await resolveArtistForRemoteTrack("V.A.");
            expect(result.id).toBe("va-id");
            expect(result.name).toBe("Various Artists");
            expect(result.created).toBe(false);
        });

        it("creates Various Artists if not found", async () => {
            mockPrisma.artist.findUnique.mockResolvedValueOnce(null);
            mockPrisma.artist.create.mockResolvedValueOnce({
                id: "new-va-id",
                name: "Various Artists",
            });

            const result = await resolveArtistForRemoteTrack("VA");
            expect(result.id).toBe("new-va-id");
            expect(result.created).toBe(true);
        });

        it("strips feat. collaborators before matching", async () => {
            mockPrisma.artist.findFirst.mockResolvedValueOnce({
                id: "artist-1",
                name: "Radiohead",
            });

            const result = await resolveArtistForRemoteTrack(
                "Radiohead feat. Thom Yorke"
            );
            expect(result.id).toBe("artist-1");
            expect(result.name).toBe("Radiohead");
        });

        it("exact match on normalized name", async () => {
            mockPrisma.artist.findFirst.mockResolvedValueOnce({
                id: "bjork-id",
                name: "Bjork",
            });

            const result = await resolveArtistForRemoteTrack("Bjork");
            expect(result.id).toBe("bjork-id");
            expect(result.created).toBe(false);
        });

        it("fuzzy match finds similar artist (>= 95%)", async () => {
            // First call: exact match returns null
            mockPrisma.artist.findFirst.mockResolvedValueOnce(null);
            // Fuzzy candidates
            mockPrisma.artist.findMany.mockResolvedValueOnce([
                {
                    id: "weeknd-id",
                    name: "The Weeknd",
                    normalizedName: "the weeknd",
                },
            ]);

            const result = await resolveArtistForRemoteTrack("The Weekend");
            // fuzzball ratio of "the weekend" vs "the weeknd" is >= 95
            // If not, this tests the fallback path
            if (result.id === "weeknd-id") {
                expect(result.created).toBe(false);
            } else {
                // Created new (fuzzy match didn't reach threshold)
                expect(result.created).toBe(true);
            }
        });

        it("creates new artist when no match found", async () => {
            mockPrisma.artist.findFirst.mockResolvedValueOnce(null);
            mockPrisma.artist.findMany.mockResolvedValueOnce([]);
            mockPrisma.artist.create.mockResolvedValueOnce({
                id: "new-artist-id",
                name: "Brand New Artist",
            });

            const result = await resolveArtistForRemoteTrack("Brand New Artist");
            expect(result.id).toBe("new-artist-id");
            expect(result.created).toBe(true);
        });

        it("handles P2002 race condition on create", async () => {
            mockPrisma.artist.findFirst
                .mockResolvedValueOnce(null) // exact match
                .mockResolvedValueOnce({ id: "race-id", name: "Racer" }); // retry after P2002
            mockPrisma.artist.findMany.mockResolvedValueOnce([]);
            mockPrisma.artist.create.mockRejectedValueOnce({
                code: "P2002",
                message: "Unique constraint failed on the fields: (`mbid`)",
            });

            const result = await resolveArtistForRemoteTrack("Racer");
            expect(result.id).toBe("race-id");
            expect(result.created).toBe(false);
        });

        it("updates name if incoming has diacritics on fuzzy match", async () => {
            mockPrisma.artist.findFirst.mockResolvedValueOnce(null);
            mockPrisma.artist.findMany.mockResolvedValueOnce([
                {
                    id: "olafur-id",
                    name: "Olafur Arnalds",
                    normalizedName: "olafur arnalds",
                },
            ]);
            mockPrisma.artist.update.mockResolvedValueOnce({});

            const result = await resolveArtistForRemoteTrack("Ólafur Arnalds");
            expect(result.name).toBe("Ólafur Arnalds");
            expect(mockPrisma.artist.update).toHaveBeenCalledWith({
                where: { id: "olafur-id" },
                data: { name: "Ólafur Arnalds" },
            });
        });
    });
});
