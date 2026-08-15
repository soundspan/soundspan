import type { Job } from "bull";
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
        if (hasStartAfterId !== hasCutoffAt) {
            context.addIssue({
                code: "custom",
                message: "Track removal purge cursor and cutoff must be paired",
            });
        }
        const hasContinuation = hasStartAfterId && hasCutoffAt;
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

/** Persisted data for one bounded purge page or its continuation. */
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
    const result = await prisma.track.deleteMany({
        where: {
            id: { in: batch.map((track) => track.id) },
            removedAt: { lt: cutoff },
        },
    });
    return result.count;
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
    } else if (sweepDeleted > 0) {
        await refreshCatalogAfterPurge(sweepDeleted);
    }
    log.info(
        `Purged ${deleted} expired removed tracks (selected ${batch.length}, sweepDeleted=${sweepDeleted}, continued=${continued})`,
    );
    return { deleted, continued };
}
