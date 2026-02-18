describe("dependency readiness tracker behavior", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadTracker(options?: {
        required?: boolean;
        redisReady?: boolean;
        postgresReject?: string;
        redisReject?: string;
        postgresHang?: boolean;
        redisHang?: boolean;
        intervalMs?: string;
        timeoutMs?: string;
    }) {
        process.env = { ...originalEnv };
        if (options?.required === false) {
            process.env.READINESS_REQUIRE_DEPENDENCIES = "false";
        } else {
            process.env.READINESS_REQUIRE_DEPENDENCIES = "true";
        }
        process.env.READINESS_DEPENDENCY_CHECK_INTERVAL_MS =
            options?.intervalMs ?? "60000";
        process.env.READINESS_DEPENDENCY_CHECK_TIMEOUT_MS =
            options?.timeoutMs ?? "1000";

        const state = {
            redisReady: options?.redisReady ?? true,
            postgresReject: options?.postgresReject,
            redisReject: options?.redisReject,
        };

        const queryRaw = jest.fn().mockImplementation(() => {
            if (options?.postgresHang) {
                return new Promise(() => undefined);
            }
            if (state.postgresReject) {
                return Promise.reject(new Error(state.postgresReject));
            }
            return Promise.resolve(1);
        });
        const ping = jest.fn().mockImplementation(() => {
            if (options?.redisHang) {
                return new Promise(() => undefined);
            }
            if (state.redisReject) {
                return Promise.reject(new Error(state.redisReject));
            }
            return Promise.resolve("PONG");
        });

        const redisClient = {
            get isReady() {
                return state.redisReady;
            },
            ping,
        };

        const logger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        };

        jest.doMock("../db", () => ({
            prisma: {
                $queryRaw: queryRaw,
            },
        }));
        jest.doMock("../redis", () => ({ redisClient }));
        jest.doMock("../logger", () => ({ logger }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { createDependencyReadinessTracker } = require("../dependencyReadiness");
        const tracker = createDependencyReadinessTracker("test");
        return {
            tracker,
            queryRaw,
            ping,
            logger,
            setRedisReady(value: boolean) {
                state.redisReady = value;
            },
            setPostgresReject(value: string | undefined) {
                state.postgresReject = value;
            },
            setRedisReject(value: string | undefined) {
                state.redisReject = value;
            },
        };
    }

    it("reports healthy without probing dependencies when dependency checks are disabled", async () => {
        const { tracker, queryRaw, ping } = loadTracker({ required: false });

        const snapshot = await tracker.probe();

        expect(snapshot.required).toBe(false);
        expect(snapshot.overallHealthy).toBe(true);
        expect(snapshot.postgres.ok).toBe(true);
        expect(snapshot.redis.ok).toBe(true);
        expect(queryRaw).not.toHaveBeenCalled();
        expect(ping).not.toHaveBeenCalled();
    });

    it("reports unhealthy when redis client is not ready", async () => {
        const { tracker, queryRaw, ping } = loadTracker({
            required: true,
            redisReady: false,
        });

        const snapshot = await tracker.probe(true);

        expect(snapshot.required).toBe(true);
        expect(snapshot.overallHealthy).toBe(false);
        expect(snapshot.postgres.ok).toBe(true);
        expect(snapshot.redis.ok).toBe(false);
        expect(snapshot.redis.error).toContain("not ready");
        expect(queryRaw).toHaveBeenCalledTimes(1);
        expect(ping).not.toHaveBeenCalled();
    });

    it("reuses cached probe result within interval unless forced", async () => {
        const { tracker, queryRaw, ping } = loadTracker({
            required: true,
            redisReady: true,
            intervalMs: "300000",
        });

        await tracker.probe();
        await tracker.probe();
        expect(queryRaw).toHaveBeenCalledTimes(1);
        expect(ping).toHaveBeenCalledTimes(1);

        await tracker.probe(true);
        expect(queryRaw).toHaveBeenCalledTimes(2);
        expect(ping).toHaveBeenCalledTimes(2);
    });

    it("logs a recovery message when dependencies transition from unhealthy to healthy", async () => {
        const { tracker, logger, setRedisReject, setRedisReady } = loadTracker({
            required: true,
            redisReject: "redis-down",
            intervalMs: "1",
        });

        const first = await tracker.probe(true);
        expect(first.overallHealthy).toBe(false);

        setRedisReject(undefined);
        setRedisReady(true);
        const recovered = await tracker.probe(true);
        expect(recovered.overallHealthy).toBe(true);
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining("Dependencies recovered"),
        );
    });

    it("logs an unhealthy warning when dependencies regress from healthy to unhealthy", async () => {
        const { tracker, logger, setRedisReject } = loadTracker({
            required: true,
            intervalMs: "1",
        });

        const healthy = await tracker.probe(true);
        expect(healthy.overallHealthy).toBe(true);
        expect(tracker.isHealthy()).toBe(true);

        setRedisReject("redis-down");
        const degraded = await tracker.probe(true);
        expect(degraded.overallHealthy).toBe(false);
        expect(tracker.isHealthy()).toBe(false);
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Dependencies unhealthy")
        );
    });

    it("deduplicates concurrent probes by returning the in-flight promise", async () => {
        const { tracker, queryRaw, ping } = loadTracker({
            required: true,
            intervalMs: "1",
            postgresHang: true,
            timeoutMs: "5",
        });

        const firstPromise = tracker.probe(true);
        const secondPromise = tracker.probe(true);

        const [firstSnapshot, secondSnapshot] = await Promise.all([
            firstPromise,
            secondPromise,
        ]);
        expect(secondSnapshot).toEqual(firstSnapshot);
        const snapshot = firstSnapshot;
        expect(snapshot.overallHealthy).toBe(false);
        expect(snapshot.postgres.error).toContain("timed out");
        expect(queryRaw).toHaveBeenCalledTimes(1);
        expect(ping).toHaveBeenCalledTimes(1);
    });
});
