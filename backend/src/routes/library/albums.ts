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
    TRACK_SORT_MAP,
    TRACK_VISIBLE_WHERE,
    parseLibraryOrigin,
    trackBrowseWhere,
} from "../../utils/librarySorting";
import {
    PersistedTrackDeletionPath,
    resolvePersistedTrackDeletionPath,
    isSafeRecursiveDeletionTarget,
    libraryDeletionLogger,
} from "../../utils/libraryDeletion";

/**
 * Router segment for albums routes registered at this position.
 */
export const albumsBrowseRouter = Router();

/**
 * Router segment for albums routes registered at this position.
 */
export const albumsPreferenceRouter = Router();

/**
 * Router segment for albums routes registered at this position.
 */
export const albumsDeletionRouter = Router();
/**
 * @openapi
 * /api/library/albums:
 *   get:
 *     summary: List albums in the library with pagination and filtering
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: artistId
 *         schema:
 *           type: string
 *         description: Filter by artist ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 500
 *         description: Number of albums to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Offset for pagination
 *       - in: query
 *         name: filter
 *         schema:
 *           type: string
 *           enum: [owned, discovery, all]
 *           default: owned
 *         description: Filter by ownership type
 *       - in: query
 *         name: origin
 *         schema:
 *           type: string
 *           enum: [all, local, peers]
 *           default: all
 *         description: Filter albums by local or federated track origin
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [name, name-desc, recent]
 *           default: name
 *         description: Sort order
 *     responses:
 *       200:
 *         description: Paginated list of albums
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 albums:
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
// GET /library/albums?artistId=&limit=&offset=&filter=owned|discovery|all
/**
 * Handles GET /api/library/albums.
 */
export async function handleGetAlbums(req: Request, res: Response) {
    try {
        const {
            artistId,
            limit: limitParam = "500",
            offset: offsetParam = "0",
            filter = "owned", // owned (default), discovery, all
            sortBy = "name",
            origin: originParam,
        } = req.query;
        const origin = parseLibraryOrigin(originParam);
        if (!origin) {
            return sendRouteError(res, 400, "Invalid library origin filter");
        }
        const browseTrackWhere = {
            ...TRACK_VISIBLE_WHERE,
            ...trackBrowseWhere(origin),
        };
        const limit = Math.min(
            parseInt(limitParam as string, 10) || 500,
            MAX_LIMIT,
        );
        const offset = parseInt(offsetParam as string, 10) || 0;

        const orderBy = ALBUM_SORT_MAP[sortBy as string] ?? {
            title: "asc" as const,
        };

        let where: Prisma.AlbumWhereInput = {
            tracks: { some: browseTrackWhere }, // Only albums with visible tracks
        };

        // Apply location filter
        if (filter === "owned") {
            // Get all owned album rgMbids (includes liked discovery albums)
            const ownedAlbumMbids = await prisma.ownedAlbum.findMany({
                select: { rgMbid: true },
            });
            const ownedMbids = ownedAlbumMbids.map((oa) => oa.rgMbid);

            // Albums with LIBRARY location OR rgMbid in OwnedAlbum
            where.OR = [
                {
                    location: "LIBRARY",
                    tracks: { some: browseTrackWhere },
                },
                {
                    rgMbid: { in: ownedMbids },
                    tracks: { some: browseTrackWhere },
                },
            ];
            if (origin !== "local") {
                where.OR.push({
                    location: "FEDERATED",
                    tracks: { some: browseTrackWhere },
                });
            }
        } else if (filter === "discovery") {
            where.location = "DISCOVER";
        }
        // filter === "all" shows all locations

        // If artistId is provided, filter by artist
        if (artistId) {
            if (where.OR) {
                // If we have OR conditions, wrap with AND
                where = {
                    AND: [{ OR: where.OR }, { artistId: artistId as string }],
                };
            } else {
                where.artistId = artistId as string;
            }
        }

        const [albumsData, total] = await Promise.all([
            prisma.album.findMany({
                where,
                skip: offset,
                take: limit,
                orderBy,
                include: {
                    artist: {
                        select: {
                            id: true,
                            mbid: true,
                            name: true,
                        },
                    },
                    federationPeer: {
                        select: {
                            id: true,
                            name: true,
                            outboundStatus: true,
                        },
                    },
                },
            }),
            prisma.album.count({ where }),
        ]);

        // Normalize coverArt field for frontend
        const albums = albumsData.map(({ federationPeer, ...album }) => ({
            ...album,
            source: album.location === "FEDERATED" ? "federated" : "local",
            peer: federationPeer
                ? {
                      id: federationPeer.id,
                      name: federationPeer.name,
                      online: federationPeer.outboundStatus === "ACTIVE",
                  }
                : undefined,
            coverArt: album.coverUrl,
        }));

        res.json({
            albums,
            total,
            offset,
            limit,
        });
    } catch (error: any) {
        logger.error("[Library] Get albums error:", error?.message || error);
        logger.error("[Library] Stack:", error?.stack);
        res.status(500).json({
            error: "Failed to fetch albums",
        });
    }
}

