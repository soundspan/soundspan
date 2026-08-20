import type { Prisma } from "@prisma/client";

/** Discovery identity used to resolve its catalog album without stale fallback. */
export interface DiscoveryCatalogIdentity {
    id: string;
    catalogAlbumId?: string | null;
    rgMbid: string;
    albumTitle: string;
    artistName: string;
}

/** Catalog album shape shared by discovery ownership workflows. */
export type DiscoveryCatalogAlbum = Prisma.AlbumGetPayload<{
    include: { artist: true };
}>;

/**
 * Resolves a discovery album's catalog row and persists a legacy fallback link.
 * A present link is authoritative even when its target no longer exists.
 */
export async function resolveDiscoveryCatalogAlbum(
    transaction: Prisma.TransactionClient,
    discoveryAlbum: DiscoveryCatalogIdentity,
): Promise<DiscoveryCatalogAlbum | null> {
    if (discoveryAlbum.catalogAlbumId) {
        return transaction.album.findUnique({
            where: { id: discoveryAlbum.catalogAlbumId },
            include: { artist: true },
        });
    }

    const catalogAlbum = await transaction.album.findFirst({
        where: {
            OR: [
                { rgMbid: discoveryAlbum.rgMbid },
                {
                    title: {
                        equals: discoveryAlbum.albumTitle,
                        mode: "insensitive",
                    },
                    artist: {
                        name: {
                            equals: discoveryAlbum.artistName,
                            mode: "insensitive",
                        },
                    },
                },
            ],
        },
        include: { artist: true },
    });
    if (!catalogAlbum) return null;

    await transaction.discoveryAlbum.updateMany({
        where: { id: discoveryAlbum.id, catalogAlbumId: null },
        data: { catalogAlbumId: catalogAlbum.id },
    });
    return catalogAlbum;
}
