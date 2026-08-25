/**
 * Unified Acquisition Service
 *
 * Consolidates album/track acquisition logic from Discovery Weekly and Playlist Import.
 * Handles download source selection, behavior matrix routing, and job tracking.
 *
 * Phase 2.1: Initial implementation
 * - Behavior matrix logic for primary/fallback source selection
 * - Soulseek album acquisition (track list → batch download)
 * - Lidarr album acquisition (webhook-based completion)
 * - DownloadJob management with context-based tracking
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { getSystemSettings } from "../utils/systemSettings";
import { simpleDownloadManager } from "./simpleDownloadManager";
import { soulseekService } from "./soulseek";
import { lastFmService } from "./lastfm";
import type { AcquisitionErrorType } from "./lidarr";
import PQueue from "p-queue";
import {
    type DownloadSource,
    type DownloadSourceAvailability,
    probeDownloadSourceAvailability,
    resolveDownloadSource,
} from "./downloadSourcePolicy";
import { processSoulseekDownload } from "./soulseekLibraryDownload";
import { patchDownloadJobMetadata } from "./downloadJobStatus";

/**
 * Context for tracking acquisition origin
 * Used to link download jobs to their source (Discovery batch or Spotify import)
 */
export interface AcquisitionContext {
    userId: string;
    discoveryBatchId?: string;
    spotifyImportJobId?: string;
    existingJobId?: string;
}

/**
 * Request to acquire an album
 */
export interface AlbumAcquisitionRequest {
    albumTitle: string;
    artistName: string;
    mbid?: string;
    lastfmUrl?: string;
    requestedTracks?: Array<{ title: string; position?: number }>;
}

/**
 * Request to acquire individual tracks (for Unknown Album case)
 */
export interface TrackAcquisitionRequest {
    trackTitle: string;
    artistName: string;
    albumTitle?: string;
}

/**
 * Result of an acquisition attempt
 */
export interface AcquisitionResult {
    success: boolean;
    downloadJobId?: number;
    source?: "soulseek" | "lidarr";
    error?: string;
    errorType?: AcquisitionErrorType;
    isRecoverable?: boolean;
    tracksDownloaded?: number;
    tracksTotal?: number;
    correlationId?: string;
}

/**
 * Download behavior matrix configuration
 */
interface DownloadBehavior {
    hasPrimarySource: boolean;
    primarySource: "soulseek" | "lidarr" | null;
    hasFallbackSource: boolean;
    fallbackSource: "soulseek" | "lidarr" | null;
}

const NO_ACQUISITION_SOURCES: DownloadBehavior = {
    hasPrimarySource: false,
    primarySource: null,
    hasFallbackSource: false,
    fallbackSource: null,
};

function acquisitionAvailability(
    availability: DownloadSourceAvailability,
): DownloadSourceAvailability {
    return { ...availability, tidal: false, youtube: false };
}

function isAcquisitionSource(
    source: DownloadSource,
): source is "soulseek" | "lidarr" {
    return source === "soulseek" || source === "lidarr";
}

function availableAcquisitionSource(
    source: DownloadSource,
    availability: DownloadSourceAvailability,
): "soulseek" | "lidarr" | null {
    return isAcquisitionSource(source) && availability[source] ? source : null;
}

function fallbackAcquisitionSource(
    configuredSource: DownloadSource,
    fallback: string | null | undefined,
    availability: DownloadSourceAvailability,
    primarySource: "soulseek" | "lidarr",
): "soulseek" | "lidarr" | null {
    const resolution = resolveDownloadSource({
        configuredSource,
        fallback,
        availability: { ...availability, [primarySource]: false },
    });
    if (resolution.kind === "fail") return null;
    return availableAcquisitionSource(resolution.source, availability);
}

function acquisitionBehavior(
    configuredSource: DownloadSource,
    fallback: string | null | undefined,
    availability: DownloadSourceAvailability,
): DownloadBehavior {
    const primaryResolution = resolveDownloadSource({
        configuredSource,
        fallback,
        availability,
    });
    if (primaryResolution.kind === "fail") return NO_ACQUISITION_SOURCES;
    const primarySource = availableAcquisitionSource(
        primaryResolution.source,
        availability,
    );
    if (!primarySource) return NO_ACQUISITION_SOURCES;
    const fallbackSource = fallbackAcquisitionSource(
        configuredSource,
        fallback,
        availability,
        primarySource,
    );
    const hasFallbackSource =
        fallbackSource !== null && fallbackSource !== primarySource;
    return {
        hasPrimarySource: true,
        primarySource,
        hasFallbackSource,
        fallbackSource: hasFallbackSource ? fallbackSource : null,
    };
}

