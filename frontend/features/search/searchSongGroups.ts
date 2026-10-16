import { dedupeDiscoverTracks } from "./songDedup";
import type { DiscoverResult, SearchResult } from "./types";

/** Inputs that decide which song groups the search page shows. */
export interface SearchSongGroupsInput {
    filterTab: string;
    showLibrary: boolean;
    showDiscover: boolean;
    libraryResults: SearchResult | null | undefined;
    discoverTracks: DiscoverResult[];
}

/**
 * Splits search songs into the page's three groups: library songs, liked
 * streaming songs (never on the Peers tab), and external matches with any
 * song already shown in the first two removed.
 */
export function selectSearchSongGroups(input: SearchSongGroupsInput) {
    const libraryTracks = input.libraryResults?.tracks ?? [];
    const streamingTracks =
        input.showLibrary && input.filterTab !== "peers"
            ? (input.libraryResults?.remoteTracks ?? [])
            : [];
    const unownedDiscoverTracks = input.showDiscover
        ? dedupeDiscoverTracks(input.discoverTracks, [
              ...libraryTracks,
              ...streamingTracks,
          ])
        : [];
    return { libraryTracks, streamingTracks, unownedDiscoverTracks };
}
