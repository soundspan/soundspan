import express from "express";
import {
    requireAuth,
    requireAuthOrToken,
    requireAdmin,
} from "../middleware/auth";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { logger } from "../utils/logger";
import { publishSocialPresenceUpdate } from "../services/socialPresenceEvents";
import { resolveCanonicalMediaSource } from "@soundspan/media-metadata-contract";
import { TRACK_VISIBLE_WHERE } from "../utils/librarySorting";
import { readFederationPeerPresenceSnapshots } from "../services/federationPresence";
import type { FederationPeerPresenceSnapshot } from "../utils/federationPresenceSchemas";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler";
import { sendRouteError } from "../utils/routeErrorResponse";
import { config } from "../config";
import {
    browseFederationPeerPlaylists,
    copyFederationPeerPlaylist,
    followFederationPeerPlaylist,
    getFederationPeerPlaylist,
    listFollowedFederationPeerPlaylists,
    PeerPlaylistError,
    unfollowFederationPeerPlaylist,
} from "../services/federationPeerPlaylists";

const router = express.Router();
const log = logger.child("Social");

/**
 * @openapi
 * /api/social/profile-picture/{userId}:
 *   get:
 *     summary: Get a user's profile picture
 *     description: Serves the profile picture as JPEG. Uses query token auth since img tags cannot send Authorization headers.
 *     tags: [Social]
 *     security:
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
router.get<{ userId: string }>(
    "/profile-picture/:userId",
    requireAuthOrToken,
    async (req, res) => {
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
            log.error("Failed to serve profile picture", { error });
            return res
                .status(500)
                .json({ error: "Failed to get profile picture" });
        }
    },
);

router.use(requireAuth);

const peerPlaylistParamsSchema = z.strictObject({
    peerId: z.string().trim().min(1).max(256),
    remoteId: z.string().trim().min(1).max(256),
});
const noQuerySchema = z.strictObject({});

function peerPlaylistErrorResponse(res: express.Response, error: unknown) {
    if (!(error instanceof PeerPlaylistError)) throw error;
    if (error.errorClass === "not_found") {
        return sendRouteError(res, 404, "Peer playlist not found");
    }
    if (error.errorClass === "timeout") {
        return sendRouteError(res, 504, "Peer playlist request timed out");
    }
    if (error.errorClass === "offline") {
        return sendRouteError(res, 503, "Federation peer is offline");
    }
    return sendRouteError(res, 502, "Peer playlist request failed");
}

function parsedPeerPlaylistParams(req: express.Request) {
    return peerPlaylistParamsSchema.safeParse(req.params);
}

/** @openapi
 * /api/social/peer-playlists:
 *   get:
 *     summary: Browse public playlists from active social-scoped peers
 *     tags: [Social]
 *     security: [{ apiKeyAuth: [] }]
 *     responses:
 *       200: { description: Partial peer playlist results and classified per-peer errors }
 *       401: { description: Not authenticated }
 */
router.get(
    "/peer-playlists",
    asyncHandler(async (req, res) => {
        if (!noQuerySchema.safeParse(req.query).success) {
            return sendRouteError(res, 400, "Invalid request");
        }
        return res.json(await browseFederationPeerPlaylists());
    }),
);

/** @openapi
 * /api/social/peer-playlists/followed:
 *   get:
 *     summary: Resolve the caller's followed peer playlists live
 *     tags: [Social]
 *     security: [{ apiKeyAuth: [] }]
 *     responses:
 *       200: { description: Followed playlists with per-playlist offline errors }
 *       401: { description: Not authenticated }
 */
router.get(
    "/peer-playlists/followed",
    asyncHandler(async (req, res) => {
        if (!req.user) return sendRouteError(res, 401, "Unauthorized");
        if (!noQuerySchema.safeParse(req.query).success) {
            return sendRouteError(res, 400, "Invalid request");
        }
        return res.json(await listFollowedFederationPeerPlaylists(req.user.id));
    }),
);

/** @openapi
 * /api/social/peer-playlists/{peerId}/{remoteId}:
 *   get:
 *     summary: Fetch and locally resolve one peer playlist
 *     tags: [Social]
 *     security: [{ apiKeyAuth: [] }]
 *     responses:
 *       200: { description: Live playlist detail with local resolution states }
 *       401: { description: Not authenticated }
 *       404: { description: Peer playlist not found }
 *       503: { description: Peer offline }
 *       504: { description: Peer timeout }
 */
router.get(
    "/peer-playlists/:peerId/:remoteId",
    asyncHandler(async (req, res) => {
        const params = parsedPeerPlaylistParams(req);
        if (!params.success || !noQuerySchema.safeParse(req.query).success) {
            return sendRouteError(res, 400, "Invalid request");
        }
        try {
            return res.json(
                await getFederationPeerPlaylist(
                    params.data.peerId,
                    params.data.remoteId,
                ),
            );
        } catch (error) {
            return peerPlaylistErrorResponse(res, error);
        }
    }),
);

