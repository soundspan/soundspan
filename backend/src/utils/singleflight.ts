/** Options for joining keyed in-flight asynchronous work. */
export interface SingleflightOptions {
    /** Invoked when a caller joins an existing in-flight promise instead of starting a new one. */
    onCoalescedWait?: () => void;
}

/** Callable cached singleflight with explicit settled-value invalidation. */
export interface CachedSingleflight<T> {
    (): Promise<T>;
    clear(): void;
}

/**
 * Coalesce concurrent asynchronous work by key within the provided map.
 * The settled flight clears only its own map slot, preserving any replacement.
 */
export function coalesceInFlightByKey<T>(
    inFlightMap: Map<string, Promise<T>>,
    key: string,
    factory: () => Promise<T>,
    options?: SingleflightOptions,
): Promise<T> {
    const existingPromise = inFlightMap.get(key);
    if (existingPromise) {
        options?.onCoalescedWait?.();
        return existingPromise;
    }

    const inFlightPromise = Promise.resolve()
        .then(factory)
        .finally(() => {
            if (inFlightMap.get(key) === inFlightPromise) {
                inFlightMap.delete(key);
            }
        });
    inFlightMap.set(key, inFlightPromise);
    return inFlightPromise;
}

/**
 * Cache one asynchronous value for a TTL and coalesce concurrent cache fills.
 * Rejected fills are not cached.
 */
export function cachedSingleflight<T>(
    factory: () => Promise<T>,
    ttlMs: number,
): CachedSingleflight<T> {
    let cached: { value: T; expiresAt: number } | null = null;
    let inFlight: Promise<T> | null = null;

    const load = (): Promise<T> => {
        if (cached && cached.expiresAt > Date.now()) {
            return Promise.resolve(cached.value);
        }
        if (inFlight) return inFlight;

        const fill = (async () => factory())()
            .then((value) => {
                cached = { value, expiresAt: Date.now() + ttlMs };
                return value;
            })
            .finally(() => {
                if (inFlight === fill) inFlight = null;
            });
        inFlight = fill;
        return fill;
    };
    load.clear = (): void => {
        cached = null;
    };
    return load;
}
