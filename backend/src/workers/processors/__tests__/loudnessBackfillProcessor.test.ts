describe("loudnessBackfillProcessor", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadProcessor(
        tracks: Array<{
            id: string;
            filePath: string | null;
            duration: number;
        }>,
        admissions: Array<"queued" | "duplicate" | "full"> = [],
        batchSize = 25,
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
                findMany: jest.fn(async () => tracks),
            },
        };
        const schedulerQueue = {
            add: jest.fn(async () => ({})),
            client: { eval: jest.fn() },
        };
        const enqueueReservedWork = jest.fn(async () =>
            admissions.length > 0 ? admissions.shift() : "queued",
        );

        jest.doMock("../../../utils/logger", () => ({ logger }));
        jest.doMock("../../../utils/db", () => ({ prisma }));
        jest.doMock("../../../config", () => ({
            config: {
                analysisQueues: {
                    audioMaxDepth: 100,
                    loudnessBackfillBatchSize: batchSize,
                    reservationTtlSeconds: 3600,
                },
            },
        }));
        jest.doMock("../../enrichmentQueue", () => ({
            enqueueReservedWork,
        }));
        jest.doMock("../../queues", () => ({ schedulerQueue }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../loudnessBackfillProcessor");
        return {
            module,
            logger,
            prisma,
            schedulerQueue,
            enqueueReservedWork,
        };
    }

    function buildJob(startAfterId?: string) {
        return {
            id: "loudness-backfill-1",
            data: {
                ...(startAfterId ? { startAfterId } : { mode: "startup" }),
                sweepStartedAt: "2026-08-18T12:00:00.000Z",
            },
        } as any;
    }

    it("selects one keyset page and enqueues loudness-only work", async () => {
        const tracks = Array.from({ length: 3 }, (_, index) => ({
            id: `track-${index}`,
            filePath: `Artist/Track-${index}.flac`,
            duration: 180 + index,
        }));
        const { module, prisma, schedulerQueue, enqueueReservedWork } =
            loadProcessor(tracks, [], 2);

        await expect(
            module.processLoudnessBackfill(buildJob()),
        ).resolves.toEqual({
            processed: 2,
            queued: 2,
            duplicates: 0,
            skipped: 0,
            continued: true,
            capacityLimited: false,
        });

        expect(prisma.track.findMany).toHaveBeenCalledWith({
            where: {
                origin: "LOCAL",
                removedAt: null,
                analysisStatus: "completed",
                loudnessLufs: null,
            },
            orderBy: { id: "asc" },
            take: 3,
            select: {
                id: true,
                filePath: true,
                duration: true,
            },
        });
        expect(enqueueReservedWork).toHaveBeenNthCalledWith(
            1,
            schedulerQueue.client,
            {
                queueKey: "audio:analysis:queue",
                trackId: "track-0",
                payload: JSON.stringify({
                    trackId: "track-0",
                    filePath: "Artist/Track-0.flac",
                    duration: 180,
                    loudnessOnly: true,
                }),
                maxDepth: 100,
                reservationTtlSeconds: 3600,
            },
        );
        expect(schedulerQueue.add).toHaveBeenCalledWith(
            "track-loudness-backfill",
            {
                startAfterId: "track-1",
                sweepStartedAt: "2026-08-18T12:00:00.000Z",
            },
            {
                attempts: 3,
                backoff: { type: "exponential", delay: 5_000 },
                delay: 5_000,
                jobId: "scheduler:loudness-backfill:2026-08-18T12:00:00.000Z:track-1",
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
    });

    it("advances from a validated cursor", async () => {
        const { module, prisma } = loadProcessor([
            { id: "track-11", filePath: "Artist/11.flac", duration: 181 },
        ]);

        await module.processLoudnessBackfill(buildJob("track-10"));

        expect(prisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: { gt: "track-10" } }),
            }),
        );
    });

    it("stops on full admission and retries from the last admitted row", async () => {
        const tracks = [
            { id: "track-1", filePath: "Artist/1.flac", duration: 181 },
            { id: "track-2", filePath: "Artist/2.flac", duration: 182 },
            { id: "track-3", filePath: "Artist/3.flac", duration: 183 },
        ];
        const { module, schedulerQueue, enqueueReservedWork } = loadProcessor(
            tracks,
            ["queued", "full", "queued"],
        );

        await expect(
            module.processLoudnessBackfill(buildJob()),
        ).resolves.toEqual({
            processed: 1,
            queued: 1,
            duplicates: 0,
            skipped: 0,
            continued: true,
            capacityLimited: true,
        });

        expect(enqueueReservedWork).toHaveBeenCalledTimes(2);
        expect(schedulerQueue.add).toHaveBeenCalledWith(
            "track-loudness-backfill",
            {
                startAfterId: "track-1",
                sweepStartedAt: "2026-08-18T12:00:00.000Z",
            },
            {
                attempts: 3,
                backoff: { type: "exponential", delay: 5_000 },
                delay: 30_000,
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
    });

    it("does not self-requeue after a completed sweep", async () => {
        const { module, schedulerQueue } = loadProcessor([
            { id: "track-1", filePath: "Artist/1.flac", duration: 181 },
            { id: "track-2", filePath: null, duration: 182 },
        ]);

        await expect(
            module.processLoudnessBackfill(buildJob()),
        ).resolves.toEqual({
            processed: 2,
            queued: 1,
            duplicates: 0,
            skipped: 1,
            continued: false,
            capacityLimited: false,
        });
        expect(schedulerQueue.add).not.toHaveBeenCalled();
    });
});
