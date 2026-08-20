import type { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";

/** Updates album metadata while database cascades preserve existing ownership. */
export async function updateAlbumMetadataWithOwnership(
    albumId: string,
    data: Prisma.AlbumUpdateInput,
) {
    return prisma.$transaction(async (transaction) => {
        const album = await transaction.album.update({
            where: { id: albumId },
            data,
            include: {
                artist: { select: { id: true, name: true } },
                tracks: {
                    select: {
                        id: true,
                        title: true,
                        trackNo: true,
                        duration: true,
                    },
                },
            },
        });
        return album;
    });
}
