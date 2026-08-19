import { logger } from "../../utils/logger";
import { redisClient } from "../../utils/redis";
import { withLibraryHealthRedisDeadline } from "./redisDeadline";

const log = logger.child("LibraryHealthPurgeMarker");
const PURGE_OWNER_KEY = "library-health:purge-active:owners";
const PURGE_REMAINING_KEY = "library-health:purge-active:remaining";
const PURGE_ACTIVE_TTL_SECONDS = 60 * 60;
const NONNEGATIVE_INTEGER_PATTERN = /^(0|[1-9]\d*)$/;
const START_OWNER_SCRIPT = `
redis.call("ZADD", KEYS[1], ARGV[3], ARGV[1])
redis.call("ZADD", KEYS[2], ARGV[2], ARGV[1])
redis.call("EXPIRE", KEYS[1], ARGV[4])
redis.call("EXPIRE", KEYS[2], ARGV[4])
return 1
`;
const REFRESH_OWNER_SCRIPT = `
if not redis.call("ZSCORE", KEYS[1], ARGV[1]) then return 0 end
redis.call("ZADD", KEYS[1], ARGV[3], ARGV[1])
redis.call("ZADD", KEYS[2], ARGV[2], ARGV[1])
redis.call("EXPIRE", KEYS[1], ARGV[4])
redis.call("EXPIRE", KEYS[2], ARGV[4])
return 1
`;
const READ_ACTIVE_SCRIPT = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
if redis.call("ZCARD", KEYS[1]) == 0 then
    redis.call("DEL", KEYS[2])
    return "-1"
end
redis.call(
    "ZINTERSTORE",
    KEYS[2],
    2,
    KEYS[2],
    KEYS[1],
    "WEIGHTS",
    1,
    0,
    "AGGREGATE",
    "SUM"
)
redis.call("EXPIRE", KEYS[2], ${PURGE_ACTIVE_TTL_SECONDS})
local highest = redis.call("ZREVRANGE", KEYS[2], 0, 0, "WITHSCORES")
if not highest[2] then return "-1" end
return highest[2]
`;
const CLEAR_OWNER_SCRIPT = `
redis.call("ZREM", KEYS[1], ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[1])
return 1
`;

function validateSweepId(sweepId: string): void {
    if (sweepId.length === 0 || sweepId.length > 256) {
        throw new Error("Library Health purge sweep id is invalid");
    }
}

function validateRemaining(remaining: number): void {
    if (!Number.isSafeInteger(remaining) || remaining < 0) {
        throw new Error("Library Health purge remaining count is invalid");
    }
}

/** Reads the largest remaining count across active purge sweeps. */
export async function readLibraryHealthPurgeMarker(): Promise<number | null> {
    try {
        const value = await withLibraryHealthRedisDeadline(
            redisClient.eval(READ_ACTIVE_SCRIPT, {
                keys: [PURGE_OWNER_KEY, PURGE_REMAINING_KEY],
                arguments: [String(Date.now())],
            }),
        );
        if (value === "-1") return null;
        if (
            typeof value !== "string" ||
            !NONNEGATIVE_INTEGER_PATTERN.test(value)
        ) {
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

async function writeLibraryHealthPurgeMarker(
    script: string,
    sweepId: string,
    remaining: number,
): Promise<void> {
    try {
        validateSweepId(sweepId);
        validateRemaining(remaining);
        const expiresAt = Date.now() + PURGE_ACTIVE_TTL_SECONDS * 1000;
        await withLibraryHealthRedisDeadline(
            redisClient.eval(script, {
                keys: [PURGE_OWNER_KEY, PURGE_REMAINING_KEY],
                arguments: [
                    sweepId,
                    String(remaining),
                    String(expiresAt),
                    String(PURGE_ACTIVE_TTL_SECONDS),
                ],
            }),
        );
    } catch (error) {
        log.warn("Library Health purge marker refresh failed", { error });
    }
}

/** Establishes one uniquely owned purge-run marker. */
export function startLibraryHealthPurgeMarker(
    sweepRunId: string,
    remaining: number,
): Promise<void> {
    return writeLibraryHealthPurgeMarker(
        START_OWNER_SCRIPT,
        sweepRunId,
        remaining,
    );
}

/** Refreshes an existing purge run without recreating a cleared owner. */
export function refreshLibraryHealthPurgeMarker(
    sweepRunId: string,
    remaining: number,
): Promise<void> {
    return writeLibraryHealthPurgeMarker(
        REFRESH_OWNER_SCRIPT,
        sweepRunId,
        remaining,
    );
}

/** Removes only the completing sweep's ownership marker. */
export async function clearLibraryHealthPurgeMarker(
    sweepId: string,
): Promise<void> {
    try {
        validateSweepId(sweepId);
        await withLibraryHealthRedisDeadline(
            redisClient.eval(CLEAR_OWNER_SCRIPT, {
                keys: [PURGE_OWNER_KEY, PURGE_REMAINING_KEY],
                arguments: [sweepId],
            }),
        );
    } catch (error) {
        log.warn("Library Health purge marker clear failed", { error });
    }
}
