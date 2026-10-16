import type { DiscoverResult } from "./types";

/** Any song row with a title and an album artist (library or streaming). */
export interface SongKeySource {
    title: string;
    album?: { artist?: { name: string } };
}

/**
 * Normalize an artist/title pair for owned-vs-external song comparison:
 * lowercase, strip trailing parenthetical/bracketed qualifiers (remaster,
 * feat., live, ...), then drop punctuation AND spacing so "T.N.T.", "TNT",
 * and "AC/DC" vs "AC DC" all compare equal.
 */
export function normalizeSongKey(artist: string, title: string): string {
    const normalizePart = (value: string): string =>
        value
            .toLowerCase()
            .replace(/\s*[([][^)\]]*[)\]]\s*$/g, "")
            .replace(/[^\p{L}\p{N}]+/gu, "");
    return `${normalizePart(artist)}::${normalizePart(title)}`;
}

/**
 * Drop external track results that duplicate a song already present in the
 * library results or the viewer's liked streaming songs, so the Songs
 * section never shows the same song twice. External rows without an artist cannot be safely compared and are
 * kept.
 */
export function dedupeDiscoverTracks(
    discoverTracks: DiscoverResult[],
    libraryTracks: ReadonlyArray<SongKeySource>,
): DiscoverResult[] {
    if (discoverTracks.length === 0 || libraryTracks.length === 0) {
        return discoverTracks;
    }
    const ownedKeys = new Set(
        libraryTracks.map((track) =>
            normalizeSongKey(track.album?.artist?.name ?? "", track.title),
        ),
    );
    return discoverTracks.filter(
        (track) =>
            !track.artist ||
            !ownedKeys.has(normalizeSongKey(track.artist, track.name)),
    );
}
