"use client";

/** Canvas, SVG overlays, decorations, and map load status. */

import { Loader2 } from "lucide-react";
import type { RefObject } from "react";
import { MapCanvas } from "./MapCanvas";
import { MapDecorations } from "./MapDecorations";
import { MapOverlay } from "./MapOverlay";
import { SWEEP_BRUSH_RADIUS } from "./sweepCollect";
import type { VibeMapViewModel } from "./useVibeMapController";

function SweepStroke({ model }: { model: VibeMapViewModel }) {
    const stroke = model.sweep.live?.stroke;
    if (!stroke || stroke.length < 2) return null;
    const points = stroke.map((point) => `${point.x},${point.y}`).join(" ");
    return (
        <>
            <polyline points={points} fill="none" stroke="#818cf8"
                strokeWidth={SWEEP_BRUSH_RADIUS * 2} strokeOpacity={0.1}
                strokeLinecap="round" strokeLinejoin="round" />
            <polyline points={points} fill="none" stroke="#a5b4fc"
                strokeWidth={1.5} strokeOpacity={0.7}
                strokeLinecap="round" strokeLinejoin="round" />
        </>
    );
}

function Decorations({ model }: { model: VibeMapViewModel }) {
    const travel = model.vibe.travel;
    const journey = model.vibe.journey;
    return (
        <MapDecorations viewport={model.camera.viewport!} posOf={model.layout.posOf}
            quantiles={model.data.quantiles}
            travel={travel ? { currentId: travel.currentId,
                breadcrumbIds: travel.breadcrumbTitles.map((item) => item.id),
                onMapNeighbors: travel.onMapNeighbors, onNavigate: travel.navigate,
                onQueue: travel.queue } : null}
            journey={journey ? { fromId: journey.fromId, waypoints: journey.waypoints } : null}
            onHaloPointerDown={model.gestures.handleHaloPointerDown}
            onHaloAddIngredient={model.vibe.addIngredient} />
    );
}

function ReadyMap({ model }: { model: VibeMapViewModel }) {
    const viewport = model.camera.viewport!;
    const beacon = model.audio.currentTrack ?
        model.layout.posOf(model.audio.currentTrack.id) : null;
    return (
        <>
            <MapCanvas tracks={model.data.tracks} viewport={viewport}
                width={model.dims.width} height={model.dims.height}
                mask={model.filters.mask} positions={model.layout.positions}
                highlightIds={model.presentation.effectiveHighlightIds}
                dimUnhighlighted={model.presentation.effectiveDim}
                hoveredId={model.gestures.hoveredId}
                onPointerDown={model.gestures.handlePointerDown}
                onPointerMove={model.gestures.handlePointerMove}
                onPointerUp={model.gestures.handlePointerUp}
                onPointerCancel={model.gestures.handlePointerCancel}
                onPointerLeave={model.gestures.endDrag} />
            <MapOverlay viewport={viewport} width={model.dims.width} height={model.dims.height}
                beacon={beacon} trail={model.presentation.shownTrail}
                plan={model.presentation.shownPlan} decorations={<Decorations model={model} />}
                sweepStroke={<SweepStroke model={model} />} />
        </>
    );
}

function MapStatus({ model }: { model: VibeMapViewModel }) {
    if (model.data.loading) {
        return <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <Loader2 className="w-8 h-8 text-gray-500 animate-spin" />
        </div>;
    }
    if (!model.data.error && model.data.tracks.length > 0) return null;
    return <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4 pointer-events-none">
        <p className="text-gray-400 text-sm">{model.data.error ??
            "No tracks with embeddings available for the map"}</p>
    </div>;
}

/** Render the transform-sharing canvas and overlay stage. */
export function VibeMapCanvasStage({ model, containerRef }: {
    model: VibeMapViewModel;
    containerRef: RefObject<HTMLDivElement | null>;
}) {
    const ready = model.camera.viewport !== null && model.dims.width > 0 && model.dims.height > 0;
    return (
        <div ref={containerRef} className="absolute inset-0 overflow-hidden">
            {ready && <ReadyMap model={model} />}
            <MapStatus model={model} />
        </div>
    );
}
