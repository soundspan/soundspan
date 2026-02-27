import { Router } from "express";
import * as fuzz from "fuzzball";
import { logger } from "../utils/logger";
import { requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { lastFmService } from "../services/lastfm";
import { normalizeForMatching, calculateSimilarity } from "../utils/fuzzyMatch";
import { extractPrimaryArtist, normalizeArtistName } from "../utils/artistNormalization";

const router = Router();

router.use(requireAuthOrToken);

type LastFmTrackLike = {
    name?: string;
    artist?: string | { name?: string };
    match?: number | string;
    url?: string;
};

type PreparedTrackCandidate = {
    track: any;
    normalizedTitle: string;
    normalizedArtist: string;
};

function parseLastFmArtistName(artist: LastFmTrackLike["artist"]): string {
    if (typeof artist === "string") return artist.trim();
    if (artist && typeof artist === "object" && typeof artist.name === "string") {
        return artist.name.trim();
    }
    return "Unknown artist";
}

function stripTrackVersionSuffix(input: string): string {
    return input
        .replace(/['`′ʼ]/g, "'")
        .replace(
            /\s*-\s*(\d{4}\s+)?(remaster(ed)?|deluxe|bonus|single|radio edit|remix|acoustic|live|mono|stereo|version|edition|mix)(\s+\d{4})?.*$/i,
            ""
        )
        .replace(/\s*\([^)]*(remaster|version|edition|mix|live)[^)]*\)\s*/gi, " ")
        .replace(/\s*\[[^\]]*(remaster|version|edition|mix|live)[^\]]*\]\s*/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeTrackTitleForMatch(title: string): string {
    return normalizeForMatching(stripTrackVersionSuffix(title || ""));
}

function parseSimilarityValue(value: number | string | undefined): number {
    if (typeof value === "number") {
        if (Number.isFinite(value)) return Math.max(0, Math.min(1, value));
        return 0;
    }
    if (typeof value === "string") {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed));
    }
    return 0;
}

function scoreTrackCandidate(
    lfmTitle: string,
    lfmArtist: string,
    candidate: PreparedTrackCandidate
) {
    const normalizedLfmTitle = normalizeTrackTitleForMatch(lfmTitle);
    const normalizedLfmArtist = normalizeArtistName(extractPrimaryArtist(lfmArtist));

    const titleFuzz = fuzz.token_set_ratio(normalizedLfmTitle, candidate.normalizedTitle) / 100;
    const titleSimple = calculateSimilarity(normalizedLfmTitle, candidate.normalizedTitle);
    const titleScore = Math.max(titleFuzz, titleSimple);

    const artistFuzz = fuzz.ratio(normalizedLfmArtist, candidate.normalizedArtist) / 100;
    const artistSimple = calculateSimilarity(normalizedLfmArtist, candidate.normalizedArtist);
    const artistScore = Math.max(artistFuzz, artistSimple);

    let finalScore = titleScore * 0.72 + artistScore * 0.28;

    // Penalize weak matches to avoid wrong in-library mapping.
    if (titleScore < 0.6) finalScore -= 0.15;
    if (artistScore < 0.5) finalScore -= 0.2;

    finalScore = Math.max(0, Math.min(1, finalScore));

    return {
        finalScore,
        titleScore,
        artistScore,
    };
}

/**
 * @openapi
 * /api/recommendations/for-you:
 *   get:
 *     summary: Get personalized artist recommendations based on listening history
 *     tags: [Recommendations]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Maximum number of recommended artists to return
 *     responses:
 *       200:
 *         description: Recommended artists with metadata and album counts
 *       401:
 *         description: Not authenticated
 */
