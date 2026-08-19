import { prisma } from "../utils/db";
import { recomputeAlbumLoudness } from "./albumLoudness";

/** Deletes one track and refreshes its former album in the same transaction. */
export async function deleteTrackAndRecomputeAlbum(
    trackId: string,
): Promise<void> {
    await prisma.$transaction(async (transaction) => {
        const deletedTrack = await transaction.track.delete({
            where: { id: trackId },
            select: { id: true, albumId: true },
        });
        await recomputeAlbumLoudness(transaction, [deletedTrack.albumId]);
    });
}
