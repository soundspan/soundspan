import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAdmin, requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { parseBoundedInt } from "../utils/queryParams";
import { config } from "../config";
import { getSystemSettings } from "../utils/systemSettings";
import { lidarrService } from "../services/lidarr";
import { musicBrainzService } from "../services/musicbrainz";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { mapInteractiveRelease } from "../services/releaseContracts";
import { createAlbumDownloadJob } from "../services/albumDownloadJobs";
import {
    enqueueAlbumDownloadInBackground,
    enqueueArtistDownloadExpansionInBackground,
} from "../services/albumDownloadQueueService";
import { ALBUM_DOWNLOAD_QUEUE_OWNER } from "../services/albumDownloadQueueOwnership";
import { createArtistDownloadExpansionJob } from "../services/artistDownloadExpansionJobs";
import {
    sendRouteFailure,
    sendInternalRouteError,
    sendRouteError,
} from "../utils/routeErrorResponse";
import { probeDownloadSourceAvailability } from "../services/downloadSourcePolicy";
import {
    ACTIVE_DOWNLOAD_JOB_STATUSES,
    failDownloadJob,
} from "../services/downloadJobStatus";

const router = Router();

router.use(requireAuthOrToken);

/**
 * @openapi
 * /api/downloads/availability:
 *   get:
 *     summary: Check whether any download service is configured and enabled
 *     tags: [Downloads]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Availability status for each download service (Lidarr, Soulseek, TIDAL, YouTube Music)
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /downloads/availability
 * Check whether any download service (Lidarr or Soulseek) is configured and enabled.
 * Non-admin endpoint — any authenticated user can check.
 */
router.get("/availability", async (req, res) => {
    try {
        const availability = await probeDownloadSourceAvailability();

        res.json({
            enabled:
                availability.lidarr ||
                availability.soulseek ||
                availability.tidal ||
                availability.youtube,
            lidarr: availability.lidarr,
            soulseek: availability.soulseek,
            tidal: availability.tidal,
            youtube: availability.youtube,
        });
    } catch (error: any) {
        logger.error("Download availability check error:", error.message);
        sendInternalRouteError(res, "Failed to check download availability");
    }
});