router.get("/for-you", async (req, res) => {
    try {
        const { limit = "10" } = req.query;
        const userId = req.user!.id;
        const limitNum = parseInt(limit as string, 10);

        // Get user's most played artists
        const recentPlays = await prisma.play.findMany({
            where: { userId },
            orderBy: { playedAt: "desc" },
            take: 50,
            include: {
                track: {
                    include: {
                        album: {
                            include: {
                                artist: true,
                            },
                        },
                    },
                },
            },
        });

        // Count plays per artist
        const artistPlayCounts = new Map<
            string,
            { artist: any; count: number }
        >();
        for (const play of recentPlays) {
            const artist = play.track.album.artist;
            const existing = artistPlayCounts.get(artist.id);
            if (existing) {
                existing.count++;
            } else {
                artistPlayCounts.set(artist.id, { artist, count: 1 });
            }
        }

        // Sort by play count and get top 3 seed artists
        const topArtists = Array.from(artistPlayCounts.values())
            .sort((a, b) => b.count - a.count)
            .slice(0, 3);

        if (topArtists.length === 0) {
            // No listening history, return empty recommendations
            return res.json({ artists: [] });
        }

        // Get similar artists for each top artist
        const allSimilarArtists = await Promise.all(
            topArtists.map(async ({ artist }) => {
                const similar = await prisma.similarArtist.findMany({
                    where: { fromArtistId: artist.id },
                    orderBy: { weight: "desc" },
                    take: 10,
                    include: {
                        toArtist: {
                            select: {
                                id: true,
                                mbid: true,
                                name: true,
                                heroUrl: true,
                            },
                        },
                    },
                });
                return similar.map((s) => s.toArtist);
            })
        );

        // Flatten and deduplicate
        const recommendedArtists = Array.from(
            new Map(
                allSimilarArtists.flat().map((artist) => [artist.id, artist])
            ).values()
        );

        // Filter out artists user already owns (from native library)
        const ownedArtists = await prisma.ownedAlbum.findMany({
            select: { artistId: true },
            distinct: ["artistId"],
        });
        const ownedArtistIds = new Set(ownedArtists.map((a) => a.artistId));

        logger.debug(
            `Filtering recommendations: ${ownedArtistIds.size} owned artists to exclude`
        );

        const newArtists = recommendedArtists.filter(
            (artist) => !ownedArtistIds.has(artist.id)
        );

        // Get album counts for recommended artists (from enriched discography)
        const recommendedArtistIds = newArtists
            .slice(0, limitNum)
            .map((a) => a.id);
        const albumCounts = await prisma.album.groupBy({
            by: ["artistId"],
            where: { artistId: { in: recommendedArtistIds } },
            _count: { rgMbid: true },
        });
        const albumCountMap = new Map(
            albumCounts.map((ac) => [ac.artistId, ac._count.rgMbid])
        );

        // Only use cached data (DB heroUrl or Redis cache) - no API calls during page loads.
        // Background enrichment worker will populate cache over time.
        const { redisClient } = await import("../utils/redis");

        // Get all cached images in a single Redis call for efficiency
        const artistsToCheck = newArtists.slice(0, limitNum);
        const cacheKeys = artistsToCheck
            .filter(a => !a.heroUrl)
            .map(a => `hero:${a.id}`);
        
        let cachedImages: (string | null)[] = [];
        if (cacheKeys.length > 0) {
            try {
                cachedImages = await redisClient.mGet(cacheKeys);
            } catch (err) {
                // Redis errors are non-critical
            }
        }

        // Build a map from cache results
        const cachedImageMap = new Map<string, string>();
        let cacheIndex = 0;
        for (const artist of artistsToCheck) {
            if (!artist.heroUrl) {
                const cached = cachedImages[cacheIndex];
                if (cached && cached !== "NOT_FOUND") {
                    cachedImageMap.set(artist.id, cached);
                }
                cacheIndex++;
            }
        }

        const artistsWithMetadata = artistsToCheck.map((artist) => {
            // Use DB heroUrl first, then Redis cache, otherwise null
            const coverArt = artist.heroUrl || cachedImageMap.get(artist.id) || null;

            return {
                ...artist,
                coverArt,
                albumCount: albumCountMap.get(artist.id) || 0,
            };
        });

        logger.debug(
            `Recommendations: Found ${artistsWithMetadata.length} new artists`
        );
        artistsWithMetadata.forEach((a) => {
            logger.debug(
                `  ${a.name}: coverArt=${a.coverArt ? "YES" : "NO"}, albums=${
                    a.albumCount
                }`
            );
        });

        res.json({ artists: artistsWithMetadata });
    } catch (error) {
        logger.error("Get recommendations for you error:", error);
        res.status(500).json({ error: "Failed to get recommendations" });
    }
});

