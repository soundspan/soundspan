/**
 * Unified Enrichment Worker
 *
 * Handles ALL enrichment in one place:
 * - Artist metadata (Last.fm, MusicBrainz)
 * - Track mood tags (Last.fm)
 * - Audio analysis (triggers Essentia via Redis queue)
 *
 * Two modes:
 * 1. FULL: Re-enriches everything regardless of status (Settings > Enrich)
 * 2. INCREMENTAL: Only new material and incomplete items (Sync)
 */

import { logger } from "../utils/logger";
import { prisma, Prisma } from "../utils/db";
import { enrichSimilarArtist } from "./artistEnrichment";
import { lastFmService } from "../services/lastfm";
import { randomUUID } from "crypto";
import Redis from "ioredis";
import { createIORedisClient } from "../utils/ioredis";
import { config } from "../config";
import { enrichmentStateService } from "../services/enrichmentState";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import { audioAnalysisCleanupService } from "../services/audioAnalysisCleanup";
import { rateLimiter } from "../services/rateLimiter";
import { vibeAnalysisCleanupService } from "../services/vibeAnalysisCleanup";
import { getSystemSettings } from "../utils/systemSettings";
import { featureDetection } from "../services/featureDetection";
import { moodBucketService } from "../services/moodBucketService";
import pLimit from "p-limit";

// Configuration
const ARTIST_BATCH_SIZE = 10;
const TRACK_BATCH_SIZE = 20;
const ENRICHMENT_INTERVAL_MS = 5 * 1000; // 5 seconds - rate limiter handles API limits
const MAX_CONSECUTIVE_SYSTEM_FAILURES = 5; // Circuit breaker threshold
const ENRICHMENT_STOP_WAIT_INTERVAL_MS = 100;
const ENRICHMENT_STOP_MAX_WAIT_MS = 30_000;
const ENRICHMENT_PRISMA_RETRY_ATTEMPTS = 3;

let isRunning = false;
let enrichmentInterval: NodeJS.Timeout | null = null;
let redis: Redis | null = null;
let enrichmentClaimRedis: Redis | null = null;
let controlSubscriber: Redis | null = null;
let isPaused = false;
let isStopping = false;
let immediateEnrichmentRequested = false;
let consecutiveSystemFailures = 0; // Track consecutive system-level failures
let lastRunTime = 0;
const MIN_INTERVAL_MS = 10000; // Minimum 10s between cycles
const ENRICHMENT_CLAIM_KEY = "enrichment:cycle:claim";
const ENRICHMENT_CLAIM_OWNER_ID = randomUUID();
const DEFAULT_ENRICHMENT_CLAIM_TTL_MS = 15 * 60 * 1000;
const parsedEnrichmentClaimTtlMs = Number.parseInt(
    process.env.ENRICHMENT_CLAIM_TTL_MS ||
        `${DEFAULT_ENRICHMENT_CLAIM_TTL_MS}`,
    10,
);
const ENRICHMENT_CLAIM_TTL_MS =
    Number.isFinite(parsedEnrichmentClaimTtlMs) &&
    parsedEnrichmentClaimTtlMs > 0
        ? parsedEnrichmentClaimTtlMs
        : DEFAULT_ENRICHMENT_CLAIM_TTL_MS;

// Batch failure tracking
interface BatchFailures {
    artists: { name: string; error: string }[];
    tracks: { name: string; error: string }[];
    audio: { name: string; error: string }[];
}
let currentBatchFailures: BatchFailures = {
    artists: [],
    tracks: [],
    audio: [],
};

// Session-level failure counter (accumulates across cycles, reset on enrichment start)
let sessionFailureCount = { artists: 0, tracks: 0, audio: 0 };

// Mood tags to extract from Last.fm
const MOOD_TAGS = new Set([
    // Energy/Activity
    "chill",
    "relax",
    "relaxing",
    "calm",
    "peaceful",
    "ambient",
    "energetic",
    "upbeat",
    "hype",
    "party",
    "dance",
    "workout",
    "gym",
    "running",
    "exercise",
    "motivation",
    // Emotions
    "sad",
    "melancholy",
    "melancholic",
    "depressing",
    "heartbreak",
    "happy",
    "feel good",
    "feel-good",
    "joyful",
    "uplifting",
    "angry",
    "aggressive",
    "intense",
    "romantic",
    "love",
    "sensual",
    // Time/Setting
    "night",
    "late night",
    "evening",
    "morning",
    "summer",
    "winter",
    "rainy",
    "sunny",
    "driving",
    "road trip",
    "travel",
    // Activity
    "study",
    "focus",
    "concentration",
    "work",
    "sleep",
    "sleeping",
    "bedtime",
    // Vibe
    "dreamy",
    "atmospheric",
    "ethereal",
    "spacey",
    "groovy",
    "funky",
    "smooth",
    "dark",
    "moody",
    "brooding",
    "epic",
    "cinematic",
    "dramatic",
    "nostalgic",
    "throwback",
]);

/**
 * Timeout wrapper to prevent operations from hanging indefinitely
 * If an operation takes longer than the timeout, it will fail and move to the next item
 */
async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string,
): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Filter tags to only include mood-relevant ones
 */
function filterMoodTags(tags: string[]): string[] {
    return tags
        .map((t) => t.toLowerCase().trim())
        .filter((t) => {
            if (MOOD_TAGS.has(t)) return true;
            for (const mood of MOOD_TAGS) {
                if (t.includes(mood)) return true;
            }
            return false;
        })
        .slice(0, 10);
}

/**
 * Initialize Redis connection for audio analysis queue
 */
function getRedis(): Redis {
    if (!redis) {
        redis = createIORedisClient("enrichment-queue");
    }
    return redis;
}

function getEnrichmentClaimRedis(): Redis {
    if (!enrichmentClaimRedis) {
        enrichmentClaimRedis = createIORedisClient("enrichment-cycle-claims");
    }
    return enrichmentClaimRedis;
}

function isRetryableEnrichmentRedisError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return (
        message.includes("Connection is closed") ||
        message.includes("Connection is in closing state") ||
        message.includes("ECONNRESET") ||
        message.includes("ETIMEDOUT") ||
        message.includes("EPIPE")
    );
}

function recreateEnrichmentQueueRedisClient(): void {
    try {
        redis?.disconnect();
    } catch {
        // no-op
    }
    redis = createIORedisClient("enrichment-queue");
}

function recreateEnrichmentClaimRedisClient(): void {
    try {
        enrichmentClaimRedis?.disconnect();
    } catch {
        // no-op
    }
    enrichmentClaimRedis = createIORedisClient("enrichment-cycle-claims");
}

async function withEnrichmentQueueRedisRetry<T>(
    operationName: string,
    operation: () => Promise<T>,
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (!isRetryableEnrichmentRedisError(error)) {
            throw error;
        }

        logger.warn(
            `[Enrichment/Redis] ${operationName} failed due to Redis connection closure; recreating queue client and retrying once`,
            error,
        );
        recreateEnrichmentQueueRedisClient();
        return await operation();
    }
}

