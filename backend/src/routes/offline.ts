import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";
import {
    LOCAL_TRACK_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../utils/librarySorting";

const router = Router();

router.use(requireAuth);

const qualitySchema = z.enum(["original", "high", "medium", "low"]);

const downloadAlbumSchema = z.object({
    quality: qualitySchema.optional(),
});

const completeTrackSchema = z.object({
    localPath: z.string().min(1).max(1024),
    quality: qualitySchema,
    fileSizeMb: z.coerce.number().finite().positive().max(4096),
});

/**
 * @openapi
 * /api/offline/albums/{id}/download:
 *   post:
 *     summary: Create a download job for an album's tracks
 *     tags: [Offline]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Album ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               quality:
 *                 type: string
 *                 enum: [original, high, medium, low]
 *                 description: Audio quality for download
 *     responses:
 *       200:
 *         description: Download job created with track stream URLs
 *       400:
 *         description: Cache size limit exceeded or invalid request
 *       404:
 *         description: Album not found
 *       401:
 *         description: Not authenticated
 */
// POST /offline/albums/:id/download
router.post("/albums/:id/download", async (req, res) => {
    try {
        const userId = req.user!.id;
        const albumId = req.params.id;
        const { quality } = downloadAlbumSchema.parse(req.body);

        // Get user's default quality if not specified
        let selectedQuality: "original" | "high" | "medium" | "low" =
            quality || "medium";
        if (!quality) {
            const settings = await prisma.userSettings.findUnique({
                where: { userId },
            });
            selectedQuality =
                (settings?.playbackQuality as
                    | "original"
                    | "high"
                    | "medium"
                    | "low") || "medium";
        }

        // Get album with tracks
        const album = await prisma.album.findUnique({
            where: { id: albumId },
            include: {
                tracks: {
                    where: { ...TRACK_VISIBLE_WHERE, ...LOCAL_TRACK_WHERE },
                    orderBy: [{ discNo: "asc" }, { trackNo: "asc" }],
                },
                artist: {
                    select: {
                        name: true,
                    },
                },
            },
        });

        if (!album) {
            return res.status(404).json({ error: "Album not found" });
        }

        // Calculate total size estimate
        const avgSizeMb: Record<string, number> = {
            original: 30, // FLAC
            high: 10, // MP3 320
            medium: 6, // MP3 192
            low: 4, // MP3 128
        };

        const estimatedSizeMb =
            album.tracks.length * avgSizeMb[selectedQuality];

        // Check user's cache limit
        const settings = await prisma.userSettings.findUnique({
            where: { userId },
        });

        if (settings) {
            const currentCacheSize = await prisma.cachedTrack.aggregate({
                where: { userId },
                _sum: { fileSizeMb: true },
            });

            const currentSize = currentCacheSize._sum.fileSizeMb || 0;

            if (currentSize + estimatedSizeMb > settings.maxCacheSizeMb) {
                return res.status(400).json({
                    error: "Cache size limit exceeded",
                    currentSize,
                    maxSize: settings.maxCacheSizeMb,
                    needed: estimatedSizeMb,
                });
            }
        }

        // Create download job (tracks to be downloaded by mobile client)
        const downloadJob = {
            albumId: album.id,
            albumTitle: album.title,
            artistName: album.artist.name,
            quality: selectedQuality,
            tracks: album.tracks.map((track) => ({
                trackId: track.id,
                title: track.title,
                trackNo: track.trackNo,
                duration: track.duration,
                streamUrl: `/library/tracks/${track.id}/stream?quality=${selectedQuality}`,
            })),
            estimatedSizeMb,
        };

        res.json(downloadJob);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.issues });
        }
        logger.error("Create download job error:", error);
        res.status(500).json({ error: "Failed to create download job" });
    }
});

/**
 * @openapi
 * /api/offline/tracks/{id}/complete:
 *   post:
 *     summary: Mark a track download as complete
 *     tags: [Offline]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Track ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - localPath
 *               - quality
 *               - fileSizeMb
 *             properties:
 *               localPath:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 1024
 *                 description: Local file path on device
 *               quality:
 *                 type: string
 *                 enum: [original, high, medium, low]
 *                 description: Audio quality of the cached file
 *               fileSizeMb:
 *                 type: number
 *                 exclusiveMinimum: 0
 *                 maximum: 4096
 *                 description: File size in megabytes
 *     responses:
 *       200:
 *         description: Cached track record created or updated
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Not authenticated
 */
