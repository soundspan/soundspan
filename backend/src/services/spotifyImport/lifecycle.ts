import PQueue from "p-queue";
import { logger } from "../../utils/logger";
import { createPlaylistLogger } from "../../utils/playlistLogger";
import { getSystemSettings } from "../../utils/systemSettings";
import { acquisitionService } from "../acquisitionService";
import {
    getImportJob,
    jobLoggers,
    saveImportJob,
    spotifyImportPrisma,
} from "./state";
import type { AlbumToDownload, ImportJob, ImportPreview } from "./types";
import { SpotifyImportPlaylistBuilderService } from "./playlistBuilder";

export class SpotifyImportLifecycleService extends SpotifyImportPlaylistBuilderService {
    /**
     * Start an import job
     */
    async startImport(
        userId: string,
        spotifyPlaylistId: string,
        playlistName: string,
        albumMbidsToDownload: string[],
        preview: ImportPreview,
    ): Promise<ImportJob> {
        // Validate userId to prevent NaN/invalid values from entering the system
        if (
            !userId ||
            typeof userId !== "string" ||
            userId === "NaN" ||
            userId === "undefined" ||
            userId === "null"
        ) {
            logger?.error(
                `[Spotify Import] Invalid userId provided to startImport: ${JSON.stringify(
                    {
                        userId,
                        typeofUserId: typeof userId,
                        playlistName,
                    },
                )}`,
            );
            throw new Error(`Invalid userId provided: ${userId}`);
        }

        const jobId = `import_${Date.now()}_${Math.random()
            .toString(36)
            .substring(7)}`;

        // Create dedicated logger for this job
        const jobLogger = createPlaylistLogger(jobId);
        jobLoggers.set(jobId, jobLogger);

        jobLogger.logJobStart(playlistName, preview.summary.total, userId);
        jobLogger?.info(`Playlist ID: ${spotifyPlaylistId}`);
        jobLogger?.info(
            `Albums selected by client (ignored in resolution-only mode): ${albumMbidsToDownload.length}`,
        );
        jobLogger?.info(
            `Tracks already in library: ${preview.summary.inLibrary}`,
        );

        // Spotify import is now resolution-only. Keep route compatibility but do
        // not execute downloader/indexer acquisition from this flow.
        const effectiveAlbumSelections: string[] = [];

        // Extract the track info we need to match after downloads
        // Include ALL tracks, both matched and unmatched
        // IMPORTANT: Store pre-matched track IDs so we don't have to re-search them!
        // NOTE: `PlaylistPendingTrack.spotifyAlbum` should reflect Spotify's album name.
        // Only fall back to a resolved album name when Spotify returns "Unknown Album".
        const pendingTracks = preview.matchedTracks.map((m) => {
            const spotifyAlbum = m.spotifyTrack.album;
            const spotifyAlbumId = m.spotifyTrack.albumId;
            const spotifyArtist = m.spotifyTrack.artist;
            const spotifyTrackId = m.spotifyTrack.spotifyId;
            const trackTitle = m.spotifyTrack.title;

            // Check if album was resolved via MusicBrainz (albumId has mbid: prefix)
            const wasMbResolved = spotifyAlbumId?.startsWith("mbid:");
            const resolvedMbid = wasMbResolved
                ? spotifyAlbumId.replace("mbid:", "")
                : null;

            // Try to find album info using multiple strategies
            let albumToDownload: AlbumToDownload | undefined;

            // Strategy 1: Match by resolved MusicBrainz MBID (highest priority for pre-resolved)
            if (resolvedMbid) {
                albumToDownload = preview.albumsToDownload.find(
                    (a) => a.albumMbid === resolvedMbid,
                );
            }

            // Strategy 2: Match by Spotify album ID (for non-resolved tracks)
            if (!albumToDownload && spotifyAlbumId && !wasMbResolved) {
                albumToDownload = preview.albumsToDownload.find(
                    (a) => a.spotifyAlbumId === spotifyAlbumId,
                );
            }

            // Strategy 3: Find album that contains this specific track in tracksNeeded
            if (!albumToDownload) {
                albumToDownload = preview.albumsToDownload.find((a) =>
                    a.tracksNeeded.some(
                        (t) =>
                            t.spotifyId === spotifyTrackId ||
                            (t.title.toLowerCase() ===
                                trackTitle.toLowerCase() &&
                                t.artist.toLowerCase() ===
                                    spotifyArtist.toLowerCase()),
                    ),
                );
            }

            // Strategy 4: Match by artist + album name similarity (for edge cases)
            if (
                !albumToDownload &&
                spotifyArtist &&
                spotifyAlbum &&
                spotifyAlbum !== "Unknown Album"
            ) {
                const normalizedArtist = spotifyArtist.toLowerCase();
                const normalizedAlbum = spotifyAlbum.toLowerCase();
                albumToDownload = preview.albumsToDownload.find(
                    (a) =>
                        a.artistName.toLowerCase() === normalizedArtist &&
                        a.albumName
                            .toLowerCase()
                            .includes(normalizedAlbum.substring(0, 10)),
                );
            }

            // Use resolved album name for display (from track or from albumToDownload)
            const albumForDisplay =
                spotifyAlbum && spotifyAlbum !== "Unknown Album"
                    ? spotifyAlbum
                    : albumToDownload?.albumName || spotifyAlbum;

            // Get the actual MBID (either from pre-resolved or from albumToDownload)
            const actualAlbumMbid =
                resolvedMbid || albumToDownload?.albumMbid || null;

            return {
                artist: spotifyArtist,
                title: trackTitle,
                album: albumForDisplay,
                albumMbid: actualAlbumMbid,
                artistMbid: albumToDownload?.artistMbid || null,
                preMatchedTrackId: m.localTrack?.id || null,
            };
        });

        const job: ImportJob = {
            id: jobId,
            userId,
            spotifyPlaylistId,
            playlistName,
            status: "pending",
            progress: 0,
            albumsTotal: 0,
            albumsCompleted: 0,
            tracksMatched: preview.summary.inLibrary,
            tracksTotal: preview.summary.total,
            tracksDownloadable: 0,
            createdPlaylistId: null,
            error: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            pendingTracks,
        };

        // Save to database and memory cache
        await saveImportJob(job);

        // Start processing in background
        this.processImport(job, effectiveAlbumSelections, preview).catch(
            async (error) => {
                job.status = "failed";
                job.error = error.message;
                job.updatedAt = new Date();
                await saveImportJob(job);
                jobLogger?.logJobFailed(error.message);
                // Clean up job logger to prevent memory leak
                jobLoggers.delete(job.id);
            },
        );

        return job;
    }

