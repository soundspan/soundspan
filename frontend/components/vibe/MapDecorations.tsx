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
    trackById: ReadonlyMap<string, MapTrack>;
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
}

export function MapDecorations({
    viewport,
    trackById,
    travel,
    journey,
}: MapDecorationsProps) {
    const nodes: React.ReactNode[] = [];

    if (travel) {
        const origin = trackById.get(travel.currentId);
        // Breadcrumb: a bolder trail through the on-map nodes visited so far.
        const crumbPts: { x: number; y: number }[] = [];
        for (const id of travel.breadcrumbIds) {
            const t = trackById.get(id);
            if (t) crumbPts.push(worldToScreen(viewport, t));
        }
        if (crumbPts.length >= 2) {
            nodes.push(
                <polyline
                    key="travel-breadcrumb"
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
        if (origin) {
            const o = worldToScreen(viewport, origin);
            for (const n of travel.onMapNeighbors) {
                const t = trackById.get(n.id);
                if (!t) continue;
                const s = worldToScreen(viewport, t);
                nodes.push(
                    <line
                        key={`edge-${n.id}`}
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
                const t = trackById.get(n.id);
                if (!t) continue;
                const s = worldToScreen(viewport, t);
                nodes.push(
                    <circle
                        key={`halo-${n.id}`}
                        cx={s.x}
                        cy={s.y}
                        r={8}
                        fill="transparent"
                        stroke={EDGE_COLOR}
                        strokeWidth={2}
                        style={{ pointerEvents: "auto", cursor: "pointer" }}
                        onClick={(e) =>
                            e.shiftKey
                                ? travel.onQueue(n.id)
                                : travel.onNavigate(n.id)
                        }
                    >
                        <title>{n.title}</title>
                    </circle>
                );
            }
            // Current-node marker.
            nodes.push(
                <circle
                    key="travel-origin"
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
        const from = trackById.get(journey.fromId);
        if (from) pts.push(worldToScreen(viewport, from));
        const onMap = journey.waypoints.filter((w) => w.onMap);
        for (const w of onMap) {
            const t = trackById.get(w.id);
            if (t) pts.push(worldToScreen(viewport, t));
        }
        if (pts.length >= 2) {
            nodes.push(
                <polyline
                    key="journey-line"
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
            const t = trackById.get(w.id);
            if (!t) continue;
            const s = worldToScreen(viewport, t);
            nodes.push(
                <Fragment key={`wp-${w.id}-${w.seq}`}>
                    <circle
                        cx={s.x}
                        cy={s.y}
                        r={9}
                        fill="#1e1b4b"
                        stroke={ROUTE_COLOR}
                        strokeWidth={1.75}
                    />
                    <text
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
