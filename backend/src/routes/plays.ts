import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { parseBoundedInt } from "../utils/queryParams";
import { TRACK_VISIBLE_WHERE } from "../utils/librarySorting";
import { z } from "zod";
import { trackMappingService } from "../services/trackMappingService";
import { resolveRemoteTrackMetadataForRequest } from "../services/remoteTrackMetadataResolver";
import {
    type UnifiedTrackResponse,
    normalizeLocalTrack,
    normalizeTidalTrack,
    normalizeYtMusicTrack,
} from "../services/unifiedTrackResponse";

const router = Router();

router.use(requireAuth);

const playSchema = z
    .object({
        trackId: z.string().optional(),
        tidalTrackId: z.number().int().positive().optional(),
        youtubeVideoId: z.string().trim().min(1).optional(),
        title: z.string().trim().min(1).optional(),
        artist: z.string().trim().min(1).optional(),
        album: z.string().trim().min(1).optional(),
        duration: z.number().int().nonnegative().optional(),
        thumbnailUrl: z.string().trim().min(1).optional(),
    })
    .superRefine((data, ctx) => {
        const providedIdentifiers = [
            data.trackId ? 1 : 0,
            data.tidalTrackId ? 1 : 0,
            data.youtubeVideoId ? 1 : 0,
        ].reduce((sum, value) => sum + value, 0);
        if (providedIdentifiers !== 1) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["trackId"],
                message: "Exactly one track identifier required",
            });
        }

        const isRemote = Boolean(data.tidalTrackId || data.youtubeVideoId);
        if (isRemote) {
            if (
                !data.title ||
                !data.artist ||
                !data.album ||
                data.duration === undefined
            ) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["title"],
                    message:
                        "Remote play logging requires title, artist, album, and duration",
                });
            }
        }
    });

const playHistoryRangeSchema = z.enum(["7d", "30d", "365d", "all"]);
type PlayHistoryRange = z.infer<typeof playHistoryRangeSchema>;

const getHistoryRangeStart = (
    range: Exclude<PlayHistoryRange, "all">,
): Date => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const lookbackDays = range === "7d" ? 7 : range === "30d" ? 30 : 365;
    return new Date(now - lookbackDays * dayMs);
};

/**
 * @openapi
 * /api/plays/summary:
 *   get:
 *     summary: Get play count summaries across time ranges
 *     tags: [Plays]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Play count summaries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 allTime:
 *                   type: integer
 *                 last7Days:
 *                   type: integer
 *                 last30Days:
 *                   type: integer
 *                 last365Days:
 *                   type: integer
 *       401:
 *         description: Not authenticated
 */
// GET /plays/summary (counts for warning/confirmation UI)
router.get("/summary", async (req, res) => {
    try {
        const userId = req.user!.id;
        const now = new Date();
        const sevenDaysAgo = getHistoryRangeStart("7d");
        const thirtyDaysAgo = getHistoryRangeStart("30d");
        const yearAgo = getHistoryRangeStart("365d");

        const [allTime, last7Days, last30Days, last365Days] = await Promise.all(
            [
                prisma.play.count({
                    where: { userId },
                }),
                prisma.play.count({
                    where: {
                        userId,
                        playedAt: { gte: sevenDaysAgo, lte: now },
                    },
                }),
                prisma.play.count({
                    where: {
                        userId,
                        playedAt: { gte: thirtyDaysAgo, lte: now },
                    },
                }),
                prisma.play.count({
                    where: {
                        userId,
                        playedAt: { gte: yearAgo, lte: now },
                    },
                }),
            ],
        );

        res.json({
            allTime,
            last7Days,
            last30Days,
            last365Days,
        });
    } catch (error) {
        logger.error("Get play summary error:", error);
        res.status(500).json({ error: "Failed to get play history summary" });
    }
});

/**
 * @openapi
 * /api/plays/history:
 *   delete:
 *     summary: Clear play history for a given time range
 *     tags: [Plays]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: range
 *         schema:
 *           type: string
 *           enum: [7d, 30d, 365d, all]
 *           default: 30d
 *     responses:
 *       200:
 *         description: Play history cleared
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 range:
 *                   type: string
 *                 deletedCount:
 *                   type: integer
 *       400:
 *         description: Invalid range parameter
 *       401:
 *         description: Not authenticated
 */
