import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuthOrToken } from "../middleware/auth";
import { spotifyService } from "../services/spotify";
import { deezerService, DeezerPlaylistPreview, DeezerRadioStation } from "../services/deezer";

const router = Router();

// All routes require authentication
router.use(requireAuthOrToken);

/**
 * Unified playlist preview type
 */
interface PlaylistPreview {
    id: string;
    source: "deezer" | "spotify";
    type: "playlist" | "radio";
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    url: string;
}

/**
 * Convert Deezer playlist to unified format
 */
function deezerPlaylistToUnified(playlist: DeezerPlaylistPreview): PlaylistPreview {
    return {
        id: playlist.id,
        source: "deezer",
        type: "playlist",
        title: playlist.title,
        description: playlist.description,
        creator: playlist.creator,
        imageUrl: playlist.imageUrl,
        trackCount: playlist.trackCount,
        url: `https://www.deezer.com/playlist/${playlist.id}`,
    };
}

/**
 * Convert Deezer radio to unified format
 */
function deezerRadioToUnified(radio: DeezerRadioStation): PlaylistPreview {
    return {
        id: radio.id,
        source: "deezer",
        type: "radio",
        title: radio.title,
        description: radio.description,
        creator: "Deezer",
        imageUrl: radio.imageUrl,
        trackCount: 0, // Radio tracks are dynamic
        url: `https://www.deezer.com/radio-${radio.id}`,
    };
}

/**
 * @openapi
 * /api/browse/playlists/featured:
 *   get:
 *     summary: Get featured/chart playlists from Deezer
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 200
 *         description: Maximum number of playlists to return
 *     responses:
 *       200:
 *         description: Featured playlists retrieved successfully
 *       401:
 *         description: Not authenticated
 */
router.get("/playlists/featured", async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        logger.debug(`[Browse] Fetching featured playlists (limit: ${limit})...`);

        const playlists = await deezerService.getFeaturedPlaylists(limit);
        logger.debug(`[Browse] Got ${playlists.length} Deezer playlists`);

        res.json({
            playlists: playlists.map(deezerPlaylistToUnified),
            total: playlists.length,
            source: "deezer",
        });
    } catch (error: any) {
        logger.error("Browse featured playlists error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch playlists" });
    }
});

/**
 * @openapi
 * /api/browse/playlists/search:
 *   get:
 *     summary: Search for playlists on Deezer
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *           minLength: 2
 *         description: Search query (minimum 2 characters)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           maximum: 100
 *         description: Maximum number of results to return
 *     responses:
 *       200:
 *         description: Playlist search results
 *       400:
 *         description: Search query too short
 *       401:
 *         description: Not authenticated
 */
router.get("/playlists/search", async (req, res) => {
    try {
        const query = req.query.q as string;
        if (!query || query.length < 2) {
            return res.status(400).json({ error: "Search query must be at least 2 characters" });
        }

        const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
        logger.debug(`[Browse] Searching playlists for "${query}"...`);

        const playlists = await deezerService.searchPlaylists(query, limit);
        logger.debug(`[Browse] Search "${query}": ${playlists.length} results`);

        res.json({
            playlists: playlists.map(deezerPlaylistToUnified),
            total: playlists.length,
            query,
            source: "deezer",
        });
    } catch (error: any) {
        logger.error("Browse search playlists error:", error);
        res.status(500).json({ error: error.message || "Failed to search playlists" });
    }
});

/**
 * @openapi
 * /api/browse/playlists/{id}:
 *   get:
 *     summary: Get full details of a Deezer playlist
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Deezer playlist ID
 *     responses:
 *       200:
 *         description: Playlist details retrieved successfully
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
router.get("/playlists/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const playlist = await deezerService.getPlaylist(id);

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        res.json({
            ...playlist,
            source: "deezer",
            url: `https://www.deezer.com/playlist/${id}`,
        });
    } catch (error: any) {
        logger.error("Playlist fetch error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch playlist" });
    }
});

/**
 * @openapi
 * /api/browse/radios:
 *   get:
 *     summary: Get all radio stations (mood/theme based mixes)
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Radio stations retrieved successfully
 *       401:
 *         description: Not authenticated
 */
router.get("/radios", async (req, res) => {
    try {
        logger.debug("[Browse] Fetching radio stations...");
        const radios = await deezerService.getRadioStations();

        res.json({
            radios: radios.map(deezerRadioToUnified),
            total: radios.length,
            source: "deezer",
        });
    } catch (error: any) {
        logger.error("Browse radios error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch radios" });
    }
});

/**
 * @openapi
 * /api/browse/radios/by-genre:
 *   get:
 *     summary: Get radio stations organized by genre
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Radio stations grouped by genre
 *       401:
 *         description: Not authenticated
 */
router.get("/radios/by-genre", async (req, res) => {
    try {
        logger.debug("[Browse] Fetching radios by genre...");
        const genresWithRadios = await deezerService.getRadiosByGenre();

        // Transform to include unified format
        const result = genresWithRadios.map(genre => ({
            id: genre.id,
            name: genre.name,
            radios: genre.radios.map(deezerRadioToUnified),
        }));

        res.json({
            genres: result,
            total: result.length,
            source: "deezer",
        });
    } catch (error: any) {
        logger.error("Browse radios by genre error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch radios" });
    }
});

/**
 * @openapi
 * /api/browse/radios/{id}:
 *   get:
 *     summary: Get tracks from a radio station
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Radio station ID
 *     responses:
 *       200:
 *         description: Radio station tracks in playlist format for import
 *       404:
 *         description: Radio station not found
 *       401:
 *         description: Not authenticated
 */
