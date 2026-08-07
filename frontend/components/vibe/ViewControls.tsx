"use client";

/**
 * ViewControls — the top-right floating vertical stack of map view controls,
 * extracted out of VibeMap's old header row. Icon buttons with humane hit
 * targets (min 40×40, 44×44 under a coarse pointer), tooltips, aria-labels and
 * aria-pressed on the toggle-like ones.
 *
 * Buttons: zoom in / zoom out / reset view / spread-cluster toggle / sweep
 * brush / locate-now-playing / start-journey / show-queue / session-trail
 * settings / about-this-map / fullscreen toggle. (Start-journey lives here
 * because removing the old header row removed its only entry point; it is
 * disabled until there's a track to journey from, or while alchemy is active
 * — a half-built blend must not be silently destroyed. The brush toggle is
 * the touch-friendly way to arm sweep — mouse users can just hold Shift and
 * drag.)
 *
 * The queue button carries a small corner badge (count of upcoming queue
 * items, capped at "99+") — VibeMap owns the open/closed state (like
 * filtersExpanded) and the QueuePanel it toggles.
 *
 * The trail button opens a small anchored popover (three-way On/Fade/Off
 * segmented control + "Clear history" + "Save history as playlist").
 * The about button opens a legend/cheat-sheet popover explaining the map's
 * visual language (mood colors, line/glyph meanings, gesture verbs) and that
 * distance on the map is meaningful only locally — neighborhoods cluster real
 * similarity, but long distances aren't a proportional "twice as different"
 * scale, and shown percentages are calibrated against the library, not fixed.
 * Both are purely presentational: this component renders them when their
 * `*PopoverOpen` prop is true and reports every action back up. VibeMap owns
 * ALL of queue/trail/about as one exclusive `auxSurface` state — opening one
 * closes the other two, so they can never z-fight or ghost against each
 * other or the mode panels (F2 travel/journey/alchemy). The about popover
 * used to be self-contained local state (no external side effects, same
 * pattern FiltersPanel's own expanded/collapsed state still uses) but is now
 * lifted for that exclusivity, exactly like the trail popover already was.
 */

import {
    Brush,
    Crosshair,
    Footprints,
    HelpCircle,
    ListMusic,
    ListPlus,
    Loader2,
    Maximize2,
    Minimize2,
    Network,
    RotateCcw,
    Route,
    Shuffle,
    ZoomIn,
    ZoomOut,
} from "lucide-react";
import { Fragment } from "react";
import { FILTERABLE_MOODS, VIBE_ACCENTS, getMoodColor, moodLabel } from "./types";

export type LayoutMode = "natural" | "spread";

/** "on": full trail. "fade": age-fades and eventually drops old entries.
 *  "off": hidden entirely (beacon + flight plan unaffected). */
export type TrailMode = "on" | "fade" | "off";

const TRAIL_MODE_OPTIONS: readonly { mode: TrailMode; label: string }[] = [
    { mode: "on", label: "On" },
    { mode: "fade", label: "Fade" },
    { mode: "off", label: "Off" },
];

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
    /** Queue panel open state + toggle, and a count of upcoming queue items
     *  (badge, capped display at "99+"; hidden entirely at 0). */
    queueOpen: boolean;
    onToggleQueue: () => void;
    queueCount: number;
    /** Session trail: display mode + the settings popover's open state. */
    trailMode: TrailMode;
    onSetTrailMode: (mode: TrailMode) => void;
    trailPopoverOpen: boolean;
    onToggleTrailPopover: () => void;
    /** Disables "Clear history" / "Save history as playlist" when empty. */
    trailEmpty: boolean;
    onClearTrail: () => void;
    /** Save the full stored trail (oldest -> newest) as a new playlist. */
    onSaveTrail: () => void;
    /** True while the trail save is in flight — disables the save button. */
    trailSaving?: boolean;
    /** About-this-map popover open state + toggle — lifted into VibeMap's
     *  exclusive `auxSurface`, same prop pattern as the trail popover. */
    aboutPopoverOpen: boolean;
    onToggleAboutPopover: () => void;
    isFullscreen: boolean;
    onToggleFullscreen: () => void;
}