albumsBrowseRouter.get("/albums", handleGetAlbums);

/**
 * @openapi
 * /api/library/albums/{id}:
 *   get:
 *     summary: Get album details with tracks
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Album ID or release group MBID
 *       - in: query
 *         name: includeTracks
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Include track listing
 *     responses:
 *       200:
 *         description: Album details with tracks and ownership info
 *       404:
 *         description: Album not found
 *       401:
 *         description: Not authenticated
 */
// GET /library/albums/:id
function buildRemoteAlbumTrackWheres(userId: string | undefined) {
    const likedTidal: Prisma.TrackTidalWhereInput = userId
        ? { likedBy: { some: { userId } } }
        : { id: { in: [] } };
    const likedYt: Prisma.TrackYtMusicWhereInput = userId
        ? { likedBy: { some: { userId } } }
        : { id: { in: [] } };
    return {
        likedTidal,
        likedYt,
        includedTidal: {
            ...likedTidal,
            albumEntity: { is: { location: "REMOTE" as const } },
        },
        includedYt: {
            ...likedYt,
            albumEntity: { is: { location: "REMOTE" as const } },
        },
    };
}

function buildAlbumDetailWhere(
    id: string,
    browseTrackWhere: Prisma.TrackWhereInput,
    likedTidal: Prisma.TrackTidalWhereInput,
    likedYt: Prisma.TrackYtMusicWhereInput,
): Prisma.AlbumWhereInput {
    return {
        AND: [
            { OR: [{ id }, { rgMbid: id }] },
            {
                OR: [
                    { tracks: { some: browseTrackWhere } },
                    {
                        location: "REMOTE",
                        tracksTidal: { some: likedTidal },
                    },
                    {
                        location: "REMOTE",
                        tracksYtMusic: { some: likedYt },
                    },
                ],
            },
        ],
    };
}

async function findAlbumWithTracks(
    where: Prisma.AlbumWhereInput,
    browseTrackWhere: Prisma.TrackWhereInput,
    tidalTrackWhere: Prisma.TrackTidalWhereInput,
    ytTrackWhere: Prisma.TrackYtMusicWhereInput,
) {
    return prisma.album.findFirst({
        where,
        include: {
            artist: { select: { id: true, mbid: true, name: true } },
            federationPeer: {
                select: { id: true, name: true, outboundStatus: true },
            },
            tracks: {
                where: browseTrackWhere,
                include: {
                    federationPeer: {
                        select: {
                            id: true,
                            name: true,
                            outboundStatus: true,
                        },
                    },
                },
                orderBy: [
                    { discNo: Prisma.SortOrder.asc },
                    { trackNo: Prisma.SortOrder.asc },
                ],
            },
            tracksTidal: {
                where: tidalTrackWhere,
                include: {
                    mappings: {
                        where: { stale: false },
                        select: { id: true, trackId: true },
                    },
                },
                orderBy: { title: Prisma.SortOrder.asc },
            },
            tracksYtMusic: {
                where: ytTrackWhere,
                include: {
                    mappings: {
                        where: { stale: false },
                        select: { id: true, trackId: true },
                    },
                },
                orderBy: { title: Prisma.SortOrder.asc },
            },
        },
    });
}

