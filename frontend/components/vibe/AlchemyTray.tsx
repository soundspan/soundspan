"use client";

/**
 * AlchemyTray — the Alchemy-mode overlay. Ingredients are gathered by
 * ctrl/cmd-clicking dots, weighted here, and blended into playable results.
 */

import { FlaskConical, Loader2, Play, X } from "lucide-react";
import { VIBE_PANEL_CLASS, VIBE_PANEL_STYLE, PANEL_CLOSE_CLASS } from "./TravelPanel";
import { MAX_ALCHEMY_INGREDIENTS, MIN_WEIGHT, MAX_WEIGHT } from "./useVibeMode";
import type { AlchemyView } from "./useVibeMode";
import { VibeTrackRow } from "./VibeTrackRow";

function AlchemyHeader({ view }: { view: AlchemyView }) {
    return (
        <>
            <div className="flex items-center gap-2 mb-2">
                <FlaskConical className="w-4 h-4 text-fuchsia-300" />
                <span className="text-sm font-semibold text-white">Alchemy</span>
                <span className="text-xs text-gray-400 tabular-nums">
                    {view.ingredients.length}/{MAX_ALCHEMY_INGREDIENTS}
                </span>
                <button type="button" onClick={view.clear} aria-label="Clear alchemy (Esc)"
                    title="Clear alchemy (Esc)" className={PANEL_CLOSE_CLASS}>
                    <X className="w-4 h-4" />
                </button>
            </div>
            <p className="text-xs text-gray-400 mb-2">
                Ctrl/⌘-click dots to add ingredients, then blend.
            </p>
        </>
    );
}

function IngredientRows({ view }: { view: AlchemyView }) {
    return (
        <div className="flex flex-col gap-1.5 mb-3">
            {view.ingredients.map((ingredient) => (
                <div key={ingredient.id} className="flex items-center gap-2">
                    <span className="flex-1 min-w-0">
                        <span className="block truncate text-[13px] text-white">{ingredient.title}</span>
                        <span className="block truncate text-xs text-gray-400">{ingredient.artist}</span>
                    </span>
                    <input type="range" min={MIN_WEIGHT} max={MAX_WEIGHT} step={0.1}
                        value={ingredient.weight} aria-label={`Weight for ${ingredient.title}`}
                        onChange={(event) => view.setWeight(ingredient.id, parseFloat(event.target.value))}
                        className="w-16 h-1.5 accent-fuchsia-400" />
                    <span className="w-6 shrink-0 text-xs tabular-nums text-gray-400">
                        {ingredient.weight.toFixed(1)}
                    </span>
                    <button type="button" onClick={() => view.remove(ingredient.id)}
                        aria-label={`Remove ${ingredient.title}`} title="Remove"
                        className="shrink-0 inline-flex items-center justify-center w-10 h-10 -my-2 rounded-lg text-gray-400 hover:text-red-400 hover:bg-white/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60">
                        <X className="w-4 h-4" />
                    </button>
                </div>
            ))}
        </div>
    );
}

function BlendActions({ view }: { view: AlchemyView }) {
    return (
        <>
            <div className="flex items-center gap-2 mb-3">
                <button type="button" onClick={view.blend}
                    disabled={!view.canBlend || view.loading}
                    className="flex-1 min-h-[40px] flex items-center justify-center gap-2 px-2 py-2 rounded-lg bg-fuchsia-500/80 hover:bg-fuchsia-500 text-white text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 disabled:opacity-30 disabled:cursor-not-allowed">
                    {view.loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />}
                    Blend
                </button>
                <button type="button" onClick={view.clear}
                    className="min-h-[40px] px-3 py-2 rounded-lg border border-white/10 text-gray-300 hover:bg-white/5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60">
                    Clear
                </button>
            </div>
            {view.error && <p className="text-xs text-red-400 mb-2">{view.error}</p>}
        </>
    );
}

function BlendResults({ view }: { view: AlchemyView }) {
    if (view.results.length === 0) return null;
    return (
        <div>
            <div className="flex items-center justify-between mb-1">
                <p className="text-xs uppercase tracking-wide text-gray-500">Blend results</p>
                <button type="button" onClick={view.play}
                    className="inline-flex items-center gap-1 min-h-[36px] px-2 rounded-lg text-xs text-fuchsia-300 hover:text-white hover:bg-white/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60">
                    <Play className="w-3.5 h-3.5" /> Play blend
                </button>
            </div>
            <div className="flex flex-col">
                {view.results.map((result) => (
                    <VibeTrackRow key={`${result.id}-${result.seq}`} title={result.title}
                        artistName={result.artist.name} onMap={result.onMap}
                        distance={result.distance} quantiles={view.quantiles}
                        accentClass="text-fuchsia-300/80" />
                ))}
            </div>
        </div>
    );
}

export function AlchemyTray({ view }: { view: AlchemyView }) {
    return (
        <div className={VIBE_PANEL_CLASS} style={VIBE_PANEL_STYLE} data-vibe-panel="alchemy">
            <AlchemyHeader view={view} />
            <IngredientRows view={view} />
            <BlendActions view={view} />
            <BlendResults view={view} />
        </div>
    );
}
