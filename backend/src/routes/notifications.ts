import { Router, Request, Response } from "express";
import { logger } from "../utils/logger";
import { notificationService } from "../services/notificationService";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";

const router = Router();

/**
 * @openapi
 * /api/notifications:
 *   get:
 *     summary: Get all uncleared notifications
 *     description: Returns all uncleared notifications for the current user
 *     tags: [Notifications]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of notifications
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *       401:
 *         description: Not authenticated
 */
router.get(
    "/",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            logger.debug(
                `[Notifications] Fetching notifications for user ${
                    req.user!.id
                }`
            );
            const notifications = await notificationService.getForUser(
                req.user!.id
            );
            logger.debug(
                `[Notifications] Found ${notifications.length} notifications`
            );
            res.json(notifications);
        } catch (error: any) {
            logger.error("Error fetching notifications:", error);
            res.status(500).json({ error: "Failed to fetch notifications" });
        }
    }
);

/**
 * @openapi
 * /api/notifications/unread-count:
 *   get:
 *     summary: Get unread notification count
 *     description: Returns the count of unread notifications for the current user
 *     tags: [Notifications]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Unread count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count:
 *                   type: integer
 *       401:
 *         description: Not authenticated
 */
router.get(
    "/unread-count",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const count = await notificationService.getUnreadCount(
                req.user!.id
            );
            res.json({ count });
        } catch (error: any) {
            logger.error("Error fetching unread count:", error);
            res.status(500).json({ error: "Failed to fetch unread count" });
        }
    }
);

/**
 * @openapi
 * /api/notifications/{id}/read:
 *   post:
 *     summary: Mark a notification as read
 *     tags: [Notifications]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Notification ID
 *     responses:
 *       200:
 *         description: Notification marked as read
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       401:
 *         description: Not authenticated
 */
router.post(
    "/:id/read",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            await notificationService.markAsRead(req.params.id, req.user!.id);
            res.json({ success: true });
        } catch (error: any) {
            logger.error("Error marking notification as read:", error);
            res.status(500).json({
                error: "Failed to mark notification as read",
            });
        }
    }
);

/**
 * @openapi
 * /api/notifications/read-all:
 *   post:
 *     summary: Mark all notifications as read
 *     tags: [Notifications]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: All notifications marked as read
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       401:
 *         description: Not authenticated
 */
router.post(
    "/read-all",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            await notificationService.markAllAsRead(req.user!.id);
            res.json({ success: true });
        } catch (error: any) {
            logger.error("Error marking all notifications as read:", error);
            res.status(500).json({
                error: "Failed to mark all notifications as read",
            });
        }
    }
);

/**
 * @openapi
 * /api/notifications/{id}/clear:
 *   post:
 *     summary: Clear a notification
 *     description: Dismiss a single notification by ID
 *     tags: [Notifications]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Notification ID
 *     responses:
 *       200:
 *         description: Notification cleared
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       401:
 *         description: Not authenticated
 */
router.post(
    "/:id/clear",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            await notificationService.clear(req.params.id, req.user!.id);
            res.json({ success: true });
        } catch (error: any) {
            logger.error("Error clearing notification:", error);
            res.status(500).json({ error: "Failed to clear notification" });
        }
    }
);

/**
 * @openapi
 * /api/notifications/clear-all:
 *   post:
 *     summary: Clear all notifications
 *     description: Dismiss all notifications for the current user
 *     tags: [Notifications]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: All notifications cleared
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       401:
 *         description: Not authenticated
 */
router.post(
    "/clear-all",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            await notificationService.clearAll(req.user!.id);
            res.json({ success: true });
        } catch (error: any) {
            logger.error("Error clearing all notifications:", error);
            res.status(500).json({
                error: "Failed to clear all notifications",
            });
        }
    }
);

/**
 * @openapi
 * /api/notifications/downloads/history:
 *   get:
 *     summary: Get download history
 *     description: Returns completed/failed downloads that haven't been cleared, deduplicated by album subject (most recent entry per album). Limited to 50 results.
 *     tags: [Notifications]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of completed/failed download jobs
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *       401:
 *         description: Not authenticated
 */
