import { randomUUID } from "crypto";
import { logger } from "./logger";

type CircuitState = "closed" | "open" | "half-open";
type CircuitBreakerLogger = Pick<typeof logger, "warn">;

interface CircuitBreakerOptions {
    failureThreshold: number;
    cooldownMs: number;
    now?: () => number;
    store?: CircuitBreakerStateStore;
    logger?: CircuitBreakerLogger;
    tokenFactory?: () => string;
}

/** Snapshot safe for logs and deterministic state-machine tests. */
export interface CircuitBreakerSnapshot {
    state: CircuitState;
    consecutiveFailures: number;
}

interface CircuitBreakerPermit {
    acquired: boolean;
    snapshot: CircuitBreakerSnapshot;
}

interface CircuitBreakerStateStore {
    tryAcquire(
        now: number,
        cooldownMs: number,
        probeToken: string,
    ): Promise<CircuitBreakerPermit>;
    recordSuccess(probeToken: string): Promise<CircuitBreakerSnapshot>;
    recordFailure(
        now: number,
        failureThreshold: number,
        probeToken: string,
    ): Promise<CircuitBreakerSnapshot>;
    snapshot(): Promise<CircuitBreakerSnapshot>;
}

/** Minimal atomic Redis command surface used by the breaker state store. */
export interface CircuitBreakerRedisClient {
    eval(
        script: string,
        numberOfKeys: number,
        key: string,
        ...args: string[]
    ): Promise<unknown>;
}

const ACQUIRE_SCRIPT = `
-- circuit-breaker:acquire
local state = redis.call("HGET", KEYS[1], "state") or "closed"
local failures = tonumber(redis.call("HGET", KEYS[1], "failures") or "0")
if state == "closed" then
    redis.call("PEXPIRE", KEYS[1], ARGV[4])
    return {1, state, failures}
end
if state == "half-open" then
    return {0, state, failures}
end
local openedAt = tonumber(redis.call("HGET", KEYS[1], "openedAt") or "0")
if tonumber(ARGV[1]) - openedAt < tonumber(ARGV[2]) then
    return {0, state, failures}
end
redis.call("HSET", KEYS[1], "state", "half-open", "probeToken", ARGV[3])
redis.call("PEXPIRE", KEYS[1], ARGV[4])
return {1, "half-open", failures}
`;

const SUCCESS_SCRIPT = `
-- circuit-breaker:success
local state = redis.call("HGET", KEYS[1], "state") or "closed"
local failures = tonumber(redis.call("HGET", KEYS[1], "failures") or "0")
local owner = redis.call("HGET", KEYS[1], "probeToken")
if state == "half-open" and owner ~= ARGV[1] then
    return {state, failures}
end
redis.call("HSET", KEYS[1], "state", "closed", "failures", 0)
redis.call("HDEL", KEYS[1], "openedAt", "probeToken")
redis.call("PEXPIRE", KEYS[1], ARGV[2])
return {"closed", 0}
`;

const FAILURE_SCRIPT = `
-- circuit-breaker:failure
local state = redis.call("HGET", KEYS[1], "state") or "closed"
local failures = tonumber(redis.call("HGET", KEYS[1], "failures") or "0")
local owner = redis.call("HGET", KEYS[1], "probeToken")
if state == "half-open" and owner ~= ARGV[3] then
    return {state, failures}
end
failures = failures + 1
if state == "half-open" or failures >= tonumber(ARGV[2]) then
    state = "open"
    redis.call("HSET", KEYS[1], "openedAt", ARGV[1])
    redis.call("HDEL", KEYS[1], "probeToken")
end
redis.call("HSET", KEYS[1], "state", state, "failures", failures)
redis.call("PEXPIRE", KEYS[1], ARGV[4])
return {state, failures}
`;

const SNAPSHOT_SCRIPT = `
-- circuit-breaker:snapshot
local state = redis.call("HGET", KEYS[1], "state") or "closed"
local failures = tonumber(redis.call("HGET", KEYS[1], "failures") or "0")
return {state, failures}
`;

function parseState(value: unknown): CircuitState {
    if (value === "closed" || value === "open" || value === "half-open") {
        return value;
    }
    throw new Error("Redis circuit breaker returned an invalid state");
}

function parseFailures(value: unknown): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(
            "Redis circuit breaker returned an invalid failure count",
        );
    }
    return parsed;
}

function parseSnapshot(value: unknown): CircuitBreakerSnapshot {
    if (!Array.isArray(value) || value.length < 2) {
        throw new Error("Redis circuit breaker returned an invalid snapshot");
    }
    return {
        state: parseState(value[0]),
        consecutiveFailures: parseFailures(value[1]),
    };
}

/** TTL-managed Redis state with atomic open and half-open transitions. */
export class RedisCircuitBreakerStore implements CircuitBreakerStateStore {
    constructor(
        private readonly redis: CircuitBreakerRedisClient,
        private readonly key: string,
        private readonly ttlMs: number,
    ) {
        if (!key || !Number.isSafeInteger(ttlMs) || ttlMs < 1) {
            throw new Error("Redis circuit breaker key and TTL are required");
        }
    }

