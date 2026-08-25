import { Router, type Request, type Response } from "express";
import {
    requireAdmin,
    requireAuth,
    requireAuthOrToken,
} from "../../middleware/auth";
import { asyncHandler } from "../../middleware/asyncHandler";
import { lastFmService } from "../../services/lastfm";
import { prisma, Prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { logger } from "../../utils/logger";
import path from "path";
import fs from "fs";
import { config } from "../../config";
import { resolveAlbumCover } from "../../services/metadata/albumCoverResolver";
import { musicBrainzService } from "../../services/musicbrainz";
import { dataCacheService } from "../../services/dataCache";
import {
    getMergedGenres,
    getArtistDisplaySummary,
} from "../../utils/metadataOverrides";
import { safeResolvePath } from "../../utils/safeResolvePath";
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
import { findRouteNameMatch } from "../artistRouteName";
import { deleteArtistCatalogEntry } from "../../services/artistCatalogDeletion";
import { withFederatedTrackPlayback } from "../../services/federatedTrackPayload";
import { bumpSearchCacheVersion } from "../../services/searchCacheVersion";
import {
    buildArtistTrackTitleIndex,
    filterDistinctDiscographyAlbums,
    findArtistTrackByTitle,
} from "./artistPageMatching";
import { resolveArtistImage } from "../../services/metadata/artistImageResolver";
import { isRealArtistMbid } from "../../utils/musicIds";

/**
 * Router segments for artists routes registered at their mount positions.
 */
export const artistsListRouter = Router();
export const artistsDetailRouter = Router();
export const artistsDeletionRouter = Router();
/**
 * @openapi
 * /api/library/artists:
 *   get:
 *     summary: List artists in the library with pagination and filtering
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: query
 *         schema:
 *           type: string
 *         description: Search filter by artist name
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of artists to return
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
 *           enum: [owned, discovery, remote, all]
 *           default: owned
 *         description: Filter by ownership type (remote = streaming-only artists)
 *       - in: query
 *         name: origin
 *         schema:
 *           type: string
 *           enum: [all, local, peers]
 *           default: all
 *         description: Filter artists by local or federated track origin
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Cursor ID for cursor-based pagination
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [name, name-desc, tracks]
 *           default: name
 *         description: Sort order
 *     responses:
 *       200:
 *         description: Paginated list of artists
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 artists:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 offset:
 *                   type: integer
 *                 limit:
 *                   type: integer
 *                 nextCursor:
 *                   type: string
 *                   nullable: true
 *       401:
 *         description: Not authenticated
 */
// GET /library/artists?query=&limit=&offset=&filter=owned|discovery|remote|all&cursor=
// Optimized with denormalized counts for O(1) filtering
/**
 * Handles GET /api/library/artists.
 */
export async function handleGetArtists(req: Request, res: Response) {
    try {
        const {
            query = "",
            limit: limitParam = "50",
            offset: offsetParam = "0",
            filter = "owned", // owned (default), discovery, remote, all
            cursor, // Optional cursor for cursor-based pagination
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
            parseInt(limitParam as string, 10) || 50,
            MAX_LIMIT,
        );
        const offset = parseInt(offsetParam as string, 10) || 0;

        const orderBy = ARTIST_SORT_MAP[sortBy as string] ?? {
            name: "asc" as const,
        };

        // Check whether denormalized counts have been backfilled.
        // If no artist has a non-null countsLastUpdated, the counts are stale
        // (e.g. fresh DB after first scan before backfill finishes) and we
        // must fall back to JOIN-based filtering to avoid returning 0 results.
        const countsReady =
            origin !== "peers" &&
            (await prisma.artist.count({
                where: { countsLastUpdated: { not: null } },
            })) > 0;

        // Build WHERE clause
        const where: Prisma.ArtistWhereInput = {};

        if (origin === "peers") {
            where.albums = {
                some: { tracks: { some: browseTrackWhere } },
            };
        } else if (countsReady) {
            // Fast path: use denormalized counts (indexed lookup)
            if (filter === "owned") {
                where.OR = [
                    { libraryAlbumCount: { gt: 0 } },
                    { ownedAlbums: { some: {} } },
                    ...(origin === "all" ? [{ peerId: { not: null } }] : []),
                ];
            } else if (filter === "discovery") {
                where.discoveryAlbumCount = { gt: 0 };
                where.libraryAlbumCount = 0;
            } else if (filter === "remote") {
                where.remoteTrackCount = { gt: 0 };
                where.libraryAlbumCount = 0;
                where.discoveryAlbumCount = 0;
            } else {
                // "all" — include library, discovery, and remote-only artists
                where.OR = [
                    { libraryAlbumCount: { gt: 0 } },
                    { discoveryAlbumCount: { gt: 0 } },
                    { remoteTrackCount: { gt: 0 } },
                    ...(origin === "all" ? [{ peerId: { not: null } }] : []),
                ];
            }
        } else {
            // Fallback: counts not yet backfilled — use JOINs
            if (filter === "owned") {
                where.OR = [
                    {
                        albums: {
                            some: {
                                location: "LIBRARY",
                                tracks: { some: browseTrackWhere },
                            },
                        },
                    },
                    { ownedAlbums: { some: {} } },
                ];
                if (origin === "all") {
                    where.OR.push({
                        albums: {
                            some: {
                                location: "FEDERATED",
                                tracks: { some: browseTrackWhere },
                            },
                        },
                    });
                }
            } else if (filter === "discovery") {
                where.albums = {
                    some: {
                        location: "DISCOVER",
                        tracks: { some: browseTrackWhere },
                    },
                };
                where.NOT = {
                    albums: {
                        some: {
                            location: "LIBRARY",
                            tracks: { some: browseTrackWhere },
                        },
                    },
                };
            } else if (filter === "remote") {
                where.OR = [
                    { tracksTidal: { some: {} } },
                    { tracksYtMusic: { some: {} } },
                ];
                where.NOT = {
                    albums: {
                        some: { tracks: { some: browseTrackWhere } },
                    },
                };
            } else {
                // "all" — include library, discovery, and remote-only
                where.OR = [
                    {
                        albums: {
                            some: { tracks: { some: browseTrackWhere } },
                        },
                    },
                    { tracksTidal: { some: {} } },
                    { tracksYtMusic: { some: {} } },
                ];
            }
        }

        // Add search query if provided
        if (query) {
            where.name = { contains: query as string, mode: "insensitive" };
        }

        // Execute queries with timeout to prevent cascade failures
        const [artists, total] = await prisma.$transaction(
            async (tx) => {
                // Build findMany args - cursor or offset pagination
                const findManyArgs = {
                    where,
                    take: limit,
                    orderBy,
                    select: {
                        id: true,
                        mbid: true,
                        name: true,
                        heroUrl: true,
                        userHeroUrl: true,
                        libraryAlbumCount: true,
                        discoveryAlbumCount: true,
                        totalTrackCount: true,
                        remoteTrackCount: true,
                        peerId: true,
                        federationPeer: {
                            select: {
                                id: true,
                                name: true,
                                outboundStatus: true,
                            },
                        },
                    },
                    cursor: cursor ? { id: cursor as string } : undefined,
                    skip: cursor ? 1 : offset,
                } satisfies Prisma.ArtistFindManyArgs;

                return Promise.all([
                    tx.artist.findMany(findManyArgs),
                    tx.artist.count({ where }),
                ]);
            },
            { timeout: 30000 }, // 30 second timeout as safety net
        );

        // Use DataCacheService for batch image lookup (DB + Redis, no API calls for lists)
        const imageMap = await dataCacheService.getArtistImagesBatch(
            artists.map((a) => ({
                id: a.id,
                heroUrl: a.heroUrl,
                userHeroUrl: a.userHeroUrl,
            })),
        );

        const artistsWithImages = artists.map((artist) => {
            const coverArt = imageMap.get(artist.id) || artist.heroUrl || null;

            // Use denormalized counts when ready, otherwise show raw sum
            const albumCount = countsReady
                ? filter === "discovery"
                    ? artist.discoveryAlbumCount
                    : filter === "all"
                      ? artist.libraryAlbumCount + artist.discoveryAlbumCount
                      : artist.libraryAlbumCount
                : artist.libraryAlbumCount + artist.discoveryAlbumCount;

            return {
                id: artist.id,
                mbid: artist.mbid,
                name: artist.name,
                heroUrl: coverArt,
                coverArt, // Alias for frontend consistency
                albumCount,
                trackCount: artist.totalTrackCount,
                ...(artist.peerId && artist.federationPeer
                    ? {
                          source: "federated" as const,
                          streamSource: "peer" as const,
                          peer: {
                              id: artist.federationPeer.id,
                              name: artist.federationPeer.name,
                              online:
                                  artist.federationPeer.outboundStatus ===
                                  "ACTIVE",
                          },
                      }
                    : {}),
            };
        });

        // Include cursor for next page (last artist ID)
        const nextCursor =
            artists.length === limit ? artists[artists.length - 1].id : null;

        res.json({
            artists: artistsWithImages,
            total,
            offset,
            limit,
            nextCursor, // For cursor-based pagination
        });
    } catch (error: any) {
        logger.error("[Library] Get artists error:", error?.message || error);
        logger.error("[Library] Stack:", error?.stack);
        res.status(500).json({
            error: "Failed to fetch artists",
        });
    }
}

artistsListRouter.get("/artists", handleGetArtists);

/**
 * @openapi
 * /api/library/artists/{id}:
 *   get:
 *     summary: Get detailed artist information including discography and similar artists
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Artist ID, name, or MusicBrainz ID
 *       - in: query
 *         name: includeDiscography
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Include full discography from MusicBrainz
 *       - in: query
 *         name: includeTopTracks
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Include top tracks from Last.fm
 *       - in: query
 *         name: includeSimilarArtists
 *         schema:
 *           type: boolean
 *           default: true
 *         description: Include similar artists
 *     responses:
 *       200:
 *         description: Artist details with albums, top tracks, and similar artists
 *       404:
 *         description: Artist not found
 *       401:
 *         description: Not authenticated
 */
// GET /library/artists/:id
/**
 * Handles GET /api/library/artists/:id.
 */
export async function handleGetArtist(
    req: Request<{ id: string }>,
    res: Response,
) {
    const idParam = req.params.id;
    const includeDiscography = parseBooleanQueryParam(
        req.query.includeDiscography,
        true,
    );
    const includeTopTracks = parseBooleanQueryParam(
        req.query.includeTopTracks,
        true,
    );
    const includeSimilarArtists = parseBooleanQueryParam(
        req.query.includeSimilarArtists,
        true,
    );
    const shouldResolveMbid =
        includeDiscography || includeTopTracks || includeSimilarArtists;
    const browseTrackWhere = {
        ...TRACK_VISIBLE_WHERE,
        ...trackBrowseWhere("all"),
    };

    const artistInclude = {
        albums: {
            where: { tracks: { some: browseTrackWhere } },
            orderBy: { year: Prisma.SortOrder.desc },
            include: {
                federationPeer: {
                    select: { id: true, name: true, outboundStatus: true },
                },
                tracks: {
                    where: browseTrackWhere,
                    orderBy: [
                        { discNo: Prisma.SortOrder.asc },
                        { trackNo: Prisma.SortOrder.asc },
                    ],
                    take: 10, // Top tracks
                    include: {
                        federationPeer: {
                            select: {
                                id: true,
                                name: true,
                                outboundStatus: true,
                            },
                        },
                        album: {
                            select: {
                                id: true,
                                title: true,
                                coverUrl: true,
                                albumLoudnessLufs: true,
                                albumTruePeakDb: true,
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
        },
        ownedAlbums: true,
        federationPeer: {
            select: { id: true, name: true, outboundStatus: true },
        },
        // similarFrom is retired; similarArtistsJson is fetched by default.
    };

    const artist = await findRouteNameMatch(idParam, (name) =>
        prisma.artist.findFirst({
            where: {
                OR: [
                    { id: idParam },
                    { name: { equals: name, mode: "insensitive" } },
                    { mbid: idParam },
                ],
            },
            include: artistInclude,
        }),
    );

    if (!artist) {
        return sendRouteError(res, 404, "Artist not found");
    }

    // For enriched artists with ownedAlbums, skip expensive MusicBrainz calls.
    // Only fetch from MusicBrainz if the artist hasn't been enriched yet.
    let albumsWithOwnership = [];
    const ownedRgMbids = new Set(artist.ownedAlbums.map((o) => o.rgMbid));

    // If artist has temp MBID, try to find real MBID by searching MusicBrainz
    let effectiveMbid = artist.mbid;
    if (shouldResolveMbid && !isRealArtistMbid(effectiveMbid)) {
        logger.debug(
            ` Artist has temp/no MBID, searching MusicBrainz for ${artist.name}...`,
        );
        try {
            const searchResults = await musicBrainzService.searchArtist(
                artist.name,
                1,
            );
            if (searchResults.length > 0) {
                effectiveMbid = searchResults[0].id;
                logger.debug(`  Found MBID: ${effectiveMbid}`);

                const existingOwner = await prisma.artist.findUnique({
                    where: { mbid: effectiveMbid },
                    select: { id: true },
                });

                // Update database with real MBID for future use (skip if duplicate).
                // Pre-check avoids noisy unique-constraint logs in common races.
                if (existingOwner && existingOwner.id !== artist.id) {
                    logger.debug(
                        `MBID ${effectiveMbid} already exists for another artist, skipping update`,
                    );
                } else {
                    try {
                        await prisma.artist.update({
                            where: { id: artist.id },
                            data: { mbid: effectiveMbid },
                        });
                    } catch (mbidError: any) {
                        // If MBID was claimed between pre-check and update, continue.
                        if (mbidError.code === "P2002") {
                            logger.debug(
                                `MBID ${effectiveMbid} already exists for another artist, skipping update`,
                            );
                        } else {
                            logger.error(
                                `  ✗ Failed to update MBID:`,
                                mbidError,
                            );
                        }
                    }
                }
            } else {
                logger.debug(
                    `  ✗ No MusicBrainz match found for ${artist.name}`,
                );
            }
        } catch (error) {
            logger.error(` MusicBrainz search failed:`, error);
        }
    }

    // Track whether we successfully loaded the full discography
    let discographyComplete = !includeDiscography;

    // Only LIBRARY/DISCOVER albums represent files on disk — REMOTE albums
    // are created by provider entity resolution and should not appear as owned.
    const dbAlbums = artist.albums
        .filter((album) => album.location !== "REMOTE")
        .map((album) => ({
            ...album,
            tracks: album.tracks.map(({ federationPeer, ...track }) =>
                withFederatedTrackPlayback(track, federationPeer),
            ),
            owned:
                album.location === "LIBRARY" || ownedRgMbids.has(album.rgMbid),
            coverArt: album.coverUrl,
            source: "database" as const,
            provenanceSource:
                album.location === "FEDERATED" ? "federated" : "local",
            peer: album.federationPeer
                ? {
                      id: album.federationPeer.id,
                      name: album.federationPeer.name,
                      online: album.federationPeer.outboundStatus === "ACTIVE",
                  }
                : undefined,
        }));

    logger.debug(
        `[Artist] Found ${dbAlbums.length} albums from database (excluding REMOTE-only)`,
    );

    if (!includeDiscography) {
        albumsWithOwnership = dbAlbums;
    } else {
        // Always fetch discography if we have a valid MBID - users need to see what's available
        const shouldFetchDiscography = isRealArtistMbid(effectiveMbid);

        if (shouldFetchDiscography) {
            const discoCacheKey = `discography:${effectiveMbid}`;
            try {
                // Check Redis cache first (cache for 24 hours)
                let releaseGroups: any[] = [];

                const cachedDisco = await redisClient.get(discoCacheKey);
                if (cachedDisco && cachedDisco !== "NOT_FOUND") {
                    releaseGroups = JSON.parse(cachedDisco);
                    logger.debug(
                        `[Artist] Using cached discography (${releaseGroups.length} albums)`,
                    );
                } else {
                    logger.debug(
                        `[Artist] Fetching discography from MusicBrainz...`,
                    );
                    releaseGroups = await musicBrainzService.getReleaseGroups(
                        effectiveMbid,
                        ["album", "ep"],
                        100,
                    );
                    // Cache for 24 hours
                    await redisClient.setEx(
                        discoCacheKey,
                        24 * 60 * 60,
                        JSON.stringify(releaseGroups),
                    );
                }

                logger.debug(
                    `  Got ${releaseGroups.length} albums from MusicBrainz (before filtering)`,
                );

                // Filter out live albums, compilations, soundtracks, remixes, etc.
                const excludedSecondaryTypes = [
                    "Live",
                    "Compilation",
                    "Soundtrack",
                    "Remix",
                    "DJ-mix",
                    "Mixtape/Street",
                    "Demo",
                    "Interview",
                    "Audio drama",
                    "Audiobook",
                    "Spokenword",
                ];

                const filteredReleaseGroups = releaseGroups.filter(
                    (rg: any) => {
                        // Keep if no secondary types (pure studio album/EP)
                        if (
                            !rg["secondary-types"] ||
                            rg["secondary-types"].length === 0
                        ) {
                            return true;
                        }
                        // Exclude if any secondary type matches our exclusion list
                        return !rg["secondary-types"].some((type: string) =>
                            excludedSecondaryTypes.includes(type),
                        );
                    },
                );

                logger.debug(
                    `  Filtered to ${filteredReleaseGroups.length} studio albums/EPs`,
                );

                // Transform MusicBrainz release groups to album format
                // PERFORMANCE: Only check Redis cache for covers, don't make API calls
                // This makes artist pages load instantly after the first visit
                const mbAlbums = await Promise.all(
                    filteredReleaseGroups.map(async (rg: any) => {
                        let coverUrl = null;

                        // Only check Redis cache - don't make external API calls
                        // Covers will be fetched lazily by the frontend or during enrichment
                        const cacheKey = `caa:${rg.id}`;
                        try {
                            const cached = await redisClient.get(cacheKey);
                            if (cached && cached !== "NOT_FOUND") {
                                coverUrl = cached;
                            }
                        } catch (err) {
                            // Redis error, continue without cover
                        }

                        return {
                            id: rg.id,
                            rgMbid: rg.id,
                            title: rg.title,
                            year: rg["first-release-date"]
                                ? parseInt(
                                      rg["first-release-date"].substring(0, 4),
                                  )
                                : null,
                            type: rg["primary-type"],
                            coverUrl,
                            coverArt: coverUrl,
                            artistId: artist.id,
                            owned: ownedRgMbids.has(rg.id),
                            trackCount: 0,
                            tracks: [],
                            source: "musicbrainz" as const,
                        };
                    }),
                );

                // Merge database albums with MusicBrainz albums
                // Database albums take precedence (they have actual files!)
                const mbAlbumsFiltered = filterDistinctDiscographyAlbums(
                    dbAlbums,
                    mbAlbums,
                );

                albumsWithOwnership = [...dbAlbums, ...mbAlbumsFiltered];

                logger.debug(
                    `  Total albums: ${albumsWithOwnership.length} (${dbAlbums.length} owned from database, ${mbAlbumsFiltered.length} from MusicBrainz)`,
                );
                logger.debug(
                    `  Owned: ${
                        albumsWithOwnership.filter((a) => a.owned).length
                    }, Available: ${
                        albumsWithOwnership.filter((a) => !a.owned).length
                    }`,
                );
                discographyComplete = true;
            } catch (error: any) {
                const transientErrorCodes = new Set([
                    "ECONNRESET",
                    "ECONNABORTED",
                    "ETIMEDOUT",
                    "EAI_AGAIN",
                    "ENOTFOUND",
                    "EHOSTUNREACH",
                    "ENETUNREACH",
                    "ERR_SOCKET_CLOSED",
                ]);
                const statusCode = Number(error?.response?.status);
                const isTransientMusicBrainzError =
                    transientErrorCodes.has(String(error?.code || "")) ||
                    (Number.isFinite(statusCode) &&
                        statusCode >= 500 &&
                        statusCode <= 599);

                if (isTransientMusicBrainzError) {
                    logger.warn(
                        `[Artist] MusicBrainz discography lookup failed for ${artist.name} (${effectiveMbid}): ${error?.message || "unknown error"}`,
                    );
                } else {
                    logger.error(
                        `Failed to fetch MusicBrainz discography:`,
                        error,
                    );
                }

                // Short-cache the miss to avoid rapid repeat retries during transient outages.
                try {
                    await redisClient.setEx(
                        discoCacheKey,
                        120,
                        JSON.stringify([]),
                    );
                } catch (cacheError) {
                    logger.debug(
                        "[Artist] Failed to write transient discography fallback cache:",
                        cacheError,
                    );
                }
                // Just use database albums - discographyComplete stays false
                albumsWithOwnership = dbAlbums;
            }
        } else {
            // No valid MBID - just use database albums
            // Still mark as complete since there's nothing more to fetch
            discographyComplete = true;
            logger.debug(
                `[Artist] No valid MBID, using ${dbAlbums.length} albums from database`,
            );
            albumsWithOwnership = dbAlbums;
        }
    }

    let similarArtists: any[] = [];
    let topTracks: any[] = [];

    if (includeTopTracks) {
        // Extract top tracks from library first
        const allTracks = artist.albums.flatMap((album) =>
            album.tracks.map(({ federationPeer, ...track }) =>
                withFederatedTrackPlayback(track, federationPeer),
            ),
        );
        topTracks = allTracks.slice(0, 10).map((track) => ({
            ...track,
            artist: track.album.artist,
        }));

        // Get user play counts for all tracks
        const userId = req.user!.id;
        const trackIds = allTracks.map((t) => t.id);
        const userPlays = await prisma.play.groupBy({
            by: ["trackId"],
            where: {
                userId,
                trackId: { in: trackIds },
            },
            _count: {
                id: true,
            },
        });
        const userPlayCounts = new Map(
            userPlays.map((p) => [p.trackId, p._count.id]),
        );

        // Fetch Last.fm top tracks (cached for 24 hours)
        const topTracksCacheKey = `top-tracks:${artist.id}`;
        try {
            // Check cache first
            const cachedTopTracks = await redisClient.get(topTracksCacheKey);
            let lastfmTopTracks: any[] = [];

            if (cachedTopTracks && cachedTopTracks !== "NOT_FOUND") {
                lastfmTopTracks = JSON.parse(cachedTopTracks);
                logger.debug(
                    `[Artist] Using cached top tracks (${lastfmTopTracks.length})`,
                );
            } else {
                // Cache miss - fetch from Last.fm
                const validMbid = isRealArtistMbid(effectiveMbid)
                    ? effectiveMbid
                    : "";
                lastfmTopTracks = await lastFmService.getArtistTopTracks(
                    validMbid,
                    artist.name,
                    10,
                );
                // Cache for 24 hours
                await redisClient.setEx(
                    topTracksCacheKey,
                    24 * 60 * 60,
                    JSON.stringify(lastfmTopTracks),
                );
                logger.debug(
                    `[Artist] Cached ${lastfmTopTracks.length} top tracks`,
                );
            }

            // Build lookup map for O(1) matching instead of O(n*m)
            const tracksByTitle = buildArtistTrackTitleIndex(allTracks);

            // For each Last.fm track, try to match with library track or add as unowned
            const combinedTracks: any[] = [];

            // Collect unowned tracks that need Deezer cover lookups
            const unownedEntries: Array<{
                index: number;
                lfmTrack: (typeof lastfmTopTracks)[number];
                albumTitle: string;
            }> = [];

            for (const lfmTrack of lastfmTopTracks) {
                const matchedTrack = findArtistTrackByTitle(
                    tracksByTitle,
                    lfmTrack.name,
                );

                if (matchedTrack) {
                    // Track exists in library - include user play count
                    combinedTracks.push({
                        ...matchedTrack,
                        artist: matchedTrack.album.artist,
                        playCount: lfmTrack.playcount
                            ? parseInt(lfmTrack.playcount)
                            : 0,
                        listeners: lfmTrack.listeners
                            ? parseInt(lfmTrack.listeners)
                            : 0,
                        userPlayCount: userPlayCounts.get(matchedTrack.id) || 0,
                        album: {
                            ...matchedTrack.album,
                            coverArt: matchedTrack.album.coverUrl,
                        },
                    });
                } else {
                    const albumTitle =
                        lfmTrack.album?.["#text"] || "Unknown Album";
                    // Push placeholder; coverArt will be filled after batch lookup
                    const idx = combinedTracks.length;
                    combinedTracks.push({
                        id: `lastfm-${artist.mbid || artist.name}-${
                            lfmTrack.name
                        }`,
                        title: lfmTrack.name,
                        playCount: lfmTrack.playcount
                            ? parseInt(lfmTrack.playcount)
                            : 0,
                        listeners: lfmTrack.listeners
                            ? parseInt(lfmTrack.listeners)
                            : 0,
                        duration: lfmTrack.duration
                            ? Math.floor(parseInt(lfmTrack.duration))
                            : 0,
                        url: lfmTrack.url,
                        artist: { name: artist.name },
                        album: {
                            title: albumTitle,
                            coverArt: null,
                        },
                        userPlayCount: 0,
                        // NO album.id - this indicates track is not in library
                    });
                    if (albumTitle !== "Unknown Album") {
                        unownedEntries.push({
                            index: idx,
                            lfmTrack,
                            albumTitle,
                        });
                    }
                }
            }

            if (unownedEntries.length > 0) {
                const covers = await Promise.all(
                    unownedEntries.map((entry) =>
                        resolveAlbumCover({
                            artistName: artist.name,
                            albumTitle: entry.albumTitle,
                        }).catch(() => null),
                    ),
                );
                for (let i = 0; i < unownedEntries.length; i++) {
                    if (covers[i]) {
                        combinedTracks[unownedEntries[i].index].album.coverArt =
                            covers[i]?.url ?? null;
                    }
                }
            }

            topTracks = combinedTracks.slice(0, 10);
        } catch (error) {
            logger.error(
                `Failed to get Last.fm top tracks for ${artist.name}:`,
                error,
            );
            // If Last.fm fails, add user play counts to library tracks
            topTracks = topTracks.map((t) => ({
                ...t,
                artist: t.album.artist,
                userPlayCount: userPlayCounts.get(t.id) || 0,
                album: {
                    ...t.album,
                    coverArt: t.album.coverUrl,
                },
            }));
        }
    }

    const heroUrl =
        includeDiscography || includeTopTracks || includeSimilarArtists
            ? await dataCacheService.getArtistImage(
                  artist.id,
                  artist.name,
                  effectiveMbid,
              )
            : (artist.userHeroUrl ?? artist.heroUrl ?? null);

    if (includeSimilarArtists) {
        const similarCacheKey = `similar-artists:${artist.id}`;
        const cachedSimilar = await redisClient.get(similarCacheKey);

        // Check if artist has pre-enriched similar artists JSON (full Last.fm data)
        const enrichedSimilar = artist.similarArtistsJson as Array<{
            name: string;
            mbid: string | null;
            match: number;
        }> | null;

        if (enrichedSimilar && enrichedSimilar.length > 0) {
            // Use pre-enriched data from database (fast path)
            logger.debug(
                `[Artist] Using ${enrichedSimilar.length} similar artists from enriched JSON`,
            );

            // First, batch lookup which similar artists exist in our library
            const similarNames = enrichedSimilar
                .slice(0, 10)
                .map((s) => s.name.toLowerCase());
            const similarMbids = enrichedSimilar
                .slice(0, 10)
                .map((s) => s.mbid)
                .filter(Boolean) as string[];

            // Find library artists matching by name or mbid
            const libraryMatches = await prisma.artist.findMany({
                where: {
                    OR: [
                        { normalizedName: { in: similarNames } },
                        ...(similarMbids.length > 0
                            ? [{ mbid: { in: similarMbids } }]
                            : []),
                    ],
                },
                select: {
                    id: true,
                    name: true,
                    normalizedName: true,
                    mbid: true,
                    heroUrl: true,
                    _count: {
                        select: {
                            albums: {
                                where: {
                                    location: "LIBRARY",
                                    tracks: { some: TRACK_VISIBLE_WHERE },
                                },
                            },
                        },
                    },
                },
            });

            // Create lookup maps for quick matching
            const libraryByName = new Map(
                libraryMatches.map((a) => [
                    a.normalizedName?.toLowerCase() || a.name.toLowerCase(),
                    a,
                ]),
            );
            const libraryByMbid = new Map(
                libraryMatches.filter((a) => a.mbid).map((a) => [a.mbid!, a]),
            );

            // Fetch missing images in parallel through the canonical facade.
            const similarWithImages = await Promise.all(
                enrichedSimilar.slice(0, 10).map(async (s) => {
                    // Check if this artist is in our library
                    const libraryArtist =
                        (s.mbid && libraryByMbid.get(s.mbid)) ||
                        libraryByName.get(s.name.toLowerCase());

                    let image = libraryArtist?.heroUrl || null;

                    // Persisted library images remain the first choice.
                    if (!image) {
                        try {
                            const resolved = await resolveArtistImage({
                                artistName: s.name,
                                mbid: s.mbid,
                            });
                            image = resolved?.url ?? null;
                        } catch (err) {
                            // Image resolution failed, leave null.
                        }
                    }

                    return {
                        id: libraryArtist?.id || s.name,
                        name: s.name,
                        mbid: s.mbid || null,
                        coverArt: image,
                        albumCount: 0, // Would require MusicBrainz lookup - skip for performance
                        ownedAlbumCount: libraryArtist?._count?.albums || 0,
                        weight: s.match,
                        inLibrary: !!libraryArtist,
                    };
                }),
            );

            similarArtists = similarWithImages;
        } else if (cachedSimilar && cachedSimilar !== "NOT_FOUND") {
            similarArtists = JSON.parse(cachedSimilar);
            logger.debug(
                `[Artist] Using cached similar artists (${similarArtists.length})`,
            );
        } else {
            // Cache miss - fetch from Last.fm
            logger.debug(`[Artist] Fetching similar artists from Last.fm...`);

            try {
                const validMbid = isRealArtistMbid(effectiveMbid)
                    ? effectiveMbid
                    : "";
                const lastfmSimilar = await lastFmService.getSimilarArtists(
                    validMbid,
                    artist.name,
                    10,
                );

                // Batch lookup which similar artists exist in our library
                const similarNames = lastfmSimilar.map((s: any) =>
                    s.name.toLowerCase(),
                );
                const similarMbids = lastfmSimilar
                    .map((s: any) => s.mbid)
                    .filter(Boolean) as string[];

                const libraryMatches = await prisma.artist.findMany({
                    where: {
                        OR: [
                            { normalizedName: { in: similarNames } },
                            ...(similarMbids.length > 0
                                ? [{ mbid: { in: similarMbids } }]
                                : []),
                        ],
                    },
                    select: {
                        id: true,
                        name: true,
                        normalizedName: true,
                        mbid: true,
                        heroUrl: true,
                        _count: {
                            select: {
                                albums: {
                                    where: {
                                        location: "LIBRARY",
                                        tracks: { some: TRACK_VISIBLE_WHERE },
                                    },
                                },
                            },
                        },
                    },
                });

                const libraryByName = new Map(
                    libraryMatches.map((a) => [
                        a.normalizedName?.toLowerCase() || a.name.toLowerCase(),
                        a,
                    ]),
                );
                const libraryByMbid = new Map(
                    libraryMatches
                        .filter((a) => a.mbid)
                        .map((a) => [a.mbid!, a]),
                );

                // Fetch missing images in parallel through the canonical facade.
                const similarWithImages = await Promise.all(
                    lastfmSimilar.map(async (s: any) => {
                        const libraryArtist =
                            (s.mbid && libraryByMbid.get(s.mbid)) ||
                            libraryByName.get(s.name.toLowerCase());

                        let image = libraryArtist?.heroUrl || null;

                        if (!image) {
                            try {
                                const resolved = await resolveArtistImage({
                                    artistName: s.name,
                                    mbid: s.mbid || null,
                                });
                                image = resolved?.url ?? null;
                            } catch (err) {
                                // Image resolution failed, leave null.
                            }
                        }

                        return {
                            id: libraryArtist?.id || s.name,
                            name: s.name,
                            mbid: s.mbid || null,
                            coverArt: image,
                            albumCount: 0,
                            ownedAlbumCount: libraryArtist?._count?.albums || 0,
                            weight: s.match,
                            inLibrary: !!libraryArtist,
                        };
                    }),
                );

                similarArtists = similarWithImages;

                // Cache for 24 hours
                await redisClient.setEx(
                    similarCacheKey,
                    24 * 60 * 60,
                    JSON.stringify(similarArtists),
                );
                logger.debug(
                    `[Artist] Cached ${similarArtists.length} similar artists`,
                );
            } catch (error) {
                logger.error(
                    `[Artist] Failed to fetch similar artists:`,
                    error,
                );
                similarArtists = [];
            }
        }
    }

    const { federationPeer, ...artistFields } = artist;
    res.json({
        ...artistFields,
        source: artist.peerId ? "federated" : "local",
        peer: federationPeer
            ? {
                  id: federationPeer.id,
                  name: federationPeer.name,
                  online: federationPeer.outboundStatus === "ACTIVE",
              }
            : undefined,
        coverArt: heroUrl, // Use fetched hero image (falls back to artist.heroUrl)
        bio: getArtistDisplaySummary(artist),
        genres: getMergedGenres(artist),
        albums: albumsWithOwnership,
        topTracks,
        similarArtists,
        discographyComplete,
    });
}

artistsDetailRouter.get("/artists/:id", asyncHandler(handleGetArtist));

/**
 * @openapi
 * /api/library/artists/{id}:
 *   delete:
 *     summary: Delete an artist and all their albums/tracks from the library and filesystem
 *     tags: [Library]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Artist ID
 *     responses:
 *       200:
 *         description: Artist deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 deletedFiles:
 *                   type: integer
 *                 lidarrDeleted:
 *                   type: boolean
 *                 lidarrError:
 *                   type: string
 *                   nullable: true
 *       403:
 *         description: Library deletion is disabled or not admin
 *       404:
 *         description: Artist not found
 *       401:
 *         description: Not authenticated
 */
// DELETE /library/artists/:id
/**
 * Handles DELETE /api/library/artists/:id.
 */
export async function handleDeleteArtist(
    req: Request<{ id: string }>,
    res: Response,
) {
    try {
        const deletionsEnabled = await isLibraryDeletionEnabled();
        if (!deletionsEnabled) {
            return res.status(403).json({
                error: "Library deletion is disabled in admin settings",
            });
        }

        const artist = await prisma.artist.findUnique({
            where: { id: req.params.id },
            include: {
                albums: {
                    include: {
                        tracks: true,
                    },
                },
            },
        });

        if (!artist) {
            return sendRouteError(res, 404, "Artist not found");
        }

        // Delete all track files and collect actual artist folders from file paths
        let deletedFiles = 0;
        const artistFoldersToDelete = new Set<string>();

        for (const album of artist.albums) {
            for (const track of album.tracks) {
                if (track.filePath) {
                    const deletionPath = resolvePersistedTrackDeletionPath(
                        track.filePath,
                    );
                    if (!deletionPath) {
                        libraryDeletionLogger.warn(
                            "Skipped unsafe persisted artist track path",
                        );
                    } else {
                        try {
                            if (fs.existsSync(deletionPath.absolutePath)) {
                                fs.unlinkSync(deletionPath.absolutePath);
                                deletedFiles++;

                                // Path format: Soulseek/Artist/Album/Track.mp3 OR Artist/Album/Track.mp3
                                const artistPathParts =
                                    deletionPath.pathParts[0].toLowerCase() ===
                                    "soulseek"
                                        ? deletionPath.pathParts.slice(0, 2)
                                        : deletionPath.pathParts.slice(0, 1);
                                const artistFolder = safeResolvePath(
                                    config.music.musicPath,
                                    artistPathParts.join("/"),
                                );
                                if (artistFolder) {
                                    artistFoldersToDelete.add(artistFolder);
                                }
                            }
                        } catch (err) {
                            libraryDeletionLogger.warn(
                                "Could not delete artist track file",
                                { error: err },
                            );
                        }
                    }
                }
            }
        }

        // Delete artist folders based on actual file paths, not database name
        for (const artistFolder of artistFoldersToDelete) {
            if (!isSafeRecursiveDeletionTarget(artistFolder)) {
                libraryDeletionLogger.warn(
                    "Skipped unsafe recursive artist folder target",
                );
                continue;
            }
            try {
                if (fs.existsSync(artistFolder)) {
                    logger.debug(
                        `[DELETE] Attempting to delete folder: ${artistFolder}`,
                    );

                    // Always try recursive delete with force
                    fs.rmSync(artistFolder, {
                        recursive: true,
                        force: true,
                    });
                    logger.debug(
                        `[DELETE] Successfully deleted artist folder: ${artistFolder}`,
                    );
                }
            } catch (err: any) {
                logger.error(
                    `[DELETE] Failed to delete artist folder ${artistFolder}:`,
                    err?.message || err,
                );

                // Try alternative: delete contents first, then folder
                try {
                    const files = fs.readdirSync(artistFolder);
                    for (const file of files) {
                        const filePath = safeResolvePath(artistFolder, file);
                        if (!filePath) {
                            continue;
                        }
                        try {
                            const stat = fs.statSync(filePath);
                            if (stat.isDirectory()) {
                                fs.rmSync(filePath, {
                                    recursive: true,
                                    force: true,
                                });
                            } else {
                                fs.unlinkSync(filePath);
                            }
                            logger.debug(`[DELETE] Deleted: ${filePath}`);
                        } catch (fileErr: any) {
                            logger.error(
                                `[DELETE] Could not delete ${filePath}:`,
                                fileErr?.message,
                            );
                        }
                    }
                    // Try deleting the now-empty folder
                    fs.rmdirSync(artistFolder);
                    logger.debug(
                        `[DELETE] Deleted artist folder after manual cleanup: ${artistFolder}`,
                    );
                } catch (cleanupErr: any) {
                    logger.error(
                        `[DELETE] Cleanup also failed for ${artistFolder}:`,
                        cleanupErr?.message,
                    );
                }
            }
        }

        // Also try deleting from common music folder paths (in case tracks weren't indexed)
        const commonPaths = [
            safeResolvePath(config.music.musicPath, artist.name),
            safeResolvePath(
                config.music.musicPath,
                path.join("Soulseek", artist.name),
            ),
            safeResolvePath(
                config.music.musicPath,
                path.join("discovery", artist.name),
            ),
        ].filter((candidatePath): candidatePath is string =>
            Boolean(candidatePath),
        );

        for (const commonPath of commonPaths) {
            if (
                isSafeRecursiveDeletionTarget(commonPath) &&
                fs.existsSync(commonPath) &&
                !artistFoldersToDelete.has(commonPath)
            ) {
                try {
                    fs.rmSync(commonPath, { recursive: true, force: true });
                    logger.debug(
                        `[DELETE] Deleted additional artist folder: ${commonPath}`,
                    );
                } catch (err: any) {
                    logger.error(
                        `[DELETE] Could not delete ${commonPath}:`,
                        err?.message,
                    );
                }
            }
        }

        // Delete from Lidarr if connected and artist has MBID
        let lidarrDeleted = false;
        let lidarrError: string | null = null;
        if (isRealArtistMbid(artist.mbid)) {
            try {
                const { lidarrService } = await import("../../services/lidarr");
                const lidarrResult = await lidarrService.deleteArtist(
                    artist.mbid,
                    true,
                );
                if (lidarrResult.success) {
                    logger.debug(`[DELETE] Lidarr: ${lidarrResult.message}`);
                    lidarrDeleted = true;
                } else {
                    logger.warn(
                        `[DELETE] Lidarr deletion note: ${lidarrResult.message}`,
                    );
                    lidarrError = lidarrResult.message;
                }
            } catch (err: any) {
                logger.warn(
                    "[DELETE] Could not delete from Lidarr:",
                    err?.message || err,
                );
                lidarrError = err?.message || "Unknown error";
            }
        }

        // Explicitly delete OwnedAlbum records first (should cascade, but being safe)
        try {
            await prisma.ownedAlbum.deleteMany({
                where: { artistId: artist.id },
            });
        } catch (err) {
            logger.warn("[DELETE] Could not delete OwnedAlbum records:", err);
        }

        // Delete from database (cascade will delete albums and tracks)
        logger.debug(
            `[DELETE] Deleting artist from database: ${artist.name} (${artist.id})`,
        );
        await deleteArtistCatalogEntry(artist.id);
        await bumpSearchCacheVersion();

        logger.debug(
            `[DELETE] Successfully deleted artist: ${
                artist.name
            } (${deletedFiles} files${
                lidarrDeleted ? ", removed from Lidarr" : ""
            })`,
        );

        res.json({
            message: "Artist deleted successfully",
            deletedFiles,
            lidarrDeleted,
            lidarrError,
        });
    } catch (error: any) {
        logger.error("Delete artist error:", error?.message || error);
        logger.error("Delete artist stack:", error?.stack);
        res.status(500).json({
            error: "Failed to delete artist",
        });
    }
}

artistsDeletionRouter.delete<{ id: string }>(
    "/artists/:id",
    requireAdmin,
    handleDeleteArtist,
);