/**
 * @openapi
 * /api/downloads:
 *   post:
 *     summary: Create a new download job for an artist or album
 *     description: Creates a persisted download job and queues artist expansion or album work for background processing.
 *     tags: [Downloads]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [type, mbid, subject]
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [artist, album]
 *               mbid:
 *                 type: string
 *                 description: MusicBrainz ID of the artist or release group
 *               subject:
 *                 type: string
 *                 description: Display name for the download
 *               artistName:
 *                 type: string
 *               albumTitle:
 *                 type: string
 *               downloadType:
 *                 type: string
 *                 enum: [library, discovery]
 *                 default: library
 *     responses:
 *       200:
 *         description: Artist expansion or album work is queued for background processing, or an active duplicate is returned
 *       400:
 *         description: Missing required fields or no download service configured
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
// POST /downloads - Create download job
router.post("/", requireAdmin, async (req, res) => {
    try {
        const {
            type,
            mbid,
            subject,
            artistName,
            artistMbid,
            albumTitle,
            downloadType = "library",
        } = req.body;
        const userId = req.user!.id;

        if (!type || !mbid || !subject) {
            return res.status(400).json({
                error: "Missing required fields: type, mbid, subject",
            });
        }

        if (type !== "artist" && type !== "album") {
            return res
                .status(400)
                .json({ error: "Type must be 'artist' or 'album'" });
        }

        if (downloadType !== "library" && downloadType !== "discovery") {
            return res.status(400).json({
                error: "downloadType must be 'library' or 'discovery'",
            });
        }

        // Check if at least one download service is available
        const settings = await getSystemSettings();
        const availability = await probeDownloadSourceAvailability();

        if (
            !availability.lidarr &&
            !availability.soulseek &&
            !availability.tidal &&
            !availability.youtube
        ) {
            return res.status(400).json({
                error: "No download service configured. Please set up Lidarr, Soulseek, TIDAL, or YouTube Music.",
            });
        }

        // Determine root folder path based on download type
        const baseMusicPath = settings?.musicPath || config.music.musicPath;
        const rootFolderPath =
            downloadType === "discovery"
                ? `${baseMusicPath}/discovery`
                : baseMusicPath;

        if (type === "artist") {
            const jobResult = await createArtistDownloadExpansionJob({
                userId,
                artistMbid: mbid,
                artistName: subject,
                downloadType,
                rootFolderPath,
            });

            if (jobResult.duplicate) {
                return res.json({
                    id: jobResult.job.id,
                    status: jobResult.job.status,
                    downloadType,
                    rootFolderPath,
                    message: "Download already in progress",
                    duplicate: true,
                });
            }

            enqueueArtistDownloadExpansionInBackground({
                jobId: jobResult.job.id,
                artistMbid: mbid,
                artistName: subject,
                downloadType,
                rootFolderPath,
                userId,
            });

            return res.json({
                id: jobResult.job.id,
                status: "pending",
                downloadType,
                rootFolderPath,
                message: "Enumerating discography in the background",
            });
        }

        const jobResult = await createAlbumDownloadJob({
            userId,
            mbid,
            subject,
            artistName,
            artistMbid,
            albumTitle,
            downloadType,
            rootFolderPath,
            metadata: { queuedVia: ALBUM_DOWNLOAD_QUEUE_OWNER },
        });

        if (jobResult.duplicate) {
            if (jobResult.duplicateSource === "unique") {
                return res.json({
                    id: jobResult.job.id,
                    status: jobResult.job.status,
                    duplicate: true,
                    message: "Download already in progress",
                });
            }
            return res.json({
                id: jobResult.job.id,
                status: jobResult.job.status,
                downloadType,
                rootFolderPath,
                message: "Download already in progress",
                duplicate: true,
            });
        }

        const job = jobResult.job;

        logger.debug(
            `[DOWNLOAD] Triggering Lidarr: ${type} "${subject}" -> ${rootFolderPath}`,
        );

        enqueueAlbumDownloadInBackground({
            jobId: job.id,
            type,
            mbid,
            subject,
            artistName: jobResult.verifiedArtistName,
            artistMbid,
            albumTitle,
        });

        res.json({
            id: job.id,
            status: job.status,
            downloadType,
            rootFolderPath,
            message: "Download job created. Processing in background.",
        });
    } catch (error: any) {
        logger.error("Create download job error:", error);
        sendInternalRouteError(res, "Failed to create download job");
    }
});

/**
 * @openapi
 * /api/downloads/clear-all:
 *   delete:
 *     summary: Clear all download jobs for the current user
 *     tags: [Downloads]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Optional status filter to clear only jobs with a specific status
 *     responses:
 *       200:
 *         description: Number of deleted download jobs
 *       401:
 *         description: Not authenticated
 */
// DELETE /downloads/clear-all - Clear all download jobs for the current user
// IMPORTANT: Must be BEFORE /:id route to avoid catching "clear-all" as an ID
router.delete("/clear-all", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { status } = req.query;

        const where: any = { userId };
        if (status) {
            where.status = status as string;
        }

        const result = await prisma.downloadJob.deleteMany({ where });

        logger.debug(
            ` Cleared ${result.count} download jobs for user ${userId}`,
        );
        res.json({ success: true, deleted: result.count });
    } catch (error) {
        logger.error("Clear downloads error:", error);
        sendInternalRouteError(res, "Failed to clear downloads");
    }
});

