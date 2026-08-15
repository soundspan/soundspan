import type { Request, Response } from "express";
import { Transform } from "node:stream";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";

const log = logger.child("FederationStreamControls");
const STREAM_COUNTER_KEY_PREFIX = "federation:stream-count:v1";
const STREAM_RETRY_AFTER_SECONDS = 1;
const PACING_WINDOW_MS = 100;
const MAX_PACING_SLICES_PER_CHUNK = 8_000_000;

/** Crash-recovery lease duration for distributed peer stream counters. */
export const FEDERATION_STREAM_COUNTER_TTL_SECONDS = 60;
const STREAM_COUNTER_REFRESH_MS =
    (FEDERATION_STREAM_COUNTER_TTL_SECONDS * 1_000) / 3;

const ACQUIRE_STREAM_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if current == 1 or ttl < 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if current > tonumber(ARGV[1]) then
  local remaining = redis.call('DECR', KEYS[1])
  if remaining <= 0 then redis.call('DEL', KEYS[1]) end
  return 0
end
return current
`;

const REFRESH_STREAM_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current > 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  return 1
end
return 0
`;

const RELEASE_STREAM_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current <= 0 then return 0 end
if current == 1 then
  redis.call('DEL', KEYS[1])
  return 0
end
local remaining = redis.call('DECR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return remaining
`;

/** Minimal Redis command surface used by the distributed stream counter. */
export interface FederationStreamRedis {
    eval(
        script: string,
        options: { keys: string[]; arguments: string[] },
    ): Promise<unknown>;
}

/** Limits attached to one authenticated host-side peer request. */
export interface FederationStreamLimits {
    peerId: string;
    maxConcurrentStreams: number | null;
    maxStreamKbps: number | null;
}

class FederationStreamLease {
    private refreshTimer: NodeJS.Timeout | null = null;
    private releasePromise: Promise<void> | null = null;

    constructor(
        private readonly redis: FederationStreamRedis,
        private readonly key: string,
    ) {
        this.refreshTimer = setInterval(() => {
            this.refresh().catch((error: unknown) => {
                log.warn("Failed to refresh federation stream lease", error);
            });
        }, STREAM_COUNTER_REFRESH_MS);
        this.refreshTimer.unref?.();
    }

    private async refresh(): Promise<void> {
        await this.redis.eval(REFRESH_STREAM_SCRIPT, {
            keys: [this.key],
            arguments: [String(FEDERATION_STREAM_COUNTER_TTL_SECONDS)],
        });
    }

    release(): Promise<void> {
        if (this.releasePromise) return this.releasePromise;
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        this.refreshTimer = null;
        this.releasePromise = this.redis
            .eval(RELEASE_STREAM_SCRIPT, {
                keys: [this.key],
                arguments: [String(FEDERATION_STREAM_COUNTER_TTL_SECONDS)],
            })
            .then(() => undefined);
        return this.releasePromise;
    }
}

function streamCounterKey(peerId: string): string {
    return `${STREAM_COUNTER_KEY_PREFIX}:${peerId}`;
}

async function acquireStreamLease(
    redis: FederationStreamRedis,
    peerId: string,
    limit: number,
): Promise<FederationStreamLease | null> {
    const key = streamCounterKey(peerId);
    const result = await redis.eval(ACQUIRE_STREAM_SCRIPT, {
        keys: [key],
        arguments: [
            String(limit),
            String(FEDERATION_STREAM_COUNTER_TTL_SECONDS),
        ],
    });
    if (Number(result) < 1) return null;
    return new FederationStreamLease(redis, key);
}

function waitForWindow(delayMs: number): Promise<void> {
    if (delayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function pushPacedChunk(
    transform: Transform,
    chunk: Buffer,
    bytesPerWindow: number,
    nextWindow: { value: number },
): Promise<void> {
    let offset = 0;
    for (let slice = 0; slice < MAX_PACING_SLICES_PER_CHUNK; slice += 1) {
        if (offset >= chunk.byteLength || transform.destroyed) return;
        await waitForWindow(Math.max(0, nextWindow.value - Date.now()));
        if (transform.destroyed) return;
        const end = Math.min(offset + bytesPerWindow, chunk.byteLength);
        transform.push(chunk.subarray(offset, end));
        offset = end;
        nextWindow.value = Math.max(
            nextWindow.value + PACING_WINDOW_MS,
            Date.now(),
        );
    }
    throw new RangeError("Federation stream pacing chunk exceeded its bound");
}

/** Creates a backpressure-aware byte-window pacing transform for one peer cap. */
export function createStreamPacingTransform(maxStreamKbps: number): Transform {
    const bytesPerWindow = Math.max(
        1,
        Math.floor((maxStreamKbps * 1_000 * PACING_WINDOW_MS) / 8_000),
    );
    const nextWindow = { value: Date.now() };
    let transform: Transform;
    transform = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
            pushPacedChunk(transform, chunk, bytesPerWindow, nextWindow).then(
                () => callback(),
                (error: unknown) =>
                    callback(
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    ),
            );
        },
    });
    return transform;
}

function sendLimitExceeded(res: Response): Response {
    res.setHeader("Retry-After", String(STREAM_RETRY_AFTER_SECONDS));
    return res.status(429).json({
        error: "Federation peer stream limit exceeded",
        code: "FEDERATION_STREAM_LIMIT",
        retryAfterSeconds: STREAM_RETRY_AFTER_SECONDS,
    });
}

function attachLeaseCleanup(
    req: Request,
    res: Response,
    lease: FederationStreamLease,
): () => void {
    const release = (): void => {
        lease.release().catch((error: unknown) => {
            log.warn("Failed to release federation stream lease", error);
        });
    };
    req.once("aborted", release);
    res.once("finish", release);
    res.once("close", release);
    return () => {
        req.off("aborted", release);
        res.off("finish", release);
        res.off("close", release);
    };
}

async function releaseLease(lease: FederationStreamLease): Promise<void> {
    try {
        await lease.release();
    } catch (error) {
        log.warn("Failed to release federation stream lease", error);
    }
}

/** Applies optional distributed admission and pacing to one host stream. */
export async function withFederationStreamControls<T>(
    req: Request,
    res: Response,
    limits: FederationStreamLimits,
    operation: (pacing: Transform | null) => Promise<T>,
    redis: FederationStreamRedis = redisClient,
): Promise<T | Response> {
    let lease: FederationStreamLease | null = null;
    if (limits.maxConcurrentStreams !== null) {
        lease = await acquireStreamLease(
            redis,
            limits.peerId,
            limits.maxConcurrentStreams,
        );
        if (!lease) return sendLimitExceeded(res);
    }
    const detach = lease
        ? attachLeaseCleanup(req, res, lease)
        : () => undefined;
    const pacing = limits.maxStreamKbps
        ? createStreamPacingTransform(limits.maxStreamKbps)
        : null;
    try {
        return await operation(pacing);
    } finally {
        detach();
        if (lease) await releaseLease(lease);
    }
}
