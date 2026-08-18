import type { Job } from "bull";
import { z } from "zod";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { enqueueReservedWork } from "../enrichmentQueue";
import { schedulerQueue } from "../queues";

const log = logger.child("LoudnessBackfillProcessor");
const AUDIO_ANALYSIS_QUEUE = "audio:analysis:queue";
const BETWEEN_PAGE_DELAY_MS = 5_000;
const QUEUE_FULL_DELAY_MS = 30_000;
const CONTINUATION_OPTIONS = {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 5_000 },
    removeOnComplete: true,
    removeOnFail: 10,
};

/** Bull job name for bounded loudness-measurement backfill pages. */
export const LOUDNESS_BACKFILL_JOB_NAME = "track-loudness-backfill";

/** Cursor payload persisted with each loudness backfill page. */
export interface LoudnessBackfillJobData {
    mode?: "startup";
    startAfterId?: string;
    sweepStartedAt: string;
}

/** Summary returned by one bounded loudness backfill page. */
export interface LoudnessBackfillResult {
    processed: number;
    queued: number;
    duplicates: number;
    skipped: number;
    continued: boolean;
    capacityLimited: boolean;
}

type BackfillTrack = {
    id: string;
    filePath: string | null;
    duration: number;
};

const backfillJobDataSchema = z.strictObject({
    mode: z.literal("startup").optional(),
    startAfterId: z.string().trim().min(1).max(128).optional(),
    sweepStartedAt: z.iso.datetime({ offset: true }),
});

async function loadBackfillPage(
    startAfterId: string | undefined,
): Promise<BackfillTrack[]> {
    const batchSize = config.analysisQueues.loudnessBackfillBatchSize;
    return prisma.track.findMany({
        where: {
            origin: "LOCAL",
            removedAt: null,
            analysisStatus: "completed",
            loudnessLufs: null,
            ...(startAfterId ? { id: { gt: startAfterId } } : {}),
        },
        orderBy: { id: "asc" },
        take: batchSize + 1,
        select: { id: true, filePath: true, duration: true },
    });
}

async function enqueueTrack(track: BackfillTrack) {
    if (track.filePath === null) return "skipped" as const;
    return enqueueReservedWork(schedulerQueue.client, {
        queueKey: AUDIO_ANALYSIS_QUEUE,
        trackId: track.id,
        payload: JSON.stringify({
            trackId: track.id,
            filePath: track.filePath,
            duration: track.duration,
            loudnessOnly: true,
        }),
        maxDepth: config.analysisQueues.audioMaxDepth,
        reservationTtlSeconds: config.analysisQueues.reservationTtlSeconds,
    });
}

async function enqueueContinuation(
    startAfterId: string | undefined,
    sweepStartedAt: string,
    capacityLimited: boolean,
): Promise<void> {
    const data = {
        ...(startAfterId ? { startAfterId } : {}),
        sweepStartedAt,
    };
    const options = {
        ...CONTINUATION_OPTIONS,
        delay: capacityLimited ? QUEUE_FULL_DELAY_MS : BETWEEN_PAGE_DELAY_MS,
        ...(capacityLimited
            ? {}
            : {
                  jobId: `scheduler:loudness-backfill:${sweepStartedAt}:${startAfterId}`,
              }),
    };
    await schedulerQueue.add(LOUDNESS_BACKFILL_JOB_NAME, data, options);
}

/** Process one bounded page and persist any continuation through Bull. */
export async function processLoudnessBackfill(
    job: Job<LoudnessBackfillJobData>,
): Promise<LoudnessBackfillResult> {
    const data = backfillJobDataSchema.parse(job.data);
    const batchSize = config.analysisQueues.loudnessBackfillBatchSize;
    const candidates = await loadBackfillPage(data.startAfterId);
    const batch = candidates.slice(0, batchSize);
    const result: LoudnessBackfillResult = {
        processed: 0,
        queued: 0,
        duplicates: 0,
        skipped: 0,
        continued: false,
        capacityLimited: false,
    };
    let nextCursor = data.startAfterId;

    for (let index = 0; index < batchSize; index += 1) {
        const track = batch[index];
        if (!track) break;
        const admission = await enqueueTrack(track);
        if (admission === "full") {
            result.capacityLimited = true;
            break;
        }
        result.processed += 1;
        result[
            admission === "queued"
                ? "queued"
                : admission === "duplicate"
                  ? "duplicates"
                  : "skipped"
        ] += 1;
        nextCursor = track.id;
    }

    result.continued = result.capacityLimited || candidates.length > batchSize;
    if (result.continued) {
        await enqueueContinuation(
            nextCursor,
            data.sweepStartedAt,
            result.capacityLimited,
        );
    }
    log.info(
        `Processed ${result.processed} loudness backfill rows (${result.queued} queued, ${result.duplicates} duplicate, ${result.skipped} skipped)`,
    );
    return result;
}
