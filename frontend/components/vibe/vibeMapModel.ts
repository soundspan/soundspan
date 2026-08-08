/** Pure decisions shared by the VibeMap controller and focused tests. */

import { computeDotRadius, type MapDims, type Point, type Viewport,
    type WorldBounds } from "./mapViewport";
import type { AuxSurface } from "./useAuxSurface";
import type { TrailPoint } from "./useTrailDisplay";
import type { VibeMode } from "./vibeModeMachine";

const MIN_HIT_RADIUS = 8;
const MAX_HIT_TEST_TRACKS = 250_000;
const MAX_JOURNEY_WAYPOINTS = 20;
const FOLLOW_EDGE_FRACTION = 0.2;
const EMPTY_TRAIL: readonly TrailPoint[] = [];
const EMPTY_PLAN: readonly Point[] = [];

type EscapeAction = "dismiss-sweep" | "close-aux" | "exit-mode" |
    "exit-fullscreen" | null;

/** Select the single action owned by an Escape key press. */
export function resolveEscapeAction(sweepOpen: boolean, auxOpen: boolean,
    mode: VibeMode, fullscreen: boolean): EscapeAction {
    if (sweepOpen) return "dismiss-sweep";
    if (auxOpen) return "close-aux";
    if (mode !== "explore") return "exit-mode";
    return fullscreen ? "exit-fullscreen" : null;
}

interface VibeMapPresentationInput {
    mode: VibeMode;
    sweepHighlight: ReadonlySet<string> | null;
    vibeHighlight: ReadonlySet<string> | null;
    spotlightHighlight: ReadonlySet<string> | null;
    trail: readonly TrailPoint[];
    plan: readonly Point[];
    filtersExpanded: boolean;
    auxSurface: AuxSurface;
    sweepChipOpen: boolean;
}

/** Derive mutually exclusive overlays and panel visibility. */
export function deriveVibeMapPresentation(input: VibeMapPresentationInput) {
    const effectiveHighlightIds = input.sweepHighlight ?? input.vibeHighlight ??
        input.spotlightHighlight;
    return {
        effectiveHighlightIds,
        effectiveDim: input.sweepHighlight ? false :
            input.vibeHighlight !== null || input.spotlightHighlight !== null,
        filtersOpen: input.filtersExpanded && input.mode === "explore",
        queuePanelVisible: input.auxSurface === "queue" && !input.sweepChipOpen,
        shownTrail: input.mode === "explore" ? input.trail : EMPTY_TRAIL,
        shownPlan: input.mode === "explore" ? input.plan : EMPTY_PLAN,
    };
}

interface HitTrack { id: string }
interface TrackHitTestInput {
    clientX: number;
    clientY: number;
    rect: { left: number; top: number };
    viewport: Viewport;
    fitScale: number;
    tracks: readonly HitTrack[];
    positions: Float32Array;
    mask: Uint8Array;
    radiusScale?: number;
}

/** Find the nearest visible dot under a screen-space pointer. */
export function findTrackAtScreenPoint(input: TrackHitTestInput): string | null {
    const x = input.clientX - input.rect.left;
    const y = input.clientY - input.rect.top;
    const radius = Math.max(computeDotRadius(input.viewport.scale, input.fitScale),
        MIN_HIT_RADIUS) * (input.radiusScale ?? 1);
    const available = Math.min(input.tracks.length, input.mask.length,
        Math.floor(input.positions.length / 2), MAX_HIT_TEST_TRACKS);
    let closest: string | null = null;
    let closestDistance = radius;
    for (let index = 0; index < MAX_HIT_TEST_TRACKS && index < available; index++) {
        if (input.mask[index] === 0) continue;
        const dx = x - (input.positions[index * 2] * input.viewport.scale + input.viewport.tx);
        const dy = y - (input.positions[index * 2 + 1] * input.viewport.scale + input.viewport.ty);
        const distance = Math.hypot(dx, dy);
        if (distance < closestDistance) {
            closest = input.tracks[index].id;
            closestDistance = distance;
        }
    }
    return closest;
}

interface JourneyPoint { id: string; onMap: boolean }

/** Bound an on-map journey plus its origin, or return null for fewer than two points. */
export function journeyBounds(originId: string | null, waypoints: readonly JourneyPoint[],
    positionOf: (id: string) => Point | null): WorldBounds | null {
    const points: Point[] = [];
    const origin = originId ? positionOf(originId) : null;
    if (origin) points.push(origin);
    for (let index = 0; index < MAX_JOURNEY_WAYPOINTS && index < waypoints.length; index++) {
        const waypoint = waypoints[index];
        if (!waypoint.onMap) continue;
        const point = positionOf(waypoint.id);
        if (point) points.push(point);
    }
    if (points.length < 2) return null;
    return points.reduce<WorldBounds>((bounds, point) => ({
        minX: Math.min(bounds.minX, point.x), minY: Math.min(bounds.minY, point.y),
        maxX: Math.max(bounds.maxX, point.x), maxY: Math.max(bounds.maxY, point.y),
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

/** Report whether a travel origin is outside the viewport's central band. */
export function shouldFollowTravelOrigin(screen: Point, dims: MapDims): boolean {
    const marginX = dims.width * FOLLOW_EDGE_FRACTION;
    const marginY = dims.height * FOLLOW_EDGE_FRACTION;
    return screen.x < marginX || screen.x > dims.width - marginX ||
        screen.y < marginY || screen.y > dims.height - marginY;
}
