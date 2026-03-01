import { Router, Request, Response } from "express";
import { logger } from "../utils/logger";
import { requireAuthOrToken } from "../middleware/auth";
import { spotifyService } from "../services/spotify";
import { deezerService } from "../services/deezer";
import { ytMusicService } from "../services/youtubeMusic";
import { getSystemSettings } from "../utils/systemSettings";

const router = Router();

// ── Simple TTL cache for YT Music browse data ──────────────────
const YTMUSIC_BROWSE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ytBrowseCache = new Map<string, { data: any; expiresAt: number }>();

function getCachedOrNull<T>(key: string): T | null {
    const entry = ytBrowseCache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.data as T;
    if (entry) ytBrowseCache.delete(key);
    return null;
}

function setCache(key: string, data: any): void {
    ytBrowseCache.set(key, { data, expiresAt: Date.now() + YTMUSIC_BROWSE_TTL_MS });
}

const YTMUSIC_REGION = process.env.YTMUSIC_REGION || "US";

// All routes require authentication
router.use(requireAuthOrToken);

// ── Deprecated Deezer browse routes (410 Gone) ─────────────────

const GONE_MSG = "Deezer browse has been replaced by YouTube Music. Use /api/browse/ytmusic/* endpoints instead.";

/**
 * @openapi
 * /api/browse/playlists/featured:
 *   get:
 *     summary: Deprecated Deezer featured playlists endpoint
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       410:
 *         description: Deezer browse is deprecated; use `/api/browse/ytmusic/*`
 *       401:
 *         description: Not authenticated
 */
router.get("/playlists/featured", (_req: Request, res: Response) =>
    res.status(410).json({ error: GONE_MSG })
);
/**
 * @openapi
 * /api/browse/playlists/search:
 *   get:
 *     summary: Deprecated Deezer playlist search endpoint
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       410:
 *         description: Deezer browse is deprecated; use `/api/browse/ytmusic/*`
 *       401:
 *         description: Not authenticated
 */
router.get("/playlists/search", (_req: Request, res: Response) =>
    res.status(410).json({ error: GONE_MSG })
);
/**
 * @openapi
 * /api/browse/playlists/{id}:
 *   get:
 *     summary: Deprecated Deezer playlist details endpoint
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
 *     responses:
 *       410:
 *         description: Deezer browse is deprecated; use `/api/browse/ytmusic/*`
 *       401:
 *         description: Not authenticated
 */
router.get("/playlists/:id", (_req: Request, res: Response) =>
    res.status(410).json({ error: GONE_MSG })
);
/**
 * @openapi
 * /api/browse/radios:
 *   get:
 *     summary: Deprecated Deezer radio list endpoint
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       410:
 *         description: Deezer browse is deprecated; use `/api/browse/ytmusic/*`
 *       401:
 *         description: Not authenticated
 */
router.get("/radios", (_req: Request, res: Response) =>
    res.status(410).json({ error: GONE_MSG })
);
/**
 * @openapi
 * /api/browse/radios/by-genre:
 *   get:
 *     summary: Deprecated Deezer radios-by-genre endpoint
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       410:
 *         description: Deezer browse is deprecated; use `/api/browse/ytmusic/*`
 *       401:
 *         description: Not authenticated
 */
router.get("/radios/by-genre", (_req: Request, res: Response) =>
    res.status(410).json({ error: GONE_MSG })
);
/**
 * @openapi
 * /api/browse/radios/{id}:
 *   get:
 *     summary: Deprecated Deezer radio details endpoint
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
 *     responses:
 *       410:
 *         description: Deezer browse is deprecated; use `/api/browse/ytmusic/*`
 *       401:
 *         description: Not authenticated
 */
router.get("/radios/:id", (_req: Request, res: Response) =>
    res.status(410).json({ error: GONE_MSG })
);
/**
 * @openapi
 * /api/browse/genres:
 *   get:
 *     summary: Deprecated Deezer genre list endpoint
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       410:
 *         description: Deezer browse is deprecated; use `/api/browse/ytmusic/*`
 *       401:
 *         description: Not authenticated
 */
router.get("/genres", (_req: Request, res: Response) =>
    res.status(410).json({ error: GONE_MSG })
);
/**
 * @openapi
 * /api/browse/genres/{id}/playlists:
 *   get:
 *     summary: Deprecated Deezer playlists-by-genre endpoint
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
 *     responses:
 *       410:
 *         description: Deezer browse is deprecated; use `/api/browse/ytmusic/*`
 *       401:
 *         description: Not authenticated
 */
router.get("/genres/:id/playlists", (_req: Request, res: Response) =>
    res.status(410).json({ error: GONE_MSG })
);
/**
 * @openapi
 * /api/browse/genres/{id}:
 *   get:
 *     summary: Deprecated Deezer genre details endpoint
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
 *     responses:
 *       410:
 *         description: Deezer browse is deprecated; use `/api/browse/ytmusic/*`
 *       401:
 *         description: Not authenticated
 */