async function resolveAcquisitionBehavior(): Promise<DownloadBehavior> {
    const settings = await getSystemSettings();
    const configuredSource = (settings?.downloadSource ||
        "soulseek") as DownloadSource;
    const availability = acquisitionAvailability(
        await probeDownloadSourceAvailability(),
    );
    return acquisitionBehavior(
        configuredSource,
        settings?.primaryFailureFallback,
        availability,
    );
}

class AcquisitionService {
    private albumQueue: PQueue;
    private lastConcurrency: number = 4;

    constructor() {
        // Initialize album queue with default concurrency (will be updated from settings)
        this.albumQueue = new PQueue({ concurrency: 4 });
        logger.debug(
            "[Acquisition] Initialized album queue with default concurrency=4",
        );
    }

    /**
     * Update album queue concurrency from user settings
     * Called before processing to ensure settings are respected
     */
    private async updateQueueConcurrency(): Promise<void> {
        const settings = await getSystemSettings();
        const concurrency = settings?.soulseekConcurrentDownloads || 4;

        if (concurrency !== this.lastConcurrency) {
            this.albumQueue.concurrency = concurrency;
            this.lastConcurrency = concurrency;
            logger.debug(
                `[Acquisition] Updated album queue concurrency to ${concurrency}`,
            );
        }
    }

    /**
     * Update download job with source-specific status text
     * Stored in metadata for frontend display
     */
    private async updateJobStatusText(
        jobId: string,
        source: "lidarr" | "soulseek",
        attemptNumber: number,
    ): Promise<void> {
        const sourceLabel = source.charAt(0).toUpperCase() + source.slice(1);
        const statusText = `${sourceLabel} #${attemptNumber}`;

        await patchDownloadJobMetadata(jobId, (current) => ({
            ...current,
            currentSource: source,
            lidarrAttempts:
                source === "lidarr"
                    ? attemptNumber
                    : current.lidarrAttempts || 0,
            soulseekAttempts:
                source === "soulseek"
                    ? attemptNumber
                    : current.soulseekAttempts || 0,
            statusText,
        }));

        logger.debug(`[Acquisition] Updated job ${jobId}: ${statusText}`);
    }

    /**
     * Acquire an album using the configured behavior matrix
     * Routes to Soulseek or Lidarr based on settings, with fallback support
     * Queued to enable parallel album acquisition
     *
     * @param request - Album to acquire
     * @param context - Tracking context (userId, batchId, etc.)
     * @returns Acquisition result
     */
    async acquireAlbum(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext,
    ): Promise<AcquisitionResult> {
        // Update queue concurrency from user settings
        await this.updateQueueConcurrency();

        return this.albumQueue.add(() =>
            this.acquireAlbumInternal(request, context),
        );
    }

    /**
     * Internal album acquisition logic (called via queue)
     */
    private async acquireAlbumInternal(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext,
    ): Promise<AcquisitionResult> {
        logger.debug(
            `\n[Acquisition] Acquiring album: ${request.artistName} - ${request.albumTitle} (queue: ${this.albumQueue.size} pending, ${this.albumQueue.pending} active)`,
        );

        // Verify artist name before acquisition
        try {
            const correction = await lastFmService.getArtistCorrection(
                request.artistName,
            );
            if (correction?.corrected) {
                logger.debug(
                    `[Acquisition] Artist corrected: "${request.artistName}" → "${correction.canonicalName}"`,
                );
                request = { ...request, artistName: correction.canonicalName };
            }
        } catch (error) {
            logger.warn(
                `[Acquisition] Artist correction failed for "${request.artistName}":`,
                error,
            );
        }

        // Get download behavior configuration
        const behavior = await resolveAcquisitionBehavior();

        // Validate at least one source is available
        if (!behavior.hasPrimarySource) {
            const error =
                "No download sources available (neither Soulseek nor Lidarr configured)";
            logger.error(`[Acquisition] ${error}`);
            return { success: false, error };
        }

        // Try primary source first
        let result: AcquisitionResult;

        if (behavior.primarySource === "soulseek") {
            logger.debug(`[Acquisition] Trying primary: Soulseek`);
            result = await this.processSoulseekAcquisition(request, context);

            // Fallback to Lidarr if Soulseek fails and fallback is configured
            if (!result.success) {
                logger.debug(
                    `[Acquisition] Soulseek failed: ${result.error || "unknown error"}`,
                );
                logger.debug(
                    `[Acquisition] Fallback available: hasFallback=${behavior.hasFallbackSource}, source=${behavior.fallbackSource}`,
                );

                if (
                    behavior.hasFallbackSource &&
                    behavior.fallbackSource === "lidarr"
                ) {
                    logger.debug(`[Acquisition] Attempting Lidarr fallback...`);
                    result = await this.acquireAlbumViaLidarr(request, context);
                } else {
                    logger.debug(
                        `[Acquisition] No fallback configured or fallback not Lidarr`,
                    );
                }
            }
        } else if (behavior.primarySource === "lidarr") {
            logger.debug(`[Acquisition] Trying primary: Lidarr`);
            result = await this.acquireAlbumViaLidarr(request, context);

            // Fallback to Soulseek if Lidarr fails and fallback is configured
            if (!result.success) {
                logger.debug(
                    `[Acquisition] Lidarr failed: ${result.error || "unknown error"}`,
                );
                logger.debug(
                    `[Acquisition] Fallback available: hasFallback=${behavior.hasFallbackSource}, source=${behavior.fallbackSource}`,
                );

                if (
                    behavior.hasFallbackSource &&
                    behavior.fallbackSource === "soulseek"
                ) {
                    logger.debug(
                        `[Acquisition] Attempting Soulseek fallback...`,
                    );
                    result = await this.processSoulseekAcquisition(
                        request,
                        context,
                    );
                } else {
                    logger.debug(
                        `[Acquisition] No fallback configured or fallback not Soulseek`,
                    );
                }
            }
        } else {
            // This should never happen due to validation above
            const error = "No primary source configured";
            logger.error(`[Acquisition] ${error}`);
            return { success: false, error };
        }

        return result;
    }

