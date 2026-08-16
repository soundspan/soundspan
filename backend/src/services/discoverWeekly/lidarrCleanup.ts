import axios from "axios";
import { logger } from "../../utils/logger";
import { getSystemSettings } from "../../utils/systemSettings";
import { discoveryBatchLogger } from "../discovery";
import { lidarrService } from "../lidarr";
import { RecommendationStrategiesService } from "./recommendationStrategies";
import { discoverWeeklyPrisma } from "./state";

/** Owns Lidarr and download cleanup for Discover Weekly batches. */
export class LidarrCleanupService extends RecommendationStrategiesService {
    /**
     * Cleanup orphaned Lidarr queue items that belong to this discovery batch
     * but are no longer needed (download completed but album not in final playlist)
     */
    protected async cleanupOrphanedLidarrQueue(batchId: string): Promise<void> {
        logger.debug(`\n[CLEANUP] Checking for orphaned Lidarr queue items...`);

        try {
            const batch = await discoverWeeklyPrisma.discoveryBatch.findUnique({
                where: { id: batchId },
                include: { jobs: true },
            });

            if (!batch) return;

            const settings = await getSystemSettings();
            if (
                !settings?.lidarrEnabled ||
                !settings?.lidarrUrl ||
                !settings?.lidarrApiKey
            ) {
                return;
            }

            // Get all download IDs from our batch jobs
            const ourDownloadIds = new Set<string>();
            for (const job of batch.jobs) {
                if (job.lidarrRef) {
                    ourDownloadIds.add(job.lidarrRef);
                }
            }

            if (ourDownloadIds.size === 0) {
                logger.debug(`   No download IDs to check`);
                return;
            }

            // Get Lidarr queue
            const queueResponse = await axios.get(
                `${settings.lidarrUrl}/api/v1/queue`,
                {
                    params: { pageSize: 500 },
                    headers: { "X-Api-Key": settings.lidarrApiKey },
                    timeout: 30000,
                },
            );

            const queueItems = queueResponse.data?.records || [];
            let removed = 0;

            for (const item of queueItems) {
                const downloadId = item.downloadId;

                // Check if this is one of our downloads
                if (downloadId && ourDownloadIds.has(downloadId)) {
                    // Check if it's in a stuck state
                    const isStuck =
                        item.status === "warning" ||
                        item.status === "failed" ||
                        item.trackedDownloadState === "importFailed" ||
                        item.trackedDownloadState === "importBlocked";

                    if (isStuck) {
                        try {
                            await axios.delete(
                                `${settings.lidarrUrl}/api/v1/queue/${item.id}`,
                                {
                                    params: {
                                        removeFromClient: true,
                                        blocklist: true,
                                    },
                                    headers: {
                                        "X-Api-Key": settings.lidarrApiKey,
                                    },
                                    timeout: 10000,
                                },
                            );
                            logger.debug(
                                `   Removed orphaned queue item: ${item.title}`,
                            );
                            removed++;
                        } catch (e) {
                            // Ignore removal errors
                        }
                    }
                }
            }

            if (removed > 0) {
                logger.debug(`   Cleaned up ${removed} orphaned queue item(s)`);
            } else {
                logger.debug(`   No orphaned queue items found`);
            }
        } catch (error: any) {
            logger.error(
                `[CLEANUP] Error cleaning orphaned queue:`,
                error.message,
            );
        }
    }