const BTN =
    "vibe-ctrl-btn flex items-center justify-center w-10 h-10 rounded-lg " +
    "text-gray-300 hover:text-white hover:bg-white/10 transition-colors " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 " +
    "disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-300";

// z-50: explicit belt-and-braces so these popovers always paint above the
// VIBE_PANEL_CLASS mode/queue panels (z-40) even though `auxSurface`
// exclusivity (VibeMap) means they should never actually coexist with one.
const POPOVER_CLASS =
    "absolute right-full top-0 mr-2 p-2 flex flex-col gap-2 z-50 " +
    "bg-black/60 backdrop-blur-md border border-white/10 rounded-xl shadow-lg";

function MoodLegend() {
    return (
        <div className="flex flex-wrap gap-1.5">
            {FILTERABLE_MOODS.map((mood) => (
                <span
                    key={mood}
                    className="inline-flex items-center gap-1.5 text-xs text-gray-300"
                >
                    <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: getMoodColor(mood) }}
                    />
                    {moodLabel(mood)}
                </span>
            ))}
        </div>
    );
}

function GlyphLegend() {
    return (
        <ul className="flex flex-col gap-1.5 text-xs text-gray-300">
            <li className="flex items-center gap-2">
                <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{
                        backgroundColor: VIBE_ACCENTS.edge,
                        boxShadow: `0 0 4px 1px ${VIBE_ACCENTS.edge}`,
                    }}
                />
                Beacon — now playing
            </li>
            <li className="flex items-center gap-2">
                <span
                    className="w-4 h-0 shrink-0 border-t-2"
                    style={{ borderColor: VIBE_ACCENTS.trail }}
                />
                Solid fading line — your listening trail
            </li>
            <li className="flex items-center gap-2">
                <span
                    className="w-4 h-0 shrink-0 border-t-2 border-dashed"
                    style={{ borderColor: VIBE_ACCENTS.plan }}
                />
                Dashed line — upcoming queue (flight plan)
            </li>
        </ul>
    );
}

function GestureCheatSheet() {
    const gestures: Array<[string, string]> = [
        ["Click", "Travel"],
        ["Shift-drag", "Sweep-to-queue"],
        ["Ctrl/⌘-click", "Add to alchemy"],
        ["Wheel / pinch", "Zoom"],
        ["Esc", "Back"],
    ];
    return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-xs">
            {gestures.map(([gesture, action]) => (
                <Fragment key={gesture}>
                    <dt className="text-gray-400">{gesture}</dt>
                    <dd className="text-gray-300">{action}</dd>
                </Fragment>
            ))}
        </dl>
    );
}

/** Exported for direct testing — the toggle button's open state is local to
 *  ViewControls, so a static-render test can't click it open; rendering the
 *  popover directly verifies its content instead. */
