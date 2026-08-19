import { Router, type Request, type Response } from "express";
import {
    requireAdmin,
    requireAuth,
    requireAuthOrToken,
} from "../../middleware/auth";
import { asyncHandler } from "../../middleware/asyncHandler";
import { prisma, Prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import path from "path";
import fs from "fs";
import { config } from "../../config";
import {
    AudioStreamingService,
    type Quality as StreamingQuality,
} from "../../services/audioStreaming";
import { shuffleArray } from "../../utils/shuffle";
import { safeResolvePath } from "../../utils/safeResolvePath";
import {
    applyTrackPreferenceOrderBias,
    applyTrackPreferenceSimilarityBias,
    normalizeTrackPreferenceSignal,
    resolveTrackPreference,
    TRACK_DISLIKE_ENTITY_TYPE,
} from "../../services/trackPreference";
import {
    applyTrackPreferenceSignalToTrackIds,
    buildTrackPreferenceScoreMapForUser,
    formatAlbumPreferenceResponse,
    formatTrackPreferenceResponse,
    hasConnectedProviderToken,
    toLikedResponseTrack,
} from "../../services/libraryTrackPreferences";
import { sendInternalRouteError, sendRouteError } from "../routeErrorResponse";
import {
    type UnifiedTrackResponse,
    normalizeLocalTrack,
    normalizeTidalTrack,
    normalizeYtMusicTrack,
} from "../../services/unifiedTrackResponse";
import { proxyFederatedTrackStream } from "../../services/federationStreamProxy";
import {
    AUDIO_INFO_CACHE_TTL_MS,
    audioInfoCache,
    buildAudioInfoCacheKey,
    normalizeStreamingQuality,
    pruneAudioInfoCache,
    readAudioInfoPayload,
    resolveAudioInfoAbsolutePath,
} from "../../utils/libraryAudioInfo";
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
    ALBUM_SORT_MAP,
    ARTIST_SORT_MAP,
    TRACK_BROWSE_WHERE,
    TRACK_SORT_MAP,
    TRACK_VISIBLE_WHERE,
    parseLibraryOrigin,
    trackBrowseWhere,
} from "../../utils/librarySorting";
import { loadActiveFederationStreamPeer } from "./federationStreamPeer";
import {
    PersistedTrackDeletionPath,
    resolvePersistedTrackDeletionPath,
    isSafeRecursiveDeletionTarget,
    libraryDeletionLogger,
} from "../../utils/libraryDeletion";
import { deleteTrackAndRecomputeAlbum } from "../../services/trackDeletion";

/**
 * Router segment for tracks routes registered at this position.
 */
export const tracksBrowseRouter = Router();

/**
 * Router segment for tracks routes registered at this position.
 */
export const tracksStreamRouter = Router();

/**
 * Router segment for tracks routes registered at this position.
 */
export const tracksPreferenceReadRouter = Router();

/**
 * Router segment for tracks routes registered at this position.
 */
export const tracksPreferenceWriteRouter = Router();

/**
 * Router segment for tracks routes registered at this position.
 */
export const tracksDetailRouter = Router();

/**
 * Router segment for tracks routes registered at this position.
 */
export const tracksDeletionRouter = Router();
/**
 * @openapi
 * /api/library/tracks:
 *   get:
 *     summary: List tracks with optional album filter and pagination
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: albumId
 *         schema:
 *           type: string
 *         description: Filter by album ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Number of tracks to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Offset for pagination
 *       - in: query
 *         name: origin
 *         schema:
 *           type: string
 *           enum: [all, local, peers]
 *           default: all
 *         description: Filter tracks by local or federated origin
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [name, name-desc]
 *           default: name
 *         description: Sort order (ignored when albumId is provided)
 *     responses:
 *       200:
 *         description: Paginated list of tracks
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tracks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 offset:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *       401:
 *         description: Not authenticated
 */
// GET /library/tracks?albumId=&limit=100&offset=0
/**
 * Handles GET /api/library/tracks.
 */
export async function handleGetTracks(req: Request, res: Response) {
    const {
        albumId,
        limit: limitParam = "100",
        offset: offsetParam = "0",
        sortBy = "name",
        origin: originParam,
    } = req.query;
    const origin = parseLibraryOrigin(originParam);
    if (!origin) {
        return sendRouteError(res, 400, "Invalid library origin filter");
    }
    const limit = Math.min(
        parseInt(limitParam as string, 10) || 100,
        MAX_LIMIT,
    );
    const offset = parseInt(offsetParam as string, 10) || 0;

    let orderBy:
        | Prisma.TrackOrderByWithRelationInput
        | Prisma.TrackOrderByWithRelationInput[];
    if (albumId) {
        orderBy = [{ discNo: "asc" as const }, { trackNo: "asc" as const }];
    } else {
        orderBy = TRACK_SORT_MAP[sortBy as string] ?? {
            title: "asc" as const,
        };
    }

    const where: Prisma.TrackWhereInput = {
        ...TRACK_VISIBLE_WHERE,
        ...trackBrowseWhere(origin),
    };
    if (albumId) {
        where.albumId = albumId as string;
    }

    const [tracksData, total] = await Promise.all([
        prisma.track.findMany({
            where,
            skip: offset,
            take: limit,
            orderBy,
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
                federationPeer: {
                    select: { id: true, name: true, outboundStatus: true },
                },
            },
        }),
        prisma.track.count({ where }),
    ]);

    // Add coverArt field to albums
    const tracks = tracksData.map(({ federationPeer, ...track }) => ({
        ...track,
        source: track.origin === "FEDERATED" ? "federated" : "local",
        peer: federationPeer
            ? {
                  id: federationPeer.id,
                  name: federationPeer.name,
                  online: federationPeer.outboundStatus === "ACTIVE",
              }
            : undefined,
        album: {
            ...track.album,
            coverArt: track.album.coverUrl,
        },
    }));

    res.json({ tracks, total, offset, limit });
}

