import { redisClient } from "./redis";

const MAX_KV_TTL_SECONDS = 24 * 60 * 60;

function validateKeyAndTtl(key: string, ttlSeconds: number): void {
    if (!key) throw new Error("Redis key is required");
    if (
        !Number.isSafeInteger(ttlSeconds) ||
        ttlSeconds < 1 ||
        ttlSeconds > MAX_KV_TTL_SECONDS
    ) {
        throw new Error("Redis TTL is outside the supported range");
    }
}

/** Stores a JSON value only when the key does not already exist. */
export async function putOnce(
    key: string,
    value: unknown,
    ttlSeconds: number,
): Promise<boolean> {
    validateKeyAndTtl(key, ttlSeconds);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Redis value is not JSON");
    const result = await redisClient.set(key, serialized, {
        EX: ttlSeconds,
        NX: true,
    });
    return result === "OK";
}

/** Atomically reads and deletes a single-use JSON value. */
export async function takeOnce(key: string): Promise<unknown | null> {
    if (!key) throw new Error("Redis key is required");
    const serialized = await redisClient.getDel(key);
    return serialized === null ? null : (JSON.parse(serialized) as unknown);
}