/**
 * @openapi
 * /api/recommendations:
 *   get:
 *     summary: Get similar artist recommendations for a seed artist
 *     tags: [Recommendations]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: seedArtistId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the seed artist to find similar artists for
 *     responses:
 *       200:
 *         description: Similar artists with top albums and similarity scores
 *       400:
 *         description: seedArtistId is required
 *       404:
 *         description: Artist not found
 *       401:
 *         description: Not authenticated
 */
router.get("/", async (req, res) => {
    try {
        const { seedArtistId } = req.query;

        if (!seedArtistId) {
            return res.status(400).json({ error: "seedArtistId required" });
        }

        // Get seed artist
        const seedArtist = await prisma.artist.findUnique({
            where: { id: seedArtistId as string },
        });

        if (!seedArtist) {
            return res.status(404).json({ error: "Artist not found" });
        }

        // Get similar artists from database
        const similarArtists = await prisma.similarArtist.findMany({
            where: { fromArtistId: seedArtistId as string },
            orderBy: { weight: "desc" },
            take: 20,
        });

        // Batch fetch all data instead of N+1 queries per similar artist
        const similarArtistIds = similarArtists.map((s) => s.toArtistId);

        const [artists, albums, ownedAlbums] = await Promise.all([
            prisma.artist.findMany({
                where: { id: { in: similarArtistIds } },
                select: { id: true, mbid: true, name: true, heroUrl: true },
            }),
            prisma.album.findMany({
                where: { artistId: { in: similarArtistIds } },
                include: { artist: true },
                orderBy: { year: "desc" },
            }),
            prisma.ownedAlbum.findMany({
                where: { artistId: { in: similarArtistIds } },
                select: { artistId: true, rgMbid: true },
            }),
        ]);

        const artistMap = new Map(artists.map((a) => [a.id, a]));
        const albumsByArtist = new Map<string, typeof albums>();
        for (const album of albums) {
            const list = albumsByArtist.get(album.artistId) || [];
            list.push(album);
            albumsByArtist.set(album.artistId, list);
        }
        const ownedByArtist = new Map<string, Set<string>>();
        for (const o of ownedAlbums) {
            const set = ownedByArtist.get(o.artistId) || new Set();
            set.add(o.rgMbid);
            ownedByArtist.set(o.artistId, set);
        }

        const recommendations = similarArtists.map((similar) => {
            const artist = artistMap.get(similar.toArtistId);
            const artistAlbums = (albumsByArtist.get(similar.toArtistId) || []).slice(0, 3);
            const ownedRgMbids = ownedByArtist.get(similar.toArtistId) || new Set();

            return {
                artist: {
                    id: artist?.id,
                    mbid: artist?.mbid,
                    name: artist?.name,
                    heroUrl: artist?.heroUrl,
                },
                similarity: similar.weight,
                topAlbums: artistAlbums.map((album) => ({
                    ...album,
                    owned: ownedRgMbids.has(album.rgMbid),
                })),
            };
        });

        res.json({
            seedArtist: {
                id: seedArtist.id,
                name: seedArtist.name,
            },
            recommendations,
        });
    } catch (error) {
        logger.error("Get recommendations error:", error);
        res.status(500).json({ error: "Failed to get recommendations" });
    }
});