    /**
     * Process the import (download albums, create playlist)
     * Now uses AcquisitionService for unified download handling
     */
    protected async processImport(
        job: ImportJob,
        albumMbidsToDownload: string[],
        preview: ImportPreview,
    ): Promise<void> {
        const logger = jobLoggers.get(job.id);

        try {
            // Phase 1: Download albums using AcquisitionService
            if (albumMbidsToDownload.length > 0) {
                job.status = "downloading";
                job.updatedAt = new Date();
                await saveImportJob(job);

                logger?.logAlbumDownloadStart(albumMbidsToDownload.length);

                logger?.debug(
                    `[Spotify Import] Processing ${albumMbidsToDownload.length} albums via AcquisitionService`,
                );
                logger?.info(
                    `Processing ${albumMbidsToDownload.length} albums via AcquisitionService`,
                );

                // Process albums in parallel with concurrency limit from settings
                const settings = await getSystemSettings();
                const albumQueue = new PQueue({
                    concurrency: settings?.soulseekConcurrentDownloads || 4,
                });

                const albumPromises = albumMbidsToDownload.map(
                    (albumIdentifier) =>
                        albumQueue.add(async () => {
                            // albumIdentifier can be either albumMbid or spotifyAlbumId (for Unknown Album)
                            const album = preview.albumsToDownload.find(
                                (a) =>
                                    a.albumMbid === albumIdentifier ||
                                    a.spotifyAlbumId === albumIdentifier,
                            );
                            if (!album) return;

                            try {
                                const isUnknownAlbum =
                                    album.albumName === "Unknown Album" ||
                                    !album.albumMbid;

                                logger?.info(
                                    `Album start: ${album.artistName} - ${
                                        album.albumName
                                    }${
                                        album.albumMbid
                                            ? ` [MBID: ${album.albumMbid}]`
                                            : " [Unknown Album]"
                                    } (tracksNeeded=${
                                        album.tracksNeeded.length
                                    })`,
                                );

                                logger?.debug(
                                    `[Spotify Import] Requesting: ${album.artistName} - ${album.albumName}`,
                                );

                                // Validate userId before creating acquisition context
                                if (
                                    !job.userId ||
                                    typeof job.userId !== "string" ||
                                    job.userId === "NaN" ||
                                    job.userId === "undefined" ||
                                    job.userId === "null"
                                ) {
                                    logger?.error(
                                        `[Spotify Import] Invalid userId in job: ${JSON.stringify(
                                            {
                                                jobId: job.id,
                                                userId: job.userId,
                                                typeofUserId: typeof job.userId,
                                            },
                                        )}`,
                                    );
                                    throw new Error(
                                        `Invalid userId in import job: ${job.userId}`,
                                    );
                                }

                                // Acquisition context for tracking
                                const context = {
                                    userId: job.userId,
                                    spotifyImportJobId: job.id,
                                };

                                let result;

                                if (isUnknownAlbum) {
                                    // Unknown Album: Use track-based acquisition
                                    logger?.debug(
                                        `[Spotify Import] Unknown Album detected - using track acquisition`,
                                    );

                                    const trackRequests =
                                        album.tracksNeeded.map((track) => ({
                                            trackTitle: track.title,
                                            artistName: track.artist,
                                            albumTitle: album.albumName,
                                        }));

                                    const trackResults =
                                        await acquisitionService.acquireTracks(
                                            trackRequests,
                                            context,
                                        );

                                    // Check if at least 50% succeeded
                                    const successCount = trackResults.filter(
                                        (r) => r.success,
                                    ).length;
                                    const successThreshold = Math.ceil(
                                        trackRequests.length * 0.5,
                                    );

                                    result = {
                                        success:
                                            successCount >= successThreshold,
                                        tracksDownloaded: successCount,
                                        tracksTotal: trackRequests.length,
                                    };

                                    if (result.success) {
                                        logger?.info(
                                            `Unknown Album tracks success: ${album.artistName} - ${successCount}/${trackRequests.length} tracks`,
                                        );
                                    }
                                } else {
                                    // Regular album: Use album-based acquisition
                                    result =
                                        await acquisitionService.acquireAlbum(
                                            {
                                                albumTitle: album.albumName,
                                                artistName: album.artistName,
                                                mbid: album.albumMbid!,
                                                requestedTracks:
                                                    album.tracksNeeded.map(
                                                        (t) => ({
                                                            title: t.title,
                                                        }),
                                                    ),
                                            },
                                            context,
                                        );

                                    if (result.success) {
                                        logger?.info(
                                            `Album acquisition success: ${album.artistName} - ${album.albumName} via ${result.source}`,
                                        );
                                    }
                                }

                                if (!result.success) {
                                    const errorMsg =
                                        result.error ||
                                        "No download sources available";
                                    logger?.debug(
                                        `[Spotify Import] ✗ Failed: ${album.albumName} - ${errorMsg}`,
                                    );
                                    logger?.logAlbumFailed(
                                        album.albumName,
                                        album.artistName,
                                        errorMsg,
                                    );
                                }

                                job.albumsCompleted++;
                                job.progress = Math.round(
                                    (job.albumsCompleted / job.albumsTotal) *
                                        30,
                                );
                                job.updatedAt = new Date();
                                await saveImportJob(job);

                                logger?.debug(
                                    `Album done: ${album.artistName} - ${
                                        album.albumName
                                    } (success=${
                                        result.success ? "yes" : "no"
                                    })`,
                                );
                            } catch (error: any) {
                                logger?.error(
                                    `[Spotify Import] Failed: ${album.artistName} - ${album.albumName}: ${error.message}`,
                                );
                                logger?.logAlbumFailed(
                                    album.albumName,
                                    album.artistName,
                                    error.message,
                                );
                            }
                        }),
                );

                // Wait for all album acquisitions to complete
                await Promise.all(albumPromises);

                logger?.info(
                    `Initial acquisition phase finished for ${albumMbidsToDownload.length} album(s). Checking completion state...`,
                );

                // Check if we can complete immediately
                await this.checkImportCompletion(job.id);

                // Re-fetch job state after checkImportCompletion may have updated it
                const updatedJob = await getImportJob(job.id);
                if (!updatedJob) {
                    logger?.error(
                        `[Spotify Import] Job ${job.id}: Job not found after completion check`,
                    );
                    return;
                }

                // If still downloading, wait for completion
                if (updatedJob.status === "downloading") {
                    logger?.debug(
                        `[Spotify Import] Job ${updatedJob.id}: Waiting for downloads to complete...`,
                    );
                    logger?.info(`Waiting for downloads to complete...`);
                }
                return;
            }

            // No downloads needed - all tracks already in library
            // Create playlist immediately
            await this.buildPlaylist(job);
        } catch (error: any) {
            job.status = "failed";
            job.error = error.message;
            job.updatedAt = new Date();
            throw error;
        }
    }

