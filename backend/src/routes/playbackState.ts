import express from "express";
import { logger } from "../utils/logger";
import { prisma, Prisma } from "../utils/db";
import { requireAuth } from "../middleware/auth";
import { publishSocialPresenceUpdate } from "../services/socialPresenceEvents";
import {
    normalizeCanonicalMediaProviderIdentity,
    toLegacyStreamFields,
} from "@soundspan/media-metadata-contract";

const router = express.Router();

function getPlaybackDeviceId(req: express.Request): string {
    const raw = req.header("X-Playback-Device-Id") || "legacy";
    const trimmed = raw.trim();
    if (!trimmed) return "legacy";
    // Keep identifiers bounded to avoid untrusted oversized header values
    return trimmed.substring(0, 128);
}

function sanitizeOptionalString(
    value: unknown,
    maxLen: number
): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.substring(0, maxLen);
}

/**
 * @openapi
 * /api/playback-state:
 *   get:
 *     summary: Get current playback state for the authenticated user
 *     tags: [Playback State]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: header
 *         name: X-Playback-Device-Id
 *         schema:
 *           type: string
 *         description: Device identifier (defaults to "legacy")
 *     responses:
 *       200:
 *         description: Current playback state or null if none exists
 *       401:
 *         description: Not authenticated
 */
// Get current playback state for the authenticated user
router.get("/", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id;
        const deviceId = getPlaybackDeviceId(req);

        const playbackState = await prisma.playbackState.findUnique({
            where: { userId_deviceId: { userId, deviceId } },
        });

        if (playbackState) {
            return res.json(playbackState);
        }

        // Backward compatibility for pre-device rows
        const legacyState = await prisma.playbackState.findUnique({
            where: { userId_deviceId: { userId, deviceId: "legacy" } },
        });

        if (!legacyState) {
            return res.json(null);
        }

        // Opportunistically migrate legacy state to this device without removing legacy.
        // Multiple active devices can copy once and then diverge independently.
        if (deviceId !== "legacy") {
            await prisma.playbackState.upsert({
                where: { userId_deviceId: { userId, deviceId } },
                update: {
                    playbackType: legacyState.playbackType,
                    trackId: legacyState.trackId,
                    audiobookId: legacyState.audiobookId,
                    podcastId: legacyState.podcastId,
                    queue: legacyState.queue ?? Prisma.DbNull,
                    currentIndex: legacyState.currentIndex,
                    isShuffle: legacyState.isShuffle,
                    isPlaying: legacyState.isPlaying,
                    currentTime: legacyState.currentTime,
                },
                create: {
                    userId,
                    deviceId,
                    playbackType: legacyState.playbackType,
                    trackId: legacyState.trackId,
                    audiobookId: legacyState.audiobookId,
                    podcastId: legacyState.podcastId,
                    queue: legacyState.queue ?? Prisma.DbNull,
                    currentIndex: legacyState.currentIndex,
                    isShuffle: legacyState.isShuffle,
                    isPlaying: legacyState.isPlaying,
                    currentTime: legacyState.currentTime,
                },
            });
        }

        res.json(legacyState);
    } catch (error) {
        logger.error("Get playback state error:", error);
        res.status(500).json({ error: "Failed to get playback state" });
    }
});

/**
 * @openapi
 * /api/playback-state:
 *   post:
 *     summary: Update current playback state for the authenticated user
 *     tags: [Playback State]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: header
 *         name: X-Playback-Device-Id
 *         schema:
 *           type: string
 *         description: Device identifier (defaults to "legacy")
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - playbackType
 *             properties:
 *               playbackType:
 *                 type: string
 *                 enum: [track, audiobook, podcast]
 *               trackId:
 *                 type: string
 *               audiobookId:
 *                 type: string
 *               podcastId:
 *                 type: string
 *               queue:
 *                 type: array
 *                 items:
 *                   type: object
 *               currentIndex:
 *                 type: integer
 *               isShuffle:
 *                 type: boolean
 *               isPlaying:
 *                 type: boolean
 *               currentTime:
 *                 type: number
 *     responses:
 *       200:
 *         description: Playback state updated
 *       400:
 *         description: Invalid playbackType or missing required fields
 *       401:
 *         description: Not authenticated
 */
