describe("discoverProcessor", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadDiscoverProcessor(options?: {
        claimResult?: "OK" | null;
        retryClaim?: boolean;
        mode?: "legacy" | "strict";
        generateError?: string;
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

        const lockClient = {
            set: jest.fn(async () => resolvedClaimResult),
            eval: jest.fn(async () => 1),
            quit: jest.fn(async () => "OK"),
            disconnect: jest.fn(),
        };
        if (options?.retryClaim) {
            lockClient.set
                .mockRejectedValueOnce(new Error("Connection is closed"))
                .mockResolvedValueOnce("OK");
        }

        const replacementLockClient = {
            set: jest.fn(async () => "OK"),
            eval: jest.fn(async () => 1),
            quit: jest.fn(async () => "OK"),
            disconnect: jest.fn(),
        };

        const clients = [lockClient, replacementLockClient];
        const createIORedisClient = jest.fn(() => clients.shift() || lockClient);

        const discoverWeeklyService = {
            generatePlaylist: jest.fn(async () => ({
                success: true,
                playlistName: "Discover Legacy",
                songCount: 10,
                batchId: "b1",
            })),
        };
        const discoveryRecommendationsService = {
            generatePlaylist: jest.fn(async () => ({
                success: true,
                playlistName: "Discover Strict",
                songCount: 20,
                batchId: "b2",
            })),
        };

        if (options?.generateError) {
            discoveryRecommendationsService.generatePlaylist.mockRejectedValueOnce(
                new Error(options.generateError)
            );
        }

        jest.doMock("crypto", () => ({
            randomUUID: () => "node-1",
        }));
        jest.doMock("../../../utils/logger", () => ({ logger }));
        jest.doMock("../../../services/discoverWeekly", () => ({
            discoverWeeklyService,
        }));
        jest.doMock("../../../services/discovery", () => ({
            discoveryRecommendationsService,
        }));
        jest.doMock("../../../config", () => ({
            config: { discover: { mode: options?.mode ?? "strict" } },
        }));
        jest.doMock("../../../utils/ioredis", () => ({ createIORedisClient }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const module = require("../discoverProcessor");
        return {
            module,
            logger,
            lockClient,
            replacementLockClient,
            createIORedisClient,
            discoverWeeklyService,
            discoveryRecommendationsService,
        };
    }

    function buildJob() {
        return {
            id: "job-1",
            data: { userId: "u1" },
            progress: jest.fn(async () => undefined),
        } as any;
    }

    it("returns skipped result when claim is already held", async () => {
        const { module, discoveryRecommendationsService } = loadDiscoverProcessor({
            claimResult: null,
        });
        const job = buildJob();

        await expect(module.processDiscoverWeekly(job)).resolves.toEqual({
            success: true,
            skipped: true,
            playlistName: "",
            songCount: 0,
        });

        expect(discoveryRecommendationsService.generatePlaylist).not.toHaveBeenCalled();
    });

    it("processes strict-mode generation and releases lock", async () => {
        const { module, lockClient, discoveryRecommendationsService } =
            loadDiscoverProcessor({ mode: "strict" });
        const job = buildJob();

        const result = await module.processDiscoverWeekly(job);
        expect(result).toEqual({
            success: true,
            playlistName: "Discover Strict",
            songCount: 20,
            batchId: "b2",
        });
        expect(discoveryRecommendationsService.generatePlaylist).toHaveBeenCalledWith(
            "u1"
        );
        expect(lockClient.eval).toHaveBeenCalled();
    });

    it("retries claim on redis closure and uses legacy mode when configured", async () => {
        const {
            module,
            logger,
            createIORedisClient,
            replacementLockClient,
            discoverWeeklyService,
        } = loadDiscoverProcessor({
            retryClaim: true,
            mode: "legacy",
        });
        const job = buildJob();

        await expect(module.processDiscoverWeekly(job)).resolves.toEqual(
            expect.objectContaining({
                success: true,
                playlistName: "Discover Legacy",
                songCount: 10,
            })
        );

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("failed due to Redis connection closure"),
            expect.any(Error)
        );
        expect(createIORedisClient).toHaveBeenCalledTimes(2);
        expect(replacementLockClient.set).toHaveBeenCalled();
        expect(discoverWeeklyService.generatePlaylist).toHaveBeenCalledWith("u1");
    });

    it("returns error payload on generation failure and supports shutdown fallback", async () => {
        const { module, lockClient, logger } = loadDiscoverProcessor({
            generateError: "generation-boom",
        });
        const job = buildJob();

        await expect(module.processDiscoverWeekly(job)).resolves.toEqual(
            expect.objectContaining({
                success: false,
                error: "generation-boom",
            })
        );

        lockClient.quit.mockRejectedValueOnce(new Error("quit-failed"));
        await module.shutdownDiscoverProcessor();
        expect(logger.warn).toHaveBeenCalledWith(
            "[DiscoverProcessor] Failed to gracefully close lock Redis client; disconnecting forcefully",
            expect.any(Error)
        );
        expect(lockClient.disconnect).toHaveBeenCalled();
    });

    it("logs a warning when processor claim release fails", async () => {
        const { module, lockClient, logger } = loadDiscoverProcessor({
            mode: "strict",
        });
        lockClient.eval.mockRejectedValueOnce(new Error("release-failed"));

        const result = await module.processDiscoverWeekly(buildJob());
        expect(result).toEqual(
            expect.objectContaining({
                success: true,
                playlistName: "Discover Strict",
            })
        );
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                "Failed to release processor claim for user u1"
            ),
            expect.any(Error)
        );
    });
});
