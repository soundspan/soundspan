import { Router, type Request, type Response } from "express";
import {
    requireAdmin,
    requireAuth,
    requireAuthOrToken,
} from "../../middleware/auth";
import { asyncHandler } from "../../middleware/asyncHandler";
import { prisma, Prisma } from "../../utils/db";
import path from "path";
import { config } from "../../config";
import { scanQueue } from "../../workers/queues";
import { organizeSingles } from "../../workers/organizeSingles";
import { parseBoundedInt } from "../../utils/queryParams";
import { sendInternalRouteError, sendRouteError } from "../routeErrorResponse";
import {
    DEFAULT_MY_LIKED_LIMIT,
    isLibraryDeletionEnabled,
    MAX_LIMIT,
    MY_LIKED_PLAYLIST_DESCRIPTION,
    MY_LIKED_PLAYLIST_ID,
    MY_LIKED_PLAYLIST_NAME,
    parseBooleanQueryParam,
} from "../../utils/libraryRouteSupport";
import {
    admitLibraryMaintenance,
    finishOrganizationInBackground,
    LIBRARY_MAINTENANCE_JOB_ID,
    libraryMaintenanceLogger,
    releaseLibraryMaintenanceAdmission,
    sanitizeScanProgress,
    sanitizeScanResult,
    startAdmittedLibraryScan,
} from "../../services/libraryMaintenance";

/**
 * Router segment for maintenance routes registered at this position.
 */
export const maintenanceRouter = Router();
/**
 * @openapi
 * /api/library/delete-policy:
 *   get:
 *     summary: Get library deletion policy for the current user
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Deletion policy details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isAdmin:
 *                   type: boolean
 *                 libraryDeletionEnabled:
 *                   type: boolean
 *                 canDelete:
 *                   type: boolean
 *       401:
 *         description: Not authenticated
 */
// GET /library/delete-policy - Determine whether current user can delete library content
/**
 * Handles GET /api/library/delete-policy.
 */
export async function handleGetDeletePolicy(req: Request, res: Response) {
    const isAdmin = req.user?.role === "admin";
    if (!isAdmin) {
        return res.json({
            isAdmin: false,
            libraryDeletionEnabled: false,
            canDelete: false,
        });
    }

    const libraryDeletionEnabled = await isLibraryDeletionEnabled();

    return res.json({
        isAdmin: true,
        libraryDeletionEnabled,
        canDelete: libraryDeletionEnabled,
    });
}

maintenanceRouter.get("/delete-policy", asyncHandler(handleGetDeletePolicy));

/**
 * @openapi
 * /api/library/scan:
 *   post:
 *     summary: Start a library scan job
 *     description: Initiates a background job to scan the music directory and index all audio files
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Library scan started or global library maintenance is already running
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Library scan started"
 *                 jobId:
 *                   type: string
 *                   description: Job ID to track progress
 *                   example: "123"
 *                 musicPath:
 *                   type: string
 *                   example: "/path/to/music"
 *                 status:
 *                   type: string
 *                   description: Present as "processing" when maintenance was already active
 *       429:
 *         description: This user started library maintenance too recently
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Failed to start scan
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
/**
 * Handles POST /api/library/scan.
 */
export async function handleStartLibraryScan(req: Request, res: Response) {
    if (!config.music.musicPath) {
        return res.status(500).json({
            error: "Music path not configured. Please set MUSIC_PATH environment variable.",
        });
    }

    const userId = req.user?.id || "system";
    const admission = await admitLibraryMaintenance(userId);
    if (!admission.admitted) {
        if (admission.reason === "cooldown") {
            return sendRouteError(
                res,
                429,
                "Library maintenance was started recently",
            );
        }
        return res.json({
            message: "Library maintenance already running",
            status: "processing",
            jobId: admission.jobId ?? LIBRARY_MAINTENANCE_JOB_ID,
            musicPath: config.music.musicPath,
        });
    }

    const job = await startAdmittedLibraryScan(userId, admission);
    return res.json({
        message: "Library scan started",
        jobId: job.id,
        musicPath: config.music.musicPath,
    });
}

