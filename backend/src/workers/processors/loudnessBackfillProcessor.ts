import type { Job } from "bull";
import { createHash } from "crypto";
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
const LOUDNESS_SWEEP_JITTER_MS = 15 * 60_000;
const LOUDNESS_SWEEP_LOCK_TTL_MS = 60 * 60_000;
const LOUDNESS_SWEEP_LOCK_KEY = "scheduler:lock:loudness-backfill-sweep";
const LOUDNESS_ATTEMPT_KEY_PREFIX = "audio:analysis:loudness:attempts:";
const LOUDNESS_BACKFILL_MAX_FAILURES = 3;
const LOUDNESS_ATTEMPT_TTL_SECONDS = 30 * 24 * 60 * 60;
const PERMANENT_FAILURE_MARKER = "permanent";
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
    mode?: "startup" | "periodic" | "repeat";
    startAfterId?: string;
    sweepStartedAt?: string;
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
    fileModified: Date;
    fileSize: number;
};

type LoudnessSweepData = {
    mode?: "startup" | "periodic";
    startAfterId?: string;
    sweepStartedAt: string;
};

const backfillJobDataSchema = z.union([
    z.strictObject({ mode: z.literal("repeat") }),
    z.strictObject({
        mode: z.enum(["startup", "periodic"]).optional(),
        startAfterId: z.string().trim().min(1).max(128).optional(),
        sweepStartedAt: z.iso.datetime({ offset: true }),
    }),
]);

const CLAIM_SWEEP_SCRIPT = `
local owner = redis.call("GET", KEYS[1])
if not owner then
    local acquired = redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2], "NX")
    return acquired and 1 or 0
end
if owner == ARGV[1] then
    redis.call("PEXPIRE", KEYS[1], ARGV[2])
    return 1
end
return 0
`;