tracksBrowseRouter.get("/tracks", asyncHandler(handleGetTracks));

/**
 * @openapi
 * /api/library/liked:
 *   get:
 *     summary: Get the user's liked tracks playlist with cursor-based pagination
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Number of tracks to return
 *       - in: query
 *         name: cursorLikedAt
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Cursor timestamp for pagination (must be paired with cursorTrackId)
 *       - in: query
 *         name: cursorTrackId
 *         schema:
 *           type: string
 *         description: Cursor track ID for pagination (must be paired with cursorLikedAt)
 *     responses:
 *       200:
 *         description: Liked tracks playlist with pagination info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 playlist:
 *                   type: object
 *                 tracks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     limit:
 *                       type: integer
 *                     hasMore:
 *                       type: boolean
 *                     nextCursor:
 *                       type: object
 *                       nullable: true
 *       400:
 *         description: Bad request (mismatched cursor params)
 *       401:
 *         description: Not authenticated
 */
// GET /library/liked?limit=100&cursorLikedAt=<iso>&cursorTrackId=<id>
/**
 * Handles GET /api/library/liked.
 */
export async function handleGetLikedTracks(req: Request, res: Response) {
    const userId = req.user?.id;
    if (!userId) {
        return sendRouteError(
            res,
            401,
            "Authentication required for liked playlist",
        );
    }

    const parsedLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit =
        Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.min(parsedLimit, MAX_LIMIT)
            : DEFAULT_MY_LIKED_LIMIT;

    const cursorLikedAtParam =
        typeof req.query.cursorLikedAt === "string"
            ? req.query.cursorLikedAt
            : null;
    const cursorTrackIdParam =
        typeof req.query.cursorTrackId === "string"
            ? req.query.cursorTrackId
            : null;
    const remoteCursorIdParam = cursorTrackIdParam?.startsWith("remote:")
        ? cursorTrackIdParam.slice("remote:".length)
        : null;

    if (!!cursorLikedAtParam !== !!cursorTrackIdParam) {
        return sendRouteError(
            res,
            400,
            "cursorLikedAt and cursorTrackId must be provided together",
        );
    }

    let cursorLikedAt: Date | null = null;
    if (cursorLikedAtParam) {
        const parsedCursor = new Date(cursorLikedAtParam);
        if (Number.isNaN(parsedCursor.getTime())) {
            return sendRouteError(res, 400, "Invalid cursorLikedAt timestamp");
        }
        cursorLikedAt = parsedCursor;
    }

    const fetchTake = Math.max(limit * 3, limit + 1);
    const likedWhere: Prisma.LikedTrackWhereInput =
        cursorLikedAt && cursorTrackIdParam
            ? {
                  userId,
                  track: TRACK_VISIBLE_WHERE,
                  OR: [
                      { likedAt: { lt: cursorLikedAt } },
                      {
                          likedAt: cursorLikedAt,
                          trackId: { gt: cursorTrackIdParam },
                      },
                  ],
              }
            : { userId, track: TRACK_VISIBLE_WHERE };
    const remoteWhere: Prisma.LikedRemoteTrackWhereInput =
        cursorLikedAt && remoteCursorIdParam
            ? {
                  userId,
                  OR: [
                      { likedAt: { lt: cursorLikedAt } },
                      {
                          likedAt: cursorLikedAt,
                          id: { gt: remoteCursorIdParam },
                      },
                  ],
              }
            : cursorLikedAt
              ? {
                    userId,
                    likedAt: { lte: cursorLikedAt },
                }
              : { userId };

    const [total, remoteTotal, userSettings, localEntries, remoteEntries] =
        await Promise.all([
            prisma.likedTrack.count({
                where: { userId, track: TRACK_VISIBLE_WHERE },
            }),
            prisma.likedRemoteTrack.count({ where: { userId } }),
            prisma.userSettings.findUnique({
                where: { userId },
                select: {
                    tidalOAuthJson: true,
                    ytMusicOAuthJson: true,
                },
            }),
            prisma.likedTrack.findMany({
                where: likedWhere,
                select: {
                    trackId: true,
                    likedAt: true,
                },
                orderBy: [{ likedAt: "desc" }, { trackId: "asc" }],
                take: fetchTake,
            }),
            prisma.likedRemoteTrack.findMany({
                where: remoteWhere,
                include: {
                    trackTidal: true,
                    trackYtMusic: true,
                },
                orderBy: [{ likedAt: "desc" }, { id: "asc" }],
                take: fetchTake,
            }),
        ]);

    const hasTidal = hasConnectedProviderToken(userSettings?.tidalOAuthJson);
    const hasYtMusic = hasConnectedProviderToken(
        userSettings?.ytMusicOAuthJson,
    );

    type LocalMergedEntry = {
        kind: "local";
        token: string;
        cursorId: string;
        trackId: string;
        likedAt: Date;
    };
    type RemoteMergedEntry = {
        kind: "remote";
        token: string;
        cursorId: string;
        likedAt: Date;
        source: "tidal" | "youtube";
        trackTidalId: string | null;
        trackYtMusicId: string | null;
        remote: (typeof remoteEntries)[number];
    };
    type MergedEntry = LocalMergedEntry | RemoteMergedEntry;

    const mergedEntries: MergedEntry[] = [
        ...localEntries.map((entry) => ({
            kind: "local" as const,
            token: `l:${entry.trackId}`,
            cursorId: entry.trackId,
            trackId: entry.trackId,
            likedAt: entry.likedAt,
        })),
        ...remoteEntries
            .map((entry): RemoteMergedEntry | null => {
                if (entry.trackTidalId && entry.trackTidal) {
                    return {
                        kind: "remote",
                        token: `t:${entry.trackTidalId}`,
                        cursorId: `remote:${entry.id}`,
                        likedAt: entry.likedAt,
                        source: "tidal",
                        trackTidalId: entry.trackTidalId,
                        trackYtMusicId: null,
                        remote: entry,
                    };
                }
                if (entry.trackYtMusicId && entry.trackYtMusic) {
                    return {
                        kind: "remote",
                        token: `y:${entry.trackYtMusicId}`,
                        cursorId: `remote:${entry.id}`,
                        likedAt: entry.likedAt,
                        source: "youtube",
                        trackTidalId: null,
                        trackYtMusicId: entry.trackYtMusicId,
                        remote: entry,
                    };
                }
                return null;
            })
            .filter((entry): entry is RemoteMergedEntry => entry !== null),
    ].sort((left, right) => {
        const likedAtDiff = right.likedAt.getTime() - left.likedAt.getTime();
        if (likedAtDiff !== 0) return likedAtDiff;
        return left.cursorId.localeCompare(right.cursorId);
    });

    if (mergedEntries.length === 0) {
        return res.json({
            playlist: {
                id: MY_LIKED_PLAYLIST_ID,
                name: MY_LIKED_PLAYLIST_NAME,
                description: MY_LIKED_PLAYLIST_DESCRIPTION,
            },
            tracks: [],
            total: total + remoteTotal,
            pagination: {
                limit,
                hasMore: false,
                nextCursor: null,
            },
        });
    }

    const localTrackIds = Array.from(
        new Set(
            mergedEntries
                .filter(
                    (entry): entry is LocalMergedEntry =>
                        entry.kind === "local",
                )
                .map((entry) => entry.trackId),
        ),
    );
    const localTrackRows =
        localTrackIds.length > 0
            ? await prisma.track.findMany({
                  where: {
                      ...TRACK_VISIBLE_WHERE,
                      id: { in: localTrackIds },
                  },
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
                              artist: { select: { id: true, name: true } },
                          },
                      },
                  },
              })
            : [];
    const localTrackById = new Map(
        localTrackRows.map((track) => [track.id, track]),
    );

    const mappingWhereOr: Prisma.TrackMappingWhereInput[] = [];
    if (localTrackIds.length > 0) {
        mappingWhereOr.push({ trackId: { in: localTrackIds } });
    }
    const trackTidalIds = Array.from(
        new Set(
            mergedEntries
                .filter(
                    (entry): entry is RemoteMergedEntry =>
                        entry.kind === "remote" && entry.trackTidalId !== null,
                )
                .map((entry) => entry.trackTidalId as string),
        ),
    );
    if (trackTidalIds.length > 0) {
        mappingWhereOr.push({ trackTidalId: { in: trackTidalIds } });
    }
    const trackYtMusicIds = Array.from(
        new Set(
            mergedEntries
                .filter(
                    (entry): entry is RemoteMergedEntry =>
                        entry.kind === "remote" &&
                        entry.trackYtMusicId !== null,
                )
                .map((entry) => entry.trackYtMusicId as string),
        ),
    );
    if (trackYtMusicIds.length > 0) {
        mappingWhereOr.push({ trackYtMusicId: { in: trackYtMusicIds } });
    }

    const mappings =
        mappingWhereOr.length > 0
            ? await prisma.trackMapping.findMany({
                  where: {
                      stale: false,
                      OR: mappingWhereOr,
                  },
                  select: {
                      trackId: true,
                      trackTidalId: true,
                      trackYtMusicId: true,
                  },
              })
            : [];

    const parent = new Map<string, string>();
    const findRoot = (token: string): string => {
        const existing = parent.get(token);
        if (!existing) {
            parent.set(token, token);
            return token;
        }
        if (existing === token) return token;
        const root = findRoot(existing);
        parent.set(token, root);
        return root;
    };
    const unionTokens = (left: string, right: string) => {
        const leftRoot = findRoot(left);
        const rightRoot = findRoot(right);
        if (leftRoot !== rightRoot) {
            parent.set(rightRoot, leftRoot);
        }
    };

    for (const entry of mergedEntries) {
        findRoot(entry.token);
    }

    for (const mapping of mappings) {
        const tokens: string[] = [];
        if (mapping.trackId) tokens.push(`l:${mapping.trackId}`);
        if (mapping.trackTidalId) tokens.push(`t:${mapping.trackTidalId}`);
        if (mapping.trackYtMusicId) tokens.push(`y:${mapping.trackYtMusicId}`);
        for (let i = 1; i < tokens.length; i += 1) {
            unionTokens(tokens[0], tokens[i]);
        }
    }

    const grouped = new Map<string, MergedEntry[]>();
    for (const entry of mergedEntries) {
        const root = findRoot(entry.token);
        const bucket = grouped.get(root) ?? [];
        bucket.push(entry);
        grouped.set(root, bucket);
    }

    const choosePriority = (entry: MergedEntry): number => {
        if (entry.kind === "local") return 300;
        if (entry.source === "tidal") return hasTidal ? 220 : 120;
        return hasYtMusic ? 210 : 110;
    };

    const deduped = Array.from(grouped.values())
        .map((entries) => {
            const sortedCandidates = [...entries].sort((left, right) => {
                const priorityDiff =
                    choosePriority(right) - choosePriority(left);
                if (priorityDiff !== 0) return priorityDiff;
                const likedAtDiff =
                    left.likedAt.getTime() - right.likedAt.getTime();
                if (likedAtDiff !== 0) return likedAtDiff;
                return left.cursorId.localeCompare(right.cursorId);
            });
            const preferred = sortedCandidates[0];
            const earliestLikedAt = entries.reduce(
                (earliest, candidate) =>
                    candidate.likedAt < earliest ? candidate.likedAt : earliest,
                entries[0].likedAt,
            );

            let normalized: UnifiedTrackResponse | null = null;
            if (preferred.kind === "local") {
                const localTrack = localTrackById.get(preferred.trackId);
                if (localTrack) {
                    normalized = normalizeLocalTrack(localTrack as any);
                }
            } else if (preferred.source === "tidal") {
                if (preferred.remote.trackTidal) {
                    normalized = normalizeTidalTrack(
                        preferred.remote.trackTidal,
                    );
                }
            } else if (preferred.remote.trackYtMusic) {
                normalized = normalizeYtMusicTrack(
                    preferred.remote.trackYtMusic,
                );
            }

            if (!normalized) return null;
            return {
                cursorId: preferred.cursorId,
                likedAt: earliestLikedAt,
                track: toLikedResponseTrack(normalized, earliestLikedAt),
            };
        })
        .filter(
            (
                entry,
            ): entry is {
                cursorId: string;
                likedAt: Date;
                track: ReturnType<typeof toLikedResponseTrack>;
            } => entry !== null,
        )
        .sort((left, right) => {
            const likedAtDiff =
                right.likedAt.getTime() - left.likedAt.getTime();
            if (likedAtDiff !== 0) return likedAtDiff;
            return left.cursorId.localeCompare(right.cursorId);
        });

    const cursorFiltered =
        cursorLikedAt && cursorTrackIdParam
            ? deduped.filter(
                  (entry) =>
                      entry.likedAt < cursorLikedAt ||
                      (entry.likedAt.getTime() === cursorLikedAt.getTime() &&
                          entry.cursorId > cursorTrackIdParam),
              )
            : deduped;

    const hasMore = cursorFiltered.length > limit;
    const page = hasMore ? cursorFiltered.slice(0, limit) : cursorFiltered;
    const nextCursor =
        hasMore && page.length > 0
            ? {
                  likedAt: page[page.length - 1].likedAt.toISOString(),
                  trackId: page[page.length - 1].cursorId,
              }
            : null;

    return res.json({
        playlist: {
            id: MY_LIKED_PLAYLIST_ID,
            name: MY_LIKED_PLAYLIST_NAME,
            description: MY_LIKED_PLAYLIST_DESCRIPTION,
        },
        tracks: page.map((entry) => entry.track),
        total: total + remoteTotal,
        pagination: {
            limit,
            hasMore,
            nextCursor,
        },
    });
}

