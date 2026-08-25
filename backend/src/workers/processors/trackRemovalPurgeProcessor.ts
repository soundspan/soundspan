import type { Job } from "bull";
import type { Prisma } from "@prisma/client";
import { randomUUID } from "crypto";
import { z } from "zod";
import { config } from "../../config";
import { updateArtistCountsInTransaction } from "../../services/artistCountsService";
import { cleanupOrphanedLibraryEntities } from "../../services/libraryOrphanCleanup";
import { collectProviderTracks } from "../../services/providerTrackGc";
import {
    clearLibraryHealthPurgeMarker,
    refreshLibraryHealthPurgeMarker,
    startLibraryHealthPurgeMarker,
} from "../../services/libraryHealthDashboard/purgeMarker";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { schedulerMaintenanceQueue } from "../queues";

const log = logger.child("TrackRemovalPurgeProcessor");
const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100;
const QUERY_SIZE = BATCH_SIZE + 1;
const COUNT_CORRECTION_PAGE_INTERVAL = 10;
const CONTINUATION_OPTIONS = {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 5_000 },
    removeOnComplete: true,
    removeOnFail: 10,
};

const safeCountSchema = z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER);
const rootPurgeJobDataSchema = z.strictObject({
    mode: z.enum(["startup", "repeat"]).optional(),
    cutoffAt: z.iso.datetime({ offset: true }).optional(),
    sweepRunId: z.string().trim().min(1).max(256).optional(),
});
const continuationPurgeJobDataSchema = z
    .strictObject({
        mode: z.enum(["startup", "repeat"]).optional(),
        startAfterId: z.string().trim().min(1).max(128).optional(),
        cutoffAt: z.iso.datetime({ offset: true }),
        deletedSoFar: safeCountSchema,
        sweepRunId: z.string().trim().min(1).max(256).optional(),
        initialTotal: safeCountSchema,
        processedSoFar: safeCountSchema,
        remaining: safeCountSchema,
        pageNumber: safeCountSchema.min(1),
    })
    .superRefine((data, context) => {
        const expectedRemaining = Math.max(
            0,
            data.initialTotal - data.processedSoFar,
        );
        if (data.remaining !== expectedRemaining) {
            context.addIssue({
                code: "custom",
                path: ["remaining"],
                message:
                    "Track removal purge continuation remaining count is inconsistent",
            });
        }
    });
const purgeJobDataSchema = z.union([
    continuationPurgeJobDataSchema,
    rootPurgeJobDataSchema,
]);

/** Bull job name for expired soft-removed track purge pages. */
export const TRACK_REMOVAL_PURGE_JOB_NAME = "track-removal-purge";

/** Persisted data for a scheduled purge, explicit-cutoff sweep, or continuation. */
export interface TrackRemovalPurgeJobData {
    mode?: "startup" | "repeat";
    startAfterId?: string;
    cutoffAt?: string;
    deletedSoFar?: number;
    sweepRunId?: string;
    initialTotal?: number;
    processedSoFar?: number;
    remaining?: number;
    pageNumber?: number;
}

/** Summary returned by one bounded purge page. */
export interface TrackRemovalPurgeResult {
    deleted: number;
    continued: boolean;
}

type PurgeCursor = {
    startAfterId?: string;
    cutoff: Date;
    deletedSoFar: number;
    sweepRunId: string;
    progress?: SweepProgress;
};

type SweepProgress = {
    sweepRunId: string;
    initialTotal: number;
    processedSoFar: number;
    remaining: number;
    pageNumber: number;
};

function parsePurgeCursor(data: unknown): PurgeCursor {
    const parsed = purgeJobDataSchema.parse(data ?? {});
    const cutoff = parsed.cutoffAt
        ? new Date(parsed.cutoffAt)
        : new Date(
              Date.now() - config.workers.trackRemovalRetentionDays * DAY_MS,
          );
    const isContinuation = "initialTotal" in parsed;
    const sweepRunId = parsed.sweepRunId ?? randomUUID();
    if (isContinuation && parsed.sweepRunId === undefined) {
        log.warn(
            "Legacy track removal purge continuation lacked sweepRunId; minted a replacement run id",
        );
    }
    const progress = isContinuation
        ? {
              sweepRunId,
              initialTotal: parsed.initialTotal,
              processedSoFar: parsed.processedSoFar,
              remaining: parsed.remaining,
              pageNumber: parsed.pageNumber,
          }
        : undefined;
    return {
        startAfterId: isContinuation ? parsed.startAfterId : undefined,
        cutoff,
        deletedSoFar: isContinuation ? parsed.deletedSoFar : 0,
        sweepRunId,
        progress,
    };
}

