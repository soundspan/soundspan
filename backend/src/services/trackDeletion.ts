import { prisma } from "../utils/db";
import { recomputeAlbumLoudness } from "./albumLoudness";

/**
 * Deletes one track and refreshes its former album in the same transaction.
 * The deleted row's albumId is authoritative; the caller-observed album is
 * also recomputed when a concurrent reassignment made them differ.
 */
export async function deleteTrackAndRecomputeAlbum(
    trackId: string,
    observedAlbumId: string,
): Promise<void> {
    await prisma.$transaction(async (transaction) => {
        const deletedTrack = await transaction.track.delete({
            where: { id: trackId },
            select: { id: true, albumId: true },
        });
        const albumIds = [...new Set([deletedTrack.albumId, observedAlbumId])];
        await recomputeAlbumLoudness(transaction, albumIds);
    });
}