async function withEnrichmentClaimRedisRetry<T>(
    operationName: string,
    operation: () => Promise<T>,
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (!isRetryableEnrichmentRedisError(error)) {
            throw error;
        }

        logger.warn(
            `[Enrichment/Redis] ${operationName} failed due to Redis connection closure; recreating claim client and retrying once`,
            error,
        );
        recreateEnrichmentClaimRedisClient();
        return await operation();
    }
}

function isRetryableEnrichmentPrismaError(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        return ["P1001", "P1002", "P1017", "P2024", "P2037"].includes(error.code);
    }

    if (error instanceof Prisma.PrismaClientRustPanicError) {
        return true;
    }

    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
        const message = error.message || "";
        return (
            message.includes("Response from the Engine was empty") ||
            message.includes("Engine has already exited")
        );
    }

    const message = error instanceof Error ? error.message : String(error ?? "");
    return (
        message.includes("Response from the Engine was empty") ||
        message.includes("Engine has already exited") ||
        message.includes("Can't reach database server") ||
        message.includes("Connection reset")
    );
}

function isTooManyConnectionsPrismaError(error: unknown): boolean {
    return (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2037"
    );
}

async function withEnrichmentPrismaRetry<T>(
    operationName: string,
    operation: () => Promise<T>,
): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            if (
                !isRetryableEnrichmentPrismaError(error) ||
                attempt === ENRICHMENT_PRISMA_RETRY_ATTEMPTS
            ) {
                throw error;
            }

            logger.warn(
                `[Enrichment/Prisma] ${operationName} failed (attempt ${attempt}/${ENRICHMENT_PRISMA_RETRY_ATTEMPTS}), retrying`,
                error,
            );

            const delayMs =
                isTooManyConnectionsPrismaError(error) ?
                    1000 * attempt
                :   250 * attempt;
            if (isTooManyConnectionsPrismaError(error)) {
                await prisma.$disconnect().catch(() => {});
            }
            await prisma.$connect().catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
}

async function runEnrichmentCycleClaimed(
    fullMode: boolean,
    operationName: string,
): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
}> {
    const emptyResult = { artists: 0, tracks: 0, audioQueued: 0 };
    const claimToken = `${ENRICHMENT_CLAIM_OWNER_ID}:${Date.now()}:${Math.random()}`;
    const ttlSeconds = Math.max(1, Math.ceil(ENRICHMENT_CLAIM_TTL_MS / 1000));

    try {
        const acquired = await withEnrichmentClaimRedisRetry(
            `claim acquire for ${operationName}`,
            () =>
                getEnrichmentClaimRedis().set(
                    ENRICHMENT_CLAIM_KEY,
                    claimToken,
                    "EX",
                    ttlSeconds,
                    "NX",
                ),
        );

        if (acquired !== "OK") {
            logger.debug(
                `[Enrichment] Skipping ${operationName}; cycle claim is held by another worker`,
            );
            return emptyResult;
        }
    } catch (error) {
        logger.error(
            `[Enrichment] Failed to claim ${operationName}; skipping cycle`,
            error,
        );
        return emptyResult;
    }

    try {
        return await runEnrichmentCycle(fullMode);
    } finally {
        try {
            await withEnrichmentClaimRedisRetry(
                `claim release for ${operationName}`,
                () =>
                    getEnrichmentClaimRedis().eval(
                        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
                        1,
                        ENRICHMENT_CLAIM_KEY,
                        claimToken,
                    ),
            );
        } catch (error) {
            logger.warn(
                `[Enrichment] Failed to release cycle claim for ${operationName}`,
                error,
            );
        }
    }
}

/**
 * Setup subscription to enrichment control channel
 */
async function setupControlChannel() {
    if (!controlSubscriber) {
        controlSubscriber = createIORedisClient("enrichment-control-sub");
        await controlSubscriber.subscribe("enrichment:control");

        controlSubscriber.on("message", (channel, message) => {
            if (channel === "enrichment:control") {
                logger.debug(
                    `[Enrichment] Received control message: ${message}`,
                );

                if (message === "pause") {
                    isPaused = true;
                    logger.debug("[Enrichment] Paused");
                } else if (message === "resume") {
                    isPaused = false;
                    logger.debug("[Enrichment] Resumed");
                } else if (message === "stop") {
                    isStopping = true;
                    isPaused = true;
                    logger.debug(
                        "[Enrichment] Stopping gracefully - completing current item...",
                    );
                    // DO NOT override state - let enrichmentStateService.stop() handle it
                }
            }
        });

        logger.debug("[Enrichment] Subscribed to control channel");
    }
}

/**
 * Start the unified enrichment worker (incremental mode)
 */
export async function startUnifiedEnrichmentWorker() {
    logger.debug("\n=== Starting Unified Enrichment Worker ===");
    logger.debug(`   Artist batch: ${ARTIST_BATCH_SIZE}`);
    logger.debug(`   Track batch: ${TRACK_BATCH_SIZE}`);
    logger.debug(`   Interval: ${ENRICHMENT_INTERVAL_MS / 1000}s`);
    logger.debug("");

    // Ensure startup begins from a clean local runtime state.
    isPaused = false;
    isStopping = false;

    // Check if there's existing state that might be problematic
    const existingState = await enrichmentStateService.getState();

    // Only clear state if it exists and is in a non-idle state
    // This prevents clearing fresh state from a previous worker instance
    if (existingState && existingState.status !== "idle") {
        await enrichmentStateService.clear();
    }

    // Initialize state
    await enrichmentStateService.initializeState();

    // Setup control channel subscription
    await setupControlChannel();

    // Run immediately
    await runEnrichmentCycleClaimed(false, "startup enrichment cycle");

    // Then run at interval
    enrichmentInterval = setInterval(async () => {
        await runEnrichmentCycleClaimed(false, "interval enrichment cycle");
    }, ENRICHMENT_INTERVAL_MS);
}

/**
 * Stop the enrichment worker
 */
async function waitForActiveCycleToStop(maxWaitMs = ENRICHMENT_STOP_MAX_WAIT_MS): Promise<void> {
    const startedAt = Date.now();
    while (isRunning && Date.now() - startedAt < maxWaitMs) {
        await new Promise((resolve) =>
            setTimeout(resolve, ENRICHMENT_STOP_WAIT_INTERVAL_MS),
        );
    }

    if (isRunning) {
        logger.warn(
            `[Enrichment] Stop wait exceeded ${maxWaitMs}ms while a cycle was still running; proceeding with teardown`,
        );
    }
}

