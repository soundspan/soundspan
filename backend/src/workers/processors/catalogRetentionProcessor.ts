import { config } from "../../config";
import { recordCatalogReaped, setCatalogAlbumCount } from "../../metrics";
import { ACTIVE_DOWNLOAD_JOB_STATUSES } from "../../services/downloadJobStatus";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";

const DAY_MS = 24 * 60 * 60 * 1000;
const CATALOG_RETENTION_BATCH_SIZE = 50;
const RECENT_DOWNLOAD_RETENTION_DAYS = 30;
const log = logger.child("CatalogRetention");

interface CatalogRetentionResult {
    skipped: boolean;
    scanned: number;
    protected: number;
    reaped: number;
    remaining: number;
}

interface CatalogCandidate {
    id: string;
    rgMbid: string;
    tracks: Array<{ id: string }>;
}

interface CatalogReferences {
    rgMbids: Set<string>;
    trackIds: Set<string>;
}

function cutoffDaysAgo(now: Date, days: number): Date {
    return new Date(now.getTime() - days * DAY_MS);
}

async function loadRgReferences(
    rgMbids: readonly string[],
    recentDownloadCutoff: Date,
): Promise<Set<string>> {
    const [downloads, requests] = await Promise.all([
        prisma.downloadJob.findMany({
            where: {
                targetMbid: { in: [...rgMbids] },
                OR: [
                    { status: { in: [...ACTIVE_DOWNLOAD_JOB_STATUSES] } },
                    { updatedAt: { gte: recentDownloadCutoff } },
                ],
            },
            select: { targetMbid: true },
        }),
        prisma.musicRequest.findMany({
            where: { rgMbid: { in: [...rgMbids] } },
            select: { rgMbid: true },
        }),
    ]);
    return new Set([
        ...downloads.map((row) => row.targetMbid),
        ...requests.map((row) => row.rgMbid),
    ]);
}

async function loadTrackReferences(trackIds: readonly string[]) {
    const [likes, dislikes, ratings, playlistItems] = await Promise.all([
        prisma.likedTrack.findMany({
            where: { trackId: { in: [...trackIds] } },
            select: { trackId: true },
        }),
        prisma.dislikedEntity.findMany({
            where: {
                entityType: "track",
                entityId: { in: [...trackIds] },
            },
            select: { entityId: true },
        }),
        prisma.trackRating.findMany({
            where: { trackId: { in: [...trackIds] } },
            select: { trackId: true },
        }),
        prisma.playlistItem.findMany({
            where: { trackId: { in: [...trackIds] } },
            select: { trackId: true },
        }),
    ]);
    return new Set([
        ...likes.map((row) => row.trackId),
        ...dislikes.map((row) => row.entityId),
        ...ratings.map((row) => row.trackId),
        ...playlistItems.flatMap((row) => (row.trackId ? [row.trackId] : [])),
    ]);
}

async function loadCatalogReferences(
    candidates: readonly CatalogCandidate[],
    recentDownloadCutoff: Date,
): Promise<CatalogReferences> {
    const rgMbids = candidates.map((album) => album.rgMbid);
    const trackIds = candidates.flatMap((album) =>
        album.tracks.map((track) => track.id),
    );
    const [referencedRgMbids, referencedTrackIds] = await Promise.all([
        loadRgReferences(rgMbids, recentDownloadCutoff),
        loadTrackReferences(trackIds),
    ]);
    return { rgMbids: referencedRgMbids, trackIds: referencedTrackIds };
}

function referencedAlbumIds(
    candidates: readonly CatalogCandidate[],
    references: CatalogReferences,
): Set<string> {
    return new Set(
        candidates
            .filter(
                (album) =>
                    references.rgMbids.has(album.rgMbid) ||
                    album.tracks.some((track) =>
                        references.trackIds.has(track.id),
                    ),
            )
            .map((album) => album.id),
    );
}

async function loadExpiredCatalogCandidates(retentionCutoff: Date) {
    return prisma.album.findMany({
        where: {
            location: "CATALOG" as const,
            catalogTouchedAt: { lt: retentionCutoff },
        },
        orderBy: [{ catalogTouchedAt: "asc" as const }, { id: "asc" as const }],
        take: CATALOG_RETENTION_BATCH_SIZE,
        select: {
            id: true,
            rgMbid: true,
            tracks: { select: { id: true } },
        },
    });
}

async function deleteCatalogAlbums(
    reapIds: readonly string[],
    retentionCutoff: Date,
): Promise<number> {
    if (reapIds.length === 0) return 0;
    const deleted = await prisma.album.deleteMany({
        where: {
            id: { in: [...reapIds] },
            location: "CATALOG",
            catalogTouchedAt: { lt: retentionCutoff },
        },
    });
    return deleted.count;
}

/** Removes one bounded oldest-first batch of unreferenced catalog albums. */
export async function processCatalogRetention(): Promise<CatalogRetentionResult> {
    if (!config.catalogPersistence.enabled) {
        return {
            skipped: true,
            scanned: 0,
            protected: 0,
            reaped: 0,
            remaining: 0,
        };
    }

    const now = new Date();
    const retentionCutoff = cutoffDaysAgo(
        now,
        config.catalogPersistence.retentionDays,
    );
    const candidates = await loadExpiredCatalogCandidates(retentionCutoff);
    const references = await loadCatalogReferences(
        candidates,
        cutoffDaysAgo(now, RECENT_DOWNLOAD_RETENTION_DAYS),
    );
    const protectedIds = referencedAlbumIds(candidates, references);
    const reapIds = candidates
        .filter((album) => !protectedIds.has(album.id))
        .map((album) => album.id);
    const reaped = await deleteCatalogAlbums(reapIds, retentionCutoff);
    const remaining = await prisma.album.count({
        where: { location: "CATALOG" },
    });
    recordCatalogReaped(reaped);
    setCatalogAlbumCount(remaining);
    const result = {
        skipped: false,
        scanned: candidates.length,
        protected: protectedIds.size,
        reaped,
        remaining,
    };
    log.info("Catalog retention sweep complete", result);
    return result;
}
