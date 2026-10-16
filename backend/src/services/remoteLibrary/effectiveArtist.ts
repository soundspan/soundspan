import type { RemoteLibraryTrack } from "./types";

/** Resolves provider-level artist identity before linked-album fallback. */
export function effectiveRemoteArtistId(
    row: RemoteLibraryTrack,
): string | null {
    return row.artistId ?? row.albumArtistId;
}
