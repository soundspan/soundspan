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
 *    the current map data.
 *  - `decorations`: an SVG-children slot in screen-pixel space for F2 to draw
 *    travel constellations / journey routes / selection halos. Use the exported
 *    `worldToScreen(viewport, worldPt)` to place them.
 */

import type { ReactNode } from "react";
import type { Point, Viewport } from "./mapViewport";
import { worldToScreen } from "./mapViewport";

export interface MapOverlayProps {
    viewport: Viewport;
    /** Container size in CSS px. */
    width: number;
    height: number;
    /** Now-playing track in world (0..1) coords, or null when not on the map. */
    beacon?: Point | null;
    /** Ordered world points (oldest -> newest), already filtered to on-map ids. */
    trail?: readonly Point[];
    /** F2 slot: SVG elements in screen-pixel coords, rendered above the trail. */
    decorations?: ReactNode;
}

const TRAIL_COLOR = "#a5b4fc";

export function MapOverlay({
    viewport,
    width,
    height,
    beacon,
    trail,
    decorations,
}: MapOverlayProps) {
    const beaconScreen = beacon ? worldToScreen(viewport, beacon) : null;
    const trailScreen = (trail ?? []).map((p) => worldToScreen(viewport, p));

    const segments: ReactNode[] = [];
    const denom = Math.max(1, trailScreen.length - 1);
    for (let i = 1; i < trailScreen.length; i++) {
        const a = trailScreen[i - 1];
        const b = trailScreen[i];
        // Fade older segments; newest ~0.6, oldest ~0.08.
        const opacity = 0.08 + 0.5 * (i / denom);
        segments.push(
            <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={TRAIL_COLOR}
                strokeWidth={1.5}
                strokeOpacity={opacity}
                strokeLinecap="round"
            />
        );
    }

    return (
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <svg
                className="absolute inset-0"
                width={width}
                height={height}
                aria-hidden="true"
            >
                {segments}
                {decorations}
            </svg>

            {beaconScreen && (
                <div
                    className="vibe-beacon"
                    style={{
                        transform: `translate(${beaconScreen.x}px, ${beaconScreen.y}px)`,
                    }}
                >
                    <span className="vibe-beacon-ring" />
                    <span className="vibe-beacon-core" />
                </div>
            )}

            <style>{`
                .vibe-beacon {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 0;
                    height: 0;
                    will-change: transform;
                }
                .vibe-beacon-core {
                    position: absolute;
                    left: -4px;
                    top: -4px;
                    width: 8px;
                    height: 8px;
                    border-radius: 9999px;
                    background: #818cf8;
                    box-shadow: 0 0 8px 1px rgba(129, 140, 248, 0.9);
                }
                .vibe-beacon-ring {
                    position: absolute;
                    left: -9px;
                    top: -9px;
                    width: 18px;
                    height: 18px;
                    border-radius: 9999px;
                    border: 2px solid #818cf8;
                    animation: vibe-beacon-pulse 1.8s ease-out infinite;
                }
                @keyframes vibe-beacon-pulse {
                    0% { transform: scale(0.5); opacity: 0.9; }
                    100% { transform: scale(2.6); opacity: 0; }
                }
                /* Decoration entrance: constellation edges / halos / waypoints
                   fade in instead of popping (MapDecorations keys elements by
                   node id, so a new constellation remounts and re-fades). */
                .vibe-deco-in { animation: vibe-deco-in 200ms ease-out both; }
                @keyframes vibe-deco-in { from { opacity: 0; } }
                @media (prefers-reduced-motion: reduce) {
                    .vibe-beacon-ring { animation: none; opacity: 0.6; }
                    .vibe-deco-in { animation: none; }
                }
            `}</style>
        </div>
    );
}
