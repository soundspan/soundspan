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
                deleteMany: jest.fn(async () => ({ count: 1 })),
            },
            federationTombstone: {
                createMany: jest.fn(async ({ data }: { data: unknown[] }) => ({
                    count: data.length,
                })),
            },
            $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
                callback(prisma),
            ),
        };

        jest.doMock("../../utils/db", () => ({ prisma }));
        jest.doMock("../../utils/logger", () => ({ logger }));
        jest.doMock("../../config", () => ({
            config: { features: { federation: federationEnabled } },
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../libraryOrphanCleanup");
        return { module, prisma };
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
                tracks: { none: {} },
                tracksTidal: { none: {} },
                tracksYtMusic: { none: {} },
            },
            orderBy: { id: "asc" },
            take: 10_000,
            select: { id: true },
        });
        expect(prisma.album.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["local-album"] },
                peerId: null,
                tracks: { none: {} },
                tracksTidal: { none: {} },
                tracksYtMusic: { none: {} },
            },
        });
        expect(prisma.artist.findMany).toHaveBeenCalledWith({
            where: {
                peerId: null,
                albums: { none: {} },
                tracksTidal: { none: {} },
                tracksYtMusic: { none: {} },
            },
            orderBy: { id: "asc" },
            take: 10_000,
            select: { id: true },
        });
        expect(prisma.artist.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["local-artist"] },
                peerId: null,
                albums: { none: {} },
                tracksTidal: { none: {} },
                tracksYtMusic: { none: {} },
            },
        });
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

    it("writes no orphan tombstones when federation is disabled", async () => {
        const { module, prisma } = loadCleanup(false);

        await module.cleanupOrphanedLibraryEntities();

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.federationTombstone.createMany).not.toHaveBeenCalled();
    });
});