    /**
     * Cleanup artists from Lidarr that failed during discovery
     * Only removes artists that:
     * - Had ALL their downloads fail in this batch
     * - Don't have any other music in the user's library
     *
     * NOTE: With tag-based tracking, we simply remove artists with the discovery tag
     * who don't have successful downloads. The tag is the source of truth.
     */
    protected async cleanupFailedArtists(batchId: string): Promise<void> {
        logger.debug(
            `\n[CLEANUP] Tag-based cleanup for failed discovery artists...`,
        );

        const batch = await discoverWeeklyPrisma.discoveryBatch.findUnique({
            where: { id: batchId },
            include: { jobs: true },
        });

        if (!batch) return;

        // Build set of artists with successful downloads in this batch
        const successfulArtistMbids = new Set<string>();
        for (const job of batch.jobs) {
            if (job.status === "completed") {
                const metadata = job.metadata as any;
                if (metadata?.artistMbid) {
                    successfulArtistMbids.add(metadata.artistMbid);
                }
            }
        }

        logger.debug(
            `   ${successfulArtistMbids.size} artists had successful downloads`,
        );

        // Get all artists with the discovery tag
        const discoveryArtists = await lidarrService.getDiscoveryArtists();
        logger.debug(
            `   ${discoveryArtists.length} artists in Lidarr have discovery tag`,
        );

        let removed = 0;
        let kept = 0;

        for (const lidarrArtist of discoveryArtists) {
            const artistMbid = lidarrArtist.foreignArtistId;
            const artistName = lidarrArtist.artistName;

            if (!artistMbid) continue;

            // Keep if artist had successful downloads in this batch
            if (successfulArtistMbids.has(artistMbid)) {
                kept++;
                continue;
            }

            // Keep if artist has liked/moved discovery albums
            const hasKept = await discoverWeeklyPrisma.discoveryAlbum.findFirst(
                {
                    where: {
                        artistMbid,
                        status: { in: ["LIKED", "MOVED"] },
                    },
                },
            );

            if (hasKept) {
                logger.debug(
                    `   Keeping ${artistName} - has liked albums (removing tag)`,
                );
                await lidarrService.removeDiscoveryTagByMbid(artistMbid);
                kept++;
                continue;
            }

            // Keep if artist has ACTIVE discovery albums from other weeks
            const hasActiveOther =
                await discoverWeeklyPrisma.discoveryAlbum.findFirst({
                    where: {
                        artistMbid,
                        status: "ACTIVE",
                        weekStartDate: { not: batch.weekStart },
                    },
                });

            if (hasActiveOther) {
                logger.debug(
                    `   Keeping ${artistName} - has active albums from other batches`,
                );
                kept++;
                continue;
            }

            // Artist has discovery tag, no successful downloads, no liked albums = remove
            try {
                const result = await lidarrService.deleteArtistById(
                    lidarrArtist.id,
                    true,
                );
                if (result.success) {
                    logger.debug(` Removed: ${artistName}`);
                    removed++;
                }
            } catch (error: any) {
                logger.error(
                    ` Failed to remove ${artistName}: ${error.message}`,
                );
            }
        }

        logger.debug(`   Cleanup complete: ${removed} removed, ${kept} kept`);
        await discoveryBatchLogger.info(
            batchId,
            `Lidarr cleanup: ${removed} failed artists removed`,
        );
    }

    /**
     * Cleanup extra albums that won't be in the final playlist
     * Called when we have more successful downloads than needed
     */
    private async cleanupExtraAlbums(
        extraJobs: any[],
        userId: string,
    ): Promise<void> {
        logger.debug(
            `\n[CLEANUP] Removing ${extraJobs.length} extra albums from Lidarr and filesystem...`,
        );

        // Track artists to potentially remove (if they have no other albums)
        const artistsToCheck = new Set<string>();
        let albumsRemoved = 0;
        let errors = 0;

        for (const job of extraJobs) {
            const metadata = job.metadata as any;
            const albumMbid = job.targetMbid;
            const artistMbid = metadata?.artistMbid;
            const albumTitle = metadata?.albumTitle || "Unknown";
            const artistName = metadata?.artistName || "Unknown";

            try {
                // Get Lidarr album ID if we have it
                if (job.lidarrAlbumId) {
                    // Delete the album from Lidarr (with files)
                    const result = await lidarrService.deleteAlbum(
                        job.lidarrAlbumId,
                        true,
                    );
                    if (result.success) {
                        logger.debug(
                            `   ✓ Removed: ${artistName} - ${albumTitle}`,
                        );
                        albumsRemoved++;

                        // Track artist for potential cleanup
                        if (artistMbid) {
                            artistsToCheck.add(artistMbid);
                        }
                    } else {
                        logger.debug(
                            `   - Skip: ${artistName} - ${albumTitle} (${result.message})`,
                        );
                    }
                } else {
                    logger.debug(
                        `   - Skip: ${artistName} - ${albumTitle} (no Lidarr ID)`,
                    );
                }

                // Mark the job as cancelled (not used in playlist)
                await discoverWeeklyPrisma.downloadJob.update({
                    where: { id: job.id },
                    data: {
                        status: "cancelled",
                        error: "Extra album - not needed for playlist",
                        completedAt: new Date(),
                    },
                });
            } catch (error: any) {
                logger.error(
                    `   ✗ Error: ${artistName} - ${albumTitle}: ${error.message}`,
                );
                errors++;
            }
        }

        // Check if any artists now have no albums and should be removed
        for (const artistMbid of artistsToCheck) {
            try {
                // Check if artist has any remaining albums in Lidarr
                const albums = await lidarrService.getArtistAlbums(artistMbid);

                // Check if artist has native library content (real user library)
                const hasNativeOwnedAlbums =
                    await discoverWeeklyPrisma.ownedAlbum.findFirst({
                        where: {
                            artist: { mbid: artistMbid },
                            source: "native_scan",
                        },
                    });

                if (!albums || (albums.length === 0 && !hasNativeOwnedAlbums)) {
                    // No albums left, remove artist
                    const result = await lidarrService.deleteArtist(
                        artistMbid,
                        true,
                    );
                    if (result.success) {
                        logger.debug(` Removed empty artist: ${artistMbid}`);
                    }
                }
            } catch (error) {
                // Ignore errors when checking/removing artists
            }
        }

        logger.debug(
            `   Extra album cleanup: ${albumsRemoved} removed, ${errors} errors`,
        );
    }
}