/**
 * @openapi
 * /api/downloads/clear-lidarr-queue:
 *   post:
 *     summary: Clear stuck or failed items from Lidarr's download queue
 *     tags: [Downloads]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Number of removed items and error count
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
// POST /downloads/clear-lidarr-queue - Clear stuck/failed items from Lidarr's queue
router.post("/clear-lidarr-queue", requireAdmin, async (req, res) => {
    try {
        const result = await simpleDownloadManager.clearLidarrQueue();
        if (result.errors.length > 0) {
            logger.warn("Clear Lidarr queue completed with errors", {
                errorCount: result.errors.length,
                errors: result.errors,
            });
        }
        res.json({
            success: true,
            removed: result.removed,
            errors: result.errors.length,
        });
    } catch (error: any) {
        logger.error("Clear Lidarr queue error:", error);
        sendInternalRouteError(res, "Failed to clear Lidarr queue");
    }
});

/**
 * @openapi
 * /api/downloads/failed:
 *   get:
 *     summary: List failed or unavailable album downloads for the current user
 *     tags: [Downloads]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of failed/unavailable albums
 *       401:
 *         description: Not authenticated
 */
// GET /downloads/failed - List failed/unavailable albums for the current user
// IMPORTANT: Must be BEFORE /:id route to avoid catching "failed" as an ID
router.get("/failed", async (req, res) => {
    try {
        const userId = req.user!.id;

        const failedAlbums = await prisma.unavailableAlbum.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
        });

        res.json(failedAlbums);
    } catch (error) {
        logger.error("List failed albums error:", error);
        sendInternalRouteError(res, "Failed to list failed albums");
    }
});

/**
 * @openapi
 * /api/downloads/failed/{id}:
 *   delete:
 *     summary: Dismiss a failed album notification
 *     tags: [Downloads]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Failed album dismissed
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Failed album not found
 */
// DELETE /downloads/failed/:id - Dismiss a failed album notification
router.delete("/failed/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;

        // Verify ownership before deleting
        const failedAlbum = await prisma.unavailableAlbum.findFirst({
            where: { id, userId },
        });

        if (!failedAlbum) {
            return sendRouteError(res, 404, "Failed album not found");
        }

        await prisma.unavailableAlbum.delete({
            where: { id },
        });

        res.json({ success: true });
    } catch (error) {
        logger.error("Delete failed album error:", error);
        sendInternalRouteError(res, "Failed to delete failed album");
    }
});

/**
 * @openapi
 * /api/downloads/releases/{albumMbid}:
 *   get:
 *     summary: Get available Lidarr releases for an album (interactive search)
 *     tags: [Downloads]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: albumMbid
 *         required: true
 *         schema:
 *           type: string
 *         description: MusicBrainz release group ID
 *       - in: query
 *         name: artistName
 *         schema:
 *           type: string
 *       - in: query
 *         name: albumTitle
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Available releases for the album from Lidarr
 *       400:
 *         description: Missing albumMbid or Lidarr not configured
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Album not found in Lidarr
 */
