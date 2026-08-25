import { Job } from "bull";
import { logger } from "../../utils/logger";
import { discoverWeeklyService } from "../../services/discoverWeekly";
import { discoveryRecommendationsService } from "../../services/discovery";
import { config } from "../../config";
import {
    acquireSchedulerClaim,
    releaseSchedulerClaim,
} from "../../utils/schedulerClaim";

const log = logger.child("DiscoverProcessor");

export interface DiscoverJobData {
    userId: string;
}

export interface DiscoverJobResult {
    success: boolean;
    playlistName: string;
    songCount: number;
    batchId?: string;
    skipped?: boolean;
    error?: string;
}

const DEFAULT_DISCOVER_LOCK_TTL_MS = 45 * 60 * 1000;
const parsedDiscoverLockTtlMs = Number.parseInt(
    process.env.DISCOVER_PROCESSOR_LOCK_TTL_MS ||
        `${DEFAULT_DISCOVER_LOCK_TTL_MS}`,
    10,
);
const DISCOVER_PROCESSOR_LOCK_TTL_MS =
    Number.isFinite(parsedDiscoverLockTtlMs) && parsedDiscoverLockTtlMs > 0
        ? parsedDiscoverLockTtlMs
        : DEFAULT_DISCOVER_LOCK_TTL_MS;
const DISCOVER_PROCESSOR_LOCK_KEY_PREFIX = "discover:processor:lock";

function getDiscoverLockKey(userId: string): string {
    return `${DISCOVER_PROCESSOR_LOCK_KEY_PREFIX}:${userId}`;
}

/**
 * Executes shutdownDiscoverProcessor.
 */
export async function shutdownDiscoverProcessor(): Promise<void> {
    return Promise.resolve();
}

/**
 * Executes processDiscoverWeekly.
 */
export async function processDiscoverWeekly(
    job: Job<DiscoverJobData>,
): Promise<DiscoverJobResult> {
    const jobLog = log.child(`Job ${job.id}`);
    const { userId } = job.data;
    const lockKey = getDiscoverLockKey(userId);
    let lockToken: string | null = null;

    jobLog.debug(`Generating Discover Weekly for user ${userId}`);

    await job.progress(10);

    try {
        lockToken = await acquireSchedulerClaim(
            lockKey,
            DISCOVER_PROCESSOR_LOCK_TTL_MS,
            `user ${userId} discover generation`,
        );

        if (!lockToken) {
            jobLog.warn(
                `Skipping generation for user ${userId}; processor claim is held by another worker`,
            );
            await job.progress(100);
            return {
                success: true,
                skipped: true,
                playlistName: "",
                songCount: 0,
            };
        }

        // Note: The discoverWeeklyService.generatePlaylist doesn't have progress callback yet
        // For now, we'll just report progress at key stages
        await job.progress(20); // Starting generation

        jobLog.debug(
            `Starting discovery generation (mode=${config.discover.mode})...`,
        );
        const result =
            config.discover.mode === "legacy"
                ? await discoverWeeklyService.generatePlaylist(userId)
                : await discoveryRecommendationsService.generatePlaylist(
                      userId,
                  );

        jobLog.debug(`Result:`, {
            success: result.success,
            playlistName: result.playlistName,
            songCount: result.songCount,
            batchId: result.batchId,
        });

        await job.progress(100); // Complete

        jobLog.debug(`Generation complete: SUCCESS`);

        return {
            success: result.success,
            playlistName: result.playlistName,
            songCount: result.songCount,
            batchId: result.batchId,
        };
    } catch (error: any) {
        jobLog.error(`Generation failed with exception:`, error);
        jobLog.error(`Stack trace:`, error.stack);

        // Re-throw so Bull marks the job failed and applies its retry/backoff and
        // dead-letter handling. Returning a {success:false} payload here resolves
        // the promise, so Bull would record a genuine failure (Last.fm down, no
        // seeds, DB error) as COMPLETED — silently — and never retry it.
        throw error;
    } finally {
        if (lockToken) {
            await releaseSchedulerClaim(
                lockKey,
                lockToken,
                `user ${userId} discover generation`,
            );
        }
    }
}
