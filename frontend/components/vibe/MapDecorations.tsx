"use client";

/** Map mode graphics rendered in screen-pixel space over the dot canvas. */

import { Fragment, type ReactNode } from "react";
import type { Viewport } from "./mapViewport";
import { worldToScreen } from "./mapViewport";
import { VIBE_ACCENTS } from "./types";
import type { VibeListItem } from "./useVibeMode";
import type { CompassCandidate } from "./travelCompass";
import { calibratedMatch, matchEdgeStyle } from "./vibeMatch";

const EDGE_COLOR = VIBE_ACCENTS.edge;
const ROUTE_COLOR = VIBE_ACCENTS.route;

export interface MapDecorationsProps {
    viewport: Viewport;
    /** Live position resolver (natural or spread, mid-animation-safe). */
    posOf: (id: string) => { x: number; y: number } | null;
    travel: {
        currentId: string;
        breadcrumbIds: readonly string[];
        onMapNeighbors: readonly CompassCandidate[];
        onNavigate: (id: string) => void;
        onQueue: (id: string) => void;
    } | null;
    journey: { fromId: string; waypoints: readonly VibeListItem[] } | null;
    /** Library-calibrated distance quantiles, or null for linear fallback. */
    quantiles?: readonly number[] | null;
    onHaloPointerDown?: (event: React.PointerEvent<SVGCircleElement>) => void;
    onHaloAddIngredient?: (id: string) => void;
}

type Travel = NonNullable<MapDecorationsProps["travel"]>;
type PositionResolver = MapDecorationsProps["posOf"];

function breadcrumbNode(viewport: Viewport, posOf: PositionResolver, travel: Travel): ReactNode {
    const points = travel.breadcrumbIds.flatMap((id) => {
        const point = posOf(id);
        return point ? [worldToScreen(viewport, point)] : [];
    });
    if (points.length < 2) return null;
    return (
        <polyline key="travel-breadcrumb" className="vibe-deco-in"
            points={points.map((point) => `${point.x},${point.y}`).join(" ")}
            fill="none" stroke={EDGE_COLOR} strokeWidth={3} strokeOpacity={0.55}
            strokeLinejoin="round" strokeLinecap="round" />
    );
}

function travelEdgeNodes(
    viewport: Viewport,
    posOf: PositionResolver,
    travel: Travel,
    quantiles: readonly number[] | null
): ReactNode[] {
    const origin = posOf(travel.currentId);
    if (!origin) return [];
    const screenOrigin = worldToScreen(viewport, origin);
    return travel.onMapNeighbors.flatMap((neighbor) => {
        const point = posOf(neighbor.id);
        if (!point) return [];
        const screen = worldToScreen(viewport, point);
        const { percent } = calibratedMatch(neighbor.distance, quantiles);
        const { opacity, width } = matchEdgeStyle(percent);
        return [
            <line key={`edge-${neighbor.id}`} className="vibe-deco-in"
                x1={screenOrigin.x} y1={screenOrigin.y} x2={screen.x} y2={screen.y}
                stroke={EDGE_COLOR} strokeWidth={width} strokeOpacity={opacity} />,
        ];
    });
}

function handleHaloClick(
    event: React.MouseEvent<SVGCircleElement>,
    neighbor: CompassCandidate,
    travel: Travel,
    addIngredient?: (id: string) => void
): void {
    if (event.ctrlKey || event.metaKey) {
        addIngredient?.(neighbor.id);
    } else if (event.shiftKey) {
        travel.onQueue(neighbor.id);
    } else {
        travel.onNavigate(neighbor.id);
    }
}

function travelHaloNodes(
    viewport: Viewport,
    posOf: PositionResolver,
    travel: Travel,
    pointerDown?: MapDecorationsProps["onHaloPointerDown"],
    addIngredient?: (id: string) => void
): ReactNode[] {
    return travel.onMapNeighbors.flatMap((neighbor) => {
        const point = posOf(neighbor.id);
        if (!point) return [];
        const screen = worldToScreen(viewport, point);
        return [
            <circle key={`halo-${neighbor.id}`} className="vibe-deco-in"
                cx={screen.x} cy={screen.y} r={8} fill="transparent"
                stroke={EDGE_COLOR} strokeWidth={2}
                style={{ pointerEvents: "auto", cursor: "pointer" }}
                onPointerDown={pointerDown}
                onClick={(event) => handleHaloClick(event, neighbor, travel, addIngredient)}>
                <title>{neighbor.title}</title>
            </circle>,
        ];
    });
}

function travelNodes(props: MapDecorationsProps): ReactNode[] {
    if (!props.travel) return [];
    const origin = props.posOf(props.travel.currentId);
    const nodes: ReactNode[] = [breadcrumbNode(props.viewport, props.posOf, props.travel)];
    nodes.push(...travelEdgeNodes(props.viewport, props.posOf, props.travel, props.quantiles ?? null));
    nodes.push(...travelHaloNodes(
        props.viewport, props.posOf, props.travel,
        props.onHaloPointerDown, props.onHaloAddIngredient
    ));
    if (origin) {
        const screen = worldToScreen(props.viewport, origin);
        nodes.push(
            <circle key="travel-origin" className="vibe-deco-in" cx={screen.x}
                cy={screen.y} r={5} fill={EDGE_COLOR} fillOpacity={0.9} />
        );
    }
    return nodes;
}

function journeyNodes(props: MapDecorationsProps): ReactNode[] {
    if (!props.journey) return [];
    const onMap = props.journey.waypoints.filter((waypoint) => waypoint.onMap);
    const points = [props.journey.fromId, ...onMap.map((waypoint) => waypoint.id)]
        .flatMap((id) => {
            const point = props.posOf(id);
            return point ? [worldToScreen(props.viewport, point)] : [];
        });
    const nodes: ReactNode[] = [];
    if (points.length >= 2) {
        nodes.push(
            <polyline key="journey-line" className="vibe-deco-in"
                points={points.map((point) => `${point.x},${point.y}`).join(" ")}
                fill="none" stroke={ROUTE_COLOR} strokeWidth={1.75}
                strokeOpacity={0.7} strokeLinejoin="round" />
        );
    }
    for (const waypoint of onMap) {
        const point = props.posOf(waypoint.id);
        if (!point) continue;
        const screen = worldToScreen(props.viewport, point);
        nodes.push(
            <Fragment key={`wp-${waypoint.id}-${waypoint.seq}`}>
                <circle className="vibe-deco-in" cx={screen.x} cy={screen.y} r={9}
                    fill="#1e1b4b" stroke={ROUTE_COLOR} strokeWidth={1.75} />
                <text className="vibe-deco-in" x={screen.x} y={screen.y + 3}
                    textAnchor="middle" fontSize={9} fill="#e0e7ff">{waypoint.seq}</text>
            </Fragment>
        );
    }
    return nodes;
}

export function MapDecorations(props: MapDecorationsProps) {
    return <>{[...travelNodes(props), ...journeyNodes(props)]}</>;
}
