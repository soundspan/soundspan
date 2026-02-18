import express from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";

const router = express.Router();
router.use(requireAuth);

const PRESENCE_KEY_PREFIX = "social:presence:user:";
const PRESENCE_TTL_SECONDS = 75;

type QueueTrackProjection = {
    id: string;
    title: string;
    duration: number;
    artistName: string;
    albumTitle: string;
    coverArt: string | null;
};

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
        albumTitle: album.title,
        coverArt:
            typeof album.coverArt === "string" ? album.coverArt : null,
    };
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

router.post("/presence/heartbeat", async (req, res) => {
    try {
        const userId = req.user!.id;
        await redisClient.set(
            `${PRESENCE_KEY_PREFIX}${userId}`,
            Date.now().toString(),
            { EX: PRESENCE_TTL_SECONDS }
        );

        return res.json({
            success: true,
            ttlSeconds: PRESENCE_TTL_SECONDS,
        });
    } catch (error) {
        logger.error("[Social] Presence heartbeat failed:", error);
        return res.status(503).json({ error: "Presence unavailable" });
    }
});

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

        const inListenTogether = new Set(
            activeMemberships.map((entry) => entry.userId)
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
                const lastHeartbeatMs = onlinePresenceByUserId.get(user.id);

                return {
                    id: user.id,
                    username: user.username,
                    displayName: user.displayName ?? user.username,
                    isInListenTogetherGroup: inListenTogether.has(user.id),
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

        const connectedUsers = users
            .map((user) => {
                const lastHeartbeatMs = onlinePresenceByUserId.get(user.id);
                return {
                    id: user.id,
                    username: user.username,
                    displayName: user.displayName ?? user.username,
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
