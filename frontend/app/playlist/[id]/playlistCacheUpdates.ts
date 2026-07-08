/**
 * Pure cache-update helpers for the playlist detail page's React Query
 * entries (queryKey ["playlist", id]).
 */

interface CachedPlaylistItem {
    id: string;
    trackId?: string | null;
}

/**
 * Remove one playlist item from a cached playlist payload, mirroring the
 * backend's DELETE /playlists/:id/items/:trackId resolution: match by
 * playlist item id first, then fall back to the first item with a matching
 * track id. Returns the input unchanged (same reference) when there is no
 * match or the payload has no items array, so React Query skips a
 * re-render.
 */
export function removePlaylistItemFromCache<
    T extends { items?: CachedPlaylistItem[] },
>(old: T | undefined, itemIdOrTrackId: string): T | undefined {
    if (!old || !Array.isArray(old.items)) return old;

    let index = old.items.findIndex((item) => item.id === itemIdOrTrackId);
    if (index === -1) {
        index = old.items.findIndex(
            (item) => item.trackId === itemIdOrTrackId
        );
    }
    if (index === -1) return old;

    const items = old.items.slice();
    items.splice(index, 1);
    return { ...old, items };
}
