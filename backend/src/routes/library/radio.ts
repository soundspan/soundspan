import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../../middleware/asyncHandler";
import { prisma, Prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { config } from "../../config";
import { allocateTracksWithArtistWeighting } from "../../services/artistSlotAllocation";
import {
    getMergedGenres,
    getArtistDisplaySummary,
} from "../../utils/metadataOverrides";
import { getEffectiveYear, getDecadeFromYear } from "../../utils/dateFilters";
import { shuffleArray } from "../../utils/shuffle";
import { separateArtists } from "../../utils/separateArtists";
import { escapeLikePattern } from "../../utils/likePattern";
import { TRACK_VISIBLE_WHERE } from "../../utils/librarySorting";
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
    buildMultiTrackRadio,
    getRadioArtistCapForLimit,
    getRelaxedRadioArtistCapForLimit,
    selectTracksWithArtistDiversity,
} from "../../services/libraryRadioBuilder";
import {
    hasReliableEnhancedAnalysis,
    moodPoolCondition,
    VISIBLE_TRACK_SQL,
} from "../../utils/libraryRadioPredicates";
import {
    DEFAULT_MY_LIKED_LIMIT,
    isLibraryDeletionEnabled,
    MAX_LIMIT,
    MY_LIKED_PLAYLIST_DESCRIPTION,
    MY_LIKED_PLAYLIST_ID,
    MY_LIKED_PLAYLIST_NAME,
    parseBooleanQueryParam,
} from "../../utils/libraryRouteSupport";

/**
 * Router segment for radio routes registered at this position.
 */
export const radioRouter = Router();
/**
 * @openapi
 * /api/library/genres:
 *   get:
 *     summary: Get list of genres in the library with track counts
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of genres with track counts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 genres:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       genre:
 *                         type: string
 *                       count:
 *                         type: integer
 *       401:
 *         description: Not authenticated
 */
/**
 * Handles GET /api/library/genres.
 */
export async function handleGetGenres(req: Request, res: Response) {
    // Get artist names to filter them out of genres (they sometimes get incorrectly tagged)
    const artists = await prisma.artist.findMany({
        select: { name: true, normalizedName: true },
    });
    const artistNames = new Set(
        artists.flatMap((a) =>
            [a.name.toLowerCase(), a.normalizedName?.toLowerCase()].filter(
                Boolean,
            ),
        ),
    );

    // Query Artist.genres field (populated by enrichment from Last.fm tags)
    // Use raw SQL to expand JSONB array and count tracks per genre
    const minTracks = 15; // Minimum tracks for a genre to show up
    const genreResults = await prisma.$queryRaw<
        { genre: string; track_count: bigint }[]
    >`
            SELECT LOWER(g.genre) as genre, COUNT(DISTINCT t.id) as track_count
            FROM "Artist" ar
            CROSS JOIN LATERAL jsonb_array_elements_text(ar.genres::jsonb) AS g(genre)
            JOIN "Album" a ON a."artistId" = ar.id
            JOIN "Track" t ON t."albumId" = a.id
            WHERE ${VISIBLE_TRACK_SQL} AND ar.genres IS NOT NULL
            GROUP BY LOWER(g.genre)
            HAVING COUNT(DISTINCT t.id) >= ${minTracks}
            ORDER BY track_count DESC
            LIMIT 20
        `;

    // Filter out artist names and convert bigint to number
    const genres = genreResults
        .map((row) => ({
            genre: row.genre,
            count: Number(row.track_count),
        }))
        .filter((g) => !artistNames.has(g.genre.toLowerCase()));

    logger.debug(
        `[Genres] Found ${genres.length} genres from Artist.genres (min ${minTracks} tracks)`,
    );

    res.json({ genres });
}

radioRouter.get("/genres", asyncHandler(handleGetGenres));

/**
 * @openapi
 * /api/library/decades:
 *   get:
 *     summary: Get available decades in the library with track counts
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of decades with track counts (only decades with 15+ tracks)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 decades:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       decade:
 *                         type: integer
 *                         example: 1990
 *                       count:
 *                         type: integer
 *       401:
 *         description: Not authenticated
 */
/**
 * Handles GET /api/library/decades.
 */
export async function handleGetDecades(req: Request, res: Response) {
    // Get all albums with year fields and track count
    const albums = await prisma.album.findMany({
        select: {
            year: true,
            originalYear: true,
            displayYear: true,
            _count: {
                select: { tracks: { where: TRACK_VISIBLE_WHERE } },
            },
        },
    });

    // Group by decade using effective year (displayYear > originalYear > year)
    const decadeMap = new Map<number, number>();

    for (const album of albums) {
        const effectiveYear = getEffectiveYear(album);
        if (effectiveYear) {
            const decadeStart = getDecadeFromYear(effectiveYear);
            decadeMap.set(
                decadeStart,
                (decadeMap.get(decadeStart) || 0) + album._count.tracks,
            );
        }
    }

    // Convert to array, filter by minimum tracks, and sort by decade
    const decades = Array.from(decadeMap.entries())
        .map(([decade, count]) => ({ decade, count }))
        .filter((d) => d.count >= 15) // Minimum 15 tracks for a radio station
        .sort((a, b) => b.decade - a.decade); // Newest first

    res.json({ decades });
}

radioRouter.get("/decades", asyncHandler(handleGetDecades));

/**
 * @openapi
 * /api/library/radio:
 *   get:
 *     summary: Get tracks for a library-based radio station
 *     tags: [Library]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [all, liked, discovery, favorites, decade, genre, mood, workout, artist, artist-name, vibe]
 *         description: Radio station type
 *       - in: query
 *         name: value
 *         schema:
 *           type: string
 *         description: Value for the radio type (e.g. decade year, genre name, artist ID, track ID)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Number of tracks to return
 *     responses:
 *       200:
 *         description: Radio tracks queue
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tracks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 sourceFeatures:
 *                   type: object
 *                   description: Source track audio features (only for vibe mode)
 *       400:
 *         description: Radio type is required
 *       401:
 *         description: Not authenticated
 */
/**
 * Handles GET /api/library/radio.
 */
