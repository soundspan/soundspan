describe("trackRemovalPurgeProcessor", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadProcessor(
        candidates: Array<{ id: string }>,
        retentionDays = 90,
        deletedCount = candidates.length,
    ) {
        const logger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            child: jest.fn(),
        };
        logger.child.mockReturnValue(logger);

        const prisma = {
            track: {
                findMany: jest.fn(async () => candidates),
                deleteMany: jest.fn(async (_args: unknown) => ({
                    count: deletedCount,
                })),
            },
        };
        const schedulerQueue = { add: jest.fn(async () => ({})) };
        const cleanupOrphanedLibraryEntities = jest.fn(async () => ({
            albumsDeleted: 0,
            artistsDeleted: 0,
        }));
        const backfillAllArtistCounts = jest.fn(async () => ({
            processed: 2,
            errors: 0,
        }));

        jest.doMock("../../../utils/logger", () => ({ logger }));
        jest.doMock("../../../utils/db", () => ({ prisma }));
        jest.doMock("../../../config", () => ({
            config: { workers: { trackRemovalRetentionDays: retentionDays } },
        }));
        jest.doMock("../../queues", () => ({ schedulerQueue }));
        jest.doMock("../../../services/libraryOrphanCleanup", () => ({
            cleanupOrphanedLibraryEntities,
        }));
        jest.doMock("../../../services/artistCountsService", () => ({
            backfillAllArtistCounts,
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../trackRemovalPurgeProcessor");
        return {
            module,
            logger,
            prisma,
            schedulerQueue,
            cleanupOrphanedLibraryEntities,
            backfillAllArtistCounts,
        };
    }

    function buildJob(data: Record<string, unknown> = {}) {
        return { id: "track-removal-purge-1", data } as any;
    }

    it("purges only tracks older than the retention boundary and runs cleanup", async () => {
        jest.useFakeTimers().setSystemTime(
            new Date("2026-08-14T12:00:00.000Z"),
        );
        const {
            module,
            prisma,
            cleanupOrphanedLibraryEntities,
            backfillAllArtistCounts,
        } = loadProcessor([{ id: "track-old" }]);

        await expect(
            module.processTrackRemovalPurge(buildJob({ mode: "startup" })),
        ).resolves.toEqual({ deleted: 1, continued: false });

        expect(prisma.track.findMany).toHaveBeenCalledWith({
            where: {
                removedAt: { lt: new Date("2026-05-16T12:00:00.000Z") },
            },
            orderBy: { id: "asc" },
            take: 101,
            select: { id: true },
        });
        expect(prisma.track.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["track-old"] },
                removedAt: { lt: new Date("2026-05-16T12:00:00.000Z") },
            },
        });
        expect(cleanupOrphanedLibraryEntities).toHaveBeenCalledTimes(1);
        expect(backfillAllArtistCounts).toHaveBeenCalledTimes(1);
    });

    it("uses the current instant as the exclusive cutoff when retention is zero", async () => {
        const now = new Date("2026-08-14T12:00:00.000Z");
        jest.useFakeTimers().setSystemTime(now);
        const { module, prisma } = loadProcessor([{ id: "track-removed" }], 0);

        await module.processTrackRemovalPurge(buildJob({ mode: "repeat" }));

        expect(prisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { removedAt: { lt: now } },
            }),
        );
    });

    it("enqueues a keyset continuation when more than one bounded batch remains", async () => {
        const now = new Date("2026-08-14T12:00:00.000Z");
        jest.useFakeTimers().setSystemTime(now);
        const candidates = Array.from({ length: 101 }, (_, index) => ({
            id: `track-${index.toString().padStart(3, "0")}`,
        }));
        const { module, prisma, schedulerQueue } = loadProcessor(
            candidates,
            90,
            100,
        );

        await expect(
            module.processTrackRemovalPurge(buildJob()),
        ).resolves.toEqual({ deleted: 100, continued: true });

        expect(prisma.track.deleteMany).toHaveBeenCalledWith({
            where: {
                id: {
                    in: expect.arrayContaining(["track-000", "track-099"]),
                },
                removedAt: { lt: new Date("2026-05-16T12:00:00.000Z") },
            },
        });
        const deleteArgs = prisma.track.deleteMany.mock.calls[0]?.[0] as {
            where: { id: { in: string[] } };
        };
        expect(deleteArgs.where.id.in).toHaveLength(100);
        expect(schedulerQueue.add).toHaveBeenCalledWith(
            "track-removal-purge",
            {
                startAfterId: "track-099",
                cutoffAt: "2026-05-16T12:00:00.000Z",
            },
            {
                attempts: 3,
                backoff: { type: "exponential", delay: 5_000 },
                jobId: "scheduler:track-removal-purge:track-099",
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
    });

    it("resumes after a validated cursor with the persisted cutoff", async () => {
        const cutoffAt = "2026-05-16T12:00:00.000Z";
        const { module, prisma } = loadProcessor([{ id: "track-101" }]);

        await module.processTrackRemovalPurge(
            buildJob({ startAfterId: "track-100", cutoffAt }),
        );

        expect(prisma.track.findMany).toHaveBeenCalledWith({
            where: {
                removedAt: { lt: new Date(cutoffAt) },
                id: { gt: "track-100" },
            },
            orderBy: { id: "asc" },
            take: 101,
            select: { id: true },
        });
    });

    it("rejects invalid continuation data before querying the database", async () => {
        const { module, prisma } = loadProcessor([]);

        await expect(
            module.processTrackRemovalPurge(
                buildJob({ startAfterId: "", cutoffAt: "not-a-date" }),
            ),
        ).rejects.toBeDefined();
        expect(prisma.track.findMany).not.toHaveBeenCalled();
    });

    it("skips cleanup when no rows are purged", async () => {
        const {
            module,
            cleanupOrphanedLibraryEntities,
            backfillAllArtistCounts,
        } = loadProcessor([]);

        await expect(
            module.processTrackRemovalPurge(buildJob()),
        ).resolves.toEqual({ deleted: 0, continued: false });
        expect(cleanupOrphanedLibraryEntities).not.toHaveBeenCalled();
        expect(backfillAllArtistCounts).not.toHaveBeenCalled();
    });
});