tracksBrowseRouter.get("/liked", asyncHandler(handleGetLikedTracks));

/**
 * @openapi
 * /api/library/tracks/shuffle:
 *   get:
 *     summary: Get random tracks for shuffle play
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Number of random tracks to return
 *     responses:
 *       200:
 *         description: Shuffled tracks
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tracks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *       401:
 *         description: Not authenticated
 */
// GET /library/tracks/shuffle?limit=100 - Get random tracks for shuffle play
/**
 * Handles GET /api/library/tracks/shuffle.
 */
export async function handleGetShuffledTracks(req: Request, res: Response) {
    const { limit: limitParam = "100" } = req.query;
    const limit = Math.min(
        parseInt(limitParam as string, 10) || 100,
        MAX_LIMIT,
    );

    // Get total count of tracks
    const totalTracks = await prisma.track.count({
        where: { ...TRACK_VISIBLE_WHERE, ...TRACK_BROWSE_WHERE },
    });

    if (totalTracks === 0) {
        return res.json({ tracks: [], total: 0 });
    }

    // For small libraries, fetch all and shuffle in memory
    // For large libraries, use database-level randomization for memory efficiency
    let tracksData;
    if (totalTracks <= limit) {
        // Fetch all tracks and shuffle
        tracksData = await prisma.track.findMany({
            where: { ...TRACK_VISIBLE_WHERE, ...TRACK_BROWSE_WHERE },
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
        });
        tracksData = shuffleArray(tracksData);
    } else {
        // For large libraries, sample via the indexed persisted `random`
        // column (F15) instead of a full-table ORDER BY RANDOM() scan+sort.
        // Pick a uniform pivot in [0, 1) and take the next `limit` rows by
        // random value ascending from that pivot — this can use the btree
        // index on Track.random. If the pivot lands near 1.0, fewer than
        // `limit` rows sort at/above it; top up by wrapping around to the
        // start of the range (random < pivot) for the remainder.
        const pivot = Math.random();
        const randomIds = await prisma.track.findMany({
            where: {
                ...TRACK_VISIBLE_WHERE,
                ...TRACK_BROWSE_WHERE,
                random: { gte: pivot },
            },
            orderBy: { random: "asc" },
            take: limit,
            select: { id: true },
        });

        if (randomIds.length < limit) {
            const remaining = limit - randomIds.length;
            const topUpIds = await prisma.track.findMany({
                where: {
                    ...TRACK_VISIBLE_WHERE,
                    ...TRACK_BROWSE_WHERE,
                    random: { lt: pivot },
                },
                orderBy: { random: "asc" },
                take: remaining,
                select: { id: true },
            });
            randomIds.push(...topUpIds);
        }

        // Then fetch full track data for selected IDs
        tracksData = await prisma.track.findMany({
            where: {
                ...TRACK_VISIBLE_WHERE,
                ...TRACK_BROWSE_WHERE,
                id: { in: randomIds.map((r) => r.id) },
            },
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
        });

        // Shuffle the result: findMany-by-id doesn't preserve the sampled
        // order anyway, and this also breaks the within-page adjacency
        // correlation inherent to a persisted random column — two tracks
        // with nearby `random` values would otherwise co-appear in the
        // same page more often than chance.
        for (let i = tracksData.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [tracksData[i], tracksData[j]] = [tracksData[j], tracksData[i]];
        }
    }

    // Add coverArt field to albums
    const tracks = tracksData.slice(0, limit).map((track) => ({
        ...track,
        album: {
            ...track.album,
            coverArt: track.album.coverUrl,
        },
    }));

    res.json({ tracks, total: totalTracks });
}

