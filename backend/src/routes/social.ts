import express from "express";
import { requireAuth, requireAuthOrToken, requireAdmin } from "../middleware/auth";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { publishSocialPresenceUpdate } from "../services/socialPresenceEvents";

const router = express.Router();

/**
 * @openapi
 * /api/social/profile-picture/{userId}:
 *   get:
 *     summary: Get a user's profile picture
 *     description: Serves the profile picture as JPEG. Uses query token auth since img tags cannot send Authorization headers.
 *     tags: [Social]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: The user ID whose profile picture to retrieve
 *     responses:
 *       200:
 *         description: Profile picture image
 *         content:
 *           image/jpeg:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: No profile picture found
 *       401:
 *         description: Not authenticated
 */
// Profile picture serving — must be before router-level requireAuth
// because <img> tags can't send Authorization headers; uses query token instead
router.get("/profile-picture/:userId", requireAuthOrToken, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.params.userId },
            select: { profilePicture: true },
        });

        if (!user?.profilePicture) {
            return res.status(404).json({ error: "No profile picture" });
        }

        res.set("Content-Type", "image/jpeg");
        res.set("Cache-Control", "public, max-age=300");
        return res.send(Buffer.from(user.profilePicture));
    } catch (error) {
        logger.error("[Social] Failed to serve profile picture:", error);
        return res.status(500).json({ error: "Failed to get profile picture" });
    }
});

router.use(requireAuth);

const PRESENCE_KEY_PREFIX = "social:presence:user:";
const PRESENCE_TTL_SECONDS = 75;
const PAUSED_TO_IDLE_CUTOFF_MS = 5 * 60 * 1000;

type ListeningStatus = "playing" | "paused" | "idle";

type QueueTrackProjection = {
    id: string;
    title: string;
    duration: number;
    artistName: string;
    artistId: string | null;
    albumTitle: string;
    albumId: string | null;
    coverArt: string | null;
};

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function getElapsedMs(value: unknown): number | null {
    const timestamp =
        value instanceof Date
            ? value.getTime()
            : typeof value === "string"
              ? Date.parse(value)
              : Number.NaN;

    if (!Number.isFinite(timestamp)) return null;
    return Math.max(0, Date.now() - timestamp);
}

function extractQueueTrack(
    queueRaw: unknown,
    currentIndex: number
): QueueTrackProjection | null {
    if (!Array.isArray(queueRaw)) return null;
    const candidate = queueRaw[currentIndex];
    if (!candidate || typeof candidate !== "object") return null;

    const item = candidate as Record<string, unknown>;
    const artist =
        item.artist && typeof item.artist === "object"
            ? (item.artist as Record<string, unknown>)
            : null;
    const album =
        item.album && typeof item.album === "object"
            ? (item.album as Record<string, unknown>)
            : null;

    if (
        typeof item.id !== "string" ||
        typeof item.title !== "string" ||
        typeof item.duration !== "number" ||
        !artist ||
        typeof artist.name !== "string" ||
        !album ||
        typeof album.title !== "string"
    ) {
        return null;
    }

    return {
        id: item.id,
        title: item.title,
        duration: item.duration,
        artistName: artist.name,
        artistId: asNonEmptyString(artist.id),
        albumTitle: album.title,
        albumId: asNonEmptyString(album.id),
        coverArt:
            typeof album.coverArt === "string" ? album.coverArt : null,
    };
}

function resolveListeningStatus(
    shareListening: boolean,
    latestPlaybackState: {
        playbackType: string;
        isPlaying: boolean;
        updatedAt: Date;
    } | null | undefined,
    listeningTrack: QueueTrackProjection | null
): ListeningStatus {
    if (!shareListening) return "idle";
    if (!latestPlaybackState || latestPlaybackState.playbackType !== "track") {
        return "idle";
    }
    if (!listeningTrack) return "idle";
    if (latestPlaybackState.isPlaying) return "playing";

    const elapsedMs = getElapsedMs(latestPlaybackState.updatedAt);
    if (elapsedMs === null || elapsedMs > PAUSED_TO_IDLE_CUTOFF_MS) {
        return "idle";
    }
    return "paused";
}

