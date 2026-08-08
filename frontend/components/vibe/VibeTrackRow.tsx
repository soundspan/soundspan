"use client";

/**
 * VibeTrackRow — the shared track-row presentation for the three vibe-map
 * result lists (TravelPanel's neighbour rows, JourneyPanel's numbered
 * waypoints, AlchemyTray's blend results). They rendered near-identical
 * markup independently (title/artist, an "not on map" badge, a similarity
 * percent) with their own `Math.round(similarity * 100)%` — this is the ONE
 * place that now computes the library-calibrated match percent
 * (`calibratedMatch`, `vibeMatch.ts`) so a calibration fix or relabeling
 * never has to land in three files again.
 *
 * Renders a clickable `<button>` when `onClick` is supplied (Travel's
 * navigate/shift-click-to-queue row), otherwise a plain, non-interactive
 * container (Journey's waypoint `<li>` content, Alchemy's result row) — the
 * caller supplies any outer semantic wrapper (e.g. JourneyPanel's `<li>`).
 */

import { calibratedMatch } from "./vibeMatch";

export interface VibeTrackRowProps {
    title: string;
    artistName: string;
    /** Whether this track is plotted on the current map sample. */
    onMap: boolean;
    /** Raw pairwise CLAP cosine distance — calibratedMatch's display source. */
    distance: number;
    /** Library-calibrated distance quantiles, or null (uncalibrated fallback). */
    quantiles: readonly number[] | null;
    /** Tailwind text-color class for the percent readout (per-surface accent). */
    accentClass: string;
    /** 1-based sequence badge (journey waypoints). Omit for no badge. */
    seq?: number;
    /** Wraps the row in a clickable button instead of a static container. */
    onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    /** Button title/tooltip — only meaningful when `onClick` is supplied. */
    hint?: string;
    /** Extra wrapper class names (layout tweaks between call sites). */
    className?: string;
}

function TrackRowContent({
    title, artistName, onMap, percent, label, accentClass, seq,
}: Pick<VibeTrackRowProps, "title" | "artistName" | "onMap" | "accentClass" | "seq"> & {
    percent: number;
    label: string;
}) {
    return (
        <>
            {seq != null && (
                <span className="shrink-0 w-5 h-5 grid place-items-center rounded-full bg-indigo-500/30 text-xs tabular-nums text-indigo-200">
                    {seq}
                </span>
            )}
            <span className="flex-1 min-w-0">
                <span className="block truncate text-[13px] text-white">{title}</span>
                <span className="block truncate text-xs text-gray-400">{artistName}</span>
            </span>
            {!onMap && (
                <span className="shrink-0 text-xs uppercase tracking-wide text-amber-400/80 border border-amber-400/30 rounded px-1 py-0.5">
                    not on map
                </span>
            )}
            <span className={`shrink-0 text-xs tabular-nums ${accentClass}`}
                title={label || undefined}>{percent}%</span>
        </>
    );
}

export function VibeTrackRow({
    title,
    artistName,
    onMap,
    distance,
    quantiles,
    accentClass,
    seq,
    onClick,
    hint,
    className,
}: VibeTrackRowProps) {
    const { percent, label } = calibratedMatch(distance, quantiles);

    const inner = <TrackRowContent title={title} artistName={artistName}
        onMap={onMap} percent={percent} label={label} accentClass={accentClass} seq={seq} />;

    if (onClick) {
        return (
            <button
                type="button"
                onClick={onClick}
                title={hint}
                className={`w-full min-h-[44px] text-left flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-white/5 transition-colors ${className ?? ""}`}
            >
                {inner}
            </button>
        );
    }

    return (
        <div className={`flex items-center gap-2 px-1 py-1.5 ${className ?? ""}`}>
            {inner}
        </div>
    );
}