export async function stopUnifiedEnrichmentWorker() {
    isPaused = true;
    isStopping = true;
    immediateEnrichmentRequested = false;

    if (enrichmentInterval) {
        clearInterval(enrichmentInterval);
        enrichmentInterval = null;
        logger.debug("[Enrichment] Worker stopped");
    }

    await waitForActiveCycleToStop();

    try {
        await enrichmentStateService.updateState({
            status: "idle",
            currentPhase: null,
        });
    } catch (err) {
        logger.error("[Enrichment] Failed to update state:", err);
    } finally {
        isStopping = false;
    }

    if (redis) {
        redis.disconnect();
        redis = null;
    }
    if (enrichmentClaimRedis) {
        enrichmentClaimRedis.disconnect();
        enrichmentClaimRedis = null;
    }
    if (controlSubscriber) {
        controlSubscriber.disconnect();
        controlSubscriber = null;
    }
}

/**
 * Run a full enrichment (re-enrich everything regardless of status)
 * Called from Settings > Enrich All
 */
export async function runFullEnrichment(options?: {
    forceVibeRebuild?: boolean;
    forceMoodBucketBackfill?: boolean;
}): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
}> {
    logger.debug("\n=== FULL ENRICHMENT: Re-enriching everything ===\n");

    const forceVibeRebuild = options?.forceVibeRebuild === true;
    const forceMoodBucketBackfill =
        options?.forceMoodBucketBackfill === true;

    // Reset pause state when starting full enrichment
    isPaused = false;

    // Initialize state for new enrichment
    await enrichmentStateService.initializeState();
    await enrichmentStateService.updateState({
        pendingMoodBucketBackfill: forceMoodBucketBackfill,
        moodBucketBackfillInProgress: false,
    });

    // Reset all statuses to pending
    await prisma.artist.updateMany({
        data: { enrichmentStatus: "pending" },
    });

    await prisma.track.updateMany({
        data: {
            lastfmTags: [],
            analysisStatus: "pending",
        },
    });

    if (forceVibeRebuild) {
        await prisma.$executeRaw`DELETE FROM track_embeddings`;

        await prisma.track.updateMany({
            data: {
                vibeAnalysisStatus: "pending",
                vibeAnalysisStartedAt: null,
                vibeAnalysisStatusUpdatedAt: new Date(),
            },
        });

        await enrichmentFailureService.clearAllFailures("vibe");

        logger.info(
            "[Enrichment] forceVibeRebuild enabled: cleared CLAP embeddings and reset vibe analysis state to pending",
        );
    }

    if (forceMoodBucketBackfill) {
        logger.info(
            "[Enrichment] forceMoodBucketBackfill enabled: mood bucket full backfill will run after enrichment reaches fully complete state",
        );
    }

    // Now run the enrichment cycle
    const result = await runEnrichmentCycleClaimed(
        true,
        "full enrichment cycle",
    );

    return result;
}

/**
 * Reset only artist enrichment (keeps mood tags and audio analysis intact)
 * Used when user wants to re-fetch artist metadata without touching track data
 */
export async function resetArtistsOnly(): Promise<{ count: number }> {
    logger.debug("[Enrichment] Resetting ONLY artist enrichment status...");

    const result = await prisma.artist.updateMany({
        where: { enrichmentStatus: "completed" },
        data: {
            enrichmentStatus: "pending",
            lastEnriched: null,
        },
    });

    logger.debug(`[Enrichment] Reset ${result.count} artists to pending`);
    return { count: result.count };
}

/**
 * Reset only mood tags (keeps artist metadata and audio analysis intact)
 * Used when user wants to re-fetch Last.fm mood tags without touching other enrichment
 */
export async function resetMoodTagsOnly(): Promise<{ count: number }> {
    logger.debug("[Enrichment] Resetting ONLY mood tags...");

    const result = await prisma.track.updateMany({
        data: { lastfmTags: [] },
    });

    logger.debug(`[Enrichment] Reset mood tags for ${result.count} tracks`);
    return { count: result.count };
}

/**
 * Main enrichment cycle
 *
 * Flow:
 * 1. Artist metadata (Last.fm/MusicBrainz) - blocking, required for track enrichment
 * 2. Track tags (Last.fm mood tags) - blocking, quick API calls
 * 3. Audio analysis (Essentia) - NON-BLOCKING, queued to Redis for background processing
 *
 * Steps 1 & 2 must complete before enrichment is "done".
 * Step 3 runs entirely in background via the audio-analyzer Docker container.
 *
 * @param fullMode - If true, processes everything. If false, only pending items.
 */
