/**
 * travelCompass — PURE module for the Travel constellation.
 *
 * No React, no DOM. Given the current node plus a list of similar-track
 * candidates and a compass direction, it enriches candidates from map data,
 * filters them to the chosen direction and returns the top-N ranked by
 * similarity. Unit-testable in isolation.
 *
 * The `/vibe/similar` payload carries `audioFeatures.{energy,valence}`, but
 * those can be null and it never carries the per-mood record. Candidates that
 * are present on the map are therefore enriched from the map projection (which
 * always has energy/valence + the `moods` record) via `enrichFromMap`.
 */

import type { MapTrack } from "./types";

/** Compass directions offered by the segmented control. */
export type CompassDirection =
    | "any"
    | "happier"
    | "sadder"
    | "calmer"
    | "more-energetic";

export const COMPASS_DIRECTIONS: readonly CompassDirection[] = [
    "any",
    "happier",
    "sadder",
    "calmer",
    "more-energetic",
] as const;

/** Minimum valence delta (candidate − current) to count as happier / sadder. */
export const VALENCE_DELTA_THRESHOLD = 0.03;
/** Minimum energy delta (candidate − current) to count as calmer / energetic. */
export const ENERGY_DELTA_THRESHOLD = 0.03;
/** Default number of neighbours drawn / listed. */
export const DEFAULT_COMPASS_COUNT = 8;

/** Common vibe-track fields shared by waypoints, alchemy results and neighbours. */
export interface VibeTrackRef {
    id: string;
    title: string;
    album: { id: string; title: string; coverUrl: string | null };
    artist: { id: string; name: string };
}

/**
 * A travel neighbour: a similar-track candidate carrying the features the
 * compass filters on. `energy`/`valence` may be null (unanalyzed) and `moods`
 * may be absent until enriched from the map.
 */
export interface CompassCandidate extends VibeTrackRef {
    /** 0..1 hybrid similarity; higher = closer. Used for ranking. */
    similarity: number;
    /** Raw pairwise CLAP cosine distance — the calibrated-% display source. */
    distance: number;
    energy: number | null;
    valence: number | null;
    /** Per-mood scores (from the map payload) used as the null-valence fallback. */
    moods?: Record<string, number> | null;
    /** Groove/intensity features for the Travel explainability breakdown. */
    danceability?: number | null;
    arousal?: number | null;
}

/** The origin node the compass measures deltas against (a `MapTrack` satisfies this). */
export type CompassOrigin = Pick<MapTrack, "energy" | "valence" | "moods">;

function delta(current: number | null, candidate: number | null): number | null {
    if (current == null || candidate == null) return null;
    return candidate - current;
}

function moodHappyDelta(
    current: CompassOrigin,
    candidate: CompassCandidate
): number | null {
    const c = current.moods?.moodHappy;
    const n = candidate.moods?.moodHappy;
    if (typeof c !== "number" || typeof n !== "number") return null;
    return n - c;
}

/**
 * Does `candidate` satisfy `direction` relative to `current`?
 *
 * - happier: valence Δ > +0.03; when valence is null on either side, fall back
 *   to moodHappy Δ > 0. sadder is the inverse.
 * - calmer: energy Δ < −0.03; more-energetic is the inverse. No mood fallback —
 *   a null energy on either side simply doesn't qualify.
 * - any: everything qualifies.
 */
export function matchesDirection(
    current: CompassOrigin,
    candidate: CompassCandidate,
    direction: CompassDirection
): boolean {
    if (direction === "any") return true;

    const vd = delta(current.valence, candidate.valence);
    const ed = delta(current.energy, candidate.energy);

    switch (direction) {
        case "happier": {
            if (vd !== null) return vd > VALENCE_DELTA_THRESHOLD;
            const md = moodHappyDelta(current, candidate);
            return md !== null ? md > 0 : false;
        }
        case "sadder": {
            if (vd !== null) return vd < -VALENCE_DELTA_THRESHOLD;
            const md = moodHappyDelta(current, candidate);
            return md !== null ? md < 0 : false;
        }
        case "calmer":
            return ed !== null ? ed < -ENERGY_DELTA_THRESHOLD : false;
        case "more-energetic":
            return ed !== null ? ed > ENERGY_DELTA_THRESHOLD : false;
        default:
            return true;
    }
}

/**
 * Fill each candidate's `energy`/`valence`/`moods` from the map projection when
 * the candidate is on the map and its own value is missing (null/undefined).
 * The map's features are authoritative for anything it plots, so this recovers
 * the deltas for candidates whose `/similar` audioFeatures came back null.
 *
 * Pure: returns new candidate objects, input untouched.
 */
export function enrichFromMap(
    candidates: readonly CompassCandidate[],
    mapIndex: ReadonlyMap<string, MapTrack>
): CompassCandidate[] {
    return candidates.map((c) => {
        const m = mapIndex.get(c.id);
        if (!m) return c;
        return {
            ...c,
            energy: c.energy ?? m.energy,
            valence: c.valence ?? m.valence,
            moods: c.moods ?? m.moods ?? null,
        };
    });
}

/**
 * Filter candidates to the compass `direction` and return the top `topN` ranked
 * by similarity (desc). The current node itself is always dropped.
 */
export function compassNeighbors(
    current: CompassOrigin,
    candidates: readonly CompassCandidate[],
    direction: CompassDirection,
    topN: number = DEFAULT_COMPASS_COUNT
): CompassCandidate[] {
    return candidates
        .filter((c) => matchesDirection(current, c, direction))
        .slice()
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, Math.max(0, topN));
}
