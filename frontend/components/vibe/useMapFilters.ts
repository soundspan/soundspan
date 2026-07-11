/**
 * useMapFilters — pure visibility-mask core + a thin React hook.
 *
 * Filters are non-destructive: they produce a Uint8Array mask (1 = visible,
 * 0 = filtered out) that the canvas renders as full vs 0.05-alpha dots. Dots
 * are never removed.
 */

import { useCallback, useMemo, useState } from "react";
import type { MapTrack } from "./types";

/** Minimal shape the pure filter core needs. */
export interface FilterableTrack {
    dominantMood: string;
    energy: number | null;
    valence: number | null;
}

export interface MapFilterState {
    /** Empty set = all moods pass. Otherwise a track's dominantMood must be in it. */
    activeMoods: ReadonlySet<string>;
    /** Inclusive [lo, hi], each 0..1. A null feature always passes. */
    energyRange: readonly [number, number];
    valenceRange: readonly [number, number];
}

function inRange(v: number | null, lo: number, hi: number): boolean {
    if (v == null) return true; // null features pass range filters
    return v >= lo && v <= hi;
}

/**
 * Pure: compute the per-track visibility mask. Index-aligned with `tracks`.
 */
export function computeVisibilityMask(
    tracks: readonly FilterableTrack[],
    filters: MapFilterState
): Uint8Array {
    const { activeMoods, energyRange, valenceRange } = filters;
    const allMoodsPass = activeMoods.size === 0;
    const [eLo, eHi] = energyRange;
    const [vLo, vHi] = valenceRange;
    const mask = new Uint8Array(tracks.length);
    for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const moodOk = allMoodsPass || activeMoods.has(t.dominantMood);
        mask[i] =
            moodOk && inRange(t.energy, eLo, eHi) && inRange(t.valence, vLo, vHi)
                ? 1
                : 0;
    }
    return mask;
}

export function countVisible(mask: Uint8Array): number {
    let n = 0;
    for (let i = 0; i < mask.length; i++) n += mask[i];
    return n;
}

export interface UseMapFilters {
    activeMoods: ReadonlySet<string>;
    energyRange: [number, number];
    valenceRange: [number, number];
    mask: Uint8Array;
    visibleCount: number;
    toggleMood: (mood: string) => void;
    setEnergyRange: (range: [number, number]) => void;
    setValenceRange: (range: [number, number]) => void;
    reset: () => void;
}

/** Thin hook wrapping the pure core with React state. */
export function useMapFilters(tracks: readonly MapTrack[]): UseMapFilters {
    const [activeMoods, setActiveMoods] = useState<ReadonlySet<string>>(
        () => new Set()
    );
    const [energyRange, setEnergyRange] = useState<[number, number]>([0, 1]);
    const [valenceRange, setValenceRange] = useState<[number, number]>([0, 1]);

    const toggleMood = useCallback((mood: string) => {
        setActiveMoods((prev) => {
            const next = new Set(prev);
            if (next.has(mood)) next.delete(mood);
            else next.add(mood);
            return next;
        });
    }, []);

    const reset = useCallback(() => {
        setActiveMoods(new Set());
        setEnergyRange([0, 1]);
        setValenceRange([0, 1]);
    }, []);

    const mask = useMemo(
        () =>
            computeVisibilityMask(tracks, {
                activeMoods,
                energyRange,
                valenceRange,
            }),
        [tracks, activeMoods, energyRange, valenceRange]
    );
    const visibleCount = useMemo(() => countVisible(mask), [mask]);

    return {
        activeMoods,
        energyRange,
        valenceRange,
        mask,
        visibleCount,
        toggleMood,
        setEnergyRange,
        setValenceRange,
        reset,
    };
}
