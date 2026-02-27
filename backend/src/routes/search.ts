import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { lastFmService } from "../services/lastfm";
import { searchService, normalizeCacheQuery, type SearchResults } from "../services/search";
import axios from "axios";
import { redisClient } from "../utils/redis";

const router = Router();

function normalizeDiscoverArtistName(value: unknown): string {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeDiscoverArtistTags(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
        .filter((tag): tag is string => tag.length > 0);
}

async function getLocalSimilarArtistsFromGraph(
    artistName: string,
    artistMbid: string,
    limit: number
): Promise<any[]> {
    const normalizedArtistName = normalizeDiscoverArtistName(artistName);
    const seedFilters: any[] = [
        { name: { equals: artistName, mode: "insensitive" } },
    ];

    if (normalizedArtistName) {
        seedFilters.push({ normalizedName: normalizedArtistName });
    }

    if (artistMbid) {
        seedFilters.push({ mbid: artistMbid });
    }

    const seedArtist = await prisma.artist.findFirst({
        where: {
            OR: seedFilters,
        },
        select: { id: true },
    });

    if (!seedArtist) {
        return [];
    }

    const graphSimilar = await prisma.similarArtist.findMany({
        where: { fromArtistId: seedArtist.id },
        orderBy: { weight: "desc" },
        take: limit,
        include: {
            toArtist: {
                select: {
                    id: true,
                    mbid: true,
                    name: true,
                    heroUrl: true,
                    summary: true,
                    genres: true,
                },
            },
        },
    });

    const seen = new Set<string>();
    const mapped: any[] = [];
    for (const relation of graphSimilar) {
        const target = relation.toArtist;
        const dedupeKey =
            target.mbid ||
            target.id ||
            normalizeDiscoverArtistName(target.name);
        if (!target.name || !dedupeKey || seen.has(dedupeKey)) {
            continue;
        }

        seen.add(dedupeKey);
        mapped.push({
            type: "music",
            id: target.mbid || target.id,
            name: target.name,
            listeners: 0,
            url: null,
            image: target.heroUrl || null,
            mbid: target.mbid,
            bio: target.summary || null,
            tags: normalizeDiscoverArtistTags(target.genres),
        });
    }

    return mapped;
}

async function filterLibraryArtistsFromDiscoverResults(artists: any[]): Promise<any[]> {
    if (artists.length === 0) {
        return artists;
    }

    const candidateNames = Array.from(
        new Set(
            artists
                .map((artist) => (typeof artist?.name === "string" ? artist.name.trim() : ""))
                .filter(Boolean)
        )
    );

    if (candidateNames.length === 0) {
        return artists;
    }

    const libraryArtists = await prisma.artist.findMany({
        where: {
            OR: candidateNames.map((name) => ({
                name: { equals: name, mode: "insensitive" },
            })),
        },
        select: { name: true },
    });

    if (libraryArtists.length === 0) {
        return artists;
    }

    const libraryArtistNames = new Set(
        libraryArtists.map((artist) => normalizeDiscoverArtistName(artist.name))
    );

    return artists.filter(
        (artist) =>
            !libraryArtistNames.has(normalizeDiscoverArtistName(artist?.name))
    );
}

function transformSearchResults(serviceResults: SearchResults) {
    return {
        artists: serviceResults.artists,
        albums: serviceResults.albums.map((album) => ({
            id: album.id,
            title: album.title,
            artistId: album.artistId,
            year: album.year,
            coverUrl: album.coverUrl,
            artist: {
                id: album.artistId,
                name: album.artistName,
                mbid: "",
            },
        })),
        tracks: serviceResults.tracks.map((track) => ({
            id: track.id,
            title: track.title,
            albumId: track.albumId,
            duration: track.duration,
            trackNo: 0,
            album: {
                id: track.albumId,
                title: track.albumTitle,
                artistId: track.artistId,
                coverUrl: null,
                artist: {
                    id: track.artistId,
                    name: track.artistName,
                    mbid: "",
                },
            },
        })),
        audiobooks: serviceResults.audiobooks,
        podcasts: serviceResults.podcasts,
        episodes: serviceResults.episodes,
    };
}

router.use(requireAuth);

/**
 * @openapi
 * /search:
 *   get:
 *     summary: Search across your music library
 *     description: Search for artists, albums, tracks, audiobooks, and podcasts in your library using PostgreSQL full-text search
 *     tags: [Search]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         required: true
 *         description: Search query
 *         example: "radiohead"
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [all, artists, albums, tracks, audiobooks, podcasts, episodes]
 *         description: Type of content to search
 *         default: all
 *       - in: query
 *         name: genre
 *         schema:
 *           type: string
 *         description: Filter tracks by genre
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *         description: Maximum number of results per type
 *         default: 20
 *     responses:
 *       200:
 *         description: Search results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 artists:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Artist'
 *                 albums:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Album'
 *                 tracks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Track'
 *                 audiobooks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 podcasts:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get("/", async (req, res) => {
    try {
        const { q = "", type = "all", genre, limit = "20" } = req.query;

        const query = (q as string).trim();
        const parsed = parseInt(limit as string, 10);
        const searchLimit = Number.isNaN(parsed) ? 20 : Math.min(Math.max(parsed, 1), 100);

        if (!query) {
            return res.json({
                artists: [],
                albums: [],
                tracks: [],
                audiobooks: [],
                podcasts: [],
                episodes: [],
            });
        }

        // Delegate to service (handles caching + parallel execution + genre filtering)
        if (type === "all") {
            const serviceResults = await searchService.searchAll({
                query,
                limit: searchLimit,
                genre: genre as string | undefined,
            });

            return res.json(transformSearchResults(serviceResults));
        }

        // Single-type search (service handles caching)
        const serviceResults = await searchService.searchByType({
            query,
            type: type as string,
            limit: searchLimit,
            genre: genre as string | undefined,
        });

        res.json(transformSearchResults(serviceResults));
    } catch (error) {
        logger.error("Search error:", error);
        res.status(500).json({ error: "Search failed" });
    }
});

/**
 * @openapi
 * /api/search/genres:
 *   get:
 *     summary: Get all genres with track counts
 *     tags: [Search]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of genres with track counts
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: string
 *                   name:
 *                     type: string
 *                   trackCount:
 *                     type: integer
 *       401:
 *         description: Not authenticated
 */
// GET /search/genres
router.get("/genres", async (req, res) => {
    try {
        const genres = await prisma.genre.findMany({
            orderBy: { name: "asc" },
            include: {
                _count: {
                    select: { trackGenres: true },
                },
            },
        });

        res.json(
            genres.map((g) => ({
                id: g.id,
                name: g.name,
                trackCount: g._count.trackGenres,
            }))
        );
    } catch (error) {
        logger.error("Get genres error:", error);
        res.status(500).json({ error: "Failed to get genres" });
    }
});

/**
 * @openapi
 * /api/search/discover:
 *   get:
 *     summary: Search for new content to discover (not in your library)
 *     tags: [Search]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *         description: Search query
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [music, podcasts, all]
 *           default: music
 *         description: Type of content to discover
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 50
 *         description: Maximum number of results
 *     responses:
 *       200:
 *         description: Discovery search results with optional alias info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                 aliasInfo:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     original:
 *                       type: string
 *                     canonical:
 *                       type: string
 *                     mbid:
 *                       type: string
 *       401:
 *         description: Not authenticated
 */
router.get("/discover", async (req, res) => {
    try {
        const { q = "", type = "music", limit = "20" } = req.query;

        const query = (q as string).trim();
        const parsedLimit = parseInt(limit as string, 10);
        const searchLimit = Number.isNaN(parsedLimit) ? 20 : Math.min(Math.max(parsedLimit, 1), 50);

        if (!query) {
            return res.json({ results: [], aliasInfo: null });
        }

        // Cache TTL: 15 min (900s) -- external API data rarely changes
        const cacheKey = `search:discover:${type}:${normalizeCacheQuery(query)}:${searchLimit}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(`[SEARCH DISCOVER] Cache hit for query="${query}" type=${type}`);
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            logger.warn("[SEARCH DISCOVER] Redis read error:", err);
        }

        const results: any[] = [];

        // Resolve alias (sequential -- modifies the search query, cached 30 days)
        let searchQuery = query;
        let aliasInfo: { original: string; canonical: string; mbid?: string } | null = null;

        if (type === "music" || type === "all") {
            try {
                const correction = await lastFmService.getArtistCorrection(query);
                if (correction?.corrected) {
                    searchQuery = correction.canonicalName;
                    aliasInfo = {
                        original: query,
                        canonical: correction.canonicalName,
                        mbid: correction.mbid,
                    };
                    logger.debug(`[SEARCH DISCOVER] Alias resolved: "${query}" -> "${correction.canonicalName}"`);
                }
            } catch (correctionError) {
                logger.warn("[SEARCH DISCOVER] Correction check failed:", correctionError);
            }
        }

        // Build parallel promises for independent external calls
        const promiseMap: Record<string, Promise<any>> = {};

        if (type === "music" || type === "all") {
            promiseMap.artists = lastFmService.searchArtists(searchQuery, searchLimit);
            promiseMap.tracks = lastFmService.searchTracks(searchQuery, searchLimit);
        }

        if (type === "podcasts" || type === "all") {
            promiseMap.podcasts = axios.get("https://itunes.apple.com/search", {
                params: { term: query, media: "podcast", entity: "podcast", limit: searchLimit },
                timeout: 5000,
            }).then((resp) => resp.data.results.map((podcast: any) => ({
                type: "podcast",
                id: podcast.collectionId,
                name: podcast.collectionName,
                artist: podcast.artistName,
                description: podcast.description,
                coverUrl: podcast.artworkUrl600 || podcast.artworkUrl100,
                feedUrl: podcast.feedUrl,
                genres: podcast.genres || [],
                trackCount: podcast.trackCount,
            })));
        }

        // Await all with allSettled so one failure doesn't block others
        const keys = Object.keys(promiseMap);
        const settled = await Promise.allSettled(keys.map((k) => promiseMap[k]));
        const resolved: Record<string, any[]> = {};
        keys.forEach((k, i) => {
            const result = settled[i];
            if (result.status === "fulfilled") {
                resolved[k] = result.value;
            } else {
                logger.error(`[SEARCH DISCOVER] ${k} search failed:`, result.reason);
                resolved[k] = [];
            }
        });

        if (resolved.artists) {
            logger.debug(`[SEARCH DISCOVER] Found ${resolved.artists.length} artist results`);
            const filteredArtists = await filterLibraryArtistsFromDiscoverResults(
                resolved.artists
            );
            logger.debug(
                `[SEARCH DISCOVER] Filtered to ${filteredArtists.length} new artists not already in library`
            );
            results.push(...filteredArtists);
        }
        if (resolved.tracks) {
            logger.debug(`[SEARCH DISCOVER] Found ${resolved.tracks.length} track results`);
            results.push(...resolved.tracks);
        }
        if (resolved.podcasts) {
            results.push(...resolved.podcasts);
        }

        const payload = { results, aliasInfo };

        try {
            await redisClient.setEx(cacheKey, 900, JSON.stringify(payload));
        } catch (err) {
            logger.warn("[SEARCH DISCOVER] Redis write error:", err);
        }

        res.json(payload);
    } catch (error) {
        logger.error("Discovery search error:", error);
        res.status(500).json({ error: "Discovery search failed" });
    }
});

/**
 * @openapi
 * /api/search/discover/similar:
 *   get:
 *     summary: Fetch musically similar artists via Last.fm
 *     tags: [Search]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: artist
 *         required: true
 *         schema:
 *           type: string
 *         description: Artist name
 *       - in: query
 *         name: mbid
 *         schema:
 *           type: string
 *         description: MusicBrainz artist ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 6
 *           maximum: 50
 *         description: Maximum number of similar artists
 *     responses:
 *       200:
 *         description: Similar artists list
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 similarArtists:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Not authenticated
 */
router.get("/discover/similar", async (req, res) => {
    try {
        const { artist = "", mbid = "", limit = "6" } = req.query;
        const artistName = (artist as string).trim();
        const artistMbid = (mbid as string).trim();
        const parsedLimit = parseInt(limit as string, 10);
        const similarLimit = Number.isNaN(parsedLimit)
            ? 6
            : Math.min(Math.max(parsedLimit, 1), 50);
        const seedLimit = Math.min(100, Math.max(10, similarLimit * 3));

        if (!artistName) {
            return res.json({ similarArtists: [] });
        }

        const cacheKey = `search:discover:similar:${normalizeCacheQuery(artistName)}:${artistMbid}:${similarLimit}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                logger.debug(`[SEARCH SIMILAR] Cache hit for artist="${artistName}"`);
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            logger.warn("[SEARCH SIMILAR] Redis read error:", err);
        }

        const similar = await lastFmService.getSimilarArtists(
            artistMbid,
            artistName,
            seedLimit
        );
        let similarArtists = similar.length > 0
            ? await lastFmService.enrichSimilarArtists(similar, similarLimit)
            : [];

        if (similarArtists.length === 0) {
            logger.debug(
                `[SEARCH SIMILAR] Last.fm returned no enriched artists for artist="${artistName}", falling back to local graph`
            );
            try {
                similarArtists = await getLocalSimilarArtistsFromGraph(
                    artistName,
                    artistMbid,
                    similarLimit
                );
            } catch (fallbackError) {
                logger.warn("[SEARCH SIMILAR] Local fallback query error:", fallbackError);
            }
        }

        const payload = { similarArtists };

        try {
            // Cache TTL: 1 hour (3600s) -- similar artists rarely change
            await redisClient.setEx(cacheKey, 3600, JSON.stringify(payload));
        } catch (err) {
            logger.warn("[SEARCH SIMILAR] Redis write error:", err);
        }

        res.json(payload);
    } catch (error) {
        logger.error("Similar artists search error:", error);
        res.status(500).json({ error: "Similar artists search failed" });
    }
});

export default router;
