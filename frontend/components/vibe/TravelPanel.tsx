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

export const VIBE_PANEL_CLASS =
    "absolute z-20 inset-x-0 bottom-0 sm:inset-x-auto sm:right-3 sm:top-3 " +
    "sm:w-72 max-h-[70%] sm:max-h-[calc(100%-1.5rem)] overflow-y-auto " +
    "bg-black/90 border border-white/10 rounded-t-xl sm:rounded-xl " +
    "backdrop-blur px-3 py-3 shadow-xl";

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
            className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded hover:bg-white/5 transition-colors"
        >
            <span className="flex-1 min-w-0">
                <span className="block truncate text-xs text-white">
                    {n.title}
                </span>
                <span className="block truncate text-[10px] text-gray-500">
                    {n.artist.name}
                </span>
            </span>
            {offMap && (
                <span className="shrink-0 text-[9px] uppercase tracking-wide text-amber-400/80 border border-amber-400/30 rounded px-1 py-0.5">
                    not on map
                </span>
            )}
            <span className="shrink-0 text-[10px] tabular-nums text-indigo-300/80">
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
        <div className={VIBE_PANEL_CLASS} data-vibe-panel="travel">
            <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-semibold text-white">Travel</span>
                <button
                    type="button"
                    onClick={close}
                    aria-label="Exit travel (Esc)"
                    title="Exit travel (Esc)"
                    className="ml-auto text-gray-500 hover:text-white transition-colors"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            <p className="text-[11px] text-gray-400 mb-1">
                From <span className="text-white">{currentTitle}</span>
            </p>

            {breadcrumbTitles.length > 1 && (
                <div className="flex items-center flex-wrap gap-0.5 mb-2 text-[10px] text-gray-500">
                    {breadcrumbTitles.map((b, i) => (
                        <span key={`${b.id}-${i}`} className="flex items-center">
                            {i > 0 && (
                                <ChevronRight className="w-3 h-3 text-gray-700" />
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
                className="grid grid-cols-5 gap-0.5 mb-2 rounded bg-white/5 p-0.5"
            >
                {COMPASS_DIRECTIONS.map((d) => (
                    <button
                        key={d}
                        type="button"
                        onClick={() => setDirection(d)}
                        aria-pressed={direction === d}
                        className={`text-[9px] py-1 rounded transition-colors ${
                            direction === d
                                ? "bg-indigo-500/80 text-white"
                                : "text-gray-400 hover:text-white"
                        }`}
                    >
                        {DIRECTION_LABEL[d]}
                    </button>
                ))}
            </div>

            {loading && (
                <p className="flex items-center gap-2 text-[11px] text-gray-500 py-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Finding nearby vibes…
                </p>
            )}
            {error && <p className="text-[11px] text-red-400 py-2">{error}</p>}
            {empty && (
                <p className="text-[11px] text-gray-500 py-2">
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
