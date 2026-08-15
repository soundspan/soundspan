import * as fs from "fs";
import * as path from "path";
import type { Job } from "bull";
import { parseFile } from "music-metadata";
import { z } from "zod";
import { config } from "../../config";
import { computeAudioStreamHash } from "../../services/audioHash";
import { extractTrackIdentityTags } from "../../services/trackIdentityTags";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { schedulerQueue } from "../queues";

const log = logger.child("AudioHashBackfillProcessor");
const BATCH_SIZE = 50;
const QUERY_SIZE = BATCH_SIZE + 1;
const CONTINUATION_OPTIONS = {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 5_000 },
    removeOnComplete: true,
    removeOnFail: 10,
};

/** Bull job name for bounded track audio-hash backfill pages. */
export const AUDIO_HASH_BACKFILL_JOB_NAME = "track-audio-hash-backfill";

/** Cursor payload persisted with each audio-hash backfill page. */
export interface AudioHashBackfillJobData {
    mode?: "startup";
    startAfterId?: string;
    sweepStartedAt: string;
}

/** Summary returned by one bounded audio-hash backfill page. */
export interface AudioHashBackfillResult {
    processed: number;
    hashed: number;
    skipped: number;
    continued: boolean;
}

type BackfillTrack = { id: string; filePath: string };

function keepTracksWithPaths(
    tracks: ReadonlyArray<{ id: string; filePath: string | null }>,
): BackfillTrack[] {
    return tracks.flatMap((track) =>
        track.filePath === null
            ? []
            : [{ id: track.id, filePath: track.filePath }],
    );
}

const backfillJobDataSchema = z.strictObject({
    mode: z.literal("startup").optional(),
    startAfterId: z.string().trim().min(1).max(128).optional(),
    sweepStartedAt: z.iso.datetime({ offset: true }),
});

async function loadBackfillPage(
    startAfterId: string | undefined,
): Promise<BackfillTrack[]> {
    const tracks = await prisma.track.findMany({
        where: {
            audioHash: null,
            filePath: { not: null },
            origin: "LOCAL",
            removedAt: null,
            ...(startAfterId ? { id: { gt: startAfterId } } : {}),
        },
        orderBy: { id: "asc" },
        take: QUERY_SIZE,
        select: { id: true, filePath: true },
    });
    return keepTracksWithPaths(tracks);
}

function isMissingFileError(error: unknown): boolean {
    return (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await fs.promises.access(filePath);
        return true;
    } catch (error) {
        if (isMissingFileError(error)) return false;
        throw error;
    }
}

async function readTrackIdentityTags(
    filePath: string,
): Promise<{ recordingMbid: string | null; isrc: string | null }> {
    try {
        const metadata = await parseFile(filePath);
        return extractTrackIdentityTags(metadata);
    } catch (error) {
        log.warn(`Failed to read identity tags for ${filePath}`, { error });
        return { recordingMbid: null, isrc: null };
    }
}

async function hashTrack(track: BackfillTrack): Promise<"hashed" | "skipped"> {
    const absolutePath = path.join(config.music.musicPath, track.filePath);
    if (!(await fileExists(absolutePath))) {
        log.debug(`Skipping missing track file: ${track.filePath}`);
        return "skipped";
    }

    const identityTags = await readTrackIdentityTags(absolutePath);
    const audioHash = await computeAudioStreamHash(absolutePath);
    if (!audioHash) return "skipped";

    const updated = await prisma.track.updateMany({
        where: { id: track.id, audioHash: null, origin: "LOCAL" },
        data: { audioHash, audioHashedAt: new Date(), ...identityTags },
    });
    return updated.count === 1 ? "hashed" : "skipped";
}

async function enqueueContinuation(
    startAfterId: string,
    sweepStartedAt: string,
): Promise<void> {
    await schedulerQueue.add(
        AUDIO_HASH_BACKFILL_JOB_NAME,
        { startAfterId, sweepStartedAt },
        {
            ...CONTINUATION_OPTIONS,
            jobId: `scheduler:audio-hash-backfill:${sweepStartedAt}:${startAfterId}`,
        },
    );
}

/** Processes one bounded page and persists continuation through Bull. */
export async function processAudioHashBackfill(
    job: Job<AudioHashBackfillJobData>,
): Promise<AudioHashBackfillResult> {
    const data = backfillJobDataSchema.parse(job.data);
    const startAfterId = data.startAfterId;
    const candidates = await loadBackfillPage(startAfterId);
    const batch = candidates.slice(0, BATCH_SIZE);
    let hashed = 0;
    let skipped = 0;

    for (let index = 0; index < BATCH_SIZE; index += 1) {
        const track = batch[index];
        if (!track) break;
        const result = await hashTrack(track);
        if (result === "hashed") hashed += 1;
        else skipped += 1;
    }

    const continued = candidates.length > BATCH_SIZE;
    if (continued) {
        await enqueueContinuation(
            batch[BATCH_SIZE - 1].id,
            data.sweepStartedAt,
        );
    }
    log.info(
        `Processed ${batch.length} track audio hashes (${hashed} hashed, ${skipped} skipped)`,
    );
    return { processed: batch.length, hashed, skipped, continued };
}
