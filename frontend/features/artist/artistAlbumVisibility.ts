import type { Album } from "./types";

/**
 * True for albums that belong in the artist's library section: albums you own,
 * plus remote albums holding songs you liked on TIDAL or YouTube Music.
 */
export function isLibraryVisibleArtistAlbum(
    album: Pick<Album, "owned" | "source">,
): boolean {
    return album.owned === true || album.source === "remote";
}