async function loadPurgePage(
    cursor: PurgeCursor,
): Promise<Array<{ id: string; album: { artistId: string } }>> {
    return prisma.track.findMany({
        where: {
            origin: "LOCAL",
            removedAt: { lt: cursor.cutoff },
            ...(cursor.startAfterId ? { id: { gt: cursor.startAfterId } } : {}),
        },
        orderBy: { id: "asc" },
        take: QUERY_SIZE,
        select: { id: true, album: { select: { artistId: true } } },
    });
}

async function deletePurgeBatch(
    batch: readonly { id: string; album: { artistId: string } }[],
    cutoff: Date,
): Promise<number> {
    if (batch.length === 0) return 0;
    return prisma.$transaction(async (transaction) => {
        const deleted = await deleteTrackRows(transaction, batch, cutoff);
        if (config.features.federation) {
            const deletedIds = await resolveDeletedTrackIds(
                transaction,
                batch,
                deleted,
            );
            if (deletedIds.length !== deleted) {
                throw new Error(
                    "Track deletion count changed during tombstone write",
                );
            }
            if (deletedIds.length > 0) {
                await transaction.federationTombstone.createMany({
                    data: deletedIds.map((entityId) => ({
                        entityType: "track",
                        entityId,
                    })),
                });
            }
        }
        if (deleted > 0) {
            await updateArtistCountsInTransaction(
                transaction,
                [...new Set(batch.map((track) => track.album.artistId))].sort(),
            );
        }
        return deleted;
    });
}

async function deleteTrackRows(
    client: typeof prisma | Prisma.TransactionClient,
    batch: readonly { id: string }[],
    cutoff: Date,
): Promise<number> {
    const trackIds = batch.map((track) => track.id);
    // TrackMapping.trackId is ON DELETE SET NULL, but the table's
    // requires-linkage check rejects rows with no linkage at all. Delete
    // mappings whose only linkage is a purged track before the track delete,
    // or the whole page fails on 23514.
    await client.trackMapping.deleteMany({
        where: {
            track: {
                id: { in: trackIds },
                origin: "LOCAL",
                removedAt: { lt: cutoff },
            },
            trackTidalId: null,
            trackYtMusicId: null,
        },
    });
    const result = await client.track.deleteMany({
        where: {
            id: { in: trackIds },
            origin: "LOCAL",
            removedAt: { lt: cutoff },
        },
    });
    return result.count;
}

async function resolveDeletedTrackIds(
    client: typeof prisma | Prisma.TransactionClient,
    batch: readonly { id: string }[],
    deleted: number,
): Promise<string[]> {
    if (deleted === batch.length) return batch.map((track) => track.id);
    const remaining = await client.track.findMany({
        where: { id: { in: batch.map((track) => track.id) } },
        take: batch.length,
        select: { id: true },
    });
    const remainingIds = new Set(remaining.map((track) => track.id));
    return batch.map((track) => track.id).filter((id) => !remainingIds.has(id));
}

async function enqueueContinuation(
    startAfterId: string | undefined,
    cutoff: Date,
    deletedSoFar: number,
    progress: SweepProgress,
): Promise<void> {
    const cursorKey = startAfterId ?? `restart-${progress.pageNumber}`;
    await schedulerMaintenanceQueue.add(
        TRACK_REMOVAL_PURGE_JOB_NAME,
        {
            ...(startAfterId ? { startAfterId } : {}),
            cutoffAt: cutoff.toISOString(),
            deletedSoFar,
            ...progress,
        },
        {
            ...CONTINUATION_OPTIONS,
            jobId: `scheduler:track-removal-purge:${progress.sweepRunId}:${cutoff.toISOString()}:${cursorKey}`,
        },
    );
    await refreshLibraryHealthPurgeMarker(
        progress.sweepRunId,
        progress.remaining,
    );
}

async function countPurgeTracks(
    cutoff: Date,
    startAfterId?: string,
): Promise<number> {
    return prisma.track.count({
        where: {
            origin: "LOCAL",
            removedAt: { lt: cutoff },
            ...(startAfterId ? { id: { gt: startAfterId } } : {}),
        },
    });
}

async function initializeSweepProgress(
    cursor: PurgeCursor,
): Promise<SweepProgress> {
    if (cursor.progress) return cursor.progress;
    const initialTotal = await countPurgeTracks(cursor.cutoff);
    return {
        sweepRunId: cursor.sweepRunId,
        initialTotal,
        processedSoFar: 0,
        remaining: initialTotal,
        pageNumber: 0,
    };
}

function advanceProgress(
    progress: SweepProgress,
    processed: number,
    correctedRemaining?: number,
): SweepProgress {
    const processedSoFar = sumSafeCount(
        progress.processedSoFar,
        processed,
        "processed",
    );
    const remaining =
        correctedRemaining ??
        Math.max(0, progress.initialTotal - processedSoFar);
    const initialTotal =
        correctedRemaining === undefined
            ? progress.initialTotal
            : sumSafeCount(processedSoFar, correctedRemaining, "initial total");
    const pageNumber = sumSafeCount(progress.pageNumber, 1, "page");
    return {
        ...progress,
        initialTotal,
        processedSoFar,
        remaining,
        pageNumber,
    };
}

