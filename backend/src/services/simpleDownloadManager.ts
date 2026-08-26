/**
 * Simple Download Manager (Refactored)
 *
 * Stateless download service that uses the database as the single source of truth.
 * Handles album downloads with automatic retry, blocklisting, and completion tracking.
 * No in-memory state - survives server restarts.
 */

import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { Prisma, PrismaClient } from "@prisma/client";
import {
    lidarrService,
    AcquisitionError,
    AcquisitionErrorType,
    ReconciliationSnapshot,
} from "./lidarr";
import { resolveDownloadArtistMbid } from "./downloadArtistMbid";
import { getSystemSettings } from "../utils/systemSettings";
import { config } from "../config";
import * as crypto from "crypto";
import {
    ACTIVE_DOWNLOAD_JOB_STATUSES,
    failDownloadJob,
    patchDownloadJobMetadata,
} from "./downloadJobStatus";
import { asPlainObject } from "../utils/plainObject";
import { toErrorMessage } from "../utils/errors";
import {
    tryNextAlbumFromArtist as executeAlbumRetry,
    type AlbumRetryResult,
} from "./download/albumRetryStrategy";
import { DownloadJobEvents } from "./download/downloadJobEvents";
import { registerDownloadJobNotificationSubscriber } from "./download/downloadJobNotificationSubscriber";
import { markStaleJobsAsFailed as sweepStaleDownloadJobs } from "./download/staleDownloadSweeper";
import {
    reconcileWithLidarr,
    syncWithLidarrQueue,
} from "./download/lidarrQueueReconciler";

// Type for transactional prisma client
type TransactionClient = Omit<
    PrismaClient,
    "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

// Generate a UUID v4 without external dependency
function generateCorrelationId(): string {
    return crypto.randomUUID();
}

class SimpleDownloadManager {
    private readonly DEFAULT_MAX_ATTEMPTS = 3;

    constructor(private readonly downloadJobEvents: DownloadJobEvents) {}

    /**
     * Get max retry attempts from user's discover config, fallback to default
     */
    private async getMaxAttempts(userId: string): Promise<number> {
        try {
            const config = await prisma.userDiscoverConfig.findUnique({
                where: { userId },
            });
            return config?.maxRetryAttempts || this.DEFAULT_MAX_ATTEMPTS;
        } catch {
            return this.DEFAULT_MAX_ATTEMPTS;
        }
    }

