/**
 * flightPlan — PURE derivation of the "where the music is going" overlay.
 *
 * The session trail shows where you've been; the flight plan shows where
 * you're going: an ordered list of world points from the currently playing
 * track's dot through the next on-map tracks in the play queue. MapOverlay
 * renders it as a dashed polyline fading toward the future, so a journey /
 * sweep / alchemy queue becomes a visible plan on the map the moment you
 * press play.
 *
 * No React, no DOM — unit-testable in isolation. Podcast episodes in the
 * mixed-media queue and tracks that aren't plotted on the current map sample
 * are skipped (an off-map hop simply shortens the drawn plan).
 */

import { isEpisodeQueueItem, type QueueItem } from "@/lib/queue-item";

export interface PlanPoint {
    x: number;
    y: number;
}

/** Upcoming queue hops drawn (beyond the current track's starting point). */
export const FLIGHT_PLAN_LIMIT = 10;

/**
 * World points for the flight-plan polyline: the current track's dot (when it
 * is on the map) followed by up to `limit` upcoming on-map queue tracks, in
 * queue order. Returns [] when fewer than two points resolve — a plan needs a
 * line, not a dot.
 */
export function upcomingOnMapPoints(
    queue: readonly QueueItem[] | null | undefined,
    currentIndex: number,
    posOf: (id: string) => PlanPoint | null,
    limit: number = FLIGHT_PLAN_LIMIT
): PlanPoint[] {
    if (!queue || queue.length === 0) return [];

    const pts: PlanPoint[] = [];
    const current =
        currentIndex >= 0 && currentIndex < queue.length
            ? queue[currentIndex]
            : undefined;
    if (current && !isEpisodeQueueItem(current)) {
        const p = posOf(current.id);
        if (p) pts.push(p);
    }

    let upcoming = 0;
    for (let i = currentIndex + 1; i < queue.length && upcoming < limit; i++) {
        const item = queue[i];
        if (isEpisodeQueueItem(item)) continue;
        const p = posOf(item.id);
        if (!p) continue;
        pts.push(p);
        upcoming++;
    }

    return pts.length >= 2 ? pts : [];
}
