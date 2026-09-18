"use client";

/** Bounded lifecycle hooks for VibeMap data and container measurement. */

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type RefObject,
} from "react";
import { api } from "@/lib/api";
import {
    pollVibeMap,
    type MapPollHandle,
    type MapPollHandlers,
    type VibeMapPayload,
} from "./mapLoader";
import type { MapRebuildState } from "./mapStatus";
import type { MapDims } from "./mapViewport";
import type { MapTrack } from "./types";

/** Map API state consumed by the controller. */
export interface VibeMapData {
    tracks: MapTrack[];
    trackCount: number;
    /** ISO timestamp of the build behind `tracks`; null until first load. */
    computedAt: string | null;
    /** True when the server projected a random subset of the library. */
    sampled: boolean;
    loading: boolean;
    building: boolean;
    error: string | null;
    rebuildState: MapRebuildState;
    /** Ask the server for a fresh build; keeps the current dots on screen. */
    rebuild: () => void;
    quantiles: readonly number[] | null;
}

const BUILDING_POLL_MS = 5000;
const BUILDING_POLL_LIMIT = 120;
const STALLED_MESSAGE =
    "The map is still being built — try again in a few minutes";
const FAILED_MESSAGE =
    "The last map build failed. It will retry automatically — check back in a few minutes.";
const LOAD_ERROR_MESSAGE = "Failed to load vibe map data";

type MapLoadState = Omit<VibeMapData, "rebuild" | "quantiles">;

const INITIAL_STATE: MapLoadState = {
    tracks: [],
    trackCount: 0,
    computedAt: null,
    sampled: false,
    loading: true,
    building: false,
    error: null,
    rebuildState: "idle",
};

type Patch = (patch: Partial<MapLoadState>) => void;

function readyPatch(payload: VibeMapPayload): Partial<MapLoadState> {
    return {
        tracks: payload.tracks,
        trackCount: payload.trackCount,
        computedAt: payload.computedAt,
        sampled: payload.sampled === true,
        loading: false,
        building: false,
        error: null,
        rebuildState: "idle",
    };
}

/** First load: the map has nothing to show, so state drives the overlay. */
function initialLoadHandlers(update: Patch): MapPollHandlers {
    const settled = { loading: false, building: false };
    return {
        onReady: (payload) => update(readyPatch(payload)),
        onBuilding: () => update({ loading: true, building: true }),
        onFailed: () => update({ ...settled, error: FAILED_MESSAGE }),
        onStalled: () => update({ ...settled, error: STALLED_MESSAGE }),
        onError: () => update({ ...settled, error: LOAD_ERROR_MESSAGE }),
    };
}

/** Rebuild: the stale map stays visible and only the chip reports progress. */
function rebuildHandlers(update: Patch): MapPollHandlers {
    return {
        onReady: (payload) => update(readyPatch(payload)),
        onBuilding: () => update({ rebuildState: "building" }),
        onFailed: () => update({ rebuildState: "failed" }),
        onStalled: () => update({ rebuildState: "stalled" }),
        onError: () => update({ rebuildState: "error" }),
    };
}

function useMapTracks(): MapLoadState & { rebuild: () => void } {
    const [state, setState] = useState<MapLoadState>(INITIAL_STATE);
    const pollRef = useRef<MapPollHandle | null>(null);
    const rebuildRequestRef = useRef<AbortController | null>(null);
    const update = useCallback<Patch>((patch) => {
        setState((previous) => ({ ...previous, ...patch }));
    }, []);
    const startPolling = useCallback((handlers: MapPollHandlers) => {
        pollRef.current?.cancel();
        pollRef.current = pollVibeMap(
            (signal) => api.getVibeMap({ signal }),
            handlers,
            {
                intervalMs: BUILDING_POLL_MS,
                maxBuildingPolls: BUILDING_POLL_LIMIT,
            },
        );
    }, []);

    useEffect(() => {
        startPolling(initialLoadHandlers(update));
        return () => {
            pollRef.current?.cancel();
            pollRef.current = null;
            rebuildRequestRef.current?.abort();
            rebuildRequestRef.current = null;
        };
    }, [startPolling, update]);

    // The request is owned by this hook: unmount aborts it and nothing
    // that resolves afterwards may start a poller or touch state.
    const rebuild = useCallback(() => {
        rebuildRequestRef.current?.abort();
        const controller = new AbortController();
        rebuildRequestRef.current = controller;
        update({ rebuildState: "requesting" });
        void api.rebuildVibeMap({ signal: controller.signal }).then(
            () => {
                if (controller.signal.aborted) return;
                startPolling(rebuildHandlers(update));
            },
            () => {
                if (controller.signal.aborted) return;
                update({ rebuildState: "error" });
            },
        );
    }, [startPolling, update]);

    return { ...state, rebuild };
}

function useCalibration(): readonly number[] | null {
    const [quantiles, setQuantiles] = useState<readonly number[] | null>(null);
    useEffect(() => {
        let cancelled = false;
        void api
            .getVibeCalibration()
            .then((data) => {
                if (!cancelled)
                    setQuantiles(data.sampleSize > 0 ? data.quantiles : null);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, []);
    return quantiles;
}

/** Load map tracks and best-effort calibration data once per mount. */
export function useVibeMapData(): VibeMapData {
    return { ...useMapTracks(), quantiles: useCalibration() };
}

/** Measure a map container with ResizeObserver. */
export function useMapDimensions(
    containerRef: RefObject<HTMLElement | null>,
): MapDims {
    const [dims, setDims] = useState<MapDims>({ width: 0, height: 0 });
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const measure = () => {
            const rect = container.getBoundingClientRect();
            setDims({ width: rect.width, height: rect.height });
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        return () => observer.disconnect();
    }, [containerRef]);
    return dims;
}