tracksBrowseRouter.get(
    "/tracks/shuffle",
    asyncHandler(handleGetShuffledTracks),
);

/**
 * @openapi
 * /api/library/tracks/{id}/stream:
 *   get:
 *     summary: Stream an audio track with optional quality transcoding
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Track ID
 *       - in: query
 *         name: quality
 *         schema:
 *           type: string
 *           enum: [original, high, medium, low]
 *         description: Streaming quality (defaults to user preference)
 *     responses:
 *       200:
 *         description: Audio stream
 *         content:
 *           audio/mpeg:
 *             schema:
 *               type: string
 *               format: binary
 *       206:
 *         description: Partial content (range request)
 *       404:
 *         description: Track not found or not available
 *       401:
 *         description: Not authenticated
 */
// GET /library/tracks/:id/stream
/**
 * Handles GET /api/library/tracks/:id/stream.
 */
async function streamFederatedTrack(
    req: Request<{ id: string }>,
    res: Response,
    peer: {
        id: string;
        name: string;
        baseUrl: string;
        outboundToken: string;
        outboundStatus: string | null;
    },
    remoteId: string,
    trackId: string,
    sourceModified: Date,
    sourceMime: string | null,
    requestedQuality: string,
): Promise<Response | void> {
    const quality = normalizeStreamingQuality(requestedQuality) ?? "medium";
    try {
        await proxyFederatedTrackStream({
            req,
            res,
            peer,
            remoteId,
            trackId,
            sourceModified,
            sourceMime,
            quality,
        });
        return undefined;
    } catch (error: unknown) {
        logger.warn("Federated stream proxy failed", { error });
        if (res.headersSent) {
            if (!res.writableEnded) res.end();
            return undefined;
        }
        return sendRouteError(res, 503, "Federation peer is offline", {
            code: "PEER_OFFLINE",
        });
    }
}