router.get("/genres/:id", (_req: Request, res: Response) =>
    res.status(410).json({ error: GONE_MSG })
);
/**
 * @openapi
 * /api/browse/all:
 *   get:
 *     summary: Deprecated Deezer aggregate browse endpoint
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       410:
 *         description: Deezer browse is deprecated; use `/api/browse/ytmusic/*`
 *       401:
 *         description: Not authenticated
 */
router.get("/all", (_req: Request, res: Response) =>
    res.status(410).json({ error: GONE_MSG })
);

// ── Retained: URL parse (supports Spotify + Deezer URLs for import) ──

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
router.post("/playlists/parse", async (req: Request, res: Response) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ error: "URL is required" });
        }

        // Try Deezer
        const deezerParsed = deezerService.parseUrl(url);
        if (deezerParsed && deezerParsed.type === "playlist") {
            return res.json({
                source: "deezer",
                type: "playlist",
                id: deezerParsed.id,
                url: `https://www.deezer.com/playlist/${deezerParsed.id}`,
            });
        }

        // Try Spotify
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
            error: "Invalid or unsupported URL. Please provide a Spotify or Deezer playlist URL.",
        });
    } catch (error: any) {
        logger.error("Parse URL error:", error);
        res.status(500).json({ error: error.message || "Failed to parse URL" });
    }
});

// ── YT Music Browse Routes ─────────────────────────────────────

/**
 * @openapi
 * /api/browse/ytmusic/charts:
 *   get:
 *     summary: Get YT Music charts (top songs, trending, etc.)
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: country
 *         schema:
 *           type: string
 *           default: US
 *         description: Country code for charts
 *     responses:
 *       200:
 *         description: Charts data with sections (songs, videos, trending, artists)
 *       403:
 *         description: YouTube Music is not enabled
 *       401:
 *         description: Not authenticated
 */
router.get("/ytmusic/charts", async (req: Request, res: Response) => {
    try {
        const settings = await getSystemSettings();
        if (!settings.ytMusicEnabled) {
            return res.status(403).json({ error: "YouTube Music integration is not enabled" });
        }

        const country = (req.query.country as string) || YTMUSIC_REGION;
        const cacheKey = `charts:${country}`;

        const cached = getCachedOrNull(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const charts = await ytMusicService.getCharts(country);
        const result = { charts, country, source: "ytmusic" as const };
        setCache(cacheKey, result);
        res.json(result);
    } catch (error: any) {
        logger.error("[Browse] YT Music charts error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch charts" });
    }
});

/**
 * @openapi
 * /api/browse/ytmusic/categories:
 *   get:
 *     summary: Get YT Music mood and genre categories
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of mood/genre categories with browsable params
 *       403:
 *         description: YouTube Music is not enabled
 *       401:
 *         description: Not authenticated
 */
router.get("/ytmusic/categories", async (req: Request, res: Response) => {
    try {
        const settings = await getSystemSettings();
        if (!settings.ytMusicEnabled) {
            return res.status(403).json({ error: "YouTube Music integration is not enabled" });
        }

        const cacheKey = "categories";
        const cached = getCachedOrNull(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const categories = await ytMusicService.getMoodCategories();
        const result = { categories, source: "ytmusic" as const };
        setCache(cacheKey, result);
        res.json(result);
    } catch (error: any) {
        logger.error("[Browse] YT Music categories error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch categories" });
    }
});

/**
 * @openapi
 * /api/browse/ytmusic/playlist/{id}:
 *   get:
 *     summary: Get a YT Music public playlist with track details
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
 *         description: YT Music playlist ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *           maximum: 500
 *         description: Maximum number of tracks to fetch
 *     responses:
 *       200:
 *         description: Playlist details with tracks
 *       403:
 *         description: YouTube Music is not enabled
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
router.get("/ytmusic/playlist/:id", async (req: Request, res: Response) => {
    try {
        const settings = await getSystemSettings();
        if (!settings.ytMusicEnabled) {
            return res.status(403).json({ error: "YouTube Music integration is not enabled" });
        }

        const { id } = req.params;
        const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
        const cacheKey = `playlist:${id}:${limit}`;

        const cached = getCachedOrNull(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const playlist = await ytMusicService.getBrowsePlaylist(id, limit);
        const result = { ...playlist, source: "ytmusic" as const };
        setCache(cacheKey, result);
        res.json(result);
    } catch (error: any) {
        if (error.response?.status === 404) {
            return res.status(404).json({ error: "Playlist not found" });
        }
        logger.error("[Browse] YT Music playlist error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch playlist" });
    }
});

export default router;
