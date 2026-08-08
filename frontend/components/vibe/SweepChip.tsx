"use client";

/**
 * SweepChip — the floating action chip shown when a sweep stroke ends with
 * collected tracks: "N tracks swept · Play · Queue · ✕". Presentational; the
 * sweep gesture, collection and playback wiring live in VibeMap.
 *
 * Sits bottom-center, lifted above the mobile mini player via --vibe-binset
 * (the same clearance var the filter pill and mode sheets use).
 */

import { ListPlus, Loader2, Play, X } from "lucide-react";

export interface SweepChipProps {
    count: number;
    /** True when the sweep stopped collecting at the cap. */
    capped: boolean;
    onPlay: () => void;
    onQueue: () => void;
    /** Save the swept tracks as a new playlist. */
    onSave: () => void;
    /** True while the save is in flight — disables Play/Queue/Save. */
    saving?: boolean;
    onDismiss: () => void;
}

const ACTION_CLASS =
    "flex items-center gap-1.5 h-9 px-3 rounded-full text-xs font-medium " +
    "text-gray-200 hover:text-white hover:bg-white/10 transition-colors " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 " +
    "disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-200";

function SweepActions({ count, saving, onPlay, onQueue, onSave }: Pick<
    SweepChipProps, "count" | "saving" | "onPlay" | "onQueue" | "onSave"
>) {
    return (
        <>
            <button type="button" onClick={onPlay} disabled={saving}
                className={ACTION_CLASS} aria-label={`Play ${count} swept tracks`}>
                <Play className="w-4 h-4" /> Play
            </button>
            <button type="button" onClick={onQueue} disabled={saving}
                className={ACTION_CLASS} aria-label={`Queue ${count} swept tracks`}>
                <ListPlus className="w-4 h-4" /> Queue
            </button>
            <button type="button" onClick={onSave} disabled={saving}
                className={ACTION_CLASS} aria-label={`Save ${count} swept tracks as a playlist`}
                title="Save as playlist">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <ListPlus className="w-4 h-4" />}
                Save
            </button>
        </>
    );
}

export function SweepChip({
    count,
    capped,
    onPlay,
    onQueue,
    onSave,
    saving,
    onDismiss,
}: SweepChipProps) {
    return (
        <div
            className="absolute left-1/2 -translate-x-1/2 z-40"
            style={{ bottom: "calc(1rem + var(--vibe-binset, 0px))" }}
            data-vibe-panel="sweep"
        >
            <div className="pointer-events-auto flex items-center gap-0.5 rounded-full bg-black/70 backdrop-blur-md border border-white/10 shadow-lg pl-3 pr-1 py-1">
                <span className="text-sm text-white tabular-nums whitespace-nowrap mr-1">
                    {count} track{count === 1 ? "" : "s"} swept
                    {capped ? " (max)" : ""}
                </span>
                <SweepActions count={count} saving={saving} onPlay={onPlay}
                    onQueue={onQueue} onSave={onSave} />
                <button
                    type="button"
                    onClick={onDismiss}
                    aria-label="Dismiss sweep"
                    title="Dismiss (Esc)"
                    className="flex items-center justify-center w-9 h-9 rounded-full text-gray-400 hover:text-white hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
}
