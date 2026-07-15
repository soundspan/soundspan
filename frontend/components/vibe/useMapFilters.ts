/**
 * useMapFilters — pure visibility-mask core + a thin React hook.
 *
 * Filters are non-destructive: they produce a Uint8Array mask (1 = visible,
 * 0 = filtered out) that the canvas renders as full vs 0.05-alpha dots. Dots
 * are never removed.
 *
 * Mood chips are SUBTRACTIVE: `activeMoods` starts containing every mood
 * (nothing is filtered out) and each chip click removes/restores just that
 * mood. An empty set is a legitimate "nothing visible" state, not a special
 * "all pass" case — the count label simply shows 0.
 */

import { useCallback, useMemo, useState } from "react";
import { FILTERABLE_MOODS } from "./types";
import type { MapTrack } from "./types";

/** Minimal shape the pure filter core needs. */
export interface FilterableTrack {
    dominantMood: string;
    energy: number | null;
    valence: number | null;
}

export interface MapFilterState {
    /**
     * Subtractive membership set: a track's `dominantMood` must be in this
     * set to pass. An empty set hides every track (not "all pass").
     */
    activeMoods: ReadonlySet<string>;
    /** Inclusive [lo, hi], each 0..1. A null feature always passes. */
    energyRange: readonly [number, number];
    valenceRange: readonly [number, number];
}

/**
 * Every filterable mood key, in payload order plus the neutral fallback —
 * the default "everything on" set. Sourced from types.ts's FILTERABLE_MOODS
 * so this hook's default, `selectAllMoods()`, and `reset()` all agree with
 * FiltersPanel's chip list on what "every mood" means (see F1 postmortem:
 * neutral-mood tracks used to be excluded from this list and were therefore
 * permanently invisible/un-interactive on the map).
 */
const DEFAULT_MOOD_LIST: readonly string[] = FILTERABLE_MOODS;

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
    const [eLo, eHi] = energyRange;
    const [vLo, vHi] = valenceRange;
    const mask = new Uint8Array(tracks.length);
    for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const moodOk = activeMoods.has(t.dominantMood);
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

/** Pure: toggle `mood`'s membership in `current`; every other mood is untouched. */
export function toggleMoodInSet(
    current: ReadonlySet<string>,
    mood: string
): Set<string> {
    const next = new Set(current);
    if (next.has(mood)) next.delete(mood);
    else next.add(mood);
    return next;
}

/** Pure: solo `mood` — the returned set contains only it. */
export function soloMoodSet(mood: string): Set<string> {
    return new Set([mood]);
}

export interface UseMapFilters {
    activeMoods: ReadonlySet<string>;
    energyRange: [number, number];
    valenceRange: [number, number];
    mask: Uint8Array;
    visibleCount: number;
    /** Toggle exactly one chip; the rest are unaffected. */
    toggleMood: (mood: string) => void;
    /** Shift-click behaviour: isolate exactly this mood. */
    soloMood: (mood: string) => void;
    /** "All" button: restore every mood. */
    selectAllMoods: () => void;
    setEnergyRange: (range: [number, number]) => void;
    setValenceRange: (range: [number, number]) => void;
    reset: () => void;
}

/**
 * Thin hook wrapping the pure core with React state. `moodList` defaults to
 * every known mood key (`MOOD_COLORS`) and seeds the initial "all on" state.
 */
export function useMapFilters(
    tracks: readonly MapTrack[],
    moodList: readonly string[] = DEFAULT_MOOD_LIST
): UseMapFilters {
    const [activeMoods, setActiveMoods] = useState<ReadonlySet<string>>(
        () => new Set(moodList)
    );
    const [energyRange, setEnergyRange] = useState<[number, number]>([0, 1]);
    const [valenceRange, setValenceRange] = useState<[number, number]>([0, 1]);

    const toggleMood = useCallback((mood: string) => {
        setActiveMoods((prev) => toggleMoodInSet(prev, mood));
    }, []);

    const soloMood = useCallback((mood: string) => {
        setActiveMoods(soloMoodSet(mood));
    }, []);

    const selectAllMoods = useCallback(() => {
        setActiveMoods(new Set(moodList));
    }, [moodList]);

    const reset = useCallback(() => {
        setActiveMoods(new Set(moodList));
        setEnergyRange([0, 1]);
        setValenceRange([0, 1]);
    }, [moodList]);

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
        soloMood,
        selectAllMoods,
        setEnergyRange,
        setValenceRange,
        reset,
    };
}