export async function handleStreamTrack(
    req: Request<{ id: string }>,
    res: Response,
) {
    try {
        logger.debug("[STREAM] Request received for track:", req.params.id);
        const { quality } = req.query;
        const userId = req.user?.id;

        if (!userId) {
            logger.debug("[STREAM] No userId in session - unauthorized");
            return sendRouteError(res, 401, "Unauthorized");
        }

        const track = await prisma.track.findUnique({
            where: { id: req.params.id, ...TRACK_VISIBLE_WHERE },
        });

        if (!track) {
            logger.debug("[STREAM] Track not found");
            return sendRouteError(res, 404, "Track not found");
        }

        const isFederatedTrack =
            config.features.federation && track.origin === "FEDERATED";
        const federationPeer = isFederatedTrack
            ? await loadActiveFederationStreamPeer(track.peerId)
            : null;
        if (isFederatedTrack && (!federationPeer || !track.remoteId)) {
            return sendRouteError(res, 503, "Federation peer is offline", {
                code: "PEER_OFFLINE",
            });
        }

        // Log play start - only if this is a new playback session
        const recentPlay = await prisma.play.findFirst({
            where: {
                userId,
                trackId: track.id,
                playedAt: {
                    gte: new Date(Date.now() - 30 * 1000),
                },
            },
            orderBy: { playedAt: "desc" },
        });

        if (!recentPlay) {
            await prisma.play.create({
                data: {
                    userId,
                    trackId: track.id,
                },
            });
            logger.debug("[STREAM] Logged new play for track:", track.title);
        }

        // Get user's quality preference
        let requestedQuality: string = "medium";
        if (quality) {
            requestedQuality = quality as string;
        } else {
            const settings = await prisma.userSettings.findUnique({
                where: { userId },
            });
            requestedQuality = settings?.playbackQuality || "medium";
        }

        const ext = track.filePath
            ? path.extname(track.filePath).toLowerCase()
            : "";
        logger.debug(
            `[STREAM] Quality: requested=${
                quality || "default"
            }, using=${requestedQuality}, format=${ext}`,
        );

        if (isFederatedTrack && federationPeer && track.remoteId) {
            return streamFederatedTrack(
                req,
                res,
                federationPeer,
                track.remoteId,
                track.id,
                track.fileModified,
                track.mime,
                requestedQuality,
            );
        }

        // === NATIVE FILE STREAMING ===
        // Check if track has native file path
        if (track.filePath && track.fileModified) {
            const normalizedFilePath = track.filePath.replace(/\\/g, "/");
            const absolutePath = safeResolvePath(
                config.music.musicPath,
                normalizedFilePath,
            );
            if (!absolutePath) {
                logger.warn(
                    `[STREAM] Rejected out-of-root file path for track ${track.id}`,
                );
                return sendRouteError(res, 404, "Track not available");
            }

            let streamingService: AudioStreamingService | null = null;

            try {
                // Initialize streaming service
                streamingService = new AudioStreamingService(
                    config.music.musicPath,
                    config.music.transcodeCachePath,
                    config.music.transcodeCacheMaxGb,
                );

                logger.debug(
                    `[STREAM] Using native file: ${track.filePath} (${requestedQuality})`,
                );

                // Get stream file (either original or transcoded)
                const { filePath, mimeType } =
                    await streamingService.getStreamFilePath(
                        track.id,
                        requestedQuality as any,
                        track.fileModified,
                        absolutePath,
                    );

                // Stream file with range support
                logger.debug(
                    `[STREAM] Sending file: ${filePath}, mimeType: ${mimeType}`,
                );

                await streamingService.streamFileWithRangeSupport(
                    req,
                    res,
                    filePath,
                    mimeType,
                );
                logger.debug(
                    `[STREAM] File sent successfully: ${path.basename(
                        filePath,
                    )}`,
                );

                return;
            } catch (err: any) {
                // If FFmpeg not found, try original quality instead
                if (
                    err.code === "FFMPEG_NOT_FOUND" &&
                    requestedQuality !== "original" &&
                    streamingService !== null
                ) {
                    logger.warn(
                        `[STREAM] FFmpeg not available, falling back to original quality`,
                    );

                    const { filePath, mimeType } =
                        await streamingService.getStreamFilePath(
                            track.id,
                            "original",
                            track.fileModified,
                            absolutePath,
                        );

                    await streamingService.streamFileWithRangeSupport(
                        req,
                        res,
                        filePath,
                        mimeType,
                    );
                    return;
                }

                logger.error("[STREAM] Native streaming failed:", err.message);
                return res
                    .status(500)
                    .json({ error: "Failed to stream track" });
            } finally {
                streamingService?.destroy();
            }
        }

        // No file path available
        logger.debug("[STREAM] Track has no file path - unavailable");
        return sendRouteError(res, 404, "Track not available");
    } catch (error) {
        logger.error("Stream track error:", error);
        sendInternalRouteError(res, "Failed to stream track");
    }
}

