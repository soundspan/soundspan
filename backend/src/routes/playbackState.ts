import express from "express";
import { logger } from "../utils/logger";
import { prisma, Prisma } from "../utils/db";
import { requireAuth } from "../middleware/auth";
import { playbackStateLimiter } from "../middleware/rateLimiter";
import { publishSocialPresenceUpdate } from "../services/socialPresenceEvents";
import {
    normalizeCanonicalMediaProviderIdentity,
    toLegacyStreamFields,
} from "@soundspan/media-metadata-contract";
import { isForeignKeyViolationOn } from "../utils/prismaErrors";

const router = express.Router();
const PLAYBACK_STATE_AUDIOBOOK_FK = "PlaybackState_audiobookId_fkey";

type PlaybackStateUpsertArgs = {
    where: Prisma.PlaybackStateWhereUniqueInput;
    update: Prisma.PlaybackStateUncheckedUpdateInput;
    create: Prisma.PlaybackStateUncheckedCreateInput;
};

async function upsertPlaybackStateWithAudiobookRetry(
    args: PlaybackStateUpsertArgs,
) {
    try {
        return await prisma.playbackState.upsert(args);
    } catch (error: unknown) {
        if (!isForeignKeyViolationOn(error, PLAYBACK_STATE_AUDIOBOOK_FK)) {
            throw error;
        }
        return prisma.playbackState.upsert({
            ...args,
            update: { ...args.update, audiobookId: null },
            create: { ...args.create, audiobookId: null },
        });
    }
}

function getPlaybackDeviceId(req: express.Request): string {
    const raw = req.header("X-Playback-Device-Id") || "legacy";
    const trimmed = raw.trim();
    if (!trimmed) return "legacy";
    // Keep identifiers bounded to avoid untrusted oversized header values
    return trimmed.substring(0, 128);
}

function sanitizeOptionalString(
    value: unknown,
    maxLen: number,
): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.substring(0, maxLen);
}

/**
 * Sanitizes a podcast-episode queue item from a mixed-media queue payload.
 * Episode entries are flagged with `itemType: "episode"` and identified by a
 * composite "podcastId:episodeId" id; missing podcastId/episodeId fields are
 * derived from the composite id. Returns null when the identity is unusable.
 */
function sanitizeEpisodeQueueItem(item: any): Record<string, unknown> | null {
    const id = String(item.id || "");
    const [idPodcastId = "", idEpisodeId = ""] = id.split(":");
    const podcastId = String(item.podcastId || idPodcastId || "").substring(
        0,
        128,
    );
    const episodeId = String(item.episodeId || idEpisodeId || "").substring(
        0,
        128,
    );
    if (!podcastId || !episodeId) return null;

    return {
        itemType: "episode",
        id: `${podcastId}:${episodeId}`,
        title: String(item.title || "Unknown").substring(0, 500),
        podcastTitle: String(item.podcastTitle || "").substring(0, 500),
        podcastId,
        episodeId,
        coverUrl: item.coverUrl
            ? String(item.coverUrl).substring(0, 1000)
            : null,
        duration: Number(item.duration) || 0,
    };
}

/**
 * Sanitizes a music-track queue item, keeping only the essential fields to
 * reduce JSON size. Items without an `itemType` are treated as tracks
 * (legacy clients) and tagged with `itemType: "track"`.
 */