async function runEnrichmentCycle(fullMode: boolean): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
}> {
    const emptyResult = { artists: 0, tracks: 0, audioQueued: 0 };

    // Sync local pause flag with state service
    if (!isPaused) {
        const state = await enrichmentStateService.getState();
        if (state?.status === "paused" || state?.status === "stopping") {
            isPaused = true;
        }
    }

    if (isPaused) {
        return emptyResult;
    }

    // Skip if already running (unless full mode or immediate request)
    const bypassRunningCheck = fullMode || immediateEnrichmentRequested;
    if (isRunning && !bypassRunningCheck) {
        return emptyResult;
    }

    // Enforce minimum interval (unless full mode or immediate request)
    const now = Date.now();
    if (!bypassRunningCheck && now - lastRunTime < MIN_INTERVAL_MS) {
        return emptyResult;
    }

    immediateEnrichmentRequested = false;
    lastRunTime = now;
    isRunning = true;

    let artistsProcessed = 0;
    let tracksProcessed = 0;
    let audioQueued = 0;
    let hadOutstandingWorkAtCycleStart = true;
    let cycleHadError = false;

    try {
        const startingProgress = await getEnrichmentProgress();
        hadOutstandingWorkAtCycleStart = !startingProgress.isFullyComplete;
    } catch (error) {
        logger.warn(
            "[Enrichment] Failed to read starting progress, defaulting to notification-safe mode:",
            error,
        );
    }

    try {
        // Run phases sequentially, halting if stopped/paused
        const artistResult = await runPhase("artists", executeArtistsPhase);
        if (artistResult === null) {
            consecutiveSystemFailures = 0;
            return { artists: 0, tracks: 0, audioQueued: 0 };
        }
        artistsProcessed = artistResult;

        const trackResult = await runPhase("tracks", executeMoodTagsPhase);
        if (trackResult === null) {
            consecutiveSystemFailures = 0;
            return { artists: artistsProcessed, tracks: 0, audioQueued: 0 };
        }
        tracksProcessed = trackResult;

        const audioResult = await runPhase("audio", executeAudioPhase);
        if (audioResult === null) {
            consecutiveSystemFailures = 0;
            return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued: 0 };
        }
        audioQueued = audioResult;

        const vibeResult = await runPhase("vibe", executeVibePhase);
        if (vibeResult === null) {
            consecutiveSystemFailures = 0;
            return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued };
        }
        const vibeQueued = vibeResult;

        // Podcast refresh phase -- only runs if subscriptions exist
        await runPhase("podcasts", executePodcastRefreshPhase);

        const features = await featureDetection.getFeatures();

         // Log progress (only if work was done)
         if (artistsProcessed > 0 || tracksProcessed > 0 || audioQueued > 0 || vibeQueued > 0) {
            try {
                const progress = await getEnrichmentProgress();
                logger.debug(`\n[Enrichment Progress]`);
                logger.debug(
                    `   Artists: ${progress.artists.completed}/${progress.artists.total} (${progress.artists.progress}%)`,
                );
                logger.debug(
                    `   Track Tags: ${progress.trackTags.enriched}/${progress.trackTags.total} (${progress.trackTags.progress}%)`,
                );
                logger.debug(
                    `   Audio Analysis: ${progress.audioAnalysis.completed}/${progress.audioAnalysis.total} (${progress.audioAnalysis.progress}%) [background]`,
                );
                if (features.vibeEmbeddings) {
                    logger.debug(
                        `   Vibe Embeddings: ${progress.clapEmbeddings.completed}/${progress.clapEmbeddings.total} (${progress.clapEmbeddings.progress}%) [background]`,
                    );
                }
                logger.debug("");

                // Update state with progress
                await enrichmentStateService.updateState({
                    artists: {
                        total: progress.artists.total,
                        completed: progress.artists.completed,
                        failed: progress.artists.failed,
                    },
                    tracks: {
                        total: progress.trackTags.total,
                        completed: progress.trackTags.enriched,
                        failed: 0,
                    },
                    audio: {
                        total: progress.audioAnalysis.total,
                        completed: progress.audioAnalysis.completed,
                        failed: progress.audioAnalysis.failed,
                        processing: progress.audioAnalysis.processing,
                    },
                    completionNotificationSent: false, // Reset flag when new work is processed
                });
            } catch (error) {
                logger.warn(
                    "[Enrichment] Failed to read/update enrichment progress after processing batch; continuing cycle:",
                    error,
                );
            }

            // Reset session failure counter when new work begins
            sessionFailureCount = { artists: 0, tracks: 0, audio: 0 };
        }

        // Accumulate cycle failures into session counter before resetting
        sessionFailureCount.artists += currentBatchFailures.artists.length;
        sessionFailureCount.tracks += currentBatchFailures.tracks.length;
        sessionFailureCount.audio += currentBatchFailures.audio.length;

        // Reset batch failures (failures are viewable in Settings > Enrichment)
        currentBatchFailures = { artists: [], tracks: [], audio: [] };

        // If everything is complete, mark as idle and send notification (only once)
        let progress: Awaited<ReturnType<typeof getEnrichmentProgress>>;
        try {
            progress = await getEnrichmentProgress();
        } catch (error) {
            logger.warn(
                "[Enrichment] Failed to read completion progress snapshot; skipping completion-specific post-processing for this cycle:",
                error,
            );
            return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued };
        }

        // Clear mixes cache when core enrichment completes (artist images now available)
        if (progress.coreComplete) {
            const state = await enrichmentStateService.getState();
            if (!state?.coreCacheCleared) {
                try {
                    const redisInstance = getRedis();
                    const mixKeys = await redisInstance.keys("mixes:*");
                    if (mixKeys.length > 0) {
                        await redisInstance.del(...mixKeys);
                        logger.info(
                            `[Enrichment] Cleared ${mixKeys.length} mix cache entries after core enrichment complete`,
                        );
                    }
                    await enrichmentStateService.updateState({
                        coreCacheCleared: true,
                    });
                } catch (error) {
                    logger.error(
                        "[Enrichment] Failed to clear mix cache on core complete:",
                        error,
                    );
                }
            }
        }

        if (progress.isFullyComplete) {
            await enrichmentStateService.updateState({
                status: "idle",
                currentPhase: null,
            });

            const stateBeforeMoodBackfill = await enrichmentStateService.getState();
            if (
                stateBeforeMoodBackfill?.pendingMoodBucketBackfill &&
                !stateBeforeMoodBackfill?.moodBucketBackfillInProgress
            ) {
                try {
                    await enrichmentStateService.updateState({
                        moodBucketBackfillInProgress: true,
                    });

                    logger.info(
                        "[Enrichment] Running automatic mood bucket backfill after full enrichment completion...",
                    );
                    const backfillResult =
                        await moodBucketService.backfillAllTracks();
                    logger.info(
                        `[Enrichment] Mood bucket backfill complete: processed=${backfillResult.processed}, assigned=${backfillResult.assigned}`,
                    );

                    await enrichmentStateService.updateState({
                        pendingMoodBucketBackfill: false,
                        moodBucketBackfillInProgress: false,
                    });
                } catch (error) {
                    logger.error(
                        "[Enrichment] Automatic mood bucket backfill failed (will retry on next fully-complete cycle):",
                        error,
                    );
                    await enrichmentStateService.updateState({
                        moodBucketBackfillInProgress: false,
                    });
                }
            }

            // Clear mixes cache again when fully complete (audio analysis done)
            const stateBeforeNotify = await enrichmentStateService.getState();
            if (!stateBeforeNotify?.fullCacheCleared) {
                try {
                    const redisInstance = getRedis();
                    const mixKeys = await redisInstance.keys("mixes:*");
                    if (mixKeys.length > 0) {
                        await redisInstance.del(...mixKeys);
                        logger.info(
                            `[Enrichment] Cleared ${mixKeys.length} mix cache entries after full enrichment complete`,
                        );
                    }
                    await enrichmentStateService.updateState({
                        fullCacheCleared: true,
                    });
                } catch (error) {
                    logger.error(
                        "[Enrichment] Failed to clear mix cache on full complete:",
                        error,
                    );
                }
            }

            // Send completion notification only if not already sent
            const state = await enrichmentStateService.getState();
            const processedWorkThisCycle =
                artistsProcessed > 0 ||
                tracksProcessed > 0 ||
                audioQueued > 0 ||
                vibeQueued > 0;
            const totalSessionFailures =
                sessionFailureCount.artists +
                sessionFailureCount.tracks +
                sessionFailureCount.audio;
            const shouldSendCompletionNotification =
                hadOutstandingWorkAtCycleStart ||
                processedWorkThisCycle ||
                totalSessionFailures > 0;

            if (!state?.completionNotificationSent) {
                if (!shouldSendCompletionNotification) {
                    await enrichmentStateService.updateState({
                        completionNotificationSent: true,
                    });
                    logger.debug(
                        "[Enrichment] Skipped completion notification (already complete at cycle start, no new work)",
                    );
                    return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued };
                }

                try {
                    const { notificationService } =
                        await import("../services/notificationService");
                    // Get all users to notify (in a multi-user system, notify everyone)
                    const users = await prisma.user.findMany({
                        select: { id: true },
                    });

                    for (const user of users) {
                        if (totalSessionFailures > 0) {
                            const parts: string[] = [];
                            if (sessionFailureCount.artists > 0) parts.push(`${sessionFailureCount.artists} artist(s)`);
                            if (sessionFailureCount.tracks > 0) parts.push(`${sessionFailureCount.tracks} track(s)`);
                            if (sessionFailureCount.audio > 0) parts.push(`${sessionFailureCount.audio} audio analysis`);

                            await notificationService.create({
                                userId: user.id,
                                type: "error",
                                title: "Enrichment Completed with Errors",
                                message: `${totalSessionFailures} failures: ${parts.join(", ")}. Check Settings > Enrichment for details.`,
                            });
                        }

                        await notificationService.notifySystem(
                            user.id,
                            "Enrichment Complete",
                            `Enriched ${progress.artists.completed} artists, ${progress.trackTags.enriched} tracks, ${progress.audioAnalysis.completed} audio analyses`,
                        );
                    }

                    // Mark notification as sent
                    await enrichmentStateService.updateState({
                        completionNotificationSent: true,
                    });
                    logger.debug("[Enrichment] Completion notification sent");
                } catch (error) {
                    logger.error(
                        "[Enrichment] Failed to send completion notification:",
                        error,
                    );
                }
            } else {
                logger.debug(
                    "[Enrichment] Completion notification already sent, skipping",
                );
            }
        }
    } catch (error) {
        cycleHadError = true;
        logger.error("[Enrichment] Cycle error:", error);

        // Increment system failure counter
        consecutiveSystemFailures++;

        // Circuit breaker: Stop recording system failures after threshold
        // This prevents infinite error loops when state management fails
        if (consecutiveSystemFailures <= MAX_CONSECUTIVE_SYSTEM_FAILURES) {
            // Record system-level failure
            await enrichmentFailureService
                .recordFailure({
                    entityType: "artist", // Generic type for system errors
                    entityId: "system",
                    entityName: "Enrichment System",
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                    errorCode: "SYSTEM_ERROR",
                })
                .catch((err) =>
                    logger.error("[Enrichment] Failed to record failure:", err),
                );
        } else {
            logger.error(
                `[Enrichment] Circuit breaker triggered - ${consecutiveSystemFailures} consecutive system failures. ` +
                    `Suppressing further error recording to prevent infinite loop.`,
            );
        }
    } finally {
        isRunning = false;
    }

    if (!cycleHadError) {
        consecutiveSystemFailures = 0;
    }
    return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued };
}

