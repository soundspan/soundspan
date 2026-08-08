"use client";

/** Host-surface state for VibeMap, separate from map interaction state. */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { HINTS_DISMISSED_KEY } from "./mapHints";
import { readStoredString, sessionStorageSafe, writeStoredString } from "./useSessionTrail";
import { useLatest } from "./useLatest";
import { resolveEscapeAction } from "./vibeMapModel";
import type { AuxSurface } from "./useAuxSurface";
import type { VibeMode } from "./vibeModeMachine";

function readHintsDismissed(): boolean {
    return readStoredString(sessionStorageSafe(), HINTS_DISMISSED_KEY) === "1";
}

/** Own fullscreen, filter, hint, highlight, media, and container state. */
export function useVibeMapShell() {
    const containerRef = useRef<HTMLDivElement>(null);
    const [spotlightHighlight, setSpotlightHighlight] = useState<Set<string> | null>(null);
    const [fullscreen, setFullscreen] = useState(false);
    const [filtersExpanded, setFiltersExpanded] = useState(false);
    const [hintsDismissed, setHintsDismissed] = useState(readHintsDismissed);
    const dismissHints = useCallback(() => {
        setHintsDismissed(true);
        writeStoredString(sessionStorageSafe(), HINTS_DISMISSED_KEY, "1");
    }, []);
    return {
        containerRef, spotlightHighlight, setSpotlightHighlight,
        fullscreen, setFullscreen, filtersExpanded, setFiltersExpanded,
        hintsDismissed, dismissHints,
        reducedMotion: useMediaQuery("(prefers-reduced-motion: reduce)"),
        smallScreen: useMediaQuery("(max-width: 639px)"),
        coarsePointer: useMediaQuery("(pointer: coarse)"),
    };
}

interface EscapeArgs {
    sweepOpen: boolean;
    dismissSweep: () => void;
    auxSurface: AuxSurface;
    closeAux: () => void;
    mode: VibeMode;
    exitMode: () => void;
    fullscreen: boolean;
    setFullscreen: (value: boolean) => void;
}

/** Bind the documented Escape priority and own the fullscreen whisper timer. */
export function useVibeMapEscape(args: EscapeArgs): boolean {
    const [hintVisible, setHintVisible] = useState(false);
    const latest = useLatest(args);
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            const current = latest.current;
            const action = resolveEscapeAction(current.sweepOpen, current.auxSurface !== null,
                current.mode, current.fullscreen);
            if (action === "dismiss-sweep") current.dismissSweep();
            else if (action === "close-aux") current.closeAux();
            else if (action === "exit-mode") current.exitMode();
            else if (action === "exit-fullscreen") current.setFullscreen(false);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [latest]);
    useEffect(() => {
        if (!args.fullscreen) {
            setHintVisible(false);
            return;
        }
        setHintVisible(true);
        const timer = setTimeout(() => setHintVisible(false), 2500);
        return () => clearTimeout(timer);
    }, [args.fullscreen]);
    return hintVisible;
}
