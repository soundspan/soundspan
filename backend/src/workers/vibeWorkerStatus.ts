import { z } from "zod";

/** Namespace for TTL-bound per-worker provider status keys. */
export const VIBE_WORKER_STATUS_KEY_PREFIX = "soundspan:vibe-worker-status:v2:";
/** Three missed one-minute refreshes expire a dead worker's verdict. */
export const VIBE_WORKER_STATUS_TTL_MS = 180_000;
const MAX_STATUS_SCAN_PAGES = 100;
const STATUS_SCAN_COUNT = 128;

const coverageSchema = z.strictObject({
    embedded: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
});
const workerStatusSchema = z.strictObject({
    providerReachability: z.strictObject({
        reachable: z.boolean(),
        checkedAt: z.iso.datetime(),
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
    scan(
        cursor: string,
        options: { MATCH: string; COUNT: number },
    ): Promise<{ cursor: string; keys: string[] }>;
    set(key: string, value: string, options: { PX: number }): Promise<unknown>;
}

function workerStatusKey(workerId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(workerId)) {
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
    await redis.set(workerStatusKey(workerId), JSON.stringify(status), {
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

async function loadFreshStatusValues(
    redis: VibeWorkerStatusRedis,
): Promise<string[]> {
    let cursor = "0";
    const values: string[] = [];
    for (let page = 0; page < MAX_STATUS_SCAN_PAGES; page += 1) {
        const result = await redis.scan(cursor, {
            MATCH: `${VIBE_WORKER_STATUS_KEY_PREFIX}*`,
            COUNT: STATUS_SCAN_COUNT,
        });
        if (result.keys.length > STATUS_SCAN_COUNT) {
            throw new Error("Vibe worker status scan page exceeded its bound");
        }
        if (result.keys.length > 0) {
            const pageValues = await redis.mGet(result.keys);
            for (const value of pageValues)
                if (value !== null) values.push(value);
        }
        cursor = result.cursor;
        if (cursor === "0") return values;
    }
    throw new Error("Vibe worker status scan exceeded its page bound");
}

/** Read the newest validated, unexpired worker snapshot. */
export async function readVibeWorkerStatus(
    redis: VibeWorkerStatusRedis,
): Promise<VibeWorkerStatus | null> {
    const statuses = (await loadFreshStatusValues(redis))
        .map(parseWorkerStatus)
        .filter((status): status is VibeWorkerStatus => status !== null);
    if (statuses.length === 0) return null;
    statuses.sort((left, right) =>
        right.providerReachability.checkedAt.localeCompare(
            left.providerReachability.checkedAt,
        ),
    );
    return statuses[0];
}
