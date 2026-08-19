import { recordLibraryHealthCacheResult } from "../../metrics";
import type { LibraryHealthCachePanel } from "../../metrics/libraryHealthMetrics";
import { logger } from "../../utils/logger";
import { redisClient } from "../../utils/redis";
import { coalesceInFlightByKey } from "../../utils/singleflight";
import { LIBRARY_HEALTH_CACHE_ENVELOPE_SCHEMAS } from "./cacheSchemas";
import { withLibraryHealthRedisDeadline } from "./redisDeadline";

const log = logger.child("LibraryHealthDashboard");
const CACHE_TTL_SECONDS = 15 * 60;
const CACHE_GENERATION_KEY = "library-health:v2:generation";
const inFlight = new Map<string, Promise<unknown>>();
const pendingWrites = new Set<Promise<void>>();
const WRITE_IF_GENERATION_MATCHES_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if not current then current = "0" end
if current ~= ARGV[1] then return 0 end
redis.call("SETEX", KEYS[2], ARGV[2], ARGV[3])
return 1
`;

/** Complete versioned key set; refresh invalidation deletes only these keys. */
export const LIBRARY_HEALTH_CACHE_KEYS = {
    summary: "library-health:v2:summary",
    storage: "library-health:v2:storage",
    quality: "library-health:v2:quality",
    duplicates: "library-health:v2:duplicates",
} as const satisfies Record<LibraryHealthCachePanel, string>;

async function deleteCachedPanel(
    panel: LibraryHealthCachePanel,
): Promise<void> {
    try {
        await withLibraryHealthRedisDeadline(
            redisClient.del(LIBRARY_HEALTH_CACHE_KEYS[panel]),
        );
    } catch (error) {
        recordLibraryHealthCacheResult(panel, "error");
        log.warn("Library Health cache delete failed", { panel, error });
    }
}

async function readRawCachedPanel(
    panel: LibraryHealthCachePanel,
): Promise<string | null | undefined> {
    let value: string | null;
    try {
        value = await withLibraryHealthRedisDeadline(
            redisClient.get(LIBRARY_HEALTH_CACHE_KEYS[panel]),
        );
    } catch (error) {
        recordLibraryHealthCacheResult(panel, "error");
        log.warn("Library Health cache read failed", { panel, error });
        return undefined;
    }
    if (value === null) {
        recordLibraryHealthCacheResult(panel, "miss");
        return null;
    }
    return value;
}

async function readCachedPanel(panel: LibraryHealthCachePanel): Promise<{
    cached?: unknown;
    fillGeneration?: string;
}> {
    const [value, generation] = await Promise.all([
        readRawCachedPanel(panel),
        readCacheGeneration(panel),
    ]);
    if (value === null || value === undefined) {
        return { fillGeneration: generation };
    }
    if (generation === undefined) {
        await deleteCachedPanel(panel);
        return {};
    }
    try {
        const result = LIBRARY_HEALTH_CACHE_ENVELOPE_SCHEMAS[panel].safeParse(
            JSON.parse(value) as unknown,
        );
        if (result.success && result.data.generation === generation) {
            recordLibraryHealthCacheResult(panel, "hit");
            return { cached: result.data.payload };
        }
        if (result.success) {
            recordLibraryHealthCacheResult(panel, "miss");
            await deleteCachedPanel(panel);
            return { fillGeneration: generation };
        }
        throw new Error("Library Health cache payload failed validation");
    } catch (error) {
        recordLibraryHealthCacheResult(panel, "error");
        log.warn("Library Health cache payload invalid", { panel, error });
        await deleteCachedPanel(panel);
        return { fillGeneration: generation };
    }
}

async function writeCachedPanel(
    panel: LibraryHealthCachePanel,
    value: unknown,
    generation: string,
): Promise<void> {
    try {
        await withLibraryHealthRedisDeadline(
            redisClient.eval(WRITE_IF_GENERATION_MATCHES_SCRIPT, {
                keys: [CACHE_GENERATION_KEY, LIBRARY_HEALTH_CACHE_KEYS[panel]],
                arguments: [
                    generation,
                    String(CACHE_TTL_SECONDS),
                    JSON.stringify({ generation, payload: value }),
                ],
            }),
        );
    } catch (error) {
        recordLibraryHealthCacheResult(panel, "error");
        log.warn("Library Health cache write failed", { panel, error });
    }
}

function scheduleCacheWrite(
    panel: LibraryHealthCachePanel,
    value: unknown,
    generation: string,
): void {
    const write = writeCachedPanel(panel, value, generation).finally(() => {
        pendingWrites.delete(write);
    });
    pendingWrites.add(write);
}

async function readCacheGeneration(
    panel: LibraryHealthCachePanel,
): Promise<string | undefined> {
    try {
        const generation = await withLibraryHealthRedisDeadline(
            redisClient.get(CACHE_GENERATION_KEY),
        );
        if (generation === null) return "0";
        if (!/^(0|[1-9]\d*)$/.test(generation)) {
            throw new Error("Library Health cache generation is invalid");
        }
        return generation;
    } catch (error) {
        recordLibraryHealthCacheResult(panel, "error");
        log.warn("Library Health cache generation read failed", {
            panel,
            error,
        });
        return undefined;
    }
}

async function loadCachedPanel<T>(
    panel: LibraryHealthCachePanel,
    loader: () => Promise<T>,
): Promise<T> {
    const { cached, fillGeneration } = await readCachedPanel(panel);
    if (cached !== undefined) return cached as T;
    const value = await loader();
    if (fillGeneration !== undefined) {
        scheduleCacheWrite(panel, value, fillGeneration);
    }
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

/** Advances the shared generation fence, then deletes panel keys best-effort. */
export async function invalidateLibraryHealthDashboardCache(): Promise<void> {
    try {
        await withLibraryHealthRedisDeadline(
            redisClient.incr(CACHE_GENERATION_KEY),
        );
    } catch (error) {
        log.warn("Library Health cache generation increment failed", { error });
        throw error;
    }
    inFlight.clear();
    try {
        await withLibraryHealthRedisDeadline(
            redisClient.del(Object.values(LIBRARY_HEALTH_CACHE_KEYS)),
        );
    } catch (error) {
        log.warn("Library Health cache invalidation failed", { error });
    }
}