function sanitizeTrackQueueItem(item: any): Record<string, unknown> {
    const provider = normalizeCanonicalMediaProviderIdentity({
        mediaSource: item.mediaSource,
        streamSource: item.streamSource,
        sourceType: item.sourceType,
        providerTrackId: item.provider?.providerTrackId ?? item.providerTrackId,
        tidalTrackId: item.provider?.tidalTrackId ?? item.tidalTrackId,
        youtubeVideoId: item.provider?.youtubeVideoId ?? item.youtubeVideoId,
        youtubeAudioFormat:
            item.provider?.youtubeAudioFormat ?? item.youtubeAudioFormat,
    });
    const sanitizedProvider = {
        source: provider.source,
        ...(sanitizeOptionalString(provider.providerTrackId, 128)
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
        ...(sanitizeOptionalString(provider.youtubeVideoId, 64)
            ? {
                  youtubeVideoId: sanitizeOptionalString(
                      provider.youtubeVideoId,
                      64,
                  ),
              }
            : {}),
        ...(provider.youtubeAudioFormat
            ? { youtubeAudioFormat: provider.youtubeAudioFormat }
            : {}),
    };

    return {
        itemType: "track",
        mediaSource: provider.source,
        provider: sanitizedProvider,
        ...toLegacyStreamFields(provider),
        id: String(item.id || ""),
        title: String(item.title || "Unknown").substring(0, 500),
        duration: Number(item.duration) || 0,
        artist: item.artist
            ? {
                  id: String(item.artist.id || ""),
                  name: String(item.artist.name || "Unknown").substring(0, 200),
              }
            : null,
        album: item.album
            ? {
                  id: String(item.album.id || ""),
                  title: String(item.album.title || "Unknown").substring(
                      0,
                      500,
                  ),
                  coverArt: item.album.coverArt
                      ? String(item.album.coverArt).substring(0, 1000)
                      : null,
              }
            : null,
    };
}

/**
 * @openapi
 * /api/playback-state:
 *   get:
 *     summary: Get current playback state for the authenticated user
 *     tags: [Playback State]
 *     security:
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
router.get("/", playbackStateLimiter, requireAuth, async (req, res) => {
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
            await upsertPlaybackStateWithAudiobookRetry({
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
 *                 description: >-
 *                   Mixed-media queue items. Entries with itemType "episode"
 *                   are podcast episodes ({itemType, id, title, podcastTitle,
 *                   podcastId, episodeId, coverUrl, duration}); all other
 *                   entries are music tracks (itemType defaults to "track"
 *                   for legacy clients).
 *                 items:
 *                   type: object
 *                   properties:
 *                     itemType:
 *                       type: string
 *                       enum: [track, episode]
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
router.post("/", playbackStateLimiter, requireAuth, async (req, res) => {
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
            logger.warn(
                `[PlaybackState] Invalid playbackType: ${playbackType}`,
            );
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
                        .map((item: any) => {
                            // Mixed-media queues: podcast episode entries are
                            // persisted in their own compact shape.
                            if (item.itemType === "episode") {
                                return sanitizeEpisodeQueueItem(item);
                            }
                            return sanitizeTrackQueueItem(item);
                        })
                        .filter(
                            (item: Record<string, unknown> | null) =>
                                item !== null,
                        );
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
            updatePayload.queue =
                safeQueue === null ? Prisma.DbNull : safeQueue;
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

        const playbackState = await upsertPlaybackStateWithAudiobookRetry({
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
        logger.error(
            "[PlaybackState] Error saving state:",
            error?.message || error,
        );
        logger.error(
            "[PlaybackState] Full error:",
            JSON.stringify(error, Object.getOwnPropertyNames(error), 2),
        );
        if (error?.code) {
            logger.error("[PlaybackState] Error code:", error.code);
        }
        if (error?.meta) {
            logger.error("[PlaybackState] Prisma meta:", error.meta);
        }
        // Raw failure detail is available only in the server logs above.
        res.status(500).json({ error: "Failed to save playback state" });
    }
});

/**
 * @openapi
 * /api/playback-state:
 *   delete:
 *     summary: Clear playback state when the user stops playback
 *     tags: [Playback State]
 *     security:
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
router.delete("/", playbackStateLimiter, requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id;
        const deviceId = getPlaybackDeviceId(req);

        // An explicit clear must also remove the shared "legacy" row;
        // otherwise the GET fallback re-migrates it onto this device and
        // the cleared queue resurrects on the next playback-state poll.
        await prisma.playbackState.deleteMany({
            where: { userId, deviceId: { in: [deviceId, "legacy"] } },
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