/** @openapi
 * /api/social/peer-playlists/{peerId}/{remoteId}/follow:
 *   post:
 *     summary: Follow one peer playlist
 *     tags: [Social]
 *     security: [{ apiKeyAuth: [] }]
 *     responses:
 *       200: { description: Playlist followed idempotently }
 *       401: { description: Not authenticated }
 *   delete:
 *     summary: Unfollow one peer playlist
 *     tags: [Social]
 *     security: [{ apiKeyAuth: [] }]
 *     responses:
 *       200: { description: Playlist unfollowed idempotently }
 *       401: { description: Not authenticated }
 */
router.post(
    "/peer-playlists/:peerId/:remoteId/follow",
    asyncHandler(async (req, res) => {
        const params = parsedPeerPlaylistParams(req);
        if (!req.user) return sendRouteError(res, 401, "Unauthorized");
        if (!params.success || !noQuerySchema.safeParse(req.query).success) {
            return sendRouteError(res, 400, "Invalid request");
        }
        try {
            return res.json(
                await followFederationPeerPlaylist(
                    req.user.id,
                    params.data.peerId,
                    params.data.remoteId,
                ),
            );
        } catch (error) {
            return peerPlaylistErrorResponse(res, error);
        }
    }),
);

router.delete(
    "/peer-playlists/:peerId/:remoteId/follow",
    asyncHandler(async (req, res) => {
        const params = parsedPeerPlaylistParams(req);
        if (!req.user) return sendRouteError(res, 401, "Unauthorized");
        if (!params.success || !noQuerySchema.safeParse(req.query).success) {
            return sendRouteError(res, 400, "Invalid request");
        }
        return res.json(
            await unfollowFederationPeerPlaylist(
                req.user.id,
                params.data.peerId,
                params.data.remoteId,
            ),
        );
    }),
);

/** @openapi
 * /api/social/peer-playlists/{peerId}/{remoteId}/copy:
 *   post:
 *     summary: Copy resolvable peer tracks into a caller-owned local playlist
 *     tags: [Social]
 *     security: [{ apiKeyAuth: [] }]
 *     responses:
 *       200: { description: Copy result with copied and skipped counts }
 *       401: { description: Not authenticated }
 */
router.post(
    "/peer-playlists/:peerId/:remoteId/copy",
    asyncHandler(async (req, res) => {
        const params = parsedPeerPlaylistParams(req);
        if (!req.user) return sendRouteError(res, 401, "Unauthorized");
        if (!params.success || !noQuerySchema.safeParse(req.query).success) {
            return sendRouteError(res, 400, "Invalid request");
        }
        try {
            return res.json(
                await copyFederationPeerPlaylist(
                    req.user.id,
                    params.data.peerId,
                    params.data.remoteId,
                ),
            );
        } catch (error) {
            return peerPlaylistErrorResponse(res, error);
        }
    }),
);

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

type QueueTrackCandidate = {
    projection: QueueTrackProjection;
    localTrackId: string | null;
};

type ListeningUser = {
    id: string;
    settings: { shareListeningStatus: boolean } | null;
    playbackStates: Array<{
        playbackType: string;
        queue: unknown;
        currentIndex: number;
    }>;
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
    currentIndex: number,
): QueueTrackCandidate | null {
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
    const provider =
        item.provider && typeof item.provider === "object"
            ? (item.provider as Record<string, unknown>)
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

    const source = resolveCanonicalMediaSource({
        mediaSource: item.mediaSource ?? provider?.source,
        streamSource: item.streamSource,
        sourceType: item.sourceType,
        tidalTrackId: item.tidalTrackId,
        youtubeVideoId: item.youtubeVideoId,
    });
    return {
        projection: {
            id: item.id,
            title: item.title,
            duration: item.duration,
            artistName: artist.name,
            artistId: asNonEmptyString(artist.id),
            albumTitle: album.title,
            albumId: asNonEmptyString(album.id),
            coverArt:
                typeof album.coverArt === "string" ? album.coverArt : null,
        },
        localTrackId: source === "local" ? item.id : null,
    };
}

