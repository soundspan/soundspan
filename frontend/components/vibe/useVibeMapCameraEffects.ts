"use client";

/** Cross-mode camera effects and explicit fly-to actions for VibeMap. */

import { useCallback, useEffect, useRef } from "react";
import { fitBounds, fitViewport, flyTo, worldToScreen, type MapDims,
    type Point, type Viewport } from "./mapViewport";
import type { JourneyView } from "./useVibeMode";
import { useLatest } from "./useLatest";
import { journeyBounds, shouldFollowTravelOrigin } from "./vibeMapModel";

const SEARCH_LOCATE_ZOOM = 8;

interface CameraTargetArgs {
    dims: MapDims;
    viewportRef: React.RefObject<Viewport | null>;
    positionOf: (id: string) => Point | null;
    animate: (target: Viewport, duration?: number) => void;
}

/** Build stable locate-now-playing and spotlight fly-to callbacks. */
export function useVibeMapLocations(args: CameraTargetArgs) {
    const positionRef = useLatest(args.positionOf);
    const locate = useCallback((id: string, zoom: number) => {
        const viewport = args.viewportRef.current;
        const position = positionRef.current(id);
        if (!viewport || !position) return false;
        const scale = Math.max(viewport.scale, fitViewport(args.dims).scale * zoom);
        args.animate(flyTo(viewport, position, scale, args.dims), 600);
        return true;
    }, [args.viewportRef, args.dims, args.animate, positionRef]);
    return {
        locateNowPlaying: useCallback((id: string) => locate(id, 3), [locate]),
        locateSearchResult: useCallback((id: string) => locate(id, SEARCH_LOCATE_ZOOM),
            [locate]),
    };
}

interface TravelFollowArgs extends CameraTargetArgs {
    originId: string | null;
    gestureActive: () => boolean;
}

/** Keep a newly selected travel origin inside the viewport's central band. */
export function useTravelCameraFollow(args: TravelFollowArgs): void {
    const latest = useLatest(args);
    useEffect(() => {
        if (!args.originId || latest.current.gestureActive()) return;
        const viewport = latest.current.viewportRef.current;
        const dims = latest.current.dims;
        const position = latest.current.positionOf(args.originId);
        if (!viewport || dims.width <= 0 || !position) return;
        if (shouldFollowTravelOrigin(worldToScreen(viewport, position), dims)) {
            latest.current.animate(flyTo(viewport, position, viewport.scale, dims), 450);
        }
    }, [args.originId, latest]);
}

interface JourneyFrameArgs extends CameraTargetArgs { journey: JourneyView | null }

/** Frame each distinct on-map journey route once. */
export function useJourneyCameraFrame(args: JourneyFrameArgs): void {
    const latest = useLatest(args);
    const framedRoute = useRef<string | null>(null);
    const waypoints = args.journey?.waypoints ?? null;
    const originId = args.journey?.fromId ?? null;
    useEffect(() => {
        if (!waypoints?.length) {
            framedRoute.current = null;
            return;
        }
        const signature = `${originId}:${waypoints.map((item) => item.id).join(",")}`;
        if (framedRoute.current === signature) return;
        framedRoute.current = signature;
        const current = latest.current;
        const bounds = journeyBounds(originId, waypoints, current.positionOf);
        if (bounds && current.dims.width > 0) {
            current.animate(fitBounds(bounds, current.dims), 600);
        }
    }, [waypoints, originId, latest]);
}
