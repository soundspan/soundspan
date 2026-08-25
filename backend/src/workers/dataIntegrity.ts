/**
 * Data Integrity Worker
 *
 * Periodic cleanup to maintain database health:
 * 1. Remove expired DiscoverExclusion records
 * 2. Clean up orphaned DiscoveryTrack records
 * 3. Clean up orphaned Album records (DISCOVER location with no DiscoveryAlbum)
 * 4. Consolidate duplicate artists (temp MBID vs real MBID)
 * 5. Clean up orphaned artists (no albums)
 * 6. Clean up old completed/failed DownloadJob records
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import type { Prisma } from "@prisma/client";
import { withPrismaRetry } from "../utils/prismaRetry";
import { config } from "../config";
import { cleanupOrphanedLibraryEntities } from "../services/libraryOrphanCleanup";
import { DISCOVERY_LIKED_OWNERSHIP_SOURCE } from "../services/albumOwnershipPromotion";
import {
    albumOrphanRetentionGuardWhere,
    artistOrphanRetentionGuardWhere,
    discoveryAlbumOrphanRetentionGuardWhere,
    providerTrackRetentionCutoff,
} from "../services/providerTrackRetention";
import {
    addDiscoveryAlbumMarkers,
    addDownloadJobMarkers,
    createDiscoveryMarkers,
    findMislocatedAlbums,
    findUnprotectedDiscoverAlbumIds,
    type AlbumCandidate,
    type DiscoveryMarkers,
} from "./dataIntegrityBatches";

const DATA_INTEGRITY_BATCH_SIZE = 250;
const DATA_INTEGRITY_MAX_PAGES = 1_000;
const DATA_INTEGRITY_MAX_MARKERS = 250_000;
const log = logger.child("DataIntegrity");

interface IntegrityReport {
    expiredExclusions: number;
    orphanedDiscoveryTracks: number;
    mislocatedAlbums: number;
    orphanedAlbums: number;
    consolidatedArtists: number;
    orphanedArtists: number;
    oldDownloadJobs: number;
}

type CursorRow = { id: string };
type BatchLoader<T extends CursorRow> = (cursor?: string) => Promise<T[]>;

async function scanBatches<T extends CursorRow>(
    operationName: string,
    load: BatchLoader<T>,
    consume: (rows: T[]) => Promise<void> | void,
): Promise<void> {
    let cursor: string | undefined;
    for (let page = 0; page < DATA_INTEGRITY_MAX_PAGES; page += 1) {
        const rows = await withPrismaRetry(operationName, () => load(cursor));
        if (rows.length === 0) return;
        await consume(rows);
        if (rows.length < DATA_INTEGRITY_BATCH_SIZE) return;
        cursor = rows[rows.length - 1].id;
    }
    const overflow = await withPrismaRetry(operationName, () => load(cursor));
    if (overflow.length > 0) {
        log.warn(
            `${operationName} truncated at ${DATA_INTEGRITY_MAX_PAGES * DATA_INTEGRITY_BATCH_SIZE} rows`,
        );
    }
}

async function removeExpiredRows(
    report: IntegrityReport,
    now: Date,
): Promise<void> {
    const exclusions = await withPrismaRetry(
        "runDataIntegrityCheck.discoverExclusion.deleteMany",
        () =>
            prisma.discoverExclusion.deleteMany({
                where: { expiresAt: { lt: now } },
            }),
    );
    report.expiredExclusions = exclusions.count;
    const tracks = await withPrismaRetry(
        "runDataIntegrityCheck.discoveryTrack.deleteMany",
        () => prisma.discoveryTrack.deleteMany({ where: { trackId: null } }),
    );
    report.orphanedDiscoveryTracks = tracks.count;
}

async function findDiscoveryReferences(albums: AlbumCandidate[]) {
    return withPrismaRetry(
        "runDataIntegrityCheck.discoveryAlbum.findMany.activeBatch",
        () =>
            prisma.discoveryAlbum.findMany({
                where: {
                    status: { in: ["ACTIVE", "LIKED", "MOVED"] },
                    OR: [
                        { rgMbid: { in: albums.map((album) => album.rgMbid) } },
                        ...albums.map((album) => ({
                            albumTitle: {
                                equals: album.title,
                                mode: "insensitive" as const,
                            },
                            artistName: {
                                equals: album.artist.name,
                                mode: "insensitive" as const,
                            },
                        })),
                    ],
                },
                select: { rgMbid: true, albumTitle: true, artistName: true },
            }),
    );
}

async function findOwnedReferences(albums: AlbumCandidate[]) {
    return withPrismaRetry(
        "runDataIntegrityCheck.ownedAlbum.findMany.batch",
        () =>
            prisma.ownedAlbum.findMany({
                where: {
                    OR: albums.map((album) => ({
                        artistId: album.artistId,
                        rgMbid: album.rgMbid,
                    })),
                },
                select: { artistId: true, rgMbid: true },
            }),
    );
}

async function removeOrphanedDiscoverTracks(
    albumRetentionWhere: Prisma.AlbumWhereInput,
    cutoff: Date,
): Promise<void> {
    await scanBatches(
        "runDataIntegrityCheck.album.findMany.discoverBatch",
        (cursor) =>
            prisma.album.findMany({
                where: {
                    location: "DISCOVER",
                    ...albumRetentionWhere,
                    ...(cursor ? { id: { gt: cursor } } : {}),
                },
                orderBy: { id: "asc" },
                take: DATA_INTEGRITY_BATCH_SIZE,
                select: {
                    id: true,
                    rgMbid: true,
                    title: true,
                    artistId: true,
                    artist: { select: { name: true, mbid: true } },
                },
            }),
        async (albums) => {
            const [discovery, owned] = await Promise.all([
                findDiscoveryReferences(albums),
                findOwnedReferences(albums),
            ]);
            const orphanIds = findUnprotectedDiscoverAlbumIds(
                albums,
                discovery,
                owned,
            );
            if (orphanIds.length === 0) return;
            await withPrismaRetry(
                "runDataIntegrityCheck.track.deleteMany.orphanedAlbumBatch",
                () =>
                    prisma.track.deleteMany({
                        where: {
                            albumId: { in: orphanIds },
                            album: discoveryAlbumOrphanRetentionGuardWhere(
                                cutoff,
                            ),
                        },
                    }),
            );
        },
    );
}

async function collectDiscoveryMarkers(): Promise<DiscoveryMarkers> {
    const markers = createDiscoveryMarkers(DATA_INTEGRITY_MAX_MARKERS);
    await scanBatches(
        "runDataIntegrityCheck.downloadJob.findMany.discoveryBatch",
        (cursor) =>
            prisma.downloadJob.findMany({
                where: {
                    discoveryBatchId: { not: null },
                    status: { in: ["pending", "processing", "completed"] },
                    ...(cursor ? { id: { gt: cursor } } : {}),
                },
                orderBy: { id: "asc" },
                take: DATA_INTEGRITY_BATCH_SIZE,
                select: { id: true, metadata: true },
            }),
        (jobs) => addDownloadJobMarkers(markers, jobs),
    );
    await scanBatches(
        "runDataIntegrityCheck.discoveryAlbum.findMany.markerBatch",
        (cursor) =>
            prisma.discoveryAlbum.findMany({
                where: cursor ? { id: { gt: cursor } } : undefined,
                orderBy: { id: "asc" },
                take: DATA_INTEGRITY_BATCH_SIZE,
                select: {
                    id: true,
                    albumTitle: true,
                    artistName: true,
                    artistMbid: true,
                },
            }),
        (albums) => addDiscoveryAlbumMarkers(markers, albums),
    );
    return markers;
}

async function findProtectedArtistIds(albums: AlbumCandidate[]) {
    const rows = await withPrismaRetry(
        "runDataIntegrityCheck.ownedAlbum.findMany.protectedBatch",
        () =>
            prisma.ownedAlbum.findMany({
                where: {
                    artistId: { in: albums.map((album) => album.artistId) },
                    source: {
                        in: ["native_scan", DISCOVERY_LIKED_OWNERSHIP_SOURCE],
                    },
                },
                select: { artistId: true },
                distinct: ["artistId"],
            }),
    );
    return new Set(rows.map((row) => row.artistId));
}

async function findLikedArtistMbids(albums: AlbumCandidate[]) {
    const mbids = albums.flatMap((album) =>
        album.artist.mbid ? [album.artist.mbid] : [],
    );
    if (mbids.length === 0) return new Set<string>();
    const rows = await withPrismaRetry(
        "runDataIntegrityCheck.discoveryAlbum.findMany.likedBatch",
        () =>
            prisma.discoveryAlbum.findMany({
                where: {
                    artistMbid: { in: mbids },
                    status: { in: ["LIKED", "MOVED"] },
                },
                select: { artistMbid: true },
                distinct: ["artistMbid"],
            }),
    );
    return new Set(
        rows.flatMap((row) => (row.artistMbid ? [row.artistMbid] : [])),
    );
}

async function relocateLibraryBatch(
    albums: AlbumCandidate[],
    markers: DiscoveryMarkers,
): Promise<number> {
    const [protectedArtists, likedMbids] = await Promise.all([
        findProtectedArtistIds(albums),
        findLikedArtistMbids(albums),
    ]);
    const mislocated = findMislocatedAlbums(
        albums,
        markers,
        protectedArtists,
        likedMbids,
    );
    if (mislocated.length === 0) return 0;
    const ids = mislocated.map((album) => album.id);
    const rgMbids = mislocated.map((album) => album.rgMbid);
    const updated = await withPrismaRetry(
        "runDataIntegrityCheck.album.updateMany.mislocatedBatch",
        () =>
            prisma.album.updateMany({
                where: { id: { in: ids }, location: "LIBRARY" },
                data: { location: "DISCOVER" },
            }),
    );
    await withPrismaRetry(
        "runDataIntegrityCheck.ownedAlbum.deleteMany.mislocatedBatch",
        () =>
            prisma.ownedAlbum.deleteMany({
                where: {
                    rgMbid: { in: rgMbids },
                    source: { not: "native_scan" },
                },
            }),
    );
    return updated.count;
}

async function fixMislocatedAlbums(markers: DiscoveryMarkers): Promise<number> {
    let fixed = 0;
    await scanBatches(
        "runDataIntegrityCheck.album.findMany.libraryBatch",
        (cursor) =>
            prisma.album.findMany({
                where: {
                    location: "LIBRARY",
                    ...(cursor ? { id: { gt: cursor } } : {}),
                },
                orderBy: { id: "asc" },
                take: DATA_INTEGRITY_BATCH_SIZE,
                select: {
                    id: true,
                    rgMbid: true,
                    title: true,
                    artistId: true,
                    artist: { select: { name: true, mbid: true } },
                },
            }),
        async (albums) => {
            fixed += await relocateLibraryBatch(albums, markers);
        },
    );
    return fixed;
}

async function consolidateArtistBatch(
    artists: Array<{ id: string; normalizedName: string }>,
): Promise<number> {
    const realArtists = await withPrismaRetry(
        "runDataIntegrityCheck.artist.findMany.realBatch",
        () =>
            prisma.artist.findMany({
                where: {
                    normalizedName: {
                        in: artists.map((row) => row.normalizedName),
                    },
                    mbid: { not: { startsWith: "temp-" } },
                },
                orderBy: { id: "asc" },
                select: { id: true, normalizedName: true },
            }),
    );
    const realByName = new Map<string, string>();
    for (const artist of realArtists) {
        if (!realByName.has(artist.normalizedName)) {
            realByName.set(artist.normalizedName, artist.id);
        }
    }
    let consolidated = 0;
    for (const artist of artists) {
        const realId = realByName.get(artist.normalizedName);
        if (!realId) continue;
        await withPrismaRetry(
            "runDataIntegrityCheck.album.updateMany.consolidateArtist",
            () =>
                prisma.album.updateMany({
                    where: { artistId: artist.id },
                    data: { artistId: realId },
                }),
        );
        consolidated += 1;
    }
    return consolidated;
}

async function consolidateTempArtists(
    artistRetentionWhere: Prisma.ArtistWhereInput,
): Promise<number> {
    let consolidated = 0;
    await scanBatches(
        "runDataIntegrityCheck.artist.findMany.tempBatch",
        (cursor) =>
            prisma.artist.findMany({
                where: {
                    mbid: { startsWith: "temp-" },
                    ...artistRetentionWhere,
                    ...(cursor ? { id: { gt: cursor } } : {}),
                },
                orderBy: { id: "asc" },
                take: DATA_INTEGRITY_BATCH_SIZE,
                select: { id: true, normalizedName: true },
            }),
        async (artists) => {
            consolidated += await consolidateArtistBatch(artists);
        },
    );
    return consolidated;
}

async function removeOldDownloadJobs(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000);
    const result = await withPrismaRetry(
        "runDataIntegrityCheck.downloadJob.deleteMany.oldJobs",
        () =>
            prisma.downloadJob.deleteMany({
                where: {
                    status: { in: ["completed", "failed"] },
                    completedAt: { lt: cutoff },
                },
            }),
    );
    return result.count;
}

function logReport(report: IntegrityReport): void {
    log.debug("Data integrity check complete", report);
}

/** Runs bounded, cursor-paginated database integrity maintenance. */
export async function runDataIntegrityCheck(): Promise<IntegrityReport> {
    log.debug("Running data integrity check");
    const now = new Date();
    const cutoff = providerTrackRetentionCutoff(
        now,
        config.workers.providerTrackRetentionDays,
    );
    const albumRetentionWhere = albumOrphanRetentionGuardWhere(cutoff);
    const artistRetentionWhere = artistOrphanRetentionGuardWhere(cutoff);

    const report: IntegrityReport = {
        expiredExclusions: 0,
        orphanedDiscoveryTracks: 0,
        mislocatedAlbums: 0,
        orphanedAlbums: 0,
        consolidatedArtists: 0,
        orphanedArtists: 0,
        oldDownloadJobs: 0,
    };

    await removeExpiredRows(report, now);
    await removeOrphanedDiscoverTracks(albumRetentionWhere, cutoff);
    const markers = await collectDiscoveryMarkers();
    report.mislocatedAlbums = await fixMislocatedAlbums(markers);
    report.consolidatedArtists =
        await consolidateTempArtists(artistRetentionWhere);
    const orphanedParents = await cleanupOrphanedLibraryEntities(now);
    report.orphanedAlbums = orphanedParents.albumsDeleted;
    report.orphanedArtists = orphanedParents.artistsDeleted;
    report.oldDownloadJobs = await removeOldDownloadJobs(now);
    logReport(report);
    return report;
}
