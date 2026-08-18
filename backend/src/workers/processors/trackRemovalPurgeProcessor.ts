import type { Job } from "bull";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { config } from "../../config";
import { backfillAllArtistCounts } from "../../services/artistCountsService";
import { cleanupOrphanedLibraryEntities } from "../../services/libraryOrphanCleanup";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { schedulerQueue } from "../queues";

const log = logger.child("TrackRemovalPurgeProcessor");
const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 100;
const QUERY_SIZE = BATCH_SIZE + 1;
const CONTINUATION_OPTIONS = {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 5_000 },
    removeOnComplete: true,
    removeOnFail: 10,
};

const purgeJobDataSchema = z
    .strictObject({
        mode: z.enum(["startup", "repeat"]).optional(),
        startAfterId: z.string().trim().min(1).max(128).optional(),
        cutoffAt: z.iso.datetime({ offset: true }).optional(),
        deletedSoFar: z
            .number()
            .int()
            .nonnegative()
            .max(Number.MAX_SAFE_INTEGER)
            .optional(),
    })
    .superRefine((data, context) => {
        const hasStartAfterId = Boolean(data.startAfterId);
        const hasCutoffAt = Boolean(data.cutoffAt);
        if (hasStartAfterId && !hasCutoffAt) {
            context.addIssue({
                code: "custom",
                path: ["cutoffAt"],
                message: "Track removal purge continuation requires a cutoff",
            });
        }
        const hasContinuation = hasStartAfterId;
        if (hasContinuation !== (data.deletedSoFar !== undefined)) {
            context.addIssue({
                code: "custom",
                path: ["deletedSoFar"],
                message:
                    "Track removal purge continuation requires deletedSoFar",
            });
        }
    });

/** Bull job name for expired soft-removed track purge pages. */
export const TRACK_REMOVAL_PURGE_JOB_NAME = "track-removal-purge";

/** Persisted data for a scheduled purge, explicit-cutoff sweep, or continuation. */
export interface TrackRemovalPurgeJobData {
    mode?: "startup" | "repeat";
    startAfterId?: string;
    cutoffAt?: string;
    deletedSoFar?: number;
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
};

function parsePurgeCursor(data: unknown): PurgeCursor {
    const parsed = purgeJobDataSchema.parse(data ?? {});
    const cutoff = parsed.cutoffAt
        ? new Date(parsed.cutoffAt)
        : new Date(
              Date.now() - config.workers.trackRemovalRetentionDays * DAY_MS,
          );
    return {
        startAfterId: parsed.startAfterId,
        cutoff,
        deletedSoFar: parsed.deletedSoFar ?? 0,
    };
}

async function loadPurgePage(
    cursor: PurgeCursor,
): Promise<Array<{ id: string }>> {
    return prisma.track.findMany({
        where: {
            origin: "LOCAL",
            removedAt: { lt: cursor.cutoff },
            ...(cursor.startAfterId ? { id: { gt: cursor.startAfterId } } : {}),
        },
        orderBy: { id: "asc" },
        take: QUERY_SIZE,
        select: { id: true },
    });
}

async function deletePurgeBatch(
    batch: readonly { id: string }[],
    cutoff: Date,
): Promise<number> {
    if (batch.length === 0) return 0;
    if (!config.features.federation) {
        return deleteTrackRows(prisma, batch, cutoff);
    }
    return prisma.$transaction(async (transaction) => {
        const deleted = await deleteTrackRows(transaction, batch, cutoff);
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
        return deleted;
    });
}

async function deleteTrackRows(
    client: typeof prisma | Prisma.TransactionClient,
    batch: readonly { id: string }[],
    cutoff: Date,
): Promise<number> {
    const result = await client.track.deleteMany({
        where: {
            id: { in: batch.map((track) => track.id) },
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
    startAfterId: string,
    cutoff: Date,
    deletedSoFar: number,
): Promise<void> {
    await schedulerQueue.add(
        TRACK_REMOVAL_PURGE_JOB_NAME,
        { startAfterId, cutoffAt: cutoff.toISOString(), deletedSoFar },
        {
            ...CONTINUATION_OPTIONS,
            jobId: `scheduler:track-removal-purge:${cutoff.toISOString()}:${startAfterId}`,
        },
    );
}

async function refreshCatalogAfterPurge(deleted: number): Promise<void> {
    const orphans = await cleanupOrphanedLibraryEntities();
    const { processed, errors: failedCount } = await backfillAllArtistCounts();
    log.info(
        `Post-purge cleanup for ${deleted} tracks deleted ${orphans.albumsDeleted} albums and ${orphans.artistsDeleted} artists; refreshed ${processed} artist counts with ${failedCount} errors`,
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

function sumDeletedTracks(deletedSoFar: number, deleted: number): number {
    const total = deletedSoFar + deleted;
    if (!Number.isSafeInteger(total)) {
        throw new Error(
            "Track removal purge deleted count exceeded safe range",
        );
    }
    return total;
}

/** Hard-deletes one bounded page of tracks past the removal retention window. */
export async function processTrackRemovalPurge(
    job: Job<TrackRemovalPurgeJobData>,
): Promise<TrackRemovalPurgeResult> {
    const cursor = parsePurgeCursor(job.data);
    const candidates = await loadPurgePage(cursor);
    const batch = candidates.slice(0, BATCH_SIZE);
    const deleted = await deletePurgeBatch(batch, cursor.cutoff);
    const sweepDeleted = sumDeletedTracks(cursor.deletedSoFar, deleted);

    const continued = candidates.length > BATCH_SIZE;
    if (continued) {
        await enqueueContinuation(
            batch[BATCH_SIZE - 1].id,
            cursor.cutoff,
            sweepDeleted,
        );
    } else {
        if (sweepDeleted > 0) {
            await refreshCatalogAfterPurge(sweepDeleted);
        }
        await cleanupExpiredFederationTombstones(new Date());
    }
    log.info(
        `Purged ${deleted} expired removed tracks (selected ${batch.length}, sweepDeleted=${sweepDeleted}, continued=${continued})`,
    );
    return { deleted, continued };
}
