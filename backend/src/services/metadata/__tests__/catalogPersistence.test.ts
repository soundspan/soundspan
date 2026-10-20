const prisma = {
    $transaction: jest.fn(),
    album: {
        createMany: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
    },
    artist: {
        findFirst: jest.fn(),
        update: jest.fn(),
    },
    artistCatalogReleaseGroup: {
        createMany: jest.fn(),
        deleteMany: jest.fn(),
        findMany: jest.fn(),
    },
    track: {
        upsert: jest.fn(),
    },
};

const config = {
    catalogPersistence: { enabled: true, retentionDays: 180 },
};

const recordCatalogWrite = jest.fn();
const mockCatalogWarn = jest.fn();

jest.mock("../../../utils/db", () => ({ prisma }));
jest.mock("../../../config", () => ({ config }));
jest.mock("../../../metrics", () => ({ recordCatalogWrite }));
jest.mock("../../../utils/logger", () => ({
    logger: { child: jest.fn(() => ({ warn: mockCatalogWarn })) },
}));

import {
    findFreshCatalogAlbum,
    findFreshArtistCatalogReleaseGroups,
    findFreshCatalogReleaseGroups,
    persistCatalogReleaseGroups,
    persistCatalogTracklist,
} from "../catalogPersistence";

const NOW = new Date("2026-08-25T15:00:00.000Z");

