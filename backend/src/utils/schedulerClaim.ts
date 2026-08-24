import { randomUUID } from "crypto";
import type Redis from "ioredis";
import { config } from "../config";
import { createIORedisClient } from "./ioredis";
import { logger } from "./logger";

const claimLog = logger.child("WorkerScheduler").child("SchedulerClaim");
const claimObservabilityLog = claimLog.child("Observability");
const SCHEDULER_CLAIM_RETRY_ATTEMPTS = 3;
const OBSERVABILITY_LOG_EVERY = 25;
// Optional access keeps partial config mocks in tests from failing at import.
const SCHEDULER_SKIP_WARN_THRESHOLD =
    config.workers?.schedulerClaimSkipWarnThreshold ?? 3;
const jestLazyConnectOverride = config.underJest ? { lazyConnect: true } : {};

/** Shared scheduler-claim key for full and incremental audiobook syncs. */
export const AUDIOBOOK_SYNC_CLAIM_KEY = "scheduler-claim:audiobook-auto-sync";
/** Existing two-hour lease duration for an audiobook sync. */
export const AUDIOBOOK_SYNC_CLAIM_TTL_MS = 2 * 60 * 60 * 1000;
const AUDIOBOOK_SYNC_LEASE_SAFETY_MARGIN_MS = 10 * 60_000;
/** Sync work must finish before its serialization lease can expire. */
export const AUDIOBOOK_SYNC_WORK_TIMEOUT_MS =
    AUDIOBOOK_SYNC_CLAIM_TTL_MS - AUDIOBOOK_SYNC_LEASE_SAFETY_MARGIN_MS;
const SCHEDULER_CLAIM_PROCESS_ID = randomUUID();
/** Process-scoped owner identifier used in scheduler claim diagnostics. */
export const SCHEDULER_CLAIM_OWNER_ID = `${SCHEDULER_CLAIM_PROCESS_ID}:scheduler-claims`;

/** Outcome from a non-blocking scheduler claim attempt. */
export type SchedulerClaimResult<T> =
    | Readonly<{ acquired: false }>
    | Readonly<{ acquired: true; value: T }>;

type RedisOperation<T> = (client: Redis) => Promise<T>;

const schedulerClaimSkipCounts = new Map<string, number>();
const schedulerClaimCounters = {
    acquired: 0,
    skipped: 0,
    failedAcquire: 0,
    failedRelease: 0,
    extended: 0,
    failedExtend: 0,
    retryRecoveries: 0,
};
let schedulerLockRedis: Redis = createIORedisClient(
    "worker-scheduler-locks",
    jestLazyConnectOverride,
);
let schedulerClaimRedisClosed = false;

function logSchedulerClaimObservability(context: string): void {
    const counters = schedulerClaimCounters;
    claimObservabilityLog.info(
        `context=${context} workerId=${SCHEDULER_CLAIM_PROCESS_ID} owner=${SCHEDULER_CLAIM_OWNER_ID} acquired=${counters.acquired} skipped=${counters.skipped} failedAcquire=${counters.failedAcquire} failedRelease=${counters.failedRelease} extended=${counters.extended} failedExtend=${counters.failedExtend} retryRecoveries=${counters.retryRecoveries}`,
    );
}

function maybeLogSchedulerClaimObservability(context: string): void {
    const counters = schedulerClaimCounters;
    const totalEvents =
        counters.acquired +
        counters.skipped +
        counters.failedAcquire +
        counters.failedRelease +
        counters.extended +
        counters.failedExtend;
    if (totalEvents > 0 && totalEvents % OBSERVABILITY_LOG_EVERY === 0) {
        logSchedulerClaimObservability(context);
    }
}

function isRetryableSchedulerClaimError(error: unknown): boolean {
    const message =
        error instanceof Error ? error.message : String(error ?? "");
    return (
        message.includes("Connection is closed") ||
        message.includes("Connection is in closing state") ||
        message.includes("ECONNRESET") ||
        message.includes("ETIMEDOUT") ||
        message.includes("EPIPE")
    );
}

function recreateSchedulerLockRedisClient(): void {
    try {
        schedulerLockRedis.disconnect();
    } catch {
        // The failed client is already unusable.
    }
    schedulerLockRedis = createIORedisClient(
        "worker-scheduler-locks",
        jestLazyConnectOverride,
    );
}

/** Runs one scheduler Redis operation with bounded connection recovery. */
export async function withSchedulerClaimRedisRetry<T>(
    operationName: string,
    operation: RedisOperation<T>,
): Promise<T> {
    for (
        let attempt = 1;
        attempt <= SCHEDULER_CLAIM_RETRY_ATTEMPTS;
        attempt += 1
    ) {
        try {
            return await operation(schedulerLockRedis);
        } catch (error) {
            if (
                !isRetryableSchedulerClaimError(error) ||
                attempt === SCHEDULER_CLAIM_RETRY_ATTEMPTS
            ) {
                throw error;
            }
            claimLog.warn(
                `${operationName} failed due to Redis connection closure (attempt ${attempt}/${SCHEDULER_CLAIM_RETRY_ATTEMPTS}); recreating client and retrying`,
                error,
            );
            schedulerClaimCounters.retryRecoveries += 1;
            recreateSchedulerLockRedisClient();
            await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
        }
    }
    throw new Error("Scheduler claim Redis retry limit was not enforced");
}

