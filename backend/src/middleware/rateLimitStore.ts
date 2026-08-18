import type {
    IncrementResponse,
    Logger as ExpressRateLimitLogger,
    Options as ExpressRateLimitOptions,
    Store,
} from "express-rate-limit";
import { logger as rootLogger, type Logger } from "../utils/logger";

/**
 * Resolve the shared Redis client lazily. Limiters (and therefore stores) are
 * created when middleware modules load; importing ../utils/redis eagerly would
 * chain into config validation at import time, which exits the process in
 * environments without a full env (notably test workers that import a route or
 * middleware module without mocking config). No command runs before a request
 * reaches a limiter, so first-use resolution is equivalent in production.
 */
function loadDefaultRedisClient(): RateLimitRedisClient {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../utils/redis") as {
        redisClient: RateLimitRedisClient;
    };
    return mod.redisClient;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 250;
const DEFAULT_WARNING_INTERVAL_MS = 60_000;
const DEFAULT_MEMORY_MAX_HITS = 1_000_000;
// Each opt-in limiter retains at most this many keys in each backend process.
const DEFAULT_MEMORY_MAX_ENTRIES = 10_000;
const LIMITER_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const INCREMENT_SCRIPT = `
local windowMs = tonumber(ARGV[1])
local timeToExpire = redis.call("PTTL", KEYS[1])
if timeToExpire <= 0 then
    redis.call("SET", KEYS[1], 1, "PX", windowMs)
    return { 1, windowMs }
end
local totalHits = redis.call("INCR", KEYS[1])
return { totalHits, timeToExpire }
`.trim();

type RedisCommandOptions = Readonly<{
    timeout?: number;
    abortSignal?: AbortSignal;
}>;

/** Narrow node-redis boundary used by the shared rate-limit store. */
export interface RateLimitRedisClient {
    readonly isReady: boolean;
    sendCommand(
        args: readonly string[],
        options?: RedisCommandOptions,
    ): Promise<unknown>;
}

/** Redis outage policy for one rate limiter. */
export type RateLimitFallback = "memory" | "open";

/** Dependencies and deadlines for a Redis-backed rate-limit store. */
export type RedisRateLimitOptions = Readonly<{
    client?: RateLimitRedisClient;
    logger?: Logger;
    commandTimeoutMs?: number;
    warningIntervalMs?: number;
    now?: () => number;
    fallback?: RateLimitFallback;
}>;

type FailureReporter = (error: unknown) => void;
type ResolvedRateLimitOptions = Readonly<{
    client: () => RateLimitRedisClient;
    commandTimeoutMs: number;
    warningIntervalMs: number;
    now: () => number;
    logger: Logger;
    fallback: RateLimitFallback;
}>;

type MemoryWindow = Readonly<{
    hits: number[];
}>;

