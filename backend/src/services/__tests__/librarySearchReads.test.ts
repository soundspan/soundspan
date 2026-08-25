const prisma = {
    artist: { findMany: jest.fn() },
    album: { findMany: jest.fn() },
    track: { findMany: jest.fn() },
};

jest.mock("../../utils/db", () => ({ prisma }));

import { searchLibraryMusic } from "../librarySearchReads";

describe("library search reads", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.artist.findMany.mockResolvedValue([]);
        prisma.album.findMany.mockResolvedValue([]);
        prisma.track.findMany.mockResolvedValue([]);
    });

    it("applies independent paging and owned/federated visibility", async () => {
        await searchLibraryMusic({
            query: "Needle",
            albumLocations: ["LIBRARY", "FEDERATED"],
            artists: { limit: 3, offset: 11 },
            albums: { limit: 4, offset: 12 },
            tracks: { limit: 5, offset: 13 },
        });

        expect(prisma.artist.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                take: 3,
                skip: 11,
                where: expect.objectContaining({
                    name: { contains: "Needle", mode: "insensitive" },
                    albums: {
                        some: expect.objectContaining({
                            location: { in: ["LIBRARY", "FEDERATED"] },
                        }),
                    },
                }),
            }),
        );
        expect(prisma.album.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                take: 4,
                skip: 12,
                where: expect.objectContaining({
                    location: { in: ["LIBRARY", "FEDERATED"] },
                    tracks: { some: expect.any(Object) },
                }),
            }),
        );
        expect(prisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                take: 5,
                skip: 13,
                where: expect.objectContaining({
                    removedAt: null,
                    album: {
                        location: { in: ["LIBRARY", "FEDERATED"] },
                    },
                }),
            }),
        );
    });

    it("returns neutral counts and duration from visible selected tracks", async () => {
        prisma.artist.findMany.mockResolvedValueOnce([
            {
                id: "artist-1",
                name: "Artist One",
                heroUrl: "artist.jpg",
                _count: { albums: 2 },
            },
        ]);
        prisma.album.findMany.mockResolvedValueOnce([
            {
                id: "album-1",
                title: "Album One",
                year: 2024,
                lastSynced: new Date("2026-01-01T00:00:00.000Z"),
                coverUrl: "cover.jpg",
                location: "LIBRARY",
                genres: ["rock"],
                userGenres: null,
                artist: { id: "artist-1", name: "Artist One" },
                tracks: [
                    { id: "track-1", duration: 120 },
                    { id: "track-2", duration: null },
                ],
                _count: { tracks: 2 },
            },
        ]);

        const result = await searchLibraryMusic({
            query: "",
            albumLocations: ["LIBRARY", "FEDERATED"],
            artists: { limit: 20, offset: 0 },
            albums: { limit: 20, offset: 0 },
            tracks: { limit: 20, offset: 0 },
        });

        expect(result.artists).toEqual([
            {
                id: "artist-1",
                name: "Artist One",
                heroUrl: "artist.jpg",
                albumCount: 2,
            },
        ]);
        expect(result.albums).toEqual([
            expect.objectContaining({
                id: "album-1",
                songCount: 2,
                duration: 120,
                trackIds: ["track-1", "track-2"],
            }),
        ]);
        expect(
            prisma.artist.findMany.mock.calls[0][0].where,
        ).not.toHaveProperty("name");
    });
});