/**
 * Step 1: Enrich artist metadata
 */
async function enrichArtistsBatch(): Promise<number> {
    // Get concurrency setting from system settings
    const settings = await getSystemSettings();
    const concurrency = settings?.enrichmentConcurrency || 1;

    const artists = await prisma.artist.findMany({
        where: {
            OR: [
                { enrichmentStatus: "pending" },
                { enrichmentStatus: "failed" },
            ],
            albums: { some: {} },
        },
        orderBy: { name: "asc" },
        take: ARTIST_BATCH_SIZE,
    });

    if (artists.length === 0) return 0;

    logger.debug(
        `[Artists] Processing ${artists.length} artists (concurrency: ${concurrency})...`,
    );

    // Use p-limit to control concurrency
    const limit = pLimit(concurrency);

    const results = await Promise.allSettled(
        artists.map((artist) =>
            limit(async () => {
                // Check if paused before processing
                if (isPaused) {
                    throw new Error("Paused");
                }

                // Update state with current artist
                await enrichmentStateService.updateState({
                    artists: {
                        current: artist.name,
                    } as any,
                });

                try {
                    // Add timeout to prevent hanging on rate-limited requests
                    // 60s to accommodate multiple sequential API calls (MusicBrainz, Wikidata, Last.fm, Fanart.tv, Deezer, covers)
                    await withTimeout(
                        enrichSimilarArtist(artist),
                        60000, // 60 second max per artist
                        `Timeout enriching artist: ${artist.name}`,
                    );
                    logger.debug(`✓ ${artist.name}`);
                    return artist.name;
                } catch (error) {
                    logger.error(`✗ ${artist.name}:`, error);

                    // Collect failure for batch reporting
                    currentBatchFailures.artists.push({
                        name: artist.name,
                        error:
                            error instanceof Error ?
                                error.message
                            :   String(error),
                    });

                    // Record failure
                    await enrichmentFailureService.recordFailure({
                        entityType: "artist",
                        entityId: artist.id,
                        entityName: artist.name,
                        errorMessage:
                            error instanceof Error ?
                                error.message
                            :   String(error),
                        errorCode:
                            (
                                error instanceof Error &&
                                error.message.includes("Timeout")
                            ) ?
                                "TIMEOUT_ERROR"
                            :   "ENRICHMENT_ERROR",
                        metadata: {
                            mbid: artist.mbid,
                        },
                    });
                    throw error;
                }
            }),
        ),
    );

    // Count successful enrichments
    const processed = results.filter((r) => r.status === "fulfilled").length;

    if (processed > 0) {
        logger.debug(
            `[Artists] Successfully enriched ${processed}/${artists.length} artists`,
        );
    }

    return processed;
}

/**
 * Step 2: Enrich track mood tags from Last.fm
 * Note: No longer waits for artist enrichment - runs in parallel
 */
