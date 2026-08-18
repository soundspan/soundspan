"use client";

/** Bounded lifecycle hooks for VibeMap data and container measurement. */

import { useEffect, useState, type RefObject } from "react";
import { api } from "@/lib/api";
import type { MapDims } from "./mapViewport";
import type { MapTrack } from "./types";

/** Map API state consumed by the controller. */
export interface VibeMapData {
    tracks: MapTrack[];
    loading: boolean;
    building: boolean;
    error: string | null;
    quantiles: readonly number[] | null;
}

const BUILDING_POLL_MS = 5000;
const BUILDING_POLL_LIMIT = 120;

function useMapTracks() {
    const [tracks, setTracks] = useState<MapTrack[]>([]);
    const [loading, setLoading] = useState(true);
    const [building, setBuilding] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let cancelled = false;
        let attempts = 0;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const load = () => {
            void api
                .getVibeMap()
                .then((data) => {
                    if (cancelled) return;
                    if (data.building) {
                        attempts += 1;
                        if (attempts > BUILDING_POLL_LIMIT) {
                            setBuilding(false);
                            setLoading(false);
                            setError(
                                "The map is still being built — try again in a few minutes",
                            );
                            return;
                        }
                        setBuilding(true);
                        timer = setTimeout(load, BUILDING_POLL_MS);
                        return;
                    }
                    setBuilding(false);
                    setTracks(data.tracks);
                    setLoading(false);
                })
                .catch(() => {
                    if (cancelled) return;
                    setBuilding(false);
                    setLoading(false);
                    setError("Failed to load vibe map data");
                });
        };
        load();
        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
        };
    }, []);
    return { tracks, loading: loading || building, building, error };
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
