/**
 * Approximate placement of a track that is not part of the map sample.
 *
 * The server returns the track's nearest sampled neighbours with their
 * embedding distances; the client already knows where those neighbours sit
 * in the current layout, so the track lands at their inverse-distance
 * weighted centroid. Pure: no React, no DOM.
 */

import type { Point } from "./mapViewport";

/** One sampled neighbour as the anchors endpoint reports it. */
export interface MapAnchor {
    id: string;
    /** Cosine distance in embedding space; smaller is closer. */
    distance: number;
}

/** Keeps a zero-distance anchor from dominating with an infinite weight. */
const DISTANCE_FLOOR = 1e-3;

function anchorWeight(distance: number): number | null {
    if (!Number.isFinite(distance) || distance < 0) return null;
    return 1 / (distance + DISTANCE_FLOOR);
}

/**
 * Inverse-distance weighted centroid of the anchors that have a position in
 * the current layout. Null when no anchor can be placed, so callers fall
 * back to "not on the map" rather than a guessed point.
 */
export function placeByAnchors(
    anchors: readonly MapAnchor[],
    posOf: (id: string) => Point | null,
): Point | null {
    let weightSum = 0;
    let x = 0;
    let y = 0;
    for (const anchor of anchors) {
        const point = posOf(anchor.id);
        const weight = point ? anchorWeight(anchor.distance) : null;
        if (!point || weight === null) continue;
        weightSum += weight;
        x += point.x * weight;
        y += point.y * weight;
    }
    if (weightSum <= 0) return null;
    return { x: x / weightSum, y: y / weightSum };
}