// GET /downloads/releases/:albumMbid - Get available releases for an album (interactive search)
router.get("/releases/:albumMbid", requireAdmin, async (req, res) => {
    try {
        const albumMbidParam = req.params.albumMbid;
        const albumMbid = Array.isArray(albumMbidParam)
            ? albumMbidParam[0]
            : albumMbidParam;
        const artistName = String(req.query.artistName || "").trim();
        const albumTitle = String(req.query.albumTitle || "").trim();

        if (!albumMbid) {
            return sendRouteError(res, 400, "Missing albumMbid parameter");
        }

        const lidarrEnabled = await lidarrService.isEnabled();
        if (!lidarrEnabled) {
            return sendRouteError(res, 400, "Lidarr not configured");
        }

        logger.debug(
            `[INTERACTIVE] Searching releases for ${albumTitle || albumMbid}`,
        );

        let lidarrAlbumId: number | null = null;

        const searchResults = await lidarrService.searchAlbum(
            artistName,
            albumTitle,
            albumMbid,
        );
        if (searchResults.length > 0) {
            const exactMatch = searchResults.find(
                (album) => album.foreignAlbumId === albumMbid,
            );
            if (exactMatch) {
                lidarrAlbumId = exactMatch.id;
                logger.debug(
                    `[INTERACTIVE] Found album in Lidarr lookup: ${lidarrAlbumId}`,
                );
            }
        }

        // If not already in Lidarr, try adding the artist and retry album lookup.
        if (!lidarrAlbumId && artistName) {
            let artistMbid: string | undefined;
            try {
                const releaseGroup =
                    await musicBrainzService.getReleaseGroup(albumMbid);
                artistMbid = releaseGroup?.["artist-credit"]?.[0]?.artist?.id;
            } catch (error) {
                logger.warn(
                    `[INTERACTIVE] Failed resolving artist MBID for ${albumMbid}:`,
                    error,
                );
            }

            if (artistMbid) {
                const settings = await getSystemSettings();
                const baseMusicPath =
                    settings?.musicPath || config.music.musicPath;

                const artist = await lidarrService.addArtist(
                    artistMbid,
                    artistName,
                    baseMusicPath,
                    false, // no auto-search
                    false, // don't auto-monitor all albums
                );

                if (artist) {
                    const retryResults = await lidarrService.searchAlbum(
                        artistName,
                        albumTitle,
                        albumMbid,
                    );
                    const retryMatch = retryResults.find(
                        (album) => album.foreignAlbumId === albumMbid,
                    );
                    if (retryMatch) {
                        lidarrAlbumId = retryMatch.id;
                        logger.debug(
                            `[INTERACTIVE] Found album after artist add: ${lidarrAlbumId}`,
                        );
                    }
                }
            }
        }

        if (!lidarrAlbumId) {
            return sendRouteError(
                res,
                404,
                "Album not found in Lidarr. Could not find or add this album to Lidarr; the album may not be available in Lidarr metadata.",
            );
        }

        const releases = await lidarrService.getAlbumReleases(lidarrAlbumId);
        const formattedReleases = releases.map(mapInteractiveRelease);

        res.json({
            albumMbid,
            lidarrAlbumId,
            releases: formattedReleases,
            total: formattedReleases.length,
        });
    } catch (error: any) {
        return sendRouteFailure(
            res,
            logger,
            ["Get interactive releases error:", "Failed to fetch releases"],
            error,
        );
    }
});

/**
 * @openapi
 * /api/downloads/grab:
 *   post:
 *     summary: Grab a specific release from Lidarr interactive search
 *     tags: [Downloads]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [guid, lidarrAlbumId]
 *             properties:
 *               guid:
 *                 type: string
 *               indexerId:
 *                 type: integer
 *               albumMbid:
 *                 type: string
 *               lidarrAlbumId:
 *                 type: integer
 *               artistName:
 *                 type: string
 *               albumTitle:
 *                 type: string
 *               title:
 *                 type: string
 *                 description: Release title
 *     responses:
 *       200:
 *         description: Release grabbed from indexer and download job created
 *       400:
 *         description: Missing required fields or Lidarr not configured
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
// POST /downloads/grab - Grab a specific release from interactive search
router.post("/grab", requireAdmin, async (req, res) => {
    try {
        const {
            guid,
            indexerId,
            albumMbid,
            lidarrAlbumId,
            artistName,
            albumTitle,
            title: releaseTitle,
        } = req.body;
        const userId = req.user!.id;
        const parsedLidarrAlbumId = Number(lidarrAlbumId);
        const normalizedAlbumMbid =
            typeof albumMbid === "string" ? albumMbid.trim() : "";

        if (
            !guid ||
            !Number.isFinite(parsedLidarrAlbumId) ||
            parsedLidarrAlbumId <= 0
        ) {
            return res.status(400).json({
                error: "Missing required fields: guid, lidarrAlbumId",
            });
        }

        const lidarrEnabled = await lidarrService.isEnabled();
        if (!lidarrEnabled) {
            return sendRouteError(res, 400, "Lidarr not configured");
        }

        const duplicateWhere: any = {
            userId,
            status: { in: ACTIVE_DOWNLOAD_JOB_STATUSES },
            OR: [{ lidarrAlbumId: parsedLidarrAlbumId }],
        };

        if (normalizedAlbumMbid) {
            duplicateWhere.OR.push({ targetMbid: normalizedAlbumMbid });
        }

        const existingJob = await prisma.downloadJob.findFirst({
            where: duplicateWhere,
            orderBy: { createdAt: "desc" },
            select: { id: true, status: true },
        });

        if (existingJob) {
            return res.json({
                success: true,
                duplicate: true,
                jobId: existingJob.id,
                message: "Download already in progress for this album",
            });
        }

        const job = await prisma.downloadJob.create({
            data: {
                userId,
                subject: `${artistName || "Unknown"} - ${albumTitle || "Unknown"}`,
                type: "album",
                targetMbid:
                    normalizedAlbumMbid || `interactive:${parsedLidarrAlbumId}`,
                status: "processing",
                lidarrAlbumId: parsedLidarrAlbumId,
                metadata: {
                    downloadType: "library",
                    rootFolderPath: config.music.musicPath,
                    artistName,
                    albumTitle,
                    interactiveDownload: true,
                    selectedRelease: releaseTitle || guid,
                },
            },
        });

        const success = await lidarrService.grabRelease({
            guid,
            indexerId: Number(indexerId) || 0,
            title: releaseTitle || "",
            protocol: "torrent",
            approved: true,
            rejected: false,
        });

        if (!success) {
            await failDownloadJob(
                job.id,
                "Failed to grab release from indexer",
            );
            return sendInternalRouteError(res, "Failed to grab release");
        }

        res.json({
            success: true,
            jobId: job.id,
            message: `Downloading "${albumTitle}" - release grabbed from indexer`,
        });
    } catch (error: any) {
        return sendRouteFailure(
            res,
            logger,
            ["Grab interactive release error:", "Failed to grab release"],
            error,
        );
    }
});

/**
 * @openapi
 * /api/downloads/{id}:
 *   get:
 *     summary: Get download job status by ID
 *     tags: [Downloads]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Download job details
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Download job not found
 */
