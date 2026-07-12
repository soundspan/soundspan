"use client";

/**
 * MapDecorations — the SVG children handed to `<MapOverlay decorations>`. Draws
 * mode-specific map graphics in screen-pixel space via `worldToScreen`:
 *
 *  - Travel: edges from the current node to each on-map neighbour + clickable
 *    neighbour halos (they opt back into pointer events; the overlay root is
 *    pointer-events-none).
 *  - Journey: a connecting polyline through the on-map waypoints (origin first)
 *    plus a numbered circle at each.
 *
 * Off-map neighbours/waypoints are intentionally not drawn — the panels list
 * them. Alchemy needs no decorations; its results glow via the canvas
 * highlight path instead.
 *
 * Positions come exclusively through `posOf` (the live natural-or-spread
 * buffer resolved by index) so decorations never draw from a stale
 * `track.x/y` while the spread layout is active or animating. `trackById` is
 * kept around for metadata lookups only.
 */

import { Fragment } from "react";
import type { Viewport } from "./mapViewport";
import { worldToScreen } from "./mapViewport";
import type { MapTrack } from "./types";
import type { VibeListItem } from "./useVibeMode";
import type { CompassCandidate } from "./travelCompass";

const EDGE_COLOR = "#818cf8";
const ROUTE_COLOR = "#a78bfa";

export interface MapDecorationsProps {
    viewport: Viewport;
    /** Metadata-only lookup (title, artist, ...) — NOT for positions. */
    trackById: ReadonlyMap<string, MapTrack>;
    /** Live position resolver (natural or spread, mid-animation-safe). */
    posOf: (id: string) => { x: number; y: number } | null;
    travel: {
        currentId: string;
        breadcrumbIds: readonly string[];
        onMapNeighbors: readonly CompassCandidate[];
        onNavigate: (id: string) => void;
        onQueue: (id: string) => void;
    } | null;
    journey: {
        fromId: string;
        waypoints: readonly VibeListItem[];
    } | null;
    /**
     * A halo opts into pointer events (the overlay root is pointer-events-none),
     * which otherwise swallows a pointerdown that starts a pan. Wire this to arm
     * the same drag state the canvas's own pointerdown does.
     */
    onHaloPointerDown?: (e: React.PointerEvent<SVGCircleElement>) => void;
    /** ctrl/⌘-click on a halo adds the neighbour to the alchemy tray. */
    onHaloAddIngredient?: (id: string) => void;
}

export function MapDecorations({
    viewport,
    // Metadata-only (title, artist, ...); positions come from `posOf`. Not
    // read by this component today but kept on the props contract for
    // callers/tests and future decorations that need track metadata.
    trackById,
    posOf,
    travel,
    journey,
    onHaloPointerDown,
    onHaloAddIngredient,
}: MapDecorationsProps) {
    void trackById;
    const nodes: React.ReactNode[] = [];

    if (travel) {
        const originPos = posOf(travel.currentId);
        // Breadcrumb: a bolder trail through the on-map nodes visited so far.
        const crumbPts: { x: number; y: number }[] = [];
        for (const id of travel.breadcrumbIds) {
            const p = posOf(id);
            if (p) crumbPts.push(worldToScreen(viewport, p));
        }
        if (crumbPts.length >= 2) {
            nodes.push(
                <polyline
                    key="travel-breadcrumb"
                    className="vibe-deco-in"
                    points={crumbPts.map((p) => `${p.x},${p.y}`).join(" ")}
                    fill="none"
                    stroke={EDGE_COLOR}
                    strokeWidth={3}
                    strokeOpacity={0.55}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                />
            );
        }
        if (originPos) {
            const o = worldToScreen(viewport, originPos);
            for (const n of travel.onMapNeighbors) {
                const p = posOf(n.id);
                if (!p) continue;
                const s = worldToScreen(viewport, p);
                nodes.push(
                    <line
                        key={`edge-${n.id}`}
                        className="vibe-deco-in"
                        x1={o.x}
                        y1={o.y}
                        x2={s.x}
                        y2={s.y}
                        stroke={EDGE_COLOR}
                        strokeWidth={1.25}
                        strokeOpacity={0.5}
                    />
                );
            }
            // Halos drawn after edges so they sit on top and stay clickable.
            for (const n of travel.onMapNeighbors) {
                const p = posOf(n.id);
                if (!p) continue;
                const s = worldToScreen(viewport, p);
                nodes.push(
                    <circle
                        key={`halo-${n.id}`}
                        className="vibe-deco-in"
                        cx={s.x}
                        cy={s.y}
                        r={8}
                        fill="transparent"
                        stroke={EDGE_COLOR}
                        strokeWidth={2}
                        style={{ pointerEvents: "auto", cursor: "pointer" }}
                        onPointerDown={onHaloPointerDown}
                        onClick={(e) => {
                            if (e.ctrlKey || e.metaKey) {
                                onHaloAddIngredient?.(n.id);
                                return;
                            }
                            if (e.shiftKey) travel.onQueue(n.id);
                            else travel.onNavigate(n.id);
                        }}
                    >
                        <title>{n.title}</title>
                    </circle>
                );
            }
            // Current-node marker.
            nodes.push(
                <circle
                    key="travel-origin"
                    className="vibe-deco-in"
                    cx={o.x}
                    cy={o.y}
                    r={5}
                    fill={EDGE_COLOR}
                    fillOpacity={0.9}
                />
            );
        }
    }

    if (journey) {
        const pts: { x: number; y: number }[] = [];
        const fromPos = posOf(journey.fromId);
        if (fromPos) pts.push(worldToScreen(viewport, fromPos));
        const onMap = journey.waypoints.filter((w) => w.onMap);
        for (const w of onMap) {
            const p = posOf(w.id);
            if (p) pts.push(worldToScreen(viewport, p));
        }
        if (pts.length >= 2) {
            nodes.push(
                <polyline
                    key="journey-line"
                    className="vibe-deco-in"
                    points={pts.map((p) => `${p.x},${p.y}`).join(" ")}
                    fill="none"
                    stroke={ROUTE_COLOR}
                    strokeWidth={1.75}
                    strokeOpacity={0.7}
                    strokeLinejoin="round"
                />
            );
        }
        for (const w of onMap) {
            const p = posOf(w.id);
            if (!p) continue;
            const s = worldToScreen(viewport, p);
            nodes.push(
                <Fragment key={`wp-${w.id}-${w.seq}`}>
                    <circle
                        className="vibe-deco-in"
                        cx={s.x}
                        cy={s.y}
                        r={9}
                        fill="#1e1b4b"
                        stroke={ROUTE_COLOR}
                        strokeWidth={1.75}
                    />
                    <text
                        className="vibe-deco-in"
                        x={s.x}
                        y={s.y + 3}
                        textAnchor="middle"
                        fontSize={9}
                        fill="#e0e7ff"
                    >
                        {w.seq}
                    </text>
                </Fragment>
            );
        }
    }

    return <>{nodes}</>;
}
