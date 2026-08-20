import type { DiscoverStatus, Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../utils/db";
import {
    type DiscoveryCatalogIdentity,
    resolveDiscoveryCatalogAlbum,
} from "./discoveryCatalogAlbum";
import {
    discoveryAlbumOrphanRetentionGuardWhere,
    findUnlinkedLikedDiscoveryRgMbids,
    providerTrackRetentionCutoff,
} from "./providerTrackRetention";

/** Outcome of a guarded discovery catalog deletion attempt. */
export type DiscoveryAlbumCatalogDeleteResult =
    | "deleted"
    | "retained"
    | "absent";

const CLEANUP_ELIGIBLE_STATUSES: readonly DiscoverStatus[] = [
    "ACTIVE",
    "DELETED",
];

async function restoreDiscoveryStatus(
    transaction: Prisma.TransactionClient,
    discoveryAlbumId: string,
    status: DiscoverStatus,
): Promise<void> {
    if (status === "DELETED") return;
    await transaction.discoveryAlbum.update({
        where: { id: discoveryAlbumId },
        data: { status },
    });
}

/**
 * Claims one discovery row and deletes its catalog album in one transaction.
 * A retry may reclaim DELETED; a concurrent LIKED transition retains content.
 */
export async function deleteDiscoveryAlbumCatalogEntry(
    discoveryIdentity: DiscoveryCatalogIdentity,
    now: Date = new Date(),
): Promise<DiscoveryAlbumCatalogDeleteResult> {
    const cutoff = providerTrackRetentionCutoff(
        now,
        config.workers.providerTrackRetentionDays,
    );
    return prisma.$transaction(async (transaction) => {
        const discoveryAlbum = await transaction.discoveryAlbum.findUnique({
            where: { id: discoveryIdentity.id },
            select: { status: true },
        });
        if (!discoveryAlbum) return "retained";

        const claim = await transaction.discoveryAlbum.updateMany({
            where: {
                id: discoveryIdentity.id,
                status: { in: [...CLEANUP_ELIGIBLE_STATUSES] },
            },
            data: { status: "DELETED" },
        });
        if (claim.count === 0) return "retained";
        const catalogAlbum = await resolveDiscoveryCatalogAlbum(
            transaction,
            discoveryIdentity,
        );
        if (!catalogAlbum) return "absent";

        const unlinkedLikedRgMbids =
            await findUnlinkedLikedDiscoveryRgMbids(transaction);
        const retentionWhere = discoveryAlbumOrphanRetentionGuardWhere(
            cutoff,
            unlinkedLikedRgMbids,
        );
        const deleted = await transaction.album.deleteMany({
            where: { id: catalogAlbum.id, ...retentionWhere },
        });
        if (deleted.count === 1) return "deleted";

        await restoreDiscoveryStatus(
            transaction,
            discoveryIdentity.id,
            discoveryAlbum.status,
        );
        return "retained";
    });
}
