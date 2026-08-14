/** Minimal ioredis surface required for atomic enrichment queue admission. */
export interface EnrichmentQueueRedis {
    eval(
        script: string,
        numberOfKeys: number,
        ...args: string[]
    ): Promise<unknown>;
}

/** Outcome returned by atomic enrichment queue admission. */
export type EnrichmentQueueAdmission = "queued" | "duplicate" | "full";

interface EnqueueReservedWorkInput {
    queueKey: string;
    trackId: string;
    payload: string;
    maxDepth: number;
    reservationTtlSeconds: number;
}

const ADMIT_WORK_SCRIPT = `
local depth = redis.call("LLEN", KEYS[1])
if depth >= tonumber(ARGV[1]) then
    return -1
end
local reserved = redis.call("SET", KEYS[2], "1", "NX", "EX", ARGV[2])
if not reserved then
    return 0
end
redis.call("RPUSH", KEYS[1], ARGV[3])
return 1
`;

/** Atomically enforce queue depth and a per-track enqueue reservation. */
export async function enqueueReservedWork(
    redis: EnrichmentQueueRedis,
    input: EnqueueReservedWorkInput,
): Promise<EnrichmentQueueAdmission> {
    const result = await redis.eval(
        ADMIT_WORK_SCRIPT,
        2,
        input.queueKey,
        `${input.queueKey}:reserved:${input.trackId}`,
        String(input.maxDepth),
        String(input.reservationTtlSeconds),
        input.payload,
    );

    if (result === 1) return "queued";
    if (result === 0) return "duplicate";
    if (result === -1) return "full";
    throw new Error(`Unexpected enrichment queue admission result: ${result}`);
}