// GET /downloads/:id - Get download job status
router.get("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;

        const job = await prisma.downloadJob.findFirst({
            where: {
                id,
                userId,
            },
        });

        if (!job) {
            return sendRouteError(res, 404, "Download job not found");
        }

        res.json(job);
    } catch (error) {
        logger.error("Get download job error:", error);
        sendInternalRouteError(res, "Failed to get download job");
    }
});

/**
 * @openapi
 * /api/downloads/{id}:
 *   patch:
 *     summary: Update a download job status
 *     tags: [Downloads]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *                 description: New status for the download job
 *     responses:
 *       200:
 *         description: Updated download job
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Download job not found
 */
// PATCH /downloads/:id - Update download job (e.g., mark as complete)
router.patch("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;
        const { status } = req.body;

        const job = await prisma.downloadJob.findFirst({
            where: {
                id,
                userId,
            },
        });

        if (!job) {
            return sendRouteError(res, 404, "Download job not found");
        }

        const updated = await prisma.downloadJob.update({
            where: { id },
            data: {
                status: status || "completed",
                completedAt: status === "completed" ? new Date() : undefined,
            },
        });

        res.json(updated);
    } catch (error) {
        logger.error("Update download job error:", error);
        sendInternalRouteError(res, "Failed to update download job");
    }
});

/**
 * @openapi
 * /api/downloads/{id}:
 *   delete:
 *     summary: Delete a download job
 *     tags: [Downloads]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Download job deleted (idempotent)
 *       401:
 *         description: Not authenticated
 */
// DELETE /downloads/:id - Delete download job
router.delete("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user!.id;

        // Use deleteMany to handle race conditions gracefully
        // This won't throw an error if the record was already deleted
        const result = await prisma.downloadJob.deleteMany({
            where: {
                id,
                userId,
            },
        });

        // Return success even if nothing was deleted (idempotent delete)
        res.json({ success: true, deleted: result.count > 0 });
    } catch (error: any) {
        logger.error("Delete download job error:", error);
        logger.error("Error details:", error.message, error.stack);
        res.status(500).json({
            error: "Failed to delete download job",
        });
    }
});

