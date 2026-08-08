"use client";

/**
 * MapOverlay — absolutely-positioned layer above MapCanvas, sharing the same
 * viewport transform (via `worldToScreen`). Everything here is DOM/SVG:
 *
 *  - Beacon: a CSS-animated pulsing ring on the now-playing dot, positioned by
 *    `transform: translate(...)`. The pulse is pure CSS keyframes — never rAF,
 *    so it can't force a 15k-dot canvas repaint.
 *  - Trail: an SVG polyline through recently-played dots, opacity fading from
 *    oldest (faint) to newest (bright). Callers pass only points that exist in
 *    the current map data. Each point also carries an `alpha` multiplier (the
 *    session trail's age-based fade, `useSessionTrail`'s `fadeAlphaForAge`;
 *    1 when trail mode is "on") that multiplies into the ramp.
 *  - Plan: the flight plan — a DASHED polyline from the now-playing dot
 *    through the upcoming on-map queue tracks, fading toward the future (the
 *    forward-looking mirror of the trail). Points come from flightPlan.ts.
 *  - `decorations`: an SVG-children slot in screen-pixel space for F2 to draw
 *    travel constellations / journey routes / selection halos. Use the exported
 *    `worldToScreen(viewport, worldPt)` to place them.
 */

import type { ReactNode } from "react";
import type { Point, Viewport } from "./mapViewport";
import { worldToScreen } from "./mapViewport";
import { VIBE_ACCENTS } from "./types";

export interface MapOverlayProps {
    viewport: Viewport;
    /** Container size in CSS px. */
    width: number;
    height: number;
    /** Now-playing track in world (0..1) coords, or null when not on the map. */
    beacon?: Point | null;
    /**
     * Ordered world points (oldest -> newest), already filtered to on-map ids.
     * `alpha` is an extra per-point opacity multiplier — the session trail's
     * age-based fade (1 = full strength, 0 = fully aged out).
     */
    trail?: readonly (Point & { alpha: number })[];
    /** Flight plan: now-playing dot -> upcoming on-map queue dots (world coords). */
    plan?: readonly Point[];
    /** F2 slot: SVG elements in screen-pixel coords, rendered above the trail. */
    decorations?: ReactNode;
    /** Live sweep-brush stroke (screen-pixel SVG), rendered above decorations. */
    sweepStroke?: ReactNode;
}

const TRAIL_COLOR = VIBE_ACCENTS.trail;
const PLAN_COLOR = VIBE_ACCENTS.plan;

const MAP_OVERLAY_STYLES = (
    <style>{`
        .vibe-beacon {
            position: absolute; top: 0; left: 0; width: 0; height: 0;
            will-change: transform;
        }
        .vibe-beacon-core {
            position: absolute; left: -4px; top: -4px; width: 8px; height: 8px;
            border-radius: 9999px; background: #818cf8;
            box-shadow: 0 0 8px 1px rgba(129, 140, 248, 0.9);
        }
        .vibe-beacon-ring {
            position: absolute; left: -9px; top: -9px; width: 18px; height: 18px;
            border-radius: 9999px; border: 2px solid #818cf8;
            animation: vibe-beacon-pulse 1.8s ease-out infinite;
        }
        @keyframes vibe-beacon-pulse {
            0% { transform: scale(0.5); opacity: 0.9; }
            100% { transform: scale(2.6); opacity: 0; }
        }
        .vibe-deco-in { animation: vibe-deco-in 200ms ease-out both; }
        @keyframes vibe-deco-in { from { opacity: 0; } }
        @media (prefers-reduced-motion: reduce) {
            .vibe-beacon-ring { animation: none; opacity: 0.6; }
            .vibe-deco-in { animation: none; }
        }
    `}</style>
);

/** A screen-space point with an optional extra opacity multiplier (default 1). */
interface FadeSegmentPoint extends Point {
    alpha?: number;
}

interface FadeSegmentsOptions {
    color: string;
    dashArray?: string;
    /** Base opacity (0..1) for segment index `i` (1-based) of `denom` = max(1, points.length-1). */
    opacityAt: (i: number, denom: number) => number;
    keyPrefix: string;
}

/**
 * Build a polyline as a chain of faded `<line>` segments through screen-space
 * `points`. Shared by the session trail (oldest -> faint) and the flight plan
 * (future -> faint) — they differ only in color / dash / which direction the
 * ramp fades. Each point may carry an extra `alpha` multiplier (the trail's
 * age-based fade; defaults to 1, e.g. for the plan, which has none) — a
 * segment's final opacity is its base ramp opacity times the AVERAGE of its
 * two endpoints' alpha, so the ramp direction is preserved while aged-out
 * trail entries still visibly dim.
 */
function buildFadeSegments(
    points: readonly FadeSegmentPoint[],
    { color, dashArray, opacityAt, keyPrefix }: FadeSegmentsOptions
): ReactNode[] {
    const segments: ReactNode[] = [];
    const denom = Math.max(1, points.length - 1);
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const base = opacityAt(i, denom);
        const ageAlpha = ((a.alpha ?? 1) + (b.alpha ?? 1)) / 2;
        segments.push(
            <line
                key={`${keyPrefix}-${i}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={color}
                strokeWidth={1.5}
                strokeOpacity={base * ageAlpha}
                strokeDasharray={dashArray}
                strokeLinecap="round"
            />
        );
    }
    return segments;
}

function Beacon({ point }: { point: Point | null }) {
    if (!point) return null;
    return (
        <div className="vibe-beacon"
            style={{ transform: `translate(${point.x}px, ${point.y}px)` }}>
            <span className="vibe-beacon-ring" />
            <span className="vibe-beacon-core" />
        </div>
    );
}

export function MapOverlay({
    viewport,
    width,
    height,
    beacon,
    trail,
    plan,
    decorations,
    sweepStroke,
}: MapOverlayProps) {
    const beaconScreen = beacon ? worldToScreen(viewport, beacon) : null;

    // Fade older segments; newest ~0.6, oldest ~0.08 — the age alpha (from
    // "fade" trail mode) multiplies in on top via buildFadeSegments.
    const trailScreen: FadeSegmentPoint[] = (trail ?? []).map((p) => ({
        ...worldToScreen(viewport, p),
        alpha: p.alpha,
    }));
    const segments = buildFadeSegments(trailScreen, {
        color: TRAIL_COLOR,
        opacityAt: (i, denom) => 0.08 + 0.5 * (i / denom),
        keyPrefix: "trail",
    });

    // Flight plan: dashed, brightest leaving the beacon, fading toward the
    // future — the visual inverse of the trail's oldest-faint gradient. No
    // alpha field (buildFadeSegments treats a missing alpha as 1 = full).
    const planScreen: FadeSegmentPoint[] = (plan ?? []).map((p) =>
        worldToScreen(viewport, p)
    );
    const planSegments = buildFadeSegments(planScreen, {
        color: PLAN_COLOR,
        dashArray: "3 5",
        opacityAt: (i, denom) => 0.55 - 0.4 * ((i - 1) / denom),
        keyPrefix: "plan",
    });

    return (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <svg
                className="absolute inset-0"
                width={width}
                height={height}
                aria-hidden="true"
            >
                {planSegments}
                {segments}
                {decorations}
                {sweepStroke}
            </svg>

            <Beacon point={beaconScreen} />

            {MAP_OVERLAY_STYLES}
        </div>
    );
}
