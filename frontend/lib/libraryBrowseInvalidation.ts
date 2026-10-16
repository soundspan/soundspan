import { queryKeys } from "./queryKeys";
import { isRemoteTrack } from "./trackRef";

/** The slice of a React Query client this helper needs. */
export interface InvalidatingQueryClient {
    invalidateQueries: (filters: { queryKey: readonly unknown[] }) => unknown;
}

/**
 * Liked TIDAL / YouTube Music tracks appear in the Library lists, so a change
 * to one of those likes refreshes Artists, Albums, and Songs. Local likes do
 * not change the lists and trigger nothing.
 */
export function invalidateLibraryAfterRemoteLike(
    queryClient: InvalidatingQueryClient,
    trackIds: readonly string[],
): boolean {
    if (!trackIds.some((id) => isRemoteTrack({ id }))) return false;
    for (const queryKey of [
        queryKeys.libraryArtistsAll(),
        queryKeys.libraryAlbumsAll(),
        queryKeys.libraryTracksAll(),
    ]) {
        void queryClient.invalidateQueries({ queryKey });
    }
    return true;
}
