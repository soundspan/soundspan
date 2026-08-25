import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";

const SEARCH_CACHE_VERSION_KEY = "search:version";
const searchCacheVersionLogger = logger.child("SearchCacheVersion");

/** Returns the shared search-cache namespace version. */
export async function getSearchCacheVersion(): Promise<number> {
    try {
        const storedVersion = await redisClient.get(SEARCH_CACHE_VERSION_KEY);
        if (storedVersion === null) {
            await redisClient.set(SEARCH_CACHE_VERSION_KEY, "1", { NX: true });
            return 1;
        }

        const version = Number(storedVersion);
        if (Number.isSafeInteger(version) && version > 0) return version;

        searchCacheVersionLogger.warn(
            "Invalid search cache version; using fallback",
            { storedVersion },
        );
    } catch (error) {
        searchCacheVersionLogger.warn(
            "Search cache version read failed; using fallback",
            { error },
        );
    }
    return 1;
}

/** Advances the shared search-cache namespace without failing the mutation. */
export async function bumpSearchCacheVersion(): Promise<void> {
    try {
        await redisClient.incr(SEARCH_CACHE_VERSION_KEY);
    } catch (error) {
        searchCacheVersionLogger.warn("Search cache version bump failed", {
            error,
        });
    }
}
