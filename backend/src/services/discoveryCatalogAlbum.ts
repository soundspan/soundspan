import { Prisma } from "@prisma/client";

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

interface LockedDiscoveryCatalogLink {
    catalogAlbumId: string | null;
}

async function findFallbackCatalogAlbum(
    transaction: Prisma.TransactionClient,
    discoveryAlbum: DiscoveryCatalogIdentity,
): Promise<DiscoveryCatalogAlbum | null> {
    const exactMbid = await transaction.album.findFirst({
        where: { rgMbid: discoveryAlbum.rgMbid },
        include: { artist: true },
    });
    if (exactMbid) return exactMbid;
    return transaction.album.findFirst({
        where: {
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
        include: { artist: true },
    });
}

async function findCatalogAlbumById(
    transaction: Prisma.TransactionClient,
    catalogAlbumId: string | null,
): Promise<DiscoveryCatalogAlbum | null> {
    if (!catalogAlbumId) return null;
    return transaction.album.findUnique({
        where: { id: catalogAlbumId },
        include: { artist: true },
    });
}

/**
 * Resolves a discovery album's catalog row and persists a legacy fallback link.
 * A present link is authoritative even when its target no longer exists.
 */
export async function resolveDiscoveryCatalogAlbum(
    transaction: Prisma.TransactionClient,
    discoveryAlbum: DiscoveryCatalogIdentity,
): Promise<DiscoveryCatalogAlbum | null> {
    const lockedRows = await transaction.$queryRaw<
        LockedDiscoveryCatalogLink[]
    >(Prisma.sql`
        SELECT "catalogAlbumId"
        FROM "DiscoveryAlbum"
        WHERE "id" = ${discoveryAlbum.id}
        FOR UPDATE
    `);
    const lockedLink = lockedRows[0];
    if (!lockedLink) return null;
    if (lockedLink.catalogAlbumId) {
        return findCatalogAlbumById(transaction, lockedLink.catalogAlbumId);
    }

    const catalogAlbum = await findFallbackCatalogAlbum(
        transaction,
        discoveryAlbum,
    );
    if (!catalogAlbum) return null;

    const linked = await transaction.discoveryAlbum.updateMany({
        where: { id: discoveryAlbum.id, catalogAlbumId: null },
        data: { catalogAlbumId: catalogAlbum.id },
    });
    if (linked.count === 1) return catalogAlbum;

    const authoritative = await transaction.discoveryAlbum.findUnique({
        where: { id: discoveryAlbum.id },
        select: { catalogAlbumId: true },
    });
    return findCatalogAlbumById(
        transaction,
        authoritative?.catalogAlbumId ?? null,
    );
}
