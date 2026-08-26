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

/** Resolves two persisted ownership sources using canonical promotion rules. */
export function selectPreferredAlbumOwnershipSource(
    existingSource: string | undefined,
    incomingSource: string,
): string {
    if (!existingSource || incomingSource === "native_scan") {
        return incomingSource;
    }
    if (existingSource === "native_scan") return existingSource;
    const discoveryUpgrades = new Set<string>(
        ALBUM_OWNERSHIP_SOURCE_HIERARCHY.discoveryLikeUpgrades,
    );
    if (
        incomingSource === DISCOVERY_LIKED_OWNERSHIP_SOURCE &&
        discoveryUpgrades.has(existingSource)
    ) {
        return incomingSource;
    }
    return existingSource;
}

/** Album identity required to promote catalog ownership atomically. */
export interface AlbumOwnershipPromotion {
    id: string;
    artistId: string;
    rgMbid: string;
}

/** Promotes an album's catalog location within the caller's transaction. */
export async function promoteAlbumLocation(
    transaction: Prisma.TransactionClient,
    albumId: string,
): Promise<void> {
    await transaction.album.update({
        where: { id: albumId },
        data: { location: "LIBRARY" },
    });
}

/** Promotes an album and records ownership in the caller's transaction. */
export async function promoteAlbumOwnership(
    transaction: Prisma.TransactionClient,
    album: AlbumOwnershipPromotion,
    source: AlbumOwnershipPromotionSource,
): Promise<void> {
    await promoteAlbumLocation(transaction, album.id);
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