/**
 * @openapi
 * /api/recommendations/albums:
 *   get:
 *     summary: Get album recommendations based on a seed album
 *     tags: [Recommendations]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: seedAlbumId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the seed album to find similar albums for
 *     responses:
 *       200:
 *         description: Recommended albums from similar artists and matching genres
 *       400:
 *         description: seedAlbumId is required
 *       404:
 *         description: Album not found
 *       401:
 *         description: Not authenticated
 */
router.get("/albums", async (req, res) => {
    try {
        const { seedAlbumId } = req.query;

        if (!seedAlbumId) {
            return res.status(400).json({ error: "seedAlbumId required" });
        }

        // Get seed album
        const seedAlbum = await prisma.album.findUnique({
            where: { id: seedAlbumId as string },
            include: {
                artist: true,
                tracks: {
                    include: {
                        trackGenres: {
                            include: {
                                genre: true,
                            },
                        },
                    },
                },
            },
        });

        if (!seedAlbum) {
            return res.status(404).json({ error: "Album not found" });
        }

        // Get genre tags from the album's tracks
        const genreTags = Array.from(
            new Set(
                seedAlbum.tracks.flatMap((track) =>
                    track.trackGenres.map((tg) => tg.genre.name)
                )
            )
        );

        // Strategy 1: Get albums from similar artists
        const similarArtists = await prisma.similarArtist.findMany({
            where: { fromArtistId: seedAlbum.artistId },
            orderBy: { weight: "desc" },
            take: 10,
        });

        const similarArtistAlbums = await prisma.album.findMany({
            where: {
                artistId: { in: similarArtists.map((sa) => sa.toArtistId) },
                id: { not: seedAlbumId as string }, // Exclude seed album
            },
            include: {
                artist: true,
            },
            orderBy: { year: "desc" },
            take: 15,
        });

        // Strategy 2: Get albums with matching genres
        let genreMatchAlbums: any[] = [];
        if (genreTags.length > 0) {
            genreMatchAlbums = await prisma.album.findMany({
                where: {
                    id: { not: seedAlbumId as string },
                    tracks: {
                        some: {
                            trackGenres: {
                                some: {
                                    genre: {
                                        name: { in: genreTags },
                                    },
                                },
                            },
                        },
                    },
                },
                include: {
                    artist: true,
                },
                take: 10,
            });
        }

        // Combine and deduplicate
        const allAlbums = [...similarArtistAlbums, ...genreMatchAlbums];
        const uniqueAlbums = Array.from(
            new Map(allAlbums.map((album) => [album.id, album])).values()
        );

        // Batch check ownership instead of N+1
        const slicedAlbums = uniqueAlbums.slice(0, 20);
        const artistIdsForOwnership = [...new Set(slicedAlbums.map((a) => a.artistId))];
        const ownedAlbumsForRec = await prisma.ownedAlbum.findMany({
            where: { artistId: { in: artistIdsForOwnership } },
            select: { rgMbid: true },
        });
        const ownedRgMbidSet = new Set(ownedAlbumsForRec.map((o) => o.rgMbid));

        const recommendations = slicedAlbums.map((album) => ({
            ...album,
            owned: ownedRgMbidSet.has(album.rgMbid),
        }));

        res.json({
            seedAlbum: {
                id: seedAlbum.id,
                title: seedAlbum.title,
                artist: seedAlbum.artist.name,
            },
            recommendations,
        });
    } catch (error) {
        logger.error("Get album recommendations error:", error);
        res.status(500).json({
            error: "Failed to get album recommendations",
        });
    }
});

