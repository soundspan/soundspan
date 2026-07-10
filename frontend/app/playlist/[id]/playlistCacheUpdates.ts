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
/**
 * Move one playlist item to a new index in a cached playlist payload
 * (GH #27 reorder). The target index is clamped to the items range.
 * Returns the input unchanged (same reference) when the item is missing,
 * the payload has no items array, or the move is a no-op, so React Query
 * skips a re-render.
 */
export function movePlaylistItemToIndexInCache<
    T extends { items?: CachedPlaylistItem[] },
>(old: T | undefined, itemId: string, toIndex: number): T | undefined {
    if (!old || !Array.isArray(old.items)) return old;

    const fromIndex = old.items.findIndex((item) => item.id === itemId);
    if (fromIndex === -1) return old;

    const clampedIndex = Math.max(0, Math.min(toIndex, old.items.length - 1));
    if (clampedIndex === fromIndex) return old;

    const items = old.items.slice();
    const [moved] = items.splice(fromIndex, 1);
    items.splice(clampedIndex, 0, moved);
    return { ...old, items };
}

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
