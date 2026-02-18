import { Job } from "bull";
import { randomUUID } from "crypto";
import type Redis from "ioredis";
import { logger } from "../../utils/logger";
import { discoverWeeklyService } from "../../services/discoverWeekly";
import { discoveryRecommendationsService } from "../../services/discovery";
import { config } from "../../config";
import { createIORedisClient } from "../../utils/ioredis";

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

let discoverProcessorLockRedis: Redis = createIORedisClient(
    "discover-processor-locks"
);
const discoverProcessorNodeId = randomUUID();
const DEFAULT_DISCOVER_LOCK_TTL_MS = 45 * 60 * 1000;
const parsedDiscoverLockTtlMs = Number.parseInt(
    process.env.DISCOVER_PROCESSOR_LOCK_TTL_MS ||
        `${DEFAULT_DISCOVER_LOCK_TTL_MS}`,
    10
);
const DISCOVER_PROCESSOR_LOCK_TTL_MS =
    Number.isFinite(parsedDiscoverLockTtlMs) && parsedDiscoverLockTtlMs > 0
        ? parsedDiscoverLockTtlMs
        : DEFAULT_DISCOVER_LOCK_TTL_MS;
const DISCOVER_PROCESSOR_LOCK_KEY_PREFIX = "discover:processor:lock";

function isRetryableDiscoverLockError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return (
        message.includes("Connection is closed") ||
        message.includes("Connection is in closing state") ||
        message.includes("ECONNRESET") ||
        message.includes("ETIMEDOUT") ||
        message.includes("EPIPE")
    );
}

function recreateDiscoverLockRedisClient(): void {
    try {
        discoverProcessorLockRedis.disconnect();
    } catch {
        // no-op
    }
    discoverProcessorLockRedis = createIORedisClient("discover-processor-locks");
}

async function withDiscoverLockRedisRetry<T>(
    operationName: string,
    operation: () => Promise<T>
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (!isRetryableDiscoverLockError(error)) {
            throw error;
        }

        logger.warn(
            `[DiscoverProcessor] ${operationName} failed due to Redis connection closure; recreating client and retrying once`,
            error
        );
        recreateDiscoverLockRedisClient();
        return await operation();
    }
}

function getDiscoverLockKey(userId: string): string {
    return `${DISCOVER_PROCESSOR_LOCK_KEY_PREFIX}:${userId}`;
}

export async function shutdownDiscoverProcessor(): Promise<void> {
    try {
        await withDiscoverLockRedisRetry("shutdown quit", () =>
            discoverProcessorLockRedis.quit()
        );
    } catch (error) {
        logger.warn(
            "[DiscoverProcessor] Failed to gracefully close lock Redis client; disconnecting forcefully",
            error
        );
        discoverProcessorLockRedis.disconnect();
    }
}

export async function processDiscoverWeekly(
    job: Job<DiscoverJobData>
): Promise<DiscoverJobResult> {
    const { userId } = job.data;
    const lockKey = getDiscoverLockKey(userId);
    const lockToken = `${discoverProcessorNodeId}:${Date.now()}:${job.id}`;
    const lockTtlSeconds = Math.max(
        1,
        Math.ceil(DISCOVER_PROCESSOR_LOCK_TTL_MS / 1000)
    );

    logger.debug(
        `[DiscoverJob ${job.id}] Generating Discover Weekly for user ${userId}`
    );

    await job.progress(10);

    try {
        const claimResult = await withDiscoverLockRedisRetry(
            `claim acquire for user ${userId}`,
            () =>
                discoverProcessorLockRedis.set(
                    lockKey,
                    lockToken,
                    "EX",
                    lockTtlSeconds,
                    "NX"
                )
        );

        if (claimResult !== "OK") {
            logger.warn(
                `[DiscoverJob ${job.id}] Skipping generation for user ${userId}; processor claim is held by another worker`
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

        logger.debug(
            `[DiscoverJob ${job.id}] Starting discovery generation (mode=${config.discover.mode})...`
        );
        const result =
            config.discover.mode === "legacy"
                ? await discoverWeeklyService.generatePlaylist(userId)
                : await discoveryRecommendationsService.generatePlaylist(userId);

        logger.debug(`[DiscoverJob ${job.id}] Result:`, {
            success: result.success,
            playlistName: result.playlistName,
            songCount: result.songCount,
            batchId: result.batchId,
        });

        await job.progress(100); // Complete

        logger.debug(
            `[DiscoverJob ${job.id}] Generation complete: SUCCESS`
        );

        return {
            success: result.success,
            playlistName: result.playlistName,
            songCount: result.songCount,
            batchId: result.batchId,
        };
    } catch (error: any) {
        logger.error(
            `[DiscoverJob ${job.id}] Generation failed with exception:`,
            error
        );
        logger.error(`[DiscoverJob ${job.id}] Stack trace:`, error.stack);

        return {
            success: false,
            playlistName: "",
            songCount: 0,
            error: error.message || "Unknown error",
        };
    } finally {
        try {
            await withDiscoverLockRedisRetry(
                `claim release for user ${userId}`,
                () =>
                    discoverProcessorLockRedis.eval(
                        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
                        1,
                        lockKey,
                        lockToken
                    )
            );
        } catch (releaseError) {
            logger.warn(
                `[DiscoverJob ${job.id}] Failed to release processor claim for user ${userId}`,
                releaseError
            );
        }
    }
}
