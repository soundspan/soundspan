describe("trackRemovalPurgeProcessor", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadProcessor(
        candidates: Array<{
            id: string;
            origin?: "LOCAL" | "FEDERATED";
            removedAt?: Date | null;
        }>,
        retentionDays = 90,
        deletedCount?: number,
        federationEnabled = false,
    ) {
        const logger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            child: jest.fn(),
        };
        logger.child.mockReturnValue(logger);

        let prisma: any;
        prisma = {
            track: {
                findMany: jest.fn(async (args: any) =>
                    candidates.filter((track) => {
                        const isLocal = track.origin !== "FEDERATED";
                        const isBeforeCutoff =
                            track.removedAt === undefined ||
                            (track.removedAt !== null &&
                                track.removedAt < args.where.removedAt.lt);
                        const isAfterCursor =
                            !args.where.id?.gt || track.id > args.where.id.gt;
                        return isLocal && isBeforeCutoff && isAfterCursor;
                    }),
                ),
                deleteMany: jest.fn(async (args: any) => ({
                    count: deletedCount ?? args.where.id.in.length,
                })),
            },
            federationTombstone: {
                createMany: jest.fn(async () => ({ count: deletedCount })),
                deleteMany: jest.fn(async () => ({ count: 0 })),
            },
            $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
                callback(prisma),
            ),
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
            config: {
                features: { federation: federationEnabled },
                workers: {
                    trackRemovalRetentionDays: retentionDays,
                    federationTombstoneRetentionDays: 90,
                },
            },
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

    it("derives the legacy retention cutoff when the payload is absent", async () => {
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
            module.processTrackRemovalPurge(buildJob()),
        ).resolves.toEqual({ deleted: 1, continued: false });

        expect(prisma.track.findMany).toHaveBeenCalledWith({
            where: {
                origin: "LOCAL",
                removedAt: { lt: new Date("2026-05-16T12:00:00.000Z") },
            },
            orderBy: { id: "asc" },
            take: 101,
            select: { id: true },
        });
        expect(prisma.track.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["track-old"] },
                origin: "LOCAL",
                removedAt: { lt: new Date("2026-05-16T12:00:00.000Z") },
            },
        });
        expect(cleanupOrphanedLibraryEntities).toHaveBeenCalledTimes(1);
        expect(backfillAllArtistCounts).toHaveBeenCalledTimes(1);
    });

    it("uses an explicit initial cutoff and never purges tracks without removedAt", async () => {
        const cutoff = new Date("2026-08-18T12:00:00.000Z");
        const { module, prisma } = loadProcessor([
            {
                id: "track-before-cutoff",
                removedAt: new Date("2026-08-18T11:59:59.999Z"),
            },
            { id: "track-active", removedAt: null },
            {
                id: "track-at-cutoff",
                removedAt: new Date("2026-08-18T12:00:00.000Z"),
            },
        ]);

        await expect(
            module.processTrackRemovalPurge(
                buildJob({ cutoffAt: cutoff.toISOString() }),
            ),
        ).resolves.toEqual({ deleted: 1, continued: false });

        expect(prisma.track.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["track-before-cutoff"] },
                origin: "LOCAL",
                removedAt: { lt: cutoff },
            },
        });
    });

    it("writes track tombstones and cleans expired tombstones on a federation terminal page", async () => {
        jest.useFakeTimers().setSystemTime(
            new Date("2026-08-15T12:00:00.000Z"),
        );
        const { module, prisma } = loadProcessor(
            [{ id: "track-old" }],
            90,
            1,
            true,
        );

        await module.processTrackRemovalPurge(buildJob());

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.federationTombstone.createMany).toHaveBeenCalledWith({
            data: [{ entityType: "track", entityId: "track-old" }],
        });
        expect(prisma.federationTombstone.deleteMany).toHaveBeenCalledWith({
            where: { deletedAt: { lt: new Date("2026-05-17T12:00:00.000Z") } },
        });
    });

    it("writes no tombstones when federation is disabled", async () => {
        const { module, prisma } = loadProcessor([{ id: "track-old" }]);

        await module.processTrackRemovalPurge(buildJob());

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.federationTombstone.createMany).not.toHaveBeenCalled();
        expect(prisma.federationTombstone.deleteMany).not.toHaveBeenCalled();
    });

    it("uses the current instant as the exclusive cutoff when retention is zero", async () => {
        const now = new Date("2026-08-14T12:00:00.000Z");
        jest.useFakeTimers().setSystemTime(now);
        const { module, prisma } = loadProcessor([{ id: "track-removed" }], 0);

        await module.processTrackRemovalPurge(buildJob({ mode: "repeat" }));

        expect(prisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { origin: "LOCAL", removedAt: { lt: now } },
            }),
        );
    });

    it("enqueues a keyset continuation when more than one bounded batch remains", async () => {
        const now = new Date("2026-08-14T12:00:00.000Z");
        jest.useFakeTimers().setSystemTime(now);
        const candidates = Array.from({ length: 101 }, (_, index) => ({
            id: `track-${index.toString().padStart(3, "0")}`,
        }));
        const {
            module,
            prisma,
            schedulerQueue,
            cleanupOrphanedLibraryEntities,
            backfillAllArtistCounts,
        } = loadProcessor(candidates, 90, 100);

        await expect(
            module.processTrackRemovalPurge(buildJob()),
        ).resolves.toEqual({ deleted: 100, continued: true });

        expect(prisma.track.deleteMany).toHaveBeenCalledWith({
            where: {
                id: {
                    in: expect.arrayContaining(["track-000", "track-099"]),
                },
                origin: "LOCAL",
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
                deletedSoFar: 100,
            },
            {
                attempts: 3,
                backoff: { type: "exponential", delay: 5_000 },
                jobId: "scheduler:track-removal-purge:2026-05-16T12:00:00.000Z:track-099",
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
        expect(cleanupOrphanedLibraryEntities).not.toHaveBeenCalled();
        expect(backfillAllArtistCounts).not.toHaveBeenCalled();
    });

    it("resumes after a validated cursor with the persisted cutoff", async () => {
        const cutoffAt = "2026-05-16T12:00:00.000Z";
        const { module, prisma } = loadProcessor([{ id: "track-101" }]);

        await module.processTrackRemovalPurge(
            buildJob({
                startAfterId: "track-100",
                cutoffAt,
                deletedSoFar: 100,
            }),
        );

        expect(prisma.track.findMany).toHaveBeenCalledWith({
            where: {
                origin: "LOCAL",
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

    it.each([-1, 1.5, "100", undefined])(
        "rejects malformed continuation deletedSoFar %p",
        async (deletedSoFar) => {
            const { module, prisma } = loadProcessor([]);

            await expect(
                module.processTrackRemovalPurge(
                    buildJob({
                        startAfterId: "track-100",
                        cutoffAt: "2026-05-16T12:00:00.000Z",
                        ...(deletedSoFar === undefined ? {} : { deletedSoFar }),
                    }),
                ),
            ).rejects.toBeDefined();
            expect(prisma.track.findMany).not.toHaveBeenCalled();
        },
    );

    it.each([
        {
            startAfterId: "track-100",
            deletedSoFar: 100,
        },
        {
            cutoffAt: "2026-05-16T12:00:00.000Z",
            deletedSoFar: 100,
        },
    ])("rejects incomplete continuation data %#", async (data) => {
        const { module, prisma } = loadProcessor([]);

        await expect(
            module.processTrackRemovalPurge(buildJob(data)),
        ).rejects.toBeDefined();
        expect(prisma.track.findMany).not.toHaveBeenCalled();
    });

    it("refreshes the catalog once after a multi-page sweep and logs the cumulative count", async () => {
        const firstPage = Array.from({ length: 101 }, (_, index) => ({
            id: `track-${index.toString().padStart(3, "0")}`,
        }));
        const {
            module,
            logger,
            prisma,
            schedulerQueue,
            cleanupOrphanedLibraryEntities,
            backfillAllArtistCounts,
        } = loadProcessor(firstPage, 90, 100);

        await module.processTrackRemovalPurge(buildJob());
        expect(cleanupOrphanedLibraryEntities).not.toHaveBeenCalled();
        expect(backfillAllArtistCounts).not.toHaveBeenCalled();

        const secondPage = Array.from({ length: 101 }, (_, index) => ({
            id: `track-${(index + 100).toString().padStart(3, "0")}`,
        }));
        prisma.track.findMany.mockResolvedValueOnce(secondPage);
        prisma.track.deleteMany.mockResolvedValueOnce({ count: 50 });
        const continuationCalls = schedulerQueue.add.mock
            .calls as unknown as Array<[string, Record<string, unknown>]>;
        const firstContinuation = continuationCalls[0]?.[1];
        await module.processTrackRemovalPurge(buildJob(firstContinuation));
        expect(cleanupOrphanedLibraryEntities).not.toHaveBeenCalled();
        expect(backfillAllArtistCounts).not.toHaveBeenCalled();

        prisma.track.findMany.mockResolvedValueOnce([{ id: "track-200" }]);
        prisma.track.deleteMany.mockResolvedValueOnce({ count: 0 });
        const secondContinuation = continuationCalls[1]?.[1];
        await module.processTrackRemovalPurge(buildJob(secondContinuation));

        expect(cleanupOrphanedLibraryEntities).toHaveBeenCalledTimes(1);
        expect(backfillAllArtistCounts).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining("Post-purge cleanup for 150 tracks"),
        );
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

    it("does not select federated tracks for local retention purge", async () => {
        const { module, prisma, cleanupOrphanedLibraryEntities } =
            loadProcessor([{ id: "track-federated", origin: "FEDERATED" }]);

        await expect(
            module.processTrackRemovalPurge(buildJob()),
        ).resolves.toEqual({ deleted: 0, continued: false });

        expect(prisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ origin: "LOCAL" }),
            }),
        );
        expect(prisma.track.deleteMany).not.toHaveBeenCalled();
        expect(cleanupOrphanedLibraryEntities).not.toHaveBeenCalled();
    });
});