async function continuePurge(
    batch: readonly { id: string }[],
    cursor: PurgeCursor,
    progress: SweepProgress,
    sweepDeleted: number,
): Promise<void> {
    const lastTrack = batch[BATCH_SIZE - 1];
    if (!lastTrack)
        throw new Error("Track removal purge continuation has no cursor");
    const nextPageNumber = progress.pageNumber + 1;
    const correction =
        nextPageNumber % COUNT_CORRECTION_PAGE_INTERVAL === 0
            ? await countPurgeTracks(cursor.cutoff, lastTrack.id)
            : undefined;
    const nextProgress = advanceProgress(progress, batch.length, correction);
    await enqueueContinuation(
        lastTrack.id,
        cursor.cutoff,
        sweepDeleted,
        nextProgress,
    );
}

async function finishPurge(
    sweepDeleted: number,
    sweepRunId: string,
): Promise<void> {
    await collectProviderTracks();
    if (sweepDeleted > 0) {
        await refreshCatalogAfterPurge(sweepDeleted);
    }
    await cleanupExpiredFederationTombstones(new Date());
    await clearLibraryHealthPurgeMarker(sweepRunId);
}

async function refreshCatalogAfterPurge(deleted: number): Promise<void> {
    const orphans = await cleanupOrphanedLibraryEntities();
    log.info(
        `Post-purge cleanup for ${deleted} tracks deleted ${orphans.albumsDeleted} albums and ${orphans.artistsDeleted} artists`,
    );
}

async function cleanupExpiredFederationTombstones(now: Date): Promise<void> {
    if (!config.features.federation) return;
    const cutoff = new Date(
        now.getTime() -
            config.workers.federationTombstoneRetentionDays * DAY_MS,
    );
    const result = await prisma.federationTombstone.deleteMany({
        where: { deletedAt: { lt: cutoff } },
    });
    if (result.count > 0) {
        log.info(`Deleted ${result.count} expired federation tombstones`);
    }
}

function sumSafeCount(left: number, right: number, label: string): number {
    const total = left + right;
    if (!Number.isSafeInteger(total)) {
        throw new Error(
            `Track removal purge ${label} count exceeded safe range`,
        );
    }
    return total;
}

async function finishOrRestartPurge(
    batch: readonly { id: string }[],
    cursor: PurgeCursor,
    progress: SweepProgress,
    sweepDeleted: number,
): Promise<boolean> {
    const remaining = await countPurgeTracks(cursor.cutoff);
    if (remaining === 0) {
        await finishPurge(sweepDeleted, progress.sweepRunId);
        return false;
    }
    const nextProgress = advanceProgress(progress, batch.length, remaining);
    await enqueueContinuation(
        undefined,
        cursor.cutoff,
        sweepDeleted,
        nextProgress,
    );
    return true;
}

/** Hard-deletes one bounded page of tracks past the removal retention window. */
export async function processTrackRemovalPurge(
    job: Job<TrackRemovalPurgeJobData>,
): Promise<TrackRemovalPurgeResult> {
    const cursor = parsePurgeCursor(job.data);
    // Persist a minted run id back into the job so Bull retries of this
    // same job reuse one marker owner instead of stranding the previous
    // attempt's marker under a fresh id.
    if ((job.data as { sweepRunId?: string })?.sweepRunId === undefined) {
        try {
            await job.update({ ...job.data, sweepRunId: cursor.sweepRunId });
        } catch (error) {
            log.warn("Could not persist purge sweepRunId onto the job", {
                error,
            });
        }
    }
    const progress = await initializeSweepProgress(cursor);
    if (cursor.progress) {
        await refreshLibraryHealthPurgeMarker(
            progress.sweepRunId,
            progress.remaining,
        );
    } else {
        await startLibraryHealthPurgeMarker(
            progress.sweepRunId,
            progress.remaining,
        );
    }
    const candidates = await loadPurgePage(cursor);
    const batch = candidates.slice(0, BATCH_SIZE);
    const deleted = await deletePurgeBatch(batch, cursor.cutoff);
    const sweepDeleted = sumSafeCount(cursor.deletedSoFar, deleted, "deleted");

    let continued: boolean;
    if (candidates.length > BATCH_SIZE) {
        await continuePurge(batch, cursor, progress, sweepDeleted);
        continued = true;
    } else {
        continued = await finishOrRestartPurge(
            batch,
            cursor,
            progress,
            sweepDeleted,
        );
    }
    log.info(
        `Purged ${deleted} expired removed tracks (selected ${batch.length}, sweepDeleted=${sweepDeleted}, continued=${continued})`,
    );
    return { deleted, continued };
}
