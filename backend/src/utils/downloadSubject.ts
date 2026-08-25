/** Artist and album names parsed from a persisted download subject. */
export interface ArtistAlbumSubject {
    artist: string;
    album: string;
}

interface ParseArtistAlbumSubjectOptions {
    trim?: boolean;
}

/** Parse `Artist - Album`, preserving any later delimiters in the album title. */
export function parseArtistAlbumSubject(
    subject: string,
    options: ParseArtistAlbumSubjectOptions = {},
): ArtistAlbumSubject {
    const parts = subject.split(" - ");
    if (parts.length < 2) return { artist: subject, album: subject };
    const artist = parts[0];
    const album = parts.slice(1).join(" - ");
    if (options.trim === false) return { artist, album };
    return {
        artist: artist.trim(),
        album: album.trim(),
    };
}

/** Remove a trailing parenthesized four-digit year from an album title. */
export function stripAlbumYearSuffix(albumTitle: string): string {
    return albumTitle.replace(/\s*\(\d{4}\)\s*$/, "").trim();
}
