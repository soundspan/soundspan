/**
 * Genre keyword classification and filtering for splitting YT Music
 * categories into moods vs genres.
 */

/** Genre keywords used to split categories into moods vs genres. */
const GENRE_KEYWORDS = new Set([
    "pop", "rock", "hip-hop", "hip hop", "r&b", "country", "latin",
    "electronic", "dance", "metal", "jazz", "classical", "folk",
    "indie", "alternative", "blues", "soul", "punk", "reggae",
    "k-pop", "j-pop", "afrobeats",
]);

/**
 * Genre items hidden by default (region-specific or niche categories).
 * Matched case-insensitively against the item title.
 *
 * TODO: replace with per-user preference stored in user settings so
 * each user can pick which genres to show/hide via a selection popup.
 */
const HIDDEN_GENRE_ITEMS = new Set([
    "african",
    "arabic",
    "bollywood & indian",
    "brazilian",
    "j-pop",
    "latin",
    "mandopop & cantopop",
    "opm",
]);

/**
 * Determines if a category title represents a genre (vs a mood).
 * Uses word-boundary matching to avoid false positives (e.g. "Popular" matching "pop").
 */
export function isGenreCategory(title: string): boolean {
    const lower = title.toLowerCase();
    if (/\bgenres?\b/.test(lower)) return true;
    return [...GENRE_KEYWORDS].some((keyword) => {
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped}\\b`).test(lower);
    });
}

/** Returns true if a genre item title should be hidden from the UI. */
export function isHiddenGenreItem(title: string): boolean {
    return HIDDEN_GENRE_ITEMS.has(title.toLowerCase());
}
