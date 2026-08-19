import type { Prisma } from "@prisma/client";

export const PLAYLIST_REORDER_MAX_ITEMS = 1_000;

/** Playlist identity returned after locking an owned row for mutation. */
export type LockedPlaylist = {
    id: string;
    userId: string;
    mixId: string | null;
};

/** Signals that an owned playlist row could not be locked for mutation. */
export class PlaylistMutationLockNotFoundError extends Error {
    constructor() {
        super("Owned playlist disappeared before mutation");
        this.name = "PlaylistMutationLockNotFoundError";
    }
}

/** Locks an owned playlist row so every item mutation uses Playlist-first order. */
export async function takePlaylistLock(
    tx: Prisma.TransactionClient,
    playlistId: string,
    userId: string,
): Promise<LockedPlaylist | null> {
    const playlists = await tx.$queryRaw<LockedPlaylist[]>`
        SELECT p.id, p."userId", p."mixId"
        FROM "Playlist" p
        WHERE p.id = ${playlistId}
          AND p."userId" = ${userId}
        FOR UPDATE OF p
    `;
    return playlists[0] ?? null;
}

/** Requires an owned Playlist row lock before a transaction mutates its items. */
export async function requirePlaylistMutationLock(
    tx: Prisma.TransactionClient,
    playlistId: string,
    userId: string,
): Promise<void> {
    const playlist = await takePlaylistLock(tx, playlistId, userId);
    if (!playlist) {
        throw new PlaylistMutationLockNotFoundError();
    }
}

/** Removes one item after acquiring its owned Playlist row lock. */
export async function removeLockedPlaylistItem(
    tx: Prisma.TransactionClient,
    playlistId: string,
    userId: string,
    itemId: string,
): Promise<void> {
    await requirePlaylistMutationLock(tx, playlistId, userId);
    await tx.playlistItem.delete({ where: { id: itemId } });
    await tx.playlist.update({
        where: { id: playlistId },
        data: { updatedAt: new Date() },
    });
}

/** Reorders a bounded item set after acquiring its owned Playlist row lock. */
export async function reorderLockedPlaylistItems(
    tx: Prisma.TransactionClient,
    playlistId: string,
    userId: string,
    ids: readonly string[],
    byItemId: boolean,
): Promise<void> {
    await requirePlaylistMutationLock(tx, playlistId, userId);
    for (let index = 0; index < PLAYLIST_REORDER_MAX_ITEMS; index += 1) {
        const id = ids[index];
        if (id === undefined) break;
        if (byItemId) {
            await tx.playlistItem.update({
                where: { id },
                data: { sort: index },
            });
        } else {
            await tx.playlistItem.update({
                where: {
                    playlistId_trackId: { playlistId, trackId: id },
                },
                data: { sort: index },
            });
        }
    }
    await tx.playlist.update({
        where: { id: playlistId },
        data: { updatedAt: new Date() },
    });
}
