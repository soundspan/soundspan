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
            fileModified?: Date;
            fileSize?: number;
        }>,
        admissions: Array<"queued" | "duplicate" | "full"> = [],
        batchSize = 25,
        failureCounts: Array<string | null> = [],
    ) {
        const storedTracks = tracks.map((track) => ({
            ...track,
            fileModified:
                track.fileModified ?? new Date("2026-08-18T10:00:00.000Z"),
            fileSize: track.fileSize ?? 4_096,
        }));
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
                findMany: jest.fn(async () => storedTracks),
            },
        };
        const schedulerQueue = {
            add: jest.fn(async () => ({})),
            client: {
                eval: jest.fn(async () => 1),
                get: jest.fn(async () => null),
                mget: jest.fn(async () => failureCounts),
                expire: jest.fn(async () => 1),
                set: jest.fn(async () => "OK"),
            },
        };
        const enqueueReservedWork = jest.fn(
            async (_client: unknown, _request: { payload: string }) =>
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
                fileModified: true,
                fileSize: true,
            },
        });
        expect(enqueueReservedWork).toHaveBeenNthCalledWith(
            1,
            schedulerQueue.client,
            {
                queueKey: "audio:analysis:queue",
                trackId: "track-0",
                payload: expect.any(String),
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

    it("cools down a transiently exhausted revision", async () => {
        const { module, logger, enqueueReservedWork } = loadProcessor(
            [
                {
                    id: "track-failed",
                    filePath: "Artist/failed.flac",
                    duration: 181,
                },
            ],
            [],
            25,
            ["3"],
        );

        await expect(
            module.processLoudnessBackfill(buildJob()),
        ).resolves.toEqual({
            processed: 1,
            queued: 0,
            duplicates: 0,
            skipped: 1,
            continued: false,
            capacityLimited: false,
        });

        expect(enqueueReservedWork).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("track-failed"),
        );
    });

    it("retries a transiently exhausted revision after its cooldown expires", async () => {
        const track = {
            id: "track-recovered",
            filePath: "Artist/recovered.flac",
            duration: 181,
        };
        const cooledDown = loadProcessor([track], [], 25, ["3"]);
        await cooledDown.module.processLoudnessBackfill(buildJob());
        expect(cooledDown.enqueueReservedWork).not.toHaveBeenCalled();

        jest.resetModules();
        const recovered = loadProcessor([track], [], 25, [null]);
        await recovered.module.processLoudnessBackfill(buildJob());
        expect(recovered.enqueueReservedWork).toHaveBeenCalledTimes(1);
    });

    it("keeps permanent content failures parked and refreshes their TTL", async () => {
        const { module, schedulerQueue, enqueueReservedWork } = loadProcessor(
            [
                {
                    id: "track-permanent",
                    filePath: "Artist/unsupported.flac",
                    duration: 181,
                },
            ],
            [],
            25,
            ["permanent"],
        );

        await module.processLoudnessBackfill(buildJob());

        expect(enqueueReservedWork).not.toHaveBeenCalled();
        expect(schedulerQueue.client.expire).toHaveBeenCalledWith(
            expect.stringMatching(/^audio:analysis:loudness:attempts:/),
            30 * 24 * 60 * 60,
        );
    });

    it("uses a new attempt key when the audio revision changes", async () => {
        const first = loadProcessor([
            {
                id: "track-revision",
                filePath: "Artist/revision.flac",
                duration: 181,
                fileModified: new Date("2026-08-18T10:00:00.000Z"),
            },
        ]);
        await first.module.processLoudnessBackfill(buildJob());
        const firstPayload = JSON.parse(
            first.enqueueReservedWork.mock.calls[0][1].payload,
        );

        jest.resetModules();
        const second = loadProcessor([
            {
                id: "track-revision",
                filePath: "Artist/revision.flac",
                duration: 181,
                fileModified: new Date("2026-08-19T10:00:00.000Z"),
            },
        ]);
        await second.module.processLoudnessBackfill(buildJob());
        const secondPayload = JSON.parse(
            second.enqueueReservedWork.mock.calls[0][1].payload,
        );

        expect(secondPayload.loudnessAttemptKey).not.toBe(
            firstPayload.loudnessAttemptKey,
        );
    });

    it("rejects corrupted attempt bookkeeping without enqueueing work", async () => {
        const { module, enqueueReservedWork } = loadProcessor(
            [
                {
                    id: "track-corrupt",
                    filePath: "Artist/corrupt.flac",
                    duration: 181,
                },
            ],
            [],
            25,
            ["3failures"],
        );

        await expect(
            module.processLoudnessBackfill(buildJob()),
        ).rejects.toThrow("Loudness backfill failure count is invalid");
        expect(enqueueReservedWork).not.toHaveBeenCalled();
    });

    it("turns each repeat tick into one jittered bounded sweep", async () => {
        jest.spyOn(Math, "random").mockReturnValue(0.5);
        const { module, prisma, schedulerQueue } = loadProcessor([]);

        await module.processLoudnessBackfill({
            id: "repeat:loudness:1",
            data: { mode: "repeat" },
        });

        expect(prisma.track.findMany).not.toHaveBeenCalled();
        expect(schedulerQueue.add).toHaveBeenCalledWith(
            "track-loudness-backfill",
            {
                mode: "periodic",
                sweepStartedAt: expect.any(String),
            },
            expect.objectContaining({
                delay: 7.5 * 60 * 1000,
                jobId: "scheduler:loudness-backfill:periodic:repeat:loudness:1",
            }),
        );
    });

    it("does not overlap a periodic sweep with an unfinished startup sweep", async () => {
        const { module, logger, prisma, schedulerQueue } = loadProcessor([]);
        schedulerQueue.client.eval.mockResolvedValueOnce(0);

        await expect(
            module.processLoudnessBackfill({
                id: "periodic-1",
                data: {
                    mode: "periodic",
                    sweepStartedAt: "2026-08-18T18:00:00.000Z",
                },
            }),
        ).resolves.toEqual({
            processed: 0,
            queued: 0,
            duplicates: 0,
            skipped: 0,
            continued: false,
            capacityLimited: false,
        });

        expect(prisma.track.findMany).not.toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(
            "Skipped overlapping loudness backfill sweep",
        );
    });
});