const RELEASE_SWEEP_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
end
return 0
`;

function emptyResult(continued = false): LoudnessBackfillResult {
    return {
        processed: 0,
        queued: 0,
        duplicates: 0,
        skipped: 0,
        continued,
        capacityLimited: false,
    };
}

function buildAttemptKey(track: BackfillTrack): string {
    const revision = `${track.id}\0${track.fileModified.toISOString()}\0${track.fileSize}`;
    const digest = createHash("sha256").update(revision).digest("hex");
    return `${LOUDNESS_ATTEMPT_KEY_PREFIX}${digest}`;
}

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
        select: {
            id: true,
            filePath: true,
            duration: true,
            fileModified: true,
            fileSize: true,
        },
    });
}

async function enqueueTrack(track: BackfillTrack, attemptKey: string) {
    if (track.filePath === null) return "skipped" as const;
    return enqueueReservedWork(schedulerQueue.client, {
        queueKey: AUDIO_ANALYSIS_QUEUE,
        trackId: track.id,
        payload: JSON.stringify({
            trackId: track.id,
            filePath: track.filePath,
            duration: track.duration,
            loudnessOnly: true,
            loudnessAttemptKey: attemptKey,
        }),
        maxDepth: config.analysisQueues.audioMaxDepth,
        reservationTtlSeconds: config.analysisQueues.reservationTtlSeconds,
    });
}

async function loadFailureCounts(
    tracks: readonly BackfillTrack[],
): Promise<Array<string | null>> {
    if (tracks.length === 0) return [];
    return schedulerQueue.client.mget(...tracks.map(buildAttemptKey));
}

type FailureState = number | typeof PERMANENT_FAILURE_MARKER;

function parseFailureState(value: string | null | undefined): FailureState {
    if (value === null || value === undefined) return 0;
    if (value === PERMANENT_FAILURE_MARKER) return value;
    if (!/^(0|[1-9]\d{0,15})$/.test(value)) {
        throw new Error("Loudness backfill failure count is invalid");
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error("Loudness backfill failure count is invalid");
    }
    return parsed;
}

async function claimSweep(sweepStartedAt: string): Promise<boolean> {
    const result = await schedulerQueue.client.eval(
        CLAIM_SWEEP_SCRIPT,
        1,
        LOUDNESS_SWEEP_LOCK_KEY,
        sweepStartedAt,
        String(LOUDNESS_SWEEP_LOCK_TTL_MS),
    );
    return result === 1;
}

async function releaseSweep(sweepStartedAt: string): Promise<void> {
    await schedulerQueue.client.eval(
        RELEASE_SWEEP_SCRIPT,
        1,
        LOUDNESS_SWEEP_LOCK_KEY,
        sweepStartedAt,
    );
}

async function deferPeriodicSweep(
    job: Job<LoudnessBackfillJobData>,
): Promise<void> {
    const sweepStartedAt = new Date().toISOString();
    const delay = Math.floor(Math.random() * LOUDNESS_SWEEP_JITTER_MS);
    await schedulerQueue.add(
        LOUDNESS_BACKFILL_JOB_NAME,
        { mode: "periodic", sweepStartedAt },
        {
            ...CONTINUATION_OPTIONS,
            delay,
            jobId: `scheduler:loudness-backfill:periodic:${job.id}`,
        },
    );
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

async function processBackfillBatch(
    batch: readonly BackfillTrack[],
    failureCounts: readonly (string | null)[],
    startAfterId: string | undefined,
): Promise<{ result: LoudnessBackfillResult; nextCursor?: string }> {
    const result = emptyResult();
    let nextCursor = startAfterId;
    for (let index = 0; index < batch.length; index += 1) {
        const track = batch[index];
        if (!track) break;
        const attemptKey = buildAttemptKey(track);
        const failureState = parseFailureState(failureCounts[index]);
        if (failureState === PERMANENT_FAILURE_MARKER) {
            result.processed += 1;
            result.skipped += 1;
            nextCursor = track.id;
            await schedulerQueue.client.expire(
                attemptKey,
                LOUDNESS_ATTEMPT_TTL_SECONDS,
            );
            log.warn(
                `Permanently skipping loudness backfill for track ${track.id} after a content failure`,
            );
            continue;
        }
        if (failureState >= LOUDNESS_BACKFILL_MAX_FAILURES) {
            result.processed += 1;
            result.skipped += 1;
            nextCursor = track.id;
            log.warn(
                `Cooling down loudness backfill for track ${track.id} after ${failureState} transient failures`,
            );
            continue;
        }
        const admission = await enqueueTrack(track, attemptKey);
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
    return { result, ...(nextCursor ? { nextCursor } : {}) };
}

async function processLoudnessSweep(
    data: LoudnessSweepData,
): Promise<LoudnessBackfillResult> {
    if (!(await claimSweep(data.sweepStartedAt))) {
        log.info("Skipped overlapping loudness backfill sweep");
        return emptyResult();
    }
    const batchSize = config.analysisQueues.loudnessBackfillBatchSize;
    const candidates = await loadBackfillPage(data.startAfterId);
    const batch = candidates.slice(0, batchSize);
    const failureCounts = await loadFailureCounts(batch);
    const page = await processBackfillBatch(
        batch,
        failureCounts,
        data.startAfterId,
    );
    page.result.continued =
        page.result.capacityLimited || candidates.length > batchSize;
    if (page.result.continued) {
        await enqueueContinuation(
            page.nextCursor,
            data.sweepStartedAt,
            page.result.capacityLimited,
        );
    } else {
        await releaseSweep(data.sweepStartedAt);
    }
    log.info(
        `Processed ${page.result.processed} loudness backfill rows (${page.result.queued} queued, ${page.result.duplicates} duplicate, ${page.result.skipped} skipped)`,
    );
    return page.result;
}

/** Process one bounded page and persist any continuation through Bull. */
export async function processLoudnessBackfill(
    job: Job<LoudnessBackfillJobData>,
): Promise<LoudnessBackfillResult> {
    const data = backfillJobDataSchema.parse(job.data);
    if (data.mode === "repeat") {
        await deferPeriodicSweep(job);
        return emptyResult(true);
    }
    return processLoudnessSweep(data);
}
