describe("workers/queues", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadQueues(redisUrl: string) {
        process.env = { ...originalEnv };

        const bullCtor = jest.fn().mockImplementation((name: string, options: unknown) => ({
            name,
            options,
            on: jest.fn(),
        }));

        const logger = {
            debug: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };

        jest.doMock("bull", () => ({
            __esModule: true,
            default: bullCtor,
        }));
        jest.doMock("../../config", () => ({
            config: {
                redisUrl,
            },
        }));
        jest.doMock("../../utils/logger", () => ({
            logger,
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const queuesModule = require("../queues");

        return { queuesModule, bullCtor, logger };
    }

    it("parses rediss URL into Bull redis config including TLS", () => {
        const { bullCtor, queuesModule, logger } = loadQueues(
            "rediss://user:pass@cache.example:6381/2"
        );

        expect(bullCtor).toHaveBeenCalledTimes(6);
        const firstCallArgs = bullCtor.mock.calls[0];
        const firstQueueOptions = firstCallArgs[1];

        expect(firstCallArgs[0]).toBe("library-scan");
        expect(firstQueueOptions.redis).toEqual(
            expect.objectContaining({
                host: "cache.example",
                port: 6381,
                username: "user",
                password: "pass",
                db: 2,
                tls: {},
            })
        );
        expect(queuesModule.queues).toHaveLength(6);
        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("Redis config resolved")
        );
    });

    it("falls back to localhost redis config when REDIS_URL is invalid", () => {
        const { bullCtor, logger } = loadQueues("://invalid");
        const firstQueueOptions = bullCtor.mock.calls[0][1];

        expect(firstQueueOptions.redis).toEqual({
            host: "127.0.0.1",
            port: 6379,
        });
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Failed to parse REDIS_URL")
        );
    });

    it("bounds the library-scan queue's completed/failed Redis retention", () => {
        const { bullCtor } = loadQueues("redis://cache.example:6379/0");

        const scanCall = bullCtor.mock.calls.find(
            (call: any[]) => call[0] === "library-scan"
        );
        expect(scanCall).toBeDefined();
        // Most scanQueue.add() sites enqueue without per-job retention options,
        // so without this default Redis accumulates completed/failed scan
        // records unbounded (F24). The queue must cap them: last 100 completed
        // (enough for the recent-job status lookup) and 200 failed.
        expect(scanCall![1].defaultJobOptions).toEqual({
            removeOnComplete: 100,
            removeOnFail: 200,
        });
    });

    it("wires queue error and stalled handlers for observability", () => {
        const { bullCtor, logger } = loadQueues("redis://cache.example:6379/0");

        const firstQueueInstance = bullCtor.mock.results[0].value;
        const errorHandler = firstQueueInstance.on.mock.calls.find(
            (call: any[]) => call[0] === "error"
        )?.[1];
        const stalledHandler = firstQueueInstance.on.mock.calls.find(
            (call: any[]) => call[0] === "stalled"
        )?.[1];

        const err = new Error("queue exploded");
        errorHandler(err);
        stalledHandler({ id: "job-1", data: { payload: true } });

        expect(logger.error).toHaveBeenCalledWith(
            "Bull queue error (library-scan):",
            {
                message: "queue exploded",
                stack: expect.any(String),
            }
        );
        expect(logger.warn).toHaveBeenCalledWith(
            "Bull job stalled (library-scan):",
            {
                jobId: "job-1",
                data: { payload: true },
            }
        );
        expect(logger.debug).toHaveBeenCalledWith(
            "Bull queues initialized with stability settings"
        );
    });
});
