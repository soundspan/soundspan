import { randomUUID } from "node:crypto";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";

const log = logger.child("VibeMapBuildState");
const BUILD_LEASE_PREFIX = "vibe-map:build-lease";
const BUILD_FAILURE_PREFIX = "vibe-map:build-failed";
const BUILD_FAILURE_COUNT_PREFIX = "vibe-map:build-failure-count";
const FAILURE_HISTORY_TTL_SECONDS = 24 * 60 * 60;
const FAILURE_COOLDOWN_SECONDS = [5 * 60, 15 * 60, 60 * 60] as const;

/** Lease lifetime exceeds three sequential 15-minute worker attempts. */
export const VIBE_MAP_BUILD_LEASE_TTL_SECONDS = 60 * 60;
const BUILD_LEASE_REFRESH_MS = 5 * 60 * 1000;

const REFRESH_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
`;
const RELEASE_LEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Retry-suppression state stored for one failed projection build. */
export interface VibeMapBuildFailure {
    attempt: number;
    error: string;
    failedAt: string;
    retryAt: string;
}

/** Owned distributed lease for one space's projection build. */
export class VibeMapBuildLease {
    private refreshTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly spaceId: string,
        private readonly token: string,
    ) {
        this.refreshTimer = setInterval(() => {
            this.refresh().catch((error: unknown) => {
                log.warn("Failed to refresh vibe map build lease", error);
            });
        }, BUILD_LEASE_REFRESH_MS);
        this.refreshTimer.unref?.();
    }

    private async refresh(): Promise<void> {
        const refreshed = await redisClient.eval(REFRESH_LEASE_SCRIPT, {
            keys: [buildLeaseKey(this.spaceId)],
            arguments: [this.token, String(VIBE_MAP_BUILD_LEASE_TTL_SECONDS)],
        });
        if (Number(refreshed) !== 1) {
            log.warn("Vibe map build lease ownership was lost", {
                spaceId: this.spaceId,
            });
        }
    }

    /** Stop refreshes without deleting the lease so its TTL can recover ownership. */
    abandon(): void {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        this.refreshTimer = null;
    }

    /** Stop refreshes and release the lease only when this owner still holds it. */
    async release(): Promise<void> {
        this.abandon();
        await redisClient.eval(RELEASE_LEASE_SCRIPT, {
            keys: [buildLeaseKey(this.spaceId)],
            arguments: [this.token],
        });
    }
}

function buildLeaseKey(spaceId: string): string {
    return `${BUILD_LEASE_PREFIX}:${spaceId}`;
}

function buildFailureKey(spaceId: string): string {
    return `${BUILD_FAILURE_PREFIX}:${spaceId}`;
}

function buildFailureCountKey(spaceId: string): string {
    return `${BUILD_FAILURE_COUNT_PREFIX}:${spaceId}`;
}

function parseFailureMarker(raw: string): VibeMapBuildFailure | null {
    try {
        const parsed = JSON.parse(raw) as Partial<VibeMapBuildFailure>;
        const valid =
            Number.isSafeInteger(parsed.attempt) &&
            Number(parsed.attempt) > 0 &&
            typeof parsed.error === "string" &&
            parsed.error.length > 0 &&
            typeof parsed.failedAt === "string" &&
            Number.isFinite(Date.parse(parsed.failedAt)) &&
            typeof parsed.retryAt === "string" &&
            Number.isFinite(Date.parse(parsed.retryAt));
        return valid ? (parsed as VibeMapBuildFailure) : null;
    } catch {
        return null;
    }
}

/** Acquire the per-space build lease with Redis NX admission. */
export async function acquireVibeMapBuildLease(
    spaceId: string,
): Promise<VibeMapBuildLease | null> {
    const token = randomUUID();
    const acquired = await redisClient.set(buildLeaseKey(spaceId), token, {
        NX: true,
        EX: VIBE_MAP_BUILD_LEASE_TTL_SECONDS,
    });
    return acquired === "OK" ? new VibeMapBuildLease(spaceId, token) : null;
}

/** Read a live retry-suppression marker, treating malformed state as a miss. */
export async function readVibeMapBuildFailure(
    spaceId: string,
): Promise<VibeMapBuildFailure | null> {
    const key = buildFailureKey(spaceId);
    const raw = await redisClient.get(key);
    if (!raw) return null;
    const marker = parseFailureMarker(raw);
    if (marker) return marker;
    log.warn("Discarding malformed vibe map build failure marker", { spaceId });
    await redisClient.del(key);
    return null;
}

/** Record a failed build with 5m, 15m, then capped 60m cooldowns. */
export async function recordVibeMapBuildFailure(
    spaceId: string,
    errorSummary: string,
    failedAt: Date = new Date(),
): Promise<VibeMapBuildFailure> {
    const countKey = buildFailureCountKey(spaceId);
    const attempt = await redisClient.incr(countKey);
    await redisClient.expire(countKey, FAILURE_HISTORY_TTL_SECONDS);
    const cooldownIndex = Math.min(
        attempt - 1,
        FAILURE_COOLDOWN_SECONDS.length - 1,
    );
    const cooldownSeconds = FAILURE_COOLDOWN_SECONDS[cooldownIndex];
    const marker: VibeMapBuildFailure = {
        attempt,
        error: errorSummary.slice(0, 500),
        failedAt: failedAt.toISOString(),
        retryAt: new Date(
            failedAt.getTime() + cooldownSeconds * 1000,
        ).toISOString(),
    };
    await redisClient.setEx(
        buildFailureKey(spaceId),
        cooldownSeconds,
        JSON.stringify(marker),
    );
    return marker;
}

/** Reset escalation after a successful build. */
export async function clearVibeMapBuildFailures(
    spaceId: string,
): Promise<void> {
    await redisClient.del([
        buildFailureKey(spaceId),
        buildFailureCountKey(spaceId),
    ]);
}
