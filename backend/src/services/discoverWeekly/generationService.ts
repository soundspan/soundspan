/**
 * Discovery Weekly Service (Refactored)
 *
 * Generates weekly discovery playlists using Last.fm recommendations,
 * downloads via Lidarr, and only shows songs after successful import.
 *
 * Key improvements:
 * - Prisma transactions for atomic operations
 * - Pre-fetched and cached recommendations
 * - Structured logging with batch logs field
 * - No dynamic imports
 */

import { startOfWeek } from "date-fns";
import { config as appConfig } from "../../config";
import { logger } from "../../utils/logger";
import { getSystemSettings } from "../../utils/systemSettings";
import { acquisitionService } from "../acquisitionService";
import {
    discoveryAlbumLifecycle,
    discoveryBatchLogger,
    discoverySeeding,
} from "../discovery";
import { discoveryLogger } from "../discoveryLogger";
import { lastFmService } from "../lastfm";
import { BatchLifecycleService } from "./batchLifecycle";
import { discoverWeeklyPrisma } from "./state";
import type { SeedArtist } from "./types";

/** Represents the DiscoverWeeklyService class. */
export class DiscoverWeeklyService extends BatchLifecycleService {
    private async resolveCanAcquire(userId: string): Promise<boolean> {
        const user = await discoverWeeklyPrisma.user.findUnique({
            where: { id: userId },
            select: { role: true },
        });
        return user?.role === "admin";
    }

    /**
     * Main entry: Generate Discovery Weekly
     */
    async generatePlaylist(userId: string, jobId?: number) {
        // Start a dedicated log file for this generation
        const logPath = discoveryLogger.start(userId, jobId);
        discoveryLogger.info(`Log file: ${logPath}`);

        try {
            if (!(await this.resolveCanAcquire(userId))) {
                throw new Error(
                    "Discover Weekly downloads are admin-only on this server",
                );
            }

            discoveryLogger.section("CONFIGURATION CHECK");
            const settings = await getSystemSettings();

            const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });

            // Get user config
            const config =
                await discoverWeeklyPrisma.userDiscoverConfig.findUnique({
                    where: { userId },
                });

            if (!config || !config.enabled) {
                discoveryLogger.error("Discovery Weekly not enabled for user");
                discoveryLogger.end(false, "Not enabled");
                throw new Error("Discovery Weekly not enabled");
            }

            // Get download ratio from config (default 1.3)
            const downloadRatio = config.downloadRatio ?? 1.3;

            discoveryLogger.table({
                "Target Songs": config.playlistSize,
                "Download Ratio": `${downloadRatio}x`,
                "Week Start": weekStart.toISOString().split("T")[0],
            });

            // CRITICAL: Process previous week's liked albums before generating new ones
            discoveryLogger.section("PROCESSING PREVIOUS WEEK");
            await discoveryAlbumLifecycle.processBeforeGeneration(
                userId,
                settings,
            );

            const targetCount = config.playlistSize;

            // Step 1: Get seed artists
            discoveryLogger.section("STEP 1: SEED ARTISTS");
            const seeds = await discoverySeeding.getSeedArtists(userId);
            if (seeds.length === 0) {
                discoveryLogger.error(
                    "No seed artists found - need listening history",
                );
                discoveryLogger.end(false, "No seed artists");
                throw new Error(
                    "No seed artists found - need listening history",
                );
            }
            discoveryLogger.success(`Found ${seeds.length} seed artists:`);
            discoveryLogger.list(
                seeds.map(
                    (s) => `${s.name}${s.mbid ? ` (${s.mbid})` : " (no MBID)"}`,
                ),
            );

            // Step 2: Pre-fetch and cache similar artists (parallel with rate limiting)
            discoveryLogger.section("STEP 2: SIMILAR ARTISTS");
            const similarArtistsMap = await this.prefetchSimilarArtists(seeds);
            discoveryLogger.success(
                `Cached ${similarArtistsMap.size} similar artist sets`,
            );
            for (const [key, similar] of similarArtistsMap.entries()) {
                const seedName =
                    seeds.find((s) => s.mbid === key || s.name === key)?.name ||
                    key;
                discoveryLogger.write(
                    `  ${seedName}: ${similar.length} similar artists`,
                    1,
                );
            }

            // Step 3: Find recommended albums using multi-strategy discovery
            // REQUEST MORE ALBUMS than target to account for download failures
            // User configurable ratio (default 1.3x) to control bandwidth usage
            const albumsToRequest = Math.ceil(targetCount * downloadRatio);

            discoveryLogger.section(
                "STEP 3: ALBUM RECOMMENDATIONS (Multi-Strategy)",
            );
            discoveryLogger.info(
                `Requesting ${albumsToRequest} albums (${downloadRatio}x target of ${targetCount}) to account for failures`,
            );

            const recommended = await this.findRecommendedAlbumsMultiStrategy(
                seeds,
                similarArtistsMap,
                albumsToRequest, // Request more albums!
                userId,
            );