router.get("/radios/:id", async (req, res) => {
    try {
        const { id } = req.params;
        logger.debug(`[Browse] Fetching radio ${id} tracks...`);
        
        const radioPlaylist = await deezerService.getRadioTracks(id);

        if (!radioPlaylist) {
            return res.status(404).json({ error: "Radio station not found" });
        }

        res.json({
            ...radioPlaylist,
            source: "deezer",
            type: "radio",
        });
    } catch (error: any) {
        logger.error("Radio tracks error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch radio tracks" });
    }
});

/**
 * @openapi
 * /api/browse/genres:
 *   get:
 *     summary: Get all available genres
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of all available genres
 *       401:
 *         description: Not authenticated
 */
router.get("/genres", async (req, res) => {
    try {
        logger.debug("[Browse] Fetching genres...");
        const genres = await deezerService.getGenres();

        res.json({
            genres,
            total: genres.length,
            source: "deezer",
        });
    } catch (error: any) {
        logger.error("Browse genres error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch genres" });
    }
});

/**
 * @openapi
 * /api/browse/genres/{id}:
 *   get:
 *     summary: Get content for a specific genre (playlists and radios)
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Genre ID
 *     responses:
 *       200:
 *         description: Genre content including playlists and radios
 *       400:
 *         description: Invalid genre ID
 *       401:
 *         description: Not authenticated
 */
router.get("/genres/:id", async (req, res) => {
    try {
        const genreId = parseInt(req.params.id);
        if (isNaN(genreId)) {
            return res.status(400).json({ error: "Invalid genre ID" });
        }

        logger.debug(`[Browse] Fetching content for genre ${genreId}...`);
        const content = await deezerService.getEditorialContent(genreId);

        res.json({
            genreId,
            playlists: content.playlists.map(deezerPlaylistToUnified),
            radios: content.radios.map(deezerRadioToUnified),
            source: "deezer",
        });
    } catch (error: any) {
        logger.error("Genre content error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch genre content" });
    }
});

/**
 * @openapi
 * /api/browse/genres/{id}/playlists:
 *   get:
 *     summary: Get playlists for a specific genre
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Genre ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *           maximum: 50
 *         description: Maximum number of playlists to return
 *     responses:
 *       200:
 *         description: Genre playlists retrieved successfully
 *       404:
 *         description: Genre not found
 *       401:
 *         description: Not authenticated
 */
router.get("/genres/:id/playlists", async (req, res) => {
    try {
        const genreId = parseInt(req.params.id);
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

        // Get genre name first
        const genres = await deezerService.getGenres();
        const genre = genres.find(g => g.id === genreId);

        if (!genre) {
            return res.status(404).json({ error: "Genre not found" });
        }

        const playlists = await deezerService.getGenrePlaylists(genre.name, limit);

        res.json({
            playlists: playlists.map(deezerPlaylistToUnified),
            total: playlists.length,
            genre: genre.name,
            source: "deezer",
        });
    } catch (error: any) {
        logger.error("Genre playlists error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch genre playlists" });
    }
});

/**
 * @openapi
 * /api/browse/playlists/parse:
 *   post:
 *     summary: Parse a Spotify or Deezer URL and return playlist info
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - url
 *             properties:
 *               url:
 *                 type: string
 *                 description: Spotify or Deezer playlist URL
 *     responses:
 *       200:
 *         description: Parsed playlist info (source, type, id, url)
 *       400:
 *         description: Missing or invalid/unsupported URL
 *       401:
 *         description: Not authenticated
 */
router.post("/playlists/parse", async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ error: "URL is required" });
        }

        // Try Deezer first (our primary source)
        const deezerParsed = deezerService.parseUrl(url);
        if (deezerParsed && deezerParsed.type === "playlist") {
            return res.json({
                source: "deezer",
                type: "playlist",
                id: deezerParsed.id,
                url: `https://www.deezer.com/playlist/${deezerParsed.id}`,
            });
        }

        // Try Spotify (still supported for URL imports)
        const spotifyParsed = spotifyService.parseUrl(url);
        if (spotifyParsed && spotifyParsed.type === "playlist") {
            return res.json({
                source: "spotify",
                type: "playlist",
                id: spotifyParsed.id,
                url: `https://open.spotify.com/playlist/${spotifyParsed.id}`,
            });
        }

        return res.status(400).json({ 
            error: "Invalid or unsupported URL. Please provide a Spotify or Deezer playlist URL." 
        });
    } catch (error: any) {
        logger.error("Parse URL error:", error);
        res.status(500).json({ error: error.message || "Failed to parse URL" });
    }
});

/**
 * @openapi
 * /api/browse/all:
 *   get:
 *     summary: Get a combined view of featured content (playlists, genres)
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Combined browse content including playlists and genres
 *       401:
 *         description: Not authenticated
 */
router.get("/all", async (req, res) => {
    try {
        logger.debug("[Browse] Fetching browse content (playlists + genres)...");

        // Only fetch playlists and genres - radios are now internal library-based
        const [playlists, genres] = await Promise.all([
            deezerService.getFeaturedPlaylists(200),
            deezerService.getGenres(),
        ]);

        res.json({
            playlists: playlists.map(deezerPlaylistToUnified),
            radios: [],
            genres,
            source: "deezer",
        });
    } catch (error: any) {
        logger.error("Browse all error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch browse content" });
    }
});

export default router;
