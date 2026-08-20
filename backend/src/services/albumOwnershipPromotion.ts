import type { Prisma } from "@prisma/client";

/** Canonical ownership source for albums retained by a discovery like. */
export const DISCOVERY_LIKED_OWNERSHIP_SOURCE = "discovery_liked";

/** Ownership precedence applied when discovery likes promote an album. */
export const ALBUM_OWNERSHIP_SOURCE_HIERARCHY = {
    discoveryLikeUpgrades: ["enrichment", "discover_liked"],
    discoveryLikeCanonical: DISCOVERY_LIKED_OWNERSHIP_SOURCE,
    discoveryLikePreserves: "all_other_sources",
} as const;

type AlbumOwnershipPromotionSource =
    | "native_scan"
    | typeof DISCOVERY_LIKED_OWNERSHIP_SOURCE;

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
    source: AlbumOwnershipPromotionSource,
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
    if (source !== DISCOVERY_LIKED_OWNERSHIP_SOURCE) return;
    await transaction.ownedAlbum.updateMany({
        where: {
            artistId: album.artistId,
            rgMbid: album.rgMbid,
            source: {
                in: [...ALBUM_OWNERSHIP_SOURCE_HIERARCHY.discoveryLikeUpgrades],
            },
        },
        data: { source: DISCOVERY_LIKED_OWNERSHIP_SOURCE },
    });
}
