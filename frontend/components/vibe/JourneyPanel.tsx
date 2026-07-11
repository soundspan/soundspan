"use client";

/**
 * JourneyPanel — the Journey/Drift-mode overlay. Presentational: destination is
 * either a map dot ("pick on map") or a mood chip (disabled when the bucket is
 * too thin to route). Submitting draws + lists the numbered waypoint route;
 * "Play journey" queues it. The Drift section is the one-shot shortcut: a
 * "drift toward <mood>" button per mood that journeys 12 steps from now-playing.
 */

import { Loader2, MapPin, Play, Route, X } from "lucide-react";
import { VIBE_PANEL_CLASS } from "./TravelPanel";
import type { JourneyView } from "./useVibeMode";

/** Mood buckets thinner than this can't seed a journey (mirrors the backend). */
const MIN_MOOD_TRACKS = 5;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function JourneyPanel({ view }: { view: JourneyView }) {
    const {
        fromLabel,
        picking,
        destTrackId,
        destLabel,
        moodTarget,
        steps,
        moods,
        targetLabel,
        waypoints,
        loading,
        error,
        canSubmit,
        togglePick,
        chooseMood,
        setSteps,
        submit,
        drift,
        play,
        close,
    } = view;

    const driftable = moods.filter((m) => m.trackCount >= MIN_MOOD_TRACKS);

    return (
        <div className={VIBE_PANEL_CLASS} data-vibe-panel="journey">
            <div className="flex items-center gap-2 mb-2">
                <Route className="w-3.5 h-3.5 text-indigo-300" />
                <span className="text-xs font-semibold text-white">Journey</span>
                <button
                    type="button"
                    onClick={close}
                    aria-label="Exit journey (Esc)"
                    title="Exit journey (Esc)"
                    className="ml-auto text-gray-500 hover:text-white transition-colors"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            <p className="text-[11px] text-gray-400 mb-2">
                From <span className="text-white">{fromLabel}</span>
            </p>

            {/* Destination: pick-on-map or a mood chip */}
            <p className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">
                Destination
            </p>
            <button
                type="button"
                onClick={togglePick}
                aria-pressed={picking}
                className={`w-full flex items-center gap-2 px-2 py-1.5 mb-2 rounded border text-[11px] transition-colors ${
                    picking
                        ? "border-indigo-400/60 bg-indigo-500/20 text-white"
                        : "border-white/10 text-gray-300 hover:bg-white/5"
                }`}
            >
                <MapPin className="w-3.5 h-3.5" />
                {picking
                    ? "Click a dot to set destination…"
                    : destTrackId
                      ? `Destination: ${destLabel}`
                      : "Pick a destination on the map"}
            </button>

            <div className="flex flex-wrap gap-1 mb-3">
                {moods.map((m) => {
                    const thin = m.trackCount < MIN_MOOD_TRACKS;
                    const active = moodTarget === m.mood;
                    return (
                        <button
                            key={m.mood}
                            type="button"
                            disabled={thin}
                            onClick={() => chooseMood(m.mood)}
                            aria-pressed={active}
                            title={
                                thin
                                    ? "Not enough analyzed tracks for this mood"
                                    : `${m.trackCount} tracks`
                            }
                            className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                                active
                                    ? "border-indigo-400/60 bg-indigo-500/30 text-white"
                                    : "border-white/10 text-gray-400 hover:bg-white/5"
                            } disabled:opacity-30 disabled:cursor-not-allowed`}
                        >
                            {cap(m.mood)}{" "}
                            <span className="tabular-nums text-gray-600">
                                {m.trackCount}
                            </span>
                        </button>
                    );
                })}
            </div>

            {/* Steps slider */}
            <label className="flex items-center gap-2 mb-3 text-[11px] text-gray-400">
                <span className="w-10">Steps</span>
                <input
                    type="range"
                    min={4}
                    max={16}
                    step={1}
                    value={steps}
                    aria-label="Journey steps"
                    onChange={(e) => setSteps(parseInt(e.target.value, 10))}
                    className="flex-1 accent-indigo-400"
                />
                <span className="tabular-nums text-gray-500 w-4">{steps}</span>
            </label>

            <button
                type="button"
                onClick={submit}
                disabled={!canSubmit || loading}
                className="w-full mb-3 flex items-center justify-center gap-2 px-2 py-1.5 rounded bg-indigo-500/80 hover:bg-indigo-500 text-white text-xs font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
                {loading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                    <Route className="w-3.5 h-3.5" />
                )}
                Build journey
            </button>

            {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}

            {/* Route */}
            {waypoints.length > 0 && (
                <div className="mb-3">
                    <div className="flex items-center justify-between mb-1">
                        <p className="text-[10px] uppercase tracking-wide text-gray-600">
                            {targetLabel
                                ? `Route to ${targetLabel}`
                                : "Route"}
                        </p>
                        <button
                            type="button"
                            onClick={play}
                            className="flex items-center gap-1 text-[10px] text-indigo-300 hover:text-white transition-colors"
                        >
                            <Play className="w-3 h-3" />
                            Play journey
                        </button>
                    </div>
                    <ol className="flex flex-col">
                        {waypoints.map((w) => (
                            <li
                                key={`${w.id}-${w.seq}`}
                                className="flex items-center gap-2 px-1 py-1"
                            >
                                <span className="shrink-0 w-4 h-4 grid place-items-center rounded-full bg-indigo-500/30 text-[9px] tabular-nums text-indigo-200">
                                    {w.seq}
                                </span>
                                <span className="flex-1 min-w-0">
                                    <span className="block truncate text-xs text-white">
                                        {w.title}
                                    </span>
                                    <span className="block truncate text-[10px] text-gray-500">
                                        {w.artist.name}
                                    </span>
                                </span>
                                {!w.onMap && (
                                    <span className="shrink-0 text-[9px] uppercase tracking-wide text-amber-400/80 border border-amber-400/30 rounded px-1 py-0.5">
                                        not on map
                                    </span>
                                )}
                                <span className="shrink-0 text-[10px] tabular-nums text-indigo-300/80">
                                    {Math.round(w.similarity * 100)}%
                                </span>
                            </li>
                        ))}
                    </ol>
                </div>
            )}

            {/* Drift presets */}
            {driftable.length > 0 && (
                <div className="border-t border-white/10 pt-2">
                    <p className="text-[10px] uppercase tracking-wide text-gray-600 mb-1">
                        Drift toward…
                    </p>
                    <div className="flex flex-wrap gap-1">
                        {driftable.map((m) => (
                            <button
                                key={m.mood}
                                type="button"
                                onClick={() => drift(m.mood)}
                                title={`Drift 12 steps toward ${cap(m.mood)}`}
                                className="text-[10px] px-1.5 py-0.5 rounded border border-white/10 text-gray-400 hover:bg-white/5 hover:text-white transition-colors"
                            >
                                {cap(m.mood)}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