    /**
     * Check if all downloads for this import are complete (called by webhook handler)
     */
    async checkImportCompletion(importJobId: string): Promise<void> {
        logger?.debug(
            `\n[Spotify Import] Checking completion for job ${importJobId}...`,
        );

        const job = await getImportJob(importJobId);
        if (!job) {
            logger?.debug(`   Job not found`);
            jobLoggers.delete(importJobId);
            return;
        }

        const jobLogger = jobLoggers.get(importJobId);

        // Check download jobs for this import
        // NOTE: Jobs are created with auto-generated CUIDs, not prefixed IDs
        // The spotifyImportJobId is stored in metadata.spotifyImportJobId
        const downloadJobs = await spotifyImportPrisma.downloadJob.findMany({
            where: {
                metadata: {
                    path: ["spotifyImportJobId"],
                    equals: importJobId,
                },
            },
        });

        const total = downloadJobs.length;
        const completed = downloadJobs.filter(
            (j) => j.status === "completed",
        ).length;
        const failed = downloadJobs.filter((j) => j.status === "failed").length;
        const pending = total - completed - failed;

        if (total === 0 && job.albumsTotal > 0) {
            const message =
                "No download jobs were created for this import. This usually means the import preview did not include the selected albums.";
            logger?.debug(`   ${message}`);
            jobLogger?.warn(message);

            job.status = "failed";
            job.error = message;
            job.updatedAt = new Date();
            await saveImportJob(job);
            // Clean up job logger to prevent memory leak
            jobLoggers.delete(job.id);
            return;
        }

        logger?.debug(
            `   Download status: ${completed}/${total} completed, ${failed} failed, ${pending} pending`,
        );
        jobLogger?.logDownloadProgress(completed, failed, pending);

        // Update progress
        job.progress =
            total > 0
                ? 30 + Math.round((completed / total) * 40) // 30-70% for downloads
                : 30;
        job.updatedAt = new Date();

        if (pending > 0) {
            // Check how long we've been waiting for these downloads
            const oldestPending = downloadJobs
                .filter(
                    (j) => j.status === "pending" || j.status === "processing",
                )
                .sort(
                    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
                )[0];

            const waitTimeMs = oldestPending
                ? Date.now() - oldestPending.createdAt.getTime()
                : 0;
            const waitTimeMins = Math.round(waitTimeMs / 60000);

            // After 10 minutes of waiting, proceed anyway to avoid stuck jobs
            if (waitTimeMs < 600000) {
                // 10 minutes
                logger?.debug(
                    `   Still waiting for ${pending} downloads... (${waitTimeMins} min elapsed)`,
                );
                jobLogger?.info(
                    `Waiting for Soulseek downloads to complete...`,
                );
                await saveImportJob(job);
                return;
            }

            logger?.debug(
                `   Timeout: ${pending} downloads still pending after ${waitTimeMins} minutes, proceeding anyway`,
            );
            jobLogger?.warn(
                `Download timeout: ${pending} pending after ${waitTimeMins}m, proceeding with available tracks`,
            );

            // Mark stale pending jobs as failed
            await spotifyImportPrisma.downloadJob.updateMany({
                where: {
                    metadata: {
                        path: ["spotifyImportJobId"],
                        equals: importJobId,
                    },
                    status: { in: ACTIVE_DOWNLOAD_JOB_STATUSES },
                },
                data: {
                    status: "failed",
                    error: "Timed out waiting for download",
                    completedAt: new Date(),
                },
            });
        }

        // All downloads finished (completed or failed)
        logger?.debug(`   All downloads finished! Triggering library scan...`);
        jobLogger?.info(
            `All ${total} download jobs finished (${completed} completed, ${failed} failed)`,
        );

        // Trigger library scan to import the new files
        const { scanQueue } = await import("../../workers/queues");
        const scanJob = await scanQueue.add("scan", {
            userId: job.userId,
            source: "spotify-import",
            spotifyImportJobId: importJobId,
        });

        jobLogger?.info(
            `Queued library scan (bullJobId=${scanJob.id ?? "unknown"})`,
        );

        job.status = "scanning";
        job.progress = 75;
        job.updatedAt = new Date();
        await saveImportJob(job);
    }

    /**
     * Build playlist after library scan completes (called by scan worker)
     */
    async buildPlaylistAfterScan(importJobId: string): Promise<void> {
        logger?.debug(
            `\n[Spotify Import] Building playlist for job ${importJobId}...`,
        );

        const job = await getImportJob(importJobId);
        if (!job) {
            logger?.debug(`   Job not found`);
            jobLoggers.delete(importJobId);
            return;
        }

        await this.buildPlaylist(job);
    }
}
import { ACTIVE_DOWNLOAD_JOB_STATUSES } from "../downloadJobStatus";
