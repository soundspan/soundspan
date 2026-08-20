import type { Prisma } from "@prisma/client";

/** Canonical ownership source for albums retained by a discovery like. */
export const DISCOVERY_LIKED_OWNERSHIP_SOURCE = "discovery_liked";

/** Album identity required to promote catalog ownership atomically. */
export interface AlbumOwnershipPromotion {
    id: string;
    artistId: string;
    rgMbid: string;
}

/** Promotes an album and records ownership in the caller's transaction. */
export async function promoteAlbumOwnership(
    transaction: Prisma.TransactionClient,
    album: AlbumOwnershipPromotion,
    source: string,
): Promise<void> {
    await transaction.album.update({
        where: { id: album.id },
        data: { location: "LIBRARY" },
    });
    await transaction.ownedAlbum.upsert({
        where: {
            artistId_rgMbid: {
                artistId: album.artistId,
                rgMbid: album.rgMbid,
            },
        },
        create: {
            artistId: album.artistId,
            rgMbid: album.rgMbid,
            source,
        },
        update: source === "native_scan" ? { source } : {},
    });
}