    /**
     * Transaction wrapper with retry logic for serialization conflicts
     */
    private async withTransaction<T>(
        operation: (tx: TransactionClient) => Promise<T>,
        options?: { maxRetries?: number; logPrefix?: string },
    ): Promise<T> {
        const maxRetries = options?.maxRetries ?? 3;
        const logPrefix = options?.logPrefix ?? "[TX]";
        let lastError: Error | undefined;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await prisma.$transaction(operation, {
                    isolationLevel:
                        Prisma.TransactionIsolationLevel.Serializable,
                    maxWait: 5000,
                    timeout: 10000,
                });
            } catch (error: any) {
                // Check for serialization failure
                const isSerializationError =
                    error.code === "P2034" ||
                    error.message?.includes("could not serialize") ||
                    error.message?.includes("deadlock");

                if (isSerializationError && attempt < maxRetries) {
                    lastError = error;
                    const delay = Math.pow(2, attempt) * 100; // 200ms, 400ms, 800ms
                    logger.debug(
                        `${logPrefix} Serialization conflict, retry ${attempt}/${maxRetries} after ${delay}ms`,
                    );
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    continue;
                }
                throw error;
            }
        }

        throw lastError;
    }

    /**
     * Recovery path for onDownloadGrabbed when a concurrent duplicate Grab
     * webhook (the same Lidarr download delivered/retried twice, or a race
     * with the queue-cleaner reconciler) loses the partial-unique-index race
     * on targetMbid (`DownloadJob_targetMbid_active_unique`, migration
     * `20260118000000_add_partial_unique_index_active_downloads`) at either
     * the matched-job update or the tracking-job create inside
     * onDownloadGrabbed's transaction.
     *
     * Placement note: both writes happen inside the SAME withTransaction
     * callback, so by the time this runs, Prisma's interactive $transaction
     * has already rolled the transaction back and rethrown (that's how a
     * callback rejection is handled). The `tx` client from that callback is
     * dead — re-querying with it here would fail with "current transaction
     * is aborted, commands ignored until end of transaction block". This
     * method is wired via `.catch()` on the *outside* of the withTransaction
     * call (see below) specifically so the re-find runs against the plain
     * `prisma` singleton, which opens its own fresh implicit
     * transaction/connection, unaffected by the aborted one.
     */
    private async recoverFromGrabRaceError(
        error: any,
        downloadId: string,
    ): Promise<{ matched: boolean; jobId?: string }> {
        if (error?.code !== "P2002") {
            throw error;
        }

        logger.debug(
            `[GRAB-TX] P2002 on grab for downloadId=${downloadId}; re-finding the winning job`,
        );

        // Both the matched-update and the tracking-job create write
        // lidarrRef + metadata.downloadId together on success (see Step 4
        // above), so whichever concurrent call won the race is findable by
        // either signal. Prefer the indexed lidarrRef column; keep the
        // JSON-path metadata check as a fallback for the same reason Step 1's
        // idempotency check uses it.
        const winner = await prisma.downloadJob.findFirst({
            where: {
                OR: [
                    { lidarrRef: downloadId },
                    { metadata: { path: ["downloadId"], equals: downloadId } },
                ],
            },
        });

        if (winner) {
            logger.debug(
                `[GRAB-TX] Duplicate grab resolved to existing job: ${winner.id}`,
            );
            return { matched: true, jobId: winner.id };
        }

        // Truthful, non-throwing fallback: we couldn't identify the winner
        // (e.g. a different downloadId raced on the same targetMbid, which is
        // outside this recipe's scope), but a real active row exists
        // somewhere under the partial-unique constraint. Preserve the
        // existing "can't determine, don't fabricate a match" contract shape
        // rather than inventing a new resolution path.
        logger.warn(
            `[DownloadManager] P2002 on grab but no winning job found for downloadId=${downloadId}`,
        );
        return { matched: false };
    }

    /**
     * Start a new download
     * Returns the correlation ID for webhook matching
     * @param isDiscovery - If true, tags the artist in Lidarr for discovery cleanup
     */
    async startDownload(
        jobId: string,
        artistName: string,
        albumTitle: string,
        albumMbid: string,
        userId: string,
        isDiscovery: boolean = false,
        providedArtistMbid?: string,
    ): Promise<{
        success: boolean;
        correlationId?: string;
        error?: string;
        errorType?: AcquisitionErrorType;
        isRecoverable?: boolean;
    }> {
        logger.debug(
            `\n Starting download: ${artistName} - ${albumTitle}${
                isDiscovery ? " (discovery)" : ""
            }`,
        );
        logger.debug(`   Job ID: ${jobId}`);
        logger.debug(`   Album MBID: ${albumMbid}`);

        // Generate correlation ID for webhook matching
        const correlationId = generateCorrelationId();

        try {
            // Get music path from settings with fallback to config
            const settings = await getSystemSettings();
            const musicPath = settings?.musicPath || config.music.musicPath;

            const artistMbid = await resolveDownloadArtistMbid(
                albumMbid,
                providedArtistMbid,
            );

            // Add album to Lidarr (with discovery tag if this is a discovery download)
            const result = await lidarrService.addAlbum(
                albumMbid,
                artistName,
                albumTitle,
                musicPath,
                artistMbid,
                isDiscovery,
            );

            if (!result) {
                throw new Error(
                    "Failed to add album to Lidarr - album not found",
                );
            }

            logger.debug(`   Album queued in Lidarr (ID: ${result.id})`);

            // Lidarr may have matched by name and returned a different MBID
            const actualLidarrMbid = result.foreignAlbumId;
            if (actualLidarrMbid && actualLidarrMbid !== albumMbid) {
                logger.debug(
                    `   MBID mismatch - original: ${albumMbid}, Lidarr: ${actualLidarrMbid}`,
                );
            }

            // Update job with all tracking information
            // IMPORTANT: Preserve existing metadata (especially tier/similarity from discovery jobs)
            const now = new Date();
            await patchDownloadJobMetadata(
                jobId,
                (current) => {
                    const lidarrAttempts =
                        ((current.lidarrAttempts as number) || 0) + 1;
                    return {
                        ...current,
                        albumTitle,
                        artistName,
                        artistMbid,
                        albumMbid,
                        lidarrMbid: actualLidarrMbid,
                        downloadType: current.downloadType || "library",
                        startedAt: now.toISOString(),
                        currentSource: "lidarr" as const,
                        lidarrAttempts,
                        statusText: `Lidarr #${lidarrAttempts}`,
                    };
                },
                {
                    correlationId, // Unique ID for webhook matching
                    status: "processing",
                    startedAt: now, // For timeout tracking (if field exists)
                    lidarrAlbumId: result.id, // Store Lidarr album ID for retry/cleanup
                    artistMbid: artistMbid, // Store artist MBID for same-artist fallback
                    attempts: 1,
                },
            );

            logger.debug(
                `   Download started with correlation ID: ${correlationId}`,
            );
            return { success: true, correlationId };
        } catch (error: any) {
            logger.error(`   Failed to start download:`, error.message);

            // Extract error properties if this is an AcquisitionError
            const errorType =
                error instanceof AcquisitionError ? error.type : undefined;
            const isRecoverable =
                error instanceof AcquisitionError
                    ? error.isRecoverable
                    : undefined;

            // Get the job to check if it's a discovery job
            const job = await prisma.downloadJob.findUnique({
                where: { id: jobId },
            });
            const existingMetadata = asPlainObject(job?.metadata);

            // Handle "No releases available" error - immediate failure
            if (error.message?.includes("No releases available")) {
                logger.debug(
                    `   No sources found - handling immediate failure`,
                );

                // For discovery jobs, skip same-artist fallback
                if (job?.discoveryBatchId) {
                    logger.debug(
                        `   Discovery job - skipping same-artist fallback (diversity enforced)`,
                    );
                } else if (job && !job.discoveryBatchId) {
                    // For library downloads, try same-artist fallback
                    logger.debug(
                        `   Library download - trying same-artist fallback...`,
                    );

                    const artistMbid =
                        job.artistMbid || existingMetadata.artistMbid;

                    if (artistMbid) {
                        const fallbackResult =
                            await this.tryNextAlbumFromArtist(
                                { ...job, metadata: existingMetadata },
                                "No sources available",
                            );

                        if (fallbackResult.retried && fallbackResult.jobId) {
                            return { success: true };
                        }
                    }
                }

                // Mark as failed with proper status text
                await patchDownloadJobMetadata(
                    jobId,
                    {
                        statusText: "No sources available",
                        failedAt: new Date().toISOString(),
                    },
                    {
                        correlationId,
                        status: "failed",
                        error: error.message,
                        completedAt: new Date(),
                    },
                );

                // Check batch completion for discovery jobs
                if (job?.discoveryBatchId) {
                    const { discoverWeeklyService } =
                        await import("./discoverWeekly");
                    await discoverWeeklyService.checkBatchCompletion(
                        job.discoveryBatchId,
                    );
                }

                return {
                    success: false,
                    error: error.message,
                    errorType,
                    isRecoverable,
                };
            }

            // If album wasn't found, try same-artist fallback ONLY for non-discovery jobs
            // Discovery jobs should find NEW artists via the discovery system instead
            if (job && error.message?.includes("album not found")) {
                if (job.discoveryBatchId) {
                    logger.debug(
                        `   Album not found - Discovery job, skipping same-artist fallback`,
                    );
                    logger.debug(
                        `   Discovery system will find a different artist instead`,
                    );
                } else {
                    logger.debug(
                        `   Album not found - trying same-artist fallback...`,
                    );

                    const artistMbid =
                        job.artistMbid || existingMetadata.artistMbid;

                    if (artistMbid) {
                        const fallbackResult =
                            await this.tryNextAlbumFromArtist(
                                { ...job, metadata: existingMetadata },
                                "Album not found in Lidarr",
                            );

                        if (fallbackResult.retried && fallbackResult.jobId) {
                            return { success: true };
                        }
                    }
                }
            }

            // No replacement found - mark as failed
            await patchDownloadJobMetadata(
                jobId,
                {
                    statusText: "Failed to start",
                    failedAt: new Date().toISOString(),
                },
                {
                    correlationId,
                    status: "failed",
                    error: error.message || "Failed to add album to Lidarr",
                    completedAt: new Date(),
                },
            );

            // Check batch completion for discovery jobs
            if (job?.discoveryBatchId) {
                const { discoverWeeklyService } =
                    await import("./discoverWeekly");
                await discoverWeeklyService.checkBatchCompletion(
                    job.discoveryBatchId,
                );
            }

            return {
                success: false,
                error: error.message,
                errorType,
                isRecoverable,
            };
        }
    }

    /**
     * Handle download grabbed event (from webhook)
     * Links the Lidarr downloadId to our job
     *
     * IMPORTANT: One logical album = one job, regardless of MBID.
     * MBIDs can differ between MusicBrainz and Lidarr, but artist+album name is canonical.
     */
    async onDownloadGrabbed(
        downloadId: string,
        albumMbid: string,
        albumTitle: string,
        artistName: string,
        lidarrAlbumId: number,
    ): Promise<{ matched: boolean; jobId?: string }> {
        logger.debug(`[DOWNLOAD] Grabbed: ${artistName} - ${albumTitle}`);
        logger.debug(`   Download ID: ${downloadId}`);

        return await this.withTransaction(
            async (tx) => {
                // ═══════════════════════════════════════════════════════════════
                // STEP 1: Idempotency Check - Already processed?
                // ═══════════════════════════════════════════════════════════════
                const existingByRef = await tx.downloadJob.findFirst({
                    where: {
                        metadata: {
                            path: ["downloadId"],
                            equals: downloadId,
                        },
                    },
                });

                if (existingByRef) {
                    logger.debug(
                        `   Already tracked by job: ${existingByRef.id}`,
                    );
                    return { matched: true, jobId: existingByRef.id };
                }

                // ═══════════════════════════════════════════════════════════════
                // STEP 2: Query Unassigned Jobs (Transaction ensures consistent view)
                // Only get jobs not yet assigned to a download (lidarrRef IS NULL)
                // ═══════════════════════════════════════════════════════════════
                const activeJobs = await tx.downloadJob.findMany({
                    where: {
                        status: { in: ACTIVE_DOWNLOAD_JOB_STATUSES },
                        lidarrRef: null, // Not yet assigned to a download
                    },
                });

                logger.debug(
                    `   Found ${activeJobs.length} unassigned active job(s)`,
                );

                // Normalize for matching
                const normalizedArtist = artistName?.toLowerCase().trim() || "";
                const normalizedAlbum = albumTitle?.toLowerCase().trim() || "";

                // ═══════════════════════════════════════════════════════════════
                // STEP 3: Apply Matching Strategies (In Priority Order)
                // ═══════════════════════════════════════════════════════════════
                let matchedJob: (typeof activeJobs)[0] | undefined;
                let matchStrategy = "";

                // Strategy 1: targetMbid
                matchedJob = activeJobs.find((j) => j.targetMbid === albumMbid);
                if (matchedJob) matchStrategy = "targetMbid";

                // Strategy 2: lidarrMbid in metadata
                if (!matchedJob) {
                    matchedJob = activeJobs.find((j) => {
                        const meta = j.metadata as any;
                        return meta?.lidarrMbid === albumMbid;
                    });
                    if (matchedJob) matchStrategy = "lidarrMbid";
                }

                // Strategy 3: lidarrAlbumId
                if (!matchedJob && lidarrAlbumId > 0) {
                    matchedJob = activeJobs.find((j) => {
                        const meta = j.metadata as any;
                        return (
                            j.lidarrAlbumId === lidarrAlbumId ||
                            meta?.lidarrAlbumId === lidarrAlbumId
                        );
                    });
                    if (matchedJob) matchStrategy = "lidarrAlbumId";
                }

                // Strategy 4: Artist + Album name (canonical match)
                if (!matchedJob && normalizedArtist && normalizedAlbum) {
                    matchedJob = activeJobs.find((j) => {
                        const meta = j.metadata as any;
                        const candArtist =
                            meta?.artistName?.toLowerCase().trim() || "";
                        const candAlbum =
                            meta?.albumTitle?.toLowerCase().trim() || "";
                        return (
                            candArtist === normalizedArtist &&
                            candAlbum === normalizedAlbum
                        );
                    });
                    if (matchedJob) matchStrategy = "artist+album";
                }

                // Strategy 5: Subject field
                if (!matchedJob && normalizedArtist && normalizedAlbum) {
                    matchedJob = activeJobs.find((j) => {
                        const subject = j.subject?.toLowerCase().trim() || "";
                        return (
                            subject.includes(normalizedArtist) &&
                            subject.includes(normalizedAlbum)
                        );
                    });
                    if (matchedJob) matchStrategy = "subject";
                }

                // ═══════════════════════════════════════════════════════════════
                // STEP 4: Update Matched Job OR Create Tracking Job (Atomic)
                // ═══════════════════════════════════════════════════════════════
                if (matchedJob) {
                    logger.debug(
                        `   Matched by ${matchStrategy}: ${matchedJob.id}`,
                    );

                    // Keep this metadata RMW on tx so it commits with the transaction.
                    await tx.downloadJob.update({
                        where: { id: matchedJob.id },
                        data: {
                            status: "processing",
                            lidarrRef: downloadId,
                            lidarrAlbumId,
                            targetMbid: matchedJob.targetMbid || albumMbid,
                            metadata: {
                                ...((matchedJob.metadata as any) || {}),
                                downloadId,
                                lidarrMbid: albumMbid,
                                grabbedAt: new Date().toISOString(),
                            },
                        },
                    });

                    return { matched: true, jobId: matchedJob.id };
                }

                // No match - check for duplicates before creating tracking job
                logger.debug(`   No match found, checking for duplicates...`);

                // ═══════════════════════════════════════════════════════════════
                // DUPLICATE DETECTION: Prevent creating duplicate tracking jobs
                // This prevents the "Beatles Abbey Road" issue where the same
                // album is downloaded twice by SABnzbd, causing file deletions.
                // ═══════════════════════════════════════════════════════════════

                // Normalize for duplicate detection
                const normalizedArtistForDup =
                    artistName?.toLowerCase().trim() || "";
                const normalizedAlbumForDup =
                    albumTitle?.toLowerCase().trim() || "";

                // Check by MBID first (most reliable)
                let existingJob = null;
                if (albumMbid) {
                    existingJob = await tx.downloadJob.findFirst({
                        where: {
                            targetMbid: albumMbid,
                            status: {
                                in: ["pending", "processing", "completed"],
                            },
                        },
                    });
                }

                // If no MBID match, check by artist+album name
                if (
                    !existingJob &&
                    normalizedArtistForDup &&
                    normalizedAlbumForDup
                ) {
                    const candidateJobs = await tx.downloadJob.findMany({
                        where: {
                            status: {
                                in: ["pending", "processing", "completed"],
                            },
                        },
                    });

                    existingJob = candidateJobs.find((j) => {
                        const meta = j.metadata as any;
                        const candArtist =
                            meta?.artistName?.toLowerCase().trim() || "";
                        const candAlbum =
                            meta?.albumTitle?.toLowerCase().trim() || "";
                        return (
                            candArtist === normalizedArtistForDup &&
                            candAlbum === normalizedAlbumForDup
                        );
                    });
                }

                // If duplicate found, log warning and exit early
                if (existingJob) {
                    logger.warn(
                        `[DownloadManager] Duplicate download detected`,
                        {
                            artist: artistName,
                            album: albumTitle,
                            mbid: albumMbid,
                            existingJobId: existingJob.id,
                        },
                    );
                    return { matched: false };
                }

                logger.debug(`   No duplicates found, creating tracking job`);

                // Find user from recent artist download
                const recentJob = await tx.downloadJob.findFirst({
                    where: {
                        type: "artist",
                        status: { in: ["pending", "processing", "completed"] },
                    },
                    orderBy: { createdAt: "desc" },
                });

                if (!recentJob?.userId) {
                    logger.debug(
                        `   Cannot determine user, skipping job creation`,
                    );
                    return { matched: false };
                }

                const trackingJob = await tx.downloadJob.create({
                    data: {
                        userId: recentJob.userId,
                        subject: `${artistName} - ${albumTitle}`,
                        type: "album",
                        targetMbid: albumMbid,
                        status: "processing",
                        lidarrRef: downloadId,
                        lidarrAlbumId,
                        attempts: 1,
                        metadata: {
                            artistName,
                            albumTitle,
                            downloadId,
                            grabbedAt: new Date().toISOString(),
                            source: "lidarr-auto-grab",
                        },
                    },
                });

                logger.debug(`   Created tracking job: ${trackingJob.id}`);
                return { matched: true, jobId: trackingJob.id };
            },
            { logPrefix: "[GRAB-TX]" },
        ).catch((error: any) =>
            this.recoverFromGrabRaceError(error, downloadId),
        );
    }

    /**
     * Handle download complete event (from webhook)
     *
     * IMPORTANT: One logical album = one job. Match by name if MBID doesn't match.
     */
    async onDownloadComplete(
        downloadId: string,
        albumMbid?: string,
        artistName?: string,
        albumTitle?: string,
        lidarrAlbumId?: number,
    ): Promise<{
        jobId?: string;
        batchId?: string;
        downloadBatchId?: string;
        spotifyImportJobId?: string;
    }> {
        logger.debug(`\n[COMPLETE] Download completed: ${downloadId}`);

        const result = await this.withTransaction(
            async (tx) => {
                // ═══════════════════════════════════════════════════════════════
                // STEP 1: Check if already completed (idempotency)
                // ═══════════════════════════════════════════════════════════════
                const completedJob = await tx.downloadJob.findFirst({
                    where: {
                        metadata: {
                            path: ["downloadId"],
                            equals: downloadId,
                        },
                        status: "completed",
                    },
                });

                if (completedJob) {
                    logger.debug(`   Already completed: ${completedJob.id}`);
                    const meta = completedJob.metadata as any;
                    return {
                        jobId: completedJob.id,
                        batchId: completedJob.discoveryBatchId || undefined,
                        downloadBatchId: meta?.batchId,
                        spotifyImportJobId: meta?.spotifyImportJobId,
                    };
                }

                // ═══════════════════════════════════════════════════════════════
                // STEP 2: Find Active Job
                // ═══════════════════════════════════════════════════════════════
                const activeJobs = await tx.downloadJob.findMany({
                    where: {
                        status: { in: ACTIVE_DOWNLOAD_JOB_STATUSES },
                    },
                });

                const normalizedArtist = artistName?.toLowerCase().trim() || "";
                const normalizedAlbum = albumTitle?.toLowerCase().trim() || "";

                let job: (typeof activeJobs)[0] | undefined;

                // Strategy 1: lidarrRef
                job = activeJobs.find((j) => j.lidarrRef === downloadId);
                if (job) logger.debug(`    Matched by lidarrRef`);

                // Strategy 2: lidarrAlbumId
                if (!job && lidarrAlbumId) {
                    job = activeJobs.find(
                        (j) => j.lidarrAlbumId === lidarrAlbumId,
                    );
                    if (job) logger.debug(`    Matched by lidarrAlbumId`);
                }

                // Strategy 3: previousDownloadIds
                if (!job) {
                    job = activeJobs.find((j) => {
                        const meta = j.metadata as any;
                        return meta?.previousDownloadIds?.includes(downloadId);
                    });
                    if (job) logger.debug(`    Matched by previousDownloadIds`);
                }

                // Strategy 4: MBID
                if (!job && albumMbid) {
                    job = activeJobs.find((j) => j.targetMbid === albumMbid);
                    if (!job) {
                        job = activeJobs.find(
                            (j) =>
                                (j.metadata as any)?.lidarrMbid === albumMbid,
                        );
                    }
                    if (job) logger.debug(`    Matched by MBID`);
                }

                // Strategy 5: Name match
                if (!job && normalizedArtist && normalizedAlbum) {
                    job = activeJobs.find((j) => {
                        const meta = j.metadata as any;
                        const candArtist =
                            meta?.artistName?.toLowerCase().trim() || "";
                        const candAlbum =
                            meta?.albumTitle?.toLowerCase().trim() || "";
                        const subject = j.subject?.toLowerCase().trim() || "";

                        return (
                            (candArtist === normalizedArtist &&
                                candAlbum === normalizedAlbum) ||
                            (subject.includes(normalizedArtist) &&
                                subject.includes(normalizedAlbum))
                        );
                    });
                    if (job) logger.debug(`    Matched by name`);
                }

                if (!job) {
                    logger.debug(`   No matching job found`);
                    return {};
                }

                // ═══════════════════════════════════════════════════════════════
                // STEP 3: Find and Mark Duplicates Complete (Atomic)
                // ═══════════════════════════════════════════════════════════════
                const jobMeta = job.metadata as any;
                const jobArtist =
                    jobMeta?.artistName?.toLowerCase().trim() || "";
                const jobAlbum =
                    jobMeta?.albumTitle?.toLowerCase().trim() || "";

                const duplicateJobs = activeJobs.filter((j) => {
                    if (j.id === job!.id) return false;
                    const meta = j.metadata as any;
                    const candArtist =
                        meta?.artistName?.toLowerCase().trim() || "";
                    const candAlbum =
                        meta?.albumTitle?.toLowerCase().trim() || "";
                    return candArtist === jobArtist && candAlbum === jobAlbum;
                });

                if (duplicateJobs.length > 0) {
                    logger.debug(
                        `   Marking ${duplicateJobs.length} duplicate(s) complete`,
                    );
                    await tx.downloadJob.updateMany({
                        where: { id: { in: duplicateJobs.map((j) => j.id) } },
                        data: {
                            status: "completed",
                            completedAt: new Date(),
                            error: null,
                        },
                    });
                }

                // ═══════════════════════════════════════════════════════════════
                // STEP 4: Mark Primary Job Complete
                // ═══════════════════════════════════════════════════════════════
                // Keep this metadata RMW on tx so it commits with the transaction.
                await tx.downloadJob.update({
                    where: { id: job.id },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                        error: null,
                        metadata: {
                            ...jobMeta,
                            completedAt: new Date().toISOString(),
                        },
                    },
                });

                logger.debug(`   Job ${job.id} marked complete`);

                return {
                    jobId: job.id,
                    batchId: job.discoveryBatchId || undefined,
                    downloadBatchId: jobMeta?.batchId,
                    spotifyImportJobId: jobMeta?.spotifyImportJobId,
                    userId: job.userId,
                    subject: job.subject,
                    metadata: jobMeta,
                };
            },
            { logPrefix: "[COMPLETE-TX]" },
        );

        // Post-transaction operations (notifications, batch completion)
        if (result.jobId && result.userId) {
            await this.downloadJobEvents.emit("download.completed", {
                jobId: result.jobId,
                userId: result.userId,
                subject: result.subject,
                artistId: result.metadata?.artistId,
            });

            // Check batch completion
            if (result.batchId) {
                const { discoverWeeklyService } =
                    await import("./discoverWeekly");
                await discoverWeeklyService.checkBatchCompletion(
                    result.batchId,
                );
            }

            if (result.spotifyImportJobId) {
                const { spotifyImportService } =
                    await import("./spotifyImport");
                await spotifyImportService.checkImportCompletion(
                    result.spotifyImportJobId,
                );
            }
        }

        return {
            jobId: result.jobId,
            batchId: result.batchId,
            downloadBatchId: result.downloadBatchId,
            spotifyImportJobId: result.spotifyImportJobId,
        };
    }

    /**
     * Handle import failure - LET LIDARR HANDLE RELEASE ITERATION
     *
     * Strategy:
     * 1. Blocklist the failed release with skipRedownload=false (Lidarr searches for alternatives)
     * 2. Track the failure but DON'T limit retries - let Lidarr exhaust all releases
     * 3. Only intervene when Lidarr has NO more releases (detected via stale job timeout)
     * 4. At that point, try a different album from the same artist
     */
    async onImportFailed(
        downloadId: string,
        reason: string,
        albumMbid?: string,
    ): Promise<{ retried: boolean; failed: boolean; jobId?: string }> {
        logger.debug(`\n[RETRY] Import failed: ${downloadId}`);
        logger.debug(`   Reason: ${reason}`);

        const result = await this.withTransaction(
            async (tx) => {
                // ═══════════════════════════════════════════════════════════════
                // STEP 1: Find job and check for recent failure (DB-based dedup)
                // ═══════════════════════════════════════════════════════════════
                const job = await tx.downloadJob.findFirst({
                    where: {
                        OR: [
                            { lidarrRef: downloadId },
                            { targetMbid: albumMbid || undefined },
                        ],
                        status: "processing",
                    },
                });

                if (!job) {
                    logger.debug(`   No matching job found`);
                    return { retried: false, failed: false };
                }

                // Check for recent failure (deduplication)
                const metadata = (job.metadata as any) || {};
                const lastFailureAt = metadata.lastFailureAt;
                const FAILURE_DEDUP_WINDOW_MS = 30000; // 30 seconds

                if (lastFailureAt) {
                    const timeSinceLastFailure =
                        Date.now() - new Date(lastFailureAt).getTime();
                    if (timeSinceLastFailure < FAILURE_DEDUP_WINDOW_MS) {
                        logger.debug(
                            `   Duplicate failure (${Math.round(
                                timeSinceLastFailure / 1000,
                            )}s ago), skipping`,
                        );
                        return { retried: false, failed: false, jobId: job.id };
                    }
                }

                logger.debug(`   Found job: ${job.id}`);

                // ═══════════════════════════════════════════════════════════════
                // STEP 2: Update failure tracking
                // ═══════════════════════════════════════════════════════════════
                const failureCount = (metadata.failureCount || 0) + 1;
                const previousDownloadIds = metadata.previousDownloadIds || [];
                if (downloadId && !previousDownloadIds.includes(downloadId)) {
                    previousDownloadIds.push(downloadId);
                }

                // Update status text for retry attempts
                const lidarrAttempts = (metadata.lidarrAttempts || 1) + 1;
                const statusText = `Lidarr #${lidarrAttempts}`;

                // Keep this metadata RMW on tx so it commits with the transaction.
                await tx.downloadJob.update({
                    where: { id: job.id },
                    data: {
                        lidarrRef: null, // Clear for next grab
                        metadata: {
                            ...metadata,
                            failureCount,
                            lastError: reason,
                            lastFailureAt: new Date().toISOString(),
                            previousDownloadIds,
                            lidarrAttempts,
                            statusText,
                        },
                    },
                });

                logger.debug(`   Failure #${failureCount} recorded`);

                return { retried: true, failed: false, jobId: job.id };
            },
            { logPrefix: "[FAIL-TX]" },
        );

        // Blocklist cleanup happens outside transaction
        if (result.retried) {
            logger.debug(`   Blocklisting and letting Lidarr find alternative`);
            await this.removeFromLidarrQueue(downloadId);
        } else if (!result.jobId) {
            // No job found - still clean up Lidarr queue
            await this.removeFromLidarrQueue(downloadId);
        }

        return result;
    }

    /** Delegate same-artist fallback policy to its focused strategy. */
    private async tryNextAlbumFromArtist(
        job: any,
        reason: string,
    ): Promise<AlbumRetryResult> {
        return executeAlbumRetry(job, reason, {
            markJobExhausted: (retryJob, retryReason) =>
                this.markJobExhausted(retryJob, retryReason),
            startDownload: (...args) => this.startDownload(...args),
        });
    }
    /**
     * Mark a job as exhausted (all releases and same-artist albums tried)
     *
     * IMPORTANT: Before failing, check if another job for the same album already succeeded.
     * This handles race conditions where duplicates exist and one succeeds.
     */
    private async markJobExhausted(
        job: any,
        reason: string,
    ): Promise<{ retried: boolean; failed: boolean; jobId?: string }> {
        logger.debug(`[RETRY] Job fully exhausted: ${job.id}`);

        const meta = job.metadata as any;
        const artistName = meta?.artistName?.toLowerCase().trim() || "";
        const albumTitle = meta?.albumTitle?.toLowerCase().trim() || "";

        // Before marking as failed, check if another job for the same album already SUCCEEDED
        // This handles duplicate job scenarios
        if (artistName && albumTitle) {
            const completedDuplicate = await prisma.downloadJob.findFirst({
                where: {
                    id: { not: job.id },
                    status: "completed",
                },
            });

            if (completedDuplicate) {
                const dupMeta = completedDuplicate.metadata as any;
                const dupArtist =
                    dupMeta?.artistName?.toLowerCase().trim() || "";
                const dupAlbum =
                    dupMeta?.albumTitle?.toLowerCase().trim() || "";

                if (dupArtist === artistName && dupAlbum === albumTitle) {
                    logger.debug(
                        `   Found completed duplicate job ${completedDuplicate.id} - marking this as completed too`,
                    );
                    await patchDownloadJobMetadata(
                        job.id,
                        { mergedWithJob: completedDuplicate.id },
                        {
                            status: "completed",
                            completedAt: new Date(),
                            error: null,
                        },
                    );
                    return { retried: false, failed: false, jobId: job.id };
                }
            }
        }

        await failDownloadJob(
            job.id,
            `All releases and albums exhausted: ${reason}`,
        );

        // Check batch completion for discovery jobs
        if (job.discoveryBatchId) {
            const { discoverWeeklyService } = await import("./discoverWeekly");
            await discoverWeeklyService.checkBatchCompletion(
                job.discoveryBatchId,
            );
        }

        await this.downloadJobEvents.emit("download.exhausted", {
            jobId: job.id,
            userId: job.userId,
            subject: job.subject,
            reason,
        });

        return { retried: false, failed: true, jobId: job.id };
    }

    /** Preserve the cleanup worker's public seam. */
    async markStaleJobsAsFailed(
        existingSnapshot?: ReconciliationSnapshot,
    ): Promise<number> {
        return sweepStaleDownloadJobs(existingSnapshot, {
            events: this.downloadJobEvents,
            blocklistAndRetry: (downloadId) =>
                this.blocklistAndRetry(downloadId),
            tryNextAlbumFromArtist: (job, reason) =>
                this.tryNextAlbumFromArtist(job, reason),
        });
    }

    /**
     * Blocklist a failed release and let Lidarr search for alternatives
     * skipRedownload=false tells Lidarr to automatically search for another release
     */
    private async blocklistAndRetry(downloadId: string): Promise<void> {
        try {
            await lidarrService.blocklistAndRemove(downloadId, false);
        } catch (error: unknown) {
            logger.error(`   Blocklist/retry failed:`, toErrorMessage(error));
        }
    }

    /**
     * Remove a failed download from Lidarr's queue (without retrying)
     * Used when we don't have a tracking job but still need to clean up
     */
    private async removeFromLidarrQueue(downloadId: string) {
        try {
            await lidarrService.blocklistAndRemove(downloadId, false);
        } catch (error: unknown) {
            logger.error(
                `   Failed to remove from Lidarr queue:`,
                toErrorMessage(error),
            );
        }
    }

    /**
     * Clear failed/stuck Lidarr queue items and trigger new album searches.
     * The shared Lidarr client bounds DELETE concurrency.
     */
    async clearLidarrQueue(
        signal?: AbortSignal,
    ): Promise<{ removed: number; errors: string[] }> {
        return lidarrService.clearFailedQueue(signal);
    }

    /**
     * Get statistics about current downloads
     */
    async getStats(): Promise<{
        pending: number;
        processing: number;
        completed: number;
        failed: number;
    }> {
        const [pending, processing, completed, failed] = await Promise.all([
            prisma.downloadJob.count({ where: { status: "pending" } }),
            prisma.downloadJob.count({ where: { status: "processing" } }),
            prisma.downloadJob.count({ where: { status: "completed" } }),
            prisma.downloadJob.count({ where: { status: "failed" } }),
        ]);

        return { pending, processing, completed, failed };
    }

    /** Preserve the reconciliation worker's public seam. */
    async reconcileWithLidarr(
        existingSnapshot?: ReconciliationSnapshot,
    ): Promise<{
        reconciled: number;
        errors: string[];
        snapshot?: ReconciliationSnapshot;
    }> {
        return reconcileWithLidarr(existingSnapshot);
    }

    /** Preserve the queue-sync worker's public seam. */
    async syncWithLidarrQueue(
        existingSnapshot?: ReconciliationSnapshot,
    ): Promise<{ cancelled: number; errors: string[] }> {
        return syncWithLidarrQueue(existingSnapshot);
    }
}

const downloadJobEvents = new DownloadJobEvents();
registerDownloadJobNotificationSubscriber(downloadJobEvents);

// Singleton instance
export const simpleDownloadManager = new SimpleDownloadManager(
    downloadJobEvents,
);