async function findAlbumWithoutTracks(where: Prisma.AlbumWhereInput) {
    return prisma.album.findFirst({
        where,
        include: {
            artist: { select: { id: true, mbid: true, name: true } },
            federationPeer: {
                select: { id: true, name: true, outboundStatus: true },
            },
        },
    });
}

type AlbumWithTracks = NonNullable<
    Awaited<ReturnType<typeof findAlbumWithTracks>>
>;
type AlbumDetailRequest = Request<{ id: string }>;

function formatLocalAlbumTracks(album: AlbumWithTracks) {
    return album.tracks.map(({ federationPeer, ...track }) => ({
        ...track,
        ...(track.origin === "FEDERATED" && federationPeer
            ? {
                  source: "federated" as const,
                  peer: {
                      id: federationPeer.id,
                      name: federationPeer.name,
                      online: federationPeer.outboundStatus === "ACTIVE",
                  },
              }
            : {}),
    }));
}

function formatTidalAlbumTracks(album: AlbumWithTracks) {
    return album.tracksTidal.map((track) => ({
        id: `tidal:${track.tidalId}`,
        title: track.title,
        duration: track.duration,
        trackNo: null,
        artist: {
            id: track.artistId ?? album.artist.id,
            name: track.artist || album.artist.name,
        },
        album: {
            id: album.id,
            title: track.album || album.title,
            coverArt: album.coverUrl,
            artist: album.artist,
        },
        source: "tidal" as const,
        streamSource: "tidal" as const,
        tidalTrackId: track.tidalId,
        provider: {
            tidalTrackId: track.tidalId,
            youtubeVideoId: null,
        },
    }));
}

function formatYtAlbumTracks(album: AlbumWithTracks) {
    return album.tracksYtMusic.map((track) => ({
        id: `yt:${track.videoId}`,
        title: track.title,
        duration: track.duration,
        trackNo: null,
        artist: {
            id: track.artistId ?? album.artist.id,
            name: track.artist || album.artist.name,
        },
        album: {
            id: album.id,
            title: track.album || album.title,
            coverArt: track.thumbnailUrl ?? album.coverUrl,
            artist: album.artist,
        },
        source: "youtube" as const,
        streamSource: "youtube" as const,
        youtubeVideoId: track.videoId,
        thumbnailUrl: track.thumbnailUrl ?? undefined,
        provider: {
            tidalTrackId: null,
            youtubeVideoId: track.videoId,
        },
    }));
}

type ProviderTrack =
    | AlbumWithTracks["tracksTidal"][number]
    | AlbumWithTracks["tracksYtMusic"][number];

function canonicalMappingKeys(track: ProviderTrack): string[] {
    return (track.mappings ?? []).flatMap((mapping) => [
        `mapping:${mapping.id}`,
        ...(mapping.trackId ? [`track:${mapping.trackId}`] : []),
    ]);
}

function formatRemoteAlbumTracks(album: AlbumWithTracks) {
    const tidalMappingKeys = new Set(
        album.tracksTidal.flatMap(canonicalMappingKeys),
    );
    // Prefer TIDAL when an active mapping proves both provider rows represent
    // one canonical recording. Unmapped provider rows remain independently playable.
    const uniqueYtTracks = album.tracksYtMusic.filter((track) =>
        canonicalMappingKeys(track).every((key) => !tidalMappingKeys.has(key)),
    );
    return [
        ...formatTidalAlbumTracks(album),
        ...formatYtAlbumTracks({ ...album, tracksYtMusic: uniqueYtTracks }),
    ];
}

function formatAlbumTracks(album: AlbumWithTracks | null) {
    if (!album) return [];
    const localTracks = formatLocalAlbumTracks(album);
    if (album.location !== "REMOTE") return localTracks;
    return [...localTracks, ...formatRemoteAlbumTracks(album)];
}

function formatAlbumSource(location: string) {
    if (location === "FEDERATED") return "federated" as const;
    if (location === "REMOTE") return "remote" as const;
    return "local" as const;
}

