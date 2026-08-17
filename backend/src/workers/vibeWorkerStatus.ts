import { z } from "zod";

/** Shared Redis key for the worker's last provider and migration snapshot. */
export const VIBE_WORKER_STATUS_KEY = "soundspan:vibe-worker-status:v1";

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

/** Last provider check and target-space state published by the worker. */
export type VibeWorkerStatus = z.infer<typeof workerStatusSchema>;

/** Minimal Redis surface for the compact worker status cache. */
export interface VibeWorkerStatusRedis {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<unknown>;
}

/** Persist a worker-owned status snapshot for API processes and restarts. */
export async function writeVibeWorkerStatus(
    redis: VibeWorkerStatusRedis,
    status: VibeWorkerStatus,
): Promise<void> {
    await redis.set(VIBE_WORKER_STATUS_KEY, JSON.stringify(status));
}

/** Read a validated snapshot; corrupt or obsolete cache values are a miss. */
export async function readVibeWorkerStatus(
    redis: VibeWorkerStatusRedis,
): Promise<VibeWorkerStatus | null> {
    const stored = await redis.get(VIBE_WORKER_STATUS_KEY);
    if (stored === null) return null;
    try {
        const parsed: unknown = JSON.parse(stored);
        const status = workerStatusSchema.safeParse(parsed);
        return status.success ? status.data : null;
    } catch {
        return null;
    }
}
