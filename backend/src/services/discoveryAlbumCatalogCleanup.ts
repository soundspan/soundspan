import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../utils/db";
import {
    discoveryAlbumOrphanRetentionGuardWhere,
    providerTrackRetentionCutoff,
} from "./providerTrackRetention";

/** Deletes one discovery album only while the shared retention guard permits it. */
export async function deleteDiscoveryAlbumCatalogEntry(
    identityWhere: Prisma.AlbumWhereInput,
    now: Date = new Date(),
): Promise<boolean> {
    const cutoff = providerTrackRetentionCutoff(
        now,
        config.workers.providerTrackRetentionDays,
    );
    const retentionWhere = discoveryAlbumOrphanRetentionGuardWhere(cutoff);
    return prisma.$transaction(async (transaction) => {
        const album = await transaction.album.findFirst({
            where: { ...identityWhere, ...retentionWhere },
            select: { id: true },
        });
        if (!album) return false;
        const result = await transaction.album.deleteMany({
            where: { id: album.id, ...retentionWhere },
        });
        return result.count === 1;
    });
}