maintenanceRouter.post("/scan", asyncHandler(handleStartLibraryScan));

/**
 * @openapi
 * /api/library/scan/status/{jobId}:
 *   get:
 *     summary: Check the status of a library scan job
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *         description: The scan job ID returned from POST /scan
 *     responses:
 *       200:
 *         description: Scan job status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 progress:
 *                   type: integer
 *                   minimum: 0
 *                   maximum: 100
 *                 result:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     tracksAdded:
 *                       type: integer
 *                       minimum: 0
 *                     tracksUpdated:
 *                       type: integer
 *                       minimum: 0
 *                     tracksRemoved:
 *                       type: integer
 *                       minimum: 0
 *                     failedCount:
 *                       type: integer
 *                       minimum: 0
 *                     duration:
 *                       type: integer
 *                       minimum: 0
 *       404:
 *         description: Job not found
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       500:
 *         description: Failed to get scan status
 */
// GET /library/scan/status/:jobId - Check scan job status
/**
 * Handles GET /api/library/scan/status/:jobId.
 */
export async function handleGetLibraryScanStatus(
    req: Request<{ jobId: string }>,
    res: Response,
) {
    try {
        const job = await scanQueue.getJob(req.params.jobId);

        if (!job) {
            return sendRouteError(res, 404, "Job not found");
        }

        const state = await job.getState();
        const progress = sanitizeScanProgress(job.progress());
        const result = sanitizeScanResult(job.returnvalue);

        return res.json({
            status: state,
            progress,
            result,
        });
    } catch (error) {
        libraryMaintenanceLogger.error("Failed to get scan status", {
            jobId: req.params.jobId,
            error,
        });
        return sendInternalRouteError(res, "Failed to get scan status");
    }
}

maintenanceRouter.get<{ jobId: string }>(
    "/scan/status/:jobId",
    requireAdmin,
    asyncHandler(handleGetLibraryScanStatus),
);

/**
 * @openapi
 * /api/library/organize:
 *   post:
 *     summary: Manually trigger file organization script
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Organization started or global library maintenance is already running
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 status:
 *                   type: string
 *                   description: Present as "processing" when maintenance was already active
 *       429:
 *         description: This user started library maintenance too recently
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Not authenticated
 */
// POST /library/organize - Manually trigger organization script
/**
 * Handles POST /api/library/organize.
 */
export async function handleOrganizeLibrary(req: Request, res: Response) {
    const admission = await admitLibraryMaintenance(req.user?.id || "system");
    if (!admission.admitted) {
        if (admission.reason === "cooldown") {
            return sendRouteError(
                res,
                429,
                "Library maintenance was started recently",
            );
        }
        return res.json({
            message: "Library maintenance already running",
            status: "processing",
        });
    }

    let organization: Promise<void>;
    try {
        organization = organizeSingles();
    } catch (error) {
        await releaseLibraryMaintenanceAdmission(admission, false);
        throw error;
    }

    void finishOrganizationInBackground(organization, admission);

    res.json({ message: "Organization started in background" });
}

maintenanceRouter.post("/organize", asyncHandler(handleOrganizeLibrary));

/**
 * @openapi
 * /api/library/recently-listened:
 *   get:
 *     summary: Get recently listened artists, audiobooks, and podcasts
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Maximum number of items to return
 *     responses:
 *       200:
 *         description: Recently listened items
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Not authenticated
 */
// GET /library/recently-listened?limit=10
/**
 * Handles GET /api/library/recently-listened.
 */