            if (recommended.length === 0) {
                discoveryLogger.error(
                    "No recommendations found after filtering",
                );
                discoveryLogger.end(false, "No recommendations found");
                throw new Error("No recommendations found");
            }

            // MINIMUM THRESHOLD CHECK: Ensure we have enough candidates
            // We need at least targetCount albums, ideally more for variety
            const minRecommendations = targetCount;
            if (recommended.length < minRecommendations) {
                discoveryLogger.warn(
                    `Only ${recommended.length} recommendations found, need at least ${minRecommendations} for ${targetCount} unique albums`,
                );
                discoveryLogger.warn(
                    "Consider expanding seed artists or playing more music",
                );
                await discoveryBatchLogger.warn(
                    "threshold-check",
                    `Low recommendations: ${recommended.length}/${minRecommendations} minimum (target: ${targetCount} unique albums)`,
                );
            }

            discoveryLogger.success(
                `${recommended.length} albums recommended for download`,
            );
            discoveryLogger.list(
                recommended.map(
                    (r) =>
                        `${r.artistName} - ${r.albumTitle} (similarity: ${(
                            r.similarity * 100
                        ).toFixed(0)}%)`,
                ),
            );

            // Step 4: Create batch and jobs in a transaction
            discoveryLogger.section("STEP 4: CREATE BATCH & JOBS");

            // Get music path from settings (already fetched at line 276) with fallback to app config
            const musicPath = settings?.musicPath || appConfig.music.musicPath;

            const batch = await discoverWeeklyPrisma.$transaction(
                async (tx) => {
                    // Create discovery batch
                    const newBatch = await tx.discoveryBatch.create({
                        data: {
                            userId,
                            weekStart,
                            targetSongCount: targetCount,
                            status: "downloading",
                            totalAlbums: recommended.length,
                            completedAlbums: 0,
                            failedAlbums: 0,
                            logs: [
                                {
                                    timestamp: new Date().toISOString(),
                                    level: "info",
                                    message: `Started with ${recommended.length} albums to download`,
                                },
                            ] as any,
                        },
                    });
                    discoveryLogger.success(`Created batch: ${newBatch.id}`);

                    // Create all download jobs in the same transaction
                    for (const album of recommended) {
                        // Ensure similarity is a valid number
                        const similarity =
                            typeof album.similarity === "number" &&
                            !isNaN(album.similarity)
                                ? album.similarity
                                : 0.5;

                        // Check for existing pending/processing job to avoid duplicates
                        const existingJob = await tx.downloadJob.findFirst({
                            where: {
                                targetMbid: album.albumMbid,
                                status: {
                                    in: ACTIVE_DOWNLOAD_JOB_STATUSES,
                                },
                            },
                        });

                        if (existingJob) {
                            logger.debug(
                                `   Skipping job: ${album.artistName} - ${album.albumTitle} (already in queue: ${existingJob.id})`,
                            );
                            continue;
                        }

                        logger.debug(
                            `   Creating job: ${album.artistName} - ${album.albumTitle} (similarity: ${similarity}, tier: ${album.tier})`,
                        );

                        await tx.downloadJob.create({
                            data: {
                                userId,
                                subject: `${album.artistName} - ${album.albumTitle}`,
                                type: "album",
                                targetMbid: album.albumMbid,
                                status: "pending",
                                discoveryBatchId: newBatch.id,
                                metadata: {
                                    downloadType: "discovery",
                                    rootFolderPath: musicPath,
                                    artistName: album.artistName,
                                    artistMbid: album.artistMbid,
                                    albumTitle: album.albumTitle,
                                    albumMbid: album.albumMbid,
                                    similarity: similarity,
                                    tier: album.tier,
                                },
                            },
                        });
                    }

                    return newBatch;
                },
            );
            discoveryLogger.success(
                `Created ${recommended.length} download jobs`,
            );

            // Step 5: Start downloads outside transaction (they involve external APIs)
            discoveryLogger.section("STEP 5: START DOWNLOADS");
            let downloadsStarted = 0;
            let downloadsFailed = 0;

            const jobs = await discoverWeeklyPrisma.downloadJob.findMany({
                where: { discoveryBatchId: batch.id },
            });

