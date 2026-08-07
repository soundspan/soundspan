"use client";

/**
 * MapCanvas — the 15k-dot canvas renderer.
 *
 * A pure renderer: it repaints only when its data props change (tracks,
 * viewport, dims, mask, highlight/dim, hovered, positions). Animation (beacon
 * pulse) lives in MapOverlay via CSS — the dot canvas is NEVER rAF-repainted
 * on its own; when the caller drives a layout-toggle animation it just feeds
 * a new `positions` buffer each frame like any other prop change.
 *
 * Pointer handlers are pass-through props: the container owns interaction logic
 * (hit-test, zoom-at-cursor, click threshold) and attaches handlers here.
 */

import { useCallback, useEffect, useRef } from "react";
import type { Viewport } from "./mapViewport";
import { computeDotRadius, fitViewport } from "./mapViewport";
import type { MapTrack } from "./types";
import { getMoodColor } from "./types";

export interface MapCanvasProps {
    tracks: readonly MapTrack[];
    viewport: Viewport;
    /** Container size in CSS px. */
    width: number;
    height: number;
    /** Index-aligned visibility mask (1 = visible, 0 = filtered out). */
    mask: Uint8Array;
    /**
     * Optional index-aligned `[x0,y0,x1,y1,...]` world (0..1) positions that
     * override `track.x`/`track.y` when present — the single source of truth
     * for where a dot is drawn once the spread layout is active (or
     * mid-animation toward/away from it). Must be at least `tracks.length*2`
     * long; otherwise it is ignored and natural `track.x/y` is used.
     */
    positions?: Float32Array;
    /** Spotlight matches: rendered with a radius + alpha boost and a glow ring. */
    highlightIds?: ReadonlySet<string> | null;
    /** When a highlight set is active, dim the non-matching visible dots. */
    dimUnhighlighted?: boolean;
    /** Currently hovered track id (enlarged, opaque). */
    hoveredId?: string | null;
    className?: string;
    // NOTE: wheel is deliberately NOT a React prop — React attaches wheel
    // listeners passively (preventDefault is a no-op), so the container owns a
    // native non-passive listener instead. See VibeMap's wheel effect.
    onPointerDown?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerMove?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerUp?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerCancel?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerLeave?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
}

const TAU = Math.PI * 2;
const DIM_ALPHA = 0.05; // filtered-out dots
const BASE_ALPHA = 0.72;
const NONMATCH_ALPHA = 0.12; // visible-but-not-a-spotlight-match while spotlighting
const HOVER_BOOST = 2.5; // hover radius = r + HOVER_BOOST
const GLOW_BOOST = 2.5; // spotlight-match radius = r + GLOW_BOOST
const GLOW_RING_EXTRA = 3.5; // outer glow ring beyond the match radius
const CULL_MARGIN = 12;

export function MapCanvas(props: MapCanvasProps) {
    const {
        tracks,
        viewport,
        width,
        height,
        mask,
        positions,
        highlightIds,
        dimUnhighlighted,
        hoveredId,
        className,
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
        onPointerLeave,
    } = props;
    const canvasRef = useRef<HTMLCanvasElement>(null);

    const draw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas || width <= 0 || height <= 0) return;

        const dpr =
            typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        const hasHighlight = !!highlightIds && highlightIds.size > 0;
        const hasPositions = !!positions && positions.length >= tracks.length * 2;
        const fitScale = fitViewport({ width, height }).scale;
        const r = computeDotRadius(viewport.scale, fitScale);

        // Scalar transform, inlined from mapViewport's worldToScreen
        // (screen = world * scale + t): this loop runs for up to ~15,000 dots
        // per repaint, at up to 60fps while panning/zooming, so it deliberately
        // allocates NOTHING per dot — no world-point object, no worldToScreen
        // result object, just two local numbers. Pixel-identical to calling
        // worldToScreen(viewport, world) per dot.
        const scale = viewport.scale;
        const tx = viewport.tx;
        const ty = viewport.ty;

        for (let i = 0; i < tracks.length; i++) {
            const t = tracks[i];
            const wx = hasPositions ? positions![i * 2] : t.x;
            const wy = hasPositions ? positions![i * 2 + 1] : t.y;
            const sx = wx * scale + tx;
            const sy = wy * scale + ty;
            if (
                sx < -CULL_MARGIN ||
                sx > width + CULL_MARGIN ||
                sy < -CULL_MARGIN ||
                sy > height + CULL_MARGIN
            ) {
                continue;
            }

            const visible = mask[i] !== 0;
            const isMatch = hasHighlight && highlightIds!.has(t.id);
            const isHovered = visible && hoveredId === t.id;

            let radius = r;
            let alpha: number;
            if (!visible) {
                alpha = DIM_ALPHA;
            } else if (isHovered) {
                radius = r + HOVER_BOOST;
                alpha = 1;
            } else if (hasHighlight) {
                if (isMatch) {
                    radius = r + GLOW_BOOST;
                    alpha = 1;
                } else {
                    alpha = dimUnhighlighted ? NONMATCH_ALPHA : BASE_ALPHA;
                }
            } else {
                alpha = BASE_ALPHA;
            }

            const color = getMoodColor(t.dominantMood);

            // Soft glow ring behind spotlight matches.
            if (visible && isMatch) {
                ctx.beginPath();
                ctx.arc(sx, sy, radius + GLOW_RING_EXTRA, 0, TAU);
                ctx.fillStyle = color;
                ctx.globalAlpha = 0.22;
                ctx.fill();
            }

            ctx.beginPath();
            ctx.arc(sx, sy, radius, 0, TAU);
            ctx.fillStyle = color;
            ctx.globalAlpha = alpha;
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }, [
        tracks,
        viewport,
        width,
        height,
        mask,
        positions,
        highlightIds,
        dimUnhighlighted,
        hoveredId,
    ]);

    useEffect(() => {
        draw();
    }, [draw]);

    return (
        <canvas
            ref={canvasRef}
            className={className ?? "absolute inset-0 touch-none"}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onPointerLeave={onPointerLeave}
        />
    );
}
