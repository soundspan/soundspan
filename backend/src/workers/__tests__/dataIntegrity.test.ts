describe("dataIntegrity worker", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadDataIntegrity(options?: { retryFirstCall?: boolean }) {
        class PrismaClientKnownRequestError extends Error {
            code: string;
            constructor(message: string, code: string) {
                super(message);
                this.code = code;
            }
        }
        class PrismaClientRustPanicError extends Error {}
        class PrismaClientUnknownRequestError extends Error {}

        const logger = {
            debug: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };

        const discoverExclusionDeleteMany = jest
            .fn()
            .mockResolvedValue({ count: 1 });
        if (options?.retryFirstCall) {
            discoverExclusionDeleteMany
                .mockRejectedValueOnce(
                    new PrismaClientKnownRequestError("too many clients", "P2037")
                )
                .mockResolvedValueOnce({ count: 1 });
        }

        const prisma = {
            $connect: jest.fn(async () => undefined),
            $executeRaw: jest.fn(async () => 0),
            discoverExclusion: {
                deleteMany: discoverExclusionDeleteMany,
            },
            discoveryTrack: {
                deleteMany: jest.fn(async () => ({ count: 2 })),
            },
            album: {
                findMany: jest
                    .fn()
                    .mockResolvedValueOnce([])
                    .mockResolvedValueOnce([])
                    .mockResolvedValueOnce([]),
                update: jest.fn(async () => undefined),
                delete: jest.fn(async () => undefined),
                updateMany: jest.fn(async () => ({ count: 0 })),
            },
            ownedAlbum: {
                findFirst: jest.fn(async () => null),
                deleteMany: jest.fn(async () => ({ count: 0 })),
            },
            discoveryAlbum: {
                findFirst: jest.fn(async () => null),
                findMany: jest.fn(async () => []),
            },
            downloadJob: {
                findMany: jest.fn(async () => []),
                deleteMany: jest.fn(async () => ({ count: 3 })),
            },
            artist: {
                findMany: jest
                    .fn()
                    .mockResolvedValueOnce([])
                    .mockResolvedValueOnce([]),
                findFirst: jest.fn(async () => null),
                delete: jest.fn(async () => undefined),
                deleteMany: jest.fn(async () => ({ count: 0 })),
            },
            similarArtist: {
                deleteMany: jest.fn(async () => ({ count: 0 })),
            },
            track: {
                deleteMany: jest.fn(async () => ({ count: 0 })),
            },
        };

        jest.doMock("../../utils/logger", () => ({ logger }));
        jest.doMock("../../utils/db", () => ({ prisma }));
        const Prisma = {
            PrismaClientKnownRequestError,
            PrismaClientRustPanicError,
            PrismaClientUnknownRequestError,
        };

        jest.doMock("@prisma/client", () => ({ Prisma }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../dataIntegrity");

        return { module, prisma, logger, Prisma };
    }

    it("runs integrity cleanup and returns expected report", async () => {
        const { module, prisma } = loadDataIntegrity();

        await expect(module.runDataIntegrityCheck()).resolves.toEqual({
            expiredExclusions: 1,
            orphanedDiscoveryTracks: 2,
            mislocatedAlbums: 0,
            orphanedAlbums: 0,
            consolidatedArtists: 0,
            orphanedArtists: 0,
            oldDownloadJobs: 3,
        });

        expect(prisma.discoverExclusion.deleteMany).toHaveBeenCalled();
        expect(prisma.discoveryTrack.deleteMany).toHaveBeenCalled();
        expect(prisma.downloadJob.deleteMany).toHaveBeenCalled();
    });

    it("handles zero-count cleanup paths without positive-count side effects", async () => {
        const { module, prisma } = loadDataIntegrity();
        (prisma.discoverExclusion.deleteMany as jest.Mock).mockResolvedValueOnce({
            count: 0,
        });
        (prisma.discoveryTrack.deleteMany as jest.Mock).mockResolvedValueOnce({
            count: 0,
        });
        (prisma.downloadJob.deleteMany as jest.Mock).mockResolvedValueOnce({
            count: 0,
        });

        await expect(module.runDataIntegrityCheck()).resolves.toEqual({
            expiredExclusions: 0,
            orphanedDiscoveryTracks: 0,
            mislocatedAlbums: 0,
            orphanedAlbums: 0,
            consolidatedArtists: 0,
            orphanedArtists: 0,
            oldDownloadJobs: 0,
        });
    });

    it("retries transient prisma failures and reconnects before succeeding", async () => {
        const { module, prisma, logger } = loadDataIntegrity({
            retryFirstCall: true,
        });

        await expect(module.runDataIntegrityCheck()).resolves.toEqual(
            expect.objectContaining({
                expiredExclusions: 1,
            })
        );

        expect(prisma.$connect).toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("runDataIntegrityCheck.discoverExclusion.deleteMany failed"),
            expect.any(Error)
        );
    });

    it("continues retry flow when prisma reconnect attempt fails once", async () => {
        const { module, prisma } = loadDataIntegrity({ retryFirstCall: true });
        (prisma.$connect as jest.Mock).mockRejectedValueOnce(
            new Error("connect failed")
        );

        await expect(module.runDataIntegrityCheck()).resolves.toEqual(
            expect.objectContaining({
                expiredExclusions: 1,
            })
        );
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
    });

    it("fixes mislocated discovery albums when no protected ownership exists", async () => {
        const { module, prisma } = loadDataIntegrity();

        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                discoveryBatchId: "batch-1",
                status: "completed",
                metadata: {
                    albumTitle: "Discovery Album",
                    artistName: "Discovery Artist",
                    artistMbid: "artist-mbid-1",
                },
            },
        ]);
        (prisma.album.findMany as jest.Mock)
            .mockReset()
            .mockResolvedValueOnce([]) // discover albums
            .mockResolvedValueOnce([
                {
                    id: "album-1",
                    title: "Discovery Album",
                    rgMbid: "rg-1",
                    location: "LIBRARY",
                    artistId: "artist-1",
                    artist: { name: "Discovery Artist", mbid: "artist-mbid-1" },
                },
            ]) // library albums
            .mockResolvedValueOnce([]); // empty albums
        (prisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValue(null);

        await expect(module.runDataIntegrityCheck()).resolves.toEqual(
            expect.objectContaining({
                mislocatedAlbums: 1,
            })
        );

        expect(prisma.album.update).toHaveBeenCalledWith({
            where: { id: "album-1" },
            data: { location: "DISCOVER" },
        });
        expect(prisma.ownedAlbum.deleteMany).toHaveBeenCalledWith({
            where: {
                rgMbid: "rg-1",
                source: { not: "native_scan" },
            },
        });
    });

    it("keeps library album unchanged when artist has protected owned content", async () => {
        const { module, prisma } = loadDataIntegrity();

        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                discoveryBatchId: "batch-1",
                status: "completed",
                metadata: {
                    albumTitle: "Discovery Album",
                    artistName: "Discovery Artist",
                },
            },
        ]);
        (prisma.album.findMany as jest.Mock)
            .mockReset()
            .mockResolvedValueOnce([]) // discover albums
            .mockResolvedValueOnce([
                {
                    id: "album-1",
                    title: "Discovery Album",
                    rgMbid: "rg-1",
                    location: "LIBRARY",
                    artistId: "artist-1",
                    artist: { name: "Discovery Artist", mbid: "artist-mbid-1" },
                },
            ]) // library albums
            .mockResolvedValueOnce([]); // empty albums
        (prisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "owned-1",
            source: "native_scan",
        });

        await expect(module.runDataIntegrityCheck()).resolves.toEqual(
            expect.objectContaining({
                mislocatedAlbums: 0,
            })
        );

        expect(prisma.album.update).not.toHaveBeenCalledWith(
            expect.objectContaining({
                data: { location: "DISCOVER" },
            })
        );
    });

    it("removes orphaned discover albums and empty albums", async () => {
        const { module, prisma } = loadDataIntegrity();

        (prisma.album.findMany as jest.Mock)
            .mockReset()
            .mockResolvedValueOnce([
                {
                    id: "discover-album-1",
                    title: "Lost Album",
                    rgMbid: "rg-lost",
                    artistId: "artist-1",
                    artist: { name: "Lost Artist" },
                },
            ]) // discover albums
            .mockResolvedValueOnce([]) // library albums
            .mockResolvedValueOnce([
                {
                    id: "empty-album-1",
                    title: "Empty Album",
                    rgMbid: "rg-empty",
                    artistId: "artist-2",
                    artist: { name: "Empty Artist" },
                },
            ]); // empty albums
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValueOnce(null);

        await expect(module.runDataIntegrityCheck()).resolves.toEqual(
            expect.objectContaining({
                orphanedAlbums: 2,
            })
        );

        expect(prisma.track.deleteMany).toHaveBeenCalledWith({
            where: { albumId: "discover-album-1" },
        });
        expect(prisma.album.delete).toHaveBeenCalledWith({
            where: { id: "discover-album-1" },
        });
        expect(prisma.album.delete).toHaveBeenCalledWith({
            where: { id: "empty-album-1" },
        });
        expect(prisma.ownedAlbum.deleteMany).toHaveBeenCalledWith({
            where: { rgMbid: "rg-empty" },
        });
    });

    it("consolidates duplicate artists and cleans up orphaned artists", async () => {
        const { module, prisma } = loadDataIntegrity();

        (prisma.artist.findMany as jest.Mock)
            .mockReset()
            .mockResolvedValueOnce([
                {
                    id: "temp-artist-1",
                    name: "Artist Name",
                    normalizedName: "artist name",
                },
            ]) // temp artists
            .mockResolvedValueOnce([{ id: "orphan-artist-1" }]); // orphaned artists
        (prisma.artist.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "real-artist-1",
            mbid: "real-mbid",
        });

        await expect(module.runDataIntegrityCheck()).resolves.toEqual(
            expect.objectContaining({
                consolidatedArtists: 1,
                orphanedArtists: 1,
            })
        );

        expect(prisma.album.updateMany).toHaveBeenCalledWith({
            where: { artistId: "temp-artist-1" },
            data: { artistId: "real-artist-1" },
        });
        expect(prisma.artist.delete).toHaveBeenCalledWith({
            where: { id: "temp-artist-1" },
        });
        expect(prisma.artist.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: ["orphan-artist-1"] } },
        });
    });

    it("propagates non-retryable prisma failures without reconnect retries", async () => {
        const { module, prisma, logger } = loadDataIntegrity();

        (prisma.discoverExclusion.deleteMany as jest.Mock).mockRejectedValueOnce(
            new Error("permission denied")
        );

        await expect(module.runDataIntegrityCheck()).rejects.toThrow(
            "permission denied"
        );
        expect(prisma.$connect).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalledWith(
            expect.stringContaining("[DataIntegrity/Prisma]"),
            expect.anything()
        );
    });

    it("retries rust panic and unknown request prisma errors", async () => {
        const { module, prisma, Prisma } = loadDataIntegrity();

        (prisma.discoverExclusion.deleteMany as jest.Mock)
            .mockRejectedValueOnce(new Prisma.PrismaClientRustPanicError("panic"))
            .mockRejectedValueOnce(
                new Prisma.PrismaClientUnknownRequestError(
                    "Response from the Engine was empty"
                )
            )
            .mockResolvedValueOnce({ count: 1 });

        await expect(module.runDataIntegrityCheck()).resolves.toEqual(
            expect.objectContaining({
                expiredExclusions: 1,
            })
        );
        expect(prisma.$connect).toHaveBeenCalledTimes(2);
    });

    it("retries on unknown-request engine-exited errors", async () => {
        const { module, prisma, Prisma } = loadDataIntegrity();
        (prisma.discoverExclusion.deleteMany as jest.Mock)
            .mockRejectedValueOnce(
                new Prisma.PrismaClientUnknownRequestError(
                    "Engine has already exited"
                )
            )
            .mockResolvedValueOnce({ count: 1 });

        await expect(module.runDataIntegrityCheck()).resolves.toEqual(
            expect.objectContaining({
                expiredExclusions: 1,
            })
        );
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
    });

    it("retries on non-Error string connection-reset failures", async () => {
        const { module, prisma } = loadDataIntegrity();
        (prisma.discoverExclusion.deleteMany as jest.Mock)
            .mockRejectedValueOnce("Connection reset by peer")
            .mockResolvedValueOnce({ count: 1 });

        await expect(module.runDataIntegrityCheck()).resolves.toEqual(
            expect.objectContaining({
                expiredExclusions: 1,
            })
        );
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
    });

    it("propagates undefined non-retryable errors from prisma operations", async () => {
        const { module, prisma } = loadDataIntegrity();
        (prisma.discoverExclusion.deleteMany as jest.Mock).mockRejectedValueOnce(
            undefined
        );

        await expect(module.runDataIntegrityCheck()).rejects.toBeUndefined();
        expect(prisma.$connect).not.toHaveBeenCalled();
    });

    it("fixes mislocated albums via artist MBID matching path", async () => {
        const { module, prisma } = loadDataIntegrity();

        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                discoveryBatchId: "batch-1",
                status: "completed",
                metadata: {
                    albumTitle: "Different Discovery Album",
                    artistName: "Different Discovery Artist",
                    artistMbid: "artist-mbid-match",
                },
            },
        ]);
        (prisma.album.findMany as jest.Mock)
            .mockReset()
            .mockResolvedValueOnce([]) // discover albums
            .mockResolvedValueOnce([
                {
                    id: "album-mbid-1",
                    title: "Unrelated Album",
                    rgMbid: "rg-mbid-1",
                    location: "LIBRARY",
                    artistId: "artist-1",
                    artist: { name: "Unrelated Artist", mbid: "artist-mbid-match" },
                },
            ]) // library albums
            .mockResolvedValueOnce([]); // empty albums
        (prisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValue(null);

        await expect(module.runDataIntegrityCheck()).resolves.toEqual(
            expect.objectContaining({
                mislocatedAlbums: 1,
            })
        );
    });

    it("retains discover albums when active/owned references exist", async () => {
        const { module, prisma } = loadDataIntegrity();
        (prisma.album.findMany as jest.Mock)
            .mockReset()
            .mockResolvedValueOnce([
                {
                    id: "discover-active-1",
                    title: "Still Active",
                    rgMbid: "rg-active-1",
                    artistId: "artist-active-1",
                    artist: { name: "Artist Active" },
                },
            ]) // discover albums
            .mockResolvedValueOnce([]) // library albums
            .mockResolvedValueOnce([]); // empty albums
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "active-record-1",
            status: "ACTIVE",
        });
        (prisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValueOnce(null);

        await expect(module.runDataIntegrityCheck()).resolves.toEqual(
            expect.objectContaining({
                orphanedAlbums: 0,
            })
        );
        expect(prisma.album.delete).not.toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "discover-active-1" },
            })
        );
    });

    it("skips mislocation updates when discovery metadata is incomplete or unmatched", async () => {
        const { module, prisma } = loadDataIntegrity();

        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                discoveryBatchId: "batch-empty",
                status: "completed",
                metadata: {},
            },
        ]);
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValueOnce([
            {
                albumTitle: "Known Discovery Album",
                artistName: "Known Discovery Artist",
                artistMbid: null,
            },
        ]);
        (prisma.album.findMany as jest.Mock)
            .mockReset()
            .mockResolvedValueOnce([]) // discover albums
            .mockResolvedValueOnce([
                {
                    id: "album-no-match-1",
                    title: "Different Album",
                    rgMbid: "rg-no-match-1",
                    location: "LIBRARY",
                    artistId: "artist-no-match-1",
                    artist: { name: "Different Artist", mbid: undefined },
                },
            ]) // library albums
            .mockResolvedValueOnce([]); // empty albums

        await expect(module.runDataIntegrityCheck()).resolves.toEqual(
            expect.objectContaining({
                mislocatedAlbums: 0,
            })
        );
        expect(prisma.album.update).not.toHaveBeenCalled();
    });

    it("fixes mislocated albums by discovery title match when artist MBID is blank", async () => {
        const { module, prisma } = loadDataIntegrity();
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValueOnce([
            {
                albumTitle: "Exact Discovery Title",
                artistName: "Discovery Artist",
                artistMbid: null,
            },
        ]);
        (prisma.album.findMany as jest.Mock)
            .mockReset()
            .mockResolvedValueOnce([]) // discover albums
            .mockResolvedValueOnce([
                {
                    id: "album-title-match-1",
                    title: "Exact Discovery Title",
                    rgMbid: "rg-title-match-1",
                    location: "LIBRARY",
                    artistId: "artist-title-match-1",
                    artist: { name: "Unrelated Artist", mbid: "" },
                },
            ]) // library albums
            .mockResolvedValueOnce([]); // empty albums
        (prisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce(null);

        await expect(module.runDataIntegrityCheck()).resolves.toEqual(
            expect.objectContaining({
                mislocatedAlbums: 1,
            })
        );
    });

    it("uses DiscoveryAlbum table metadata to detect mislocated library albums", async () => {
        const { module, prisma } = loadDataIntegrity();

        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.discoveryAlbum.findMany as jest.Mock).mockResolvedValueOnce([
            {
                albumTitle: "Discovery Album",
                artistName: "Discovery Artist",
                artistMbid: "artist-mbid-discovery-table",
            },
        ]);
        (prisma.album.findMany as jest.Mock)
            .mockReset()
            .mockResolvedValueOnce([]) // discover albums
            .mockResolvedValueOnce([
                {
                    id: "album-discovery-table-1",
                    title: "Unrelated Local Title",
                    rgMbid: "rg-discovery-table-1",
                    location: "LIBRARY",
                    artistId: "artist-discovery-table-1",
                    artist: {
                        name: "Unrelated Local Artist",
                        mbid: "artist-mbid-discovery-table",
                    },
                },
            ]) // library albums
            .mockResolvedValueOnce([]); // empty albums
        (prisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce(null);

        await expect(module.runDataIntegrityCheck()).resolves.toEqual(
            expect.objectContaining({
                mislocatedAlbums: 1,
            })
        );
        expect(prisma.album.update).toHaveBeenCalledWith({
            where: { id: "album-discovery-table-1" },
            data: { location: "DISCOVER" },
        });
    });

    it("skips mislocation changes when liked discovery albums exist for artist", async () => {
        const { module, prisma } = loadDataIntegrity();

        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                discoveryBatchId: "batch-1",
                status: "completed",
                metadata: {
                    albumTitle: "Discovery Album",
                    artistName: "Discovery Artist",
                    artistMbid: "artist-mbid-liked",
                },
            },
        ]);
        (prisma.album.findMany as jest.Mock)
            .mockReset()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                {
                    id: "album-liked-1",
                    title: "Discovery Album",
                    rgMbid: "rg-liked-1",
                    location: "LIBRARY",
                    artistId: "artist-liked-1",
                    artist: { name: "Discovery Artist", mbid: "artist-mbid-liked" },
                },
            ])
            .mockResolvedValueOnce([]);
        (prisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "liked-1",
            status: "LIKED",
        });

        await expect(module.runDataIntegrityCheck()).resolves.toEqual(
            expect.objectContaining({
                mislocatedAlbums: 0,
            })
        );
        expect(prisma.album.update).not.toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "album-liked-1" },
            })
        );
    });

    it("logs orphaned OwnedAlbum cleanup when raw delete removes rows", async () => {
        const { module, prisma, logger } = loadDataIntegrity();
        (prisma.$executeRaw as jest.Mock).mockResolvedValueOnce(2);

        await expect(module.runDataIntegrityCheck()).resolves.toEqual(
            expect.objectContaining({
                oldDownloadJobs: 3,
            })
        );
        expect(logger.debug).toHaveBeenCalledWith(
            "     Removed 2 orphaned OwnedAlbum records"
        );
    });

    it("does not consolidate temp artists when no real artist match exists", async () => {
        const { module, prisma } = loadDataIntegrity();
        (prisma.artist.findMany as jest.Mock)
            .mockReset()
            .mockResolvedValueOnce([
                {
                    id: "temp-artist-no-real",
                    name: "No Real Match",
                    normalizedName: "no real match",
                },
            ])
            .mockResolvedValueOnce([]);
        (prisma.artist.findFirst as jest.Mock).mockResolvedValueOnce(null);

        await expect(module.runDataIntegrityCheck()).resolves.toEqual(
            expect.objectContaining({
                consolidatedArtists: 0,
            })
        );
        expect(prisma.album.updateMany).not.toHaveBeenCalledWith(
            expect.objectContaining({
                where: { artistId: "temp-artist-no-real" },
            })
        );
    });
});
