import { recordLibraryHealthCacheResult } from "../../metrics";
import type { LibraryHealthCachePanel } from "../../metrics/libraryHealthMetrics";
import { logger } from "../../utils/logger";
import { redisClient } from "../../utils/redis";
import { coalesceInFlightByKey } from "../../utils/singleflight";

const log = logger.child("LibraryHealthDashboard");
const CACHE_TTL_SECONDS = 15 * 60;
const inFlight = new Map<string, Promise<unknown>>();

/** Complete versioned key set; refresh invalidation deletes only these keys. */
export const LIBRARY_HEALTH_CACHE_KEYS = {
    summary: "library-health:v1:summary",
    storage: "library-health:v1:storage",
    quality: "library-health:v1:quality",
    duplicates: "library-health:v1:duplicates",
} as const satisfies Record<LibraryHealthCachePanel, string>;

async function readCachedPanel(panel: LibraryHealthCachePanel) {
    try {
        const value = await redisClient.get(LIBRARY_HEALTH_CACHE_KEYS[panel]);
        if (value === null) {
            recordLibraryHealthCacheResult(panel, "miss");
            return undefined;
        }
        const parsed: unknown = JSON.parse(value);
        recordLibraryHealthCacheResult(panel, "hit");
        return parsed;
    } catch (error) {
        recordLibraryHealthCacheResult(panel, "error");
        log.warn("Library Health cache read failed", { panel, error });
        return undefined;
    }
}

async function writeCachedPanel(
    panel: LibraryHealthCachePanel,
    value: unknown,
): Promise<void> {
    try {
        await redisClient.setEx(
            LIBRARY_HEALTH_CACHE_KEYS[panel],
            CACHE_TTL_SECONDS,
            JSON.stringify(value),
        );
    } catch (error) {
        recordLibraryHealthCacheResult(panel, "error");
        log.warn("Library Health cache write failed", { panel, error });
    }
}

async function loadCachedPanel(
    panel: LibraryHealthCachePanel,
    loader: () => Promise<unknown>,
): Promise<unknown> {
    const cached = await readCachedPanel(panel);
    if (cached !== undefined) return cached;
    const value = await loader();
    await writeCachedPanel(panel, value);
    return value;
}

/** Reads or fills one panel cache while coalescing concurrent process-local fills. */
export function getCachedLibraryHealthPanel<T>(
    panel: LibraryHealthCachePanel,
    loader: () => Promise<T>,
): Promise<T> {
    return coalesceInFlightByKey(
        inFlight,
        LIBRARY_HEALTH_CACHE_KEYS[panel],
        () => loadCachedPanel(panel, loader),
    ) as Promise<T>;
}

/** Deletes every known Library Health dashboard cache key. */
export async function invalidateLibraryHealthDashboardCache(): Promise<void> {
    try {
        await redisClient.del(Object.values(LIBRARY_HEALTH_CACHE_KEYS));
    } catch (error) {
        log.warn("Library Health cache invalidation failed", { error });
    }
}