/**
 * @openapi
 * /api/downloads:
 *   get:
 *     summary: List download jobs for the current user
 *     tags: [Downloads]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by job status
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           minimum: 1
 *           maximum: 200
 *         description: Maximum number of jobs to return
 *       - in: query
 *         name: includeDiscovery
 *         schema:
 *           type: string
 *           enum: ["true", "false"]
 *           default: "false"
 *         description: Include automated discovery downloads
 *       - in: query
 *         name: includeCleared
 *         schema:
 *           type: string
 *           enum: ["true", "false"]
 *           default: "false"
 *         description: Include cleared/dismissed jobs
 *     responses:
 *       200:
 *         description: List of download jobs
 *       401:
 *         description: Not authenticated
 */
// GET /downloads - List user's download jobs
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const {
            status,
            includeDiscovery = "false",
            includeCleared = "false",
        } = req.query;
        const limit = parseBoundedInt(req.query.limit, 50, 1, 200);

        const where: any = { userId };
        if (status) {
            where.status = status as string;
        }
        // Filter out cleared jobs by default (user dismissed from history)
        if (includeCleared !== "true") {
            where.cleared = false;
        }

        const jobs = await prisma.downloadJob.findMany({
            where,
            orderBy: { createdAt: "desc" },
            take: limit,
        });

        // Filter out discovery downloads unless explicitly requested
        // Discovery downloads are automated and shouldn't show in the UI popover
        const filteredJobs =
            includeDiscovery === "true"
                ? jobs
                : jobs.filter((job) => {
                      const metadata = job.metadata as any;
                      return metadata?.downloadType !== "discovery";
                  });

        res.json(filteredJobs);
    } catch (error) {
        logger.error("List download jobs error:", error);
        sendInternalRouteError(res, "Failed to list download jobs");
    }
});

async function keepDiscoveryTrack(
    userId: string,
    discoveryTrackId: string,
    createDownloadJob: boolean,
) {
    return prisma.$transaction(async (tx) => {
        const discoveryTrack = await tx.discoveryTrack.findFirst({
            where: {
                id: discoveryTrackId,
                discoveryAlbum: { userId },
            },
            include: { discoveryAlbum: true },
        });

        if (!discoveryTrack) {
            return { found: false } as const;
        }

        await tx.discoveryTrack.update({
            where: { id: discoveryTrack.id },
            data: { userKept: true },
        });

        if (!createDownloadJob) {
            return { found: true, downloadJobId: null } as const;
        }

        const job = await tx.downloadJob.create({
            data: {
                userId,
                subject: `${discoveryTrack.discoveryAlbum.albumTitle} by ${discoveryTrack.discoveryAlbum.artistName}`,
                type: "album",
                targetMbid: discoveryTrack.discoveryAlbum.rgMbid,
                status: "pending",
            },
        });

        return { found: true, downloadJobId: job.id } as const;
    });
}

/**
 * @openapi
 * /api/downloads/keep-track:
 *   post:
 *     summary: Keep a discovery track by moving it to the permanent library
 *     tags: [Downloads]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [discoveryTrackId]
 *             properties:
 *               discoveryTrackId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Track marked as kept with optional download job info
 *       400:
 *         description: Missing discoveryTrackId
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Discovery track not found
 */
// POST /downloads/keep-track - Keep a discovery track (move to permanent library)
router.post("/keep-track", requireAdmin, async (req, res) => {
    try {
        const { discoveryTrackId } = req.body;
        const userId = req.user!.id;

        if (!discoveryTrackId) {
            return sendRouteError(res, 400, "Missing discoveryTrackId");
        }

        const lidarrEnabled = await lidarrService.isEnabled();
        const result = await keepDiscoveryTrack(
            userId,
            discoveryTrackId,
            lidarrEnabled,
        );

        if (!result.found) {
            return sendRouteError(res, 404, "Discovery track not found");
        }

        if (result.downloadJobId) {
            return res.json({
                success: true,
                message:
                    "Track marked as kept. Full album will be downloaded to permanent library.",
                downloadJobId: result.downloadJobId,
            });
        }

        res.json({
            success: true,
            message:
                "Track marked as kept. Please add the full album manually to your /music folder.",
        });
    } catch (error) {
        logger.error("Keep track error:", error);
        sendInternalRouteError(res, "Failed to keep track");
    }
});

export default router;