router.get(
    "/downloads/history",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const downloads = await prisma.downloadJob.findMany({
                where: {
                    userId: req.user!.id,
                    status: { in: ["completed", "failed", "exhausted"] },
                    cleared: false,
                },
                orderBy: { updatedAt: "desc" },
                take: 100, // Fetch more to account for duplicates
            });

            // Deduplicate by subject - keep only the most recent entry per album
            const seen = new Set<string>();
            const deduplicated = downloads.filter((download) => {
                if (seen.has(download.subject)) {
                    return false; // Skip duplicate
                }
                seen.add(download.subject);
                return true; // Keep first occurrence (most recent due to ordering)
            });

            // Return top 50 after deduplication
            res.json(deduplicated.slice(0, 50));
        } catch (error: any) {
            logger.error("Error fetching download history:", error);
            res.status(500).json({ error: "Failed to fetch download history" });
        }
    }
);

/**
 * @openapi
 * /api/notifications/downloads/active:
 *   get:
 *     summary: Get active downloads
 *     description: Returns downloads that are currently pending or processing
 *     tags: [Notifications]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of active download jobs
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *       401:
 *         description: Not authenticated
 */
router.get(
    "/downloads/active",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const downloads = await prisma.downloadJob.findMany({
                where: {
                    userId: req.user!.id,
                    status: { in: ["pending", "processing"] },
                },
                orderBy: { createdAt: "desc" },
            });
            res.json(downloads);
        } catch (error: any) {
            logger.error("Error fetching active downloads:", error);
            res.status(500).json({ error: "Failed to fetch active downloads" });
        }
    }
);

/**
 * @openapi
 * /api/notifications/downloads/{id}/clear:
 *   post:
 *     summary: Clear a download from history
 *     description: Marks a specific download job as cleared so it no longer appears in history
 *     tags: [Notifications]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Download job ID
 *     responses:
 *       200:
 *         description: Download cleared
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       401:
 *         description: Not authenticated
 */
router.post(
    "/downloads/:id/clear",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            await prisma.downloadJob.updateMany({
                where: {
                    id: req.params.id,
                    userId: req.user!.id,
                },
                data: { cleared: true },
            });
            res.json({ success: true });
        } catch (error: any) {
            logger.error("Error clearing download:", error);
            res.status(500).json({ error: "Failed to clear download" });
        }
    }
);

/**
 * @openapi
 * /api/notifications/downloads/clear-all:
 *   post:
 *     summary: Clear all downloads from history
 *     description: Marks all completed/failed/exhausted download jobs as cleared
 *     tags: [Notifications]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: All downloads cleared
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       401:
 *         description: Not authenticated
 */
router.post(
    "/downloads/clear-all",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            await prisma.downloadJob.updateMany({
                where: {
                    userId: req.user!.id,
                    status: { in: ["completed", "failed", "exhausted"] },
                    cleared: false,
                },
                data: { cleared: true },
            });
            res.json({ success: true });
        } catch (error: any) {
            logger.error("Error clearing all downloads:", error);
            res.status(500).json({ error: "Failed to clear all downloads" });
        }
    }
);

/**
 * @openapi
 * /api/notifications/downloads/{id}/retry:
 *   post:
 *     summary: Retry a failed download
 *     description: Retries a failed or exhausted download job. Supports pending-track-retry (Soulseek), spotify_import (Soulseek then Lidarr fallback), and generic album retry via Lidarr.
 *     tags: [Notifications]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Download job ID to retry
 *     responses:
 *       200:
 *         description: Retry initiated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 newJobId:
 *                   type: string
 *                   description: ID of the new download job created for the retry
 *                 error:
 *                   type: string
 *                   nullable: true
 *       400:
 *         description: Cannot retry - missing required metadata
 *       404:
 *         description: Download not found or not in failed state
 *       401:
 *         description: Not authenticated
 */
