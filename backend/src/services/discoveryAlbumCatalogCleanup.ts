import { Prisma, type DiscoverStatus } from "@prisma/client";
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

async function restoreActiveDiscoveryRows(
    transaction: Prisma.TransactionClient,
    discoveryAlbumIds: readonly string[],
): Promise<void> {
    if (discoveryAlbumIds.length === 0) return;
    await transaction.discoveryAlbum.updateMany({
        where: {
            id: { in: [...discoveryAlbumIds] },
            status: "DELETED",
        },
        data: { status: "ACTIVE" },
    });
}

async function lockCatalogAlbum(
    transaction: Prisma.TransactionClient,
    catalogAlbumId: string,
): Promise<void> {
    await transaction.$queryRaw(
        Prisma.sql`
            SELECT "id"
            FROM "Album"
            WHERE "id" = ${catalogAlbumId}
            FOR UPDATE
        `,
    );
}

/**
 * Claims every linked eligible discovery row and deletes the catalog album.
 * A retry may reclaim DELETED; any linked LIKED or MOVED row retains content.
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
        const catalogAlbum = await resolveDiscoveryCatalogAlbum(
            transaction,
            discoveryIdentity,
        );
        if (!catalogAlbum) {
            const claim = await transaction.discoveryAlbum.updateMany({
                where: {
                    id: discoveryIdentity.id,
                    status: { in: [...CLEANUP_ELIGIBLE_STATUSES] },
                },
                data: { status: "DELETED" },
            });
            return claim.count === 1 ? "absent" : "retained";
        }

        // Stabilize the FK target before enumerating links. New link writers
        // must take a conflicting key-share lock and cannot escape the claim.
        await lockCatalogAlbum(transaction, catalogAlbum.id);
        const linkedRows = await transaction.discoveryAlbum.findMany({
            where: { catalogAlbumId: catalogAlbum.id },
            select: { id: true, status: true },
        });
        const allEligible = linkedRows.every((row) =>
            CLEANUP_ELIGIBLE_STATUSES.includes(row.status),
        );
        if (!allEligible) return "retained";

        const linkedIds = linkedRows.map((row) => row.id);
        const activeIds = linkedRows
            .filter((row) => row.status === "ACTIVE")
            .map((row) => row.id);
        const claim = await transaction.discoveryAlbum.updateMany({
            where: {
                id: { in: linkedIds },
                status: { in: [...CLEANUP_ELIGIBLE_STATUSES] },
            },
            data: { status: "DELETED" },
        });
        if (claim.count !== linkedRows.length) {
            await restoreActiveDiscoveryRows(transaction, activeIds);
            return "retained";
        }

        const unlinkedLikedRgMbids =
            await findUnlinkedLikedDiscoveryRgMbids(transaction);
        const retentionWhere = discoveryAlbumOrphanRetentionGuardWhere(
            cutoff,
            unlinkedLikedRgMbids,
        );
        const deleted = await transaction.album.deleteMany({
            where: { id: catalogAlbum.id, ...retentionWhere },
        });
        if (deleted.count === 1) {
            await transaction.discoveryTrack.deleteMany({
                where: { discoveryAlbumId: { in: linkedIds } },
            });
            return "deleted";
        }

        await restoreActiveDiscoveryRows(transaction, activeIds);
        return "retained";
    });
}
