import { Prisma, type DiscoverStatus } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../utils/db";
import {
    DiscoveryCatalogResolutionError,
    type DiscoveryCatalogIdentity,
    resolveDiscoveryCatalogAlbum,
    retryDiscoveryLinkDrift,
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

class DiscoveryCatalogRetainedError extends Error {}

function requireEligibleStatuses(
    rows: readonly { status: DiscoverStatus }[],
): void {
    const allEligible = rows.every((row) =>
        CLEANUP_ELIGIBLE_STATUSES.includes(row.status),
    );
    if (!allEligible) {
        throw new DiscoveryCatalogRetainedError(
            "A linked discovery row is no longer cleanup eligible",
        );
    }
}

async function claimDiscoveryRows(
    transaction: Prisma.TransactionClient,
    discoveryAlbumIds: readonly string[],
): Promise<void> {
    const claim = await transaction.discoveryAlbum.updateMany({
        where: {
            id: { in: [...discoveryAlbumIds] },
            status: { in: [...CLEANUP_ELIGIBLE_STATUSES] },
        },
        data: { status: "DELETED" },
    });
    if (claim.count !== discoveryAlbumIds.length) {
        throw new DiscoveryCatalogRetainedError(
            "The cleanup claim changed after discovery rows were locked",
        );
    }
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
    try {
        return await retryDiscoveryLinkDrift(() =>
            prisma.$transaction(async (transaction) => {
                const resolution = await resolveDiscoveryCatalogAlbum(
                    transaction,
                    discoveryIdentity,
                    {
                        expectedStatuses: CLEANUP_ELIGIBLE_STATUSES,
                        lockAllLinkedRows: true,
                    },
                );
                if (!resolution) throw new DiscoveryCatalogRetainedError();

                requireEligibleStatuses(resolution.discoveryRows);
                const linkedIds = resolution.discoveryRows.map((row) => row.id);
                await claimDiscoveryRows(transaction, linkedIds);
                if (!resolution.catalogAlbum) return "absent";

                const unlinkedLikedRgMbids =
                    await findUnlinkedLikedDiscoveryRgMbids(transaction);
                const retentionWhere = discoveryAlbumOrphanRetentionGuardWhere(
                    cutoff,
                    unlinkedLikedRgMbids,
                );
                const deleted = await transaction.album.deleteMany({
                    where: {
                        id: resolution.catalogAlbum.id,
                        ...retentionWhere,
                    },
                });
                if (deleted.count !== 1) {
                    throw new DiscoveryCatalogRetainedError(
                        "The catalog album is retained",
                    );
                }
                await transaction.discoveryTrack.deleteMany({
                    where: { discoveryAlbumId: { in: linkedIds } },
                });
                return "deleted";
            }),
        );
    } catch (error: unknown) {
        if (
            error instanceof DiscoveryCatalogRetainedError ||
            error instanceof DiscoveryCatalogResolutionError
        ) {
            return "retained";
        }
        throw error;
    }
}
