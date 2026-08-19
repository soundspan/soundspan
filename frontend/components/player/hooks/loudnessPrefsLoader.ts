"use client";

/**
 * Serialized, generation-fenced loader for the loudness preference
 * snapshot. Each reload starts a new generation: responses and retry
 * timers from older generations are ignored, obsolete queued loads skip
 * before any I/O, and every fetch is chained behind the previous one so
 * the API client's in-flight GET coalescing can never hand a post-save
 * reload the pre-save response.
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

interface LoaderState {
    generation: number;
    retriesUsed: number;
    disposed: boolean;
    retryTimer: ReturnType<typeof setTimeout> | null;
    inFlight: Promise<void>;
    /** True while a continuation is queued but not yet running. */
    queued: boolean;
}

function clearRetry(state: LoaderState): void {
    if (state.retryTimer !== null) {
        clearTimeout(state.retryTimer);
        state.retryTimer = null;
    }
}

function publishSnapshot(
    options: LoudnessPrefsLoaderOptions,
    settingsResult: PromiseSettledResult<unknown>,
    featuresResult: PromiseSettledResult<unknown>,
): boolean {
    const settingsOk =
        settingsResult.status === "fulfilled" && Boolean(settingsResult.value);
    const featuresOk =
        featuresResult.status === "fulfilled" && Boolean(featuresResult.value);
    options.onSnapshot({
        mode: settingsOk ? options.extractMode(settingsResult.value) : null,
        targetLufs: featuresOk
            ? options.extractTarget(featuresResult.value)
            : null,
        complete: settingsOk && featuresOk,
    });
    return settingsOk && featuresOk;
}

function scheduleRetry(
    state: LoaderState,
    options: LoudnessPrefsLoaderOptions,
    loadGeneration: number,
): void {
    if (state.retriesUsed >= options.retryDelaysMs.length) return;
    const delay = options.retryDelaysMs[state.retriesUsed];
    state.retriesUsed += 1;
    state.retryTimer = setTimeout(() => {
        state.retryTimer = null;
        if (loadGeneration === state.generation) enqueue(state, options);
    }, delay);
}

async function run(
    state: LoaderState,
    options: LoudnessPrefsLoaderOptions,
    loadGeneration: number,
): Promise<void> {
    // Obsolete generations skip before any I/O: a disposed loader or a
    // superseded generation never fetches.
    if (state.disposed || loadGeneration !== state.generation) return;
    const [settingsResult, featuresResult] = await Promise.allSettled([
        options.fetchSettings(),
        options.fetchFeatures(),
    ]);
    if (state.disposed || loadGeneration !== state.generation) return;
    const complete = publishSnapshot(options, settingsResult, featuresResult);
    if (!complete) scheduleRetry(state, options, loadGeneration);
}

function enqueue(
    state: LoaderState,
    options: LoudnessPrefsLoaderOptions,
): void {
    // Coalesce: at most one continuation waits behind the in-flight load,
    // and it executes whatever generation is current when it starts — a
    // reload burst therefore costs one queued continuation, not one each.
    if (state.queued) return;
    state.queued = true;
    state.inFlight = state.inFlight
        .catch(() => undefined)
        .then(() => {
            state.queued = false;
            return run(state, options, state.generation);
        });
}

export function createLoudnessPrefsLoader(
    options: LoudnessPrefsLoaderOptions,
): LoudnessPrefsLoader {
    const state: LoaderState = {
        generation: 0,
        retriesUsed: 0,
        disposed: false,
        retryTimer: null,
        inFlight: Promise.resolve(),
        queued: false,
    };
    return {
        start: () => {
            enqueue(state, options);
        },
        reload: () => {
            state.generation += 1;
            state.retriesUsed = 0;
            clearRetry(state);
            enqueue(state, options);
        },
        dispose: () => {
            state.disposed = true;
            clearRetry(state);
        },
    };
}
