describe("moodBucketWorker", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.useRealTimers();
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadMoodBucketWorker(options?: {
        claimResult?: "OK" | null;
        retryClaim?: boolean;
        tracks?: Array<{ id: string; title: string }>;
    }) {
        process.env = { ...originalEnv };

        const logger = {
            debug: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };

        const resolvedClaimResult =
            options && Object.prototype.hasOwnProperty.call(options, "claimResult")
                ? options.claimResult
                : "OK";

        const claimClient = {
            set: jest.fn(async () => resolvedClaimResult),
            eval: jest.fn(async () => 1),
            disconnect: jest.fn(),
        };

        if (options?.retryClaim) {
            claimClient.set
                .mockRejectedValueOnce(new Error("Connection is closed"))
                .mockResolvedValueOnce("OK");
        }

        const replacementClaimClient = {
            set: jest.fn(async () => "OK"),
            eval: jest.fn(async () => 1),
            disconnect: jest.fn(),
        };

        const clients = [claimClient, replacementClaimClient];
        const createIORedisClient = jest.fn(() => clients.shift() || claimClient);

        const prisma = {
            $queryRaw: jest.fn(async () => options?.tracks ?? []),
        };
        const moodBucketService = {
            assignTrackToMoods: jest.fn(async () => ["chill"]),
        };

        jest.doMock("../../utils/logger", () => ({ logger }));
        jest.doMock("../../utils/ioredis", () => ({ createIORedisClient }));
        jest.doMock("../../utils/db", () => ({ prisma }));
        jest.doMock("../../services/moodBucketService", () => ({
            moodBucketService,
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../moodBucketWorker");
        return {
            module,
            logger,
            claimClient,
            replacementClaimClient,
            createIORedisClient,
            prisma,
            moodBucketService,
        };
    }

    it("claims and processes tracks, then releases lock and can stop cleanly", async () => {
        jest.useFakeTimers();
        const { module, claimClient, prisma, moodBucketService } =
            loadMoodBucketWorker({
                claimResult: "OK",
                tracks: [{ id: "t1", title: "Track 1" }],
            });

        await module.startMoodBucketWorker();
        module.stopMoodBucketWorker();

        expect(claimClient.set).toHaveBeenCalled();
        expect(prisma.$queryRaw).toHaveBeenCalled();
        expect(moodBucketService.assignTrackToMoods).toHaveBeenCalledWith("t1");
        expect(claimClient.eval).toHaveBeenCalled();
        expect(claimClient.disconnect).toHaveBeenCalled();
    });

    it("runs claimed processing again on interval ticks", async () => {
        jest.useFakeTimers();
        const { module, claimClient } = loadMoodBucketWorker({
            claimResult: "OK",
            tracks: [],
        });

        await module.startMoodBucketWorker();
        await jest.advanceTimersByTimeAsync(30_000);
        module.stopMoodBucketWorker();

        expect(claimClient.set).toHaveBeenCalledTimes(2);
    });

    it("skips processing when claim is held elsewhere", async () => {
        const { module, prisma, moodBucketService } = loadMoodBucketWorker({
            claimResult: null,
        });

        await module.startMoodBucketWorker();
        module.stopMoodBucketWorker();

        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(moodBucketService.assignTrackToMoods).not.toHaveBeenCalled();
    });

    it("retries claim acquisition on transient redis closure", async () => {
        const { module, logger, createIORedisClient, replacementClaimClient } =
            loadMoodBucketWorker({
                retryClaim: true,
                tracks: [],
            });

        await module.startMoodBucketWorker();
        module.stopMoodBucketWorker();

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("failed due to Redis connection closure"),
            expect.any(Error)
        );
        expect(createIORedisClient).toHaveBeenCalledTimes(2);
        expect(replacementClaimClient.set).toHaveBeenCalled();
    });

    it("logs and skips when claim acquisition fails with non-retryable error", async () => {
        const { module, claimClient, logger, prisma } = loadMoodBucketWorker({
            tracks: [{ id: "t1", title: "Track 1" }],
        });
        claimClient.set.mockRejectedValueOnce(new Error("permission denied"));

        await module.startMoodBucketWorker();
        module.stopMoodBucketWorker();

        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining("Failed to claim startup mood-bucket cycle"),
            expect.any(Error)
        );
    });

    it("warns when claim release fails after processing", async () => {
        const { module, claimClient, logger, prisma } = loadMoodBucketWorker({
            tracks: [{ id: "t1", title: "Track 1" }],
        });
        claimClient.eval.mockRejectedValueOnce(new Error("release failed"));

        await module.startMoodBucketWorker();
        module.stopMoodBucketWorker();

        expect(prisma.$queryRaw).toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                "Failed to release cycle claim for startup mood-bucket cycle"
            ),
            expect.any(Error)
        );
    });

    it("continues processing remaining tracks when one mood assignment fails", async () => {
        const { module, moodBucketService, logger } = loadMoodBucketWorker({
            tracks: [
                { id: "t1", title: "Track 1" },
                { id: "t2", title: "Track 2" },
            ],
        });
        moodBucketService.assignTrackToMoods
            .mockRejectedValueOnce(new Error("assign failed"))
            .mockResolvedValueOnce(["calm"]);

        await module.startMoodBucketWorker();
        module.stopMoodBucketWorker();

        expect(moodBucketService.assignTrackToMoods).toHaveBeenCalledTimes(2);
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining("✗ Track 1: assign failed")
        );
        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("Assigned 1/2 tracks")
        );
    });

    it("logs worker-level query failures without crashing startup", async () => {
        const { module, prisma, logger } = loadMoodBucketWorker();
        prisma.$queryRaw.mockRejectedValueOnce(new Error("query failed"));

        await expect(module.startMoodBucketWorker()).resolves.toBeUndefined();
        module.stopMoodBucketWorker();

        expect(logger.error).toHaveBeenCalledWith(
            "[Mood Bucket] Worker error:",
            expect.any(Error)
        );
    });
});