    /**
     * Acquire individual tracks via Soulseek (for Unknown Album case)
     * Batch downloads tracks without album MBID
     *
     * @param requests - Tracks to acquire
     * @param context - Tracking context
     * @returns Array of acquisition results
     */
    async acquireTracks(
        requests: TrackAcquisitionRequest[],
        context: AcquisitionContext,
    ): Promise<AcquisitionResult[]> {
        logger.debug(
            `\n[Acquisition] Acquiring ${requests.length} individual tracks via Soulseek`,
        );

        // Check Soulseek availability
        const soulseekAvailable = await soulseekService.isAvailable();
        if (!soulseekAvailable) {
            logger.error(
                `[Acquisition] Soulseek not available for track downloads`,
            );
            return requests.map(() => ({
                success: false,
                error: "Soulseek not configured",
            }));
        }

        // Get music path
        const settings = await getSystemSettings();
        const musicPath = settings?.musicPath;
        if (!musicPath) {
            logger.error(`[Acquisition] Music path not configured`);
            return requests.map(() => ({
                success: false,
                error: "Music path not configured",
            }));
        }

        // Prepare tracks for batch download
        const tracksToDownload = requests.map((req) => ({
            artist: req.artistName,
            title: req.trackTitle,
            album: req.albumTitle || "Unknown Album",
        }));

        try {
            // Use Soulseek batch download
            const batchResult = await soulseekService.searchAndDownloadBatch(
                tracksToDownload,
                musicPath,
                settings?.soulseekConcurrentDownloads || 4, // concurrency
            );

            logger.debug(
                `[Acquisition] Batch result: ${batchResult.successful}/${requests.length} tracks downloaded`,
            );

            // Create individual results for each track
            // Note: Batch doesn't return per-track success mapping, so we use error messages to determine failures
            const results: AcquisitionResult[] = requests.map((req) => {
                // Check if this specific track had an error in the batch result
                const trackKey = `${req.artistName} - ${req.trackTitle}`;
                const trackError = batchResult.errors.find((e) =>
                    e.startsWith(trackKey),
                );
                const success = !trackError;

                return {
                    success,
                    source: "soulseek" as const,
                    tracksDownloaded: success ? 1 : 0,
                    tracksTotal: 1,
                    error: trackError || undefined,
                };
            });

            return results;
        } catch (error: any) {
            logger.error(
                `[Acquisition] Batch track download error: ${error.message}`,
            );
            return requests.map(() => ({
                success: false,
                error: error.message,
            }));
        }
    }

    private async processSoulseekAcquisition(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext,
    ): Promise<AcquisitionResult> {
        if (!request.mbid) {
            return {
                success: false,
                error: "Album MBID required for Soulseek download",
            };
        }
        const settings = await getSystemSettings();
        if (!settings?.musicPath) {
            return { success: false, error: "Music path not configured" };
        }
        const job = await this.createDownloadJob(request, context);
        return processSoulseekDownload(
            job.id,
            request.artistName,
            request.albumTitle,
            context.userId,
        );
    }

