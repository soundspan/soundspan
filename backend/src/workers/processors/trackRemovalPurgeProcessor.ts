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
    })
    .superRefine((data, context) => {
        if (Boolean(data.startAfterId) === Boolean(data.cutoffAt)) return;
        context.addIssue({
            code: "custom",
            message: "Track removal purge cursor and cutoff must be paired",
        });
    });

/** Bull job name for expired soft-removed track purge pages. */
export const TRACK_REMOVAL_PURGE_JOB_NAME = "track-removal-purge";

/** Persisted data for one bounded purge page or its continuation. */
export interface TrackRemovalPurgeJobData {
    mode?: "startup" | "repeat";
    startAfterId?: string;
    cutoffAt?: string;
}

/** Summary returned by one bounded purge page. */
export interface TrackRemovalPurgeResult {
    deleted: number;
    continued: boolean;
}

type PurgeCursor = { startAfterId?: string; cutoff: Date };

function parsePurgeCursor(data: unknown): PurgeCursor {
    const parsed = purgeJobDataSchema.parse(data ?? {});
    const cutoff = parsed.cutoffAt
        ? new Date(parsed.cutoffAt)
        : new Date(
              Date.now() - config.workers.trackRemovalRetentionDays * DAY_MS,
          );
    return { startAfterId: parsed.startAfterId, cutoff };
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
): Promise<void> {
    await schedulerQueue.add(
        TRACK_REMOVAL_PURGE_JOB_NAME,
        { startAfterId, cutoffAt: cutoff.toISOString() },
        {
            ...CONTINUATION_OPTIONS,
            jobId: `scheduler:track-removal-purge:${startAfterId}`,
        },
    );
}

async function refreshCatalogAfterPurge(): Promise<void> {
    const orphans = await cleanupOrphanedLibraryEntities();
    const counts = await backfillAllArtistCounts();
    log.info(
        `Post-purge cleanup deleted ${orphans.albumsDeleted} albums and ${orphans.artistsDeleted} artists; refreshed ${counts.processed} artist counts with ${counts.errors} errors`,
    );
}

/** Hard-deletes one bounded page of tracks past the removal retention window. */
export async function processTrackRemovalPurge(
    job: Job<TrackRemovalPurgeJobData>,
): Promise<TrackRemovalPurgeResult> {
    const cursor = parsePurgeCursor(job.data);
    const candidates = await loadPurgePage(cursor);
    const batch = candidates.slice(0, BATCH_SIZE);
    const deleted = await deletePurgeBatch(batch, cursor.cutoff);
    if (deleted > 0) await refreshCatalogAfterPurge();

    const continued = candidates.length > BATCH_SIZE;
    if (continued) {
        await enqueueContinuation(batch[BATCH_SIZE - 1].id, cursor.cutoff);
    }
    log.info(
        `Purged ${deleted} expired removed tracks (selected ${batch.length}, continued=${continued})`,
    );
    return { deleted, continued };
}
