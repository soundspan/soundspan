/** Shared status-cache entry shape used by album provider gap-fill hooks. */
export interface ProviderStatusCacheEntry {
    available: boolean;
    checkedAt: number;
}

/** Positive availability cache window to avoid repeated status calls when healthy. */
export const PROVIDER_STATUS_POSITIVE_TTL_MS = 60_000;

/** Negative availability cache window kept short to recover quickly after transient failures. */
export const PROVIDER_STATUS_NEGATIVE_TTL_MS = 5_000;

/**
 * Returns true when a cached provider-status entry should be reused.
 * Negative entries intentionally expire faster than positive entries.
 */
export function isProviderStatusCacheFresh(
    entry: ProviderStatusCacheEntry,
    now: number = Date.now()
): boolean {
    const ttlMs = entry.available
        ? PROVIDER_STATUS_POSITIVE_TTL_MS
        : PROVIDER_STATUS_NEGATIVE_TTL_MS;
    return now - entry.checkedAt < ttlMs;
}

/** Builds a status-cache entry anchored to the provided timestamp. */
export function createProviderStatusCacheEntry(
    available: boolean,
    now: number = Date.now()
): ProviderStatusCacheEntry {
    return {
        available,
        checkedAt: now,
    };
}
