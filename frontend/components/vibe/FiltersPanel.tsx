"use client";

/**
 * FiltersPanel — the bottom-left floating, collapsible filter surface extracted
 * out of VibeMap's old filter row.
 *
 *  - Collapsed: a single glass pill "Filters · {visible}/{total}".
 *  - Expanded: a ~300px glass card with mood chips (real buttons, shift-click
 *    solos), an "All" reset, and both range sliders full-card-width with big,
 *    touch-friendly thumbs.
 *
 * Below `sm` the expanded card becomes a bottom sheet. The expand transition is
 * ~180ms and is skipped under prefers-reduced-motion (passed in as a prop so
 * the JS/CSS stay in sync).
 */

import { SlidersHorizontal, X } from "lucide-react";
import { FILTERABLE_MOODS, VIBE_ACCENTS, getMoodColor, moodLabel } from "./types";
import type { UseMapFilters } from "./useMapFilters";

type FiltersSlice = Pick<
    UseMapFilters,
    | "activeMoods"
    | "energyRange"
    | "valenceRange"
    | "visibleCount"
    | "toggleMood"
    | "soloMood"
    | "selectAllMoods"
    | "setEnergyRange"
    | "setValenceRange"
>;

export interface FiltersPanelProps {
    filters: FiltersSlice;
    /** Total dots on the map (denominator of the count). */
    total: number;
    expanded: boolean;
    onExpandedChange: (next: boolean) => void;
    /** Skip the expand animation + rely on CSS reduced-motion. */
    reducedMotion?: boolean;
    /** Small-screen bottom-sheet styling for the expanded card. */
    compact?: boolean;
    /** Mood keys to render; defaults to every filterable mood (incl. neutral). */
    moods?: readonly string[];
}

const RANGE_STYLES = (
    <style>{`
        .vibe-range-input {
            position: absolute; inset: 0; width: 100%; height: 100%; margin: 0;
            background: transparent; pointer-events: none;
            -webkit-appearance: none; appearance: none;
        }
        .vibe-range-input::-webkit-slider-runnable-track {
            background: transparent; height: 100%;
        }
        .vibe-range-input::-moz-range-track {
            background: transparent; height: 100%; border: none;
        }
        .vibe-range-input::-webkit-slider-thumb {
            -webkit-appearance: none; appearance: none; pointer-events: auto;
            width: 18px; height: 18px; border-radius: 9999px;
            background: ${VIBE_ACCENTS.edge}; border: 2px solid #0a0a0a; cursor: pointer;
        }
        .vibe-range-input::-moz-range-thumb {
            pointer-events: auto; width: 18px; height: 18px;
            border: 2px solid #0a0a0a; border-radius: 9999px;
            background: ${VIBE_ACCENTS.edge}; cursor: pointer;
        }
        @media (pointer: coarse) {
            .vibe-range-input::-webkit-slider-thumb { width: 22px; height: 22px; }
            .vibe-range-input::-moz-range-thumb { width: 22px; height: 22px; }
        }
    `}</style>
);

const FILTER_ANIMATION_STYLES = (
    <style>{`
        .vibe-anim-in { animation: vibe-anim-in 180ms ease-out both; }
        @keyframes vibe-anim-in {
            from { opacity: 0; transform: translateY(6px); }
            to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
            .vibe-anim-in { animation: none; }
        }
    `}</style>
);

/** Full-width dual-thumb range. One 6px track, two overlapped inputs whose
 *  thumbs (only) receive pointer events — the standard dual-range trick. */
function DualRange({
    label,
    lowLabel,
    highLabel,
    value,
    onChange,
}: {
    label: string;
    lowLabel: string;
    highLabel: string;
    value: [number, number];
    onChange: (v: [number, number]) => void;
}) {
    const [lo, hi] = value;
    return (
        <div className="mt-3">
            <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-gray-300">{label}</span>
                <span className="text-xs text-gray-400 tabular-nums">
                    {lo.toFixed(2)}–{hi.toFixed(2)}
                </span>
            </div>
            <div className="vibe-range relative h-5">
                <div
                    className="pointer-events-none absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1.5 rounded-full bg-white/10"
                    aria-hidden="true"
                />
                <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={lo}
                    aria-label={`${label} minimum`}
                    onChange={(e) =>
                        onChange([Math.min(parseFloat(e.target.value), hi), hi])
                    }
                    className="vibe-range-input"
                />
                <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={hi}
                    aria-label={`${label} maximum`}
                    onChange={(e) =>
                        onChange([lo, Math.max(parseFloat(e.target.value), lo)])
                    }
                    className="vibe-range-input"
                />
            </div>
            <div className="flex items-center justify-between mt-1 text-xs text-gray-500">
                <span>{lowLabel}</span>
                <span>{highLabel}</span>
            </div>
            {RANGE_STYLES}
        </div>
    );
}

