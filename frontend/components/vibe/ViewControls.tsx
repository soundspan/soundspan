"use client";

/**
 * ViewControls — the top-right floating vertical stack of map view controls,
 * extracted out of VibeMap's old header row. Icon buttons with humane hit
 * targets (min 40×40, 44×44 under a coarse pointer), tooltips, aria-labels and
 * aria-pressed on the toggle-like ones.
 *
 * Buttons: zoom in / zoom out / reset view / spread-cluster toggle / sweep
 * brush / locate-now-playing / start-journey / fullscreen toggle.
 * (Start-journey lives here because removing the old header row removed its
 * only entry point; it is disabled until there's a track to journey from. The
 * brush toggle is the touch-friendly way to arm sweep — mouse users can just
 * hold Shift and drag.)
 */

import {
    Brush,
    Crosshair,
    Maximize2,
    Minimize2,
    Network,
    RotateCcw,
    Route,
    Shuffle,
    ZoomIn,
    ZoomOut,
} from "lucide-react";

export type LayoutMode = "natural" | "spread";

export interface ViewControlsProps {
    onZoomIn: () => void;
    onZoomOut: () => void;
    onReset: () => void;
    layoutMode: LayoutMode;
    layoutDisabled?: boolean;
    onToggleLayout: () => void;
    /** Sweep brush armed: dragging collects tracks instead of panning. */
    brushArmed: boolean;
    onToggleBrush: () => void;
    canLocate: boolean;
    locateHint: string;
    onLocate: () => void;
    canStartJourney: boolean;
    journeyHint: string;
    onStartJourney: () => void;
    isFullscreen: boolean;
    onToggleFullscreen: () => void;
}

const BTN =
    "vibe-ctrl-btn flex items-center justify-center w-10 h-10 rounded-lg " +
    "text-gray-300 hover:text-white hover:bg-white/10 transition-colors " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 " +
    "disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-300";

export function ViewControls({
    onZoomIn,
    onZoomOut,
    onReset,
    layoutMode,
    layoutDisabled,
    onToggleLayout,
    brushArmed,
    onToggleBrush,
    canLocate,
    locateHint,
    onLocate,
    canStartJourney,
    journeyHint,
    onStartJourney,
    isFullscreen,
    onToggleFullscreen,
}: ViewControlsProps) {
    const spread = layoutMode === "spread";
    return (
        <div className="pointer-events-auto flex flex-col gap-1 p-1 bg-black/60 backdrop-blur-md border border-white/10 rounded-xl shadow-lg">
            <button
                type="button"
                onClick={onZoomIn}
                className={BTN}
                title="Zoom in"
                aria-label="Zoom in"
            >
                <ZoomIn className="w-5 h-5" />
            </button>
            <button
                type="button"
                onClick={onZoomOut}
                className={BTN}
                title="Zoom out"
                aria-label="Zoom out"
            >
                <ZoomOut className="w-5 h-5" />
            </button>
            <button
                type="button"
                onClick={onReset}
                className={BTN}
                title="Reset view"
                aria-label="Reset view"
            >
                <RotateCcw className="w-5 h-5" />
            </button>

            <span className="mx-2 my-0.5 h-px bg-white/10" aria-hidden="true" />

            <button
                type="button"
                onClick={onToggleLayout}
                disabled={layoutDisabled}
                aria-pressed={spread}
                className={BTN}
                title={
                    spread
                        ? "Cluster: return to the natural layout"
                        : "Spread: uniformly space out crowded clusters"
                }
                aria-label={spread ? "Cluster layout" : "Spread layout"}
            >
                {spread ? (
                    <Network className="w-5 h-5" />
                ) : (
                    <Shuffle className="w-5 h-5" />
                )}
            </button>
            <button
                type="button"
                onClick={onToggleBrush}
                aria-pressed={brushArmed}
                className={`${BTN} ${brushArmed ? "bg-indigo-500/30 text-white" : ""}`}
                title={
                    brushArmed
                        ? "Sweep brush armed — drag over dots to collect a queue (click to disarm)"
                        : "Sweep brush: drag over dots to collect a queue (or hold Shift and drag)"
                }
                aria-label="Sweep brush"
            >
                <Brush className="w-5 h-5" />
            </button>
            <button
                type="button"
                onClick={onLocate}
                disabled={!canLocate}
                className={BTN}
                title={locateHint}
                aria-label="Locate now playing"
            >
                <Crosshair className="w-5 h-5" />
            </button>
            <button
                type="button"
                onClick={onStartJourney}
                disabled={!canStartJourney}
                className={BTN}
                title={journeyHint}
                aria-label="Start a journey"
            >
                <Route className="w-5 h-5" />
            </button>

            <span className="mx-2 my-0.5 h-px bg-white/10" aria-hidden="true" />

            <button
                type="button"
                onClick={onToggleFullscreen}
                aria-pressed={isFullscreen}
                className={BTN}
                title={isFullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
                aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            >
                {isFullscreen ? (
                    <Minimize2 className="w-5 h-5" />
                ) : (
                    <Maximize2 className="w-5 h-5" />
                )}
            </button>

            <style>{`
                @media (pointer: coarse) {
                    .vibe-ctrl-btn { min-width: 44px; min-height: 44px; }
                }
            `}</style>
        </div>
    );
}
