import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { recordProviderTrackGcPass } from "../metrics";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { cleanupOrphanedLibraryEntities } from "./libraryOrphanCleanup";
import {
    providerTrackCollectableWhere,
    providerTrackRetentionCutoff,
} from "./providerTrackRetention";

const log = logger.child("ProviderTrackGc");
const PROVIDER_BATCH_SIZE = 100;
const EMPTY_COUNTS = { tidal: 0, youtube: 0 } as const;

interface ProviderTrackCandidates {
    tidal: Array<{ id: string }>;
    youtube: Array<{ id: string }>;
}

/** Summary of one bounded provider-track garbage collection pass. */
export interface ProviderTrackGcResult {
    selected: { tidal: number; youtube: number };
    deleted: { tidal: number; youtube: number };
    orphanedParents: { albums: number; artists: number };
}

/** Optional deterministic inputs for one provider-track GC pass. */
export interface ProviderTrackGcOptions {
    now?: Date;
    retentionDays?: number;
}

async function loadCandidates(cutoff: Date): Promise<ProviderTrackCandidates> {
    const where = providerTrackCollectableWhere(cutoff);
    const [tidal, youtube] = await Promise.all([
        prisma.trackTidal.findMany({
            where,
            orderBy: { id: "asc" },
            take: PROVIDER_BATCH_SIZE,
            select: { id: true },
        }),
        prisma.trackYtMusic.findMany({
            where,
            orderBy: { id: "asc" },
            take: PROVIDER_BATCH_SIZE,
            select: { id: true },
        }),
    ]);
    return { tidal, youtube };
}

async function deleteUnlinkedMappings(
    transaction: Prisma.TransactionClient,
    candidates: ProviderTrackCandidates,
    cutoff: Date,
): Promise<void> {
    const where = providerTrackCollectableWhere(cutoff);
    const tidalIds = candidates.tidal.map((track) => track.id);
    const youtubeIds = candidates.youtube.map((track) => track.id);
    await transaction.trackMapping.deleteMany({
        where: {
            trackId: null,
            OR: [
                {
                    trackYtMusicId: null,
                    trackTidal: { id: { in: tidalIds }, ...where },
                },
                {
                    trackTidalId: null,
                    trackYtMusic: { id: { in: youtubeIds }, ...where },
                },
                {
                    trackTidal: { id: { in: tidalIds }, ...where },
                    trackYtMusic: { id: { in: youtubeIds }, ...where },
                },
            ],
        },
    });
}

async function deleteCandidates(
    candidates: ProviderTrackCandidates,
    cutoff: Date,
): Promise<{ tidal: number; youtube: number }> {
    return prisma.$transaction(async (transaction) => {
        await deleteUnlinkedMappings(transaction, candidates, cutoff);
        const where = providerTrackCollectableWhere(cutoff);
        const tidal = await transaction.trackTidal.deleteMany({
            where: {
                id: { in: candidates.tidal.map((track) => track.id) },
                ...where,
            },
        });
        const youtube = await transaction.trackYtMusic.deleteMany({
            where: {
                id: { in: candidates.youtube.map((track) => track.id) },
                ...where,
            },
        });
        return { tidal: tidal.count, youtube: youtube.count };
    });
}

function elapsedSeconds(startedAt: bigint): number {
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
}

/** Deletes at most 100 collectable rows per provider and cleans their parents. */
export async function collectProviderTracks(
    options: ProviderTrackGcOptions = {},
): Promise<ProviderTrackGcResult> {
    const startedAt = process.hrtime.bigint();
    const now = options.now ?? new Date();
    const retentionDays =
        options.retentionDays ?? config.workers.providerTrackRetentionDays;
    const cutoff = providerTrackRetentionCutoff(now, retentionDays);
    let deleted: { tidal: number; youtube: number } = EMPTY_COUNTS;

    try {
        const candidates = await loadCandidates(cutoff);
        const selected = {
            tidal: candidates.tidal.length,
            youtube: candidates.youtube.length,
        };
        deleted = await deleteCandidates(candidates, cutoff);
        const orphans = await cleanupOrphanedLibraryEntities(now);
        const durationSeconds = elapsedSeconds(startedAt);
        recordProviderTrackGcPass("success", durationSeconds, deleted);
        log.info("Provider track garbage collection pass completed", {
            cutoff: cutoff.toISOString(),
            retentionDays,
            selectedTidal: selected.tidal,
            selectedYoutube: selected.youtube,
            deletedTidal: deleted.tidal,
            deletedYoutube: deleted.youtube,
            orphanedAlbums: orphans.albumsDeleted,
            orphanedArtists: orphans.artistsDeleted,
            durationMs: Math.round(durationSeconds * 1000),
        });
        return {
            selected,
            deleted,
            orphanedParents: {
                albums: orphans.albumsDeleted,
                artists: orphans.artistsDeleted,
            },
        };
    } catch (error) {
        const durationSeconds = elapsedSeconds(startedAt);
        recordProviderTrackGcPass("failure", durationSeconds, deleted);
        log.error("Provider track garbage collection pass failed", {
            retentionDays,
            deletedTidal: deleted.tidal,
            deletedYoutube: deleted.youtube,
            durationMs: Math.round(durationSeconds * 1000),
            error,
        });
        throw error;
    }
}