    /**
     * Acquire album via Lidarr (full album download)
     * Creates download job and waits for webhook completion
     *
     * @param request - Album to acquire
     * @param context - Tracking context
     * @returns Acquisition result
     */
    private async acquireAlbumViaLidarr(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext,
    ): Promise<AcquisitionResult> {
        logger.debug(
            `[Acquisition/Lidarr] Downloading: ${request.artistName} - ${request.albumTitle}`,
        );

        if (!request.mbid) {
            return {
                success: false,
                error: "Album MBID required for Lidarr download",
            };
        }

        let job: any;
        try {
            // Create download job
            job = await this.createDownloadJob(request, context);

            // Calculate attempt number (existing lidarr attempts + 1)
            const jobMetadata = (job.metadata as any) || {};
            const lidarrAttempts = (jobMetadata.lidarrAttempts || 0) + 1;
            await this.updateJobStatusText(job.id, "lidarr", lidarrAttempts);

            // Start Lidarr download
            const isDiscovery = !!context.discoveryBatchId;
            const result = await simpleDownloadManager.startDownload(
                job.id,
                request.artistName,
                request.albumTitle,
                request.mbid,
                context.userId,
                isDiscovery,
            );

            if (result.success) {
                logger.debug(
                    `[Acquisition/Lidarr] Download started (correlation: ${result.correlationId})`,
                );

                return {
                    success: true,
                    source: "lidarr",
                    downloadJobId: parseInt(job.id),
                    correlationId: result.correlationId,
                };
            } else {
                logger.error(
                    `[Acquisition/Lidarr] Failed to start: ${result.error}`,
                );

                // Mark job as failed
                await this.updateJobStatus(job.id, "failed", result.error);

                // Return structured error info for fallback logic
                return {
                    success: false,
                    error: result.error,
                    errorType: result.errorType,
                    isRecoverable: result.isRecoverable,
                };
            }
        } catch (error: any) {
            logger.error(`[Acquisition/Lidarr] Error: ${error.message}`);
            // Update job status if job was created
            if (job) {
                await this.updateJobStatus(
                    job.id,
                    "failed",
                    error.message,
                ).catch((e) =>
                    logger.error(
                        `[Acquisition/Lidarr] Failed to update job status: ${e.message}`,
                    ),
                );
            }
            return { success: false, error: error.message };
        }
    }

    /**
     * Create a DownloadJob for tracking acquisition
     * Links to Discovery batch or Spotify import job as appropriate
     *
     * @param request - Album request
     * @param context - Tracking context
     * @returns Created download job
     */
    private async createDownloadJob(
        request: AlbumAcquisitionRequest,
        context: AcquisitionContext,
    ): Promise<any> {
        // Check for existing job first
        if (context.existingJobId) {
            logger.debug(
                `[Acquisition] Using existing download job: ${context.existingJobId}`,
            );
            return { id: context.existingJobId };
        }

        // Validate userId before creating download job to prevent foreign key constraint violations
        if (
            !context.userId ||
            typeof context.userId !== "string" ||
            context.userId === "NaN" ||
            context.userId === "undefined" ||
            context.userId === "null"
        ) {
            logger.error(
                `[Acquisition] Invalid userId in context: ${JSON.stringify({
                    userId: context.userId,
                    typeofUserId: typeof context.userId,
                    albumTitle: request.albumTitle,
                    artistName: request.artistName,
                })}`,
            );
            throw new Error(
                `Invalid userId in acquisition context: ${context.userId}`,
            );
        }

        const jobData: any = {
            userId: context.userId,
            subject: `${request.artistName} - ${request.albumTitle}`,
            type: "album",
            targetMbid: request.mbid || null,
            status: "pending",
            metadata: {
                artistName: request.artistName,
                albumTitle: request.albumTitle,
                albumMbid: request.mbid,
                ...(request.requestedTracks
                    ? { requestedTracks: request.requestedTracks }
                    : {}),
            },
        };

        // Add context-based tracking
        if (context.discoveryBatchId) {
            jobData.discoveryBatchId = context.discoveryBatchId;
            jobData.metadata.downloadType = "discovery";
        }

        if (context.spotifyImportJobId) {
            jobData.metadata.spotifyImportJobId = context.spotifyImportJobId;
            jobData.metadata.downloadType = "spotify_import";
        }

        const job = await prisma.downloadJob.create({
            data: jobData,
        });

        logger.debug(
            `[Acquisition] Created download job: ${job.id} (type: ${
                jobData.metadata.downloadType || "library"
            })`,
        );

        return job;
    }

    /**
     * Update download job status
     *
     * @param jobId - Job ID to update
     * @param status - New status
     * @param error - Optional error message
     */
    private async updateJobStatus(
        jobId: string,
        status: string,
        error?: string,
    ): Promise<void> {
        await prisma.downloadJob.update({
            where: { id: jobId },
            data: {
                status,
                error: error || null,
                completedAt:
                    status === "completed" || status === "failed"
                        ? new Date()
                        : undefined,
            },
        });

        logger.debug(
            `[Acquisition] Updated job ${jobId}: status=${status}${
                error ? `, error=${error}` : ""
            }`,
        );
    }
}

// Export singleton instance
export const acquisitionService = new AcquisitionService();
