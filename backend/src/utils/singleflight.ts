/** Options for joining keyed in-flight asynchronous work. */
export interface SingleflightOptions {
    /** Invoked when a caller joins an existing in-flight promise instead of starting a new one. */
    onCoalescedWait?: () => void;
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
