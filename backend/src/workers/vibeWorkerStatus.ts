import { z } from "zod";
import { logger } from "../utils/logger";

function registryErrorClass(error: unknown): string {
    if (error instanceof Error && error.name.trim().length > 0) {
        return error.name.slice(0, 128);
    }
    return "UnknownError";
}

/** Namespace for TTL-bound per-worker provider status keys. */
export const VIBE_WORKER_STATUS_KEY_PREFIX = "soundspan:vibe-worker-status:v3:";
/** Timestamped registry used to discover and expire worker snapshots. */
export const VIBE_WORKER_STATUS_REGISTRY_KEY =
    "soundspan:vibe-worker-status:v3:registry";
/** Cadence shared by worker publishing and reader-side freshness checks. */
export const VIBE_WORKER_STATUS_PUBLISH_INTERVAL_MS = 60_000;
/** Three missed one-minute refreshes expire a dead worker's verdict. */
export const VIBE_WORKER_STATUS_TTL_MS =
    3 * VIBE_WORKER_STATUS_PUBLISH_INTERVAL_MS;
const MAX_STATUS_REGISTRY_SIZE = 256;
const V2_STATUS_KEY_PREFIX = "soundspan:vibe-worker-status:v2:";
const V2_STATUS_REGISTRY_KEY = `${V2_STATUS_KEY_PREFIX}registry`;
const V2_CLEANUP_MARKER_KEY =
    "soundspan:vibe-worker-status:v2-registry-cleanup:v1";
const CLEANUP_V2_REGISTRY_SCRIPT = `
if redis.call('GET', KEYS[2]) == 'done' then
    return 0
end
local members = redis.call('ZRANGE', KEYS[1], -256, -1)
for _, key in ipairs(members) do
    if string.sub(key, 1, string.len(ARGV[1])) == ARGV[1] and key ~= KEYS[1] then
        redis.call('DEL', key)
    end
end
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], 'done')
return 1
`;
const PRUNE_STATUS_REGISTRY_SCRIPT = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local count = redis.call('ZCARD', KEYS[1])
local maximum = tonumber(ARGV[2])
if count > maximum then
    redis.call('ZREMRANGEBYRANK', KEYS[1], 0, count - maximum - 1)
