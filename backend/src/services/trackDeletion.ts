import { prisma } from "../utils/db";
import { recomputeAlbumLoudness } from "./albumLoudness";

/** Deletes one track and refreshes its former album in the same transaction. */
export async function deleteTrackAndRecomputeAlbum(
    trackId: string,
    albumId: string,
): Promise<void> {
    await prisma.$transaction(async (transaction) => {
        await transaction.track.delete({
            where: { id: trackId },
            select: { id: true },
        });
        await recomputeAlbumLoudness(transaction, [albumId]);
    });
}
