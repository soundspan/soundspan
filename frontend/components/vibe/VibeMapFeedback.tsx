"use client";

/** Contextual map hints, hover details, and fullscreen feedback. */

import { MapHintChip } from "./MapHintChip";
import { hintForMode } from "./mapHints";
import { worldToScreen } from "./mapViewport";
import { getMoodColor } from "./types";
import { api } from "@/lib/api";
import type { VibeMapViewModel } from "./useVibeMapController";

function HoverTooltip({ model }: { model: VibeMapViewModel }) {
    const track = model.gestures.hoveredId
        ? model.trackById.get(model.gestures.hoveredId)
        : undefined;
    const viewport = model.camera.viewport;
    if (!track || model.shell.coarsePointer || !viewport) return null;
    const world = model.layout.posOf(track.id);
    if (!world) return null;
    const screen = worldToScreen(viewport, world);
    const flip = screen.x > model.dims.width - 280;
    const coverUrl =
        track.coverUrl &&
        !track.coverUrl.startsWith("/") &&
        !track.coverUrl.startsWith("data:") &&
        !track.coverUrl.startsWith("blob:")
            ? api.getCoverArtUrl(track.coverUrl, 80)
            : track.coverUrl;
    return (
        <div
            className="pointer-events-none absolute z-40 -translate-y-1/2"
            style={{
                left: flip ? undefined : screen.x + 16,
                right: flip ? model.dims.width - screen.x + 16 : undefined,
                top: Math.min(Math.max(screen.y, 44), model.dims.height - 44),
            }}
        >
            <div className="bg-black/60 backdrop-blur-md border border-white/10 rounded-xl px-3 py-2 shadow-lg inline-flex items-center gap-2 max-w-[260px]">
                {coverUrl && (
                    <img
                        src={coverUrl}
                        alt=""
                        loading="lazy"
                        className="w-10 h-10 rounded object-cover flex-shrink-0"
                    />
                )}
                <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                        <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{
                                backgroundColor: getMoodColor(
                                    track.dominantMood,
                                ),
                            }}
                        />
                        <p className="text-sm text-white font-medium truncate">
                            {track.title}
                        </p>
                    </div>
                    <p className="text-xs text-gray-400 truncate">
                        {track.artist}
                    </p>
                </div>
            </div>
        </div>
    );
}

function ContextHint({ model }: { model: VibeMapViewModel }) {
    const modeSheetOpen =
        model.shell.smallScreen && model.vibe.mode !== "explore";
    const hidden =
        model.shell.hintsDismissed ||
        model.sweep.result ||
        model.sweep.live ||
        model.escHintVisible ||
        modeSheetOpen ||
        model.data.loading ||
        model.data.tracks.length === 0;
    if (hidden) return null;
    return (
        <MapHintChip
            text={hintForMode(model.vibe.mode, {
                picking: model.vibe.journey?.picking,
                sweepArmed: model.sweep.brushArmed,
            })}
            onDismiss={model.shell.dismissHints}
        />
    );
}

function FullscreenHint({ model }: { model: VibeMapViewModel }) {
    if (!model.shell.fullscreen || !model.escHintVisible) return null;
    return (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 z-40">
            <div className="vibe-esc-hint px-3 py-1.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-xs text-gray-300 shadow-lg">
                Esc to exit
            </div>
            <style>{`
            .vibe-esc-hint { animation: vibe-esc-fade 2.5s ease-out forwards; }
            @keyframes vibe-esc-fade { 0%, 60% { opacity: 1; } 100% { opacity: 0; } }
            @media (prefers-reduced-motion: reduce) { .vibe-esc-hint { animation: none; } }
        `}</style>
        </div>
    );
}

/** Render non-interactive, contextual feedback above the map. */
export function VibeMapFeedback({ model }: { model: VibeMapViewModel }) {
    return (
        <>
            <ContextHint model={model} />
            <HoverTooltip model={model} />
            <FullscreenHint model={model} />
        </>
    );
}
