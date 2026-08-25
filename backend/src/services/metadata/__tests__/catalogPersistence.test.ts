const prisma = {
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
    track: {
        upsert: jest.fn(),
    },
};

const config = {
    catalogPersistence: { enabled: true, retentionDays: 180 },
};

const recordCatalogWrite = jest.fn();

jest.mock("../../../utils/db", () => ({ prisma }));
jest.mock("../../../config", () => ({ config }));
jest.mock("../../../metrics", () => ({ recordCatalogWrite }));

import {
    findFreshCatalogAlbum,
    findFreshCatalogReleaseGroups,
    persistCatalogReleaseGroups,
    persistCatalogTracklist,
    readFreshCatalogReleaseGroups,
} from "../catalogPersistence";

const NOW = new Date("2026-08-25T15:00:00.000Z");

describe("catalog persistence", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers().setSystemTime(NOW);
        config.catalogPersistence.enabled = true;
        prisma.album.findMany.mockResolvedValue([]);
        prisma.album.findFirst.mockResolvedValue(null);
        prisma.album.createMany.mockResolvedValue({ count: 0 });
        prisma.album.updateMany.mockResolvedValue({ count: 0 });
        prisma.album.findUnique.mockResolvedValue(null);
        prisma.artist.findFirst.mockResolvedValue(null);
        prisma.artist.update.mockResolvedValue(undefined);
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
        expect(recordCatalogWrite).toHaveBeenCalledWith("release_group");
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

    it("reads fresh persisted release groups and touches their catalog rows", async () => {
        prisma.artist.findFirst.mockResolvedValueOnce({
            id: "artist-catalog",
            catalogSyncedAt: new Date("2026-08-24T15:00:00.000Z"),
            albums: [
                {
                    id: "album-catalog",
                    rgMbid: "rg-catalog",
                    title: "Catalog Album",
                    year: 2016,
                    primaryType: "Album",
                    location: "CATALOG",
                },
            ],
        });

        const groups = await findFreshCatalogReleaseGroups("artist-mbid");

        expect(groups).toEqual([
            {
                id: "rg-catalog",
                title: "Catalog Album",
                "first-release-date": "2016",
                "primary-type": "Album",
                "secondary-types": [],
            },
        ]);
        expect(prisma.artist.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    mbid: "artist-mbid",
                    catalogSyncedAt: {
                        gt: new Date("2026-08-18T15:00:00.000Z"),
                    },
                }),
            }),
        );
        await Promise.resolve();
        expect(prisma.album.updateMany).toHaveBeenCalledWith({
            where: { artistId: "artist-catalog", location: "CATALOG" },
            data: { catalogTouchedAt: NOW },
        });
    });

    it("treats a missing or stale catalog sync as a provider miss", async () => {
        prisma.artist.findFirst.mockResolvedValueOnce(null);

        await expect(
            findFreshCatalogReleaseGroups("artist-stale"),
        ).resolves.toBeNull();
        expect(prisma.album.updateMany).not.toHaveBeenCalled();
    });

    it("treats a catalog sync exactly seven days old as stale", () => {
        const groups = readFreshCatalogReleaseGroups({
            artistId: "artist-boundary",
            catalogSyncedAt: new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000),
            albums: [
                {
                    id: "album-boundary",
                    rgMbid: "rg-boundary",
                    title: "Boundary Album",
                    year: 2000,
                    primaryType: "Album",
                    location: "CATALOG",
                },
            ],
        });

        expect(groups).toBeNull();
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
