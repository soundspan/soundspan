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

/** Dependencies and deadlines for a Redis-backed rate-limit store. */
export type RedisRateLimitOptions = Readonly<{
    client?: RateLimitRedisClient;
    logger?: Logger;
    commandTimeoutMs?: number;
    warningIntervalMs?: number;
    now?: () => number;
}>;

type FailureReporter = (error: unknown) => void;
type ResolvedRateLimitOptions = Readonly<{
    client: () => RateLimitRedisClient;
    commandTimeoutMs: number;
    warningIntervalMs: number;
    now: () => number;
    logger: Logger;
}>;

function requirePositiveInteger(value: number, name: string): number {
    if (!Number.isInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive integer`);
    }
    return value;
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
    };
}

function createFailureReporter(
    limiterName: string,
    logger: Logger,
    warningIntervalMs: number,
    now: () => number,
): FailureReporter {
    let lastWarningAt = Number.NEGATIVE_INFINITY;
    return (error: unknown): void => {
        const currentTime = now();
        if (currentTime - lastWarningAt < warningIntervalMs) return;
        lastWarningAt = currentTime;
        logger.warn("Redis rate-limit store unavailable; allowing request", {
            limiter: limiterName,
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

class RedisRateLimitStore implements Store {
    private windowMs: number | null = null;

    constructor(
        private readonly client: () => RateLimitRedisClient,
        readonly prefix: string,
        private readonly commandTimeoutMs: number,
        private readonly reportFailure: FailureReporter,
    ) {}

    init(options: ExpressRateLimitOptions): void {
        this.windowMs = requirePositiveInteger(options.windowMs, "windowMs");
    }

    async increment(key: string): Promise<IncrementResponse> {
        if (this.windowMs === null) {
            throw new Error("Redis rate-limit store was not initialized");
        }
        const reply = await this.execute([
            "EVAL",
            INCREMENT_SCRIPT,
            "1",
            this.prefixKey(key),
            String(this.windowMs),
        ]);
        return parseIncrementReply(reply);
    }

    async decrement(key: string): Promise<void> {
        await this.executeBestEffort(["DECR", this.prefixKey(key)]);
    }

    async resetKey(key: string): Promise<void> {
        await this.executeBestEffort(["DEL", this.prefixKey(key)]);
    }

    private prefixKey(key: string): string {
        return `${this.prefix}${key}`;
    }

    private async executeBestEffort(args: readonly string[]): Promise<void> {
        try {
            await this.execute(args);
        } catch (error) {
            this.reportFailure(error);
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
 * Redis failures pass requests through and emit at most one warning per minute.
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
        ),
        passOnStoreError: true,
        logger: rateLimitLogger,
    };
}