async function getOnlinePresenceMap(): Promise<Map<string, number>> {
    const keys: string[] = [];

    try {
        for await (const key of redisClient.scanIterator({
            MATCH: `${PRESENCE_KEY_PREFIX}*`,
            COUNT: 250,
        })) {
            if (typeof key === "string") {
                keys.push(key);
            }
        }

        if (keys.length === 0) {
            return new Map();
        }

        const values = await redisClient.mGet(keys);
        const byUserId = new Map<string, number>();

        keys.forEach((key, idx) => {
            const rawValue = values[idx];
            const userId = key.slice(PRESENCE_KEY_PREFIX.length);
            const parsed = Number(rawValue);
            if (userId && Number.isFinite(parsed) && parsed > 0) {
                byUserId.set(userId, parsed);
            }
        });

        return byUserId;
    } catch (error) {
        logger.error("[Social] Failed to fetch online presence keys:", error);
        return new Map();
    }
}

/**
 * @openapi
 * /api/social/presence/heartbeat:
 *   post:
 *     summary: Send a presence heartbeat
 *     description: Updates the user's online presence timestamp in Redis with a TTL. Called periodically by the client to indicate the user is online.
 *     tags: [Social]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Heartbeat recorded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 ttlSeconds:
 *                   type: integer
 *                   description: TTL in seconds before presence expires
 *       401:
 *         description: Not authenticated
 *       503:
 *         description: Presence service unavailable
 */
router.post("/presence/heartbeat", async (req, res) => {
    try {
        const userId = req.user!.id;
        const timestampMs = Date.now();
        await redisClient.set(
            `${PRESENCE_KEY_PREFIX}${userId}`,
            timestampMs.toString(),
            { EX: PRESENCE_TTL_SECONDS }
        );
        publishSocialPresenceUpdate({
            userId,
            reason: "heartbeat",
            timestampMs,
        });

        return res.json({
            success: true,
            ttlSeconds: PRESENCE_TTL_SECONDS,
        });
    } catch (error) {
        logger.error("[Social] Presence heartbeat failed:", error);
        return res.status(503).json({ error: "Presence unavailable" });
    }
});

/**
 * @openapi
 * /api/social/online:
 *   get:
 *     summary: Get online users
 *     description: Returns a list of users who are currently online and have opted to share their online presence. Includes listening status and track info for users who share that.
 *     tags: [Social]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of online users with presence and listening info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       username:
 *                         type: string
 *                       displayName:
 *                         type: string
 *                       hasProfilePicture:
 *                         type: boolean
 *                       isInListenTogetherGroup:
 *                         type: boolean
 *                       listeningStatus:
 *                         type: string
 *                         enum: [playing, paused, idle]
 *                       listeningTrack:
 *                         type: object
 *                         nullable: true
 *                       lastHeartbeatAt:
 *                         type: string
 *                         format: date-time
 *       401:
 *         description: Not authenticated
 */
