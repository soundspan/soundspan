const GENERIC_ALBUM_TITLES = new Set([
    "",
    "single",
    "singles",
    "unknown album",
    "unknown",
    "n/a",
    "none",
]);

/** Returns true for an absent or placeholder album title. */
export function isGenericAlbumTitle(value?: string | null): boolean {
    return !value || GENERIC_ALBUM_TITLES.has(value.trim().toLowerCase());
}