router.post(
    "/downloads/:id/retry",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            // Get the failed download
            const failedJob = await prisma.downloadJob.findFirst({
                where: {
                    id: req.params.id,
                    userId: req.user!.id,
                    status: { in: ["failed", "exhausted"] },
                },
            });

            if (!failedJob) {
                return res
                    .status(404)
                    .json({ error: "Download not found or not failed" });
            }

            // If this was a pending-track retry job, re-run the pending-track retry flow
            const metadata = failedJob.metadata as Record<
                string,
                unknown
            > | null;
            if (metadata?.downloadType === "pending-track-retry") {
                const playlistId = metadata.playlistId as string | undefined;
                const pendingTrackId = metadata.pendingTrackId as
                    | string
                    | undefined;

                if (!playlistId || !pendingTrackId) {
                    return res.status(400).json({
                        error: "Cannot retry: missing playlistId or pendingTrackId",
                    });
                }

                // Mark old job as cleared
                await prisma.downloadJob.update({
                    where: { id: failedJob.id },
                    data: { cleared: true },
                });

                // Validate playlist ownership and pending track exists
                const playlist = await prisma.playlist.findUnique({
                    where: { id: playlistId },
                });
                if (!playlist || playlist.userId !== req.user!.id) {
                    return res
                        .status(404)
                        .json({ error: "Playlist not found" });
                }

                const pendingTrack =
                    await prisma.playlistPendingTrack.findUnique({
                        where: { id: pendingTrackId },
                    });
                if (!pendingTrack) {
                    return res
                        .status(404)
                        .json({ error: "Pending track not found" });
                }

                const retryTargetId =
                    pendingTrack.albumMbid ||
                    pendingTrack.artistMbid ||
                    `pendingTrack:${pendingTrack.id}`;

                const newJobRecord = await prisma.downloadJob.create({
                    data: {
                        userId: req.user!.id,
                        subject: `${pendingTrack.spotifyArtist} - ${pendingTrack.spotifyTitle}`,
                        type: "track",
                        targetMbid: retryTargetId,
                        artistMbid: pendingTrack.artistMbid,
                        status: "processing",
                        attempts: 1,
                        startedAt: new Date(),
                        metadata: {
                            downloadType: "pending-track-retry",
                            source: "soulseek",
                            playlistId,
                            pendingTrackId,
                            spotifyArtist: pendingTrack.spotifyArtist,
                            spotifyTitle: pendingTrack.spotifyTitle,
                            spotifyAlbum: pendingTrack.spotifyAlbum,
                            albumMbid: pendingTrack.albumMbid,
                        },
                    },
                });

                const { soulseekService } = await import(
                    "../services/soulseek"
                );
                const { getSystemSettings } = await import(
                    "../utils/systemSettings"
                );

                const settings = await getSystemSettings();
                if (!settings?.musicPath) {
                    await prisma.downloadJob.update({
                        where: { id: newJobRecord.id },
                        data: {
                            status: "failed",
                            error: "Music path not configured",
                            completedAt: new Date(),
                        },
                    });
                    return res.json({
                        success: false,
                        newJobId: newJobRecord.id,
                        error: "Music path not configured",
                    });
                }

                if (
                    !settings?.soulseekUsername ||
                    !settings?.soulseekPassword
                ) {
                    await prisma.downloadJob.update({
                        where: { id: newJobRecord.id },
                        data: {
                            status: "failed",
                            error: "Soulseek credentials not configured",
                            completedAt: new Date(),
                        },
                    });
                    return res.json({
                        success: false,
                        newJobId: newJobRecord.id,
                        error: "Soulseek credentials not configured",
                    });
                }

                const albumName =
                    pendingTrack.spotifyAlbum !== "Unknown Album"
                        ? pendingTrack.spotifyAlbum
                        : pendingTrack.spotifyArtist;

                const searchResult = await soulseekService.searchTrack(
                    pendingTrack.spotifyArtist,
                    pendingTrack.spotifyTitle
                );

                if (
                    !searchResult.found ||
                    searchResult.allMatches.length === 0
                ) {
                    await prisma.downloadJob.update({
                        where: { id: newJobRecord.id },
                        data: {
                            status: "failed",
                            error: "No matching files found",
                            completedAt: new Date(),
                        },
                    });
                    return res.json({
                        success: false,
                        newJobId: newJobRecord.id,
                        error: "No matching files found",
                    });
                }

                // Start download in background (don't await)
                soulseekService
                    .downloadBestMatch(
                        pendingTrack.spotifyArtist,
                        pendingTrack.spotifyTitle,
                        albumName,
                        searchResult.allMatches,
                        settings.musicPath
                    )
                    .then(async (result) => {
                        if (result.success) {
                            await prisma.downloadJob.update({
                                where: { id: newJobRecord.id },
                                data: {
                                    status: "completed",
                                    completedAt: new Date(),
                                    metadata: {
                                        ...(newJobRecord.metadata as any),
                                        filePath: result.filePath,
                                    },
                                },
                            });

                            try {
                                const { scanQueue } = await import(
                                    "../workers/queues"
                                );
                                await scanQueue.add(
                                    "scan",
                                    {
                                        userId: req.user!.id,
                                        source: "retry-pending-track",
                                        albumMbid:
                                            pendingTrack.albumMbid || undefined,
                                        artistMbid:
                                            pendingTrack.artistMbid ||
                                            undefined,
                                    },
                                    {
                                        priority: 1,
                                        removeOnComplete: true,
                                    }
                                );
                            } catch {
                                // Best-effort; job status already reflects download
                            }
                        } else {
                            await prisma.downloadJob.update({
                                where: { id: newJobRecord.id },
                                data: {
                                    status: "failed",
                                    error: result.error || "Download failed",
                                    completedAt: new Date(),
                                },
                            });
                        }
                    })
                    .catch(async (error) => {
                        await prisma.downloadJob.update({
                            where: { id: newJobRecord.id },
                            data: {
                                status: "failed",
                                error: error?.message || "Download exception",
                                completedAt: new Date(),
                            },
                        });
                    });

                return res.json({ success: true, newJobId: newJobRecord.id });
            }

            // If this was a spotify_import job, retry with Soulseek first
            if (metadata?.downloadType === "spotify_import") {
                const artistName = metadata.artistName as string;
                const albumTitle = metadata.albumTitle as string;

                if (!artistName || !albumTitle) {
                    return res.status(400).json({
                        error: "Cannot retry: missing artist/album info",
                    });
                }

                // Mark old job as cleared
                await prisma.downloadJob.update({
                    where: { id: failedJob.id },
                    data: { cleared: true },
                });

                // Create a NEW download job record for the retry
                const newJobRecord = await prisma.downloadJob.create({
                    data: {
                        userId: req.user!.id,
                        type: "album",
                        targetMbid:
                            failedJob.targetMbid || `retry_${Date.now()}`,
                        artistMbid: failedJob.artistMbid,
                        subject: `${artistName} - ${albumTitle}`,
                        status: "processing",
                        attempts: 1,
                        startedAt: new Date(),
                        metadata: {
                            ...metadata,
                            retryAttempt: true,
                        },
                    },
                });

                // Try Soulseek first (async)
                const { soulseekService } = await import(
                    "../services/soulseek"
                );
                const { getSystemSettings } = await import(
                    "../utils/systemSettings"
                );

                const settings = await getSystemSettings();
                const musicPath = settings?.musicPath;

                if (!musicPath) {
                    await prisma.downloadJob.update({
                        where: { id: newJobRecord.id },
                        data: {
                            status: "failed",
                            error: "Music path not configured",
                            completedAt: new Date(),
                        },
                    });
                    return res.json({
                        success: false,
                        newJobId: newJobRecord.id,
                        error: "Music path not configured",
                    });
                }

                // Build track from album info (single track search using album as title)
                const tracks = [
                    {
                        artist: artistName,
                        title: albumTitle,
                        album: albumTitle,
                    },
                ];

                logger.debug(
                    `[Retry] Trying Soulseek for ${artistName} - ${albumTitle}`
                );

                // Run Soulseek search async
                soulseekService
                    .searchAndDownloadBatch(tracks, musicPath, settings?.soulseekConcurrentDownloads || 4)
                    .then(async (result) => {
                        if (result.successful > 0) {
                            await prisma.downloadJob.update({
                                where: { id: newJobRecord.id },
                                data: {
                                    status: "completed",
                                    completedAt: new Date(),
                                    error: null,
                                    metadata: {
                                        ...metadata,
                                        source: "soulseek",
                                        tracksDownloaded: result.successful,
                                        files: result.files,
                                    },
                                },
                            });
                            logger.debug(
                                `[Retry] ✓ Soulseek downloaded ${result.successful} tracks for ${artistName} - ${albumTitle}`
                            );

                            // Trigger library scan
                            const { scanQueue } = await import(
                                "../workers/queues"
                            );
                            await scanQueue.add("scan", {
                                paths: [],
                                fullScan: false,
                                userId: req.user!.id,
                                source: "retry-spotify-import",
                            });
                        } else {
                            // Soulseek failed, try Lidarr if we have an MBID
                            logger.debug(
                                `[Retry] Soulseek failed, trying Lidarr for ${artistName} - ${albumTitle}`
                            );

                            if (
                                failedJob.targetMbid &&
                                !failedJob.targetMbid.startsWith("retry_")
                            ) {
                                const { simpleDownloadManager } = await import(
                                    "../services/simpleDownloadManager"
                                );
                                const lidarrResult =
                                    await simpleDownloadManager.startDownload(
                                        newJobRecord.id,
                                        artistName,
                                        albumTitle,
                                        failedJob.targetMbid,
                                        req.user!.id,
                                        false
                                    );

                                if (!lidarrResult.success) {
                                    await prisma.downloadJob.update({
                                        where: { id: newJobRecord.id },
                                        data: {
                                            status: "failed",
                                            error:
                                                lidarrResult.error ||
                                                "Both Soulseek and Lidarr failed",
                                            completedAt: new Date(),
                                        },
                                    });
                                }
                            } else {
                                await prisma.downloadJob.update({
                                    where: { id: newJobRecord.id },
                                    data: {
                                        status: "failed",
                                        error: "No tracks found on Soulseek, no MBID for Lidarr fallback",
                                        completedAt: new Date(),
                                    },
                                });
                            }
                        }
                    })
                    .catch(async (error) => {
                        logger.error(`[Retry] Soulseek error:`, error);
                        await prisma.downloadJob.update({
                            where: { id: newJobRecord.id },
                            data: {
                                status: "failed",
                                error: error?.message || "Soulseek error",
                                completedAt: new Date(),
                            },
                        });
                    });

                return res.json({ success: true, newJobId: newJobRecord.id });
            }

            // Validate that we have the required MBIDs
            if (!failedJob.targetMbid) {
                return res
                    .status(400)
                    .json({ error: "Cannot retry: missing album MBID" });
            }

            // Mark old job as cleared
            await prisma.downloadJob.update({
                where: { id: failedJob.id },
                data: { cleared: true },
            });

            // Extract parameters from the failed job
            // Subject is typically "Artist - Album" format
            const subjectParts = failedJob.subject.split(" - ");
            const artistName = subjectParts[0] || failedJob.subject;
            const albumTitle =
                (metadata?.albumTitle as string) ||
                subjectParts[1] ||
                failedJob.subject;

            // Create a NEW download job record for the retry
            const newJobRecord = await prisma.downloadJob.create({
                data: {
                    userId: req.user!.id,
                    type: failedJob.type as "artist" | "album",
                    targetMbid: failedJob.targetMbid,
                    artistMbid: failedJob.artistMbid,
                    subject: failedJob.subject,
                    status: "pending",
                    metadata: (metadata || {}) as any,
                },
            });

            // Import the download manager dynamically to avoid circular deps
            const { simpleDownloadManager } = await import(
                "../services/simpleDownloadManager"
            );

            // Start download with the correct positional arguments
            // startDownload(jobId, artistName, albumTitle, albumMbid, userId, isDiscovery)
            const result = await simpleDownloadManager.startDownload(
                newJobRecord.id,
                artistName,
                albumTitle,
                failedJob.targetMbid,
                req.user!.id,
                false // isDiscovery
            );

            res.json({
                success: result.success,
                newJobId: newJobRecord.id,
                error: result.error,
            });
        } catch (error: any) {
            logger.error("Error retrying download:", error);
            res.status(500).json({ error: "Failed to retry download" });
        }
    }
);

export default router;
