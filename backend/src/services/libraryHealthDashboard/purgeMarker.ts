import { logger } from "../../utils/logger";
import { redisClient } from "../../utils/redis";
import { withLibraryHealthRedisDeadline } from "./redisDeadline";

const log = logger.child("LibraryHealthPurgeMarker");
const PURGE_ACTIVE_KEY = "library-health:purge-active";
const PURGE_ACTIVE_TTL_SECONDS = 10 * 60;
const NONNEGATIVE_INTEGER_PATTERN = /^(0|[1-9]\d*)$/;

/** Reads the active purge's remaining count, or null when no valid marker exists. */
export async function readLibraryHealthPurgeMarker(): Promise<number | null> {
    try {
        const value = await withLibraryHealthRedisDeadline(
            redisClient.get(PURGE_ACTIVE_KEY),
        );
        if (value === null) return null;
        if (!NONNEGATIVE_INTEGER_PATTERN.test(value)) {
            throw new Error("Library Health purge marker is invalid");
        }
        const remaining = Number(value);
        if (!Number.isSafeInteger(remaining)) {
            throw new Error("Library Health purge marker exceeds safe range");
        }
        return remaining;
    } catch (error) {
        log.warn("Library Health purge marker read failed", { error });
        return null;
    }
}

/** Refreshes the active purge marker and its expiry after a completed page. */
export async function refreshLibraryHealthPurgeMarker(
    remaining: number,
): Promise<void> {
    try {
        if (!Number.isSafeInteger(remaining) || remaining < 0) {
            throw new Error("Library Health purge remaining count is invalid");
        }
        await withLibraryHealthRedisDeadline(
            redisClient.set(PURGE_ACTIVE_KEY, String(remaining), {
                EX: PURGE_ACTIVE_TTL_SECONDS,
            }),
        );
    } catch (error) {
        log.warn("Library Health purge marker refresh failed", { error });
    }
}

/** Removes the active purge marker after the final page completes. */
export async function clearLibraryHealthPurgeMarker(): Promise<void> {
    try {
        await withLibraryHealthRedisDeadline(redisClient.del(PURGE_ACTIVE_KEY));
    } catch (error) {
        log.warn("Library Health purge marker clear failed", { error });
    }
}