// DELETE /plays/history?range=7d|30d|365d|all
router.delete("/history", async (req, res) => {
    try {
        const userId = req.user!.id;
        const parsed = playHistoryRangeSchema.safeParse(
            (req.query.range as string) || "30d",
        );

        if (!parsed.success) {
            return res.status(400).json({
                error: "Invalid range. Expected one of: 7d, 30d, 365d, all",
            });
        }

        const range = parsed.data;
        const where =
            range === "all"
                ? { userId }
                : {
                      userId,
                      playedAt: {
                          gte: getHistoryRangeStart(range),
                          lte: new Date(),
                      },
                  };

        const result = await prisma.play.deleteMany({ where });

        res.json({
            success: true,
            range,
            deletedCount: result.count,
        });
    } catch (error) {
        logger.error("Clear play history error:", error);
        res.status(500).json({ error: "Failed to clear play history" });
    }
});

/**
 * @openapi
 * /api/plays:
 *   post:
 *     summary: Log a new play for a track
 *     tags: [Plays]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - type: object
 *                 required: [trackId]
 *                 not:
 *                   anyOf:
 *                     - required: [tidalTrackId]
 *                     - required: [youtubeVideoId]
 *                 properties:
 *                   trackId:
 *                     type: string
 *                     minLength: 1
 *                     description: Local library track ID
 *               - type: object
 *                 required: [tidalTrackId, title, artist, album, duration]
 *                 not:
 *                   anyOf:
 *                     - required: [trackId]
 *                     - required: [youtubeVideoId]
 *                 properties:
 *                   tidalTrackId:
 *                     type: integer
 *                     minimum: 1
 *                   title:
 *                     type: string
 *                     minLength: 1
 *                   artist:
 *                     type: string
 *                     minLength: 1
 *                   album:
 *                     type: string
 *                     minLength: 1
 *                   duration:
 *                     type: integer
 *                     minimum: 0
 *                     description: Track duration in seconds
 *                   thumbnailUrl:
 *                     type: string
 *                     minLength: 1
 *               - type: object
 *                 required: [youtubeVideoId, title, artist, album, duration]
 *                 not:
 *                   anyOf:
 *                     - required: [trackId]
 *                     - required: [tidalTrackId]
 *                 properties:
 *                   youtubeVideoId:
 *                     type: string
 *                     minLength: 1
 *                   title:
 *                     type: string
 *                     minLength: 1
 *                   artist:
 *                     type: string
 *                     minLength: 1
 *                   album:
 *                     type: string
 *                     minLength: 1
 *                   duration:
 *                     type: integer
 *                     minimum: 0
 *                     description: Track duration in seconds
 *                   thumbnailUrl:
 *                     type: string
 *                     minLength: 1
 *     responses:
 *       200:
 *         description: Play logged successfully
 *       400:
 *         description: Invalid request body
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Track not found
 */
// POST /plays
router.post("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const payload = playSchema.parse(req.body);

        if (payload.trackId) {
            // Verify local track exists
            const track = await prisma.track.findUnique({
                where: { id: payload.trackId, ...TRACK_VISIBLE_WHERE },
            });

            if (!track) {
                return res.status(404).json({ error: "Track not found" });
            }

            const play = await prisma.play.create({
                data: {
                    userId,
                    trackId: payload.trackId,
                    source: "LIBRARY",
                },
            });

            return res.json(play);
        }

        if (payload.tidalTrackId) {
            const resolvedMetadata = await resolveRemoteTrackMetadataForRequest(
                {
                    provider: "tidal",
                    userId,
                    tidalId: payload.tidalTrackId,
                    metadata: {
                        title: payload.title,
                        artist: payload.artist,
                        album: payload.album,
                        duration: payload.duration,
                    },
                },
            );
            const ensured = await trackMappingService.ensureRemoteTrack({
                provider: "tidal",
                tidalId: payload.tidalTrackId,
                title: resolvedMetadata.title,
                artist: resolvedMetadata.artist,
                album: resolvedMetadata.album,
                duration: resolvedMetadata.duration,
                isrc: resolvedMetadata.isrc,
                explicit: resolvedMetadata.explicit,
            });
            const play = await prisma.play.create({
                data: {
                    userId,
                    trackTidalId: ensured.id,
                    source: "TIDAL",
                },
            });
            return res.json(play);
        }

        const resolvedMetadata = await resolveRemoteTrackMetadataForRequest({
            provider: "youtube",
            userId,
            videoId: payload.youtubeVideoId!,
            metadata: {
                title: payload.title,
                artist: payload.artist,
                album: payload.album,
                duration: payload.duration,
                thumbnailUrl: payload.thumbnailUrl,
            },
        });
        const ensured = await trackMappingService.ensureRemoteTrack({
            provider: "youtube",
            videoId: payload.youtubeVideoId!,
            title: resolvedMetadata.title,
            artist: resolvedMetadata.artist,
            album: resolvedMetadata.album,
            duration: resolvedMetadata.duration,
            thumbnailUrl: resolvedMetadata.thumbnailUrl,
        });
        const play = await prisma.play.create({
            data: {
                userId,
                trackYtMusicId: ensured.id,
                source: "YOUTUBE_MUSIC",
            },
        });

        return res.json(play);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.issues });
        }
        logger.error("Create play error:", error);
        res.status(500).json({ error: "Failed to log play" });
    }
});

