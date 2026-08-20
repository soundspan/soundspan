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
            tidalPageSizes?: number[];
            youtubePageSizes?: number[];
        } = {},
    ) {
        const logger = {
            info: jest.fn(),
            warn: jest.fn(),
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
        const page = (provider: string, sizes: number[] | undefined) => {
            const size = sizes?.shift() ?? 1;
            return Array.from({ length: size }, (_, index) => ({
                id: `${provider}-${index + 1}`,
            }));
        };
        let prisma: any;
        prisma = {
            trackTidal: {
                findMany: options.failSelection
                    ? jest.fn(async () => {
                          throw new Error("selection failed");
                      })
                    : jest.fn(async () =>
                          page("tidal", options.tidalPageSizes),
                      ),
                deleteMany: jest.fn(async (args: any) => ({
                    count: options.deletedCount ?? args.where.id.in.length,
                })),
                count: jest.fn(async () => 0),
                findFirst: jest.fn(async () => null),
            },
            trackYtMusic: {
                findMany: jest.fn(async () =>
                    page("youtube", options.youtubePageSizes),
                ),
                deleteMany: jest.fn(async (args: any) => ({
                    count: options.deletedCount ?? args.where.id.in.length,
                })),
                count: jest.fn(async () => 0),
                findFirst: jest.fn(async () => null),
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
        expect(prisma.trackTidal.count).toHaveBeenCalledWith(
            expect.objectContaining({ take: 50_000 }),
        );
        expect(prisma.trackTidal.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ orderBy: { createdAt: "asc" } }),
        );
        expect(cleanupOrphanedLibraryEntities).toHaveBeenCalledWith(now);
        expect(recordProviderTrackGcPass).toHaveBeenCalledWith(
            "success",
            expect.any(Number),
            { tidal: 1, youtube: 1 },
            {
                backlog: { tidal: 0, youtube: 0 },
                oldestCollectableAgeSeconds: { tidal: 0, youtube: 0 },
            },
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

    it("drains more than one provider batch in a single invocation", async () => {
        const { module, prisma } = loadGc({
            tidalPageSizes: [100, 100, 20],
            youtubePageSizes: [100, 100, 20],
        });

        await expect(module.collectProviderTracks()).resolves.toEqual(
            expect.objectContaining({
                selected: { tidal: 220, youtube: 220 },
                deleted: { tidal: 220, youtube: 220 },
            }),
        );
        expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    });

    it("opens no delete transaction when the candidate set is empty", async () => {
        const { module, prisma } = loadGc({
            tidalPageSizes: [0],
            youtubePageSizes: [0],
        });

        await expect(module.collectProviderTracks()).resolves.toEqual(
            expect.objectContaining({
                selected: { tidal: 0, youtube: 0 },
                deleted: { tidal: 0, youtube: 0 },
            }),
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("stops provider continuation at the hard pass ceiling", async () => {
        const fullPages = Array.from({ length: 50 }, () => 100);
        const { module, prisma, logger } = loadGc({
            tidalPageSizes: [...fullPages],
            youtubePageSizes: [...fullPages],
        });

        await expect(module.collectProviderTracks()).resolves.toEqual(
            expect.objectContaining({
                selected: { tidal: 5_000, youtube: 5_000 },
                deleted: { tidal: 5_000, youtube: 5_000 },
            }),
        );
        expect(prisma.$transaction).toHaveBeenCalledTimes(50);
        expect(logger.warn).toHaveBeenCalledWith(
            "Provider track garbage collection reached its safety ceiling",
            expect.objectContaining({ maxPasses: 50 }),
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