export async function handleGetRecentlyListened(req: Request, res: Response) {
    const userId = req.user!.id;
    const limitNum = parseBoundedInt(req.query.limit, 10, 1, 100);

    const [recentPlays, inProgressAudiobooks, inProgressPodcasts] =
        await Promise.all([
            prisma.play.findMany({
                where: {
                    userId,
                    // Exclude pure discovery plays (only show library and kept discovery)
                    source: { in: ["LIBRARY", "DISCOVERY_KEPT"] },
                    // Also filter by album location to exclude discovery albums
                    track: {
                        album: {
                            location: "LIBRARY",
                        },
                    },
                },
                orderBy: { playedAt: "desc" },
                take: limitNum * 3, // Get more than needed to account for duplicates
                include: {
                    track: {
                        include: {
                            album: {
                                include: {
                                    artist: {
                                        select: {
                                            id: true,
                                            mbid: true,
                                            name: true,
                                            heroUrl: true,
                                            userHeroUrl: true,
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            }),
            prisma.audiobookProgress.findMany({
                where: {
                    userId,
                    isFinished: false,
                    currentTime: { gt: 0 }, // Only show if actually started
                },
                orderBy: { lastPlayedAt: Prisma.SortOrder.desc },
                take: Math.ceil(limitNum / 3), // Get up to 1/3 for audiobooks
            }),
            prisma.podcastProgress.findMany({
                where: {
                    userId,
                    isFinished: false,
                    currentTime: { gt: 0 }, // Only show if actually started
                },
                orderBy: { lastPlayedAt: Prisma.SortOrder.desc },
                take: limitNum * 2, // Get extra to account for deduplication
                include: {
                    episode: {
                        include: {
                            podcast: {
                                select: {
                                    id: true,
                                    title: true,
                                    author: true,
                                    imageUrl: true,
                                },
                            },
                        },
                    },
                },
            }),
        ]);

    // Deduplicate podcasts - keep only the most recently played episode per podcast
    const seenPodcasts = new Set();
    const uniquePodcasts = inProgressPodcasts
        .filter((pp) => {
            const podcastId = pp.episode.podcast.id;
            if (seenPodcasts.has(podcastId)) {
                return false;
            }
            seenPodcasts.add(podcastId);
            return true;
        })
        .slice(0, Math.ceil(limitNum / 3)); // Limit to 1/3 after deduplication

    // Extract unique artists and audiobooks
    const items: any[] = [];
    const artistsMap = new Map();

    // Add music artists
    for (const play of recentPlays) {
        if (!play.track) {
            continue;
        }
        const artist = play.track.album.artist;
        if (!artistsMap.has(artist.id)) {
            artistsMap.set(artist.id, {
                ...artist,
                type: "artist",
                lastPlayedAt: play.playedAt,
            });
        }
        if (items.length >= limitNum) break;
    }

    // Combine artists, audiobooks, and podcasts
    const combined = [
        ...Array.from(artistsMap.values()),
        ...inProgressAudiobooks.map((ab: any) => {
            // For audiobooks, prefix the path with 'audiobook__' so the frontend knows to use the audiobook endpoint
            const coverArt =
                ab.coverUrl && !ab.coverUrl.startsWith("http")
                    ? `audiobook__${ab.coverUrl}`
                    : ab.coverUrl;

            return {
                id: ab.audiobookshelfId,
                name: ab.title,
                coverArt,
                type: "audiobook",
                author: ab.author,
                progress:
                    ab.duration > 0
                        ? Math.round((ab.currentTime / ab.duration) * 100)
                        : 0,
                lastPlayedAt: ab.lastPlayedAt,
            };
        }),
        ...uniquePodcasts.map((pp: any) => ({
            id: pp.episode.podcast.id,
            episodeId: pp.episodeId,
            name: pp.episode.podcast.title,
            coverArt: pp.episode.podcast.imageUrl,
            type: "podcast",
            author: pp.episode.podcast.author,
            progress:
                pp.duration > 0
                    ? Math.round((pp.currentTime / pp.duration) * 100)
                    : 0,
            lastPlayedAt: pp.lastPlayedAt,
        })),
    ];

    // Sort by lastPlayedAt and limit
    combined.sort(
        (a, b) =>
            new Date(b.lastPlayedAt).getTime() -
            new Date(a.lastPlayedAt).getTime(),
    );
    const limitedItems = combined.slice(0, limitNum);

    // Get album counts for artists
    const artistIds = limitedItems
        .filter((item) => item.type === "artist")
        .map((item) => item.id);
    const albumCounts = await prisma.ownedAlbum.groupBy({
        by: ["artistId"],
        where: { artistId: { in: artistIds } },
        _count: { rgMbid: true },
    });
    const albumCountMap = new Map(
        albumCounts.map((ac) => [ac.artistId, ac._count.rgMbid]),
    );

    // Map results - no on-demand image fetching for performance
    // Artists without images will show placeholders until enrichment completes
    const results = limitedItems.map((item) => {
        if (item.type === "audiobook" || item.type === "podcast") {
            return item;
        } else {
            // Use override pattern: userHeroUrl ?? heroUrl
            const coverArt = item.userHeroUrl ?? item.heroUrl ?? null;
            return {
                ...item,
                coverArt,
                albumCount: albumCountMap.get(item.id) || 0,
            };
        }
    });

    res.json({ items: results });
}

maintenanceRouter.get(
    "/recently-listened",
    asyncHandler(handleGetRecentlyListened),
);

/**
 * @openapi
 * /api/library/recently-added:
 *   get:
 *     summary: Get recently added artists to the library
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Maximum number of artists to return
 *     responses:
 *       200:
 *         description: Recently added artists
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 artists:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Not authenticated
 */
// GET /library/recently-added?limit=10
/**
 * Handles GET /api/library/recently-added.
 */
export async function handleGetRecentlyAdded(req: Request, res: Response) {
    const { limit = "10" } = req.query;
    const limitNum = parseInt(limit as string, 10);

    // Get the 20 most recently added LIBRARY albums (by lastSynced timestamp)
    // This limits "Recently Added" to actual recent additions, not the entire library
    const recentAlbums = await prisma.album.findMany({
        where: {
            location: "LIBRARY",
            tracks: { some: {} }, // Only albums with actual tracks
        },
        orderBy: { lastSynced: "desc" },
        take: 20, // Hard limit to last 20 albums
        include: {
            artist: {
                select: {
                    id: true,
                    mbid: true,
                    name: true,
                    heroUrl: true,
                    userHeroUrl: true,
                },
            },
        },
    });

    // Extract unique artists from recent albums (preserving order of most recent)
    const artistsMap = new Map();
    for (const album of recentAlbums) {
        if (!artistsMap.has(album.artist.id)) {
            artistsMap.set(album.artist.id, album.artist);
        }
        if (artistsMap.size >= limitNum) break;
    }

    // Get album counts for each artist (only LIBRARY albums)
    const artistIds = Array.from(artistsMap.keys());
    const albumCounts = await prisma.album.groupBy({
        by: ["artistId"],
        where: {
            artistId: { in: artistIds },
            location: "LIBRARY",
            tracks: { some: {} },
        },
        _count: { id: true },
    });
    const albumCountMap = new Map(
        albumCounts.map((ac) => [ac.artistId, ac._count.id]),
    );

    // Map results - no on-demand image fetching for performance
    // Artists without images will show placeholders until enrichment completes
    const artistsWithImages = Array.from(artistsMap.values()).map((artist) => {
        // Use override pattern: userHeroUrl ?? heroUrl
        const coverArt = artist.userHeroUrl ?? artist.heroUrl ?? null;
        return {
            ...artist,
            coverArt,
            albumCount: albumCountMap.get(artist.id) || 0,
        };
    });

    res.json({ artists: artistsWithImages });
}

maintenanceRouter.get("/recently-added", asyncHandler(handleGetRecentlyAdded));
