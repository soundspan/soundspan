"use client";

/**
 * TravelPanel — the Travel-mode overlay. Presentational: it renders the compass
 * segmented control, the current node + breadcrumb, and the ranked neighbour
 * list (on-map first, then off-map tagged "not on map"). All state + fetching
 * lives in `useVibeMode`; this only calls back.
 *
 * Clicking a neighbour navigates (play + becomes current); shift-click queues
 * it without moving. Loading + error states render inline.
 *
 * Each neighbour row also has a chevron/info toggle expanding an inline
 * "why this match" breakdown: the calibrated match sentence plus per-feature
 * (Energy/Mood/Groove/Intensity) origin-vs-candidate bars. Purely
 * presentational and local (which row is expanded) — no extra HTTP, the
 * feature values are already in the candidate payload / origin lookup.
 */

import { ChevronDown, ChevronRight, Loader2, X } from "lucide-react";
import { useState } from "react";
import { COMPASS_DIRECTIONS, type CompassDirection } from "./travelCompass";
import type { CompassCandidate } from "./travelCompass";
import type { TravelView, VibeFeatures } from "./useVibeMode";
import { VibeTrackRow } from "./VibeTrackRow";
import { calibratedMatch, featureMatchPercent } from "./vibeMatch";

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

const FEATURE_LABELS: ReadonlyArray<{ key: keyof VibeFeatures; label: string }> = [
    { key: "energy", label: "Energy" },
    { key: "valence", label: "Mood" },
    { key: "danceability", label: "Groove" },
    { key: "arousal", label: "Intensity" },
];

/** One origin-vs-candidate feature bar, skipped entirely when either side is null. */
function FeatureBar({
    label,
    origin,
    candidate,
}: {
    label: string;
    origin: number | null;
    candidate: number | null;
}) {
    const matchPct = featureMatchPercent(origin, candidate);
    if (matchPct == null) return null;
    const originPct = Math.round(origin! * 100);
    const candidatePct = Math.round(candidate! * 100);
    return (
        <div className="mb-1.5 last:mb-0">
            <div className="flex items-center justify-between text-[10px] text-gray-500 mb-0.5">
                <span>{label}</span>
                <span className="tabular-nums">{matchPct}% match</span>
            </div>
            <div className="relative h-1 rounded-full bg-white/10 overflow-hidden">
                <span
                    className="absolute inset-y-0 left-0 rounded-full bg-indigo-400/80"
                    style={{ width: `${originPct}%` }}
                />
            </div>
            <div className="relative h-1 rounded-full bg-white/10 overflow-hidden mt-0.5">
                <span
                    className="absolute inset-y-0 left-0 rounded-full bg-indigo-300/40"
                    style={{ width: `${candidatePct}%` }}
                />
            </div>
        </div>
    );
}

/** The expanded "why this match" breakdown below a neighbour row. */
function MatchBreakdown({
    n,
    originFeatures,
    quantiles,
}: {
    n: CompassCandidate;
    originFeatures: VibeFeatures | null;
    quantiles: readonly number[] | null;
}) {
    const { percent, label } = calibratedMatch(n.distance, quantiles);
    return (
        <div className="mx-2 mb-1.5 px-2.5 py-2 rounded-lg bg-white/5 border border-white/5">
            <p className="text-xs text-gray-300 mb-2">
                {label
                    ? `Closer than ${percent}% of your library — ${label}.`
                    : `${percent}% match.`}
            </p>
            {FEATURE_LABELS.map(({ key, label: featureLabel }) => (
                <FeatureBar
                    key={key}
                    label={featureLabel}
                    origin={originFeatures ? originFeatures[key] : null}
                    candidate={n[key] ?? null}
                />
            ))}
        </div>
    );
}

/** Exported for direct testing of the expanded "why this match" breakdown —
 *  `expanded` is a plain prop (state lives in the parent TravelPanel), so
 *  static-render tests can force it open without simulating a click. */
export function NeighborRow({
    n,
    offMap,
    onNavigate,
    onQueue,
    quantiles,
    originFeatures,
    expanded,
    onToggleExpand,
}: {
    n: CompassCandidate;
    offMap: boolean;
    onNavigate: (id: string) => void;
    onQueue: (id: string) => void;
    quantiles: readonly number[] | null;
    originFeatures: VibeFeatures | null;
    expanded: boolean;
    onToggleExpand: () => void;
}) {
    return (
        <div className="flex flex-col">
            <div className="flex items-center gap-0.5">
                <VibeTrackRow
                    title={n.title}
                    artistName={n.artist.name}
                    onMap={!offMap}
                    distance={n.distance}
                    quantiles={quantiles}
                    accentClass="text-indigo-300/80"
                    onClick={(e) => (e.shiftKey ? onQueue(n.id) : onNavigate(n.id))}
                    hint={
                        offMap
                            ? "Not on the map — click to play, shift-click to queue"
                            : "Click to travel here, shift-click to queue"
                    }
                    className="flex-1"
                />
                <button
                    type="button"
                    onClick={onToggleExpand}
                    aria-expanded={expanded}
                    aria-label={
                        expanded
                            ? `Hide why ${n.title} matches`
                            : `Show why ${n.title} matches`
                    }
                    title={expanded ? "Hide match breakdown" : "Why this match?"}
                    className="shrink-0 inline-flex items-center justify-center w-8 h-8 -ml-1 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                >
                    {expanded ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                    ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                    )}
                </button>
            </div>
            {expanded && (
                <MatchBreakdown
                    n={n}
                    originFeatures={originFeatures}
                    quantiles={quantiles}
                />
            )}
        </div>
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
        quantiles,
        originFeatures,
        setDirection,
        navigate,
        queue,
        close,
    } = view;

    const [expandedId, setExpandedId] = useState<string | null>(null);
    const toggleExpanded = (id: string) =>
        setExpandedId((prev) => (prev === id ? null : id));

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

            {/* Compass direction chips. Wrapping pills, not a 5-column grid:
                five labels in a ~16rem panel gave each button ~50px and
                "Energetic" crushed into its neighbours. Same chip idiom as
                JourneyPanel's mood picker, so the two panels read alike. */}
            <div
                role="group"
                aria-label="Compass direction"
                className="flex flex-wrap gap-1.5 mb-2"
            >
                {COMPASS_DIRECTIONS.map((d) => (
                    <button
                        key={d}
                        type="button"
                        onClick={() => setDirection(d)}
                        aria-pressed={direction === d}
                        className={`inline-flex items-center min-h-[36px] px-3 py-1.5 rounded-full border text-xs whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${
                            direction === d
                                ? "border-indigo-400/60 bg-indigo-500/30 text-white"
                                : "border-white/10 text-gray-300 hover:bg-white/5 hover:text-white"
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
                        quantiles={quantiles}
                        originFeatures={originFeatures}
                        expanded={expandedId === n.id}
                        onToggleExpand={() => toggleExpanded(n.id)}
                    />
                ))}
                {offMapNeighbors.map((n) => (
                    <NeighborRow
                        key={n.id}
                        n={n}
                        offMap
                        onNavigate={navigate}
                        onQueue={queue}
                        quantiles={quantiles}
                        originFeatures={originFeatures}
                        expanded={expandedId === n.id}
                        onToggleExpand={() => toggleExpanded(n.id)}
                    />
                ))}
            </div>
        </div>
    );
}
