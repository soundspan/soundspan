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
    error: string | null;
    quantiles: readonly number[] | null;
}

function useMapTracks() {
    const [tracks, setTracks] = useState<MapTrack[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let cancelled = false;
        void api.getVibeMap().then((data) => {
            if (!cancelled) setTracks(data.tracks);
        }).catch(() => {
            if (!cancelled) setError("Failed to load vibe map data");
        }).finally(() => {
            if (!cancelled) setLoading(false);
        });
        return () => { cancelled = true; };
    }, []);
    return { tracks, loading, error };
}

function useCalibration(): readonly number[] | null {
    const [quantiles, setQuantiles] = useState<readonly number[] | null>(null);
    useEffect(() => {
        let cancelled = false;
        void api.getVibeCalibration().then((data) => {
            if (!cancelled) setQuantiles(data.sampleSize > 0 ? data.quantiles : null);
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, []);
    return quantiles;
}

/** Load map tracks and best-effort calibration data once per mount. */
export function useVibeMapData(): VibeMapData {
    return { ...useMapTracks(), quantiles: useCalibration() };
}

/** Measure a map container with ResizeObserver. */
export function useMapDimensions(containerRef: RefObject<HTMLElement | null>): MapDims {
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
