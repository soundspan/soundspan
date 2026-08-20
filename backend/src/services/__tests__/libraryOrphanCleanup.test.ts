describe("cleanupOrphanedLibraryEntities", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadCleanup(federationEnabled = false) {
        const logger = {
            info: jest.fn(),
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
        return { module, operations, prisma };
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
            take: 10_000,
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
            take: 10_000,
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
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
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

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
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

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
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
});
