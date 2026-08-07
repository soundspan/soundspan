/**
 * mapSearch — pure, in-memory track/artist finder for the vibe map's
 * spotlight pill. Separate from `api.vibeSearch` (semantic CLAP search): this
 * is a plain case-insensitive substring match over the already-loaded map
 * payload, so it can run on every keystroke with no network round trip.
 *
 * No React, no DOM — unit-testable in isolation.
 */

import type { MapTrack } from "./types";

/** Below this many (trimmed) characters, matching is too noisy to bother. */
const MIN_QUERY_LENGTH = 2;

/** Match tiers, best first. Lower sorts first. */
const RANK_TITLE_PREFIX = 0;
const RANK_ARTIST_PREFIX = 1;
const RANK_TITLE_SUBSTRING = 2;
const RANK_ARTIST_SUBSTRING = 3;

/** Normalise: trim, collapse internal whitespace, lowercase. */
function normalize(s: string): string {
    return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Case-insensitive substring search over `title`/`artist`, ranked
 * title-prefix > artist-prefix > title-substring > artist-substring, then
 * alphabetical by title (then artist, then id, for full determinism) within a
 * tier. `query` is trimmed and its internal whitespace collapsed before
 * matching; fewer than 2 resulting characters yields no matches.
 */
export function searchMapTracks(
    tracks: readonly MapTrack[],
    query: string,
    limit = 8
): MapTrack[] {
    const q = normalize(query);
    if (q.length < MIN_QUERY_LENGTH) return [];

    const ranked: { track: MapTrack; rank: number }[] = [];
    for (const track of tracks) {
        const title = track.title.toLowerCase();
        const artist = track.artist.toLowerCase();
        let rank: number;
        if (title.startsWith(q)) rank = RANK_TITLE_PREFIX;
        else if (artist.startsWith(q)) rank = RANK_ARTIST_PREFIX;
        else if (title.includes(q)) rank = RANK_TITLE_SUBSTRING;
        else if (artist.includes(q)) rank = RANK_ARTIST_SUBSTRING;
        else continue;
        ranked.push({ track, rank });
    }

    ranked.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        const titleCmp = a.track.title.localeCompare(b.track.title);
        if (titleCmp !== 0) return titleCmp;
        const artistCmp = a.track.artist.localeCompare(b.track.artist);
        if (artistCmp !== 0) return artistCmp;
        return a.track.id.localeCompare(b.track.id);
    });

    return ranked.slice(0, limit).map((r) => r.track);
}