// Update current playback state for the authenticated user
router.post("/", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id;
        const deviceId = getPlaybackDeviceId(req);
        const {
            playbackType,
            trackId,
            audiobookId,
            podcastId,
            queue,
            currentIndex,
            isShuffle,
            isPlaying,
            currentTime,
        } = req.body;

        // Validate required field
        if (!playbackType) {
            return res.status(400).json({ error: "playbackType is required" });
        }

        // Validate playback type
        const validPlaybackTypes = ["track", "audiobook", "podcast"];
        if (!validPlaybackTypes.includes(playbackType)) {
            logger.warn(`[PlaybackState] Invalid playbackType: ${playbackType}`);
            return res.status(400).json({ error: "Invalid playbackType" });
        }

        const hasExplicitQueue = Array.isArray(queue);
        const hasExplicitCurrentIndex = Number.isInteger(currentIndex);
        const hasExplicitCurrentTime =
            typeof currentTime === "number" && Number.isFinite(currentTime);
        const hasExplicitIsShuffle = typeof isShuffle === "boolean";
        const hasExplicitIsPlaying = typeof isPlaying === "boolean";
        const safeIsPlaying = hasExplicitIsPlaying ? isPlaying : false;
        const safeCurrentTime = hasExplicitCurrentTime
            ? Math.max(0, currentTime)
            : 0;

        // `undefined` means caller omitted queue and we should preserve persisted value.
        let safeQueue: any[] | null | undefined = undefined;
        if (hasExplicitQueue) {
            safeQueue = null;
            if (queue.length > 0) {
                // Only keep essential fields from each queue item to reduce JSON size.
                try {
                    safeQueue = queue
                        .slice(0, 100)
                        .filter((item: any) => item && item.id)
                        .map((item: any) => ({
                            ...(() => {
                                const provider = normalizeCanonicalMediaProviderIdentity({
                                    mediaSource: item.mediaSource,
                                    streamSource: item.streamSource,
                                    sourceType: item.sourceType,
                                    providerTrackId:
                                        item.provider?.providerTrackId ??
                                        item.providerTrackId,
                                    tidalTrackId:
                                        item.provider?.tidalTrackId ??
                                        item.tidalTrackId,
                                    youtubeVideoId:
                                        item.provider?.youtubeVideoId ??
                                        item.youtubeVideoId,
                                });
                                const sanitizedProvider = {
                                    source: provider.source,
                                    ...(sanitizeOptionalString(
                                        provider.providerTrackId,
                                        128,
                                    )
                                        ? {
                                              providerTrackId: sanitizeOptionalString(
                                                  provider.providerTrackId,
                                                  128,
                                              ),
                                          }
                                        : {}),
                                    ...(typeof provider.tidalTrackId === "number" &&
                                    Number.isFinite(provider.tidalTrackId)
                                        ? { tidalTrackId: provider.tidalTrackId }
                                        : {}),
                                    ...(sanitizeOptionalString(
                                        provider.youtubeVideoId,
                                        64,
                                    )
                                        ? {
                                              youtubeVideoId: sanitizeOptionalString(
                                                  provider.youtubeVideoId,
                                                  64,
                                              ),
                                          }
                                        : {}),
                                };

                                return {
                                    mediaSource: provider.source,
                                    provider: sanitizedProvider,
                                    ...toLegacyStreamFields(provider),
                                };
                            })(),
                            id: String(item.id || ""),
                            title: String(item.title || "Unknown").substring(0, 500),
                            duration: Number(item.duration) || 0,
                            artist: item.artist
                                ? {
                                      id: String(item.artist.id || ""),
                                      name: String(item.artist.name || "Unknown").substring(
                                          0,
                                          200,
                                      ),
                                  }
                                : null,
                            album: item.album
                                ? {
                                      id: String(item.album.id || ""),
                                      title: String(
                                          item.album.title || "Unknown",
                                      ).substring(0, 500),
                                      coverArt: item.album.coverArt
                                          ? String(item.album.coverArt).substring(
                                                0,
                                                1000,
                                            )
                                          : null,
                                  }
                                : null,
                        }));
                    if (safeQueue.length === 0) {
                        safeQueue = null;
                    }
                } catch (sanitizeError: any) {
                    logger.error(
                        "[PlaybackState] Queue sanitization failed:",
                        sanitizeError?.message,
                    );
                    safeQueue = null;
                }
            }
        }

        const safeCurrentIndexFromPayload = hasExplicitCurrentIndex
            ? Math.max(0, currentIndex)
            : 0;
        const safeCurrentIndex =
            safeQueue !== undefined
                ? Math.min(
                      safeCurrentIndexFromPayload,
                      safeQueue?.length ? safeQueue.length - 1 : 0,
                  )
                : safeCurrentIndexFromPayload;

        const updatePayload: Prisma.PlaybackStateUncheckedUpdateInput = {
            playbackType,
            trackId: trackId || null,
            audiobookId: audiobookId || null,
            podcastId: podcastId || null,
            ...(hasExplicitIsPlaying ? { isPlaying: safeIsPlaying } : {}),
        };
        if (safeQueue !== undefined) {
            updatePayload.queue = safeQueue === null ? Prisma.DbNull : safeQueue;
        }
        if (hasExplicitCurrentIndex || safeQueue !== undefined) {
            updatePayload.currentIndex = safeCurrentIndex;
        }
        if (hasExplicitIsShuffle) {
            updatePayload.isShuffle = isShuffle;
        }
        if (hasExplicitCurrentTime) {
            updatePayload.currentTime = safeCurrentTime;
        }

        const createPayload: Prisma.PlaybackStateUncheckedCreateInput = {
            userId,
            deviceId,
            playbackType,
            trackId: trackId || null,
            audiobookId: audiobookId || null,
            podcastId: podcastId || null,
            queue:
                safeQueue === undefined || safeQueue === null
                    ? Prisma.DbNull
                    : safeQueue,
            currentIndex:
                hasExplicitCurrentIndex || safeQueue !== undefined
                    ? safeCurrentIndex
                    : 0,
            isShuffle: hasExplicitIsShuffle ? isShuffle : false,
            isPlaying: safeIsPlaying,
            currentTime: hasExplicitCurrentTime ? safeCurrentTime : 0,
        };

        const playbackState = await prisma.playbackState.upsert({
            where: { userId_deviceId: { userId, deviceId } },
            update: updatePayload,
            create: createPayload,
        });
        publishSocialPresenceUpdate({
            userId,
            deviceId,
            reason: "playback-state",
            timestampMs: Date.now(),
        });

        res.json(playbackState);
    } catch (error: any) {
        logger.error("[PlaybackState] Error saving state:", error?.message || error);
        logger.error("[PlaybackState] Full error:", JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
        if (error?.code) {
            logger.error("[PlaybackState] Error code:", error.code);
        }
        if (error?.meta) {
            logger.error("[PlaybackState] Prisma meta:", error.meta);
        }
        // Return more specific error for debugging
        res.status(500).json({ 
            error: "Internal server error",
            details: error?.message || "Unknown error"
        });
    }
});

/**
 * @openapi
 * /api/playback-state:
 *   delete:
 *     summary: Clear playback state when the user stops playback
 *     tags: [Playback State]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: header
 *         name: X-Playback-Device-Id
 *         schema:
 *           type: string
 *         description: Device identifier (defaults to "legacy")
 *     responses:
 *       200:
 *         description: Playback state cleared
 *       401:
 *         description: Not authenticated
 */
// Clear playback state (when user stops playback completely)
router.delete("/", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id;
        const deviceId = getPlaybackDeviceId(req);

        await prisma.playbackState.deleteMany({
            where: { userId, deviceId },
        });
        publishSocialPresenceUpdate({
            userId,
            deviceId,
            reason: "playback-state-cleared",
            timestampMs: Date.now(),
        });

        res.json({ success: true });
    } catch (error) {
        logger.error("Delete playback state error:", error);
        res.status(500).json({ error: "Failed to delete playback state" });
    }
});

export default router;
