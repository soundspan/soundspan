"use client";

/**
 * TravelPanel — the Travel-mode overlay. Presentational: it renders the compass
 * segmented control, the current node + breadcrumb, and the ranked neighbour
 * list (on-map first, then off-map tagged "not on map"). All state + fetching
 * lives in `useVibeMode`; this only calls back.
 *
 * Clicking a neighbour navigates (play + becomes current); shift-click queues
 * it without moving. Loading + error states render inline.
 */

import { ChevronRight, Loader2, X } from "lucide-react";
import { COMPASS_DIRECTIONS, type CompassDirection } from "./travelCompass";
import type { CompassCandidate } from "./travelCompass";
import type { TravelView } from "./useVibeMode";

const DIRECTION_LABEL: Record<CompassDirection, string> = {
    any: "Any",
    happier: "Happier",
    sadder: "Sadder",
    calmer: "Calmer",
    "more-energetic": "Energetic",
};

/** Shared glass surface for the F2 mode panels: floats over the viz, sits to
 *  the left of the top-right ViewControls stack on desktop, and drops to a
 *  bottom sheet below sm. Pair with VIBE_PANEL_STYLE, which anchors the sheet
 *  above the mobile mini player (--vibe-binset, 0px on desktop/fullscreen). */
export const VIBE_PANEL_CLASS =
    "absolute z-40 inset-x-0 sm:inset-x-auto sm:right-20 sm:top-3 " +
    "sm:w-72 max-h-[75%] sm:max-h-[calc(100%-1.5rem)] overflow-y-auto " +
    "bg-black/60 border border-white/10 rounded-t-xl sm:rounded-xl " +
    "backdrop-blur-md px-3 py-3 shadow-lg";

/** Bottom anchor for the mode panels (was `bottom-0`; see VIBE_PANEL_CLASS). */
export const VIBE_PANEL_STYLE: React.CSSProperties = {
    bottom: "var(--vibe-binset, 0px)",
};

/** Close (✕) button with a humane ≥40px hit area, negatively margined so it
 *  doesn't inflate the panel header. */
export const PANEL_CLOSE_CLASS =
    "ml-auto -mr-1.5 -my-1 inline-flex items-center justify-center w-10 h-10 " +
    "rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60";

function NeighborRow({
    n,
    offMap,
    onNavigate,
    onQueue,
}: {
    n: CompassCandidate;
    offMap: boolean;
    onNavigate: (id: string) => void;
    onQueue: (id: string) => void;
}) {
    return (
        <button
            type="button"
            onClick={(e) => (e.shiftKey ? onQueue(n.id) : onNavigate(n.id))}
            title={
                offMap
                    ? "Not on the map — click to play, shift-click to queue"
                    : "Click to travel here, shift-click to queue"
            }
            className="w-full min-h-[44px] text-left flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-white/5 transition-colors"
        >
            <span className="flex-1 min-w-0">
                <span className="block truncate text-[13px] text-white">
                    {n.title}
                </span>
                <span className="block truncate text-xs text-gray-400">
                    {n.artist.name}
                </span>
            </span>
            {offMap && (
                <span className="shrink-0 text-xs uppercase tracking-wide text-amber-400/80 border border-amber-400/30 rounded px-1 py-0.5">
                    not on map
                </span>
            )}
            <span className="shrink-0 text-xs tabular-nums text-indigo-300/80">
                {Math.round(n.similarity * 100)}%
            </span>
        </button>
    );
}

export function TravelPanel({ view }: { view: TravelView }) {
    const {
        currentTitle,
        breadcrumbTitles,
        direction,
        onMapNeighbors,
        offMapNeighbors,
        loading,
        error,
        setDirection,
        navigate,
        queue,
        close,
    } = view;

    const empty =
        !loading &&
        !error &&
        onMapNeighbors.length === 0 &&
        offMapNeighbors.length === 0;

    return (
        <div
            className={VIBE_PANEL_CLASS}
            style={VIBE_PANEL_STYLE}
            data-vibe-panel="travel"
        >
            <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-semibold text-white">Travel</span>
                <button
                    type="button"
                    onClick={close}
                    aria-label="Exit travel (Esc)"
                    title="Exit travel (Esc)"
                    className={PANEL_CLOSE_CLASS}
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            <p className="text-xs text-gray-400 mb-1">
                From <span className="text-white">{currentTitle}</span>
            </p>

            {breadcrumbTitles.length > 1 && (
                <div className="flex items-center flex-wrap gap-0.5 mb-2 text-xs text-gray-400">
                    {breadcrumbTitles.map((b, i) => (
                        <span key={`${b.id}-${i}`} className="flex items-center">
                            {i > 0 && (
                                <ChevronRight className="w-3 h-3 text-gray-600" />
                            )}
                            <span
                                className={
                                    i === breadcrumbTitles.length - 1
                                        ? "text-indigo-300"
                                        : ""
                                }
                            >
                                {b.title}
                            </span>
                        </span>
                    ))}
                </div>
            )}

            {/* Compass segmented control */}
            <div
                role="group"
                aria-label="Compass direction"
                className="grid grid-cols-5 gap-0.5 mb-2 rounded-lg bg-white/5 p-0.5"
            >
                {COMPASS_DIRECTIONS.map((d) => (
                    <button
                        key={d}
                        type="button"
                        onClick={() => setDirection(d)}
                        aria-pressed={direction === d}
                        className={`min-h-[40px] px-1 py-1.5 rounded-md text-xs leading-tight flex items-center justify-center text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${
                            direction === d
                                ? "bg-indigo-500/80 text-white"
                                : "text-gray-300 hover:text-white hover:bg-white/5"
                        }`}
                    >
                        {DIRECTION_LABEL[d]}
                    </button>
                ))}
            </div>

            {loading && (
                <p className="flex items-center gap-2 text-xs text-gray-400 py-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Finding nearby vibes…
                </p>
            )}
            {error && <p className="text-xs text-red-400 py-2">{error}</p>}
            {empty && (
                <p className="text-xs text-gray-400 py-2">
                    No neighbours in this direction — try “Any”.
                </p>
            )}

            <div className="flex flex-col">
                {onMapNeighbors.map((n) => (
                    <NeighborRow
                        key={n.id}
                        n={n}
                        offMap={false}
                        onNavigate={navigate}
                        onQueue={queue}
                    />
                ))}
                {offMapNeighbors.map((n) => (
                    <NeighborRow
                        key={n.id}
                        n={n}
                        offMap
                        onNavigate={navigate}
                        onQueue={queue}
                    />
                ))}
            </div>
        </div>
    );
}
