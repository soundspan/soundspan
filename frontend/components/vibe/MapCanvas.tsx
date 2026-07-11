"use client";

/**
 * MapCanvas — the 15k-dot canvas renderer.
 *
 * A pure renderer: it repaints only when its data props change (tracks,
 * viewport, dims, mask, highlight/dim, hovered). Animation (beacon pulse) lives
 * in MapOverlay via CSS — the dot canvas is NEVER rAF-repainted.
 *
 * Pointer handlers are pass-through props: the container owns interaction logic
 * (hit-test, zoom-at-cursor, click threshold) and attaches handlers here.
 */

import { useCallback, useEffect, useRef } from "react";
import type { Viewport } from "./mapViewport";
import { worldToScreen } from "./mapViewport";
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
    /** Spotlight matches: rendered with a radius + alpha boost and a glow ring. */
    highlightIds?: ReadonlySet<string> | null;
    /** When a highlight set is active, dim the non-matching visible dots. */
    dimUnhighlighted?: boolean;
    /** Currently hovered track id (enlarged, opaque). */
    hoveredId?: string | null;
    className?: string;
    onWheel?: (e: React.WheelEvent<HTMLCanvasElement>) => void;
    onPointerDown?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerMove?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerUp?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
    onPointerLeave?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
}

const TAU = Math.PI * 2;
const DIM_ALPHA = 0.05; // filtered-out dots
const BASE_ALPHA = 0.72;
const NONMATCH_ALPHA = 0.12; // visible-but-not-a-spotlight-match while spotlighting
const BASE_RADIUS = 3.5;
const HOVER_RADIUS = 6;
const GLOW_RADIUS = 6;
const CULL_MARGIN = 12;

export function MapCanvas(props: MapCanvasProps) {
    const {
        tracks,
        viewport,
        width,
        height,
        mask,
        highlightIds,
        dimUnhighlighted,
        hoveredId,
        className,
        onWheel,
        onPointerDown,
        onPointerMove,
        onPointerUp,
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

        for (let i = 0; i < tracks.length; i++) {
            const t = tracks[i];
            const s = worldToScreen(viewport, t);
            if (
                s.x < -CULL_MARGIN ||
                s.x > width + CULL_MARGIN ||
                s.y < -CULL_MARGIN ||
                s.y > height + CULL_MARGIN
            ) {
                continue;
            }

            const visible = mask[i] !== 0;
            const isMatch = hasHighlight && highlightIds!.has(t.id);
            const isHovered = visible && hoveredId === t.id;

            let radius = BASE_RADIUS;
            let alpha: number;
            if (!visible) {
                alpha = DIM_ALPHA;
            } else if (isHovered) {
                radius = HOVER_RADIUS;
                alpha = 1;
            } else if (hasHighlight) {
                if (isMatch) {
                    radius = GLOW_RADIUS;
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
                ctx.arc(s.x, s.y, radius + 3.5, 0, TAU);
                ctx.fillStyle = color;
                ctx.globalAlpha = 0.22;
                ctx.fill();
            }

            ctx.beginPath();
            ctx.arc(s.x, s.y, radius, 0, TAU);
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
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerLeave}
        />
    );
}