async function enrichTrackTagsBatch(): Promise<number> {
    // Get concurrency setting from system settings
    const settings = await getSystemSettings();
    const concurrency = settings?.enrichmentConcurrency || 1;

    // Note: Nested orderBy on relations doesn't work with isEmpty filtering in Prisma
    // Track tag enrichment doesn't depend on artist enrichment status, so we just order by recency
    // Match both empty array AND null (newly scanned tracks have null, not [])
    const tracks = await prisma.track.findMany({
        where: {
            OR: [
                { lastfmTags: { equals: [] } },
                { lastfmTags: { isEmpty: true } },
                { lastfmTags: { equals: null } },
            ],
        },
        include: {
            album: {
                include: {
                    artist: { select: { name: true } },
                },
            },
        },
        take: TRACK_BATCH_SIZE,
        orderBy: [{ fileModified: "desc" }],
    });

    if (tracks.length === 0) return 0;

    logger.debug(
        `[Track Tags] Processing ${tracks.length} tracks (concurrency: ${concurrency})...`,
    );

    // Use p-limit to control concurrency
    const limit = pLimit(concurrency);

    const results = await Promise.allSettled(
        tracks.map((track) =>
            limit(async () => {
                // Check if paused before processing
                if (isPaused) {
                    throw new Error("Paused");
                }

                // Update state with current track
                await enrichmentStateService.updateState({
                    tracks: {
                        current: `${track.album.artist.name} - ${track.title}`,
                    } as any,
                });

                try {
                    const artistName = track.album.artist.name;

                    // Add timeout to prevent hanging on rate-limited requests
                    const trackInfo = await withTimeout(
                        lastFmService.getTrackInfo(artistName, track.title),
                        30000, // 30 second max per track
                        `Timeout enriching track: ${track.title}`,
                    );

                    if (trackInfo?.toptags?.tag) {
                        const allTags = trackInfo.toptags.tag.map(
                            (t: any) => t.name,
                        );
                        const moodTags = filterMoodTags(allTags);

                        await prisma.track.update({
                            where: { id: track.id },
                            data: {
                                lastfmTags:
                                    moodTags.length > 0 ?
                                        moodTags
                                    :   ["_no_mood_tags"],
                            },
                        });

                        if (moodTags.length > 0) {
                            logger.debug(
                                `   ✓ ${track.title}: [${moodTags
                                    .slice(0, 3)
                                    .join(", ")}...]`,
                            );
                        }
                    } else {
                        await prisma.track.update({
                            where: { id: track.id },
                            data: { lastfmTags: ["_not_found"] },
                        });
                    }

                    // Small delay between requests
                    await new Promise((resolve) => setTimeout(resolve, 200));
                    return track.title;
                } catch (error: any) {
                    logger.error(
                        `✗ ${track.title}: ${error?.message || error}`,
                    );

                    // Collect failure for batch reporting
                    currentBatchFailures.tracks.push({
                        name: `${track.album.artist.name} - ${track.title}`,
                        error: error?.message || String(error),
                    });

                    // Record failure
                    await enrichmentFailureService.recordFailure({
                        entityType: "track",
                        entityId: track.id,
                        entityName: `${track.album.artist.name} - ${track.title}`,
                        errorMessage: error?.message || String(error),
                        errorCode:
                            error?.message?.includes("Timeout") ?
                                "TIMEOUT_ERROR"
                            :   "LASTFM_ERROR",
                        metadata: {
                            albumId: track.albumId,
                            filePath: track.filePath,
                        },
                    });
                    throw error;
                }
            }),
        ),
    );

    // Count successful enrichments
    const processed = results.filter((r) => r.status === "fulfilled").length;

    if (processed > 0) {
        logger.debug(
            `[Track Tags] Successfully enriched ${processed}/${tracks.length} tracks`,
        );
    }

    return processed;
}

/**
 * Step 3: Queue pending tracks for audio analysis (Essentia)
 */
async function queueAudioAnalysis(): Promise<number> {
    // Find tracks that need audio analysis
    // All tracks should have filePath, so no null check needed
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "pending",
        },
        select: {
            id: true,
            filePath: true,
            title: true,
            duration: true,
        },
        take: 10, // Match analyzer batch size to avoid stale "processing" buildup
        orderBy: { fileModified: "desc" },
    });

    if (tracks.length === 0) return 0;

    logger.debug(
        `[Audio Analysis] Queueing ${tracks.length} tracks for Essentia...`,
    );

    const redis = getRedis();
    let queued = 0;

    for (const track of tracks) {
        try {
            // Queue for the Python audio analyzer
            await withEnrichmentQueueRedisRetry(
                `queueAudioAnalysis.rpush(${track.id})`,
                () =>
                    redis.rpush(
                        "audio:analysis:queue",
                        JSON.stringify({
                            trackId: track.id,
                            filePath: track.filePath,
                            duration: track.duration, // Avoids file read in analyzer
                        }),
                    ),
            );

            // Mark as queued (processing) with timestamp for timeout detection
            await prisma.track.update({
                where: { id: track.id },
                data: {
                    analysisStatus: "processing",
                    analysisStartedAt: new Date(),
                },
            });

            queued++;
        } catch (error) {
            logger.error(`   Failed to queue ${track.title}:`, error);
        }
    }

    if (queued > 0) {
        logger.debug(` Queued ${queued} tracks for audio analysis`);
    }

    return queued;
}

/**
 * Step 4: Queue tracks for CLAP vibe embeddings
 * Only runs if CLAP analyzer is available
 */
async function queueVibeEmbeddings(): Promise<number> {
      const tracks = await withEnrichmentPrismaRetry(
          "queueVibeEmbeddings.track.select",
          () => prisma.$queryRaw<{ id: string; filePath: string; vibeAnalysisStatus: string | null }[]>`
          SELECT t.id, t."filePath", t."vibeAnalysisStatus"
          FROM "Track" t
          LEFT JOIN track_embeddings te ON t.id = te.track_id
          WHERE te.track_id IS NULL
            AND t."filePath" IS NOT NULL
            AND (t."vibeAnalysisStatus" IS NULL OR t."vibeAnalysisStatus" = 'pending')
          LIMIT 1000
      `);
 
     if (tracks.length === 0) {
         return 0;
     }

 const redis = getRedis();
      let queued = 0;

      for (const track of tracks) {
          try {
              await prisma.track.update({
                  where: { id: track.id },
                  data: {
                      vibeAnalysisStatus: 'processing',
                      vibeAnalysisStartedAt: new Date(),
                      vibeAnalysisStatusUpdatedAt: new Date(),
                  },
              });
              
              await withEnrichmentQueueRedisRetry(
                  `queueVibeEmbeddings.rpush(${track.id})`,
                  () =>
                      redis.rpush(
                          "audio:clap:queue",
                          JSON.stringify({
                              trackId: track.id,
                              filePath: track.filePath,
                          })
                      )
              );
              
              queued++;
          } catch (error) {
              logger.error(`   Failed to queue vibe embedding for ${track.id}:`, error);
          }
      }

      return queued;
 }

/**
 * Check if enrichment should stop and handle state cleanup if stopping.
 * Returns true if cycle should halt (either stopping or paused).
 */
async function shouldHaltCycle(): Promise<boolean> {
    if (isStopping) {
        await enrichmentStateService.updateState({
            status: "idle",
            currentPhase: null,
        });
        isStopping = false;
        return true;
    }
    return isPaused;
}

/**
 * Run a phase and return result. Returns null if cycle should halt.
 */
async function runPhase(
    phaseName: "artists" | "tracks" | "audio" | "vibe" | "podcasts",
    executor: () => Promise<number>,
): Promise<number | null> {
    await enrichmentStateService.updateState({
        status: "running",
        currentPhase: phaseName,
    });

    const result = await executor();

    if (await shouldHaltCycle()) {
        return null;
    }

    return result;
}

async function executeArtistsPhase(): Promise<number> {
    return enrichArtistsBatch();
}

async function executeMoodTagsPhase(): Promise<number> {
    return enrichTrackTagsBatch();
}

