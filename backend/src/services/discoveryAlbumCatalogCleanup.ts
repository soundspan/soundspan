import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../utils/db";
import {
    discoveryAlbumOrphanRetentionGuardWhere,
    providerTrackRetentionCutoff,
} from "./providerTrackRetention";

/** Outcome of a guarded discovery catalog deletion attempt. */
export type DiscoveryAlbumCatalogDeleteResult =
    | "deleted"
    | "retained"
    | "absent";

/** Deletes one discovery album only while the shared retention guard permits it. */
export async function deleteDiscoveryAlbumCatalogEntry(
    identityWhere: Prisma.AlbumWhereInput,
    now: Date = new Date(),
): Promise<DiscoveryAlbumCatalogDeleteResult> {
    const cutoff = providerTrackRetentionCutoff(
        now,
        config.workers.providerTrackRetentionDays,
    );
    const retentionWhere = discoveryAlbumOrphanRetentionGuardWhere(cutoff);
    return prisma.$transaction(async (transaction) => {
        const album = await transaction.album.findFirst({
            where: identityWhere,
            select: { id: true },
        });
        if (!album) return "absent";
        const result = await transaction.album.deleteMany({
            where: { id: album.id, ...retentionWhere },
        });
        if (result.count === 1) return "deleted";
        const retained = await transaction.album.findUnique({
            where: { id: album.id },
            select: { id: true },
        });
        return retained ? "retained" : "absent";
    });
}