async function resolveVisibleListeningTracks(
    users: ListeningUser[],
): Promise<Map<string, QueueTrackProjection | null>> {
    const candidates = new Map(
        users.map((user) => {
            const state = user.playbackStates[0];
            const candidate =
                user.settings?.shareListeningStatus === true &&
                state?.playbackType === "track"
                    ? extractQueueTrack(state.queue, state.currentIndex)
                    : null;
            return [user.id, candidate] as const;
        }),
    );
    const localTrackIds = Array.from(
        new Set(
            Array.from(candidates.values()).flatMap((candidate) =>
                candidate?.localTrackId ? [candidate.localTrackId] : [],
            ),
        ),
    );
    const visibleTracks =
        localTrackIds.length === 0
            ? []
            : await prisma.track.findMany({
                  where: {
                      ...TRACK_VISIBLE_WHERE,
                      id: { in: localTrackIds },
                  },
                  select: { id: true },
              });
    const visibleTrackIds = new Set(visibleTracks.map((track) => track.id));
    return new Map(
        Array.from(candidates, ([userId, candidate]) => [
            userId,
            candidate &&
            (!candidate.localTrackId ||
                visibleTrackIds.has(candidate.localTrackId))
                ? candidate.projection
                : null,
        ]),
    );
}

function resolveListeningStatus(
    shareListening: boolean,
    latestPlaybackState:
        | {
              playbackType: string;
              isPlaying: boolean;
              updatedAt: Date;
          }
        | null
        | undefined,
    listeningTrack: QueueTrackProjection | null,
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
        // node-redis v5+ scanIterator yields one array of keys per SCAN page.
        for await (const keyBatch of redisClient.scanIterator({
            MATCH: `${PRESENCE_KEY_PREFIX}*`,
            COUNT: 250,
        })) {
            for (const key of keyBatch) {
                if (typeof key === "string") {
                    keys.push(key);
                }
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
        log.error("Failed to fetch online presence keys", { error });
        return new Map();
    }
}

async function visiblePeerPresence(): Promise<
    FederationPeerPresenceSnapshot[] | undefined
> {
    if (!config.features.federation) return undefined;
    try {
        return await readFederationPeerPresenceSnapshots();
    } catch (error) {
        log.error("Failed to load peer presence display data", { error });
        return undefined;
    }
}

function rosterPayload(
    users: unknown[],
    peers: FederationPeerPresenceSnapshot[] | undefined,
) {
    return peers === undefined ? { users } : { users, peers };
}

/**
 * @openapi
 * /api/social/presence/heartbeat:
 *   post:
 *     summary: Send a presence heartbeat
 *     description: Updates the user's online presence timestamp in Redis with a TTL. Called periodically by the client to indicate the user is online.
 *     tags: [Social]
 *     security:
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
            { expiration: { type: "EX", value: PRESENCE_TTL_SECONDS } },
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
        log.error("Presence heartbeat failed", { error });
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
 *                 peers:
 *                   type: array
 *                   description: Included when federation is enabled and peer snapshots can be read; empty when no snapshots exist
 *                   items:
 *                     type: object
 *                     required: [peerId, peerName, users, fetchedAt]
 *                     properties:
 *                       peerId: { type: string }
 *                       peerName: { type: string }
 *                       users:
 *                         type: array
 *                         maxItems: 100
 *                         items:
 *                           type: object
 *                       fetchedAt: { type: string, format: date-time }
 *       401:
 *         description: Not authenticated
 */
router.get("/online", async (_req, res) => {
    try {
        const [onlinePresenceByUserId, peers] = await Promise.all([
            getOnlinePresenceMap(),
            visiblePeerPresence(),
        ]);
        const onlineUserIds = Array.from(onlinePresenceByUserId.keys());

        if (onlineUserIds.length === 0) {
            return res.json(rosterPayload([], peers));
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

        const usersWithPictures = await prisma.user.findMany({
            where: {
                id: { in: onlineUserIds },
                profilePicture: { not: null },
            },
            select: { id: true },
        });

        const inListenTogether = new Set(
            activeMemberships.map((entry) => entry.userId),
        );
        const hasProfilePictureSet = new Set(
            usersWithPictures.map((u) => u.id),
        );
        const listeningTracksByUserId =
            await resolveVisibleListeningTracks(users);

        const socialUsers = users
            .filter((user) => user.settings?.shareOnlinePresence === true)
            .map((user) => {
                const latestPlaybackState = user.playbackStates[0];
                const shareListening =
                    user.settings?.shareListeningStatus === true;
                const listeningTrack =
                    listeningTracksByUserId.get(user.id) ?? null;
                const listeningStatus = resolveListeningStatus(
                    shareListening,
                    latestPlaybackState,
                    listeningTrack,
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

        return res.json(rosterPayload(socialUsers, peers));
    } catch (error) {
        log.error("Failed to load online roster", { error });
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

        const usersWithPicturesConnected = await prisma.user.findMany({
            where: {
                id: { in: onlineUserIds },
                profilePicture: { not: null },
            },
            select: { id: true },
        });

        const hasProfilePictureSet = new Set(
            usersWithPicturesConnected.map((u) => u.id),
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
        log.error("Failed to load connected users", { error });
        return res.status(500).json({ error: "Failed to get connected users" });
    }
});

export default router;
