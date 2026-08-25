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

        const removedIds = new Set<string>();
        let prisma: any;
        prisma = {
            track: {
                findMany: jest.fn(async (args: any) =>
                    candidates.filter((track) => {
                        if (removedIds.has(track.id)) return false;
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
                deleteMany: jest.fn(async (args: any) => {
                    for (const id of args.where.id.in) removedIds.add(id);
                    return {
                        count: deletedCount ?? args.where.id.in.length,
                    };
                }),
                count: jest.fn(
                    async (args: any) =>
                        candidates.filter((track) => {
                            if (removedIds.has(track.id)) return false;
                            const isLocal = track.origin !== "FEDERATED";
                            const isBeforeCutoff =
                                track.removedAt === undefined ||
                                (track.removedAt !== null &&
                                    track.removedAt < args.where.removedAt.lt);
                            return (
                                isLocal &&
                                isBeforeCutoff &&
                                (!args.where.id?.gt ||
                                    track.id > args.where.id.gt)
                            );
                        }).length,
                ),
            },
            trackMapping: {
                deleteMany: jest.fn(async () => ({ count: 0 })),
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
        const redisClient = {
            set: jest.fn(async () => "OK"),
            del: jest.fn(async () => 1),
            eval: jest.fn(async () => 1),
        };
        const cleanupOrphanedLibraryEntities = jest.fn(async () => ({
            albumsDeleted: 0,
            artistsDeleted: 0,
        }));
        const backfillAllArtistCounts = jest.fn(async () => ({
            processed: 2,
            errors: 0,
        }));
        let generatedRunNumber = 0;
        const randomUUID = jest.fn(
            () => `generated-run-${(generatedRunNumber += 1)}`,
        );

        jest.doMock("crypto", () => ({ randomUUID }));
        jest.doMock("../../../utils/logger", () => ({ logger }));
        jest.doMock("../../../utils/db", () => ({ prisma }));
        jest.doMock("../../../config", () => ({
            config: {
                features: { federation: federationEnabled },
                workers: {
                    trackRemovalRetentionDays: retentionDays,
                    providerTrackRetentionDays: 30,
                    federationTombstoneRetentionDays: 90,
                },
            },
        }));
        jest.doMock("../../queues", () => ({
            schedulerMaintenanceQueue: schedulerQueue,
        }));
        jest.doMock("../../../utils/redis", () => ({ redisClient }));
        jest.doMock("../../../services/libraryOrphanCleanup", () => ({
            cleanupOrphanedLibraryEntities,
        }));
        jest.doMock("../../../services/artistCountsService", () => ({
            backfillAllArtistCounts,
        }));
        const collectProviderTracks = jest.fn(async () => ({
            selected: { tidal: 0, youtube: 0 },
            deleted: { tidal: 0, youtube: 0 },
            orphanedParents: { albums: 0, artists: 0 },
        }));
        jest.doMock("../../../services/providerTrackGc", () => ({
            collectProviderTracks,
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../trackRemovalPurgeProcessor");
        return {
            module,
            logger,
            prisma,
            schedulerQueue,
            redisClient,
            cleanupOrphanedLibraryEntities,
            backfillAllArtistCounts,
            collectProviderTracks,
            randomUUID,
        };
    }

    function buildJob(data: Record<string, unknown> = {}) {
        const job = {
            id: "track-removal-purge-1",
            data: { sweepRunId: "unique-run-a", ...data },
            update: jest.fn(async (next: Record<string, unknown>) => {
                job.data = next;
            }),
        } as any;
        return job;
    }

    // Mirrors real Bull: update() persists data onto the job, so retries of
    // the same job observe it, while each repeat occurrence is a NEW job.
    function buildLegacyJob(data: Record<string, unknown>) {
        const job = {
            id: "legacy-track-removal-purge",
            data,
            update: jest.fn(async (next: Record<string, unknown>) => {
                job.data = next;
            }),
        } as any;
        return job;
    }

    it("processes a persisted legacy repeat root without a sweep run id", async () => {
        const { module } = loadProcessor([]);

        await expect(
            module.processTrackRemovalPurge(buildLegacyJob({ mode: "repeat" })),
        ).resolves.toEqual({ deleted: 0, continued: false });
    });

    it("mints a different run id for each repeat occurrence", async () => {
        const { module, randomUUID, redisClient } = loadProcessor([]);

        // Bull creates a fresh job per repeat occurrence with the original data.
        await module.processTrackRemovalPurge(
            buildLegacyJob({ mode: "repeat" }),
        );
        await module.processTrackRemovalPurge(
            buildLegacyJob({ mode: "repeat" }),
        );

        expect(randomUUID).toHaveBeenCalledTimes(2);
        const markerCalls = redisClient.eval.mock.calls as unknown as Array<
            [string, { arguments: string[] }]
        >;
        const startRunIds = markerCalls
            .filter((call) => call[1]?.arguments?.length === 4)
            .map((call) => call[1].arguments[0]);
        expect(startRunIds).toEqual(["generated-run-1", "generated-run-2"]);
    });

    it("reuses one run id across Bull retries of the same job", async () => {
        const { module, randomUUID } = loadProcessor([]);
        const job = buildLegacyJob({ mode: "repeat" });

        await module.processTrackRemovalPurge(job);
        // A Bull retry re-invokes the processor with the SAME job, whose
        // data now carries the persisted run id.
        await module.processTrackRemovalPurge(job);

        expect(randomUUID).toHaveBeenCalledTimes(1);
        expect(job.update).toHaveBeenCalledTimes(1);
        expect(job.data.sweepRunId).toBe("generated-run-1");
    });

    it("mints a run id with a warning for a legacy continuation", async () => {
        const { module, logger, randomUUID } = loadProcessor([]);

        await expect(
            module.processTrackRemovalPurge(
                buildLegacyJob({
                    cutoffAt: "2026-05-16T12:00:00.000Z",
                    deletedSoFar: 100,
                    initialTotal: 100,
                    processedSoFar: 100,
                    remaining: 0,
                    pageNumber: 1,
                }),
            ),
        ).resolves.toEqual({ deleted: 0, continued: false });

        expect(randomUUID).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("lacked sweepRunId"),
        );
    });

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

    it("refreshes the one-hour marker after enqueuing a continuation", async () => {
        const candidates = Array.from({ length: 101 }, (_, index) => ({
            id: `track-${index.toString().padStart(3, "0")}`,
        }));
        const { module, redisClient, schedulerQueue } =
            loadProcessor(candidates);

        await module.processTrackRemovalPurge(buildJob());

        expect(redisClient.eval).toHaveBeenLastCalledWith(expect.any(String), {
            keys: [
                "library-health:purge-active:owners",
                "library-health:purge-active:remaining",
            ],
            arguments: expect.arrayContaining(["unique-run-a", "1", "3600"]),
        });
        const enqueueOrder = schedulerQueue.add.mock.invocationCallOrder[0];
        const refreshOrder = redisClient.eval.mock.invocationCallOrder.at(-1);
        expect(refreshOrder).toBeGreaterThan(enqueueOrder);
    });

    it("clears only its owned marker when the sweep completes", async () => {
        const { module, redisClient } = loadProcessor([{ id: "track-old" }]);

        await module.processTrackRemovalPurge(buildJob());

        expect(redisClient.eval).toHaveBeenLastCalledWith(expect.any(String), {
            keys: [
                "library-health:purge-active:owners",
                "library-health:purge-active:remaining",
            ],
            arguments: ["unique-run-a"],
        });
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

    it("deletes track-only mappings before the track rows so the linkage check cannot fail", async () => {
        const cutoff = new Date("2026-08-18T12:00:00.000Z");
        const { module, prisma } = loadProcessor([
            {
                id: "track-mapped",
                removedAt: new Date("2026-08-18T11:00:00.000Z"),
            },
        ]);

        await expect(
            module.processTrackRemovalPurge(
                buildJob({ cutoffAt: cutoff.toISOString() }),
            ),
        ).resolves.toEqual({ deleted: 1, continued: false });

        expect(prisma.trackMapping.deleteMany).toHaveBeenCalledWith({
            where: {
                track: {
                    id: { in: ["track-mapped"] },
                    origin: "LOCAL",
                    removedAt: { lt: cutoff },
                },
                trackTidalId: null,
                trackYtMusicId: null,
            },
        });
        const mappingOrder = (prisma.trackMapping.deleteMany as jest.Mock).mock
            .invocationCallOrder[0];
        const trackOrder = (prisma.track.deleteMany as jest.Mock).mock
            .invocationCallOrder[0];
        expect(mappingOrder).toBeLessThan(trackOrder);
    });

    it("writes track tombstones and cleans expired tombstones on a federation terminal page", async () => {
        jest.useFakeTimers().setSystemTime(
            new Date("2026-08-15T12:00:00.000Z"),
        );
        const { module, prisma, collectProviderTracks } = loadProcessor(
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
        expect(collectProviderTracks).toHaveBeenCalledTimes(1);
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
            collectProviderTracks,
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
                sweepRunId: "unique-run-a",
                initialTotal: 101,
                processedSoFar: 100,
                remaining: 1,
                pageNumber: 1,
            },
            {
                attempts: 3,
                backoff: { type: "exponential", delay: 5_000 },
                jobId: "scheduler:track-removal-purge:unique-run-a:2026-05-16T12:00:00.000Z:track-099",
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
        expect(cleanupOrphanedLibraryEntities).not.toHaveBeenCalled();
        expect(backfillAllArtistCounts).not.toHaveBeenCalled();
        expect(collectProviderTracks).not.toHaveBeenCalled();
    });

    it("propagates the processor-minted root run id to its continuation", async () => {
        const candidates = Array.from({ length: 101 }, (_, index) => ({
            id: `track-${index.toString().padStart(3, "0")}`,
        }));
        const { module, schedulerQueue } = loadProcessor(candidates);

        await module.processTrackRemovalPurge(
            buildLegacyJob({ mode: "startup" }),
        );

        expect(schedulerQueue.add).toHaveBeenCalledWith(
            "track-removal-purge",
            expect.objectContaining({ sweepRunId: "generated-run-1" }),
            expect.any(Object),
        );
    });

    it("resumes after a validated cursor with the persisted cutoff", async () => {
        const cutoffAt = "2026-05-16T12:00:00.000Z";
        const { module, prisma } = loadProcessor([{ id: "track-101" }]);

        await module.processTrackRemovalPurge(
            buildJob({
                startAfterId: "track-100",
                cutoffAt,
                deletedSoFar: 100,
                sweepRunId: "track-removal-purge-root",
                initialTotal: 200,
                processedSoFar: 100,
                remaining: 100,
                pageNumber: 1,
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

    it("carries an arithmetic remaining countdown without recounting a non-correction page", async () => {
        const candidates = Array.from({ length: 101 }, (_, index) => ({
            id: `track-${index.toString().padStart(3, "0")}`,
        }));
        const { module, prisma, schedulerQueue } = loadProcessor(candidates);

        await module.processTrackRemovalPurge(buildJob());

        expect(prisma.track.count).toHaveBeenCalledTimes(1);
        const continuationCalls = schedulerQueue.add.mock
            .calls as unknown as Array<[string, Record<string, unknown>]>;
        expect(continuationCalls[0]?.[1]).toEqual(
            expect.objectContaining({
                initialTotal: 101,
                processedSoFar: 100,
                remaining: 1,
                pageNumber: 1,
            }),
        );
    });

    it("corrects the arithmetic countdown every tenth processed page", async () => {
        const candidates = Array.from({ length: 101 }, (_, index) => ({
            id: `track-${(index + 901).toString().padStart(4, "0")}`,
        }));
        const { module, prisma, schedulerQueue } = loadProcessor(candidates);
        prisma.track.count.mockResolvedValueOnce(37);

        await module.processTrackRemovalPurge(
            buildJob({
                startAfterId: "track-0900",
                cutoffAt: "2026-05-16T12:00:00.000Z",
                deletedSoFar: 900,
                sweepRunId: "track-removal-purge-root",
                initialTotal: 2_000,
                processedSoFar: 900,
                remaining: 1_100,
                pageNumber: 9,
            }),
        );

        expect(prisma.track.count).toHaveBeenCalledWith({
            where: {
                origin: "LOCAL",
                removedAt: { lt: new Date("2026-05-16T12:00:00.000Z") },
                id: { gt: "track-1000" },
            },
        });
        const continuationCalls = schedulerQueue.add.mock
            .calls as unknown as Array<[string, Record<string, unknown>]>;
        expect(continuationCalls[0]?.[1]).toEqual(
            expect.objectContaining({
                initialTotal: 1_037,
                processedSoFar: 1_000,
                remaining: 37,
                pageNumber: 10,
            }),
        );
    });

    it("recounts a terminal page and restarts when matching rows drifted behind the cursor", async () => {
        const {
            module,
            prisma,
            schedulerQueue,
            cleanupOrphanedLibraryEntities,
        } = loadProcessor([{ id: "track-001" }]);
        prisma.track.count.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

        await expect(
            module.processTrackRemovalPurge(buildJob()),
        ).resolves.toEqual({ deleted: 1, continued: true });

        const continuationCalls = schedulerQueue.add.mock
            .calls as unknown as Array<[string, Record<string, unknown>]>;
        expect(continuationCalls[0]?.[1]).toEqual(
            expect.objectContaining({
                initialTotal: 3,
                processedSoFar: 1,
                remaining: 2,
                pageNumber: 1,
            }),
        );
        expect(continuationCalls[0]?.[1]).not.toHaveProperty("startAfterId");
        expect(cleanupOrphanedLibraryEntities).not.toHaveBeenCalled();
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
        prisma.track.count.mockResolvedValueOnce(0);
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
