describe("provider track garbage collection", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadGc(
        options: {
            failSelection?: boolean;
            failCleanup?: boolean;
            deletedCount?: number;
        } = {},
    ) {
        const logger = {
            info: jest.fn(),
            error: jest.fn(),
            child: jest.fn(),
        };
        logger.child.mockReturnValue(logger);
        const recordProviderTrackGcPass = jest.fn();
        const cleanupOrphanedLibraryEntities = options.failCleanup
            ? jest.fn(async () => {
                  throw new Error("cleanup failed");
              })
            : jest.fn(async () => ({
                  albumsDeleted: 1,
                  artistsDeleted: 1,
              }));
        let prisma: any;
        prisma = {
            trackTidal: {
                findMany: options.failSelection
                    ? jest.fn(async () => {
                          throw new Error("selection failed");
                      })
                    : jest.fn(async () => [{ id: "tidal-1" }]),
                deleteMany: jest.fn(async () => ({
                    count: options.deletedCount ?? 1,
                })),
            },
            trackYtMusic: {
                findMany: jest.fn(async () => [{ id: "youtube-1" }]),
                deleteMany: jest.fn(async () => ({
                    count: options.deletedCount ?? 1,
                })),
            },
            trackMapping: {
                deleteMany: jest.fn(async () => ({ count: 2 })),
            },
            $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
                callback(prisma),
            ),
        };

        jest.doMock("../../config", () => ({
            config: { workers: { providerTrackRetentionDays: 30 } },
        }));
        jest.doMock("../../utils/db", () => ({ prisma }));
        jest.doMock("../../utils/logger", () => ({ logger }));
        jest.doMock("../../metrics", () => ({ recordProviderTrackGcPass }));
        jest.doMock("../libraryOrphanCleanup", () => ({
            cleanupOrphanedLibraryEntities,
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../providerTrackGc");
        return {
            module,
            prisma,
            logger,
            recordProviderTrackGcPass,
            cleanupOrphanedLibraryEntities,
        };
    }

    it("bounds selection and rechecks liveness in transactional deletes", async () => {
        const {
            module,
            prisma,
            logger,
            recordProviderTrackGcPass,
            cleanupOrphanedLibraryEntities,
        } = loadGc();
        const now = new Date("2026-08-19T00:00:00.000Z");

        await expect(
            module.collectProviderTracks({ now, retentionDays: 30 }),
        ).resolves.toEqual({
            selected: { tidal: 1, youtube: 1 },
            deleted: { tidal: 1, youtube: 1 },
            orphanedParents: { albums: 1, artists: 1 },
        });

        expect(prisma.trackTidal.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ take: 100 }),
        );
        const selectionWhere =
            prisma.trackTidal.findMany.mock.calls[0][0].where;
        expect(prisma.trackTidal.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: ["tidal-1"] }, ...selectionWhere },
        });
        expect(prisma.trackYtMusic.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: ["youtube-1"] }, ...selectionWhere },
        });
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(cleanupOrphanedLibraryEntities).toHaveBeenCalledWith(now);
        expect(recordProviderTrackGcPass).toHaveBeenCalledWith(
            "success",
            expect.any(Number),
            { tidal: 1, youtube: 1 },
        );
        expect(logger.info).toHaveBeenCalledWith(
            "Provider track garbage collection pass completed",
            expect.objectContaining({
                selectedTidal: 1,
                selectedYoutube: 1,
                deletedTidal: 1,
                deletedYoutube: 1,
                durationMs: expect.any(Number),
            }),
        );
    });

    it("records and rethrows a failed pass", async () => {
        const { module, recordProviderTrackGcPass, logger } = loadGc({
            failSelection: true,
        });

        await expect(module.collectProviderTracks()).rejects.toThrow(
            "selection failed",
        );
        expect(recordProviderTrackGcPass).toHaveBeenCalledWith(
            "failure",
            expect.any(Number),
            { tidal: 0, youtube: 0 },
        );
        expect(logger.error).toHaveBeenCalledWith(
            "Provider track garbage collection pass failed",
            expect.objectContaining({ error: expect.any(Error) }),
        );
    });

    it("retries orphan cleanup after provider deletes already committed", async () => {
        const { module, cleanupOrphanedLibraryEntities } = loadGc({
            deletedCount: 0,
        });
        const now = new Date("2026-08-19T00:00:00.000Z");

        await expect(
            module.collectProviderTracks({ now, retentionDays: 30 }),
        ).resolves.toEqual(
            expect.objectContaining({
                deleted: { tidal: 0, youtube: 0 },
                orphanedParents: { albums: 1, artists: 1 },
            }),
        );
        expect(cleanupOrphanedLibraryEntities).toHaveBeenCalledWith(now);
    });

    it("records committed deletes when parent cleanup fails", async () => {
        const { module, recordProviderTrackGcPass, logger } = loadGc({
            failCleanup: true,
        });

        await expect(module.collectProviderTracks()).rejects.toThrow(
            "cleanup failed",
        );
        expect(recordProviderTrackGcPass).toHaveBeenCalledWith(
            "failure",
            expect.any(Number),
            { tidal: 1, youtube: 1 },
        );
        expect(logger.error).toHaveBeenCalledWith(
            "Provider track garbage collection pass failed",
            expect.objectContaining({ deletedTidal: 1, deletedYoutube: 1 }),
        );
    });
});