function publicAlbumFields(
    albumWithTracks: AlbumWithTracks | null,
    albumWithoutTracks: Awaited<ReturnType<typeof findAlbumWithoutTracks>>,
) {
    if (albumWithTracks) {
        const {
            federationPeer,
            tracks: _tracks,
            tracksTidal: _tracksTidal,
            tracksYtMusic: _tracksYtMusic,
            ...albumFields
        } = albumWithTracks;
        return { federationPeer, albumFields };
    }
    if (!albumWithoutTracks) return null;
    const { federationPeer, ...albumFields } = albumWithoutTracks;
    return { federationPeer, albumFields };
}

/**
 * Handles GET /api/library/albums/:id.
 */
export async function handleGetAlbum(req: AlbumDetailRequest, res: Response) {
    const idParam = req.params.id;
    const includeTracks = parseBooleanQueryParam(req.query.includeTracks, true);
    const browseTrackWhere = {
        ...TRACK_VISIBLE_WHERE,
        ...trackBrowseWhere("all"),
    };
    const remoteWheres = buildRemoteAlbumTrackWheres(req.user?.id);
    const albumWhere = buildAlbumDetailWhere(
        idParam,
        browseTrackWhere,
        remoteWheres.likedTidal,
        remoteWheres.likedYt,
    );
    const albumWithTracks = includeTracks
        ? await findAlbumWithTracks(
              albumWhere,
              browseTrackWhere,
              remoteWheres.includedTidal,
              remoteWheres.includedYt,
          )
        : null;
    const albumWithoutTracks = includeTracks
        ? null
        : await findAlbumWithoutTracks(albumWhere);
    const album = albumWithTracks ?? albumWithoutTracks;
    if (!album) {
        return sendRouteError(res, 404, "Album not found");
    }
    const owned = await prisma.ownedAlbum.findUnique({
        where: {
            artistId_rgMbid: {
                artistId: album.artistId,
                rgMbid: album.rgMbid,
            },
        },
    });
    const publicFields = publicAlbumFields(albumWithTracks, albumWithoutTracks);
    if (!publicFields) {
        return sendRouteError(res, 404, "Album not found");
    }
    const { federationPeer, albumFields } = publicFields;
    res.json({
        ...albumFields,
        source: formatAlbumSource(album.location),
        peer: federationPeer
            ? {
                  id: federationPeer.id,
                  name: federationPeer.name,
                  online: federationPeer.outboundStatus === "ACTIVE",
              }
            : undefined,
        artist: album.artist,
        tracks: formatAlbumTracks(albumWithTracks),
        owned: !!owned,
        coverArt: album.coverUrl,
    });
}

albumsBrowseRouter.get("/albums/:id", asyncHandler(handleGetAlbum));

/**
 * @openapi
 * /api/library/albums/{id}/preference:
 *   post:
 *     summary: Set preference (like/dislike) for all tracks in an album
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Album ID or release group MBID
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
 *         description: Album preference set successfully
 *       400:
 *         description: Invalid preference signal
 *       404:
 *         description: Album not found
 *       422:
 *         description: Album contains no local tracks
 *       401:
 *         description: Not authenticated
 */
// POST /library/albums/:id/preference
async function findAlbumLocalTrackIds(
    requestedAlbumId: string,
): Promise<{ albumId: string; trackIds: string[] } | null> {
    const album = await prisma.album.findFirst({
        where: {
            OR: [{ id: requestedAlbumId }, { rgMbid: requestedAlbumId }],
        },
        select: { id: true },
    });
    if (!album) return null;
    const tracks = await prisma.track.findMany({
        where: { albumId: album.id, ...TRACK_VISIBLE_WHERE },
        select: { id: true },
    });
    return {
        albumId: album.id,
        trackIds: Array.from(
            new Set(
                tracks
                    .map((track) => track.id)
                    .filter((trackId) => trackId.length > 0),
            ),
        ),
    };
}

/**
 * Handles POST /api/library/albums/:id/preference.
 */