tracksStreamRouter.get("/tracks/:id/stream", handleStreamTrack);

/**
 * @openapi
 * /api/library/tracks/{id}/preference:
 *   get:
 *     summary: Get the current user's preference (like/dislike) for a track
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Track ID
 *     responses:
 *       200:
 *         description: Track preference state
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 trackId:
 *                   type: string
 *                 signal:
 *                   type: string
 *                 state:
 *                   type: string
 *                 score:
 *                   type: number
 *                 likedAt:
 *                   type: string
 *                   nullable: true
 *                 dislikedAt:
 *                   type: string
 *                   nullable: true
 *       404:
 *         description: Track not found
 *       401:
 *         description: Not authenticated
 */
// GET /library/tracks/:id/preference
/**
 * Handles GET /api/library/tracks/:id/preference.
 */
export async function handleGetTrackPreference(
    req: Request<{ id: string }>,
    res: Response,
) {
    const userId = req.user?.id;
    if (!userId) {
        return sendRouteError(res, 401, "Authentication required");
    }

    const trackId = req.params.id;
    const track = await prisma.track.findUnique({
        where: { id: trackId, ...TRACK_VISIBLE_WHERE },
        select: { id: true },
    });
    if (!track) {
        return sendRouteError(res, 404, "Track not found");
    }

    const [likedEntry, dislikedEntry] = await Promise.all([
        prisma.likedTrack.findUnique({
            where: {
                userId_trackId: {
                    userId,
                    trackId,
                },
            },
            select: {
                likedAt: true,
            },
        }),
        prisma.dislikedEntity.findUnique({
            where: {
                userId_entityType_entityId: {
                    userId,
                    entityType: TRACK_DISLIKE_ENTITY_TYPE,
                    entityId: trackId,
                },
            },
            select: {
                dislikedAt: true,
            },
        }),
    ]);

    const preference = resolveTrackPreference({
        likedAt: likedEntry?.likedAt ?? null,
        dislikedAt: dislikedEntry?.dislikedAt ?? null,
    });

    res.json(formatTrackPreferenceResponse(trackId, preference));
}

tracksPreferenceReadRouter.get(
    "/tracks/:id/preference",
    asyncHandler(handleGetTrackPreference),
);

/**
 * @openapi
 * /api/library/tracks/{id}/preference:
 *   post:
 *     summary: Set preference (like/dislike/clear) for a track
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
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
 *             properties:
 *               signal:
 *                 type: string
 *                 enum: [thumbs_up, thumbs_down, clear]
 *     responses:
 *       200:
 *         description: Track preference set successfully
 *       400:
 *         description: Invalid preference signal
 *       404:
 *         description: Track not found
 *       401:
 *         description: Not authenticated
 */
