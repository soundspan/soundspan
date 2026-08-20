import type { Prisma } from "@prisma/client";
import { prisma } from "../utils/db";

/** Ownership row to preserve or create after an album identity update. */
export interface AlbumOwnershipTarget {
    artistId: string;
    rgMbid: string;
}

/** Updates album metadata before ensuring its ownership row in one transaction. */
export async function updateAlbumMetadataWithOwnership(
    albumId: string,
    data: Prisma.AlbumUpdateInput,
    ownership: AlbumOwnershipTarget | null,
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
        if (ownership) {
            await transaction.ownedAlbum.upsert({
                where: {
                    artistId_rgMbid: {
                        artistId: ownership.artistId,
                        rgMbid: ownership.rgMbid,
                    },
                },
                create: {
                    artistId: ownership.artistId,
                    rgMbid: ownership.rgMbid,
                    source: "metadata_edit",
                },
                update: {},
            });
        }
        return album;
    });
}
