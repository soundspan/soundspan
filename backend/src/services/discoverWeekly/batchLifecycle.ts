import { logger } from "../../utils/logger";
import { scanQueue } from "../../workers/queues";
import { discoveryBatchLogger } from "../discovery";
import { getTierFromSimilarity } from "./helpers";
import { PlaylistPersistenceService } from "./playlistPersistence";
import { discoverWeeklyPrisma } from "./state";

/** Owns timeout handling and completion transitions for discovery batches. */
export class BatchLifecycleService extends PlaylistPersistenceService {
    /**
     * Check for batches stuck in "downloading" or "scanning" status for too long
     * Called periodically from queue cleaner
     */
    async checkStuckBatches(): Promise<number> {
        const BATCH_TIMEOUT_WITH_COMPLETIONS = 30 * 60 * 1000; // 30 minutes
        const BATCH_TIMEOUT_NO_COMPLETIONS = 60 * 60 * 1000; // 60 minutes
        const ABSOLUTE_MAX_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours - force fail any batch older than this

        const stuckBatches = await discoverWeeklyPrisma.discoveryBatch.findMany(
            {
                where: {
                    status: { in: ["downloading", "scanning"] },
                },
                include: { jobs: true },
            },
        );

        let forcedCount = 0;

        for (const batch of stuckBatches) {
            const batchAge = Date.now() - batch.createdAt.getTime();
            const completedJobs = batch.jobs.filter(
                (j) => j.status === "completed",
            );
            const pendingJobs = batch.jobs.filter(
                (j) => j.status === "pending" || j.status === "processing",
            );

            // Absolute timeout - fail any batch older than 2 hours regardless of state
            if (batchAge > ABSOLUTE_MAX_TIMEOUT) {
                logger.debug(
                    `\n⏰ [BATCH FORCE FAIL] Batch ${batch.id} is ${Math.round(
                        batchAge / 3600000,
                    )}h old - force failing`,
                );

                await discoverWeeklyPrisma.discoveryBatch.update({
                    where: { id: batch.id },
                    data: {
                        status: "failed",
                        errorMessage: "Batch timed out after 2 hours",
                        completedAt: new Date(),
                    },
                });

                // Mark any remaining pending/processing jobs as failed
                await discoverWeeklyPrisma.downloadJob.updateMany({
                    where: {
                        discoveryBatchId: batch.id,
                        status: { in: ACTIVE_DOWNLOAD_JOB_STATUSES },
                    },
                    data: {
                        status: "failed",
                        error: "Batch force-failed due to timeout",
                        completedAt: new Date(),
                    },
                });

                forcedCount++;
                continue;
            }

            // Check if batch should be force-completed
            const hasCompletions = completedJobs.length > 0;
            const timeout = hasCompletions
                ? BATCH_TIMEOUT_WITH_COMPLETIONS
                : BATCH_TIMEOUT_NO_COMPLETIONS;

            if (batchAge > timeout && pendingJobs.length > 0) {
                logger.debug(
                    `\n⏰ [BATCH TIMEOUT] Batch ${
                        batch.id
                    } stuck for ${Math.round(batchAge / 60000)}min`,
                );
                logger.debug(
                    `   Completed: ${completedJobs.length}, Pending: ${pendingJobs.length}`,
                );

                // Mark all pending jobs as failed (timed out)
                await discoverWeeklyPrisma.downloadJob.updateMany({
                    where: {
                        discoveryBatchId: batch.id,
                        status: { in: ACTIVE_DOWNLOAD_JOB_STATUSES },
                    },
                    data: {
                        status: "failed",
                        error: "Batch timeout - download took too long",
                        completedAt: new Date(),
                    },
                });

                logger.debug(
                    `   Marked ${pendingJobs.length} pending jobs as failed`,
                );

                // Now trigger batch completion check
                await this.checkBatchCompletion(batch.id);
                forcedCount++;
            }
        }

        return forcedCount;
    }

