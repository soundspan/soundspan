"use client";

/**
 * useAuxSurface — one exclusive owner for the map's top-right auxiliary
 * surfaces: the queue panel, the trail popover and the about popover
 * (`null` = none open).
 *
 * Before this they were three independent booleans: the trail/about popovers
 * had no z-index of their own and rendered UNDER the queue panel, and the
 * queue panel used a visibility gate rather than actually closing, so it
 * ghosted back open after leaving a mode. One `auxSurface` slot fixes both:
 * opening one surface always closes the other two, and entering any vibe
 * mode / a sweep chip appearing genuinely CLOSES it (state back to null)
 * instead of merely hiding it.
 */

import { useCallback, useEffect, useState } from "react";
import type { VibeMode } from "./vibeModeMachine";

export type AuxSurface = "queue" | "trail" | "about" | null;

export interface UseAuxSurface {
    auxSurface: AuxSurface;
    /** True while any surface is open. */
    auxOpen: boolean;
    /**
     * Toggle semantics: opening a surface closes whichever other one (if
     * any) was open; clicking the currently-open surface's own button closes
     * it.
     */
    toggleAuxSurface: (surface: Exclude<AuxSurface, null>) => void;
    closeAux: () => void;
}

export interface UseAuxSurfaceArgs {
    /** The current vibe mode — any non-explore transition closes the surface. */
    mode: VibeMode;
    /** A live sweep chip claims the same slot — its appearance closes the surface. */
    sweepChipOpen: boolean;
}

export function useAuxSurface({
    mode,
    sweepChipOpen,
}: UseAuxSurfaceArgs): UseAuxSurface {
    const [auxSurface, setAuxSurface] = useState<AuxSurface>(null);

    const toggleAuxSurface = useCallback(
        (surface: Exclude<AuxSurface, null>) => {
            setAuxSurface((cur) => (cur === surface ? null : surface));
        },
        []
    );

    const closeAux = useCallback(() => setAuxSurface(null), []);

    // Exclusivity, part 1: entering (or switching) any vibe mode genuinely
    // CLOSES the open surface — not just hides it, so it can't ghost back
    // once the mode exits. Opening a surface WHILE a mode is already active
    // is still allowed (the mode panel yields to it visually); this effect
    // only fires on a mode transition, not on that deliberate reopen.
    useEffect(() => {
        if (mode !== "explore") setAuxSurface(null);
    }, [mode]);

    // Exclusivity, part 2: a live sweep chip claims the same bottom-center /
    // mobile-sheet slot the queue panel can occupy — close (not hide) the
    // moment the chip appears.
    useEffect(() => {
        if (sweepChipOpen) setAuxSurface(null);
    }, [sweepChipOpen]);

    return { auxSurface, auxOpen: auxSurface !== null, toggleAuxSurface, closeAux };
}