function requirePositiveInteger(value: number, name: string): number {
    if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive integer`);
    }
    return value;
}

function requireMemoryLimit(limit: ExpressRateLimitOptions["limit"]): number {
    if (typeof limit !== "number") {
        throw new TypeError("memory fallback requires a static numeric limit");
    }
    const resolved = requirePositiveInteger(limit, "limit");
    if (resolved >= DEFAULT_MEMORY_MAX_HITS) {
        throw new RangeError("memory fallback limit exceeds its hit capacity");
    }
    return resolved;
}

function memoryEntryCap(limit: number): number {
    return Math.min(
        DEFAULT_MEMORY_MAX_ENTRIES,
        Math.floor(DEFAULT_MEMORY_MAX_HITS / (limit + 1)),
    );
}

function normalizeReplyInteger(value: unknown, field: string): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new TypeError(`Redis returned an invalid ${field}`);
    }
    return parsed;
}

function parseIncrementReply(reply: unknown): IncrementResponse {
    if (!Array.isArray(reply) || reply.length !== 2) {
        throw new TypeError("Redis returned an invalid rate-limit reply");
    }
    const totalHits = normalizeReplyInteger(reply[0], "hit count");
    const ttlMs = normalizeReplyInteger(reply[1], "expiry");
    if (totalHits < 1 || ttlMs < 0) {
        throw new TypeError("Redis returned an invalid rate-limit counter");
    }
    return { totalHits, resetTime: new Date(Date.now() + ttlMs) };
}

function describeError(error: unknown): string {
    return String(error);
}

/**
 * Scope the store's logger without assuming a full logger shape. Limiters are
 * created at module load, where test doubles may stub the logger module with a
 * partial object; falling back to the base logger keeps imports side-effect
 * safe instead of throwing before any request runs.
 */
function scopedLogger(base: Logger): Logger {
    return typeof base.child === "function"
        ? base.child("RateLimitStore")
        : base;
}

function resolveRateLimitOptions(
    options: RedisRateLimitOptions,
): ResolvedRateLimitOptions {
    const providedClient = options.client;
    return {
        client: providedClient ? () => providedClient : loadDefaultRedisClient,
        commandTimeoutMs: requirePositiveInteger(
            options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
            "commandTimeoutMs",
        ),
        warningIntervalMs: requirePositiveInteger(
            options.warningIntervalMs ?? DEFAULT_WARNING_INTERVAL_MS,
            "warningIntervalMs",
        ),
        now: options.now ?? Date.now,
        logger: scopedLogger(options.logger ?? rootLogger),
        fallback: options.fallback ?? "open",
    };
}

function createFailureReporter(
    limiterName: string,
    logger: Logger,
    warningIntervalMs: number,
    now: () => number,
    fallback: RateLimitFallback,
): FailureReporter {
    let lastWarningAt = Number.NEGATIVE_INFINITY;
    const message = `Redis rate-limit store unavailable; using ${fallback} fallback`;
    return (error: unknown): void => {
        const currentTime = now();
        if (currentTime - lastWarningAt < warningIntervalMs) return;
        lastWarningAt = currentTime;
        logger.warn(message, {
            limiter: limiterName,
            fallback,
            error: describeError(error),
        });
    };
}

function createExpressRateLimitLogger(
    logger: Logger,
    reportFailure: FailureReporter,
): ExpressRateLimitLogger {
    return {
        error: (error, message) => {
            if (message?.includes("error from store")) {
                reportFailure(error);
                return;
            }
            logger.error(message ?? "Rate limiter error", describeError(error));
        },
        warn: (error, message) => {
            logger.warn(
                message ?? "Rate limiter warning",
                describeError(error),
            );
        },
    };
}

class BoundedMemorySlidingWindowStore {
    private readonly entries = new Map<string, MemoryWindow>();

    constructor(
        private readonly maxEntries: number,
        private readonly maxHitsPerKey: number,
        private readonly now: () => number,
    ) {}

    increment(key: string, windowMs: number): IncrementResponse {
        const currentTime = this.now();
        const hits = this.activeHits(key, currentTime - windowMs);
        hits.push(currentTime);
        if (hits.length > this.maxHitsPerKey) hits.shift();
        this.setRecentlyUsed(key, { hits });
        const oldestHit = hits[0] ?? currentTime;
        return {
            totalHits: hits.length,
            resetTime: new Date(oldestHit + windowMs),
        };
    }

    decrement(key: string, windowMs: number): void {
        const hits = this.activeHits(key, this.now() - windowMs);
        hits.pop();
        if (hits.length > 0) this.setRecentlyUsed(key, { hits });
    }

    resetKey(key: string): void {
        this.entries.delete(key);
    }

    private activeHits(key: string, cutoff: number): number[] {
        const current = this.entries.get(key);
        if (!current) return [];
        this.entries.delete(key);
        return current.hits.filter((hit) => hit > cutoff);
    }

    private setRecentlyUsed(key: string, value: MemoryWindow): void {
        const existed = this.entries.delete(key);
        if (!existed && this.entries.size >= this.maxEntries) {
            const oldestKey = this.entries.keys().next().value as
                | string
                | undefined;
            if (oldestKey !== undefined) this.entries.delete(oldestKey);
        }
        this.entries.set(key, value);
    }
}

class RedisRateLimitStore implements Store {
    private windowMs: number | null = null;
    private memoryStore: BoundedMemorySlidingWindowStore | null = null;

    constructor(
        private readonly client: () => RateLimitRedisClient,
        readonly prefix: string,
        private readonly commandTimeoutMs: number,
        private readonly reportFailure: FailureReporter,
        private readonly fallback: RateLimitFallback,
        private readonly now: () => number,
    ) {}

    init(options: ExpressRateLimitOptions): void {
        this.windowMs = requirePositiveInteger(options.windowMs, "windowMs");
        if (this.fallback === "memory") {
            const limit = requireMemoryLimit(options.limit);
            this.memoryStore = new BoundedMemorySlidingWindowStore(
                memoryEntryCap(limit),
                limit + 1,
                this.now,
            );
        }
    }

    async increment(key: string): Promise<IncrementResponse> {
        if (this.windowMs === null) {
            throw new Error("Redis rate-limit store was not initialized");
        }
        const prefixedKey = this.prefixKey(key);
        try {
            const reply = await this.execute([
                "EVAL",
                INCREMENT_SCRIPT,
                "1",
                prefixedKey,
                String(this.windowMs),
            ]);
            // Recovery immediately returns to Redis-only decisions. Fallback
            // state is neither merged nor synchronized and expires locally.
            return parseIncrementReply(reply);
        } catch (error) {
            if (!this.memoryStore) throw error;
            this.reportFailure(error);
            return this.memoryStore.increment(prefixedKey, this.windowMs);
        }
    }

    async decrement(key: string): Promise<void> {
        const prefixedKey = this.prefixKey(key);
        const windowMs = this.windowMs;
        await this.executeBestEffort(["DECR", prefixedKey], () =>
            windowMs === null
                ? undefined
                : this.memoryStore?.decrement(prefixedKey, windowMs),
        );
    }

    async resetKey(key: string): Promise<void> {
        const prefixedKey = this.prefixKey(key);
        await this.executeBestEffort(["DEL", prefixedKey], () =>
            this.memoryStore?.resetKey(prefixedKey),
        );
    }

    private prefixKey(key: string): string {
        return `${this.prefix}${key}`;
    }

    private async executeBestEffort(
        args: readonly string[],
        fallback: () => void,
    ): Promise<void> {
        try {
            await this.execute(args);
        } catch (error) {
            this.reportFailure(error);
            fallback();
        }
    }

    private async execute(args: readonly string[]): Promise<unknown> {
        const client = this.client();
        if (!client.isReady) {
            throw new Error("Redis client is not ready");
        }
        const controller = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(
                    new Error(
                        `Redis rate-limit command timed out after ${this.commandTimeoutMs}ms`,
                    ),
                );
            }, this.commandTimeoutMs);
        });
        try {
            return await Promise.race([
                client.sendCommand(args, {
                    timeout: this.commandTimeoutMs,
                    abortSignal: controller.signal,
                }),
                timeout,
            ]);
        } finally {
            if (timer !== undefined) clearTimeout(timer);
        }
    }
}

/**
 * Builds the shared-store options for one named express-rate-limit instance.
 * Redis failures use the selected fallback and emit at most one warning per
 * minute. Memory fallback counters are capped at 10,000 keys and one million
 * retained hit timestamps per limiter per process; multi-replica deployments
 * therefore enforce independently while Redis is unavailable.
 */
export function createRedisRateLimitOptions(
    limiterName: string,
    options: RedisRateLimitOptions = {},
): Pick<ExpressRateLimitOptions, "logger" | "passOnStoreError" | "store"> {
    if (!LIMITER_NAME_PATTERN.test(limiterName)) {
        throw new TypeError("limiterName must be a lowercase key-safe name");
    }
    const resolved = resolveRateLimitOptions(options);
    const reportFailure = createFailureReporter(
        limiterName,
        resolved.logger,
        resolved.warningIntervalMs,
        resolved.now,
        resolved.fallback,
    );
    const rateLimitLogger = createExpressRateLimitLogger(
        resolved.logger,
        reportFailure,
    );
    return {
        store: new RedisRateLimitStore(
            resolved.client,
            `rl:${limiterName}:`,
            resolved.commandTimeoutMs,
            reportFailure,
            resolved.fallback,
            resolved.now,
        ),
        passOnStoreError: resolved.fallback === "open",
        logger: rateLimitLogger,
    };
}
