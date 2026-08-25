import { Job } from "bull";
import { logger } from "../../utils/logger";
import { MusicScannerService } from "../../services/musicScanner";
import { config } from "../../config";
import { ACTIVE_DOWNLOAD_JOB_STATUSES } from "../../services/downloadJobStatus";
import { reconcileDownloadJobsWithScan } from "./scanReconcileQuery";
import * as path from "path";

const log = logger.child("ScanProcessor");

export interface ScanJobData {
    userId: string | null;
    musicPath?: string; // Optional: use custom path or default from config
    albumMbid?: string; // Optional: if scan triggered by download completion
    artistMbid?: string; // Optional: if scan triggered by download completion
    source?: string; // Optional: source of scan (e.g., "lidarr-webhook", "discover-weekly-completion", "spotify-import")
    downloadId?: string; // Optional: Lidarr download ID for precise job linking
    discoveryBatchId?: string; // Optional: Discovery Weekly batch ID
    spotifyImportJobId?: string; // Optional: Spotify Import job ID
}

export interface ScanJobResult {
    tracksAdded: number;
    tracksUpdated: number;
    tracksRemoved: number;
    errors: Array<{ file: string; error: string }>;
    duration: number;
}

/**
 * Executes processScan.
 */
export async function processScan(
    job: Job<ScanJobData>,
): Promise<ScanJobResult> {
    const jobLog = log.child(`Job ${job.id}`);
    const {
        userId,
        musicPath,
        albumMbid,
        artistMbid,
        source,
        downloadId,
        discoveryBatchId,
        spotifyImportJobId,
    } = job.data;

    jobLog.debug(`\n═══════════════════════════════════════════════`);
    jobLog.debug(`Starting library scan for user ${userId}`);
    if (source) {
        jobLog.debug(`Scan source: ${source}`);
    }
    if (albumMbid) {
        jobLog.debug(`Album MBID: ${albumMbid}`);
    }
    if (artistMbid) {
        jobLog.debug(`Artist MBID: ${artistMbid}`);
    }
    jobLog.debug(`═══════════════════════════════════════════════`);

    // Report progress
    await job.progress(0);

    // Prepare cover cache path (store alongside transcode cache)
    const coverCachePath = path.join(
        config.music.transcodeCachePath,
        "../covers",
    );

    // Create scanner with progress callback and cover cache path
    const scanner = new MusicScannerService((progress) => {
        // Calculate percentage (filesScanned / filesTotal * 100)
        const percent = Math.floor(
            (progress.filesScanned / progress.filesTotal) * 100,
        );
        job.progress(percent).catch((err) =>
            jobLog.error(`Failed to update job progress:`, err),
        );
    }, coverCachePath);

    // Use provided music path or fall back to config
    const scanPath = musicPath || config.music.musicPath;

    jobLog.debug(`Scanning path: ${scanPath}`);

    try {
        const result = await scanner.scanLibrary(scanPath);

        await job.progress(100);

        jobLog.debug(
            `Scan complete: +${result.tracksAdded} ~${result.tracksUpdated} -${result.tracksRemoved}`,
        );

        // If this scan was triggered by a download completion, mark download jobs as completed
        if (
            source?.startsWith("lidarr-") &&
            (albumMbid || artistMbid || downloadId)
        ) {
            jobLog.debug(
                `Marking download jobs as completed after successful scan`,
            );
            const { prisma } = await import("../../utils/db");

            if (artistMbid) {
                await prisma.downloadJob.updateMany({
                    where: {
                        targetMbid: artistMbid,
                        type: "artist",
                        status: { in: ACTIVE_DOWNLOAD_JOB_STATUSES },
                    },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                    },
                });
                jobLog.debug(
                    `Marked artist download as completed: ${artistMbid}`,
                );

                // Trigger enrichment for the newly imported artist
                try {
                    const artist = await prisma.artist.findUnique({
                        where: { mbid: artistMbid },
                    });
                    if (artist && artist.enrichmentStatus === "pending") {
                        jobLog.debug(
                            `Triggering enrichment for artist: ${artist.name}`,
                        );
                        const { enrichSimilarArtist } =
                            await import("../artistEnrichment");
                        // Run enrichment in background (don't await)
                        enrichSimilarArtist(artist).catch((err) => {
                            jobLog.error(
                                ` Enrichment failed for ${artist.name}:`,
                                err,
                            );
                        });
                    }
                } catch (error) {
                    jobLog.error(`  Failed to trigger enrichment:`, error);
                }
            }

            if (albumMbid) {
                const updatedByMbid = await prisma.downloadJob.updateMany({
                    where: {
                        targetMbid: albumMbid,
                        type: "album",
                        status: { in: ACTIVE_DOWNLOAD_JOB_STATUSES },
                    },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                    },
                });

                if (updatedByMbid.count > 0) {
                    jobLog.debug(
                        `Marked ${updatedByMbid.count} album download(s) as completed by MBID: ${albumMbid}`,
                    );
                } else {
                    // Fallback: Try to find the album by artist+title and match download jobs
                    jobLog.debug(
                        `No downloads matched by MBID, trying artist+title match...`,
                    );

                    const album = await prisma.album.findFirst({
                        where: { rgMbid: albumMbid },
                        include: { artist: true },
                    });

                    if (album) {
                        const updatedByName =
                            await prisma.downloadJob.updateMany({
                                where: {
                                    type: "album",
                                    status: {
                                        in: ACTIVE_DOWNLOAD_JOB_STATUSES,
                                    },
                                    metadata: {
                                        path: ["albumTitle"],
                                        equals: album.title,
                                    },
                                },
                                data: {
                                    status: "completed",
                                    completedAt: new Date(),
                                },
                            });

                        if (updatedByName.count > 0) {
                            jobLog.debug(
                                `Marked ${updatedByName.count} album download(s) as completed by title match: ${album.artist.name} - ${album.title}`,
                            );
                        } else {
                            jobLog.debug(
                                `  No pending downloads found for: ${album.artist.name} - ${album.title}`,
                            );
                        }
                    }
                }

                // Trigger enrichment for the artist of the newly imported album
                try {
                    const album = await prisma.album.findFirst({
                        where: { rgMbid: albumMbid },
                        include: { artist: true },
                    });
                    if (
                        album?.artist &&
                        album.artist.enrichmentStatus === "pending"
                    ) {
                        jobLog.debug(
                            `Triggering enrichment for artist: ${album.artist.name}`,
                        );
                        const { enrichSimilarArtist } =
                            await import("../artistEnrichment");
                        // Run enrichment in background (don't await)
                        enrichSimilarArtist(album.artist).catch((err) => {
                            jobLog.error(
                                ` Enrichment failed for ${album.artist.name}:`,
                                err,
                            );
                        });
                    }
                } catch (error) {
                    jobLog.error(`  Failed to trigger enrichment:`, error);
                }
            }

            if (downloadId) {
                const updated = await prisma.downloadJob.updateMany({
                    where: {
                        lidarrRef: downloadId,
                        status: { in: ACTIVE_DOWNLOAD_JOB_STATUSES },
                    },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                    },
                });
                if (updated.count > 0) {
                    jobLog.debug(
                        `Linked Lidarr download ${downloadId} to ${updated.count} job(s)`,
                    );
                } else {
                    jobLog.debug(
                        `  No download jobs found for Lidarr ID ${downloadId}`,
                    );
                }
            }
        }

        // If this scan was for Discovery Weekly, build the final playlist
        if (source === "discover-weekly-completion" && discoveryBatchId) {
            jobLog.debug(
                ` Building Discovery Weekly playlist for batch ${discoveryBatchId}...`,
            );
            try {
                const { discoverWeeklyService } =
                    await import("../../services/discoverWeekly");
                await discoverWeeklyService.buildFinalPlaylist(
                    discoveryBatchId,
                );
                jobLog.debug(`Discovery Weekly playlist complete!`);
            } catch (error: any) {
                jobLog.error(
                    ` Failed to build Discovery playlist:`,
                    error.message,
                );
            }
        }

        // If this scan was for Spotify Import, build the final playlist
        if (source === "spotify-import" && spotifyImportJobId) {
            jobLog.debug(
                ` Building Spotify Import playlist for job ${spotifyImportJobId}...`,
            );
            try {
                const { spotifyImportService } =
                    await import("../../services/spotifyImport");
                await spotifyImportService.buildPlaylistAfterScan(
                    spotifyImportJobId,
                );
                jobLog.debug(`Spotify Import playlist complete!`);
            } catch (error: any) {
                jobLog.error(
                    ` Failed to build Spotify Import playlist:`,
                    error.message,
                );
            }
        }

        // Phase 2 Fix for #31: Reconcile download jobs with newly scanned albums
        // This runs after EVERY scan to catch albums that were downloaded but webhooks failed
        if (result.tracksAdded > 0) {
            jobLog.debug(
                `Reconciling download jobs with ${result.tracksAdded} newly scanned tracks...`,
            );
            try {
                const reconciledJobs = await reconcileDownloadJobsWithScan();
                if (reconciledJobs > 0) {
                    jobLog.debug(
                        `✓ Reconciled ${reconciledJobs} download job(s) with scanned albums`,
                    );
                }
            } catch (error: any) {
                jobLog.error(
                    `Failed to reconcile download jobs:`,
                    error.message,
                );
            }
        }

        // Send notification for manual scans (not background/webhook scans)
        if (!source && userId && userId !== "system") {
            try {
                const { notificationService } =
                    await import("../../services/notificationService");
                await notificationService.notifySystem(
                    userId,
                    "Library Scan Complete",
                    `Added ${result.tracksAdded} tracks, updated ${result.tracksUpdated}, removed ${result.tracksRemoved}`,
                );
            } catch (error) {
                jobLog.error(`Failed to send notification:`, error);
            }
        }

        // Reconcile pending tracks from Spotify playlist imports
        // This checks if any previously unmatched tracks now have matches
        // Run on: new tracks added OR manual sync (no source = manual scan button)
        const shouldReconcile = result.tracksAdded > 0 || !source;
        if (shouldReconcile) {
            try {
                jobLog.debug(
                    `Checking for pending playlist tracks to reconcile...`,
                );
                const { spotifyImportService } =
                    await import("../../services/spotifyImport");
                const reconcileResult =
                    await spotifyImportService.reconcilePendingTracks();
                if (reconcileResult.tracksAdded > 0) {
                    jobLog.debug(
                        `✓ Reconciled ${reconcileResult.tracksAdded} pending tracks to ${reconcileResult.playlistsUpdated} playlists`,
                    );

                    // Send notification about reconciled tracks
                    if (userId && userId !== "system") {
                        try {
                            const { notificationService } =
                                await import("../../services/notificationService");
                            await notificationService.notifySystem(
                                userId,
                                "Playlist Tracks Matched",
                                `${reconcileResult.tracksAdded} previously unmatched tracks were added to your playlists`,
                            );
                        } catch (notifyError) {
                            jobLog.error(
                                `Failed to send reconcile notification:`,
                                notifyError,
                            );
                        }
                    }
                } else {
                    jobLog.debug(`No pending tracks to reconcile`);
                }
            } catch (error) {
                jobLog.error(`Failed to reconcile pending tracks:`, error);
            }
        }

        // Reconcile Discovery Weekly tracks
        // This backfills Discovery Weekly playlists with albums that downloaded after initial playlist creation
        // Run on: new tracks added OR manual sync (no source = manual scan button)
        if (shouldReconcile) {
            try {
                jobLog.debug(
                    `Checking for Discovery Weekly tracks to reconcile...`,
                );
                const { discoverWeeklyService } =
                    await import("../../services/discoverWeekly");
                const discoverResult =
                    await discoverWeeklyService.reconcileDiscoveryTracks();
                if (discoverResult.tracksAdded > 0) {
                    jobLog.info(
                        `Discovery Weekly reconciliation: ${discoverResult.tracksAdded} tracks added across ${discoverResult.batchesChecked} batches`,
                    );
                }
            } catch (error) {
                jobLog.error("Discovery Weekly reconciliation failed:", error);
            }
        }

        // Reconcile TrackMapping rows — link remote-only mappings to newly scanned local tracks
        if (shouldReconcile) {
            try {
                const { trackReconciliationService } =
                    await import("../../services/trackReconciliation");
                const mappingResult =
                    await trackReconciliationService.reconcile();
                if (mappingResult.linked > 0) {
                    jobLog.info(
                        `TrackMapping reconciliation: ${mappingResult.linked} remote mappings linked to local tracks`,
                    );
                }
            } catch (error) {
                jobLog.error(`TrackMapping reconciliation failed:`, error);
            }
        }

        // Trigger mood tag collection for new tracks whose artists are already enriched
        // This ensures Last.fm mood tags are collected immediately after scan, not waiting 30s for background worker
        if (result.tracksAdded > 0) {
            try {
                jobLog.debug(
                    `Checking for tracks needing mood tag enrichment...`,
                );
                const { prisma } = await import("../../utils/db");

                // Count new tracks that need mood tags
                // Note: We don't filter by artist enrichmentStatus here because
                // triggerEnrichmentNow() runs runEnrichmentCycle() which handles
                // artist enrichment first (Step 1), then track tags (Step 2)
                const tracksNeedingTags = await prisma.track.count({
                    where: {
                        OR: [
                            { lastfmTags: { isEmpty: true } },
                            { lastfmTags: { equals: null } },
                        ],
                    },
                });

                if (tracksNeedingTags > 0) {
                    jobLog.debug(
                        `Found ${tracksNeedingTags} tracks needing mood tags, triggering enrichment...`,
                    );

                    // Trigger immediate enrichment cycle (non-blocking)
                    const { triggerEnrichmentNow } =
                        await import("../unifiedEnrichment");
                    triggerEnrichmentNow()
                        .then((result) => {
                            if (result.tracks > 0) {
                                jobLog.debug(
                                    `Mood tag enrichment completed: ${result.tracks} tracks enriched`,
                                );
                            }
                        })
                        .catch((err) => {
                            jobLog.error(`Mood tag enrichment failed:`, err);
                        });
                } else {
                    jobLog.debug(
                        `No tracks need immediate mood tag enrichment`,
                    );
                }
            } catch (error) {
                jobLog.error(`Failed to check for mood tag enrichment:`, error);
            }
        }

        return result;
    } catch (error: any) {
        jobLog.error(`Scan failed:`, error);
        throw error;
    }
}