router.get("/online", async (_req, res) => {
    try {
        const onlinePresenceByUserId = await getOnlinePresenceMap();
        const onlineUserIds = Array.from(onlinePresenceByUserId.keys());

        if (onlineUserIds.length === 0) {
            return res.json({ users: [] });
        }

        const [users, activeMemberships] = await Promise.all([
            prisma.user.findMany({
                where: { id: { in: onlineUserIds } },
                select: {
                    id: true,
                    username: true,
                    displayName: true,
                    settings: {
                        select: {
                            shareOnlinePresence: true,
                            shareListeningStatus: true,
                        },
                    },
                    playbackStates: {
                        orderBy: { updatedAt: "desc" },
                        take: 1,
                        select: {
                            playbackType: true,
                            queue: true,
                            currentIndex: true,
                            isPlaying: true,
                            updatedAt: true,
                        },
                    },
                },
            }),
            prisma.syncGroupMember.findMany({
                where: {
                    userId: { in: onlineUserIds },
                    leftAt: null,
                    syncGroup: {
                        isActive: true,
                    },
                },
                select: { userId: true },
            }),
        ]);

        const usersWithPictures = await prisma.$queryRaw<{ id: string }[]>`
            SELECT id FROM "User"
            WHERE id = ANY(${onlineUserIds})
            AND "profilePicture" IS NOT NULL
        `;

        const inListenTogether = new Set(
            activeMemberships.map((entry) => entry.userId)
        );
        const hasProfilePictureSet = new Set(
            usersWithPictures.map((u) => u.id)
        );

        const socialUsers = users
            .filter((user) => user.settings?.shareOnlinePresence === true)
            .map((user) => {
                const latestPlaybackState = user.playbackStates[0];
                const shareListening =
                    user.settings?.shareListeningStatus === true;
                const listeningTrack =
                    shareListening &&
                    latestPlaybackState?.playbackType === "track"
                        ? extractQueueTrack(
                              latestPlaybackState.queue,
                              latestPlaybackState.currentIndex
                          )
                        : null;
                const listeningStatus = resolveListeningStatus(
                    shareListening,
                    latestPlaybackState,
                    listeningTrack
                );
                const lastHeartbeatMs = onlinePresenceByUserId.get(user.id);

                return {
                    id: user.id,
                    username: user.username,
                    displayName: user.displayName ?? user.username,
                    hasProfilePicture: hasProfilePictureSet.has(user.id),
                    isInListenTogetherGroup: inListenTogether.has(user.id),
                    listeningStatus,
                    listeningTrack,
                    lastHeartbeatAt: lastHeartbeatMs
                        ? new Date(lastHeartbeatMs).toISOString()
                        : new Date().toISOString(),
                };
            })
            .sort((a, b) => a.displayName.localeCompare(b.displayName));

        return res.json({ users: socialUsers });
    } catch (error) {
        logger.error("[Social] Failed to load online roster:", error);
        return res.status(500).json({ error: "Failed to get online users" });
    }
});

/**
 * @openapi
 * /api/social/connected:
 *   get:
 *     summary: Get all connected users (admin only)
 *     description: Returns all users with active presence heartbeats regardless of their sharing preferences. Admin-only endpoint for monitoring connected sessions.
 *     tags: [Social]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of all connected users with their settings
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       username:
 *                         type: string
 *                       displayName:
 *                         type: string
 *                       hasProfilePicture:
 *                         type: boolean
 *                       role:
 *                         type: string
 *                       shareOnlinePresence:
 *                         type: boolean
 *                       shareListeningStatus:
 *                         type: boolean
 *                       lastHeartbeatAt:
 *                         type: string
 *                         format: date-time
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Forbidden - admin role required
 */
router.get("/connected", requireAdmin, async (req, res) => {
    try {
        if (req.user?.role !== "admin") {
            return res.status(403).json({ error: "Forbidden" });
        }

        const onlinePresenceByUserId = await getOnlinePresenceMap();
        const onlineUserIds = Array.from(onlinePresenceByUserId.keys());

        if (onlineUserIds.length === 0) {
            return res.json({ users: [] });
        }

        const users = await prisma.user.findMany({
            where: { id: { in: onlineUserIds } },
            select: {
                id: true,
                username: true,
                displayName: true,
                role: true,
                settings: {
                    select: {
                        shareOnlinePresence: true,
                        shareListeningStatus: true,
                    },
                },
            },
        });

        const usersWithPicturesConnected = await prisma.$queryRaw<{ id: string }[]>`
            SELECT id FROM "User"
            WHERE id = ANY(${onlineUserIds})
            AND "profilePicture" IS NOT NULL
        `;

        const hasProfilePictureSet = new Set(
            usersWithPicturesConnected.map((u) => u.id)
        );

        const connectedUsers = users
            .map((user) => {
                const lastHeartbeatMs = onlinePresenceByUserId.get(user.id);
                return {
                    id: user.id,
                    username: user.username,
                    displayName: user.displayName ?? user.username,
                    hasProfilePicture: hasProfilePictureSet.has(user.id),
                    role: user.role,
                    shareOnlinePresence:
                        user.settings?.shareOnlinePresence ?? false,
                    shareListeningStatus:
                        user.settings?.shareListeningStatus ?? false,
                    lastHeartbeatAt: lastHeartbeatMs
                        ? new Date(lastHeartbeatMs).toISOString()
                        : new Date().toISOString(),
                };
            })
            .sort((a, b) => a.displayName.localeCompare(b.displayName));

        return res.json({ users: connectedUsers });
    } catch (error) {
        logger.error("[Social] Failed to load connected users:", error);
        return res.status(500).json({ error: "Failed to get connected users" });
    }
});

export default router;