export async function handleGetRadio(req: Request, res: Response) {
    const { type, value, limit = "50" } = req.query;
    let radioType = typeof type === "string" ? type : "";
    let radioValue = typeof value === "string" ? value : undefined;
    const parsedLimit = Number.parseInt(String(limit), 10);
    const normalizedRequestedLimit =
        Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 50;
    const limitNum =
        radioType === "liked"
            ? Math.min(normalizedRequestedLimit, MAX_LIMIT)
            : Math.min(normalizedRequestedLimit, 100);
    const userId = req.user?.id;

    if (!radioType) {
        return sendRouteError(res, 400, "Radio type is required");
    }

    if (radioType === "artist-name") {
        const artistName = (radioValue ?? "").trim();
        if (!artistName) {
            return sendRouteError(
                res,
                400,
                "Artist name is required for artist-name radio",
            );
        }

        const matchedArtist = await prisma.artist.findFirst({
            where: { name: { equals: artistName, mode: "insensitive" } },
            select: { id: true },
        });

        if (!matchedArtist) {
            return res.json({ tracks: [] });
        }

        radioType = "artist";
        radioValue = matchedArtist.id;
    }

    let trackIds: string[] = [];
    let vibeSourceFeatures: any = null; // For vibe mode - store source track features

    switch (radioType) {
        case "discovery":
            // Lesser-played tracks - get tracks the user hasn't played or played least
            // First, get tracks with NO plays at all (truly undiscovered)
            const unplayedTracks = await prisma.$queryRaw<{ id: string }[]>`
                    SELECT t.id FROM "Track" t
                    WHERE ${VISIBLE_TRACK_SQL} AND NOT EXISTS (
                        SELECT 1 FROM "Play" p WHERE p."trackId" = t.id
                    )
                    ORDER BY random()
                    LIMIT ${limitNum * 4}
                `;

            if (unplayedTracks.length >= limitNum) {
                // The candidate pool is bounded and uniformly sampled in SQL.
                trackIds = unplayedTracks.map((t) => t.id);
            } else {
                // Fallback: get tracks with the fewest plays using raw count
                const leastPlayedTracks = await prisma.$queryRaw<
                    { id: string }[]
                >`
                        SELECT t.id
                        FROM "Track" t
                        LEFT JOIN "Play" p ON p."trackId" = t.id
                        WHERE ${VISIBLE_TRACK_SQL}
                        GROUP BY t.id
                        ORDER BY COUNT(p.id) ASC
                        LIMIT ${limitNum * 2}
                    `;
                trackIds = leastPlayedTracks.map((t) => t.id);
            }
            break;

        case "liked":
            if (!userId) {
                return res.status(401).json({
                    error: "Authentication required for liked radio",
                });
            }

            const likedTracks = await prisma.likedTrack.findMany({
                where: { userId },
                select: { trackId: true },
                orderBy: { likedAt: "desc" },
                take: limitNum,
            });
            trackIds = likedTracks.map((entry) => entry.trackId);
            logger.debug(
                `[Radio:liked] Loaded ${trackIds.length} liked tracks for user ${userId}`,
            );
            break;

        case "favorites":
            // Most-played tracks - use raw query for accurate count ordering
            const mostPlayedTracks = await prisma.$queryRaw<
                { id: string; play_count: bigint }[]
            >`
                    SELECT t.id, COUNT(p.id) as play_count
                    FROM "Track" t
                    LEFT JOIN "Play" p ON p."trackId" = t.id
                    WHERE ${VISIBLE_TRACK_SQL}
                    GROUP BY t.id
                    HAVING COUNT(p.id) > 0
                    ORDER BY play_count DESC
                    LIMIT ${limitNum * 2}
                `;

            if (mostPlayedTracks.length > 0) {
                trackIds = mostPlayedTracks.map((t) => t.id);
            } else {
                // No play data yet - just get random tracks
                logger.debug(
                    "[Radio:favorites] No play data found, returning random tracks",
                );
                const randomTracks = await prisma.$queryRaw<{ id: string }[]>`
                        SELECT t.id FROM "Track" t
                        WHERE ${VISIBLE_TRACK_SQL}
                        ORDER BY random()
                        LIMIT ${limitNum * 4}
                    `;
                trackIds = randomTracks.map((t) => t.id);
            }
            break;

        case "decade":
            // Filter by decade (e.g., value = "1990" for 90s)
            const decadeStart = parseInt(radioValue || "2000", 10) || 2000;

            // The candidate pool is bounded and uniformly sampled in SQL.
            const decadeTracks = await prisma.$queryRaw<{ id: string }[]>`
                    SELECT t.id FROM "Track" t
                    JOIN "Album" a ON a.id = t."albumId"
                    WHERE ${VISIBLE_TRACK_SQL} AND (
                        (a."originalYear" >= ${decadeStart} AND a."originalYear" < ${decadeStart + 10})
                        OR (a."originalYear" IS NULL AND a."year" >= ${decadeStart} AND a."year" < ${decadeStart + 10})
                    )
                    ORDER BY random()
                    LIMIT ${limitNum * 4}
                `;
            trackIds = decadeTracks.map((t) => t.id);
            break;

        case "genre": {
            const genreValue = (radioValue || "").toLowerCase();
            const genrePattern = `%${escapeLikePattern(genreValue)}%`;

            // Prefer track-level genre evidence (Last.fm track tags,
            // Essentia genres) so the pool is matching TRACKS — the
            // artist-level fallback below pulls whole discographies of
            // any artist whose broad tag list substring-matches, which
            // is how a couple of prolific artists owned every genre
            // station (GH #46). Pools are sampled uniformly
            // (ORDER BY random()) instead of an unordered LIMIT that
            // truncated to the same artist-clustered slice every time.
            const trackLevelGenreTracks = await prisma.$queryRaw<
                { id: string }[]
            >`
                    SELECT t.id
                    FROM "Track" t
                    WHERE ${VISIBLE_TRACK_SQL} AND (
                    EXISTS (
                        SELECT 1 FROM unnest(t."lastfmTags") AS tag(name)
                        WHERE LOWER(tag.name) LIKE ${genrePattern} ESCAPE '\\'
                    )
                    OR EXISTS (
                        SELECT 1 FROM unnest(t."essentiaGenres") AS eg(name)
                        WHERE LOWER(eg.name) LIKE ${genrePattern} ESCAPE '\\'
                    )
                    )
                    ORDER BY random()
                    LIMIT ${limitNum * 4}
                `;
            trackIds = trackLevelGenreTracks.map((t) => t.id);

            if (trackIds.length < limitNum) {
                // Fallback: artist-level genres (Artist.genres and
                // userGenres), uniformly sampled.
                const artistLevelGenreTracks = await prisma.$queryRaw<
                    { id: string }[]
                >`
                        SELECT DISTINCT t.id, random() AS sort_key
                        FROM "Artist" ar
                        JOIN "Album" a ON a."artistId" = ar.id
                        JOIN "Track" t ON t."albumId" = a.id
                        WHERE ${VISIBLE_TRACK_SQL} AND (
                            (ar.genres IS NOT NULL AND EXISTS (
                                SELECT 1 FROM jsonb_array_elements_text(ar.genres::jsonb) AS g(genre)
                                WHERE LOWER(g.genre) LIKE ${genrePattern} ESCAPE '\\'
                            ))
                            OR
                            (ar."userGenres" IS NOT NULL AND EXISTS (
                                SELECT 1 FROM jsonb_array_elements_text(ar."userGenres"::jsonb) AS ug(genre)
                                WHERE LOWER(ug.genre) LIKE ${genrePattern} ESCAPE '\\'
                            ))
                        )
                        ORDER BY sort_key
                        LIMIT ${limitNum * 4}
                    `;
                trackIds = [
                    ...new Set([
                        ...trackIds,
                        ...artistLevelGenreTracks.map((t) => t.id),
                    ]),
                ];
            }

            logger.debug(
                `[Radio:genre] Found ${trackIds.length} tracks for genre "${genreValue}" (track-level tags first, artist-level fallback)`,
            );
            break;
        }

        case "mood": {
            // Mood-based filtering using audio analysis features
            const moodValue = (radioValue || "").toLowerCase();
            const moodCondition = moodPoolCondition(moodValue);
            const moodTracks = await prisma.$queryRaw<{ id: string }[]>`
                    SELECT t.id FROM "Track" t
                    WHERE ${VISIBLE_TRACK_SQL} AND ${moodCondition}
                    ORDER BY random()
                    LIMIT ${limitNum * 4}
                `;
            trackIds = moodTracks.map((t) => t.id);
            break;
        }

        case "workout":
            // High-energy workout tracks - multiple strategies
            let workoutTrackIds: string[] = [];

            // Strategy 1: Audio analysis - high energy AND fast BPM
            const energyTracks = await prisma.$queryRaw<{ id: string }[]>`
                    SELECT t.id FROM "Track" t
                    WHERE ${VISIBLE_TRACK_SQL}
                      AND t."analysisStatus" = ${"completed"}
                      AND ((t.energy >= ${0.65} AND t.bpm >= ${115})
                           OR t."moodTags" && ARRAY[${"workout"}, ${"energetic"}, ${"upbeat"}]::text[])
                    ORDER BY random()
                    LIMIT ${limitNum * 4}
                `;
            workoutTrackIds = energyTracks.map((t) => t.id);
            logger.debug(
                `[Radio:workout] Found ${workoutTrackIds.length} tracks via audio analysis`,
            );

            // Strategy 2: Genre-based (if not enough from audio)
            if (workoutTrackIds.length < limitNum) {
                const workoutGenreNames = [
                    "rock",
                    "metal",
                    "hard rock",
                    "alternative rock",
                    "punk",
                    "hip hop",
                    "rap",
                    "trap",
                    "electronic",
                    "edm",
                    "house",
                    "techno",
                    "drum and bass",
                    "dubstep",
                    "hardstyle",
                    "metalcore",
                    "hardcore",
                    "industrial",
                    "nu metal",
                    "pop punk",
                ];

                // Check Genre table
                const workoutGenres = await prisma.genre.findMany({
                    where: {
                        name: {
                            in: workoutGenreNames,
                            mode: "insensitive",
                        },
                    },
                    include: {
                        trackGenres: {
                            select: { trackId: true },
                            take: 50,
                        },
                    },
                });

                const genreTrackIds = workoutGenres.flatMap((g) =>
                    g.trackGenres.map((tg) => tg.trackId),
                );
                workoutTrackIds = [
                    ...new Set([...workoutTrackIds, ...genreTrackIds]),
                ];
                logger.debug(
                    `[Radio:workout] After genre check: ${workoutTrackIds.length} tracks`,
                );

                // Also check album.genres JSON field
                if (workoutTrackIds.length < limitNum) {
                    const albumGenreTracks = await prisma.$queryRaw<
                        { id: string }[]
                    >`
                            SELECT t.id FROM "Track" t
                            JOIN "Album" a ON a.id = t."albumId"
                            WHERE ${VISIBLE_TRACK_SQL} AND a.genres IS NOT NULL
                              AND EXISTS (
                                SELECT 1 FROM unnest(${workoutGenreNames}::text[]) AS g(name)
                                WHERE (a.genres #>> '{}') LIKE '%' || g.name || '%'
                              )
                            ORDER BY random()
                            LIMIT ${limitNum * 2}
                        `;
                    workoutTrackIds = [
                        ...new Set([
                            ...workoutTrackIds,
                            ...albumGenreTracks.map((t) => t.id),
                        ]),
                    ];
                    logger.debug(
                        `[Radio:workout] After album genre check: ${workoutTrackIds.length} tracks`,
                    );
                }
            }

            trackIds = workoutTrackIds;
            break;

        case "artist":
            // Artist Radio - plays tracks from the artist + similar artists in library
            // Uses hybrid approach: Last.fm similarity (filtered to library) + genre matching + vibe boost
            const artistId = radioValue;
            if (!artistId) {
                return res
                    .status(400)
                    .json({ error: "Artist ID required for artist radio" });
            }

            logger.debug(
                `[Radio:artist] Starting artist radio for: ${artistId}`,
            );

            // 1. Get tracks from this artist (they're in library by definition)
            const artistTracks = await prisma.track.findMany({
                where: {
                    ...TRACK_VISIBLE_WHERE,
                    album: { artistId },
                },
                select: {
                    id: true,
                    bpm: true,
                    energy: true,
                    valence: true,
                    danceability: true,
                },
            });
            logger.debug(
                `[Radio:artist] Found ${artistTracks.length} tracks from artist`,
            );

            if (artistTracks.length === 0) {
                return res.json({ tracks: [] });
            }

            // Calculate artist's average "vibe" for later matching
            const analyzedTracks = artistTracks.filter(
                (t) => t.bpm || t.energy || t.valence,
            );
            const avgVibe =
                analyzedTracks.length > 0
                    ? {
                          bpm:
                              analyzedTracks.reduce(
                                  (sum, t) => sum + (t.bpm || 0),
                                  0,
                              ) / analyzedTracks.length,
                          energy:
                              analyzedTracks.reduce(
                                  (sum, t) => sum + (t.energy || 0),
                                  0,
                              ) / analyzedTracks.length,
                          valence:
                              analyzedTracks.reduce(
                                  (sum, t) => sum + (t.valence || 0),
                                  0,
                              ) / analyzedTracks.length,
                          danceability:
                              analyzedTracks.reduce(
                                  (sum, t) => sum + (t.danceability || 0),
                                  0,
                              ) / analyzedTracks.length,
                      }
                    : null;
            logger.debug(`[Radio:artist] Artist vibe:`, avgVibe);

            // 2. Get library artist IDs (artists user actually owns)
            const ownedArtists = await prisma.ownedAlbum.findMany({
                select: { artistId: true },
                distinct: ["artistId"],
            });
            const libraryArtistIds = new Set(
                ownedArtists.map((o) => o.artistId),
            );
            libraryArtistIds.delete(artistId); // Exclude the current artist
            logger.debug(
                `[Radio:artist] Library has ${libraryArtistIds.size} other artists`,
            );

            // 3. Try Last.fm similar artists, filtered to library
            const similarInLibrary = await prisma.similarArtist.findMany({
                where: {
                    fromArtistId: artistId,
                    toArtistId: { in: Array.from(libraryArtistIds) },
                },
                orderBy: { weight: "desc" },
                take: 15,
            });
            let similarArtistIds = similarInLibrary.map((s) => s.toArtistId);
            logger.debug(
                `[Radio:artist] Found ${similarArtistIds.length} Last.fm similar artists in library`,
            );

            // 4. Fallback: genre matching if not enough similar artists
            if (similarArtistIds.length < 5 && libraryArtistIds.size > 0) {
                const artist = await prisma.artist.findUnique({
                    where: { id: artistId },
                    select: { genres: true, userGenres: true },
                });
                const artistGenres = getMergedGenres(artist || {});

                if (artistGenres.length > 0) {
                    // Find library artists with overlapping genres
                    const genreMatchArtists = await prisma.artist.findMany({
                        where: {
                            id: { in: Array.from(libraryArtistIds) },
                        },
                        select: {
                            id: true,
                            genres: true,
                            userGenres: true,
                        },
                    });

                    // Score artists by genre overlap using merged genres
                    const scoredArtists = genreMatchArtists
                        .map((a) => {
                            const theirGenres = getMergedGenres(a);
                            const overlap = artistGenres.filter((g) =>
                                theirGenres.some(
                                    (tg) =>
                                        tg
                                            .toLowerCase()
                                            .includes(g.toLowerCase()) ||
                                        g
                                            .toLowerCase()
                                            .includes(tg.toLowerCase()),
                                ),
                            ).length;
                            return { id: a.id, score: overlap };
                        })
                        .filter((a) => a.score > 0)
                        .sort((a, b) => b.score - a.score)
                        .slice(0, 10);

                    const genreArtistIds = scoredArtists.map((a) => a.id);
                    similarArtistIds = [
                        ...new Set([...similarArtistIds, ...genreArtistIds]),
                    ];
                    logger.debug(
                        `[Radio:artist] After genre matching: ${similarArtistIds.length} similar artists`,
                    );
                }
            }

            // 5. Get tracks from similar library artists
            let similarTracks: {
                id: string;
                artistId: string;
                bpm: number | null;
                energy: number | null;
                valence: number | null;
                danceability: number | null;
                vibeScore?: number;
            }[] = [];
            if (similarArtistIds.length > 0) {
                const similarTrackRows = await prisma.track.findMany({
                    where: {
                        ...TRACK_VISIBLE_WHERE,
                        album: { artistId: { in: similarArtistIds } },
                    },
                    select: {
                        id: true,
                        bpm: true,
                        energy: true,
                        valence: true,
                        danceability: true,
                        album: {
                            select: {
                                artistId: true,
                            },
                        },
                    },
                });
                similarTracks = similarTrackRows.map((track) => ({
                    id: track.id,
                    artistId: track.album.artistId,
                    bpm: track.bpm,
                    energy: track.energy,
                    valence: track.valence,
                    danceability: track.danceability,
                }));
                logger.debug(
                    `[Radio:artist] Found ${similarTracks.length} tracks from similar artists`,
                );
            }

            // 6. Apply vibe boost if we have audio analysis data
            if (avgVibe && similarTracks.length > 0) {
                // Score each similar track by how close its vibe is to the artist's average
                similarTracks = similarTracks
                    .map((t) => {
                        if (!t.bpm && !t.energy && !t.valence)
                            return { ...t, vibeScore: 0.5 };

                        let score = 0;
                        let factors = 0;

                        if (t.bpm && avgVibe.bpm) {
                            // BPM within 20 = good match
                            const bpmDiff = Math.abs(t.bpm - avgVibe.bpm);
                            score += Math.max(0, 1 - bpmDiff / 40);
                            factors++;
                        }
                        if (t.energy !== null && avgVibe.energy) {
                            score +=
                                1 - Math.abs((t.energy || 0) - avgVibe.energy);
                            factors++;
                        }
                        if (t.valence !== null && avgVibe.valence) {
                            score +=
                                1 -
                                Math.abs((t.valence || 0) - avgVibe.valence);
                            factors++;
                        }
                        if (t.danceability !== null && avgVibe.danceability) {
                            score +=
                                1 -
                                Math.abs(
                                    (t.danceability || 0) -
                                        avgVibe.danceability,
                                );
                            factors++;
                        }

                        return {
                            ...t,
                            vibeScore: factors > 0 ? score / factors : 0.5,
                        };
                    })
                    .sort(
                        (a, b) => (b as any).vibeScore - (a as any).vibeScore,
                    );

                logger.debug(
                    `[Radio:artist] Applied vibe boost, top score: ${(
                        similarTracks[0] as any
                    )?.vibeScore?.toFixed(2)}`,
                );
            }

            const similarTrackPreferenceScores =
                await buildTrackPreferenceScoreMapForUser(
                    userId,
                    similarTracks.map((track) => track.id),
                );
            if (similarTrackPreferenceScores.size > 0) {
                similarTracks = similarTracks
                    .map((track) => {
                        const adjustedScore =
                            applyTrackPreferenceSimilarityBias(
                                track.vibeScore ?? 0.5,
                                similarTrackPreferenceScores.get(track.id) ?? 0,
                            );
                        return {
                            ...track,
                            vibeScore: adjustedScore,
                        };
                    })
                    .sort(
                        (left, right) =>
                            (right.vibeScore ?? 0) - (left.vibeScore ?? 0),
                    );
                logger.debug(
                    `[Radio:artist] Applied light preference weighting across ${similarTrackPreferenceScores.size} similar-track preferences`,
                );
            }

            // 7. Mix: ~40% original artist, ~60% similar (vibe-boosted)
            const originalCount = Math.min(
                Math.ceil(limitNum * 0.4),
                artistTracks.length,
            );
            const similarCount = Math.min(
                limitNum - originalCount,
                similarTracks.length,
            );
            const strictSimilarArtistCap = getRadioArtistCapForLimit(limitNum);
            const relaxedSimilarArtistCap =
                getRelaxedRadioArtistCapForLimit(limitNum);

            const selectedOriginal = shuffleArray(artistTracks).slice(
                0,
                originalCount,
            );
            // Prioritize top vibe matches, but cap per-similar-artist to avoid overrepresentation.
            const prioritizedSimilarPool = shuffleArray(
                similarTracks.slice(
                    0,
                    Math.max(similarCount * 3, similarCount),
                ),
            );
            const remainingSimilarPool = similarTracks.slice(
                Math.max(similarCount * 3, similarCount),
            );
            const selectedSimilar = selectTracksWithArtistDiversity(
                [...prioritizedSimilarPool, ...remainingSimilarPool],
                similarCount,
                strictSimilarArtistCap,
                relaxedSimilarArtistCap,
            );
            const uniqueSimilarArtists = new Set(
                selectedSimilar.map((track) => track.artistId),
            ).size;
            logger.debug(
                `[Radio:artist] Similar artist diversity cap strict=${strictSimilarArtistCap}, relaxed=${relaxedSimilarArtistCap}, unique artists=${uniqueSimilarArtists}`,
            );

            trackIds = [...selectedOriginal, ...selectedSimilar].map(
                (t) => t.id,
            );
            logger.debug(
                `[Radio:artist] Final mix: ${selectedOriginal.length} original + ${selectedSimilar.length} similar = ${trackIds.length} tracks`,
            );
            break;

        case "vibe":
            // Vibe Match - finds tracks that sound like the given track
            // Pure audio feature matching with graceful fallbacks
            const sourceTrackId = radioValue;
            if (!sourceTrackId) {
                return res
                    .status(400)
                    .json({ error: "Track ID required for vibe matching" });
            }

            logger.debug(
                `[Radio:vibe] Starting vibe match for track: ${sourceTrackId}`,
            );

            // 1. Get the source track's audio features (including Enhanced mode fields)
            const sourceTrack = (await prisma.track.findUnique({
                where: {
                    ...TRACK_VISIBLE_WHERE,
                    id: sourceTrackId,
                },
                include: {
                    album: {
                        select: {
                            artistId: true,
                            genres: true,
                            artist: { select: { id: true, name: true } },
                        },
                    },
                },
            })) as any; // Cast to any to include all Track fields

            if (!sourceTrack) {
                return sendRouteError(res, 404, "Track not found");
            }

            const sourceHasReliableEnhancedAnalysis =
                hasReliableEnhancedAnalysis(
                    sourceTrack.analysisMode,
                    sourceTrack.analysisVersion,
                );

            logger.debug(
                `[Radio:vibe] Source: "${sourceTrack.title}" by ${sourceTrack.album.artist.name}`,
            );
            logger.debug(
                `[Radio:vibe] Analysis mode: ${
                    sourceHasReliableEnhancedAnalysis ? "ENHANCED" : "STANDARD"
                }`,
            );
            logger.debug(
                `[Radio:vibe] Source features: BPM=${sourceTrack.bpm}, Energy=${sourceTrack.energy}, Valence=${sourceTrack.valence}`,
            );
            if (sourceHasReliableEnhancedAnalysis) {
                logger.debug(
                    `[Radio:vibe] ML Moods: Happy=${sourceTrack.moodHappy}, Sad=${sourceTrack.moodSad}, Relaxed=${sourceTrack.moodRelaxed}, Aggressive=${sourceTrack.moodAggressive}, Party=${sourceTrack.moodParty}, Acoustic=${sourceTrack.moodAcoustic}, Electronic=${sourceTrack.moodElectronic}`,
                );
            }

            // Store source features for frontend visualization
            vibeSourceFeatures = {
                bpm: sourceTrack.bpm,
                energy: sourceTrack.energy,
                valence: sourceTrack.valence,
                arousal: sourceTrack.arousal,
                danceability: sourceTrack.danceability,
                keyScale: sourceTrack.keyScale,
                instrumentalness: sourceTrack.instrumentalness,
                // Enhanced mode features (all 7 ML mood predictions)
                moodHappy: sourceTrack.moodHappy,
                moodSad: sourceTrack.moodSad,
                moodRelaxed: sourceTrack.moodRelaxed,
                moodAggressive: sourceTrack.moodAggressive,
                moodParty: sourceTrack.moodParty,
                moodAcoustic: sourceTrack.moodAcoustic,
                moodElectronic: sourceTrack.moodElectronic,
                analysisMode: sourceHasReliableEnhancedAnalysis
                    ? "enhanced"
                    : "standard",
            };

            let vibeMatchedIds: string[] = [];
            const sourceArtistId = sourceTrack.album.artistId;

            // 2. Try audio feature matching first (if track is analyzed)
            const hasAudioData =
                sourceTrack.bpm || sourceTrack.energy || sourceTrack.valence;

            if (hasAudioData) {
                // Get all analyzed tracks (excluding source) - include Enhanced mode fields
                const analyzedTracks = await prisma.track.findMany({
                    where: {
                        ...TRACK_VISIBLE_WHERE,
                        id: { not: sourceTrackId },
                        analysisStatus: "completed",
                    },
                    select: {
                        id: true,
                        bpm: true,
                        energy: true,
                        valence: true,
                        arousal: true,
                        danceability: true,
                        keyScale: true,
                        moodTags: true,
                        lastfmTags: true,
                        essentiaGenres: true,
                        instrumentalness: true,
                        // Enhanced mode fields (all 7 ML mood predictions)
                        moodHappy: true,
                        moodSad: true,
                        moodRelaxed: true,
                        moodAggressive: true,
                        moodParty: true,
                        moodAcoustic: true,
                        moodElectronic: true,
                        danceabilityMl: true,
                        analysisMode: true,
                        analysisVersion: true,
                    },
                });

                logger.debug(
                    `[Radio:vibe] Found ${analyzedTracks.length} analyzed tracks to compare`,
                );

                if (analyzedTracks.length > 0) {
                    // === COSINE SIMILARITY SCORING ===
                    // Industry-standard approach: build feature vectors, compute cosine similarity
                    // Uses ALL 13 features for comprehensive matching

                    // Enhanced valence: mode/tonality + mood + audio features
                    const calculateEnhancedValence = (track: any): number => {
                        const happy = track.moodHappy ?? 0.5;
                        const sad = track.moodSad ?? 0.5;
                        const party = (track as any).moodParty ?? 0.5;
                        const isMajor = track.keyScale === "major";
                        const isMinor = track.keyScale === "minor";
                        const modeValence = isMajor ? 0.3 : isMinor ? -0.2 : 0;
                        const moodValence =
                            happy * 0.35 + party * 0.25 + (1 - sad) * 0.2;
                        const audioValence =
                            (track.energy ?? 0.5) * 0.1 +
                            (track.danceabilityMl ??
                                track.danceability ??
                                0.5) *
                                0.1;

                        return Math.max(
                            0,
                            Math.min(
                                1,
                                moodValence + modeValence + audioValence,
                            ),
                        );
                    };

                    // Enhanced arousal: mood + energy + tempo (avoids unreliable "electronic" mood)
                    const calculateEnhancedArousal = (track: any): number => {
                        const aggressive = track.moodAggressive ?? 0.5;
                        const party = (track as any).moodParty ?? 0.5;
                        const relaxed = track.moodRelaxed ?? 0.5;
                        const acoustic = (track as any).moodAcoustic ?? 0.5;
                        const energy = track.energy ?? 0.5;
                        const bpm = track.bpm ?? 120;
                        const moodArousal = aggressive * 0.3 + party * 0.2;
                        const energyArousal = energy * 0.25;
                        const tempoArousal =
                            Math.max(0, Math.min(1, (bpm - 60) / 120)) * 0.15;
                        const calmReduction =
                            (1 - relaxed) * 0.05 + (1 - acoustic) * 0.05;

                        return Math.max(
                            0,
                            Math.min(
                                1,
                                moodArousal +
                                    energyArousal +
                                    tempoArousal +
                                    calmReduction,
                            ),
                        );
                    };

                    // OOD detection using Energy-based scoring
                    const detectOOD = (track: any): boolean => {
                        const coreMoods = [
                            track.moodHappy ?? 0.5,
                            track.moodSad ?? 0.5,
                            track.moodRelaxed ?? 0.5,
                            track.moodAggressive ?? 0.5,
                        ];

                        const minMood = Math.min(...coreMoods);
                        const maxMood = Math.max(...coreMoods);

                        // Enhanced OOD detection based on research
                        // Flag if all core moods are high (>0.7) with low variance, OR if all are very neutral (~0.5)
                        const allHigh =
                            minMood > 0.7 && maxMood - minMood < 0.3;
                        const allNeutral =
                            Math.abs(maxMood - 0.5) < 0.15 &&
                            Math.abs(minMood - 0.5) < 0.15;

                        return allHigh || allNeutral;
                    };

                    // Octave-aware BPM distance calculation
                    const octaveAwareBPMDistance = (
                        bpm1: number,
                        bpm2: number,
                    ): number => {
                        if (!bpm1 || !bpm2) return 0;

                        // Normalize to standard octave range (77-154 BPM)
                        const normalizeToOctave = (bpm: number): number => {
                            while (bpm < 77) bpm *= 2;
                            while (bpm > 154) bpm /= 2;
                            return bpm;
                        };

                        const norm1 = normalizeToOctave(bpm1);
                        const norm2 = normalizeToOctave(bpm2);

                        // Calculate distance on logarithmic scale for harmonic equivalence
                        const logDistance = Math.abs(
                            Math.log2(norm1) - Math.log2(norm2),
                        );
                        return Math.min(logDistance, 1); // Cap at 1 for similarity calculation
                    };

                    // Helper: Build enhanced weighted feature vector from track
                    const buildFeatureVector = (track: any): number[] => {
                        const trackHasReliableEnhancedAnalysis =
                            hasReliableEnhancedAnalysis(
                                track.analysisMode,
                                track.analysisVersion,
                            );
                        const isOOD =
                            trackHasReliableEnhancedAnalysis &&
                            detectOOD(track);

                        // Get mood values with OOD normalization
                        const getMoodValue = (
                            value: number | null,
                            defaultValue: number,
                        ): number => {
                            if (!value) return defaultValue;
                            if (!isOOD) return value;
                            // Normalize OOD predictions to spread them out (0.2-0.8 range)
                            return (
                                0.2 + Math.max(0, Math.min(0.6, value - 0.2))
                            );
                        };

                        // Use enhanced valence/arousal calculations
                        const enhancedValence = trackHasReliableEnhancedAnalysis
                            ? calculateEnhancedValence(track)
                            : (track.valence ?? 0.5);
                        const enhancedArousal = trackHasReliableEnhancedAnalysis
                            ? calculateEnhancedArousal(track)
                            : (track.arousal ?? track.energy ?? 0.5);

                        return [
                            // ML Mood predictions (7 features) - enhanced weighting and OOD handling
                            getMoodValue(
                                trackHasReliableEnhancedAnalysis
                                    ? track.moodHappy
                                    : null,
                                0.5,
                            ) * 1.3, // 1.3x weight for semantic features
                            getMoodValue(
                                trackHasReliableEnhancedAnalysis
                                    ? track.moodSad
                                    : null,
                                0.5,
                            ) * 1.3,
                            getMoodValue(
                                trackHasReliableEnhancedAnalysis
                                    ? track.moodRelaxed
                                    : null,
                                0.5,
                            ) * 1.3,
                            getMoodValue(
                                trackHasReliableEnhancedAnalysis
                                    ? track.moodAggressive
                                    : null,
                                0.5,
                            ) * 1.3,
                            getMoodValue(
                                trackHasReliableEnhancedAnalysis
                                    ? (track as any).moodParty
                                    : null,
                                0.5,
                            ) * 1.3,
                            getMoodValue(
                                trackHasReliableEnhancedAnalysis
                                    ? (track as any).moodAcoustic
                                    : null,
                                0.5,
                            ) * 1.3,
                            getMoodValue(
                                trackHasReliableEnhancedAnalysis
                                    ? (track as any).moodElectronic
                                    : null,
                                0.5,
                            ) * 1.3,
                            // Audio features (5 features) - standard weight
                            track.energy ?? 0.5,
                            enhancedArousal, // Use enhanced arousal
                            track.danceabilityMl ?? track.danceability ?? 0.5,
                            track.instrumentalness ?? 0.5,
                            // Octave-aware BPM normalized to 0-1
                            1 - octaveAwareBPMDistance(track.bpm ?? 120, 120), // Similarity to reference tempo
                            // Enhanced key mode with valence consideration
                            enhancedValence, // Use enhanced valence instead of binary key
                        ];
                    };

                    // Helper: Compute cosine similarity between two vectors
                    const cosineSimilarity = (
                        a: number[],
                        b: number[],
                    ): number => {
                        let dot = 0,
                            magA = 0,
                            magB = 0;
                        for (let i = 0; i < a.length; i++) {
                            dot += a[i] * b[i];
                            magA += a[i] * a[i];
                            magB += b[i] * b[i];
                        }
                        if (magA === 0 || magB === 0) return 0;
                        return dot / (Math.sqrt(magA) * Math.sqrt(magB));
                    };

                    // Helper: Compute tag overlap bonus
                    const computeTagBonus = (
                        sourceTags: string[],
                        sourceGenres: string[],
                        trackTags: string[],
                        trackGenres: string[],
                    ): number => {
                        const sourceSet = new Set(
                            [...sourceTags, ...sourceGenres].map((t) =>
                                t.toLowerCase(),
                            ),
                        );
                        const trackSet = new Set(
                            [...trackTags, ...trackGenres].map((t) =>
                                t.toLowerCase(),
                            ),
                        );
                        if (sourceSet.size === 0 || trackSet.size === 0)
                            return 0;
                        const overlap = [...sourceSet].filter((tag) =>
                            trackSet.has(tag),
                        ).length;
                        // Max 5% bonus for tag overlap
                        return Math.min(0.05, overlap * 0.01);
                    };

                    // Build source feature vector once
                    const sourceVector = buildFeatureVector(sourceTrack);
                    const vibePreferenceScores =
                        await buildTrackPreferenceScoreMapForUser(
                            userId,
                            analyzedTracks.map((track) => track.id),
                        );

                    // Check if source track has Enhanced mode data
                    const sourceUsesEnhancedFeatures =
                        sourceHasReliableEnhancedAnalysis;

                    const scored = analyzedTracks.map((t) => {
                        const targetUsesEnhancedFeatures =
                            hasReliableEnhancedAnalysis(
                                t.analysisMode,
                                t.analysisVersion,
                            );
                        const useEnhanced =
                            sourceUsesEnhancedFeatures &&
                            targetUsesEnhancedFeatures;

                        // Build target feature vector
                        const targetVector = buildFeatureVector(t as any);

                        // Compute base cosine similarity
                        let score = cosineSimilarity(
                            sourceVector,
                            targetVector,
                        );

                        // Add tag/genre overlap bonus (max 5%)
                        const tagBonus = computeTagBonus(
                            sourceTrack.lastfmTags || [],
                            sourceTrack.essentiaGenres || [],
                            t.lastfmTags || [],
                            t.essentiaGenres || [],
                        );

                        // Final score: 95% cosine similarity + 5% tag bonus,
                        // plus light thumbs preference weighting.
                        const finalScore = Math.max(
                            0,
                            Math.min(
                                1,
                                applyTrackPreferenceSimilarityBias(
                                    score * 0.95 + tagBonus,
                                    vibePreferenceScores.get(t.id) ?? 0,
                                ),
                            ),
                        );

                        return {
                            id: t.id,
                            score: finalScore,
                            enhanced: useEnhanced,
                        };
                    });

                    // Filter to good matches and sort by score
                    // Use lower threshold (40%) for Enhanced mode since it's more precise
                    const minThreshold = sourceHasReliableEnhancedAnalysis
                        ? 0.4
                        : 0.5;
                    const goodMatches = scored
                        .filter((t) => t.score > minThreshold)
                        .sort((a, b) => b.score - a.score);

                    vibeMatchedIds = goodMatches.map((t) => t.id);
                    const enhancedCount = goodMatches.filter(
                        (t) => t.enhanced,
                    ).length;
                    logger.debug(
                        `[Radio:vibe] Audio matching found ${
                            vibeMatchedIds.length
                        } tracks (>${minThreshold * 100}% similarity)`,
                    );
                    logger.debug(
                        `[Radio:vibe] Enhanced matches: ${enhancedCount}, Standard matches: ${
                            goodMatches.length - enhancedCount
                        }`,
                    );
                    if (vibePreferenceScores.size > 0) {
                        logger.debug(
                            `[Radio:vibe] Applied light preference weighting to ${vibePreferenceScores.size} analyzed candidates`,
                        );
                    }

                    if (goodMatches.length > 0) {
                        logger.debug(
                            `[Radio:vibe] Top match score: ${goodMatches[0].score.toFixed(
                                2,
                            )} (${
                                goodMatches[0].enhanced
                                    ? "enhanced"
                                    : "standard"
                            })`,
                        );
                    }
                }
            }

            // 3. Fallback A: Same artist's other tracks
            if (vibeMatchedIds.length < limitNum) {
                const artistTracks = await prisma.track.findMany({
                    where: {
                        ...TRACK_VISIBLE_WHERE,
                        album: { artistId: sourceArtistId },
                        id: { notIn: [sourceTrackId, ...vibeMatchedIds] },
                    },
                    select: { id: true },
                });
                const newIds = artistTracks.map((t) => t.id);
                vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                logger.debug(
                    `[Radio:vibe] Fallback A (same artist): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`,
                );
            }

            // 4. Fallback B: Similar artists from Last.fm (filtered to library)
            if (vibeMatchedIds.length < limitNum) {
                const ownedArtistIds = await prisma.ownedAlbum.findMany({
                    select: { artistId: true },
                    distinct: ["artistId"],
                });
                const libraryArtistSet = new Set(
                    ownedArtistIds.map((o) => o.artistId),
                );
                libraryArtistSet.delete(sourceArtistId);

                const similarArtists = await prisma.similarArtist.findMany({
                    where: {
                        fromArtistId: sourceArtistId,
                        toArtistId: { in: Array.from(libraryArtistSet) },
                    },
                    orderBy: { weight: "desc" },
                    take: 10,
                });

                if (similarArtists.length > 0) {
                    const similarArtistTracks = await prisma.track.findMany({
                        where: {
                            ...TRACK_VISIBLE_WHERE,
                            album: {
                                artistId: {
                                    in: similarArtists.map((s) => s.toArtistId),
                                },
                            },
                            id: {
                                notIn: [sourceTrackId, ...vibeMatchedIds],
                            },
                        },
                        select: { id: true },
                    });
                    const newIds = similarArtistTracks.map((t) => t.id);
                    vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                    logger.debug(
                        `[Radio:vibe] Fallback B (similar artists): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`,
                    );
                }
            }

            // 5. Fallback C: Same genre (using TrackGenre relation)
            const sourceGenres = (sourceTrack.album.genres as string[]) || [];
            if (vibeMatchedIds.length < limitNum && sourceGenres.length > 0) {
                // Search using the TrackGenre relation for better accuracy.
                const genreTracks = await prisma.$queryRaw<{ id: string }[]>`
                        SELECT t.id FROM "Track" t
                        WHERE ${VISIBLE_TRACK_SQL} AND EXISTS (
                            SELECT 1 FROM "TrackGenre" tg
                            JOIN "Genre" g ON g.id = tg."genreId"
                            WHERE tg."trackId" = t.id
                              AND LOWER(g.name) IN (${Prisma.join(
                                  sourceGenres.map((genre) =>
                                      genre.toLowerCase(),
                                  ),
                              )})
                        )
                        AND t.id NOT IN (${Prisma.join([
                            sourceTrackId,
                            ...vibeMatchedIds,
                        ])})
                        ORDER BY random()
                        LIMIT ${limitNum}
                    `;
                const newIds = genreTracks.map((t) => t.id);
                vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                logger.debug(
                    `[Radio:vibe] Fallback C (same genre): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`,
                );
            }

            // 6. Fallback D: Random from library
            if (vibeMatchedIds.length < limitNum) {
                const remainingLimit = limitNum - vibeMatchedIds.length;
                const randomTracks = await prisma.$queryRaw<{ id: string }[]>`
                        SELECT t.id FROM "Track" t
                        WHERE ${VISIBLE_TRACK_SQL} AND t.id NOT IN (${Prisma.join(
                            [sourceTrackId, ...vibeMatchedIds],
                        )})
                        ORDER BY random()
                        LIMIT ${remainingLimit}
                    `;
                const newIds = randomTracks.map((t) => t.id);
                vibeMatchedIds = [...vibeMatchedIds, ...newIds];
                logger.debug(
                    `[Radio:vibe] Fallback D (random): added ${newIds.length} tracks, total: ${vibeMatchedIds.length}`,
                );
            }

            trackIds = vibeMatchedIds;
            logger.debug(
                `[Radio:vibe] Final vibe queue: ${trackIds.length} tracks`,
            );
            break;

        case "playlist": {
            // Playlist radio — seeds from the playlist's local tracks
            if (!radioValue) {
                return sendRouteError(
                    res,
                    400,
                    "Playlist ID required for playlist radio",
                );
            }

            let seedTrackIds: string[];

            if (radioValue === MY_LIKED_PLAYLIST_ID) {
                // My Liked pseudo-playlist — requires auth
                if (!userId) {
                    return sendRouteError(
                        res,
                        401,
                        "Authentication required for liked playlist radio",
                    );
                }
                const likedEntries = await prisma.likedTrack.findMany({
                    where: { userId, track: TRACK_VISIBLE_WHERE },
                    select: { trackId: true },
                });
                seedTrackIds = likedEntries.map((e) => e.trackId);
                logger.debug(
                    `[Radio:playlist] Seeding from My Liked: ${seedTrackIds.length} tracks`,
                );
            } else {
                // Regular playlist — verify ownership or public visibility
                const playlist = await prisma.playlist.findUnique({
                    where: { id: radioValue },
                    select: { userId: true, isPublic: true },
                });
                if (!playlist) {
                    return sendRouteError(res, 404, "Playlist not found");
                }
                if (!playlist.isPublic && playlist.userId !== userId) {
                    return sendRouteError(
                        res,
                        403,
                        "Access denied to private playlist",
                    );
                }

                // Only local tracks have analysis data
                const items = await prisma.playlistItem.findMany({
                    where: {
                        playlistId: radioValue,
                        trackId: { not: null },
                        track: TRACK_VISIBLE_WHERE,
                    },
                    select: { trackId: true },
                });
                seedTrackIds = items
                    .map((i) => i.trackId)
                    .filter((id): id is string => id !== null);
                logger.debug(
                    `[Radio:playlist] Seeding from playlist ${radioValue}: ${seedTrackIds.length} local tracks`,
                );
            }

            if (seedTrackIds.length === 0) {
                trackIds = [];
                break;
            }

            const playlistResult = await buildMultiTrackRadio(
                seedTrackIds,
                seedTrackIds,
                limitNum,
                userId,
            );
            trackIds = playlistResult.trackIds;
            break;
        }

        case "tracks": {
            // Arbitrary multi-track seed radio — comma-separated track IDs
            if (!radioValue) {
                return sendRouteError(
                    res,
                    400,
                    "Track IDs required for tracks radio",
                );
            }

            const inputTrackIds = radioValue
                .split(",")
                .map((id) => id.trim())
                .filter((id) => id.length > 0);

            if (inputTrackIds.length === 0) {
                trackIds = [];
                break;
            }

            logger.debug(
                `[Radio:tracks] Seeding from ${inputTrackIds.length} track IDs`,
            );

            const tracksResult = await buildMultiTrackRadio(
                inputTrackIds,
                inputTrackIds,
                limitNum,
                userId,
            );
            trackIds = tracksResult.trackIds;
            break;
        }

        case "all":
        default:
            // Random selection from all tracks in library
            const allTracks = await prisma.$queryRaw<{ id: string }[]>`
                    SELECT t.id FROM "Track" t
                    WHERE ${VISIBLE_TRACK_SQL}
                    ORDER BY random()
                    LIMIT ${limitNum * 4}
                `;
            trackIds = allTracks.map((t) => t.id);
    }

    // Keep deterministic ordering for vibe (similarity-ranked) and liked (likedAt-ranked) queues.
    // Shuffle the source pool for all other radio modes.
    const preserveInputOrder =
        radioType === "vibe" ||
        radioType === "liked" ||
        radioType === "playlist" ||
        radioType === "tracks";
    // Artist radio already runs selectTracksWithArtistDiversity (the
    // reference cap implementation); every other generated pool goes
    // through the shared weighted allocator below (GH #46).
    const alreadyDiversified = radioType === "artist";
    const basePoolIds = preserveInputOrder
        ? trackIds
        : shuffleArray(trackIds).slice(0, Math.max(limitNum * 4, limitNum));
    let diversifiedPoolIds = basePoolIds;
    if (!preserveInputOrder && !alreadyDiversified && basePoolIds.length > 0) {
        const poolArtistRows = await prisma.track.findMany({
            where: {
                ...TRACK_VISIBLE_WHERE,
                id: { in: basePoolIds },
            },
            select: { id: true, album: { select: { artistId: true } } },
        });
        const artistByTrackId = new Map(
            poolArtistRows.map((row) => [row.id, row.album?.artistId ?? ""]),
        );
        diversifiedPoolIds = allocateTracksWithArtistWeighting(
            basePoolIds,
            (trackId, index) =>
                artistByTrackId.get(trackId) || `unknown:${index}`,
            {
                targetCount: limitNum,
                alpha: config.generationDiversity.weightAlpha,
                ceilingShare: config.generationDiversity.shareCeiling,
            },
        );
        logger.debug(
            `[Radio:${radioType}] Artist-weighted selection: ${diversifiedPoolIds.length}/${basePoolIds.length} tracks (alpha=${config.generationDiversity.weightAlpha}, ceiling=${config.generationDiversity.shareCeiling})`,
        );
    }
    const preferenceScoreMap =
        radioType === "liked"
            ? new Map<string, number>()
            : await buildTrackPreferenceScoreMapForUser(
                  userId,
                  diversifiedPoolIds,
              );
    const preferenceWeightedPoolIds =
        preferenceScoreMap.size > 0
            ? applyTrackPreferenceOrderBias(
                  diversifiedPoolIds,
                  preferenceScoreMap,
              )
            : diversifiedPoolIds;
    const finalIds = preferenceWeightedPoolIds.slice(0, limitNum);

    if (preferenceScoreMap.size > 0) {
        logger.debug(
            `[Radio:${radioType}] Applied light preference weighting using ${preferenceScoreMap.size} track preferences`,
        );
    }

    if (finalIds.length === 0) {
        return res.json({ tracks: [] });
    }

    // Fetch full track data (include all analysis fields for logging)
    const tracks = await prisma.track.findMany({
        where: {
            ...TRACK_VISIBLE_WHERE,
            id: { in: finalIds },
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
            trackGenres: {
                include: {
                    genre: { select: { name: true } },
                },
            },
        },
    });

    // Reorder tracks whenever we preserve input order since Prisma IN does not preserve ordering.
    let orderedTracks = tracks;
    if (preserveInputOrder) {
        const trackMap = new Map(tracks.map((t) => [t.id, t]));
        orderedTracks = finalIds
            .map((id) => trackMap.get(id))
            .filter((t): t is (typeof tracks)[0] => t !== undefined);
    }

    // === VIBE QUEUE LOGGING ===
    // Log detailed info for vibe matching analysis (using ordered tracks)
    if (radioType === "vibe" && vibeSourceFeatures) {
        logger.debug("\n" + "=".repeat(100));
        logger.debug("VIBE QUEUE ANALYSIS - Source Track");
        logger.debug("=".repeat(100));

        // Find source track for logging
        const srcTrack = await prisma.track.findUnique({
            where: {
                ...TRACK_VISIBLE_WHERE,
                id: radioValue as string,
            },
            include: {
                album: { include: { artist: { select: { name: true } } } },
                trackGenres: {
                    include: { genre: { select: { name: true } } },
                },
            },
        });

        if (srcTrack) {
            logger.debug(
                `SOURCE: "${srcTrack.title}" by ${srcTrack.album.artist.name}`,
            );
            logger.debug(`  Album: ${srcTrack.album.title}`);
            logger.debug(
                `  Analysis Mode: ${
                    (srcTrack as any).analysisMode || "unknown"
                }`,
            );
            logger.debug(
                `  BPM: ${srcTrack.bpm?.toFixed(1) || "N/A"} | Energy: ${
                    srcTrack.energy?.toFixed(2) || "N/A"
                } | Valence: ${srcTrack.valence?.toFixed(2) || "N/A"}`,
            );
            logger.debug(
                `  Danceability: ${
                    srcTrack.danceability?.toFixed(2) || "N/A"
                } | Arousal: ${
                    srcTrack.arousal?.toFixed(2) || "N/A"
                } | Key: ${srcTrack.keyScale || "N/A"}`,
            );
            logger.debug(
                `  ML Moods: Happy=${
                    (srcTrack as any).moodHappy?.toFixed(2) || "N/A"
                }, Sad=${
                    (srcTrack as any).moodSad?.toFixed(2) || "N/A"
                }, Relaxed=${
                    (srcTrack as any).moodRelaxed?.toFixed(2) || "N/A"
                }, Aggressive=${
                    (srcTrack as any).moodAggressive?.toFixed(2) || "N/A"
                }`,
            );
            logger.debug(
                `  Genres: ${
                    srcTrack.trackGenres
                        .map((tg) => tg.genre.name)
                        .join(", ") || "N/A"
                }`,
            );
            logger.debug(
                `  Last.fm Tags: ${
                    ((srcTrack as any).lastfmTags || []).join(", ") || "N/A"
                }`,
            );
            logger.debug(
                `  Mood Tags: ${
                    ((srcTrack as any).moodTags || []).join(", ") || "N/A"
                }`,
            );
        }

        logger.debug("\n" + "-".repeat(100));
        logger.debug(
            `VIBE QUEUE - ${orderedTracks.length} tracks (showing up to 50, SORTED BY MATCH SCORE)`,
        );
        logger.debug("-".repeat(100));
        logger.debug(
            `${"#".padEnd(3)} | ${"TRACK".padEnd(35)} | ${"ARTIST".padEnd(
                20,
            )} | ${"BPM".padEnd(6)} | ${"ENG".padEnd(5)} | ${"VAL".padEnd(
                5,
            )} | ${"H".padEnd(4)} | ${"S".padEnd(4)} | ${"R".padEnd(
                4,
            )} | ${"A".padEnd(4)} | MODE    | GENRES`,
        );
        logger.debug("-".repeat(100));

        orderedTracks.slice(0, 50).forEach((track, i) => {
            const t = track as any;
            const title = track.title.substring(0, 33).padEnd(35);
            const artist = track.album.artist.name.substring(0, 18).padEnd(20);
            const bpm = track.bpm
                ? track.bpm.toFixed(0).padEnd(6)
                : "N/A".padEnd(6);
            const energy =
                track.energy !== null
                    ? track.energy.toFixed(2).padEnd(5)
                    : "N/A".padEnd(5);
            const valence =
                track.valence !== null
                    ? track.valence.toFixed(2).padEnd(5)
                    : "N/A".padEnd(5);
            const happy =
                t.moodHappy !== null
                    ? t.moodHappy.toFixed(2).padEnd(4)
                    : "N/A".padEnd(4);
            const sad =
                t.moodSad !== null
                    ? t.moodSad.toFixed(2).padEnd(4)
                    : "N/A".padEnd(4);
            const relaxed =
                t.moodRelaxed !== null
                    ? t.moodRelaxed.toFixed(2).padEnd(4)
                    : "N/A".padEnd(4);
            const aggressive =
                t.moodAggressive !== null
                    ? t.moodAggressive.toFixed(2).padEnd(4)
                    : "N/A".padEnd(4);
            const mode = (t.analysisMode || "std").substring(0, 7).padEnd(8);
            const genres = track.trackGenres
                .slice(0, 3)
                .map((tg) => tg.genre.name)
                .join(", ");

            logger.debug(
                `${String(i + 1).padEnd(
                    3,
                )} | ${title} | ${artist} | ${bpm} | ${energy} | ${valence} | ${happy} | ${sad} | ${relaxed} | ${aggressive} | ${mode} | ${genres}`,
            );
        });

        if (orderedTracks.length > 50) {
            logger.debug(`... and ${orderedTracks.length - 50} more tracks`);
        }

        logger.debug("=".repeat(100) + "\n");
    }

    // Transform to match frontend Track interface
    const transformedTracks = orderedTracks.map((track) => ({
        id: track.id,
        title: track.title,
        duration: track.duration,
        trackNo: track.trackNo,
        filePath: track.filePath,
        artist: {
            id: track.album.artist.id,
            name: track.album.artist.name,
        },
        album: {
            id: track.album.id,
            title: track.album.title,
            coverArt: track.album.coverUrl,
        },
        // Include audio features for vibe mode visualization (if available)
        ...(vibeSourceFeatures && {
            audioFeatures: {
                bpm: track.bpm,
                energy: track.energy,
                valence: track.valence,
                arousal: track.arousal,
                danceability: track.danceability,
                keyScale: track.keyScale,
                instrumentalness: track.instrumentalness,
                analysisMode: track.analysisMode,
                // ML Mood predictions for enhanced visualization
                moodHappy: track.moodHappy,
                moodSad: track.moodSad,
                moodRelaxed: track.moodRelaxed,
                moodAggressive: track.moodAggressive,
                moodParty: track.moodParty,
                moodAcoustic: track.moodAcoustic,
                moodElectronic: track.moodElectronic,
            },
        }),
    }));

    // Keep deterministic ordering for vibe/liked queues. Shuffle all other radio queues.
    const finalTracks = preserveInputOrder
        ? transformedTracks
        : separateArtists(
              shuffleArray(transformedTracks),
              (t: any) => t.artist?.id ?? `unknown:${t.id}`,
          );

    // Include source features if this was a vibe request
    const response: any = { tracks: finalTracks };
    if (vibeSourceFeatures) {
        response.sourceFeatures = vibeSourceFeatures;
    }

    res.json(response);
}

radioRouter.get("/radio", asyncHandler(handleGetRadio));
