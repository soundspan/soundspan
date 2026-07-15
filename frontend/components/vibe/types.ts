/**
 * Shared types + mood palette for the vibe map component tree.
 *
 * Kept free of React/DOM so pure logic modules and unit tests can import it.
 */

/** A single projected track as returned by `GET /api/vibe/map` (`api.getVibeMap`). */
export interface MapTrack {
    id: string;
    /** Normalised projection coordinates, 0..1. */
    x: number;
    y: number;
    title: string;
    artist: string;
    artistId: string;
    albumId: string;
    coverUrl: string | null;
    dominantMood: string;
    moodScore: number;
    energy: number | null;
    valence: number | null;
    /** Full per-mood scores (present in payload; unused by F1, kept for F2). */
    moods?: Record<string, number>;
}

/**
 * Map interaction mode. F1 implemented only `explore`; F2 adds travel /
 * journey / alchemy and branches the overlay + panels on it. The
 * `<MapOverlay decorations>` slot is where F2 draws mode-specific map graphics.
 */
export type MapMode = "explore" | "travel" | "journey" | "alchemy";

/** Mood key -> dot colour. Keys match the map payload's `dominantMood`. */
export const MOOD_COLORS: Record<string, string> = {
    moodHappy: "#facc15",
    moodSad: "#60a5fa",
    moodRelaxed: "#34d399",
    moodAggressive: "#ef4444",
    moodParty: "#f97316",
    moodAcoustic: "#c084fc",
    moodElectronic: "#f472b6",
};

const FALLBACK_MOOD_COLOR = "#6b7280";

export function getMoodColor(mood: string): string {
    return MOOD_COLORS[mood] ?? FALLBACK_MOOD_COLOR;
}

/**
 * The map's non-mood accent palette — every line/glyph color that isn't a
 * dot's mood color, in one place so MapDecorations (travel edges, journey
 * route), MapOverlay (session trail, flight plan), NowPlayingCard's beacon
 * fallback, and FiltersPanel's range-slider thumbs can never drift apart.
 * Purely a naming/consolidation move — the hex values are unchanged from
 * what each site hard-coded before.
 */
export const VIBE_ACCENTS = {
    /** Travel constellation edges + current-node marker. */
    edge: "#818cf8",
    /** Journey route polyline + waypoint rings. */
    route: "#a78bfa",
    /** Session trail polyline. */
    trail: "#a5b4fc",
    /** Flight plan (upcoming queue) dashed polyline. */
    plan: "#c7d2fe",
} as const;

/**
 * The backend's `getDominantMood` fallback (`backend/src/services/umapProjection.ts`)
 * when no mood score is confident enough to pick a named mood. Tracks with
 * this `dominantMood` are real, filterable map dots — not a value to special-case
 * out of the whitelist (that was the F1 bug: they were permanently invisible).
 */
export const NEUTRAL_MOOD = "neutral";

/**
 * Every mood key the map's filter UI should offer: the named moods plus the
 * backend's neutral fallback, appended last. Single source for both
 * useMapFilters' default "everything on" whitelist and FiltersPanel's chip
 * list, so they can never drift apart again.
 */
export const FILTERABLE_MOODS: readonly string[] = [
    ...Object.keys(MOOD_COLORS),
    NEUTRAL_MOOD,
];

/** Human label for a mood chip ("moodHappy" -> "Happy"; "neutral" -> "Neutral"). */
export function moodLabel(mood: string): string {
    if (mood === NEUTRAL_MOOD) return "Neutral";
    return mood.replace(/^mood/, "");
}
