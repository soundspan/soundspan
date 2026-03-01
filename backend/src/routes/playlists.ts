import { Router } from "express";
import { logger } from "../utils/logger";
import { z } from "zod";
import { requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { sessionLog } from "../utils/playlistLogger";

const router = Router();

router.use(requireAuthOrToken);

const createPlaylistSchema = z.object({
    name: z.string().min(1).max(200),
    isPublic: z.boolean().optional().default(false),
});

const addTrackSchema = z.object({
    trackId: z.string(),
});

/**
 * @openapi
 * /api/playlists:
 *   get:
 *     summary: Get all playlists for the current user (owned and public)
 *     tags: [Playlists]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of playlists with track counts and ownership info
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *       401:
 *         description: Not authenticated
 */
// GET /playlists
router.get("/", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;

        // Get user's hidden playlists
        const hiddenPlaylists = await prisma.hiddenPlaylist.findMany({
            where: { userId },
            select: { playlistId: true },
        });
        const hiddenPlaylistIds = new Set(
            hiddenPlaylists.map((h) => h.playlistId)
        );

        const playlists = await prisma.playlist.findMany({
            where: {
                OR: [{ userId }, { isPublic: true }],
            },
            orderBy: { createdAt: "desc" },
            include: {
                user: {
                    select: {
                        username: true,
                    },
                },
                items: {
                    include: {
                        track: {
                            include: {
                                album: {
                                    include: {
                                        artist: {
                                            select: {
                                                id: true,
                                                name: true,
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    orderBy: { sort: "asc" },
                },
            },
        });

        const playlistsWithCounts = playlists.map((playlist) => ({
            ...playlist,
            trackCount: playlist.items.length,
            isOwner: playlist.userId === userId,
            isHidden: hiddenPlaylistIds.has(playlist.id),
        }));

        // Debug: log shared playlists with user info
        const sharedPlaylists = playlistsWithCounts.filter((p) => !p.isOwner);
        if (sharedPlaylists.length > 0) {
            logger.debug(
                `[Playlists] Found ${sharedPlaylists.length} shared playlists for user ${userId}:`
            );
            sharedPlaylists.forEach((p) => {
                logger.debug(
                    `  - "${p.name}" by ${
                        p.user?.username || "UNKNOWN"
                    } (owner: ${p.userId})`
                );
            });
        }

        res.json(playlistsWithCounts);
    } catch (error) {
        logger.error("Get playlists error:", error);
        res.status(500).json({ error: "Failed to get playlists" });
    }
});

/**
 * @openapi
 * /api/playlists:
 *   post:
 *     summary: Create a new playlist
 *     tags: [Playlists]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 200
 *               isPublic:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       200:
 *         description: Created playlist
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Not authenticated
 */
// POST /playlists
router.post("/", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;
        const data = createPlaylistSchema.parse(req.body);

        const playlist = await prisma.playlist.create({
            data: {
                userId,
                name: data.name,
                isPublic: data.isPublic,
            },
        });

        res.json(playlist);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.errors });
        }
        logger.error("Create playlist error:", error);
        res.status(500).json({ error: "Failed to create playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}:
 *   get:
 *     summary: Get a single playlist with tracks and pending tracks
 *     tags: [Playlists]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     responses:
 *       200:
 *         description: Playlist details with merged items
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
// GET /playlists/:id
router.get("/:id", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;

        const playlist = await prisma.playlist.findUnique({
            where: { id: req.params.id },
            include: {
                user: {
                    select: {
                        username: true,
                    },
                },
                hiddenByUsers: {
                    where: { userId },
                    select: { id: true },
                },
                items: {
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
                        trackTidal: true,
                        trackYtMusic: true,
                    },
                    orderBy: { sort: "asc" },
                },
                pendingTracks: {
                    orderBy: { sort: "asc" },
                },
            },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        // Check access permissions
        if (!playlist.isPublic && playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Format playlist items
        const formattedItems = playlist.items.map((item) => {
            if (!item.track) {
                if (item.trackTidal) {
                    const tidalTrackId = Number(item.trackTidal.tidalId);
                    const hasValidTidalId =
                        Number.isFinite(tidalTrackId) && tidalTrackId > 0;

                    return {
                        id: item.id,
                        playlistId: item.playlistId,
                        trackId: item.trackId,
                        trackTidalId: item.trackTidalId,
                        trackYtMusicId: item.trackYtMusicId,
                        sort: item.sort,
                        type: "track" as const,
                        provider: {
                            source: "tidal" as const,
                            label: "TIDAL",
                            tidalTrackId: hasValidTidalId ? tidalTrackId : null,
                            youtubeVideoId: null,
                        },
                        playback: hasValidTidalId
                            ? {
                                  isPlayable: true,
                                  reason: null,
                                  message: null,
                              }
                            : {
                                  isPlayable: false,
                                  reason: "missing_tidal_track_id",
                                  message:
                                      "Playback is unavailable because this TIDAL item is missing a valid track id.",
                              },
                        track: {
                            id: hasValidTidalId
                                ? `tidal:${tidalTrackId}`
                                : `tidal:missing:${item.id}`,
                            title: item.trackTidal.title,
                            duration: item.trackTidal.duration,
                            streamSource: "tidal" as const,
                            ...(hasValidTidalId
                                ? { tidalTrackId }
                                : {}),
                            album: {
                                title:
                                    item.trackTidal.album || "Unknown Album",
                                coverArt: null,
                                artist: {
                                    name:
                                        item.trackTidal.artist ||
                                        "Unknown Artist",
                                },
                            },
                        },
                    };
                }

                if (item.trackYtMusic) {
                    const videoId =
                        typeof item.trackYtMusic.videoId === "string"
                            ? item.trackYtMusic.videoId.trim()
                            : "";
                    const hasValidVideoId = videoId.length > 0;

                    return {
                        id: item.id,
                        playlistId: item.playlistId,
                        trackId: item.trackId,
                        trackTidalId: item.trackTidalId,
                        trackYtMusicId: item.trackYtMusicId,
                        sort: item.sort,
                        type: "track" as const,
                        provider: {
                            source: "youtube" as const,
                            label: "YOUTUBE",
                            tidalTrackId: null,
                            youtubeVideoId: hasValidVideoId ? videoId : null,
                        },
                        playback: hasValidVideoId
                            ? {
                                  isPlayable: true,
                                  reason: null,
                                  message: null,
                              }
                            : {
                                  isPlayable: false,
                                  reason: "missing_youtube_video_id",
                                  message:
                                      "Playback is unavailable because this YouTube Music item is missing a video id.",
                              },
                        track: {
                            id: hasValidVideoId
                                ? `yt:${videoId}`
                                : `yt:missing:${item.id}`,
                            title: item.trackYtMusic.title,
                            duration: item.trackYtMusic.duration,
                            streamSource: "youtube" as const,
                            ...(hasValidVideoId
                                ? { youtubeVideoId: videoId }
                                : {}),
                            album: {
                                title:
                                    item.trackYtMusic.album || "Single",
                                coverArt:
                                    item.trackYtMusic.thumbnailUrl || null,
                                artist: {
                                    name:
                                        item.trackYtMusic.artist ||
                                        "Unknown Artist",
                                },
                            },
                        },
                    };
                }

                return {
                    id: item.id,
                    playlistId: item.playlistId,
                    trackId: item.trackId,
                    trackTidalId: item.trackTidalId,
                    trackYtMusicId: item.trackYtMusicId,
                    sort: item.sort,
                    type: "track" as const,
                    provider: {
                        source: "unknown" as const,
                        label: "UNKNOWN",
                        tidalTrackId: null,
                        youtubeVideoId: null,
                    },
                    playback: {
                        isPlayable: false,
                        reason: "missing_provider_track",
                        message:
                            "Playback is unavailable because this playlist item no longer has an attached track source.",
                    },
                    track: null,
                };
            }

            return {
                id: item.id,
                playlistId: item.playlistId,
                trackId: item.trackId,
                trackTidalId: item.trackTidalId,
                trackYtMusicId: item.trackYtMusicId,
                sort: item.sort,
                type: "track" as const,
                provider: {
                    source: "local" as const,
                    label: "LOCAL",
                    tidalTrackId: null,
                    youtubeVideoId: null,
                },
                playback: {
                    isPlayable: true,
                    reason: null,
                    message: null,
                },
                track: {
                    ...item.track,
                    album: {
                        ...item.track.album,
                        coverArt: item.track.album.coverUrl,
                    },
                },
            };
        });

        // Format pending tracks
        const formattedPending = playlist.pendingTracks.map((pending) => ({
            id: pending.id,
            type: "pending" as const,
            sort: pending.sort,
            provider: {
                source: "pending" as const,
                label: "PENDING",
            },
            playback: {
                isPlayable: false,
                reason: "pending_import",
                message:
                    "Playback is unavailable until this track is matched and imported.",
            },
            pending: {
                id: pending.id,
                artist: pending.spotifyArtist,
                title: pending.spotifyTitle,
                album: pending.spotifyAlbum,
                previewUrl: pending.deezerPreviewUrl,
            },
        }));

        // Merge and sort by position
        const mergedItems = [
            ...formattedItems.map((item) => ({ ...item, sort: item.sort })),
            ...formattedPending,
        ].sort((a, b) => a.sort - b.sort);

        res.json({
            ...playlist,
            isOwner: playlist.userId === userId,
            isHidden: playlist.hiddenByUsers.length > 0,
            trackCount: playlist.items.length,
            pendingCount: playlist.pendingTracks.length,
            items: formattedItems,
            pendingTracks: formattedPending,
            mergedItems,
        });
    } catch (error) {
        logger.error("Get playlist error:", error);
        res.status(500).json({ error: "Failed to get playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}:
 *   put:
 *     summary: Update a playlist name and visibility
 *     tags: [Playlists]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 200
 *               isPublic:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Updated playlist
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
// PUT /playlists/:id
router.put("/:id", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;
        const data = createPlaylistSchema.parse(req.body);

        // Check ownership
        const existing = await prisma.playlist.findUnique({
            where: { id: req.params.id },
        });

        if (!existing) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (existing.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        const playlist = await prisma.playlist.update({
            where: { id: req.params.id },
            data: {
                name: data.name,
                isPublic: data.isPublic,
            },
        });

        res.json(playlist);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.errors });
        }
        logger.error("Update playlist error:", error);
        res.status(500).json({ error: "Failed to update playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/hide:
 *   post:
 *     summary: Hide a playlist from your view
 *     tags: [Playlists]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     responses:
 *       200:
 *         description: Playlist hidden
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 isHidden:
 *                   type: boolean
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
// POST /playlists/:id/hide - Hide any playlist from your view
router.post("/:id/hide", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;
        const playlistId = req.params.id;

        // Check playlist exists
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        // User must own the playlist OR it must be public (shared)
        if (playlist.userId !== userId && !playlist.isPublic) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Create hidden record (upsert to handle re-hiding)
        await prisma.hiddenPlaylist.upsert({
            where: {
                userId_playlistId: { userId, playlistId },
            },
            create: { userId, playlistId },
            update: {},
        });

        res.json({ message: "Playlist hidden", isHidden: true });
    } catch (error) {
        logger.error("Hide playlist error:", error);
        res.status(500).json({ error: "Failed to hide playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/hide:
 *   delete:
 *     summary: Unhide a previously hidden playlist
 *     tags: [Playlists]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     responses:
 *       200:
 *         description: Playlist unhidden
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 isHidden:
 *                   type: boolean
 *       401:
 *         description: Not authenticated
 */
// DELETE /playlists/:id/hide - Unhide a shared playlist
router.delete("/:id/hide", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;
        const playlistId = req.params.id;

        // Delete hidden record if exists
        await prisma.hiddenPlaylist.deleteMany({
            where: { userId, playlistId },
        });

        res.json({ message: "Playlist unhidden", isHidden: false });
    } catch (error) {
        logger.error("Unhide playlist error:", error);
        res.status(500).json({ error: "Failed to unhide playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}:
 *   delete:
 *     summary: Delete a playlist
 *     tags: [Playlists]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     responses:
 *       200:
 *         description: Playlist deleted
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
// DELETE /playlists/:id
router.delete("/:id", async (req, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: "Unauthorized" });
        }
        const userId = req.user.id;

        // Check ownership
        const existing = await prisma.playlist.findUnique({
            where: { id: req.params.id },
        });

        if (!existing) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (existing.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        await prisma.playlist.delete({
            where: { id: req.params.id },
        });

        res.json({ message: "Playlist deleted" });
    } catch (error) {
        logger.error("Delete playlist error:", error);
        res.status(500).json({ error: "Failed to delete playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/items:
 *   post:
 *     summary: Add a track to a playlist
 *     tags: [Playlists]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - trackId
 *             properties:
 *               trackId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Track added to playlist (or already exists)
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist or track not found
 *       401:
 *         description: Not authenticated
 */
// POST /playlists/:id/items
router.post("/:id/items", async (req, res) => {
    try {
        if (!req.user) return res.status(401).json({ error: "Unauthorized" });
        const userId = req.user.id;
        const parsedBody = addTrackSchema.safeParse(req.body);
        if (!parsedBody.success) {
            return res.status(400).json({
                error: "Invalid request",
                details: parsedBody.error.errors,
            });
        }
        const { trackId } = parsedBody.data;

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: req.params.id },
            include: {
                items: {
                    orderBy: { sort: "desc" },
                    take: 1,
                },
            },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Check if track exists
        const track = await prisma.track.findUnique({
            where: { id: trackId },
        });

        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        // Check if track already in playlist
        const existing = await prisma.playlistItem.findUnique({
            where: {
                playlistId_trackId: {
                    playlistId: req.params.id,
                    trackId,
                },
            },
        });

        if (existing) {
            return res.status(200).json({
                message: "Track already in playlist",
                duplicated: true,
                item: existing,
            });
        }

        // Get next sort position
        const maxSort = playlist.items[0]?.sort || 0;

        const [item] = await prisma.$transaction([
            prisma.playlistItem.create({
                data: {
                    playlistId: req.params.id,
                    trackId,
                    sort: maxSort + 1,
                },
                include: {
                    track: {
                        include: {
                            album: {
                                include: {
                                    artist: true,
                                },
                            },
                        },
                    },
                },
            }),
            prisma.playlist.update({
                where: { id: req.params.id },
                data: { updatedAt: new Date() },
            }),
        ]);

        res.json(item);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.errors });
        }
        logger.error("Add track to playlist error:", error);
        res.status(500).json({ error: "Failed to add track to playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/items/{trackId}:
 *   delete:
 *     summary: Remove a track from a playlist
 *     tags: [Playlists]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *       - in: path
 *         name: trackId
 *         required: true
 *         schema:
 *           type: string
 *         description: Track ID to remove
 *     responses:
 *       200:
 *         description: Track removed from playlist
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
// DELETE /playlists/:id/items/:trackId
router.delete("/:id/items/:trackId", async (req, res) => {
    try {
        const userId = req.user!.id;

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: req.params.id },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        await prisma.$transaction([
            prisma.playlistItem.delete({
                where: {
                    playlistId_trackId: {
                        playlistId: req.params.id,
                        trackId: req.params.trackId,
                    },
                },
            }),
            prisma.playlist.update({
                where: { id: req.params.id },
                data: { updatedAt: new Date() },
            }),
        ]);

        res.json({ message: "Track removed from playlist" });
    } catch (error) {
        logger.error("Remove track from playlist error:", error);
        res.status(500).json({ error: "Failed to remove track from playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/items/reorder:
 *   put:
 *     summary: Reorder tracks in a playlist
 *     tags: [Playlists]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - trackIds
 *             properties:
 *               trackIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of track IDs in the desired order
 *     responses:
 *       200:
 *         description: Playlist reordered
 *       400:
 *         description: trackIds must be an array
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
// PUT /playlists/:id/items/reorder
router.put("/:id/items/reorder", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { trackIds } = req.body; // Array of track IDs in new order

        if (!Array.isArray(trackIds)) {
            return res.status(400).json({ error: "trackIds must be an array" });
        }

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: req.params.id },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Update sort order for each track
        const updates = trackIds.map((trackId, index) =>
            prisma.playlistItem.update({
                where: {
                    playlistId_trackId: {
                        playlistId: req.params.id,
                        trackId,
                    },
                },
                data: { sort: index },
            })
        );

        await prisma.$transaction([
            ...updates,
            prisma.playlist.update({
                where: { id: req.params.id },
                data: { updatedAt: new Date() },
            }),
        ]);

        res.json({ message: "Playlist reordered" });
    } catch (error) {
        logger.error("Reorder playlist error:", error);
        res.status(500).json({ error: "Failed to reorder playlist" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/pending:
 *   get:
 *     summary: Get pending tracks for a playlist (unmatched Spotify imports)
 *     tags: [Playlists]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     responses:
 *       200:
 *         description: Pending tracks list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count:
 *                   type: integer
 *                 tracks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 spotifyPlaylistId:
 *                   type: string
 *                   nullable: true
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
router.get("/:id/pending", async (req, res) => {
    try {
        const userId = req.user!.id;
        const playlistId = req.params.id;

        // Check ownership or public access
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId && !playlist.isPublic) {
            return res.status(403).json({ error: "Access denied" });
        }

        const pendingTracks = await prisma.playlistPendingTrack.findMany({
            where: { playlistId },
            orderBy: { sort: "asc" },
        });

        res.json({
            count: pendingTracks.length,
            tracks: pendingTracks.map((t) => ({
                id: t.id,
                artist: t.spotifyArtist,
                title: t.spotifyTitle,
                album: t.spotifyAlbum,
                position: t.sort,
                previewUrl: t.deezerPreviewUrl,
            })),
            spotifyPlaylistId: playlist.spotifyPlaylistId,
        });
    } catch (error) {
        logger.error("Get pending tracks error:", error);
        res.status(500).json({ error: "Failed to get pending tracks" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/pending/{trackId}:
 *   delete:
 *     summary: Remove a pending track from a playlist
 *     tags: [Playlists]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *       - in: path
 *         name: trackId
 *         required: true
 *         schema:
 *           type: string
 *         description: Pending track ID
 *     responses:
 *       200:
 *         description: Pending track removed
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist or pending track not found
 *       401:
 *         description: Not authenticated
 */
router.delete("/:id/pending/:trackId", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { id: playlistId, trackId: pendingTrackId } = req.params;

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        await prisma.playlistPendingTrack.delete({
            where: { id: pendingTrackId },
        });

        res.json({ message: "Pending track removed" });
    } catch (error: any) {
        if (error.code === "P2025") {
            return res.status(404).json({ error: "Pending track not found" });
        }
        logger.error("Delete pending track error:", error);
        res.status(500).json({ error: "Failed to delete pending track" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/pending/{trackId}/preview:
 *   get:
 *     summary: Get a fresh Deezer preview URL for a pending track
 *     tags: [Playlists]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *       - in: path
 *         name: trackId
 *         required: true
 *         schema:
 *           type: string
 *         description: Pending track ID
 *     responses:
 *       200:
 *         description: Fresh preview URL
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 previewUrl:
 *                   type: string
 *       404:
 *         description: Pending track not found or no preview available
 *       401:
 *         description: Not authenticated
 */
router.get("/:id/pending/:trackId/preview", async (req, res) => {
    try {
        const { trackId: pendingTrackId } = req.params;

        // Get the pending track
        const pendingTrack = await prisma.playlistPendingTrack.findUnique({
            where: { id: pendingTrackId },
        });

        if (!pendingTrack) {
            return res.status(404).json({ error: "Pending track not found" });
        }

        // Fetch fresh Deezer preview URL
        const { deezerService } = await import("../services/deezer");
        const previewUrl = await deezerService.getTrackPreview(
            pendingTrack.spotifyArtist,
            pendingTrack.spotifyTitle
        );

        if (!previewUrl) {
            return res
                .status(404)
                .json({ error: "No preview available on Deezer" });
        }

        // Update the stored preview URL for future use
        await prisma.playlistPendingTrack.update({
            where: { id: pendingTrackId },
            data: { deezerPreviewUrl: previewUrl },
        });

        res.json({ previewUrl });
    } catch (error: any) {
        logger.error("Get preview URL error:", error);
        res.status(500).json({ error: "Failed to get preview URL" });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/pending/{trackId}/retry:
 *   post:
 *     summary: Retry downloading a pending track from Soulseek
 *     description: Returns immediately and downloads in background. Triggers a library scan after download.
 *     tags: [Playlists]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *       - in: path
 *         name: trackId
 *         required: true
 *         schema:
 *           type: string
 *         description: Pending track ID
 *     responses:
 *       200:
 *         description: Download started or track not found on Soulseek
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 downloadJobId:
 *                   type: string
 *       400:
 *         description: Music path or Soulseek credentials not configured
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist or pending track not found
 *       401:
 *         description: Not authenticated
 */
router.post("/:id/pending/:trackId/retry", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { id: playlistId, trackId: pendingTrackId } = req.params;

        sessionLog(
            "PENDING-RETRY",
            `Request: userId=${userId} playlistId=${playlistId} pendingTrackId=${pendingTrackId}`
        );

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist) {
            sessionLog(
                "PENDING-RETRY",
                `Playlist not found: ${playlistId}`,
                "WARN"
            );
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            sessionLog(
                "PENDING-RETRY",
                `Access denied: playlistId=${playlistId} userId=${userId}`,
                "WARN"
            );
            return res.status(403).json({ error: "Access denied" });
        }

        // Get the pending track
        const pendingTrack = await prisma.playlistPendingTrack.findUnique({
            where: { id: pendingTrackId },
        });

        if (!pendingTrack) {
            sessionLog(
                "PENDING-RETRY",
                `Pending track not found: ${pendingTrackId}`,
                "WARN"
            );
            return res.status(404).json({ error: "Pending track not found" });
        }

        sessionLog(
            "PENDING-RETRY",
            `Pending track: artist="${pendingTrack.spotifyArtist}" title="${pendingTrack.spotifyTitle}" album="${pendingTrack.spotifyAlbum}"`
        );

        // Create a DownloadJob so this retry appears in Activity (active/history)
        const retryTargetId =
            pendingTrack.albumMbid ||
            pendingTrack.artistMbid ||
            `pendingTrack:${pendingTrack.id}`;

        const downloadJob = await prisma.downloadJob.create({
            data: {
                userId,
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

        sessionLog(
            "PENDING-RETRY",
            `Created download job: downloadJobId=${downloadJob.id} target=${retryTargetId}`
        );

        // Import soulseek service and try to download
        const { soulseekService } = await import("../services/soulseek");
        const { getSystemSettings } = await import("../utils/systemSettings");

        const settings = await getSystemSettings();
        if (!settings?.musicPath) {
            sessionLog("PENDING-RETRY", `Music path not configured`, "WARN");
            await prisma.downloadJob.update({
                where: { id: downloadJob.id },
                data: {
                    status: "failed",
                    error: "Music path not configured",
                    completedAt: new Date(),
                },
            });
            return res.status(400).json({ error: "Music path not configured" });
        }

        if (!settings?.soulseekUsername || !settings?.soulseekPassword) {
            sessionLog(
                "PENDING-RETRY",
                `Soulseek credentials not configured`,
                "WARN"
            );
            await prisma.downloadJob.update({
                where: { id: downloadJob.id },
                data: {
                    status: "failed",
                    error: "Soulseek credentials not configured",
                    completedAt: new Date(),
                },
            });
            return res
                .status(400)
                .json({ error: "Soulseek credentials not configured" });
        }

        // Use a better album name if possible - extract from stored title or use artist name
        const albumName =
            pendingTrack.spotifyAlbum !== "Unknown Album"
                ? pendingTrack.spotifyAlbum
                : pendingTrack.spotifyArtist; // Use artist as fallback folder name

        logger.debug(
            `[Retry] Starting download for: ${pendingTrack.spotifyArtist} - ${pendingTrack.spotifyTitle}`
        );
        sessionLog(
            "PENDING-RETRY",
            `Search: ${pendingTrack.spotifyArtist} - ${pendingTrack.spotifyTitle}`
        );

        // First do a quick search to see if track is available (15s timeout)
        // This way we can tell the user immediately if it's not found
        const searchResult = await soulseekService.searchTrack(
            pendingTrack.spotifyArtist,
            pendingTrack.spotifyTitle
        );

        if (!searchResult.found || searchResult.allMatches.length === 0) {
            logger.debug(`[Retry] No results found on Soulseek`);
            sessionLog("PENDING-RETRY", `No results found on Soulseek`, "INFO");

            await prisma.downloadJob.update({
                where: { id: downloadJob.id },
                data: {
                    status: "failed",
                    error: "No matching files found",
                    completedAt: new Date(),
                },
            });

            return res.status(200).json({
                success: false,
                message: "Track not found on Soulseek",
                error: "No matching files found",
            });
        }

        logger.debug(
            `[Retry] ✓ Found ${searchResult.allMatches.length} results, starting download in background`
        );
        sessionLog(
            "PENDING-RETRY",
            `Found ${searchResult.allMatches.length} candidate(s); starting background download`
        );

        // Return immediately - download happens in background
        res.json({
            success: true,
            message: "Download started",
            note: `Found ${searchResult.allMatches.length} sources. Downloading... Track will appear after scan.`,
            downloadJobId: downloadJob.id,
        });

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
                    logger.debug(
                        `[Retry] ✓ Download complete: ${result.filePath}`
                    );
                    sessionLog(
                        "PENDING-RETRY",
                        `Download complete: filePath=${result.filePath}`
                    );

                    await prisma.downloadJob.update({
                        where: { id: downloadJob.id },
                        data: {
                            status: "completed",
                            completedAt: new Date(),
                            metadata: {
                                ...(downloadJob.metadata as any),
                                filePath: result.filePath,
                            },
                        },
                    });

                    // Trigger a library scan to add the track and reconcile pending
                    try {
                        const { scanQueue } = await import("../workers/queues");
                        const scanJob = await scanQueue.add(
                            "scan",
                            {
                                userId,
                                source: "retry-pending-track",
                                albumMbid: pendingTrack.albumMbid || undefined,
                                artistMbid:
                                    pendingTrack.artistMbid || undefined,
                            },
                            {
                                priority: 1, // High priority
                                removeOnComplete: true,
                            }
                        );
                        logger.debug(
                            `[Retry] Queued library scan to reconcile pending tracks`
                        );
                        sessionLog(
                            "PENDING-RETRY",
                            `Queued library scan (bullJobId=${
                                scanJob.id ?? "unknown"
                            })`
                        );
                    } catch (scanError) {
                        logger.error(
                            `[Retry] Failed to queue scan:`,
                            scanError
                        );
                        sessionLog(
                            "PENDING-RETRY",
                            `Failed to queue scan: ${
                                (scanError as any)?.message || scanError
                            }`,
                            "ERROR"
                        );
                    }
                } else {
                    logger.debug(`[Retry] Download failed: ${result.error}`);
                    sessionLog(
                        "PENDING-RETRY",
                        `Download failed: ${result.error || "unknown error"}`,
                        "WARN"
                    );

                    await prisma.downloadJob.update({
                        where: { id: downloadJob.id },
                        data: {
                            status: "failed",
                            error: result.error || "Download failed",
                            completedAt: new Date(),
                        },
                    });
                }
            })
            .catch((error) => {
                logger.error(`[Retry] Download error:`, error);
                sessionLog(
                    "PENDING-RETRY",
                    `Download exception: ${error?.message || error}`,
                    "ERROR"
                );

                prisma.downloadJob
                    .update({
                        where: { id: downloadJob.id },
                        data: {
                            status: "failed",
                            error: error?.message || "Download exception",
                            completedAt: new Date(),
                        },
                    })
                    .catch(() => undefined);
            });
    } catch (error: any) {
        logger.error("Retry pending track error:", error);
        sessionLog(
            "PENDING-RETRY",
            `Handler error: ${error?.message || error}`,
            "ERROR"
        );
        res.status(500).json({
            error: "Failed to retry download",
            details: error.message,
        });
    }
});

/**
 * @openapi
 * /api/playlists/{id}/pending/reconcile:
 *   post:
 *     summary: Manually trigger reconciliation of pending tracks for a playlist
 *     tags: [Playlists]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Playlist ID
 *     responses:
 *       200:
 *         description: Reconciliation complete
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 tracksAdded:
 *                   type: integer
 *                 playlistsUpdated:
 *                   type: integer
 *       403:
 *         description: Access denied
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
router.post("/:id/pending/reconcile", async (req, res) => {
    try {
        const userId = req.user!.id;
        const playlistId = req.params.id;

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Import and run reconciliation
        const { spotifyImportService } = await import(
            "../services/spotifyImport"
        );
        const result = await spotifyImportService.reconcilePendingTracks();

        res.json({
            message: "Reconciliation complete",
            tracksAdded: result.tracksAdded,
            playlistsUpdated: result.playlistsUpdated,
        });
    } catch (error) {
        logger.error("Reconcile pending tracks error:", error);
        res.status(500).json({ error: "Failed to reconcile pending tracks" });
    }
});

export default router;
