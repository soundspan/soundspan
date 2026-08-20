describe("cleanupOrphanedLibraryEntities", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadCleanup(federationEnabled = false) {
        const logger = {
            info: jest.fn(),
            error: jest.fn(),
            child: jest.fn(),
        };
        logger.child.mockReturnValue(logger);
        let prisma: any;
        const operations: string[] = [];
        prisma = {
            album: {
                findMany: jest.fn(
                    async (_args: { where?: { peerId?: string | null } }) => [
                        { id: "local-album" },
                    ],
                ),
                deleteMany: jest.fn(async () => ({ count: 1 })),
            },
            artist: {
                findMany: jest.fn(
                    async (_args: { where?: { peerId?: string | null } }) => [
                        { id: "local-artist" },
                    ],
                ),
                deleteMany: jest.fn(async () => {
                    operations.push("delete-artist");
                    return { count: 1 };
                }),
            },
            federationTombstone: {
                createMany: jest.fn(async ({ data }: { data: unknown[] }) => ({
                    count: data.length,
                })),
            },
            $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
                callback(prisma),
            ),
            $queryRaw: jest.fn(async () => {
                operations.push("lock-artist-albums");
                return [];
            }),
        };

        jest.doMock("../../utils/db", () => ({ prisma }));
        jest.doMock("../../utils/logger", () => ({ logger }));
        jest.doMock("../../config", () => ({
            config: {
                features: { federation: federationEnabled },
                workers: { providerTrackRetentionDays: 30 },
            },
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../libraryOrphanCleanup");
        return { logger, module, operations, prisma };
    }

    it("deletes only peerless orphaned albums and artists", async () => {
        const { module, prisma } = loadCleanup();

        await expect(module.cleanupOrphanedLibraryEntities()).resolves.toEqual({
            albumsDeleted: 1,
            artistsDeleted: 1,
        });

        expect(prisma.album.findMany).toHaveBeenCalledWith({
            where: {
                peerId: null,
                hasUserOverrides: false,
                ownedBy: { none: {} },
                tracks: { none: {} },
                tracksTidal: { none: { NOT: expect.any(Object) } },
                tracksYtMusic: { none: { NOT: expect.any(Object) } },
            },
            orderBy: { id: "asc" },
            take: 100,
            select: { id: true },
        });
        expect(prisma.album.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["local-album"] },
                peerId: null,
                hasUserOverrides: false,
                ownedBy: { none: {} },
                tracks: { none: {} },
                tracksTidal: { none: { NOT: expect.any(Object) } },
                tracksYtMusic: { none: { NOT: expect.any(Object) } },
            },
        });
        expect(prisma.artist.findMany).toHaveBeenCalledWith({
            where: {
                peerId: null,
                hasUserOverrides: false,
                ownedAlbums: { none: {} },
                albums: { none: {} },
                tracksTidal: { none: { NOT: expect.any(Object) } },
                tracksYtMusic: { none: { NOT: expect.any(Object) } },
            },
            orderBy: { id: "asc" },
            take: 100,
            select: { id: true },
        });
        expect(prisma.artist.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["local-artist"] },
                peerId: null,
                hasUserOverrides: false,
                ownedAlbums: { none: {} },
                albums: { none: {} },
                tracksTidal: { none: { NOT: expect.any(Object) } },
                tracksYtMusic: { none: { NOT: expect.any(Object) } },
            },
        });
        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(prisma.$transaction).toHaveBeenNthCalledWith(
            1,
            expect.any(Function),
            { maxWait: 2000, timeout: 15000 },
        );
        expect(prisma.$transaction).toHaveBeenNthCalledWith(
            2,
            expect.any(Function),
            { maxWait: 2000, timeout: 15000 },
        );
        expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it("leaves peer-owned entities untouched during an empty sync window", async () => {
        const { module, prisma } = loadCleanup();
        prisma.album.findMany.mockImplementationOnce(async (args: any) => {
            return args.where?.peerId === null
                ? []
                : [{ id: "federated-album", peerId: "peer-1" }];
        });
        prisma.artist.findMany.mockImplementationOnce(async (args: any) => {
            return args.where?.peerId === null
                ? []
                : [{ id: "federated-artist", peerId: "peer-1" }];
        });

        await expect(module.cleanupOrphanedLibraryEntities()).resolves.toEqual({
            albumsDeleted: 0,
            artistsDeleted: 0,
        });

        expect(prisma.album.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ peerId: null }),
            }),
        );
        expect(prisma.artist.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ peerId: null }),
            }),
        );
        expect(prisma.album.deleteMany).not.toHaveBeenCalled();
        expect(prisma.artist.deleteMany).not.toHaveBeenCalled();
    });

    it("writes album and artist tombstones in the deletion transaction when federation is enabled", async () => {
        const { module, prisma } = loadCleanup(true);

        await module.cleanupOrphanedLibraryEntities();

        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(prisma.federationTombstone.createMany).toHaveBeenNthCalledWith(
            1,
            {
                data: [{ entityType: "album", entityId: "local-album" }],
            },
        );
        expect(prisma.federationTombstone.createMany).toHaveBeenNthCalledWith(
            2,
            {
                data: [{ entityType: "artist", entityId: "local-artist" }],
            },
        );
    });

    it("locks candidate artist album rows before deletion without federation", async () => {
        const { module, operations, prisma } = loadCleanup(false);

        await module.cleanupOrphanedLibraryEntities();

        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(operations).toEqual(["lock-artist-albums", "delete-artist"]);
        const query = prisma.$queryRaw.mock.calls[0][0];
        expect(query.strings.join("")).toContain(
            'FROM "Album"\n        WHERE "artistId" IN (',
        );
        expect(query.strings.join("")).toContain(
            'ORDER BY "id"\n        FOR UPDATE',
        );
        expect(prisma.federationTombstone.createMany).not.toHaveBeenCalled();
    });

    it("cleans more than one batch with one transaction per batch", async () => {
        const { module, prisma } = loadCleanup(true);
        const albumBatch = Array.from({ length: 100 }, (_, index) => ({
            id: `album-${String(index).padStart(3, "0")}`,
        }));
        const artistBatch = Array.from({ length: 100 }, (_, index) => ({
            id: `artist-${String(index).padStart(3, "0")}`,
        }));
        prisma.album.findMany
            .mockResolvedValueOnce(albumBatch)
            .mockResolvedValueOnce([{ id: "album-100" }]);
        prisma.album.deleteMany
            .mockResolvedValueOnce({ count: 100 })
            .mockResolvedValueOnce({ count: 1 });
        prisma.artist.findMany
            .mockResolvedValueOnce(artistBatch)
            .mockResolvedValueOnce([{ id: "artist-100" }]);
        prisma.artist.deleteMany
            .mockResolvedValueOnce({ count: 100 })
            .mockResolvedValueOnce({ count: 1 });

        await expect(module.cleanupOrphanedLibraryEntities()).resolves.toEqual({
            albumsDeleted: 101,
            artistsDeleted: 101,
        });

        expect(prisma.$transaction).toHaveBeenCalledTimes(4);
        expect(
            prisma.$transaction.mock.calls.map(
                ([, transactionOptions]: [unknown, unknown]) =>
                    transactionOptions,
            ),
        ).toEqual(
            Array.from({ length: 4 }, () => ({
                maxWait: 2000,
                timeout: 15000,
            })),
        );
        expect(prisma.album.findMany).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                where: expect.objectContaining({
                    id: { gt: "album-099" },
                }),
                take: 100,
            }),
        );
        expect(prisma.artist.findMany).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                where: expect.objectContaining({
                    id: { gt: "artist-099" },
                }),
                take: 100,
            }),
        );
        expect(prisma.federationTombstone.createMany).toHaveBeenCalledTimes(4);
    });

    it("continues after a failed batch and reports partial counts", async () => {
        const { logger, module, prisma } = loadCleanup(true);
        const failedBatch = Array.from({ length: 100 }, (_, index) => ({
            id: `album-${String(index).padStart(3, "0")}`,
        }));
        prisma.album.findMany
            .mockResolvedValueOnce(failedBatch)
            .mockResolvedValueOnce([{ id: "album-100" }]);
        prisma.album.deleteMany
            .mockRejectedValueOnce(new Error("album batch failed"))
            .mockResolvedValueOnce({ count: 1 });

        await expect(module.cleanupOrphanedLibraryEntities()).resolves.toEqual({
            albumsDeleted: 1,
            artistsDeleted: 1,
        });

        expect(prisma.album.findMany).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                where: expect.objectContaining({
                    id: { gt: "album-099" },
                }),
            }),
        );
        expect(prisma.$transaction).toHaveBeenCalledTimes(3);
        expect(prisma.federationTombstone.createMany).toHaveBeenCalledTimes(2);
        expect(logger.error).toHaveBeenCalledWith(
            "Album orphan cleanup batch failed",
            expect.objectContaining({
                error: expect.objectContaining({
                    message: "album batch failed",
                }),
                batch: 1,
            }),
        );
    });
});
