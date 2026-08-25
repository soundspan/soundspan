import { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import {
    albumOrphanRetentionGuardWhere,
    artistOrphanRetentionGuardWhere,
    providerTrackRetentionCutoff,
} from "./providerTrackRetention";
import { bumpSearchCacheVersion } from "./searchCacheVersion";
import { LIBRARY_SURFACE_ALBUM_LOCATIONS } from "../utils/librarySorting";

const cleanupLogger = logger.child("LibraryOrphanCleanup");
/** Keeps each deletion transaction near the provider GC's 100-row write cost. */
export const ORPHAN_CLEANUP_BATCH_SIZE = 100;
const ORPHAN_CLEANUP_MAX_ROWS_PER_PHASE = 10_000;
const ORPHAN_CLEANUP_MAX_BATCHES =
    ORPHAN_CLEANUP_MAX_ROWS_PER_PHASE / ORPHAN_CLEANUP_BATCH_SIZE;
const ORPHAN_CLEANUP_TRANSACTION_OPTIONS = {
    maxWait: 2_000,
    timeout: 15_000,
} as const;

/** Counts of catalog parents deleted after their last track was purged. */
export interface LibraryOrphanCleanupResult {
    albumsDeleted: number;
    artistsDeleted: number;
}

type CleanupClient = Prisma.TransactionClient;
type OrphanCandidate = Readonly<{ id: string }>;

function cursorWhere(afterId: string | undefined) {
    return afterId ? { id: { gt: afterId } } : {};
}

async function selectOrphanedAlbums(
    client: CleanupClient,
    cutoff: Date,
    afterId: string | undefined,
): Promise<OrphanCandidate[]> {
    return client.album.findMany({
        where: {
            ...cursorWhere(afterId),
            peerId: null,
            location: { in: [...LIBRARY_SURFACE_ALBUM_LOCATIONS] },
            tracks: { none: {} },
            ...albumOrphanRetentionGuardWhere(cutoff),
        },
        orderBy: { id: "asc" },
        take: ORPHAN_CLEANUP_BATCH_SIZE,
        select: { id: true },
    });
}

async function deleteOrphanedAlbums(
    client: CleanupClient,
    candidates: readonly OrphanCandidate[],
    writeTombstones: boolean,
    cutoff: Date,
): Promise<number> {
    if (candidates.length === 0) return 0;
    const result = await client.album.deleteMany({
        where: {
            id: { in: candidates.map((album) => album.id) },
            peerId: null,
            location: { in: [...LIBRARY_SURFACE_ALBUM_LOCATIONS] },
            tracks: { none: {} },
            ...albumOrphanRetentionGuardWhere(cutoff),
        },
    });
    if (writeTombstones && result.count > 0) {
        const deletedAlbums = await resolveDeletedAlbums(
            client,
            candidates,
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
    selected: readonly OrphanCandidate[],
    deletedCount: number,
): Promise<OrphanCandidate[]> {
    if (deletedCount === selected.length) return [...selected];
    const remaining = await client.album.findMany({
        where: { id: { in: selected.map((album) => album.id) } },
        take: selected.length,
        select: { id: true },
    });
    const remainingIds = new Set(remaining.map((album) => album.id));
    return selected.filter((album) => !remainingIds.has(album.id));
}

async function selectOrphanedArtists(
    client: CleanupClient,
    cutoff: Date,
    afterId: string | undefined,
): Promise<OrphanCandidate[]> {
    return client.artist.findMany({
        where: {
            ...cursorWhere(afterId),
            peerId: null,
            albums: { none: {} },
            ...artistOrphanRetentionGuardWhere(cutoff),
        },
        orderBy: { id: "asc" },
        take: ORPHAN_CLEANUP_BATCH_SIZE,
        select: { id: true },
    });
}

async function deleteOrphanedArtists(
    client: CleanupClient,
    candidates: readonly OrphanCandidate[],
    writeTombstones: boolean,
    cutoff: Date,
): Promise<number> {
    if (candidates.length === 0) return 0;
    const artistIds = candidates.map((artist) => artist.id);
    await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "Album"
        WHERE "artistId" IN (${Prisma.join(artistIds)})
        ORDER BY "id"
        FOR UPDATE
    `);
    const result = await client.artist.deleteMany({
        where: {
            id: { in: artistIds },
            peerId: null,
            albums: { none: {} },
            ...artistOrphanRetentionGuardWhere(cutoff),
        },
    });
    if (writeTombstones && result.count > 0) {
        const deletedArtists = await resolveDeletedArtists(
            client,
            candidates,
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
    selected: readonly OrphanCandidate[],
    deletedCount: number,
): Promise<OrphanCandidate[]> {
    if (deletedCount === selected.length) return [...selected];
    const remaining = await client.artist.findMany({
        where: { id: { in: selected.map((artist) => artist.id) } },
        take: selected.length,
        select: { id: true },
    });
    const remainingIds = new Set(remaining.map((artist) => artist.id));
    return selected.filter((artist) => !remainingIds.has(artist.id));
}

async function cleanupAlbumBatches(
    writeTombstones: boolean,
    cutoff: Date,
): Promise<number> {
    let afterId: string | undefined;
    let deletedTotal = 0;
    for (let index = 0; index < ORPHAN_CLEANUP_MAX_BATCHES; index += 1) {
        let selectedCount = ORPHAN_CLEANUP_BATCH_SIZE;
        let nextAfterId = afterId;
        try {
            deletedTotal += await prisma.$transaction(async (transaction) => {
                const candidates = await selectOrphanedAlbums(
                    transaction,
                    cutoff,
                    afterId,
                );
                selectedCount = candidates.length;
                nextAfterId = candidates.at(-1)?.id ?? afterId;
                return deleteOrphanedAlbums(
                    transaction,
                    candidates,
                    writeTombstones,
                    cutoff,
                );
            }, ORPHAN_CLEANUP_TRANSACTION_OPTIONS);
        } catch (error) {
            cleanupLogger.error("Album orphan cleanup batch failed", {
                error,
                batch: index + 1,
                afterId,
            });
        }
        afterId = nextAfterId;
        if (selectedCount < ORPHAN_CLEANUP_BATCH_SIZE) break;
    }
    return deletedTotal;
}

async function cleanupArtistBatches(
    writeTombstones: boolean,
    cutoff: Date,
): Promise<number> {
    let afterId: string | undefined;
    let deletedTotal = 0;
    for (let index = 0; index < ORPHAN_CLEANUP_MAX_BATCHES; index += 1) {
        let selectedCount = ORPHAN_CLEANUP_BATCH_SIZE;
        let nextAfterId = afterId;
        try {
            deletedTotal += await prisma.$transaction(async (transaction) => {
                const candidates = await selectOrphanedArtists(
                    transaction,
                    cutoff,
                    afterId,
                );
                selectedCount = candidates.length;
                nextAfterId = candidates.at(-1)?.id ?? afterId;
                return deleteOrphanedArtists(
                    transaction,
                    candidates,
                    writeTombstones,
                    cutoff,
                );
            }, ORPHAN_CLEANUP_TRANSACTION_OPTIONS);
        } catch (error) {
            cleanupLogger.error("Artist orphan cleanup batch failed", {
                error,
                batch: index + 1,
                afterId,
            });
        }
        afterId = nextAfterId;
        if (selectedCount < ORPHAN_CLEANUP_BATCH_SIZE) break;
    }
    return deletedTotal;
}

/** Deletes parents without local tracks or provider tracks retained by policy. */
export async function cleanupOrphanedLibraryEntities(
    now: Date = new Date(),
): Promise<LibraryOrphanCleanupResult> {
    const cutoff = providerTrackRetentionCutoff(
        now,
        config.workers.providerTrackRetentionDays,
    );
    const writeTombstones = config.features.federation;
    const albumsDeleted = await cleanupAlbumBatches(writeTombstones, cutoff);
    const artistsDeleted = await cleanupArtistBatches(writeTombstones, cutoff);

    if (albumsDeleted > 0 || artistsDeleted > 0) {
        await bumpSearchCacheVersion();
        cleanupLogger.info(
            `Deleted ${albumsDeleted} orphaned albums and ${artistsDeleted} orphaned artists`,
        );
    }
    return { albumsDeleted, artistsDeleted };
}
