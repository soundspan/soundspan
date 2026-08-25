const prisma = {
    artist: { findFirst: jest.fn() },
};

jest.mock("../../utils/db", () => ({ prisma }));

import { readLibraryArtist } from "../libraryArtistReads";

describe("library artist reads", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.artist.findFirst.mockResolvedValue(null);
    });

    it("builds a strict visible artist slice with complete album tracks", async () => {
        await readLibraryArtist({
            lookup: { id: "artist-1" },
            albumLocations: ["LIBRARY", "FEDERATED"],
            requireVisibleAlbum: true,
            albumOrder: "year-title",
        });

        expect(prisma.artist.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    id: "artist-1",
                    albums: {
                        some: expect.objectContaining({
                            location: { in: ["LIBRARY", "FEDERATED"] },
                        }),
                    },
                },
                include: expect.objectContaining({
                    albums: expect.objectContaining({
                        where: expect.objectContaining({
                            location: { in: ["LIBRARY", "FEDERATED"] },
                        }),
                        orderBy: [{ year: "desc" }, { title: "asc" }],
                        include: expect.objectContaining({
                            tracks: expect.not.objectContaining({
                                take: expect.anything(),
                            }),
                        }),
                    }),
                }),
            }),
        );
    });

    it("preserves flexible library lookup and the per-album track cap", async () => {
        await readLibraryArtist({
            lookup: {
                id: "route-value",
                name: "decoded name",
                mbid: "route-value",
            },
            albumLocations: ["LIBRARY", "DISCOVER", "REMOTE", "FEDERATED"],
            requireVisibleAlbum: false,
            albumOrder: "year",
            maxTracksPerAlbum: 10,
        });

        const args = prisma.artist.findFirst.mock.calls[0][0];
        expect(args.where).toEqual({
            OR: [
                { id: "route-value" },
                { name: { equals: "decoded name", mode: "insensitive" } },
                { mbid: "route-value" },
            ],
        });
        expect(args.include.albums.include.tracks.take).toBe(10);
        expect(args.include.albums.orderBy).toEqual([{ year: "desc" }]);
    });
});
