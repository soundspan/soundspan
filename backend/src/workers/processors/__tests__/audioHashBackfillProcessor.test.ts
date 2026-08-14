describe("audioHashBackfillProcessor", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadProcessor(
        tracks: Array<{ id: string; filePath: string }>,
        missingPaths: string[] = [],
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
                update: jest.fn(async () => ({})),
            },
        };
        const schedulerQueue = {
            add: jest.fn(async () => ({})),
        };
        const computeAudioStreamHash = jest.fn(async (filePath: string) => {
            const suffix = filePath.length.toString(16).padStart(2, "0");
            return `sha256:${suffix.repeat(32)}`;
        });
        const access = jest.fn(async (filePath: string) => {
            if (missingPaths.includes(filePath)) {
                const error = new Error(
                    "missing file",
                ) as NodeJS.ErrnoException;
                error.code = "ENOENT";
                throw error;
            }
        });

        jest.doMock("fs", () => ({ promises: { access } }));
        jest.doMock("../../../utils/logger", () => ({ logger }));
        jest.doMock("../../../utils/db", () => ({ prisma }));
        jest.doMock("../../../config", () => ({
            config: { music: { musicPath: "/music" } },
        }));
        jest.doMock("../../../services/audioHash", () => ({
            computeAudioStreamHash,
        }));
        jest.doMock("../../queues", () => ({ schedulerQueue }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../audioHashBackfillProcessor");
        return {
            module,
            logger,
            prisma,
            schedulerQueue,
            computeAudioStreamHash,
            access,
        };
    }

    function buildJob(startAfterId?: string) {
        return {
            id: "audio-hash-backfill-1",
            data: startAfterId ? { startAfterId } : {},
        } as any;
    }

    it("hashes one bounded batch, skips missing files, and enqueues the next cursor", async () => {
        const tracks = Array.from({ length: 51 }, (_, index) => ({
            id: `track-${index.toString().padStart(3, "0")}`,
            filePath: `Artist/Track-${index}.flac`,
        }));
        const missingPath = "/music/Artist/Track-10.flac";
        const {
            module,
            logger,
            prisma,
            schedulerQueue,
            computeAudioStreamHash,
        } = loadProcessor(tracks, [missingPath]);

        await expect(
            module.processAudioHashBackfill(buildJob()),
        ).resolves.toEqual({
            processed: 50,
            hashed: 49,
            skipped: 1,
            continued: true,
        });

        expect(logger.child).toHaveBeenCalledWith("AudioHashBackfillProcessor");
        expect(prisma.track.findMany).toHaveBeenCalledWith({
            where: { audioHash: null },
            orderBy: { id: "asc" },
            take: 51,
            select: { id: true, filePath: true },
        });
        expect(computeAudioStreamHash).toHaveBeenCalledTimes(49);
        expect(computeAudioStreamHash).not.toHaveBeenCalledWith(missingPath);
        expect(prisma.track.update).toHaveBeenCalledTimes(49);
        expect(prisma.track.update).toHaveBeenCalledWith({
            where: { id: "track-000" },
            data: {
                audioHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
                audioHashedAt: expect.any(Date),
            },
        });
        expect(schedulerQueue.add).toHaveBeenCalledWith(
            "track-audio-hash-backfill",
            { startAfterId: "track-049" },
            {
                attempts: 3,
                backoff: { type: "exponential", delay: 5_000 },
                jobId: "scheduler:audio-hash-backfill:track-049",
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
    });

    it("resumes after a persisted cursor and stops after the final page", async () => {
        const tracks = [
            { id: "track-051", filePath: "Artist/Track-51.flac" },
            { id: "track-052", filePath: "Artist/Track-52.flac" },
        ];
        const { module, prisma, schedulerQueue } = loadProcessor(tracks);

        await expect(
            module.processAudioHashBackfill(buildJob("track-050")),
        ).resolves.toEqual({
            processed: 2,
            hashed: 2,
            skipped: 0,
            continued: false,
        });

        expect(prisma.track.findMany).toHaveBeenCalledWith({
            where: { audioHash: null, id: { gt: "track-050" } },
            orderBy: { id: "asc" },
            take: 51,
            select: { id: true, filePath: true },
        });
        expect(schedulerQueue.add).not.toHaveBeenCalled();
    });
});