/**
 * @openapi
 * /api/plays:
 *   get:
 *     summary: Get recent plays for the authenticated user
 *     tags: [Plays]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           minimum: 1
 *           maximum: 200
 *     responses:
 *       200:
 *         description: List of recent plays with track details
 *       401:
 *         description: Not authenticated
 */
// GET /plays (recent plays for user)
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const limit = parseBoundedInt(req.query.limit, 50, 1, 200);

        const plays = await prisma.play.findMany({
            where: { userId },
            orderBy: { playedAt: "desc" },
            take: limit,
            include: {
                track: {
                    include: {
                        federationPeer: {
                            select: {
                                id: true,
                                name: true,
                                outboundStatus: true,
                            },
                        },
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
        });

        res.json(
            plays
                .map((play) => {
                    if (play.track) {
                        const normalized = normalizeLocalTrack(
                            play.track as any,
                        );
                        return {
                            id: play.id,
                            playedAt: play.playedAt,
                            source: play.source,
                            track: toHistoryTrackShape(
                                normalized,
                                Boolean(play.track.removedAt),
                            ),
                        };
                    }
                    if (play.trackTidal) {
                        const normalized = normalizeTidalTrack(play.trackTidal);
                        return {
                            id: play.id,
                            playedAt: play.playedAt,
                            source: play.source,
                            track: toHistoryTrackShape(normalized),
                        };
                    }
                    if (play.trackYtMusic) {
                        const normalized = normalizeYtMusicTrack(
                            play.trackYtMusic,
                        );
                        return {
                            id: play.id,
                            playedAt: play.playedAt,
                            source: play.source,
                            track: toHistoryTrackShape(normalized),
                        };
                    }
                    return null;
                })
                .filter(
                    (entry): entry is NonNullable<typeof entry> =>
                        entry !== null,
                ),
        );
    } catch (error) {
        logger.error("Get plays error:", error);
        res.status(500).json({ error: "Failed to get plays" });
    }
});

export default router;
const toHistoryTrackShape = (
    normalized: UnifiedTrackResponse,
    isRemoved = false,
) => {
    const base = {
        id: normalized.id,
        title: normalized.title,
        displayTitle: normalized.displayTitle ?? null,
        duration: normalized.duration,
        trackNo: normalized.trackNo,
        source: normalized.source,
        provider: normalized.provider,
        filePath: normalized.filePath ?? null,
        artist: normalized.artist,
        album: {
            ...normalized.album,
            artist: normalized.artist,
        },
        ...(isRemoved
            ? {
                  playback: {
                      isPlayable: false,
                      reason: "track_removed" as const,
                      message:
                          "Playback is unavailable because this track was removed from the library.",
                  },
              }
            : {}),
    };

    if (normalized.source === "tidal") {
        return {
            ...base,
            streamSource: "tidal" as const,
            tidalTrackId: normalized.provider.tidalTrackId,
        };
    }
    if (normalized.source === "youtube") {
        return {
            ...base,
            streamSource: "youtube" as const,
            youtubeVideoId: normalized.provider.youtubeVideoId,
        };
    }
    if (normalized.source === "federated") {
        return { ...base, streamSource: "peer" as const };
    }
    return base;
};