    /**
     * Check if discovery batch is complete and trigger final steps
     */
    async checkBatchCompletion(batchId: string) {
        logger.debug(`\n[BATCH ${batchId}] Checking completion...`);

        const batch = await discoverWeeklyPrisma.discoveryBatch.findUnique({
            where: { id: batchId },
            include: { jobs: true },
        });

        if (!batch) {
            logger.debug(`[BATCH ${batchId}] Not found - skipping`);
            return;
        }

        // Skip if already completed/failed/scanning
        if (
            batch.status === "completed" ||
            batch.status === "failed" ||
            batch.status === "scanning"
        ) {
            logger.debug(
                `[BATCH ${batchId}] Already ${batch.status} - skipping`,
            );
            return;
        }

        const completedJobs = batch.jobs.filter(
            (j) => j.status === "completed",
        );
        const failedJobs = batch.jobs.filter(
            (j) => j.status === "failed" || j.status === "exhausted",
        );
        const pendingJobs = batch.jobs.filter(
            (j) => j.status === "pending" || j.status === "processing",
        );

        const completed = completedJobs.length;
        const failed = failedJobs.length;
        const total = batch.jobs.length;

        logger.debug(
            `[BATCH ${batchId}] Status: ${completed} completed, ${failed} failed, ${pendingJobs.length} pending (total: ${total})`,
        );

        // Wait for ALL downloads to complete/fail
        if (pendingJobs.length > 0) {
            logger.debug(
                `[BATCH ${batchId}] Still waiting for ${pendingJobs.length} downloads`,
            );
            return;
        }

        // Wait for Lidarr to finish importing files
        logger.debug(
            `[BATCH ${batchId}] All jobs done! Waiting 60s for Lidarr to finish importing...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 60000));
        logger.debug(`[BATCH ${batchId}] Transitioning to scan phase...`);

        // All jobs finished - use transaction to update batch and create unavailable records
        await discoverWeeklyPrisma.$transaction(async (tx) => {
            // Create UnavailableAlbum records for failed downloads
            for (const job of failedJobs) {
                const metadata = job.metadata as any;
                try {
                    await tx.unavailableAlbum.upsert({
                        where: {
                            userId_weekStartDate_albumMbid: {
                                userId: batch.userId,
                                weekStartDate: batch.weekStart,
                                albumMbid: job.targetMbid,
                            },
                        },
                        create: {
                            userId: batch.userId,
                            albumMbid: job.targetMbid,
                            artistName: metadata?.artistName || "Unknown",
                            albumTitle: metadata?.albumTitle || "Unknown",
                            similarity: metadata?.similarity || 0.5,
                            tier:
                                metadata?.tier ||
                                getTierFromSimilarity(
                                    metadata?.similarity || 0.5,
                                ),
                            attemptNumber: 1,
                            weekStartDate: batch.weekStart,
                        },
                        update: {
                            attemptNumber: { increment: 1 },
                        },
                    });
                } catch (e) {
                    // Ignore duplicate errors
                }
            }

            // Update batch status
            if (completed === 0) {
                await tx.discoveryBatch.update({
                    where: { id: batchId },
                    data: {
                        status: "failed",
                        completedAlbums: 0,
                        failedAlbums: failed,
                        errorMessage: "All downloads failed",
                        completedAt: new Date(),
                    },
                });
            } else {
                await tx.discoveryBatch.update({
                    where: { id: batchId },
                    data: {
                        status: "scanning",
                        completedAlbums: completed,
                        failedAlbums: failed,
                    },
                });
            }
        });

        if (completed === 0) {
            logger.debug(`   All downloads failed`);
            await discoveryBatchLogger.error(batchId, "All downloads failed");

            // Cleanup failed artists from Lidarr
            await this.cleanupFailedArtists(batchId);
            return;
        }

        // All successful downloads will be included in the playlist
        logger.debug(
            `   ${completed} albums ready for playlist. Triggering scan...`,
        );
        await discoveryBatchLogger.info(
            batchId,
            `${completed} completed, ${failed} failed. All successful downloads will be in playlist.`,
        );

        // Trigger ONE scan with batch ID
        await scanQueue.add("scan", {
            type: "full",
            source: "discover-weekly-completion",
            discoveryBatchId: batchId,
        });

        logger.debug(
            `   Scan queued - will build playlist after scan completes`,
        );
    }
}
import { ACTIVE_DOWNLOAD_JOB_STATUSES } from "../downloadJobStatus";
