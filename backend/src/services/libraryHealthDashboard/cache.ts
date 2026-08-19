import { recordLibraryHealthCacheResult } from "../../metrics";
import type { LibraryHealthCachePanel } from "../../metrics/libraryHealthMetrics";
import { logger } from "../../utils/logger";
import { redisClient } from "../../utils/redis";
import { coalesceInFlightByKey } from "../../utils/singleflight";
import { LIBRARY_HEALTH_CACHE_SCHEMAS } from "./cacheSchemas";

const log = logger.child("LibraryHealthDashboard");
const CACHE_TTL_SECONDS = 15 * 60;
const CACHE_OPERATION_TIMEOUT_MS = 1_500;
const inFlight = new Map<string, Promise<unknown>>();
const pendingWrites = new Set<Promise<void>>();
let invalidationGeneration = 0;

/** Complete versioned key set; refresh invalidation deletes only these keys. */
export const LIBRARY_HEALTH_CACHE_KEYS = {
    summary: "library-health:v2:summary",
    storage: "library-health:v2:storage",
    quality: "library-health:v2:quality",
    duplicates: "library-health:v2:duplicates",
} as const satisfies Record<LibraryHealthCachePanel, string>;

async function withCacheDeadline<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
            () => reject(new Error("Library Health cache operation timed out")),
            CACHE_OPERATION_TIMEOUT_MS,
        );
    });
    try {
        return await Promise.race([operation, timeout]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

async function deleteCachedPanel(
    panel: LibraryHealthCachePanel,
): Promise<void> {
    try {
        await withCacheDeadline(
            redisClient.del(LIBRARY_HEALTH_CACHE_KEYS[panel]),
        );
    } catch (error) {
        recordLibraryHealthCacheResult(panel, "error");
        log.warn("Library Health cache delete failed", { panel, error });
    }
}

async function readCachedPanel(panel: LibraryHealthCachePanel) {
    let value: string | null;
    try {
        value = await withCacheDeadline(
            redisClient.get(LIBRARY_HEALTH_CACHE_KEYS[panel]),
        );
    } catch (error) {
        recordLibraryHealthCacheResult(panel, "error");
        log.warn("Library Health cache read failed", { panel, error });
        return undefined;
    }
    if (value === null) {
        recordLibraryHealthCacheResult(panel, "miss");
        return undefined;
    }
    try {
        const result = LIBRARY_HEALTH_CACHE_SCHEMAS[panel].safeParse(
            JSON.parse(value) as unknown,
        );
        if (result.success) {
            recordLibraryHealthCacheResult(panel, "hit");
            return result.data;
        }
        throw new Error("Library Health cache payload failed validation");
    } catch (error) {
        recordLibraryHealthCacheResult(panel, "error");
        log.warn("Library Health cache payload invalid", { panel, error });
        await deleteCachedPanel(panel);
        return undefined;
    }
}

async function writeCachedPanel(
    panel: LibraryHealthCachePanel,
    value: unknown,
): Promise<void> {
    try {
        await withCacheDeadline(
            redisClient.setEx(
                LIBRARY_HEALTH_CACHE_KEYS[panel],
                CACHE_TTL_SECONDS,
                JSON.stringify(value),
            ),
        );
    } catch (error) {
        recordLibraryHealthCacheResult(panel, "error");
        log.warn("Library Health cache write failed", { panel, error });
    }
}

function scheduleCacheWrite(
    panel: LibraryHealthCachePanel,
    value: unknown,
): void {
    const write = writeCachedPanel(panel, value).finally(() => {
        pendingWrites.delete(write);
    });
    pendingWrites.add(write);
}

async function loadCachedPanel<T>(
    panel: LibraryHealthCachePanel,
    loader: () => Promise<T>,
    fillGeneration: number,
): Promise<T> {
    const cached = await readCachedPanel(panel);
    if (cached !== undefined) return cached as T;
    const value = await loader();
    if (fillGeneration === invalidationGeneration) {
        scheduleCacheWrite(panel, value);
    }
    return value;
}

/** Reads or fills one panel cache while coalescing concurrent process-local fills. */
export function getCachedLibraryHealthPanel<T>(
    panel: LibraryHealthCachePanel,
    loader: () => Promise<T>,
): Promise<T> {
    const fillGeneration = invalidationGeneration;
    return coalesceInFlightByKey(
        inFlight,
        LIBRARY_HEALTH_CACHE_KEYS[panel],
        () => loadCachedPanel(panel, loader, fillGeneration),
    ) as Promise<T>;
}

/** Deletes every known Library Health dashboard cache key. */
export async function invalidateLibraryHealthDashboardCache(): Promise<void> {
    invalidationGeneration += 1;
    inFlight.clear();
    try {
        await withCacheDeadline(
            redisClient.del(Object.values(LIBRARY_HEALTH_CACHE_KEYS)),
        );
    } catch (error) {
        log.warn("Library Health cache invalidation failed", { error });
    }
}