            // Create concurrent acquisition promises
            const acquisitionPromises = jobs.map(async (job) => {
                const metadata = job.metadata as any;

                discoveryLogger.info(
                    `Acquiring: ${metadata.artistName} - ${metadata.albumTitle}`,
                    1,
                );

                const result = await acquisitionService.acquireAlbum(
                    {
                        albumTitle: metadata.albumTitle,
                        artistName: metadata.artistName,
                        mbid: metadata.albumMbid,
                        lastfmUrl: undefined,
                    },
                    {
                        userId: userId,
                        discoveryBatchId: batch.id,
                        existingJobId: job.id,
                    },
                );

                if (result.success) {
                    discoveryLogger.success(
                        `Acquired via ${result.source}: ${metadata.artistName} - ${metadata.albumTitle}`,
                        1,
                    );

                    const newStatus =
                        result.source === "soulseek"
                            ? "completed"
                            : "processing";
                    await discoverWeeklyPrisma.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            status: newStatus,
                            lidarrRef: result.correlationId || null,
                            completedAt:
                                newStatus === "completed" ? new Date() : null,
                        },
                    });
                } else {
                    discoveryLogger.error(
                        `Failed to acquire: ${metadata.albumTitle} - ${result.error}`,
                        1,
                    );

                    await discoverWeeklyPrisma.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            status: "failed",
                            error: result.error,
                            completedAt: new Date(),
                        },
                    });

                    await discoveryBatchLogger.error(
                        batch.id,
                        `Failed to acquire ${metadata.albumTitle}: ${result.error}`,
                    );
                }

                return { job, result };
            });

            // Execute all acquisitions concurrently
            const results = await Promise.allSettled(acquisitionPromises);

            // Process results and update counters
            results.forEach((settledResult, index) => {
                if (settledResult.status === "fulfilled") {
                    const { result } = settledResult.value;
                    if (result.success) {
                        downloadsStarted++;
                    } else {
                        downloadsFailed++;
                    }
                } else {
                    downloadsFailed++;
                    const job = jobs[index];
                    const metadata = job.metadata as any;
                    logger.error(
                        `[Discover] Failed to acquire ${metadata.albumTitle}: ${settledResult.reason}`,
                    );
                }
            });

            // Log batch completion summary
            logger.info(
                `[Discover] Batch complete: ${downloadsStarted} succeeded, ${downloadsFailed} failed`,
            );

            // After all download attempts, check if batch should be completed
            // This handles cases where downloads fail before webhooks are triggered
            if (downloadsStarted === 0 || downloadsFailed > 0) {
                logger.debug(
                    `[Discovery] Checking batch completion (started: ${downloadsStarted}, failed: ${downloadsFailed})`,
                );
                await this.checkBatchCompletion(batch.id);
            }

            discoveryLogger.section("GENERATION COMPLETE");
            discoveryLogger.table({
                "Downloads Started": downloadsStarted,
                "Downloads Failed": downloadsFailed,
                "Total Albums": recommended.length,
                "Batch ID": batch.id,
            });

            await discoveryBatchLogger.info(
                batch.id,
                `${downloadsStarted} downloads started, waiting for webhooks`,
            );

            discoveryLogger.end(
                true,
                `${downloadsStarted}/${recommended.length} downloads queued`,
            );

            return {
                success: true,
                playlistName: `Discover Weekly (Week of ${weekStart.toLocaleDateString()})`,
                songCount: 0,
                batchId: batch.id,
            };
        } catch (error: any) {
            discoveryLogger.error(`Generation failed: ${error.message}`);
            discoveryLogger.end(false, error.message);
            throw error;
        }
    }

    /**
     * Pre-fetch similar artists for all seeds (parallel with rate limiting)
     * Now includes exponential backoff retry for API failures
     */
    private async prefetchSimilarArtists(
        seeds: SeedArtist[],
    ): Promise<Map<string, any[]>> {
        const cache = new Map<string, any[]>();

        // Helper: fetch with exponential backoff retry
        const fetchWithRetry = async (
            seed: SeedArtist,
            maxRetries = 3,
        ): Promise<any[]> => {
            const totalAttempts = Math.max(1, maxRetries);

            for (let attempt = 1; ; attempt++) {
                try {
                    const similar = await lastFmService.getSimilarArtists(
                        seed.mbid || "",
                        seed.name,
                        20,
                    );
                    return similar;
                } catch (error: any) {
                    const isRetryable =
                        error.response?.status === 429 ||
                        error.response?.status >= 500 ||
                        error.code === "ECONNRESET" ||
                        error.code === "ETIMEDOUT";

                    if (isRetryable && attempt < totalAttempts) {
                        const delay = Math.pow(2, attempt) * 500; // 1s, 2s, 4s
                        logger.warn(
                            `   Retry ${attempt}/${totalAttempts} for ${seed.name} in ${delay}ms (${error.message})`,
                        );
                        await new Promise((r) => setTimeout(r, delay));
                        continue;
                    }

                    logger.warn(
                        `   Failed to get similar artists for ${seed.name}: ${error.message}`,
                    );
                    return [];
                }
            }
        };

        // Process seeds in smaller batches to avoid overwhelming APIs
        const batchSize = 3;
        for (let i = 0; i < seeds.length; i += batchSize) {
            const seedBatch = seeds.slice(i, i + batchSize);

            const results = await Promise.all(
                seedBatch.map(async (seed) => {
                    const similar = await fetchWithRetry(seed);
                    return { key: seed.mbid || seed.name, similar };
                }),
            );

            for (const { key, similar } of results) {
                cache.set(key, similar);
            }

            // Small delay between batches
            if (i + batchSize < seeds.length) {
                await new Promise((r) => setTimeout(r, 300));
            }
        }

        return cache;
    }
}
import { ACTIVE_DOWNLOAD_JOB_STATUSES } from "../downloadJobStatus";
