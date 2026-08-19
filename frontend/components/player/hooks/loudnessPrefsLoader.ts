"use client";

/**
 * Serialized, generation-fenced loader for the loudness preference
 * snapshot. Each reload starts a new generation: responses and retry
 * timers from older generations are ignored, and every fetch is chained
 * behind the previous one so the API client's in-flight GET coalescing
 * can never hand a post-save reload the pre-save response.
 */

export interface LoudnessPrefsSnapshot {
    /** Parsed mode, or null when the settings request failed. */
    mode: string | null;
    /** Server target, or null when the features request failed or omitted it. */
    targetLufs: number | null;
    /** True when both requests succeeded (no retry needed). */
    complete: boolean;
}

interface LoudnessPrefsLoaderOptions {
    fetchSettings: () => Promise<unknown>;
    fetchFeatures: () => Promise<unknown>;
    extractMode: (settings: unknown) => string;
    extractTarget: (features: unknown) => number | null;
    onSnapshot: (snapshot: LoudnessPrefsSnapshot) => void;
    retryDelaysMs: readonly number[];
}

export interface LoudnessPrefsLoader {
    /** Starts the initial load. */
    start: () => void;
    /** Invalidates in-flight work and loads a fresh snapshot. */
    reload: () => void;
    /** Cancels timers and ignores every outstanding response. */
    dispose: () => void;
}

export function createLoudnessPrefsLoader(
    options: LoudnessPrefsLoaderOptions,
): LoudnessPrefsLoader {
    let generation = 0;
    let retriesUsed = 0;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> = Promise.resolve();

    const clearRetry = () => {
        if (retryTimer !== null) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
    };

    const run = async (loadGeneration: number): Promise<void> => {
        const [settingsResult, featuresResult] = await Promise.allSettled([
            options.fetchSettings(),
            options.fetchFeatures(),
        ]);
        if (disposed || loadGeneration !== generation) return;
        const settingsOk =
            settingsResult.status === "fulfilled" &&
            Boolean(settingsResult.value);
        const featuresOk =
            featuresResult.status === "fulfilled" &&
            Boolean(featuresResult.value);
        options.onSnapshot({
            mode: settingsOk ? options.extractMode(settingsResult.value) : null,
            targetLufs: featuresOk
                ? options.extractTarget(featuresResult.value)
                : null,
            complete: settingsOk && featuresOk,
        });
        const shouldRetry =
            (!settingsOk || !featuresOk) &&
            retriesUsed < options.retryDelaysMs.length;
        if (shouldRetry) {
            const delay = options.retryDelaysMs[retriesUsed];
            retriesUsed += 1;
            retryTimer = setTimeout(() => {
                retryTimer = null;
                if (loadGeneration === generation) enqueue(loadGeneration);
            }, delay);
        }
    };

    const enqueue = (loadGeneration: number) => {
        inFlight = inFlight
            .catch(() => undefined)
            .then(() => run(loadGeneration));
    };

    return {
        start: () => {
            enqueue(generation);
        },
        reload: () => {
            generation += 1;
            retriesUsed = 0;
            clearRetry();
            enqueue(generation);
        },
        dispose: () => {
            disposed = true;
            clearRetry();
        },
    };
}
