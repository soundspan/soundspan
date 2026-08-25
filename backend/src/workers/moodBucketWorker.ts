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
import { prisma } from "../utils/db";
import { moodBucketService } from "../services/moodBucketService";
import { runWithSchedulerClaim } from "../utils/schedulerClaim";
import { config } from "../config";
import { TRACK_BROWSE_SQL } from "../utils/libraryRadioPredicates";

const log = logger.child("MoodBucket");

// Configuration
const BATCH_SIZE = 50;
const WORKER_INTERVAL_MS = 30 * 1000; // Run every 30 seconds

let isRunning = false;
let workerInterval: NodeJS.Timeout | null = null;
const MOOD_BUCKET_CLAIM_KEY = "mood-bucket:cycle:claim";
const MOOD_BUCKET_CLAIM_TTL_MS = config.workers.moodBucketClaimTtlMs;

async function processNewlyAnalyzedTracksClaimed(
    operationName: string,
): Promise<number> {
    const claim = await runWithSchedulerClaim(
        MOOD_BUCKET_CLAIM_KEY,
        MOOD_BUCKET_CLAIM_TTL_MS,
        operationName,
        () => processNewlyAnalyzedTracks(),
    );
    return claim.acquired ? claim.value : 0;
}

/**
 * Start the mood bucket worker
 */
export async function startMoodBucketWorker() {
    log.debug("\n=== Starting Mood Bucket Worker ===");
    log.debug(`   Batch size: ${BATCH_SIZE}`);
    log.debug(`   Interval: ${WORKER_INTERVAL_MS / 1000}s`);
    log.debug("");

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
        log.debug("Worker stopped");
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
            WHERE t."removedAt" IS NULL
              AND ${TRACK_BROWSE_SQL}
              AND t."analysisStatus" = 'completed'
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

        log.debug(
            `Processing ${tracksNeedingBuckets.length} tracks needing mood bucket reconciliation...`,
        );

        let assigned = 0;
        for (const track of tracksNeedingBuckets) {
            try {
                const moods = await moodBucketService.assignTrackToMoods(
                    track.id,
                );
                if (moods.length > 0) {
                    assigned++;
                    log.debug(` ${track.title}: [${moods.join(", ")}]`);
                }
            } catch (error: any) {
                log.error(`   ✗ ${track.title}: ${error?.message || error}`);
            }
        }

        log.debug(
            `Assigned ${assigned}/${tracksNeedingBuckets.length} tracks to mood buckets`,
        );

        return assigned;
    } catch (error) {
        log.error("Worker error:", error);
        return 0;
    } finally {
        isRunning = false;
    }
}
