import { z } from "zod";
import { logger } from "../utils/logger";

function registryErrorClass(error: unknown): string {
    if (error instanceof Error && error.name.trim().length > 0) {
        return error.name.slice(0, 128);
    }
    return "UnknownError";
}

/** Namespace for TTL-bound per-worker provider status keys. */
export const VIBE_WORKER_STATUS_KEY_PREFIX = "soundspan:vibe-worker-status:v2:";
/** Exact-key registry used to discover TTL-bound worker snapshots. */
export const VIBE_WORKER_STATUS_REGISTRY_KEY =
    "soundspan:vibe-worker-status:v2:registry";
/** Cadence shared by worker publishing and reader-side freshness checks. */
export const VIBE_WORKER_STATUS_PUBLISH_INTERVAL_MS = 60_000;
/** Three missed one-minute refreshes expire a dead worker's verdict. */
export const VIBE_WORKER_STATUS_TTL_MS =
    3 * VIBE_WORKER_STATUS_PUBLISH_INTERVAL_MS;
const MAX_STATUS_REGISTRY_SIZE = 256;
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
    mGet(keys: string[]): Promise<Array<string | null>>;
    sAdd(key: string, member: string): Promise<unknown>;
    sMembers(key: string): Promise<string[]>;
    sRem(key: string, members: string[]): Promise<unknown>;
    set(key: string, value: string, options: { PX: number }): Promise<unknown>;
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
): Promise<void> {
    const key = workerStatusKey(workerId);
    await redis.sAdd(VIBE_WORKER_STATUS_REGISTRY_KEY, key);
    await redis.set(key, JSON.stringify(status), {
        PX: VIBE_WORKER_STATUS_TTL_MS,
    });
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
        await redis.sRem(VIBE_WORKER_STATUS_REGISTRY_KEY, keys);
    } catch (error) {
        log.warn("Vibe worker status registry cleanup failed", {
            errorClass: registryErrorClass(error),
        });
    }
}

async function loadFreshStatusValues(
    redis: VibeWorkerStatusRedis,
): Promise<string[]> {
    const members = await redis.sMembers(VIBE_WORKER_STATUS_REGISTRY_KEY);
    if (members.length > MAX_STATUS_REGISTRY_SIZE) {
        throw new Error(
            "Vibe worker status registry exceeded its cardinality bound",
        );
    }
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
    return values.filter((value): value is string => value !== null);
}

/** Read the newest validated, unexpired worker snapshot. */
export async function readVibeWorkerStatus(
    redis: VibeWorkerStatusRedis,
    now: Date = new Date(),
): Promise<VibeWorkerStatus | null> {
    const nowMs = now.getTime();
    const statuses = (await loadFreshStatusValues(redis))
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
