/**
 * Bounded polling of the vibe map endpoint until a projection is ready.
 *
 * Pure with respect to React and the browser: the caller supplies the
 * loader and (optionally) the scheduler, so the retry policy is unit-tested
 * without timers or a DOM. The poller owns one AbortController per session;
 * `cancel()` aborts the in-flight request and drops any pending retry.
 */

import type { MapTrack } from "./types";

/** Ready projection payload published by a completed map build. */
export interface VibeMapPayload {
    tracks: MapTrack[];
    trackCount: number;
    /** Browsable embedded tracks when the map was built; absent on older maps. */
    embeddedCount?: number;
    computedAt: string;
    /** True when the server had to project a random subset of the library. */
    sampled?: boolean;
}

/** Server answer: a ready payload, or a build in progress / cooling down. */
export type VibeMapResponse =
    | (VibeMapPayload & { building?: undefined })
    | { building: true; failed?: boolean; retryAt?: string };

/** Callbacks for each terminal or intermediate polling outcome. */
export interface MapPollHandlers {
    onReady(payload: VibeMapPayload): void;
    onBuilding(): void;
    onFailed(retryAt: string | null): void;
    onStalled(): void;
    onError(error: unknown): void;
}

/** Polling cadence and the bound on how long "building" is tolerated. */
export interface MapPollOptions {
    intervalMs: number;
    /** Maximum number of "building" answers before reporting a stall. */
    maxBuildingPolls: number;
    /** Timer injection for tests; returns a canceller. */
    schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** Handle for stopping a poll before it settles. */
export interface MapPollHandle {
    cancel(): void;
}

function scheduleWithTimeout(callback: () => void, delayMs: number) {
    const id = setTimeout(callback, delayMs);
    return () => clearTimeout(id);
}

/** Poll the map loader until it is ready, fails, stalls, or is cancelled. */
export function pollVibeMap(
    load: (signal: AbortSignal) => Promise<VibeMapResponse>,
    handlers: MapPollHandlers,
    options: MapPollOptions,
): MapPollHandle {
    const schedule = options.schedule ?? scheduleWithTimeout;
    const controller = new AbortController();
    let cancelTimer: (() => void) | null = null;
    let buildingPolls = 0;

    function settle(response: VibeMapResponse): void {
        if (!response.building) {
            handlers.onReady(response);
            return;
        }
        if (response.failed) {
            handlers.onFailed(response.retryAt ?? null);
            return;
        }
        buildingPolls += 1;
        if (buildingPolls > options.maxBuildingPolls) {
            handlers.onStalled();
            return;
        }
        handlers.onBuilding();
        cancelTimer = schedule(attempt, options.intervalMs);
    }

    function attempt(): void {
        cancelTimer = null;
        void load(controller.signal).then(
            (response) => {
                if (!controller.signal.aborted) settle(response);
            },
            (error: unknown) => {
                if (!controller.signal.aborted) handlers.onError(error);
            },
        );
    }

    attempt();
    return {
        cancel() {
            cancelTimer?.();
            cancelTimer = null;
            controller.abort();
        },
    };
}