export async function handleSetAlbumPreference(
    req: Request<{ id: string }>,
    res: Response,
) {
    const userId = req.user?.id;
    if (!userId) {
        return sendRouteError(res, 401, "Authentication required");
    }

    const signal = normalizeTrackPreferenceSignal(
        req.body?.signal ?? req.body?.score ?? req.body?.action,
    );

    if (!signal) {
        return res.status(400).json({
            error: "Invalid preference signal. Use thumbs_up, thumbs_down, or clear.",
        });
    }

    const album = await findAlbumLocalTrackIds(req.params.id);
    if (!album) {
        return sendRouteError(res, 404, "Album not found");
    }
    if (album.trackIds.length === 0) {
        return sendRouteError(
            res,
            422,
            "Album preferences require at least one local track",
        );
    }
    const now = new Date();

    await prisma.$transaction(async (tx) => {
        await applyTrackPreferenceSignalToTrackIds(
            tx,
            userId,
            album.trackIds,
            signal,
            now,
        );
    });

    const preference = resolveTrackPreference({
        likedAt: signal === "thumbs_up" ? now : null,
        dislikedAt: signal === "thumbs_down" ? now : null,
    });

    res.json(
        formatAlbumPreferenceResponse(
            album.albumId,
            album.trackIds.length,
            preference,
        ),
    );
}

albumsPreferenceRouter.post(
    "/albums/:id/preference",
    asyncHandler(handleSetAlbumPreference),
);

/**
 * @openapi
 * /api/library/albums/{id}:
 *   delete:
 *     summary: Delete an album and its tracks from the library and filesystem
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Album ID
 *     responses:
 *       200:
 *         description: Album deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 deletedFiles:
 *                   type: integer
 *       403:
 *         description: Library deletion is disabled or not admin
 *       404:
 *         description: Album not found
 *       401:
 *         description: Not authenticated
 */
// DELETE /library/albums/:id
/**
 * Handles DELETE /api/library/albums/:id.
 */
export async function handleDeleteAlbum(
    req: Request<{ id: string }>,
    res: Response,
) {
    const deletionsEnabled = await isLibraryDeletionEnabled();
    if (!deletionsEnabled) {
        return res.status(403).json({
            error: "Library deletion is disabled in admin settings",
        });
    }

    const album = await prisma.album.findUnique({
        where: { id: req.params.id },
        include: {
            artist: true,
            tracks: {
                include: {
                    album: true,
                },
            },
        },
    });

    if (!album) {
        return sendRouteError(res, 404, "Album not found");
    }

    await prisma.$transaction(async (transaction) => {
        await transaction.ownedAlbum.deleteMany({
            where: { rgMbid: album.rgMbid },
        });
        await transaction.album.delete({
            where: { id: album.id },
        });
    });

    // Delete track files only after the database transaction commits.
    let deletedFiles = 0;
    for (const track of album.tracks) {
        if (track.filePath) {
            const deletionPath = resolvePersistedTrackDeletionPath(
                track.filePath,
            );
            if (!deletionPath) {
                libraryDeletionLogger.warn(
                    "Skipped unsafe persisted album track path",
                );
            } else {
                try {
                    if (fs.existsSync(deletionPath.absolutePath)) {
                        fs.unlinkSync(deletionPath.absolutePath);
                        deletedFiles++;
                    }
                } catch (err) {
                    libraryDeletionLogger.warn(
                        "Could not delete album track file",
                        { error: err },
                    );
                }
            }
        }
    }

    // Try to delete album folder if empty
    try {
        const artistName = album.artist.name;
        const albumFolder = safeResolvePath(
            config.music.musicPath,
            path.join(artistName, album.title),
        );

        if (albumFolder && fs.existsSync(albumFolder)) {
            const files = fs.readdirSync(albumFolder);
            if (files.length === 0) {
                fs.rmdirSync(albumFolder);
                logger.debug(
                    `[DELETE] Deleted empty album folder: ${albumFolder}`,
                );
            }
        }
    } catch (err) {
        logger.warn("[DELETE] Could not delete album folder:", err);
    }

    logger.debug(
        `[DELETE] Deleted album: ${album.title} (${deletedFiles} files)`,
    );

    res.json({
        message: "Album deleted successfully",
        deletedFiles,
    });
}

albumsDeletionRouter.delete<{ id: string }>(
    "/albums/:id",
    requireAdmin,
    asyncHandler(handleDeleteAlbum),
);