end
return count
`;
const WORKER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const log = logger.child("VibeWorkerStatus");

const coverageSchema = z.strictObject({
    embedded: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
});
const workerStatusSchema = z.strictObject({
    providerReachability: z.strictObject({
        reachable: z.boolean(),
        checkedAt: z.iso.datetime(),
        errorClass: z.string().min(1).max(128).optional(),
    }),
    targetSpace: z
        .strictObject({
            id: z.string().min(1),
            family: z.string().min(1),
            status: z.enum(["active", "migrating"]),
        })
        .nullable(),
    coverage: coverageSchema.nullable(),
});

/** Last provider check and target-space state published by one worker. */
export type VibeWorkerStatus = z.infer<typeof workerStatusSchema>;

/** Minimal Redis surface for TTL-bound worker status aggregation. */
export interface VibeWorkerStatusRedis {
    eval(
        script: string,
        options: { keys: string[]; arguments?: string[] },
    ): Promise<unknown>;
    mGet(keys: string[]): Promise<Array<string | null>>;
    set(key: string, value: string, options: { PX: number }): Promise<unknown>;
    zAdd(
        key: string,
        member: { score: number; value: string },
    ): Promise<unknown>;
    zRange(key: string, start: number, stop: number): Promise<string[]>;
    zRem(key: string, members: string[]): Promise<unknown>;
}

async function cleanupV2StatusRegistry(
    redis: VibeWorkerStatusRedis,
): Promise<void> {
    await redis.eval(CLEANUP_V2_REGISTRY_SCRIPT, {
        keys: [V2_STATUS_REGISTRY_KEY, V2_CLEANUP_MARKER_KEY],
        arguments: [V2_STATUS_KEY_PREFIX],
    });
}

async function pruneStatusRegistry(
    redis: VibeWorkerStatusRedis,
    expiryCutoffMs: number,
): Promise<void> {
    await redis.eval(PRUNE_STATUS_REGISTRY_SCRIPT, {
        keys: [VIBE_WORKER_STATUS_REGISTRY_KEY],
        arguments: [String(expiryCutoffMs), String(MAX_STATUS_REGISTRY_SIZE)],
    });
}

function workerStatusKey(workerId: string): string {
    if (!WORKER_ID_PATTERN.test(workerId) || workerId === "registry") {
        throw new Error("Vibe worker id is invalid");
    }
    return `${VIBE_WORKER_STATUS_KEY_PREFIX}${workerId}`;
}

/** Persist one worker snapshot with a bounded heartbeat lifetime. */
export async function writeVibeWorkerStatus(
    redis: VibeWorkerStatusRedis,
    status: VibeWorkerStatus,
    workerId: string,
    now: Date = new Date(),
): Promise<void> {
    const key = workerStatusKey(workerId);
    await redis.set(key, JSON.stringify(status), {
        PX: VIBE_WORKER_STATUS_TTL_MS,
    });
    await redis.zAdd(VIBE_WORKER_STATUS_REGISTRY_KEY, {
        score: now.getTime(),
        value: key,
    });
    await loadFreshStatusValues(redis, now.getTime());
}

function parseWorkerStatus(stored: string | null): VibeWorkerStatus | null {
    if (stored === null) return null;
    try {
        const parsed: unknown = JSON.parse(stored);
        const status = workerStatusSchema.safeParse(parsed);
        return status.success ? status.data : null;
    } catch {
        return null;
    }
}

function isStatusFresh(status: VibeWorkerStatus, nowMs: number): boolean {
    const checkedAtMs = Date.parse(status.providerReachability.checkedAt);
    return nowMs - checkedAtMs <= VIBE_WORKER_STATUS_TTL_MS;
}

function isRegisteredStatusKey(key: string): boolean {
    if (!key.startsWith(VIBE_WORKER_STATUS_KEY_PREFIX)) return false;
    if (key === VIBE_WORKER_STATUS_REGISTRY_KEY) return false;
    return WORKER_ID_PATTERN.test(
        key.slice(VIBE_WORKER_STATUS_KEY_PREFIX.length),
    );
}

async function removeDeadRegistryKeys(
    redis: VibeWorkerStatusRedis,
    keys: string[],
): Promise<void> {
    if (keys.length === 0) return;
    try {
        await redis.zRem(VIBE_WORKER_STATUS_REGISTRY_KEY, keys);
    } catch (error) {
        log.warn("Vibe worker status registry cleanup failed", {
            errorClass: registryErrorClass(error),
        });
    }
}

async function loadFreshStatusValues(
    redis: VibeWorkerStatusRedis,
    nowMs: number,
): Promise<string[]> {
    const expiryCutoffMs = nowMs - VIBE_WORKER_STATUS_TTL_MS;
    await cleanupV2StatusRegistry(redis);
    await pruneStatusRegistry(redis, expiryCutoffMs);
    const members = await redis.zRange(VIBE_WORKER_STATUS_REGISTRY_KEY, 0, -1);
    const keys = members.filter(isRegisteredStatusKey);
    const invalidKeys = members.filter((key) => !isRegisteredStatusKey(key));
    if (keys.length === 0) {
        await removeDeadRegistryKeys(redis, invalidKeys);
        return [];
    }
    const values = await redis.mGet(keys);
    if (values.length !== keys.length) {
        throw new Error("Vibe worker status registry read was incomplete");
    }
    const deadKeys = keys.filter((_key, index) => values[index] === null);
    await removeDeadRegistryKeys(redis, [...invalidKeys, ...deadKeys]);
    const liveValues = values.filter(
        (value): value is string => value !== null,
    );
    const liveKeys = keys.filter((_key, index) => values[index] !== null);
    const excess = liveKeys.length - MAX_STATUS_REGISTRY_SIZE;
    if (excess <= 0) return liveValues;
    await removeDeadRegistryKeys(redis, liveKeys.slice(0, excess));
    return liveValues.slice(excess);
}

/** Read the newest validated, unexpired worker snapshot. */
export async function readVibeWorkerStatus(
    redis: VibeWorkerStatusRedis,
    now: Date = new Date(),
): Promise<VibeWorkerStatus | null> {
    const nowMs = now.getTime();
    const statuses = (await loadFreshStatusValues(redis, nowMs))
        .map(parseWorkerStatus)
        .filter(
            (status): status is VibeWorkerStatus =>
                status !== null && isStatusFresh(status, nowMs),
        );
    if (statuses.length === 0) return null;
    statuses.sort((left, right) =>
        right.providerReachability.checkedAt.localeCompare(
            left.providerReachability.checkedAt,
        ),
    );
    return statuses[0];
}
