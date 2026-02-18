/**
 * Mood Bucket Worker
 *
 * This worker runs in the background and assigns newly analyzed tracks
 * to mood buckets. It watches for tracks that have:
 * - analysisStatus = 'completed'
 * - No existing MoodBucket entries
 *
 * This is separate from the Python audio analyzer to keep mood bucket
 * logic in TypeScript and avoid modifying the Python code.
 */

import { logger } from "../utils/logger";
import { randomUUID } from "crypto";
import type Redis from "ioredis";
import { prisma } from "../utils/db";
import { moodBucketService } from "../services/moodBucketService";
import { createIORedisClient } from "../utils/ioredis";

// Configuration
const BATCH_SIZE = 50;
const WORKER_INTERVAL_MS = 30 * 1000; // Run every 30 seconds

let isRunning = false;
let workerInterval: NodeJS.Timeout | null = null;
let moodBucketClaimRedis: Redis | null = null;
const MOOD_BUCKET_CLAIM_KEY = "mood-bucket:cycle:claim";
const MOOD_BUCKET_CLAIM_OWNER_ID = randomUUID();
const DEFAULT_MOOD_BUCKET_CLAIM_TTL_MS = 2 * 60 * 1000;
const parsedMoodBucketClaimTtlMs = Number.parseInt(
    process.env.MOOD_BUCKET_CLAIM_TTL_MS ||
        `${DEFAULT_MOOD_BUCKET_CLAIM_TTL_MS}`,
    10
);
const MOOD_BUCKET_CLAIM_TTL_MS =
    Number.isFinite(parsedMoodBucketClaimTtlMs) &&
    parsedMoodBucketClaimTtlMs > 0
        ? parsedMoodBucketClaimTtlMs
        : DEFAULT_MOOD_BUCKET_CLAIM_TTL_MS;

function getMoodBucketClaimRedis() {
    if (!moodBucketClaimRedis) {
        moodBucketClaimRedis = createIORedisClient("mood-bucket-cycle-claims");
    }
    return moodBucketClaimRedis;
}

function isRetryableMoodBucketClaimError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return (
        message.includes("Connection is closed") ||
        message.includes("Connection is in closing state") ||
        message.includes("ECONNRESET") ||
        message.includes("ETIMEDOUT") ||
        message.includes("EPIPE")
    );
}

function recreateMoodBucketClaimRedisClient(): void {
    if (moodBucketClaimRedis) {
        try {
            moodBucketClaimRedis.disconnect();
        } catch {
            // no-op
        }
    }
    moodBucketClaimRedis = createIORedisClient("mood-bucket-cycle-claims");
}

async function withMoodBucketClaimRedisRetry<T>(
    operationName: string,
    operation: () => Promise<T>
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (!isRetryableMoodBucketClaimError(error)) {
            throw error;
        }

        logger.warn(
            `[Mood Bucket] ${operationName} failed due to Redis connection closure; recreating client and retrying once`,
            error
        );
        recreateMoodBucketClaimRedisClient();
        return await operation();
    }
}

async function processNewlyAnalyzedTracksClaimed(
    operationName: string
): Promise<number> {
    const claimToken = `${MOOD_BUCKET_CLAIM_OWNER_ID}:${Date.now()}:${Math.random()}`;
    const ttlSeconds = Math.max(1, Math.ceil(MOOD_BUCKET_CLAIM_TTL_MS / 1000));

    try {
        const acquired = await withMoodBucketClaimRedisRetry(
            `claim acquire for ${operationName}`,
            () =>
                getMoodBucketClaimRedis().set(
                    MOOD_BUCKET_CLAIM_KEY,
                    claimToken,
                    "EX",
                    ttlSeconds,
                    "NX"
                )
        );

        if (acquired !== "OK") {
            logger.debug(
                `[Mood Bucket] Skipping ${operationName}; cycle claim is held by another worker`
            );
            return 0;
        }
    } catch (error) {
        logger.error(
            `[Mood Bucket] Failed to claim ${operationName}; skipping cycle`,
            error
        );
        return 0;
    }

    try {
        return await processNewlyAnalyzedTracks();
    } finally {
        try {
            await withMoodBucketClaimRedisRetry(
                `claim release for ${operationName}`,
                () =>
                    getMoodBucketClaimRedis().eval(
                        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
                        1,
                        MOOD_BUCKET_CLAIM_KEY,
                        claimToken
                    )
            );
        } catch (error) {
            logger.warn(
                `[Mood Bucket] Failed to release cycle claim for ${operationName}`,
                error
            );
        }
    }
}

/**
 * Start the mood bucket worker
 */
export async function startMoodBucketWorker() {
    logger.debug("\n=== Starting Mood Bucket Worker ===");
    logger.debug(`   Batch size: ${BATCH_SIZE}`);
    logger.debug(`   Interval: ${WORKER_INTERVAL_MS / 1000}s`);
    logger.debug("");

    // Run immediately
    await processNewlyAnalyzedTracksClaimed("startup mood-bucket cycle");

    // Then run at interval
    workerInterval = setInterval(async () => {
        await processNewlyAnalyzedTracksClaimed("interval mood-bucket cycle");
    }, WORKER_INTERVAL_MS);
}

/**
 * Stop the mood bucket worker
 */
export function stopMoodBucketWorker() {
    if (workerInterval) {
        clearInterval(workerInterval);
        workerInterval = null;
        logger.debug("[Mood Bucket] Worker stopped");
    }
    if (moodBucketClaimRedis) {
        moodBucketClaimRedis.disconnect();
        moodBucketClaimRedis = null;
    }
}

/**
 * Process newly analyzed tracks that don't have mood bucket assignments
 */
async function processNewlyAnalyzedTracks(): Promise<number> {
    if (isRunning) return 0;

    try {
        isRunning = true;

        // Reconcile two classes of tracks:
        // 1) completed tracks with no mood buckets
        // 2) completed tracks re-analyzed after their last mood bucket update
        const tracksNeedingBuckets = await prisma.$queryRaw<
            { id: string; title: string }[]
        >`
            SELECT t.id, t.title
            FROM "Track" t
            LEFT JOIN "MoodBucket" mb ON mb."trackId" = t.id
            WHERE t."analysisStatus" = 'completed'
            GROUP BY t.id, t.title, t."analyzedAt"
            HAVING COUNT(mb.*) = 0
                OR (
                    t."analyzedAt" IS NOT NULL
                    AND MAX(mb."updatedAt") < t."analyzedAt"
                )
            ORDER BY t."analyzedAt" DESC NULLS LAST
            LIMIT ${BATCH_SIZE}
        `;

        if (tracksNeedingBuckets.length === 0) {
            return 0;
        }

        logger.debug(
            `[Mood Bucket] Processing ${tracksNeedingBuckets.length} tracks needing mood bucket reconciliation...`
        );

        let assigned = 0;
        for (const track of tracksNeedingBuckets) {
            try {
                const moods = await moodBucketService.assignTrackToMoods(
                    track.id
                );
                if (moods.length > 0) {
                    assigned++;
                    logger.debug(` ${track.title}: [${moods.join(", ")}]`);
                }
            } catch (error: any) {
                logger.error(
                    `   ✗ ${track.title}: ${error?.message || error}`
                );
            }
        }

        logger.debug(
            `[Mood Bucket] Assigned ${assigned}/${tracksNeedingBuckets.length} tracks to mood buckets`
        );

        return assigned;
    } catch (error) {
        logger.error("[Mood Bucket] Worker error:", error);
        return 0;
    } finally {
        isRunning = false;
    }
}
