/**
 * Pure user-facing copy for TIDAL browse collection pages (playlist / mix).
 * Kept side-effect free so wording stays unit-testable per collection kind.
 */

/** The kind of TIDAL browse collection a page renders. */
export type BrowseCollectionKind = "playlist" | "mix";

/** Title-case label for a collection kind ("Playlist" / "Mix"). */
export function kindTitle(kind: BrowseCollectionKind): string {
    return kind === "playlist" ? "Playlist" : "Mix";
}

/** Copy bundle used across the browse collection page states. */
export function browseCollectionCopy(kind: BrowseCollectionKind) {
    return {
        heroLabel: `TIDAL ${kindTitle(kind)}`,
        loadErrorFallback: `Failed to load ${kind}`,
        noPlayableTracks: `No playable tracks in this ${kind}`,
        notFoundTitle: `${kindTitle(kind)} not found`,
        notFoundFallback: `This ${kind} may be private or no longer available.`,
        emptyMessage: `This ${kind} appears to be empty`,
    };
}

/**
 * Format a collection's total run time ("about 2 hr 5 min" / "45 min").
 */
export function formatTotalDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
        return `about ${hours} hr ${mins} min`;
    }
    return `${mins} min`;
}