describe("catalog persistence", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers().setSystemTime(NOW);
        config.catalogPersistence.enabled = true;
        prisma.$transaction.mockImplementation((operations) =>
            Promise.all(operations),
        );
        prisma.album.findMany.mockResolvedValue([]);
        prisma.album.findFirst.mockResolvedValue(null);
        prisma.album.createMany.mockResolvedValue({ count: 0 });
        prisma.album.updateMany.mockResolvedValue({ count: 0 });
        prisma.album.findUnique.mockResolvedValue(null);
        prisma.artist.findFirst.mockResolvedValue(null);
        prisma.artist.update.mockResolvedValue(undefined);
        prisma.artistCatalogReleaseGroup.createMany.mockResolvedValue({
            count: 0,
        });
        prisma.artistCatalogReleaseGroup.deleteMany.mockResolvedValue({
            count: 0,
        });
        prisma.artistCatalogReleaseGroup.findMany.mockResolvedValue([]);
        prisma.track.upsert.mockResolvedValue(undefined);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("creates CATALOG skeletons for unowned release groups", async () => {
        await persistCatalogReleaseGroups({
            artistId: "artist-1",
            releaseGroups: [
                {
                    id: "rg-1",
                    title: "First Album",
                    "first-release-date": "2001-02-03",
                    "primary-type": "Album",
                    "secondary-types": ["Demo"],
                },
                {
                    id: "rg-2",
                    title: "Second EP",
                    "primary-type": "EP",
                },
            ],
        });

        expect(prisma.album.createMany).toHaveBeenCalledWith({
            data: [
                {
                    artistId: "artist-1",
                    catalogTouchedAt: NOW,
                    location: "CATALOG",
                    primaryType: "Album",
                    rgMbid: "rg-1",
                    title: "First Album",
                    year: 2001,
                },
                {
                    artistId: "artist-1",
                    catalogTouchedAt: NOW,
                    location: "CATALOG",
                    primaryType: "EP",
                    rgMbid: "rg-2",
                    title: "Second EP",
                    year: null,
                },
            ],
            skipDuplicates: true,
        });
        expect(prisma.artist.update).toHaveBeenCalledWith({
            where: { id: "artist-1" },
            data: { catalogSyncedAt: NOW },
        });
        expect(
            prisma.artistCatalogReleaseGroup.deleteMany,
        ).toHaveBeenCalledWith({ where: { artistId: "artist-1" } });
        expect(
            prisma.artistCatalogReleaseGroup.createMany,
        ).toHaveBeenCalledWith({
            data: [
                {
                    artistId: "artist-1",
                    firstReleaseDate: "2001-02-03",
                    position: 0,
                    primaryType: "Album",
                    rgMbid: "rg-1",
                    secondaryTypes: ["Demo"],
                    title: "First Album",
                },
                {
                    artistId: "artist-1",
                    firstReleaseDate: null,
                    position: 1,
                    primaryType: "EP",
                    rgMbid: "rg-2",
                    secondaryTypes: [],
                    title: "Second EP",
                },
            ],
            skipDuplicates: true,
        });
        expect(prisma.$transaction).toHaveBeenCalledWith([
            expect.any(Promise),
            expect.any(Promise),
            expect.any(Promise),
        ]);
        expect(
            prisma.artistCatalogReleaseGroup.deleteMany.mock
                .invocationCallOrder[0],
        ).toBeLessThan(
            prisma.artistCatalogReleaseGroup.createMany.mock
                .invocationCallOrder[0],
        );
        expect(
            prisma.artistCatalogReleaseGroup.createMany.mock
                .invocationCallOrder[0],
        ).toBeLessThan(prisma.artist.update.mock.invocationCallOrder[0]);
        expect(recordCatalogWrite).toHaveBeenCalledWith("release_group");
    });

    it("writes nothing when release-group normalization is empty", async () => {
        await persistCatalogReleaseGroups({
            artistId: "artist-1",
            releaseGroups: [
                { id: "", title: "Missing ID" },
                { id: "rg-missing-title", title: "   " },
            ],
        });

        expect(prisma.album.findMany).not.toHaveBeenCalled();
        expect(prisma.album.createMany).not.toHaveBeenCalled();
        expect(
            prisma.artistCatalogReleaseGroup.deleteMany,
        ).not.toHaveBeenCalled();
        expect(
            prisma.artistCatalogReleaseGroup.createMany,
        ).not.toHaveBeenCalled();
        expect(prisma.artist.update).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(recordCatalogWrite).not.toHaveBeenCalled();
    });

    it("bounds and de-duplicates normalized secondary types", async () => {
        const secondaryTypes = [
            " Demo ",
            "Demo",
            "",
            42,
            "x".repeat(65),
            ...Array.from({ length: 20 }, (_, index) => `Type ${index}`),
        ];

        await persistCatalogReleaseGroups({
            artistId: "artist-1",
            releaseGroups: [
                {
                    id: "rg-bounded",
                    title: "Bounded Album",
                    "secondary-types": secondaryTypes,
                },
            ],
        });

        expect(
            prisma.artistCatalogReleaseGroup.createMany,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                data: [
                    expect.objectContaining({
                        secondaryTypes: [
                            "Demo",
                            ...Array.from(
                                { length: 15 },
                                (_, index) => `Type ${index}`,
                            ),
                        ],
                    }),
                ],
            }),
        );
    });

    it("ignores secondary types beyond the bounded input window", async () => {
        await persistCatalogReleaseGroups({
            artistId: "artist-1",
            releaseGroups: [
                {
                    id: "rg-input-bounded",
                    title: "Input Bounded Album",
                    "secondary-types": [
                        ...Array.from({ length: 64 }, () => null),
                        "Demo",
                    ],
                },
            ],
        });

        expect(
            prisma.artistCatalogReleaseGroup.createMany,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                data: [
                    expect.objectContaining({
                        secondaryTypes: [],
                    }),
                ],
            }),
        );
    });

    it("stores invalid full dates as null while preserving the skeleton year", async () => {
        await persistCatalogReleaseGroups({
            artistId: "artist-1",
            releaseGroups: [
                {
                    id: "rg-invalid-date",
                    title: "Invalid Date Album",
                    "first-release-date": "2024-not-a-date",
                },
            ],
        });

        expect(prisma.album.createMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: [expect.objectContaining({ year: 2024 })],
            }),
        );
        expect(
            prisma.artistCatalogReleaseGroup.createMany,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                data: [expect.objectContaining({ firstReleaseDate: null })],
            }),
        );
    });

    it("keeps the last duplicate release group without changing its position", async () => {
        await persistCatalogReleaseGroups({
            artistId: "artist-1",
            releaseGroups: [
                { id: "rg-duplicate", title: "Old Title" },
                { id: "rg-second", title: "Second Album" },
                { id: "rg-duplicate", title: "Replacement Title" },
            ],
        });

        expect(
            prisma.artistCatalogReleaseGroup.createMany,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                data: [
                    expect.objectContaining({
                        position: 0,
                        rgMbid: "rg-duplicate",
                        title: "Replacement Title",
                    }),
                    expect.objectContaining({
                        position: 1,
                        rgMbid: "rg-second",
                    }),
                ],
            }),
        );
    });

    it("uses an existing local artist for discovery views without creating artists", async () => {
        prisma.artist.findFirst.mockResolvedValueOnce({ id: "artist-local" });

        await persistCatalogReleaseGroups({
            artistMbid: "artist-mbid",
            releaseGroups: [{ id: "rg-discovery", title: "Discovery Album" }],
        });

        expect(prisma.artist.findFirst).toHaveBeenCalledWith({
            where: { mbid: "artist-mbid", peerId: null },
            select: { id: true },
        });
        expect(prisma.album.createMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: [expect.objectContaining({ artistId: "artist-local" })],
            }),
        );
    });

    it("does not persist discovery release groups without a local artist", async () => {
        await persistCatalogReleaseGroups({
            artistMbid: "artist-mbid",
            releaseGroups: [{ id: "rg-discovery", title: "Discovery Album" }],
        });

        expect(prisma.album.findMany).not.toHaveBeenCalled();
        expect(prisma.album.createMany).not.toHaveBeenCalled();
        expect(prisma.artist.update).not.toHaveBeenCalled();
    });

    it("refreshes existing CATALOG rows and fills missing metadata", async () => {
        prisma.album.findMany.mockResolvedValueOnce([
            {
                rgMbid: "rg-existing",
                location: "CATALOG",
                title: "",
                year: null,
                primaryType: "",
            },
        ]);

        await persistCatalogReleaseGroups({
            artistId: "artist-1",
            releaseGroups: [
                {
                    id: "rg-existing",
                    title: "Recovered Title",
                    "first-release-date": "1999-01-01",
                    "primary-type": "Album",
                },
            ],
        });

        expect(prisma.album.updateMany).toHaveBeenCalledWith({
            where: { rgMbid: "rg-existing", location: "CATALOG" },
            data: {
                catalogTouchedAt: NOW,
                primaryType: "Album",
                title: "Recovered Title",
                year: 1999,
            },
        });
        expect(prisma.album.createMany).not.toHaveBeenCalled();
    });

    it("never mutates existing LIBRARY, REMOTE, FEDERATED, or DISCOVER rows", async () => {
        prisma.album.findMany.mockResolvedValueOnce([
            {
                rgMbid: "rg-library",
                location: "LIBRARY",
                title: "Library",
                year: 2000,
                primaryType: "Album",
            },
            {
                rgMbid: "rg-remote",
                location: "REMOTE",
                title: "Remote",
                year: null,
                primaryType: "Album",
            },
            {
                rgMbid: "rg-federated",
                location: "FEDERATED",
                title: "Federated",
                year: 2002,
                primaryType: "Album",
            },
            {
                rgMbid: "rg-discover",
                location: "DISCOVER",
                title: "Discover",
                year: 2003,
                primaryType: "Album",
            },
        ]);

        await persistCatalogReleaseGroups({
            artistId: "artist-1",
            releaseGroups: [
                { id: "rg-library", title: "Changed Library" },
                { id: "rg-remote", title: "Changed Remote" },
                { id: "rg-federated", title: "Changed Federated" },
                { id: "rg-discover", title: "Changed Discover" },
            ],
        });

        expect(prisma.album.updateMany).not.toHaveBeenCalled();
        expect(prisma.album.createMany).not.toHaveBeenCalled();
    });

    it("writes nothing when the kill switch is disabled", async () => {
        config.catalogPersistence.enabled = false;

        await persistCatalogReleaseGroups({
            artistId: "artist-1",
            releaseGroups: [{ id: "rg-1", title: "Album" }],
        });
        await persistCatalogTracklist({
            rgMbid: "rg-1",
            tracks: [{ title: "Track", trackNo: 1, discNo: 1, duration: 60 }],
        });

        expect(prisma.album.findMany).not.toHaveBeenCalled();
        expect(prisma.album.findUnique).not.toHaveBeenCalled();
        expect(prisma.artist.findFirst).not.toHaveBeenCalled();
        expect(prisma.artist.update).not.toHaveBeenCalled();
        expect(prisma.track.upsert).not.toHaveBeenCalled();
    });

    it("upserts a CATALOG tracklist idempotently by album position and title", async () => {
        prisma.album.findUnique.mockResolvedValue({
            id: "album-catalog",
            location: "CATALOG",
        });
        const input = {
            rgMbid: "rg-catalog",
            tracks: [
                {
                    recordingMbid: "recording-opening",
                    title: "Opening Track",
                    trackNo: 1,
                    discNo: 1,
                    duration: 181,
                },
                {
                    title: "Second Disc",
                    trackNo: 3,
                    discNo: 2,
                    duration: 202,
                },
            ],
        };

        await persistCatalogTracklist(input);
        await persistCatalogTracklist(input);

        expect(prisma.track.upsert).toHaveBeenCalledTimes(4);
        expect(prisma.track.upsert.mock.calls[0][0].where).toEqual(
            prisma.track.upsert.mock.calls[2][0].where,
        );
        expect(prisma.track.upsert.mock.calls[1][0].where).toEqual(
            prisma.track.upsert.mock.calls[3][0].where,
        );
        expect(prisma.track.upsert).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                create: expect.objectContaining({
                    albumId: "album-catalog",
                    discNo: 1,
                    duration: 181,
                    fileModified: NOW,
                    filePath: null,
                    fileSize: 0,
                    origin: "LOCAL",
                    title: "Opening Track",
                    recordingMbid: "recording-opening",
                    trackNo: 1,
                }),
            }),
        );
        expect(recordCatalogWrite).toHaveBeenCalledWith("tracklist");
    });

    it("reads a fresh discovery catalog in persisted position order", async () => {
        prisma.artist.findFirst.mockResolvedValueOnce({
            id: "artist-catalog",
            catalogSyncedAt: new Date("2026-08-24T15:00:00.000Z"),
            catalogReleaseGroups: [
                {
                    rgMbid: "rg-catalog",
                    title: "Catalog Album",
                    firstReleaseDate: "2016-04-03",
                    primaryType: "Album",
                    secondaryTypes: ["Demo"],
                    position: 0,
                },
                {
                    rgMbid: "rg-catalog-ep",
                    title: "Catalog EP",
                    firstReleaseDate: null,
                    primaryType: "EP",
                    secondaryTypes: [],
                    position: 1,
                },
            ],
        });

        const groups = await findFreshCatalogReleaseGroups("artist-mbid");

        expect(groups).toEqual([
            {
                id: "rg-catalog",
                title: "Catalog Album",
                "first-release-date": "2016-04-03",
                "primary-type": "Album",
                "secondary-types": ["Demo"],
            },
            {
                id: "rg-catalog-ep",
                title: "Catalog EP",
                "first-release-date": "",
                "primary-type": "EP",
                "secondary-types": [],
            },
        ]);
        expect(prisma.artist.findFirst).toHaveBeenCalledWith({
            where: {
                mbid: "artist-mbid",
                peerId: null,
                catalogSyncedAt: {
                    gt: new Date("2026-08-18T15:00:00.000Z"),
                },
            },
            select: {
                id: true,
                catalogReleaseGroups: {
                    orderBy: [{ position: "asc" }, { rgMbid: "asc" }],
                    select: {
                        firstReleaseDate: true,
                        position: true,
                        primaryType: true,
                        rgMbid: true,
                        secondaryTypes: true,
                        title: true,
                    },
                },
            },
        });
        await Promise.resolve();
        expect(prisma.album.updateMany).toHaveBeenCalledWith({
            where: {
                rgMbid: { in: ["rg-catalog", "rg-catalog-ep"] },
                location: "CATALOG",
            },
            data: { catalogTouchedAt: NOW },
        });
    });

    it("treats missing, empty, and failed discovery catalogs as provider misses", async () => {
        prisma.artist.findFirst.mockResolvedValueOnce(null);
        await expect(
            findFreshCatalogReleaseGroups("artist-stale"),
        ).resolves.toBeNull();

        prisma.artist.findFirst.mockResolvedValueOnce({
            id: "artist-empty",
            catalogReleaseGroups: [],
        });
        await expect(
            findFreshCatalogReleaseGroups("artist-empty"),
        ).resolves.toBeNull();

        const error = new Error("catalog unavailable");
        prisma.artist.findFirst.mockRejectedValueOnce(error);
        await expect(
            findFreshCatalogReleaseGroups("artist-error"),
        ).resolves.toBeNull();

        expect(mockCatalogWarn).toHaveBeenCalledWith("Catalog read failed", {
            error,
        });
        expect(prisma.album.updateMany).not.toHaveBeenCalled();
    });

    it("does not query artist catalog rows when persistence is disabled", async () => {
        config.catalogPersistence.enabled = false;

        await expect(
            findFreshCatalogReleaseGroups("artist-disabled"),
        ).resolves.toBeNull();
        await expect(
            findFreshArtistCatalogReleaseGroups({
                artistId: "artist-disabled",
                catalogSyncedAt: new Date("2026-08-24T15:00:00.000Z"),
            }),
        ).resolves.toBeNull();

        expect(
            prisma.artistCatalogReleaseGroup.findMany,
        ).not.toHaveBeenCalled();
        expect(prisma.artist.findFirst).not.toHaveBeenCalled();
    });

    it.each([
        ["missing", null],
        [
            "exactly seven days old",
            new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000),
        ],
    ])(
        "does not query artist catalog rows when the sync is %s",
        async (_description, catalogSyncedAt) => {
            await expect(
                findFreshArtistCatalogReleaseGroups({
                    artistId: "artist-stale",
                    catalogSyncedAt,
                }),
            ).resolves.toBeNull();

            expect(
                prisma.artistCatalogReleaseGroup.findMany,
            ).not.toHaveBeenCalled();
        },
    );

    it("loads fresh artist catalog rows in position order and touches their skeletons", async () => {
        prisma.artistCatalogReleaseGroup.findMany.mockResolvedValueOnce([
            {
                rgMbid: "rg-artist-catalog",
                title: "Artist Catalog Album",
                firstReleaseDate: "2021-05",
                primaryType: "EP",
                secondaryTypes: ["Demo"],
                position: 2,
            },
        ]);

        const groups = await findFreshArtistCatalogReleaseGroups({
            artistId: "artist-catalog",
            catalogSyncedAt: new Date("2026-08-24T15:00:00.000Z"),
        });

        expect(prisma.artistCatalogReleaseGroup.findMany).toHaveBeenCalledWith({
            where: { artistId: "artist-catalog" },
            orderBy: [{ position: "asc" }, { rgMbid: "asc" }],
            select: {
                firstReleaseDate: true,
                position: true,
                primaryType: true,
                rgMbid: true,
                secondaryTypes: true,
                title: true,
            },
        });
        expect(groups).toEqual([
            {
                id: "rg-artist-catalog",
                title: "Artist Catalog Album",
                "first-release-date": "2021-05",
                "primary-type": "EP",
                "secondary-types": ["Demo"],
            },
        ]);
        await Promise.resolve();
        expect(prisma.album.updateMany).toHaveBeenCalledWith({
            where: {
                rgMbid: { in: ["rg-artist-catalog"] },
                location: "CATALOG",
            },
            data: { catalogTouchedAt: NOW },
        });
    });

    it("returns null for an empty fresh artist catalog without touching skeletons", async () => {
        await expect(
            findFreshArtistCatalogReleaseGroups({
                artistId: "artist-fully-owned",
                catalogSyncedAt: new Date("2026-08-24T15:00:00.000Z"),
            }),
        ).resolves.toBeNull();

        expect(prisma.album.updateMany).not.toHaveBeenCalled();
    });

    it("treats an artist catalog query failure as a provider miss", async () => {
        const error = new Error("catalog unavailable");
        prisma.artistCatalogReleaseGroup.findMany.mockRejectedValueOnce(error);

        await expect(
            findFreshArtistCatalogReleaseGroups({
                artistId: "artist-query-failure",
                catalogSyncedAt: new Date("2026-08-24T15:00:00.000Z"),
            }),
        ).resolves.toBeNull();

        expect(mockCatalogWarn).toHaveBeenCalledWith("Catalog read failed", {
            error,
        });
        expect(prisma.album.updateMany).not.toHaveBeenCalled();
    });

    it("reads a fresh catalog tracklist and touches only that album", async () => {
        const catalogAlbum = {
            id: "album-tracklist",
            rgMbid: "rg-tracklist",
            title: "Tracklist Album",
            year: 2020,
            primaryType: "EP",
            artist: {
                id: "artist-tracklist",
                mbid: "artist-mbid",
                name: "Tracklist Artist",
            },
            tracks: [
                {
                    id: "track-skeleton",
                    recordingMbid: "recording-mbid",
                    title: "Track One",
                    trackNo: 1,
                    discNo: 1,
                    duration: 200,
                },
            ],
        };
        prisma.album.findFirst.mockResolvedValueOnce(catalogAlbum);

        await expect(findFreshCatalogAlbum("rg-tracklist")).resolves.toEqual(
            catalogAlbum,
        );
        expect(prisma.album.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    rgMbid: "rg-tracklist",
                    location: "CATALOG",
                    catalogTouchedAt: {
                        gt: new Date("2026-08-18T15:00:00.000Z"),
                    },
                    tracks: { some: {} },
                }),
            }),
        );
        await Promise.resolve();
        expect(prisma.album.updateMany).toHaveBeenCalledWith({
            where: { id: "album-tracklist", location: "CATALOG" },
            data: { catalogTouchedAt: NOW },
        });
    });

    it.each(["LIBRARY", "REMOTE", "FEDERATED", "DISCOVER"])(
        "does not write a tracklist beneath a %s album",
        async (location) => {
            prisma.album.findUnique.mockResolvedValueOnce({
                id: "album-content",
                location,
            });

            await persistCatalogTracklist({
                rgMbid: "rg-content",
                tracks: [
                    {
                        title: "Protected Track",
                        trackNo: 1,
                        discNo: 1,
                        duration: 180,
                    },
                ],
            });

            expect(prisma.track.upsert).not.toHaveBeenCalled();
            expect(prisma.album.updateMany).not.toHaveBeenCalled();
        },
    );
});