/**
 * @openapi
 * /api/recommendations/tracks:
 *   get:
 *     summary: Get track recommendations using Last.fm similarity
 *     tags: [Recommendations]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: seedTrackId
 *         schema:
 *           type: string
 *         description: ID of the seed track (falls back to artist+title if not in DB)
 *       - in: query
 *         name: artist
 *         schema:
 *           type: string
 *         description: Artist name (used as fallback when seedTrackId is unavailable)
 *       - in: query
 *         name: title
 *         schema:
 *           type: string
 *         description: Track title (used as fallback when seedTrackId is unavailable)
 *     responses:
 *       200:
 *         description: Similar tracks with library match info and confidence scores
 *       400:
 *         description: seedTrackId or artist+title required
 *       401:
 *         description: Not authenticated
 */
router.get("/tracks", async (req, res) => {
    try {
        const { seedTrackId, artist: artistParam, title: titleParam } = req.query;

        if (!seedTrackId && !artistParam) {
            return res.status(400).json({ error: "seedTrackId or artist+title required" });
        }

        // Get seed track
        const seedTrack = seedTrackId
            ? await prisma.track.findUnique({
                  where: { id: seedTrackId as string },
                  include: {
                      album: {
                          include: {
                              artist: true,
                          },
                      },
                  },
              })
            : null;

        const seedArtistName = seedTrack?.album.artist.name
            || (typeof artistParam === "string" ? artistParam.trim() : "");
        const seedTitle = seedTrack?.title
            || (typeof titleParam === "string" ? titleParam.trim() : "");

        if (!seedArtistName || !seedTitle) {
            return res.status(400).json({ error: "Could not resolve seed artist and title" });
        }

        // Use Last.fm to get similar tracks
        const similarTracksFromLastFm = await lastFmService.getSimilarTracks(
            seedArtistName,
            seedTitle,
            20
        );
        const lfmTracks = (similarTracksFromLastFm as LastFmTrackLike[])
            .map((track) => ({
                title: (track.name || "").trim(),
                artist: parseLastFmArtistName(track.artist),
                similarity: parseSimilarityValue(track.match),
                lastFmUrl: typeof track.url === "string" ? track.url : null,
            }))
            .filter((track) => track.title.length > 0);

        // Fallback for tracks/artists with sparse Last.fm similarity data.
        if (lfmTracks.length === 0) {
            let sameArtistTracks: any[] = [];
            if (seedTrack) {
                sameArtistTracks = await prisma.track.findMany({
                    where: {
                        id: { not: seedTrack.id },
                        album: {
                            artistId: seedTrack.album.artist.id,
                        },
                    },
                    include: {
                        album: { include: { artist: true } },
                    },
                    take: 20,
                });
            } else if (seedArtistName) {
                sameArtistTracks = await prisma.track.findMany({
                    where: {
                        album: {
                            artist: {
                                OR: [
                                    { name: { equals: seedArtistName, mode: "insensitive" } },
                                    { normalizedName: normalizeArtistName(seedArtistName) },
                                ],
                            },
                        },
                    },
                    include: {
                        album: { include: { artist: true } },
                    },
                    take: 20,
                });
            }

            const fallbackRecommendations = sameArtistTracks.map((track) => ({
                ...track,
                inLibrary: true,
                similarity: 0,
                matchConfidence: 100,
                recommendationSource: "same-artist-fallback",
            }));

            return res.json({
                seedTrack: {
                    id: seedTrack?.id || null,
                    title: seedTitle,
                    artist: seedArtistName,
                    album: seedTrack?.album.title || null,
                },
                recommendations: fallbackRecommendations,
            });
        }

        const normalizedArtistNames = Array.from(
            new Set(
                lfmTracks
                    .map((track) =>
                        normalizeArtistName(extractPrimaryArtist(track.artist))
                    )
                    .filter((name) => name.length > 0)
            )
        );

        const artistNameClauses = Array.from(
            new Set(
                lfmTracks
                    .map((track) => extractPrimaryArtist(track.artist))
                    .filter((name) => name.length > 0)
            )
        ).map((name) => ({
            name: {
                equals: name,
                mode: "insensitive" as const,
            },
        }));

        const artistOrClauses = [
            ...(normalizedArtistNames.length > 0
                ? [{ normalizedName: { in: normalizedArtistNames } }]
                : []),
            ...artistNameClauses,
        ];

        let candidateTracks: any[] = [];

        if (artistOrClauses.length > 0) {
            candidateTracks = await prisma.track.findMany({
                where: {
                    album: {
                        artist: {
                            OR: artistOrClauses,
                        },
                    },
                },
                include: {
                    album: { include: { artist: true } },
                },
                take: 4000,
            });
        }

        // Fallback for sparse metadata libraries.
        if (candidateTracks.length === 0 && lfmTracks.length > 0) {
            candidateTracks = await prisma.track.findMany({
                where: {
                    title: {
                        in: lfmTracks.map((track) => track.title),
                        mode: "insensitive",
                    },
                },
                include: {
                    album: { include: { artist: true } },
                },
                take: 500,
            });
        }

        const preparedCandidates: PreparedTrackCandidate[] = candidateTracks.map((track) => ({
            track,
            normalizedTitle: normalizeTrackTitleForMatch(track.title || ""),
            normalizedArtist: normalizeArtistName(track.album?.artist?.name || ""),
        }));

        const usedTrackIds = new Set<string>();

        const recommendations = lfmTracks.map((lfmTrack) => {
            const normalizedLfmTitle = normalizeTrackTitleForMatch(lfmTrack.title);
            const normalizedLfmArtist = normalizeArtistName(
                extractPrimaryArtist(lfmTrack.artist)
            );

            const bestCandidate = preparedCandidates
                .filter((candidate) => !usedTrackIds.has(candidate.track.id))
                .map((candidate) => {
                    const { finalScore, titleScore, artistScore } = scoreTrackCandidate(
                        lfmTrack.title,
                        lfmTrack.artist,
                        candidate
                    );

                    return {
                        candidate,
                        finalScore,
                        titleScore,
                        artistScore,
                        quickTitleRatio:
                            fuzz.token_set_ratio(
                                normalizedLfmTitle,
                                candidate.normalizedTitle
                            ) / 100,
                        quickArtistRatio:
                            fuzz.ratio(normalizedLfmArtist, candidate.normalizedArtist) /
                            100,
                    };
                })
                .filter(
                    (result) =>
                        result.quickTitleRatio >= 0.45 &&
                        result.quickArtistRatio >= 0.35 &&
                        result.titleScore >= 0.45 &&
                        result.artistScore >= 0.35
                )
                .sort((a, b) => b.finalScore - a.finalScore)[0];

            const confidentMatch =
                bestCandidate &&
                bestCandidate.finalScore >= 0.72 &&
                bestCandidate.titleScore >= 0.62 &&
                bestCandidate.artistScore >= 0.55;

            if (confidentMatch) {
                usedTrackIds.add(bestCandidate.candidate.track.id);

                return {
                    ...bestCandidate.candidate.track,
                    inLibrary: true,
                    similarity: lfmTrack.similarity,
                    matchConfidence: Math.round(bestCandidate.finalScore * 100),
                    titleSimilarity: Number(bestCandidate.titleScore.toFixed(2)),
                    artistSimilarity: Number(bestCandidate.artistScore.toFixed(2)),
                };
            }

            return {
                title: lfmTrack.title,
                artist: lfmTrack.artist || "Unknown",
                inLibrary: false,
                similarity: lfmTrack.similarity,
                matchConfidence: 0,
                lastFmUrl: lfmTrack.lastFmUrl,
            };
        });

        res.json({
            seedTrack: {
                id: seedTrack?.id || null,
                title: seedTitle,
                artist: seedArtistName,
                album: seedTrack?.album.title || null,
            },
            recommendations,
        });
    } catch (error) {
        logger.error("Get track recommendations error:", error);
        res.status(500).json({
            error: "Failed to get track recommendations",
        });
    }
});

export default router;