async function executeAudioPhase(): Promise<number> {
    const audioCompletedBefore = await withEnrichmentPrismaRetry(
        "executeAudioPhase.audioCompletedBefore.count",
        () =>
            prisma.track.count({
                where: { analysisStatus: "completed" },
            }),
    );

    const cleanupResult =
        await audioAnalysisCleanupService.cleanupStaleProcessing();
    if (cleanupResult.reset > 0 || cleanupResult.permanentlyFailed > 0) {
        logger.debug(
            `[Enrichment] Audio analysis cleanup: ${cleanupResult.reset} reset, ${cleanupResult.permanentlyFailed} permanently failed, ${cleanupResult.recovered} recovered`,
        );
    }

    const audioCompletedAfter = await withEnrichmentPrismaRetry(
        "executeAudioPhase.audioCompletedAfter.count",
        () =>
            prisma.track.count({
                where: { analysisStatus: "completed" },
            }),
    );
    if (audioCompletedAfter > audioCompletedBefore) {
        audioAnalysisCleanupService.recordSuccess();
    }

    if (audioAnalysisCleanupService.isCircuitOpen()) {
        logger.warn(
            "[Enrichment] Audio analysis circuit breaker OPEN - skipping queue",
        );
        return 0;
    }

    return queueAudioAnalysis();
}

async function executePodcastRefreshPhase(): Promise<number> {
    const podcastCount = await withEnrichmentPrismaRetry(
        "executePodcastRefreshPhase.podcast.count",
        () => prisma.podcast.count(),
    );
    if (podcastCount === 0) return 0;

    // Only refresh once per hour (check oldest lastRefreshed)
    const ONE_HOUR = 60 * 60 * 1000;
    const staleThreshold = new Date(Date.now() - ONE_HOUR);
    const stalePodcasts = await withEnrichmentPrismaRetry(
        "executePodcastRefreshPhase.podcast.findMany",
        () =>
            prisma.podcast.findMany({
                where: {
                    lastRefreshed: { lt: staleThreshold },
                },
                select: { id: true, title: true },
            }),
    );

    if (stalePodcasts.length === 0) return 0;

    logger.debug(`[Enrichment] Refreshing ${stalePodcasts.length} podcast feeds...`);

    const { refreshPodcastFeed } = await import("../routes/podcasts");
    let refreshed = 0;

    for (const podcast of stalePodcasts) {
        if (isPaused || isStopping) break;

        try {
            const result = await withTimeout(
                refreshPodcastFeed(podcast.id),
                30000,
                `Timeout refreshing podcast: ${podcast.title}`,
            );
            if (result.newEpisodesCount > 0) {
                logger.debug(`   [Podcast] ${podcast.title}: ${result.newEpisodesCount} new episodes`);
            }
            refreshed++;
        } catch (error) {
            logger.error(`   [Podcast] Failed to refresh ${podcast.title}:`, error);
        }
    }

    if (refreshed > 0) {
        logger.debug(`[Enrichment] Refreshed ${refreshed} podcast feeds`);
    }

    return refreshed;
}

async function executeVibePhase(): Promise<number> {
    const features = await featureDetection.getFeatures();
    if (!features.vibeEmbeddings) {
        return 0;
    }

    const audioProcessing = await withEnrichmentPrismaRetry(
        "executeVibePhase.audioProcessing.count",
        () =>
            prisma.track.count({
                where: { analysisStatus: "processing" },
            }),
    );
    let audioQueue = 0;
    try {
        audioQueue = await withEnrichmentQueueRedisRetry(
            "executeVibePhase.audioQueue.llen",
            () => getRedis().llen("audio:analysis:queue"),
        );
    } catch (error) {
        logger.warn(
            "[Enrichment] Unable to read audio analysis queue length; skipping vibe phase this cycle",
            error,
        );
        return 0;
    }
    if (audioProcessing > 0 || audioQueue > 0) {
        logger.debug(
            `[Enrichment] Skipping vibe phase - audio still running (${audioProcessing} processing, ${audioQueue} queued)`,
        );
        return 0;
    }

    const { reset } = await vibeAnalysisCleanupService.cleanupStaleProcessing();
    if (reset > 0) {
        logger.debug(`[ENRICHMENT] Cleaned up ${reset} stale vibe processing entries`);
    }

    const result = await queueVibeEmbeddings();
    if (result > 0) {
        logger.debug(`[ENRICHMENT] Queued ${result} tracks for vibe embedding`);
    }

    return result;
}

 /**
  * Get comprehensive enrichment progress
 *
 * Returns separate progress for:
 * - Artists & Track Tags: "Core" enrichment (must complete before app is fully usable)
 * - Audio Analysis: "Background" enrichment (runs in separate container, non-blocking)
 */
export async function getEnrichmentProgress() {
    const [
        artistCounts,
        trackTotal,
        trackTagsEnriched,
        audioCompleted,
        audioPending,
        audioProcessing,
        audioFailed,
        clapEmbeddingCount,
        clapProcessing,
        clapFailedCount,
    ] = await withEnrichmentPrismaRetry("getEnrichmentProgress.dbReads", () =>
        prisma.$transaction([
            prisma.artist.groupBy({
                by: ["enrichmentStatus"],
                _count: true,
            }),
            prisma.track.count(),
            prisma.track.count({
                where: {
                    AND: [
                        { NOT: { lastfmTags: { equals: [] } } },
                        { NOT: { lastfmTags: { equals: null } } },
                    ],
                },
            }),
            prisma.track.count({
                where: { analysisStatus: "completed" },
            }),
            prisma.track.count({
                where: { analysisStatus: "pending" },
            }),
            prisma.track.count({
                where: { analysisStatus: "processing" },
            }),
            prisma.track.count({
                where: { analysisStatus: "failed" },
            }),
            prisma.$queryRaw<{ count: bigint }[]>`
                SELECT COUNT(*) as count FROM track_embeddings
            `,
            prisma.track.count({
                where: { vibeAnalysisStatus: "processing" },
            }),
            prisma.enrichmentFailure.count({
                where: { entityType: "vibe", resolved: false, skipped: false },
            }),
        ]),
    );

    const artistTotal = artistCounts.reduce((sum, s) => sum + s._count, 0);
    const artistCompleted =
        artistCounts.find((s) => s.enrichmentStatus === "completed")?._count ||
        0;
    const artistPending =
        artistCounts.find((s) => s.enrichmentStatus === "pending")?._count || 0;

    let clapQueueLength = 0;
    try {
        clapQueueLength = await withEnrichmentQueueRedisRetry(
            "getEnrichmentProgress.clapQueueLength.llen",
            () => getRedis().llen("audio:clap:queue"),
        );
    } catch (error) {
        logger.warn(
            "[Enrichment] Failed to read CLAP queue length while computing progress; assuming 0 for this sample",
            error,
        );
    }
    const clapCompleted = Number(clapEmbeddingCount[0]?.count || 0);
    const clapFailed = clapFailedCount;

    // Core enrichment is complete when artists and track tags are done
    // Audio analysis is separate - it runs in background and doesn't block
    const coreComplete =
        artistPending === 0 && trackTotal - trackTagsEnriched === 0;

    return {
        // Core enrichment (blocking)
        artists: {
            total: artistTotal,
            completed: artistCompleted,
            pending: artistPending,
            failed:
                artistCounts.find((s) => s.enrichmentStatus === "failed")
                    ?._count || 0,
            progress:
                artistTotal > 0 ?
                    Math.round((artistCompleted / artistTotal) * 100)
                :   0,
        },
        trackTags: {
            total: trackTotal,
            enriched: trackTagsEnriched,
            pending: trackTotal - trackTagsEnriched,
            progress:
                trackTotal > 0 ?
                    Math.round((trackTagsEnriched / trackTotal) * 100)
                :   0,
        },

        // Background enrichment (non-blocking, runs in audio-analyzer container)
        audioAnalysis: {
            total: trackTotal,
            completed: audioCompleted,
            pending: audioPending,
            processing: audioProcessing,
            failed: audioFailed,
            progress:
                trackTotal > 0 ?
                    Math.round((audioCompleted / trackTotal) * 100)
                :   0,
            isBackground: true, // Flag to indicate this runs separately
        },

        // CLAP embeddings (for vibe similarity search)
        clapEmbeddings: {
            total: trackTotal,
            completed: clapCompleted,
            pending: trackTotal - clapCompleted - clapFailed,
            processing: clapProcessing,
            failed: clapFailed,
            progress:
                trackTotal > 0 ?
                    Math.round((clapCompleted / trackTotal) * 100)
                :   0,
            isBackground: true,
        },

        // Overall status
        coreComplete, // True when artists + track tags are done
        isFullyComplete:
            coreComplete &&
            audioPending === 0 &&
            audioProcessing === 0 &&
            clapProcessing === 0 &&
            clapQueueLength === 0 &&
            clapCompleted + clapFailed >= trackTotal,
    };
}

