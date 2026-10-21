import type { Album, SearchResult } from "./types";

/** Inputs that decide which album groups the search page shows. */
export interface SearchAlbumGroupsInput {
    filterTab: string;
    showLibrary: boolean;
    libraryResults: SearchResult | null | undefined;
}

/**
 * Splits search albums into the page's two groups: library albums, and the
 * viewer's streaming-only albums (never on the Peers tab). A streaming album
 * that also came back as a library album is shown only once, as a library
 * album.
 */
export function selectSearchAlbumGroups(input: SearchAlbumGroupsInput): {
    libraryAlbums: Album[];
    streamingAlbums: Album[];
} {
    const libraryAlbums = input.libraryResults?.albums ?? [];
    if (!input.showLibrary || input.filterTab === "peers") {
        return { libraryAlbums, streamingAlbums: [] };
    }
    const libraryIds = new Set(libraryAlbums.map((album) => album.id));
    const streamingAlbums = (input.libraryResults?.remoteAlbums ?? []).filter(
        (album) => !libraryIds.has(album.id),
    );
    return { libraryAlbums, streamingAlbums };
}
