describe("cleanupOrphanedLibraryEntities", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadCleanup() {
        const logger = {
            info: jest.fn(),
            child: jest.fn(),
        };
        logger.child.mockReturnValue(logger);
        const prisma = {
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
        };

        jest.doMock("../../utils/db", () => ({ prisma }));
        jest.doMock("../../utils/logger", () => ({ logger }));

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
            where: { peerId: null, tracks: { none: {} } },
            select: { id: true },
        });
        expect(prisma.album.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["local-album"] },
                peerId: null,
                tracks: { none: {} },
            },
        });
        expect(prisma.artist.findMany).toHaveBeenCalledWith({
            where: { peerId: null, albums: { none: {} } },
            select: { id: true },
        });
        expect(prisma.artist.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["local-artist"] },
                peerId: null,
                albums: { none: {} },
            },
        });
    });

    it("leaves peer-owned entities untouched during an empty sync window", async () => {
        const { module, prisma } = loadCleanup();
        prisma.album.findMany.mockImplementationOnce(async (args) => {
            return args.where?.peerId === null
                ? []
                : [{ id: "federated-album", peerId: "peer-1" }];
        });
        prisma.artist.findMany.mockImplementationOnce(async (args) => {
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
});