/**
 * Trigger an immediate enrichment cycle (non-blocking)
 * Used when new tracks are added and we want to collect mood tags right away
 * instead of waiting for the 30s background interval
 */
export async function triggerEnrichmentNow(): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
}> {
    logger.debug("[Enrichment] Triggering immediate enrichment cycle...");

    // Reset pause state when triggering enrichment
    isPaused = false;

    // Set flag to bypass isRunning check (prevents race conditions)
    immediateEnrichmentRequested = true;

    return runEnrichmentCycleClaimed(false, "immediate enrichment cycle");
}

 /**
  * Re-run artist enrichment only (from the beginning)
  * Resets artist statuses and starts sequential enrichment from Phase 1
  */
 export async function reRunArtistsOnly(): Promise<{ count: number }> {
     logger.debug("[Enrichment] Re-running artist enrichment only...");

     const result = await resetArtistsOnly();

     logger.debug("[Enrichment] Starting sequential enrichment from artists phase...");
     isPaused = false;
     immediateEnrichmentRequested = true;

     // Run full cycle but it will stop after artists phase if paused/stopped
     const cycleResult = await runEnrichmentCycleClaimed(
         false,
         "artist-only enrichment cycle",
     );

     return { count: result.count };
 }

 /**
  * Re-run mood tags only (from the beginning)
  * Resets mood tags and starts sequential enrichment from Phase 1
  */
 export async function reRunMoodTagsOnly(): Promise<{ count: number }> {
     logger.debug("[Enrichment] Re-running mood tags only...");

     const result = await resetMoodTagsOnly();

     logger.debug("[Enrichment] Starting sequential enrichment from mood tags phase...");
     isPaused = false;
     immediateEnrichmentRequested = true;

     const cycleResult = await runEnrichmentCycleClaimed(
         false,
         "mood-tag enrichment cycle",
     );

     return { count: result.count };
 }

 /**
  * Re-run audio analysis only
  * Cleans up stale jobs and queues for audio analysis
  */
 export async function reRunAudioAnalysisOnly(): Promise<number> {
     logger.debug("[Enrichment] Re-running audio analysis only...");

     await audioAnalysisCleanupService.cleanupStaleProcessing();

     const tracks = await prisma.track.findMany({
         where: { analysisStatus: "pending" },
         select: { id: true },
     });

     logger.debug(`[Enrichment] Found ${tracks.length} tracks pending audio analysis`);

     const queued = await queueAudioAnalysis();

     logger.debug(`[Enrichment] Queued ${queued} tracks for audio analysis`);

     return queued;
 }

 /**
  * Re-run vibe embeddings only
  * Cleans up stale jobs and queues for vibe embeddings
  */
export async function reRunVibeEmbeddingsOnly(): Promise<number> {
     logger.debug("[Enrichment] Re-running vibe embeddings only...");

     const features = await featureDetection.getFeatures();
     if (!features.vibeEmbeddings) {
         logger.debug("[Enrichment] Vibe embeddings not available, skipping");
         return 0;
     }

     await vibeAnalysisCleanupService.cleanupStaleProcessing();

     const queued = await queueVibeEmbeddings();

     logger.debug(`[Enrichment] Queued ${queued} tracks for vibe embeddings`);

     return queued;
 }

export const __unifiedEnrichmentTestables = {
    withEnrichmentPrismaRetry,
    waitForActiveCycleToStop,
    runEnrichmentCycle,
    enrichArtistsBatch,
    enrichTrackTagsBatch,
    __setRuntimeStateForTests: (
        nextState: Partial<{
            isRunning: boolean;
            isPaused: boolean;
            isStopping: boolean;
            immediateEnrichmentRequested: boolean;
            consecutiveSystemFailures: number;
            lastRunTime: number;
            sessionFailureCount: {
                artists: number;
                tracks: number;
                audio: number;
            };
        }>,
    ) => {
        if (typeof nextState.isRunning === "boolean") {
            isRunning = nextState.isRunning;
        }
        if (typeof nextState.isPaused === "boolean") {
            isPaused = nextState.isPaused;
        }
        if (typeof nextState.isStopping === "boolean") {
            isStopping = nextState.isStopping;
        }
        if (typeof nextState.immediateEnrichmentRequested === "boolean") {
            immediateEnrichmentRequested = nextState.immediateEnrichmentRequested;
        }
        if (typeof nextState.consecutiveSystemFailures === "number") {
            consecutiveSystemFailures = nextState.consecutiveSystemFailures;
        }
        if (typeof nextState.lastRunTime === "number") {
            lastRunTime = nextState.lastRunTime;
        }
        if (nextState.sessionFailureCount) {
            sessionFailureCount = {
                artists: nextState.sessionFailureCount.artists,
                tracks: nextState.sessionFailureCount.tracks,
                audio: nextState.sessionFailureCount.audio,
            };
        }
    },
    __getRuntimeStateForTests: () => ({
        isRunning,
        isPaused,
        isStopping,
        immediateEnrichmentRequested,
        consecutiveSystemFailures,
        lastRunTime,
        sessionFailureCount,
    }),
};