function CollapsedFilters({
    visibleCount,
    total,
    bottom,
    expand,
}: {
    visibleCount: number;
    total: number;
    bottom: string;
    expand: () => void;
}) {
    return (
        <div className="pointer-events-none absolute left-3 z-30" style={{ bottom }}>
            <button type="button" onClick={expand} aria-expanded={false}
                title="Show filters"
                className="pointer-events-auto inline-flex items-center gap-2 h-10 px-3 rounded-full bg-black/60 backdrop-blur-md border border-white/10 shadow-lg text-sm text-gray-200 hover:bg-black/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60">
                <SlidersHorizontal className="w-4 h-4" />
                <span className="tabular-nums">Filters · {visibleCount}/{total}</span>
            </button>
        </div>
    );
}

function FiltersHeader({ visible, total, collapse }: {
    visible: number;
    total: number;
    collapse: () => void;
}) {
    return (
        <div className="flex items-center gap-2 mb-2">
            <SlidersHorizontal className="w-4 h-4 text-indigo-300" />
            <span className="text-sm font-semibold text-white">Filters</span>
            <span className="text-xs text-gray-400 tabular-nums">{visible}/{total} visible</span>
            <button type="button" onClick={collapse} aria-expanded={true}
                aria-label="Collapse filters" title="Collapse filters"
                className="ml-auto -mr-1 inline-flex items-center justify-center w-10 h-10 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60">
                <X className="w-4 h-4" />
            </button>
        </div>
    );
}

function MoodFilters({ filters, moods }: { filters: FiltersSlice; moods: readonly string[] }) {
    return (
        <>
            <div className="flex flex-wrap gap-1.5">
                {moods.map((mood) => {
                    const active = filters.activeMoods.has(mood);
                    return (
                        <button key={mood} type="button" aria-pressed={active}
                            onClick={(event) => event.shiftKey ? filters.soloMood(mood) : filters.toggleMood(mood)}
                            title={`${moodLabel(mood)} — click to toggle, shift-click to solo`}
                            className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-full border text-xs transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 ${active ? "bg-white/10 border-white/15 text-gray-200 opacity-100" : "border-white/10 text-gray-300 opacity-35"}`}>
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: getMoodColor(mood) }} />
                            {moodLabel(mood)}
                        </button>
                    );
                })}
                <button type="button" onClick={filters.selectAllMoods} title="Show all moods"
                    className="inline-flex items-center h-9 px-3 rounded-full border border-white/10 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60">
                    All
                </button>
            </div>
            <p className="mt-1.5 text-xs text-gray-500">shift-click to solo</p>
        </>
    );
}

function FilterRanges({ filters }: { filters: FiltersSlice }) {
    return (
        <>
            <DualRange label="Energy" lowLabel="calm" highLabel="intense"
                value={filters.energyRange} onChange={filters.setEnergyRange} />
            <DualRange label="Mood" lowLabel="sad" highLabel="happy"
                value={filters.valenceRange} onChange={filters.setValenceRange} />
        </>
    );
}

export function FiltersPanel({
    filters,
    total,
    expanded,
    onExpandedChange,
    reducedMotion,
    compact,
    moods = FILTERABLE_MOODS,
}: FiltersPanelProps) {
    const { visibleCount } = filters;

    // Floating bottom UI clears the mobile mini player via --vibe-binset
    // (0px on desktop / in fullscreen — set by VibeMap's root).
    const bottomOffset = "calc(0.75rem + var(--vibe-binset, 0px))";

    if (!expanded) {
        return (
            <CollapsedFilters visibleCount={visibleCount} total={total}
                bottom={bottomOffset} expand={() => onExpandedChange(true)} />
        );
    }

    const cardPos = compact
        ? "absolute inset-x-0 z-30 max-h-[75%] overflow-y-auto rounded-t-xl"
        : "absolute left-3 z-30 w-[min(90vw,300px)] rounded-xl";

    return (
        <div
            className={`${cardPos} pointer-events-none`}
            style={{
                bottom: compact ? "var(--vibe-binset, 0px)" : bottomOffset,
            }}
        >
            <div
                data-vibe-panel="filters"
                className={`vibe-filters-card pointer-events-auto bg-black/60 backdrop-blur-md border border-white/10 shadow-lg p-3 ${
                    compact ? "rounded-t-xl" : "rounded-xl"
                } ${reducedMotion ? "" : "vibe-anim-in"}`}
            >
                <FiltersHeader visible={visibleCount} total={total}
                    collapse={() => onExpandedChange(false)} />
                <MoodFilters filters={filters} moods={moods} />
                <FilterRanges filters={filters} />

                {FILTER_ANIMATION_STYLES}
            </div>
        </div>
    );
}