    async tryAcquire(
        now: number,
        cooldownMs: number,
        probeToken: string,
    ): Promise<CircuitBreakerPermit> {
        const result = await this.redis.eval(
            ACQUIRE_SCRIPT,
            1,
            this.key,
            String(now),
            String(cooldownMs),
            probeToken,
            String(this.ttlMs),
        );
        if (!Array.isArray(result) || result.length < 3) {
            throw new Error("Redis circuit breaker returned an invalid permit");
        }
        return {
            acquired: result[0] === 1 || result[0] === "1",
            snapshot: parseSnapshot(result.slice(1)),
        };
    }

    async recordSuccess(probeToken: string): Promise<CircuitBreakerSnapshot> {
        const result = await this.redis.eval(
            SUCCESS_SCRIPT,
            1,
            this.key,
            probeToken,
            String(this.ttlMs),
        );
        return parseSnapshot(result);
    }

    async recordFailure(
        now: number,
        failureThreshold: number,
        probeToken: string,
    ): Promise<CircuitBreakerSnapshot> {
        const result = await this.redis.eval(
            FAILURE_SCRIPT,
            1,
            this.key,
            String(now),
            String(failureThreshold),
            probeToken,
            String(this.ttlMs),
        );
        return parseSnapshot(result);
    }

    async snapshot(): Promise<CircuitBreakerSnapshot> {
        const result = await this.redis.eval(SNAPSHOT_SCRIPT, 1, this.key);
        return parseSnapshot(result);
    }
}

class InMemoryCircuitBreaker {
    private state: CircuitState = "closed";
    private consecutiveFailures = 0;
    private openedAt = 0;

    tryAcquire(now: number, cooldownMs: number): boolean {
        if (this.state === "closed") return true;
        if (this.state === "half-open") return false;
        if (now - this.openedAt < cooldownMs) return false;
        this.state = "half-open";
        return true;
    }

    recordSuccess(): void {
        this.state = "closed";
        this.consecutiveFailures = 0;
    }

    recordFailure(now: number, failureThreshold: number): void {
        this.consecutiveFailures += 1;
        if (
            this.state === "half-open" ||
            this.consecutiveFailures >= failureThreshold
        ) {
            this.state = "open";
            this.openedAt = now;
        }
    }

    snapshot(): CircuitBreakerSnapshot {
        return {
            state: this.state,
            consecutiveFailures: this.consecutiveFailures,
        };
    }
}

/** Consecutive-failure breaker backed by Redis with local outage fallback. */
export class ConsecutiveFailureCircuitBreaker {
    private readonly fallback = new InMemoryCircuitBreaker();
    private readonly now: () => number;
    private readonly tokenFactory: () => string;
    private readonly log: CircuitBreakerLogger;
    private probeToken = "";

    constructor(private readonly options: CircuitBreakerOptions) {
        if (!Number.isSafeInteger(options.failureThreshold)) {
            throw new Error("failureThreshold must be an integer");
        }
        if (options.failureThreshold < 1 || options.cooldownMs < 1) {
            throw new Error("circuit breaker bounds must be positive");
        }
        this.now = options.now ?? Date.now;
        this.tokenFactory = options.tokenFactory ?? randomUUID;
        this.log = options.logger ?? logger;
    }

    /** Acquires permission for ordinary work or the single recovery probe. */
    async tryAcquire(): Promise<boolean> {
        const token = this.tokenFactory();
        if (!this.options.store) {
            this.probeToken = token;
            return this.fallback.tryAcquire(
                this.now(),
                this.options.cooldownMs,
            );
        }
        try {
            const permit = await this.options.store.tryAcquire(
                this.now(),
                this.options.cooldownMs,
                token,
            );
            if (permit.acquired) this.probeToken = token;
            return permit.acquired;
        } catch (error) {
            this.warnFallback("acquire", error);
            this.probeToken = token;
            return this.fallback.tryAcquire(
                this.now(),
                this.options.cooldownMs,
            );
        }
    }

    /** Closes the breaker after any successful permitted execution. */
    async recordSuccess(): Promise<void> {
        if (this.options.store) {
            try {
                await this.options.store.recordSuccess(this.probeToken);
                this.fallback.recordSuccess();
                return;
            } catch (error) {
                this.warnFallback("success", error);
            }
        }
        this.fallback.recordSuccess();
    }

    /** Counts one failure and opens or reopens at the configured threshold. */
    async recordFailure(): Promise<void> {
        if (this.options.store) {
            try {
                await this.options.store.recordFailure(
                    this.now(),
                    this.options.failureThreshold,
                    this.probeToken,
                );
                this.fallback.recordFailure(
                    this.now(),
                    this.options.failureThreshold,
                );
                return;
            } catch (error) {
                this.warnFallback("failure", error);
            }
        }
        this.fallback.recordFailure(this.now(), this.options.failureThreshold);
    }

    /** Returns the current bounded state for diagnostics. */
    async snapshot(): Promise<CircuitBreakerSnapshot> {
        if (this.options.store) {
            try {
                return await this.options.store.snapshot();
            } catch (error) {
                this.warnFallback("snapshot", error);
            }
        }
        return this.fallback.snapshot();
    }

    private warnFallback(operation: string, error: unknown): void {
        this.log.warn(
            `Redis circuit breaker ${operation} failed; using process-local fallback`,
            { error },
        );
    }
}