// POST /offline/tracks/:id/complete (called by mobile after download)
router.post("/tracks/:id/complete", async (req, res) => {
    try {
        const userId = req.user!.id;
        const trackId = req.params.id;
        const { localPath, quality, fileSizeMb } = completeTrackSchema.parse(
            req.body,
        );
        const track = await prisma.track.findFirst({
            where: {
                id: trackId,
                ...TRACK_VISIBLE_WHERE,
                ...LOCAL_TRACK_WHERE,
            },
            select: { id: true },
        });
        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        const cachedTrack = await prisma.cachedTrack.upsert({
            where: {
                userId_trackId_quality: {
                    userId,
                    trackId,
                    quality,
                },
            },
            create: {
                userId,
                trackId,
                localPath,
                quality,
                fileSizeMb,
            },
            update: {
                localPath,
                fileSizeMb,
                lastAccessedAt: new Date(),
            },
        });

        res.json(cachedTrack);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.issues });
        }
        logger.error("Complete track download error:", error);
        res.status(500).json({ error: "Failed to complete download" });
    }
});

/**
 * @openapi
 * /api/offline/albums:
 *   get:
 *     summary: Get all offline-cached albums for the current user
 *     tags: [Offline]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: List of cached albums with track details and sizes
 *       401:
 *         description: Not authenticated
 */
// GET /offline/albums
router.get("/albums", async (req, res) => {
    try {
        const userId = req.user!.id;

        // Get all cached tracks grouped by album
        const cachedTracks = await prisma.cachedTrack.findMany({
            where: { userId },
            include: {
                track: {
                    include: {
                        album: {
                            include: {
                                artist: {
                                    select: {
                                        id: true,
                                        name: true,
                                        mbid: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        const removedCachedTracks = cachedTracks.filter(
            (cached) => cached.track.removedAt !== null,
        );
        if (removedCachedTracks.length > 0) {
            await prisma.cachedTrack.deleteMany({
                where: {
                    id: { in: removedCachedTracks.map((cached) => cached.id) },
                    userId,
                },
            });
        }
        const visibleCachedTracks = cachedTracks.filter(
            (cached) => cached.track.removedAt === null,
        );

        // Group by album
        const albumsMap = new Map();

        for (const cached of visibleCachedTracks) {
            const albumId = cached.track.album.id;

            if (!albumsMap.has(albumId)) {
                albumsMap.set(albumId, {
                    album: cached.track.album,
                    tracks: [],
                    totalSizeMb: 0,
                });
            }

            const albumData = albumsMap.get(albumId);
            albumData.tracks.push({
                ...cached.track,
                cachedPath: cached.localPath,
                cachedQuality: cached.quality,
                cachedSizeMb: cached.fileSizeMb,
            });
            albumData.totalSizeMb += cached.fileSizeMb;
        }

        const albums = Array.from(albumsMap.values()).map((data) => ({
            ...data.album,
            cachedTracks: data.tracks,
            totalSizeMb: data.totalSizeMb,
        }));

        res.json(albums);
    } catch (error) {
        logger.error("Get cached albums error:", error);
        res.status(500).json({ error: "Failed to get cached albums" });
    }
});

/**
 * @openapi
 * /api/offline/albums/{id}:
 *   delete:
 *     summary: Remove a cached album from offline storage
 *     tags: [Offline]
 *     security:
 *       - sessionAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Album ID
 *     responses:
 *       200:
 *         description: Album removed from cache
 *       401:
 *         description: Not authenticated
 */
// DELETE /offline/albums/:id
router.delete("/albums/:id", async (req, res) => {
    try {
        const userId = req.user!.id;
        const albumId = req.params.id;

        // Get all cached tracks for this album
        const cachedTracks = await prisma.cachedTrack.findMany({
            where: {
                userId,
                track: {
                    albumId,
                },
            },
        });

        // Delete all cached tracks for this album
        await prisma.cachedTrack.deleteMany({
            where: {
                userId,
                track: {
                    albumId,
                },
            },
        });

        res.json({
            message: "Album removed from cache",
            deletedCount: cachedTracks.length,
        });
    } catch (error) {
        logger.error("Delete cached album error:", error);
        res.status(500).json({ error: "Failed to delete cached album" });
    }
});

/**
 * @openapi
 * /api/offline/stats:
 *   get:
 *     summary: Get offline cache usage statistics
 *     tags: [Offline]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: Cache usage stats including size and track count
 *       401:
 *         description: Not authenticated
 */
// GET /offline/stats
router.get("/stats", async (req, res) => {
    try {
        const userId = req.user!.id;

        const [settings, cacheStats] = await Promise.all([
            prisma.userSettings.findUnique({
                where: { userId },
            }),
            prisma.cachedTrack.aggregate({
                where: { userId },
                _sum: { fileSizeMb: true },
                _count: true,
            }),
        ]);

        const usedMb = cacheStats._sum.fileSizeMb || 0;
        const maxMb = settings?.maxCacheSizeMb || 5120;
        const trackCount = cacheStats._count || 0;

        res.json({
            usedMb,
            maxMb,
            availableMb: maxMb - usedMb,
            percentUsed: (usedMb / maxMb) * 100,
            trackCount,
        });
    } catch (error) {
        logger.error("Get cache stats error:", error);
        res.status(500).json({ error: "Failed to get cache stats" });
    }
});

export default router;