// POST /library/tracks/:id/preference
/**
 * Handles POST /api/library/tracks/:id/preference.
 */
export async function handleSetTrackPreference(
    req: Request<{ id: string }>,
    res: Response,
) {
    const userId = req.user?.id;
    if (!userId) {
        return sendRouteError(res, 401, "Authentication required");
    }

    const trackId = req.params.id;
    const signal = normalizeTrackPreferenceSignal(
        req.body?.signal ?? req.body?.score ?? req.body?.action,
    );

    if (!signal) {
        return res.status(400).json({
            error: "Invalid preference signal. Use thumbs_up, thumbs_down, or clear.",
        });
    }

    const track = await prisma.track.findUnique({
        where: { id: trackId, ...TRACK_VISIBLE_WHERE },
        select: { id: true },
    });
    if (!track) {
        return sendRouteError(res, 404, "Track not found");
    }

    const now = new Date();

    if (signal === "thumbs_up") {
        await prisma.likedTrack.upsert({
            where: {
                userId_trackId: {
                    userId,
                    trackId,
                },
            },
            create: {
                userId,
                trackId,
                likedAt: now,
            },
            update: {
                likedAt: now,
            },
        });
        await prisma.dislikedEntity.deleteMany({
            where: {
                userId,
                entityType: TRACK_DISLIKE_ENTITY_TYPE,
                entityId: trackId,
            },
        });
    } else if (signal === "thumbs_down") {
        await prisma.dislikedEntity.upsert({
            where: {
                userId_entityType_entityId: {
                    userId,
                    entityType: TRACK_DISLIKE_ENTITY_TYPE,
                    entityId: trackId,
                },
            },
            create: {
                userId,
                entityType: TRACK_DISLIKE_ENTITY_TYPE,
                entityId: trackId,
                dislikedAt: now,
            },
            update: {
                dislikedAt: now,
            },
        });
        await prisma.likedTrack.deleteMany({
            where: {
                userId,
                trackId,
            },
        });
    } else {
        await prisma.likedTrack.deleteMany({
            where: {
                userId,
                trackId,
            },
        });
        await prisma.dislikedEntity.deleteMany({
            where: {
                userId,
                entityType: TRACK_DISLIKE_ENTITY_TYPE,
                entityId: trackId,
            },
        });
    }

    const preference = resolveTrackPreference({
        likedAt: signal === "thumbs_up" ? now : null,
        dislikedAt: signal === "thumbs_down" ? now : null,
    });

    res.json(formatTrackPreferenceResponse(trackId, preference));
}

tracksPreferenceWriteRouter.post(
    "/tracks/:id/preference",
    asyncHandler(handleSetTrackPreference),
);

/**
 * @openapi
 * /api/library/tracks/{id}:
 *   get:
 *     summary: Get a single track by ID
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Track ID
 *     responses:
 *       200:
 *         description: Track details with artist and album info
 *       404:
 *         description: Track not found
 *       401:
 *         description: Not authenticated
 */
// GET /library/tracks/:id
/**
 * Handles GET /api/library/tracks/:id.
 */
export async function handleGetTrack(
    req: Request<{ id: string }>,
    res: Response,
) {
    const track = await prisma.track.findUnique({
        where: { id: req.params.id, ...TRACK_VISIBLE_WHERE },
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
    });

    if (!track) {
        return sendRouteError(res, 404, "Track not found");
    }

    // Transform to match frontend Track interface: artist at top level
    const formattedTrack = {
        id: track.id,
        title: track.title,
        artist: {
            name: track.album?.artist?.name || "Unknown Artist",
            id: track.album?.artist?.id,
        },
        album: {
            title: track.album?.title || "Unknown Album",
            coverArt: track.album?.coverUrl,
            id: track.album?.id,
            albumLoudnessLufs: track.album?.albumLoudnessLufs ?? null,
            albumTruePeakDb: track.album?.albumTruePeakDb ?? null,
        },
        duration: track.duration,
        loudnessLufs: track.loudnessLufs,
        truePeakDb: track.truePeakDb,
    };

    res.json(formattedTrack);
}

tracksDetailRouter.get("/tracks/:id", asyncHandler(handleGetTrack));

/**
 * @openapi
 * /api/library/tracks/{id}/audio-info:
 *   get:
 *     summary: Get audio quality metadata for a track (codec, bitrate, sample rate, etc.)
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Track ID
 *       - in: query
 *         name: playback
 *         schema:
 *           type: boolean
 *           default: false
 *         description: If true, return info for the transcoded playback file instead of the source
 *       - in: query
 *         name: quality
 *         schema:
 *           type: string
 *           enum: [original, high, medium, low]
 *         description: Quality level for playback info (defaults to user preference)
 *     responses:
 *       200:
 *         description: Audio metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 codec:
 *                   type: string
 *                   nullable: true
 *                 bitrate:
 *                   type: number
 *                   nullable: true
 *                 sampleRate:
 *                   type: number
 *                   nullable: true
 *                 bitDepth:
 *                   type: number
 *                   nullable: true
 *                 lossless:
 *                   type: boolean
 *                   nullable: true
 *                 channels:
 *                   type: number
 *                   nullable: true
 *       404:
 *         description: Track or file not found
 *       401:
 *         description: Not authenticated
 */
// GET /library/tracks/:id/audio-info
// Returns audio quality metadata (bitrate, sample rate, bit depth, codec)
// by probing the file on disk with music-metadata. Uses a short-lived
// in-process cache keyed by track/file identity to avoid repeated probes.
/**
 * Handles GET /api/library/tracks/:id/audio-info.
 */
