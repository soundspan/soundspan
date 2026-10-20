const prisma = {
    artist: { findFirst: jest.fn() },
};

jest.mock("../../utils/db", () => ({ prisma }));

import {
    buildLibraryAlbumWhere,
    readLibraryArtist,
} from "../libraryArtistReads";

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
        expect(args.include.albums.where).toEqual(
            buildLibraryAlbumWhere([
                "LIBRARY",
                "DISCOVER",
                "REMOTE",
                "FEDERATED",
            ]),
        );
        expect(args.include.albums.include.tracks.take).toBe(10);
        expect(args.include.albums.orderBy).toEqual([{ year: "desc" }]);
    });

    it("adds the requesting user's liked remote albums to both album predicates", async () => {
        const albumLocations = ["LIBRARY", "REMOTE"] as const;
        await readLibraryArtist({
            lookup: { id: "artist-remote" },
            albumLocations,
            requireVisibleAlbum: true,
            albumOrder: "year",
            likedRemoteAlbumsUserId: "user-1",
        });

        const args = prisma.artist.findFirst.mock.calls[0][0];
        const expectedAlbumWhere = {
            OR: [
                buildLibraryAlbumWhere(albumLocations),
                {
                    location: "REMOTE",
                    OR: [
                        {
                            tracksTidal: {
                                some: {
                                    likedBy: { some: { userId: "user-1" } },
                                },
                            },
                        },
                        {
                            tracksYtMusic: {
                                some: {
                                    likedBy: { some: { userId: "user-1" } },
                                },
                            },
                        },
                    ],
                },
            ],
        };

        expect(args.include.albums.where).toEqual(expectedAlbumWhere);
        expect(args.where.albums.some).toEqual(expectedAlbumWhere);
    });

    it("ignores the remote user option when REMOTE albums are excluded", async () => {
        const options = {
            lookup: { id: "artist-local" },
            albumLocations: ["LIBRARY", "FEDERATED"] as const,
            requireVisibleAlbum: true,
            albumOrder: "year-title" as const,
        };

        await readLibraryArtist(options);
        await readLibraryArtist({
            ...options,
            likedRemoteAlbumsUserId: "user-1",
        });

        expect(prisma.artist.findFirst.mock.calls[1][0]).toEqual(
            prisma.artist.findFirst.mock.calls[0][0],
        );
    });

    it("ignores an empty remote album user id", async () => {
        const options = {
            lookup: { id: "artist-empty-user" },
            albumLocations: ["LIBRARY", "REMOTE"] as const,
            requireVisibleAlbum: false,
            albumOrder: "year" as const,
        };

        await readLibraryArtist(options);
        await readLibraryArtist({
            ...options,
            likedRemoteAlbumsUserId: "",
        });

        expect(prisma.artist.findFirst.mock.calls[1][0]).toEqual(
            prisma.artist.findFirst.mock.calls[0][0],
        );
    });
});