export function AboutMapPopover() {
    return (
        <div
            role="dialog"
            aria-label="About this map"
            className={`${POPOVER_CLASS} w-72 max-h-[70vh] overflow-y-auto`}
        >
            <p className="text-xs text-gray-300 leading-relaxed">
                Dots are songs, placed by overall sound (a CLAP embedding,
                projected with UMAP). Tracks that sound alike cluster
                together — <strong className="text-white">neighborhoods are
                meaningful, but long distances aren&apos;t proportional</strong>:
                “half a screen apart” doesn&apos;t mean “twice as different” as
                a track a quarter-screen away. Percentages shown in panels are
                calibrated against random pairs from your own library.
            </p>
            <div>
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">
                    Mood colors
                </p>
                <MoodLegend />
            </div>
            <div>
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">
                    Lines &amp; glyphs
                </p>
                <GlyphLegend />
            </div>
            <div>
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">
                    Gestures
                </p>
                <GestureCheatSheet />
            </div>
        </div>
    );
}

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
    queueOpen,
    onToggleQueue,
    queueCount,
    trailMode,
    onSetTrailMode,
    trailPopoverOpen,
    onToggleTrailPopover,
    trailEmpty,
    onClearTrail,
    onSaveTrail,
    trailSaving,
    aboutPopoverOpen,
    onToggleAboutPopover,
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
            {/* Accent-tinted when usable: with 15k dots this is the one
                button people actually hunt for, so it must not read as just
                another gray icon in the stack. */}
            <button
                type="button"
                onClick={onLocate}
                disabled={!canLocate}
                className={
                    canLocate
                        ? "vibe-ctrl-btn flex items-center justify-center w-10 h-10 rounded-lg " +
                          "text-indigo-300 bg-indigo-500/15 hover:text-white hover:bg-indigo-500/30 transition-colors " +
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                        : BTN
                }
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
            <div className="relative">
                <button
                    type="button"
                    onClick={onToggleQueue}
                    aria-pressed={queueOpen}
                    className={`${BTN} ${queueOpen ? "bg-white/10 text-white" : ""}`}
                    title="Show queue"
                    aria-label="Show queue"
                >
                    <ListMusic className="w-5 h-5" />
                </button>
                {queueCount > 0 && (
                    <span
                        aria-hidden="true"
                        className="pointer-events-none absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-indigo-500 text-white text-[10px] font-bold flex items-center justify-center leading-none"
                    >
                        {queueCount > 99 ? "99+" : queueCount}
                    </span>
                )}
            </div>
            <div className="relative">
                <button
                    type="button"
                    onClick={onToggleTrailPopover}
                    aria-pressed={trailMode !== "off"}
                    aria-expanded={trailPopoverOpen}
                    className={`${BTN} ${trailPopoverOpen ? "bg-white/10 text-white" : ""}`}
                    title="Session trail settings"
                    aria-label="Session trail settings"
                >
                    <Footprints className="w-5 h-5" />
                </button>
                {trailPopoverOpen && (
                    <div
                        role="menu"
                        aria-label="Trail display"
                        className={`${POPOVER_CLASS} w-44`}
                    >
                        <div
                            role="radiogroup"
                            aria-label="Trail mode"
                            className="flex rounded-lg overflow-hidden border border-white/10"
                        >
                            {TRAIL_MODE_OPTIONS.map(({ mode, label }) => (
                                <button
                                    key={mode}
                                    type="button"
                                    role="radio"
                                    aria-checked={trailMode === mode}
                                    onClick={() => onSetTrailMode(mode)}
                                    className={`flex-1 py-1 text-xs transition-colors ${
                                        trailMode === mode
                                            ? "bg-indigo-500/40 text-white"
                                            : "text-gray-300 hover:bg-white/10"
                                    }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                        <button
                            type="button"
                            onClick={onClearTrail}
                            disabled={trailEmpty}
                            className="text-left px-2 py-1.5 rounded-lg text-xs text-gray-300 hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                        >
                            Clear history
                        </button>
                        <button
                            type="button"
                            onClick={onSaveTrail}
                            disabled={trailEmpty || trailSaving}
                            className="flex items-center gap-1.5 text-left px-2 py-1.5 rounded-lg text-xs text-gray-300 hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                        >
                            {trailSaving ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                                <ListPlus className="w-3.5 h-3.5" />
                            )}
                            Save history as playlist
                        </button>
                    </div>
                )}
            </div>
            <div className="relative">
                <button
                    type="button"
                    onClick={onToggleAboutPopover}
                    aria-expanded={aboutPopoverOpen}
                    className={`${BTN} ${aboutPopoverOpen ? "bg-white/10 text-white" : ""}`}
                    title="About this map"
                    aria-label="About this map"
                >
                    <HelpCircle className="w-5 h-5" />
                </button>
                {aboutPopoverOpen && <AboutMapPopover />}
            </div>

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