export async function handleGetTrackAudioInfo(
    req: Request<{ id: string }>,
    res: Response,
) {
    try {
        const trackId = req.params.id;
        const playback = parseBooleanQueryParam(req.query.playback, false);
        const track = await prisma.track.findUnique({
            where: { id: trackId, ...TRACK_VISIBLE_WHERE },
            select: {
                filePath: true,
                fileModified: true,
            },
        });

        if (!track?.filePath) {
            return sendRouteError(res, 404, "Track not found");
        }

        const absolutePath = resolveAudioInfoAbsolutePath(track.filePath);
        if (!absolutePath || !fs.existsSync(absolutePath)) {
            return sendRouteError(res, 404, "File not found on disk");
        }

        let metadataPath = absolutePath;
        let cacheScope: "source" | "playback" = "source";
        let cacheQuality: StreamingQuality | null = null;

        if (playback) {
            const userId = req.user?.id;
            if (!userId) {
                return sendRouteError(res, 401, "Unauthorized");
            }

            const queryQuality = normalizeStreamingQuality(req.query.quality);
            let requestedQuality: StreamingQuality = queryQuality ?? "medium";

            if (!queryQuality) {
                const userSettings = await prisma.userSettings.findUnique({
                    where: { userId },
                    select: { playbackQuality: true },
                });
                requestedQuality =
                    normalizeStreamingQuality(userSettings?.playbackQuality) ??
                    "medium";
            }

            const streamingService = new AudioStreamingService(
                config.music.musicPath,
                config.music.transcodeCachePath,
                config.music.transcodeCacheMaxGb,
            );

            try {
                const playbackFile = await streamingService.getStreamFilePath(
                    trackId,
                    requestedQuality,
                    track.fileModified,
                    absolutePath,
                );
                metadataPath = playbackFile.filePath;
                cacheScope = "playback";
                cacheQuality = requestedQuality;
            } finally {
                streamingService.destroy();
            }
        }

        const cacheKey = buildAudioInfoCacheKey(
            trackId,
            track.filePath,
            track.fileModified,
            {
                scope: cacheScope,
                quality: cacheQuality,
            },
        );
        const now = Date.now();
        const cachedEntry = audioInfoCache.get(cacheKey);
        if (cachedEntry && cachedEntry.expiresAt > now) {
            return res.json(cachedEntry.payload);
        }
        if (cachedEntry) {
            audioInfoCache.delete(cacheKey);
        }

        if (!fs.existsSync(metadataPath)) {
            return sendRouteError(res, 404, "Playback file not found on disk");
        }

        const payload = await readAudioInfoPayload(metadataPath);

        audioInfoCache.set(cacheKey, {
            payload,
            expiresAt: now + AUDIO_INFO_CACHE_TTL_MS,
        });
        pruneAudioInfoCache(now);

        res.json(payload);
    } catch (error) {
        logger.error("Get audio info error:", error);
        sendInternalRouteError(res, "Failed to read audio metadata");
    }
}

tracksDetailRouter.get<{ id: string }>(
    "/tracks/:id/audio-info",
    requireAuth,
    handleGetTrackAudioInfo,
);

/**
 * @openapi
 * /api/library/tracks/{id}:
 *   delete:
 *     summary: Delete a track from the library and filesystem
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Track ID
 *     responses:
 *       200:
 *         description: Track deleted successfully
 *       403:
 *         description: Library deletion is disabled or not admin
 *       404:
 *         description: Track not found
 *       401:
 *         description: Not authenticated
 */

// DELETE /library/tracks/:id
/**
 * Handles DELETE /api/library/tracks/:id.
 */
export async function handleDeleteTrack(
    req: Request<{ id: string }>,
    res: Response,
) {
    const deletionsEnabled = await isLibraryDeletionEnabled();
    if (!deletionsEnabled) {
        return res.status(403).json({
            error: "Library deletion is disabled in admin settings",
        });
    }

    const track = await prisma.track.findUnique({
        where: { id: req.params.id, ...TRACK_VISIBLE_WHERE },
        include: {
            album: {
                include: {
                    artist: true,
                },
            },
        },
    });

    if (!track) {
        return sendRouteError(res, 404, "Track not found");
    }

    // Delete file from filesystem if path is available
    if (track.filePath) {
        const deletionPath = resolvePersistedTrackDeletionPath(track.filePath);
        if (!deletionPath) {
            libraryDeletionLogger.warn("Skipped unsafe persisted track path", {
                trackId: track.id,
            });
        } else {
            try {
                if (fs.existsSync(deletionPath.absolutePath)) {
                    fs.unlinkSync(deletionPath.absolutePath);
                    libraryDeletionLogger.debug("Deleted track file", {
                        trackId: track.id,
                    });
                }
            } catch (err) {
                libraryDeletionLogger.warn("Could not delete track file", {
                    trackId: track.id,
                    error: err,
                });
                // Continue with database deletion even if file deletion fails
            }
        }
    }

    // Delete from database (cascade will handle related records)
    await deleteTrackAndRecomputeAlbum(track.id, track.albumId);

    logger.debug(`[DELETE] Deleted track: ${track.title}`);

    res.json({ message: "Track deleted successfully" });
}

tracksDeletionRouter.delete<{ id: string }>(
    "/tracks/:id",
    requireAdmin,
    asyncHandler(handleDeleteTrack),
);
