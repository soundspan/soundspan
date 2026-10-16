import type { LibraryOrigin } from "@/hooks/useQueries";
import type { Tab } from "./types";

/** Title and description shown when a Library tab has nothing to list. */
export interface LibraryEmptyCopy {
    title: string;
    description: string;
}

const NOUNS: Record<Tab, string> = {
    artists: "artists",
    albums: "albums",
    tracks: "songs",
};

/** Picks empty-state copy for a tab, with streaming-specific guidance for Remote. */
export function getLibraryEmptyCopy(
    tab: Tab,
    origin: LibraryOrigin,
): LibraryEmptyCopy {
    if (origin === "remote") {
        return {
            title: `No streaming ${NOUNS[tab]} yet`,
            description:
                "Like songs on TIDAL or YouTube Music and the ones you don't have yet show up here.",
        };
    }
    return {
        title: `No ${NOUNS[tab]} yet`,
        description: "Your library is empty. Sync your music to get started.",
    };
}

/** Count line under an artist card; falls back to songs for album-less artists. */
export function formatArtistCountLabel(artist: {
    albumCount?: number;
    trackCount?: number;
}): string {
    const albums = artist.albumCount || 0;
    const songs = artist.trackCount || 0;
    if (albums === 0 && songs > 0) {
        return songs === 1 ? "1 song" : `${songs} songs`;
    }
    return `${albums} albums`;
}