function recordSkippedClaim(claimKey: string, operationName: string): void {
    const skippedCount = (schedulerClaimSkipCounts.get(claimKey) ?? 0) + 1;
    schedulerClaimSkipCounts.set(claimKey, skippedCount);
    schedulerClaimCounters.skipped += 1;
    const periodicWarnInterval = SCHEDULER_SKIP_WARN_THRESHOLD * 10;
    const shouldWarn =
        skippedCount === SCHEDULER_SKIP_WARN_THRESHOLD ||
        skippedCount % periodicWarnInterval === 0;
    const message = shouldWarn
        ? `${operationName} skipped ${skippedCount} consecutive time(s); claim held by another worker (owner=${SCHEDULER_CLAIM_OWNER_ID})`
        : `Skipping ${operationName}; claim is held by another worker (owner=${SCHEDULER_CLAIM_OWNER_ID})`;
    if (shouldWarn) {
        claimLog.warn(message);
    } else {
        claimLog.debug(message);
    }
    maybeLogSchedulerClaimObservability("skip");
}

async function acquireSchedulerClaim(
    claimKey: string,
    ttlMs: number,
    operationName: string,
): Promise<string | null> {
    const claimToken = `${SCHEDULER_CLAIM_OWNER_ID}:${randomUUID()}`;
    const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
    const acquired = await withSchedulerClaimRedisRetry(
        `claim acquire for ${operationName}`,
        (client) => client.set(claimKey, claimToken, "EX", ttlSeconds, "NX"),
    );
    if (acquired !== "OK") {
        recordSkippedClaim(claimKey, operationName);
        return null;
    }
    schedulerClaimSkipCounts.delete(claimKey);
    schedulerClaimCounters.acquired += 1;
    claimLog.debug(
        `Acquired claim for ${operationName} (claimKey=${claimKey}, owner=${SCHEDULER_CLAIM_OWNER_ID})`,
    );
    maybeLogSchedulerClaimObservability("acquire");
    return claimToken;
}

function recordClaimFailure(operationName: string, error: unknown): void {
    schedulerClaimCounters.failedAcquire += 1;
    claimLog.error(
        `Failed to claim ${operationName}; skipping cycle (owner=${SCHEDULER_CLAIM_OWNER_ID})`,
        error,
    );
    maybeLogSchedulerClaimObservability("failed-acquire");
}

async function releaseSchedulerClaim(
    claimKey: string,
    claimToken: string,
    operationName: string,
): Promise<void> {
    try {
        await withSchedulerClaimRedisRetry(
            `claim release for ${operationName}`,
            (client) =>
                client.eval(
                    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
                    1,
                    claimKey,
                    claimToken,
                ),
        );
    } catch (error) {
        schedulerClaimCounters.failedRelease += 1;
        claimLog.warn(
            `Failed to release claim for ${operationName} (owner=${SCHEDULER_CLAIM_OWNER_ID})`,
            error,
        );
        maybeLogSchedulerClaimObservability("failed-release");
    }
}

function recordClaimExtension(extended: boolean): void {
    schedulerClaimCounters[extended ? "extended" : "failedExtend"] += 1;
    maybeLogSchedulerClaimObservability(extended ? "extend" : "failed-extend");
}

/** Extend a scheduler claim when the caller still owns its token. */
export async function extendSchedulerClaim(
    claimKey: string,
    claimToken: string,
    ttlMs: number,
): Promise<boolean> {
    try {
        const ttlMilliseconds = Math.max(1, Math.ceil(ttlMs));
        const extended = await withSchedulerClaimRedisRetry(
            "claim extension",
            (client) =>
                client.eval(
                    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
                    1,
                    claimKey,
                    claimToken,
                    ttlMilliseconds,
                ),
        );
        recordClaimExtension(extended === 1);
        return extended === 1;
    } catch (error) {
        recordClaimExtension(false);
        throw error;
    }
}

/** Runs an operation under the Redis lease used by scheduled worker claims. */
export async function runWithSchedulerClaim<T>(
    claimKey: string,
    ttlMs: number,
    operationName: string,
    operation: (claimToken: string) => Promise<T>,
): Promise<SchedulerClaimResult<T>> {
    let claimToken: string | null;
    try {
        claimToken = await acquireSchedulerClaim(
            claimKey,
            ttlMs,
            operationName,
        );
    } catch (error) {
        recordClaimFailure(operationName, error);
        return { acquired: false };
    }
    if (!claimToken) return { acquired: false };
    try {
        return { acquired: true, value: await operation(claimToken) };
    } finally {
        await releaseSchedulerClaim(claimKey, claimToken, operationName);
    }
}

/** Closes the shared Redis client used by scheduler claims and cursors. */
export async function shutdownSchedulerClaimRedis(): Promise<void> {
    if (schedulerClaimRedisClosed) return;
    await schedulerLockRedis.quit();
    schedulerClaimRedisClosed = true;
}
