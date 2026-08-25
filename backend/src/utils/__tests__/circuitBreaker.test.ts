import {
    ConsecutiveFailureCircuitBreaker,
    RedisCircuitBreakerStore,
} from "../circuitBreaker";

describe("ConsecutiveFailureCircuitBreaker", () => {
    it("opens after the failure threshold and permits one cooldown probe", async () => {
        let now = 1_000;
        const breaker = new ConsecutiveFailureCircuitBreaker({
            failureThreshold: 3,
            cooldownMs: 5_000,
            now: () => now,
        });

        await expect(breaker.tryAcquire()).resolves.toBe(true);
        await breaker.recordFailure();
        await breaker.recordFailure();
        await expect(breaker.tryAcquire()).resolves.toBe(true);
        await breaker.recordFailure();
        await expect(breaker.snapshot()).resolves.toEqual({
            state: "open",
            consecutiveFailures: 3,
        });
        await expect(breaker.tryAcquire()).resolves.toBe(false);

        now += 5_000;
        await expect(breaker.tryAcquire()).resolves.toBe(true);
        await expect(breaker.tryAcquire()).resolves.toBe(false);
        await breaker.recordSuccess();
        await expect(breaker.snapshot()).resolves.toEqual({
            state: "closed",
            consecutiveFailures: 0,
        });
    });

    it("reopens when the half-open probe fails", async () => {
        let now = 0;
        const breaker = new ConsecutiveFailureCircuitBreaker({
            failureThreshold: 1,
            cooldownMs: 100,
            now: () => now,
        });

        await breaker.recordFailure();
        now = 100;
        await expect(breaker.tryAcquire()).resolves.toBe(true);
        await breaker.recordFailure();
        await expect(breaker.tryAcquire()).resolves.toBe(false);
    });

    function createRedisMock() {
        let state = "closed";
        let failures = 0;
        let openedAt = 0;
        let probeToken: string | null = null;
        const evalMock = jest.fn(
            async (
                script: string,
                _keys: number,
                _key: string,
                ...args: string[]
            ) => {
                if (script.includes("circuit-breaker:acquire")) {
                    const [nowRaw, cooldownRaw, token] = args;
                    const now = Number(nowRaw);
                    const cooldown = Number(cooldownRaw);
                    if (state === "closed") return [1, state, failures];
                    if (state === "half-open") return [0, state, failures];
                    if (now - openedAt < cooldown) return [0, state, failures];
                    state = "half-open";
                    probeToken = token;
                    return [1, state, failures];
                }
                if (script.includes("circuit-breaker:success")) {
                    const [token] = args;
                    if (state !== "half-open" || probeToken === token) {
                        state = "closed";
                        failures = 0;
                        probeToken = null;
                    }
                    return [state, failures];
                }
                if (script.includes("circuit-breaker:failure")) {
                    const [nowRaw, thresholdRaw, token] = args;
                    if (state === "half-open" && probeToken !== token) {
                        return [state, failures];
                    }
                    failures += 1;
                    if (
                        state === "half-open" ||
                        failures >= Number(thresholdRaw)
                    ) {
                        state = "open";
                        openedAt = Number(nowRaw);
                        probeToken = null;
                    }
                    return [state, failures];
                }
                return [state, failures];
            },
        );
        return { eval: evalMock };
    }

    it("shares open state across breaker instances through Redis", async () => {
        const redis = createRedisMock();
        const options = {
            failureThreshold: 1,
            cooldownMs: 5_000,
            now: () => 1_000,
        };
        const first = new ConsecutiveFailureCircuitBreaker({
            ...options,
            store: new RedisCircuitBreakerStore(redis, "breaker:test", 30_000),
        });
        const second = new ConsecutiveFailureCircuitBreaker({
            ...options,
            store: new RedisCircuitBreakerStore(redis, "breaker:test", 30_000),
        });

        await first.recordFailure();

        await expect(second.tryAcquire()).resolves.toBe(false);
        await expect(second.snapshot()).resolves.toEqual({
            state: "open",
            consecutiveFailures: 1,
        });
        expect(redis.eval).toHaveBeenCalled();
    });

    it("grants one atomic half-open probe token across instances", async () => {
        let now = 0;
        const redis = createRedisMock();
        const createBreaker = () =>
            new ConsecutiveFailureCircuitBreaker({
                failureThreshold: 1,
                cooldownMs: 100,
                now: () => now,
                store: new RedisCircuitBreakerStore(
                    redis,
                    "breaker:probe",
                    30_000,
                ),
            });
        const first = createBreaker();
        const second = createBreaker();
        await first.recordFailure();
        now = 100;

        const permits = await Promise.all([
            first.tryAcquire(),
            second.tryAcquire(),
        ]);

        expect(permits.filter(Boolean)).toHaveLength(1);
    });

    it("fails toward the closed local fallback when Redis is unavailable", async () => {
        const redis = {
            eval: jest.fn(async () => {
                throw new Error("redis unavailable");
            }),
        };
        const timeoutLogger = { warn: jest.fn() };
        const breaker = new ConsecutiveFailureCircuitBreaker({
            failureThreshold: 3,
            cooldownMs: 1_000,
            store: new RedisCircuitBreakerStore(
                redis,
                "breaker:outage",
                30_000,
            ),
            logger: timeoutLogger,
        });

        await expect(breaker.tryAcquire()).resolves.toBe(true);
        await expect(breaker.snapshot()).resolves.toEqual({
            state: "closed",
            consecutiveFailures: 0,
        });
        expect(timeoutLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining("using process-local fallback"),
            { error: expect.any(Error) },
        );
    });
});
