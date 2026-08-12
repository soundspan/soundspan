describe("dependency readiness tracker behavior", () => {
    const originalEnv = process.env;

    afterEach(() => {
        jest.useRealTimers();
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

        let activePostgresOperations = 0;
        let activeRedisOperations = 0;
        let rejectPostgresOperation: ((error: Error) => void) | undefined;
        const postgresCancel = jest.fn(() => {
            rejectPostgresOperation?.(
                new Error("postgres transaction timed out"),
            );
        });
        const redisCancel = jest.fn();

        const queryRaw = jest.fn().mockImplementation(() => {
            if (options?.postgresHang) {
                activePostgresOperations += 1;
                return new Promise((_resolve, reject) => {
                    rejectPostgresOperation = (error: Error) => {
                        activePostgresOperations -= 1;
                        reject(error);
                    };
                });
            }
            if (state.postgresReject) {
                return Promise.reject(new Error(state.postgresReject));
            }
            return Promise.resolve(1);
        });
        const transaction = jest
            .fn()
            .mockImplementation(
                async (
                    operation:
                        | Array<Promise<unknown>>
                        | ((client: {
                              $queryRaw: typeof queryRaw;
                          }) => Promise<unknown>),
                    deadline: { timeout: number },
                ) => {
                    const operationPromise = Array.isArray(operation)
                        ? Promise.all(operation)
                        : operation({ $queryRaw: queryRaw });
                    if (!options?.postgresHang) {
                        return await operationPromise;
                    }

                    const timeoutId = setTimeout(
                        postgresCancel,
                        deadline.timeout,
                    );
                    try {
                        return await operationPromise;
                    } finally {
                        clearTimeout(timeoutId);
                    }
                },
            );
        const ping = jest.fn().mockImplementation((signal?: AbortSignal) => {
            if (options?.redisHang) {
                activeRedisOperations += 1;
                return new Promise((_resolve, reject) => {
                    signal?.addEventListener(
                        "abort",
                        () => {
                            redisCancel();
                            activeRedisOperations -= 1;
                            reject(signal.reason);
                        },
                        { once: true },
                    );
                });
            }
            if (state.redisReject) {
                return Promise.reject(new Error(state.redisReject));
            }
            return Promise.resolve("PONG");
        });
        const withCommandOptions = jest.fn(
            ({ abortSignal }: { abortSignal: AbortSignal }) => ({
                ping: () => ping(abortSignal),
            }),
        );

        const redisClient = {
            get isReady() {
                return state.redisReady;
            },
            ping,
            withCommandOptions,
        };

        const logger = {
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
            child: jest.fn(),
        };
        logger.child.mockReturnValue(logger);

        jest.doMock("../db", () => ({
            prisma: {
                $queryRaw: queryRaw,
                $transaction: transaction,
            },
        }));
        jest.doMock("../redis", () => ({ redisClient }));
        jest.doMock("../logger", () => ({ logger }));
        const parsePositiveInt = (value: string, fallback: number): number => {
            const parsed = Number.parseInt(value, 10);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
        };
        jest.doMock("../../config", () => ({
            config: {
                readiness: {
                    dependencyCheckIntervalMs: parsePositiveInt(
                        process.env.READINESS_DEPENDENCY_CHECK_INTERVAL_MS ||
                            "5000",
                        5000,
                    ),
                    dependencyCheckTimeoutMs: parsePositiveInt(
                        process.env.READINESS_DEPENDENCY_CHECK_TIMEOUT_MS ||
                            "2000",
                        2000,
                    ),
                    requireDependencies:
                        process.env.READINESS_REQUIRE_DEPENDENCIES !== "false",
                },
            },
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {
            createDependencyReadinessTracker,
        } = require("../dependencyReadiness");
        const tracker = createDependencyReadinessTracker("test");
        return {
            tracker,
            queryRaw,
            transaction,
            ping,
            withCommandOptions,
            logger,
            postgresCancel,
            redisCancel,
            getActiveOperations() {
                return {
                    postgres: activePostgresOperations,
                    redis: activeRedisOperations,
                };
            },
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

    it("cancels and awaits timed-out dependency work before completing the probe", async () => {
        jest.useFakeTimers();
        const {
            tracker,
            transaction,
            withCommandOptions,
            postgresCancel,
            redisCancel,
            getActiveOperations,
        } = loadTracker({
            required: true,
            postgresHang: true,
            redisHang: true,
            timeoutMs: "10",
        });

        const probePromise = tracker.probe(true);
        await jest.advanceTimersByTimeAsync(10);
        const snapshot = await probePromise;

        expect(snapshot.overallHealthy).toBe(false);
        expect(transaction).toHaveBeenCalledWith(expect.any(Array), {
            maxWait: expect.any(Number),
            timeout: expect.any(Number),
        });
        expect(withCommandOptions).toHaveBeenCalledWith({
            abortSignal: expect.any(AbortSignal),
        });
        expect(postgresCancel).toHaveBeenCalledTimes(1);
        expect(redisCancel).toHaveBeenCalledTimes(1);
        expect(getActiveOperations()).toEqual({ postgres: 0, redis: 0 });
    });

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
            expect.stringContaining("Dependencies unhealthy"),
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
