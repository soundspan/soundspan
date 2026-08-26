/** Minimal candidate state used by deterministic scanner album selection. */
export interface PreferredScannerAlbumCandidate {
    activeTrackCount: number;
    id: string;
    location: string;
    rgMbid: string;
}

function isTemporaryAlbum(candidate: PreferredScannerAlbumCandidate): boolean {
    return candidate.rgMbid.startsWith("temp-");
}

function preferredByTrackCountThenId<T extends PreferredScannerAlbumCandidate>(
    left: T,
    right: T,
): T {
    if (left.activeTrackCount !== right.activeTrackCount) {
        return left.activeTrackCount > right.activeTrackCount ? left : right;
    }
    return left.id.localeCompare(right.id) <= 0 ? left : right;
}

/** Selects by LIBRARY location, sole real identity, active count, then id. */
export function selectPreferredScannerAlbumCandidate<
    T extends PreferredScannerAlbumCandidate,
>(albums: readonly T[]): T | null {
    if (albums.length === 0) return null;
    const locationPreferred = albums.some(
        (album) => album.location === "LIBRARY",
    )
        ? albums.filter((album) => album.location === "LIBRARY")
        : albums;
    const realAlbums = locationPreferred.filter(
        (album) => !isTemporaryAlbum(album),
    );
    if (realAlbums.length === 1) return realAlbums[0];
    return locationPreferred.reduce(preferredByTrackCountThenId);
}
