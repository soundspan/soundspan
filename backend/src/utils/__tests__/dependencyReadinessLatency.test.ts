describe("dependency readiness tracker latency", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadTracker(options?: {
        postgresReject?: string;
        redisReject?: string;
        redisReady?: boolean;
    }) {
        process.env = {
            ...originalEnv,
            READINESS_REQUIRE_DEPENDENCIES: "true",
            READINESS_DEPENDENCY_CHECK_INTERVAL_MS: "60000",
            READINESS_DEPENDENCY_CHECK_TIMEOUT_MS: "1000",
        };

        const state = {
            postgresReject: options?.postgresReject,
            redisReject: options?.redisReject,
            redisReady: options?.redisReady ?? true,
        };

        const queryRaw = jest.fn().mockImplementation(() => {
            if (state.postgresReject) {
                return Promise.reject(new Error(state.postgresReject));
            }
            return Promise.resolve(1);
        });

        const ping = jest.fn().mockImplementation(() => {
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
        return createDependencyReadinessTracker("latency-test");
    }

    it("records per-dependency probe latency when dependencies are healthy", async () => {
        const tracker = loadTracker();

        const snapshot = await tracker.probe(true);

        expect(snapshot.postgres.ok).toBe(true);
        expect(snapshot.redis.ok).toBe(true);
        expect(typeof snapshot.postgres.latencyMs).toBe("number");
        expect(snapshot.postgres.latencyMs).toBeGreaterThanOrEqual(0);
        expect(typeof snapshot.redis.latencyMs).toBe("number");
        expect(snapshot.redis.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("sets latency to null when dependency probes fail", async () => {
        const tracker = loadTracker({
            postgresReject: "postgres-down",
            redisReject: "redis-down",
        });

        const snapshot = await tracker.probe(true);

        expect(snapshot.postgres.ok).toBe(false);
        expect(snapshot.redis.ok).toBe(false);
        expect(snapshot.postgres.latencyMs).toBeNull();
        expect(snapshot.redis.latencyMs).toBeNull();
    });
});
