import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import {
    albumOrphanRetentionGuardWhere,
    artistOrphanRetentionGuardWhere,
    providerTrackRetentionCutoff,
} from "./providerTrackRetention";

const cleanupLogger = logger.child("LibraryOrphanCleanup");
const ORPHAN_CLEANUP_BATCH_SIZE = 10_000;

/** Counts of catalog parents deleted after their last track was purged. */
export interface LibraryOrphanCleanupResult {
    albumsDeleted: number;
    artistsDeleted: number;
}

/** Deletes albums without track rows, then artists without album rows. */
type CleanupClient = Prisma.TransactionClient | typeof prisma;

async function deleteOrphanedAlbums(
    client: CleanupClient,
    writeTombstones: boolean,
    cutoff: Date,
): Promise<number> {
    const retentionWhere = albumOrphanRetentionGuardWhere(cutoff);
    const orphanedAlbums = await client.album.findMany({
        where: {
            peerId: null,
            tracks: { none: {} },
            ...retentionWhere,
        },
        orderBy: { id: "asc" },
        take: ORPHAN_CLEANUP_BATCH_SIZE,
        select: { id: true },
    });
    if (orphanedAlbums.length === 0) return 0;
    const result = await client.album.deleteMany({
        where: {
            id: { in: orphanedAlbums.map((album) => album.id) },
            peerId: null,
            tracks: { none: {} },
            ...retentionWhere,
        },
    });
    if (writeTombstones && result.count > 0) {
        const deletedAlbums = await resolveDeletedAlbums(
            client,
            orphanedAlbums,
            result.count,
        );
        if (deletedAlbums.length !== result.count) {
            throw new Error(
                "Album deletion count changed during tombstone write",
            );
        }
        await client.federationTombstone.createMany({
            data: deletedAlbums.map((album) => ({
                entityType: "album",
                entityId: album.id,
            })),
        });
    }
    return result.count;
}

async function resolveDeletedAlbums(
    client: CleanupClient,
    selected: readonly { id: string }[],
    deletedCount: number,
): Promise<Array<{ id: string }>> {
    if (deletedCount === selected.length) return [...selected];
    const remaining = await client.album.findMany({
        where: { id: { in: selected.map((album) => album.id) } },
        take: selected.length,
        select: { id: true },
    });
    const remainingIds = new Set(remaining.map((album) => album.id));
    return selected.filter((album) => !remainingIds.has(album.id));
}

async function deleteOrphanedArtists(
    client: CleanupClient,
    writeTombstones: boolean,
    cutoff: Date,
): Promise<number> {
    const retentionWhere = artistOrphanRetentionGuardWhere(cutoff);
    const orphanedArtists = await client.artist.findMany({
        where: {
            peerId: null,
            albums: { none: {} },
            ...retentionWhere,
        },
        orderBy: { id: "asc" },
        take: ORPHAN_CLEANUP_BATCH_SIZE,
        select: { id: true },
    });
    if (orphanedArtists.length === 0) return 0;
    const result = await client.artist.deleteMany({
        where: {
            id: { in: orphanedArtists.map((artist) => artist.id) },
            peerId: null,
            albums: { none: {} },
            ...retentionWhere,
        },
    });
    if (writeTombstones && result.count > 0) {
        const deletedArtists = await resolveDeletedArtists(
            client,
            orphanedArtists,
            result.count,
        );
        if (deletedArtists.length !== result.count) {
            throw new Error(
                "Artist deletion count changed during tombstone write",
            );
        }
        await client.federationTombstone.createMany({
            data: deletedArtists.map((artist) => ({
                entityType: "artist",
                entityId: artist.id,
            })),
        });
    }
    return result.count;
}

async function resolveDeletedArtists(
    client: CleanupClient,
    selected: readonly { id: string }[],
    deletedCount: number,
): Promise<Array<{ id: string }>> {
    if (deletedCount === selected.length) return [...selected];
    const remaining = await client.artist.findMany({
        where: { id: { in: selected.map((artist) => artist.id) } },
        take: selected.length,
        select: { id: true },
    });
    const remainingIds = new Set(remaining.map((artist) => artist.id));
    return selected.filter((artist) => !remainingIds.has(artist.id));
}

async function cleanupWithClient(
    client: CleanupClient,
    writeTombstones: boolean,
    cutoff: Date,
): Promise<LibraryOrphanCleanupResult> {
    const albumsDeleted = await deleteOrphanedAlbums(
        client,
        writeTombstones,
        cutoff,
    );
    const artistsDeleted = await deleteOrphanedArtists(
        client,
        writeTombstones,
        cutoff,
    );
    return { albumsDeleted, artistsDeleted };
}

/** Deletes parents without local tracks or provider tracks retained by policy. */
export async function cleanupOrphanedLibraryEntities(
    now: Date = new Date(),
): Promise<LibraryOrphanCleanupResult> {
    const cutoff = providerTrackRetentionCutoff(
        now,
        config.workers.providerTrackRetentionDays,
    );
    const result = config.features.federation
        ? await prisma.$transaction((transaction) =>
              cleanupWithClient(transaction, true, cutoff),
          )
        : await cleanupWithClient(prisma, false, cutoff);

    if (result.albumsDeleted > 0 || result.artistsDeleted > 0) {
        cleanupLogger.info(
            `Deleted ${result.albumsDeleted} orphaned albums and ${result.artistsDeleted} orphaned artists`,
        );
    }
    return result;
}
