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
 * Map interaction mode. F1 implements only `explore`; F2 (travel / journey /
 * alchemy) extends this union and branches the overlay + panels on it. The
 * `<MapOverlay decorations>` slot is where F2 draws mode-specific map graphics.
 */
export type MapMode = "explore";

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

/** Human label for a mood chip ("moodHappy" -> "Happy"). */
export function moodLabel(mood: string): string {
    return mood.replace(/^mood/, "");
}
