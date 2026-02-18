describe("enrichmentStateService", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    function createStateClient() {
        let stored: string | null = null;
        return {
            get: jest.fn(async () => stored),
            set: jest.fn(async (_key: string, value: string) => {
                stored = value;
                return "OK";
            }),
            del: jest.fn(async () => {
                stored = null;
                return 1;
            }),
            disconnect: jest.fn(),
            quit: jest.fn(async () => "OK"),
            __setRaw(raw: string | null) {
                stored = raw;
            },
        };
    }

    function createPublisherClient() {
        return {
            publish: jest.fn(async () => 1),
            disconnect: jest.fn(),
            quit: jest.fn(async () => "OK"),
        };
    }

    function loadService(options?: {
        stateClient?: ReturnType<typeof createStateClient>;
        publisherClient?: ReturnType<typeof createPublisherClient>;
        extraClients?: Array<Record<string, unknown>>;
    }) {
        process.env = { ...originalEnv };

        const stateClient = options?.stateClient ?? createStateClient();
        const publisherClient =
            options?.publisherClient ?? createPublisherClient();
        const extraClients = options?.extraClients ?? [];

        const clients = [stateClient, publisherClient, ...extraClients];
        const createIORedisClient = jest.fn(() => {
            if (clients.length > 0) {
                return clients.shift();
            }
            return createPublisherClient();
        });

        const logger = {
            debug: jest.fn(),
            warn: jest.fn(),
        };

        jest.doMock("../../utils/ioredis", () => ({
            createIORedisClient,
        }));
        jest.doMock("../../utils/logger", () => ({
            logger,
        }));
        jest.doMock("ioredis", () => ({
            __esModule: true,
            default: jest.fn(),
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { enrichmentStateService } = require("../enrichmentState");

        return {
            enrichmentStateService,
            stateClient,
            publisherClient,
            logger,
            createIORedisClient,
        };
    }

    it("initializes, pauses, resumes, stops, and clears enrichment state", async () => {
        const { enrichmentStateService, stateClient, publisherClient } =
            loadService();

        const initialized = await enrichmentStateService.initializeState();
        expect(initialized.status).toBe("running");

        const paused = await enrichmentStateService.pause();
        expect(paused.status).toBe("paused");

        const resumed = await enrichmentStateService.resume();
        expect(resumed.status).toBe("running");

        const stopped = await enrichmentStateService.stop();
        expect(stopped.status).toBe("stopping");

        await enrichmentStateService.clear();
        await expect(enrichmentStateService.getState()).resolves.toBeNull();

        expect(stateClient.set).toHaveBeenCalled();
        expect(stateClient.del).toHaveBeenCalledWith("enrichment:state");
        expect(publisherClient.publish).toHaveBeenCalledWith(
            "enrichment:control",
            "pause"
        );
        expect(publisherClient.publish).toHaveBeenCalledWith(
            "audio:analysis:control",
            "pause"
        );
        expect(publisherClient.publish).toHaveBeenCalledWith(
            "enrichment:control",
            "resume"
        );
        expect(publisherClient.publish).toHaveBeenCalledWith(
            "enrichment:control",
            "stop"
        );
    });

    it("retries publisher operations after connection-closed errors", async () => {
        const stateClient = createStateClient();
        const failingPublisher = createPublisherClient();
        failingPublisher.publish.mockRejectedValueOnce(
            new Error("Connection is closed.")
        );

        const replacementPublisher = createPublisherClient();

        const { enrichmentStateService, logger, createIORedisClient } = loadService({
            stateClient,
            publisherClient: failingPublisher,
            extraClients: [replacementPublisher],
        });

        await enrichmentStateService.initializeState();
        await expect(enrichmentStateService.pause()).resolves.toEqual(
            expect.objectContaining({ status: "paused" })
        );

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("pause publish failed due to Redis connection closure"),
            expect.any(Error)
        );
        // state + publisher + recreated publisher
        expect(createIORedisClient).toHaveBeenCalledTimes(3);
        expect(replacementPublisher.publish).toHaveBeenCalledWith(
            "enrichment:control",
            "pause"
        );
    });

    it("retries state reads after connection-closed errors and recreates state client", async () => {
        const failingState = createStateClient();
        failingState.get.mockRejectedValueOnce(new Error("Connection is closed."));
        failingState.disconnect.mockImplementationOnce(() => {
            throw new Error("disconnect failed");
        });

        const replacementState = createStateClient();
        replacementState.__setRaw(
            JSON.stringify({
                status: "running",
                currentPhase: "artists",
                lastActivity: new Date().toISOString(),
                artists: { total: 1, completed: 0, failed: 0 },
                tracks: { total: 1, completed: 0, failed: 0 },
                audio: { total: 1, completed: 0, failed: 0, processing: 0 },
            })
        );
        const publisher = createPublisherClient();

        const { enrichmentStateService, logger, createIORedisClient } = loadService({
            stateClient: failingState,
            publisherClient: publisher,
            extraClients: [replacementState],
        });

        await expect(enrichmentStateService.getState()).resolves.toEqual(
            expect.objectContaining({ status: "running" })
        );
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                "getState failed due to Redis connection closure"
            ),
            expect.any(Error)
        );
        expect(createIORedisClient).toHaveBeenCalledTimes(3);
        expect(replacementState.get).toHaveBeenCalledTimes(1);
    });

    it("does not retry non-retryable state errors", async () => {
        const failingState = createStateClient();
        failingState.get.mockRejectedValueOnce(new Error("permission denied"));
        const publisher = createPublisherClient();
        const { enrichmentStateService, logger, createIORedisClient } = loadService({
            stateClient: failingState,
            publisherClient: publisher,
        });

        await expect(enrichmentStateService.getState()).rejects.toThrow(
            "permission denied"
        );
        expect(logger.warn).not.toHaveBeenCalled();
        expect(createIORedisClient).toHaveBeenCalledTimes(2);
    });

    it("does not retry non-retryable publisher errors", async () => {
        const stateClient = createStateClient();
        const failingPublisher = createPublisherClient();
        failingPublisher.publish.mockRejectedValueOnce(
            new Error("publisher forbidden")
        );

        const { enrichmentStateService, logger, createIORedisClient } = loadService({
            stateClient,
            publisherClient: failingPublisher,
        });

        await enrichmentStateService.initializeState();
        await expect(enrichmentStateService.pause()).rejects.toThrow(
            "publisher forbidden"
        );
        expect(logger.warn).not.toHaveBeenCalled();
        expect(createIORedisClient).toHaveBeenCalledTimes(2);
    });

    it("detects hangs and disconnects clients cleanly", async () => {
        const { enrichmentStateService, stateClient, publisherClient } =
            loadService();
        const stale = new Date(Date.now() - 16 * 60 * 1000).toISOString();

        stateClient.__setRaw(
            JSON.stringify({
                status: "running",
                currentPhase: "artists",
                lastActivity: stale,
                artists: { total: 1, completed: 0, failed: 0 },
                tracks: { total: 1, completed: 0, failed: 0 },
                audio: { total: 1, completed: 0, failed: 0, processing: 0 },
            })
        );

        await expect(enrichmentStateService.isRunning()).resolves.toBe(true);
        await expect(enrichmentStateService.isPaused()).resolves.toBe(false);
        await expect(enrichmentStateService.detectHang()).resolves.toBe(true);

        await enrichmentStateService.disconnect();
        expect(stateClient.quit).toHaveBeenCalledTimes(1);
        expect(publisherClient.quit).toHaveBeenCalledTimes(1);
    });

    it("rejects resume when state is not paused or running", async () => {
        const { enrichmentStateService, stateClient } = loadService();
        stateClient.__setRaw(
            JSON.stringify({
                status: "stopping",
                currentPhase: "artists",
                lastActivity: new Date().toISOString(),
                artists: { total: 1, completed: 0, failed: 0 },
                tracks: { total: 1, completed: 0, failed: 0 },
                audio: { total: 1, completed: 0, failed: 0, processing: 0 },
            })
        );

        await expect(enrichmentStateService.resume()).rejects.toThrow(
            "Cannot resume enrichment in stopping state"
        );
    });

    it("returns false from hang detection when state is missing or not running", async () => {
        const { enrichmentStateService, stateClient } = loadService();
        stateClient.__setRaw(null);
        await expect(enrichmentStateService.detectHang()).resolves.toBe(false);

        stateClient.__setRaw(
            JSON.stringify({
                status: "paused",
                currentPhase: "artists",
                lastActivity: new Date().toISOString(),
                artists: { total: 1, completed: 0, failed: 0 },
                tracks: { total: 1, completed: 0, failed: 0 },
                audio: { total: 1, completed: 0, failed: 0, processing: 0 },
            })
        );
        await expect(enrichmentStateService.detectHang()).resolves.toBe(false);
    });
});
