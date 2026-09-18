"use client";

/**
 * Approximate placement for a track that is not part of the map sample.
 *
 * Only the currently playing track is placed this way, so at most one
 * request is in flight; the query is disabled while the track is on the
 * map or nothing is playing. Anchors are the track's nearest sampled
 * neighbours; the point is recomputed from the live layout, so it follows
 * the natural/spread toggle without another request.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { placeByAnchors, type MapAnchor } from "./mapPlacement";
import type { Point } from "./mapViewport";

/** Where an off-map track lands and which sampled neighbours put it there. */
export interface OffMapPlacement {
    point: Point;
    anchors: readonly MapAnchor[];
}

const ANCHORS_STALE_MS = 5 * 60 * 1000;

/** Resolve an approximate map position for an off-map track, or null. */
export function useOffMapPlacement(
    trackId: string | null,
    onMap: boolean,
    posOf: (id: string) => Point | null,
): OffMapPlacement | null {
    const enabled = trackId !== null && !onMap;
    const { data } = useQuery({
        queryKey: queryKeys.vibeMapAnchors(trackId ?? ""),
        queryFn: ({ signal }) =>
            api.getVibeMapAnchors(trackId ?? "", { signal }),
        enabled,
        retry: false,
        staleTime: ANCHORS_STALE_MS,
    });
    return useMemo(() => {
        if (!enabled || !data || data.onMap || data.anchors.length === 0) {
            return null;
        }
        const point = placeByAnchors(data.anchors, posOf);
        return point ? { point, anchors: data.anchors } : null;
    }, [enabled, data, posOf]);
}
