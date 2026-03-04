import { Router, Request, Response } from "express";
import { logger } from "../utils/logger";
import { requireAuthOrToken } from "../middleware/auth";
import { imageLimiter } from "../middleware/rateLimiter";
import { spotifyService } from "../services/spotify";
import { deezerService } from "../services/deezer";
import { ytMusicService } from "../services/youtubeMusic";
import { tidalStreamingService } from "../services/tidalStreaming";
import { getSystemSettings } from "../utils/systemSettings";
import {
    browseImageCacheKey,
    getBrowseImageFromCache,
    fetchAndCacheBrowseImage,
} from "../services/browseImageCache";

const router = Router();

// ── Simple TTL cache for YT Music browse data ──────────────────
const YTMUSIC_BROWSE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const YTMUSIC_BROWSE_MAX_CACHE_ENTRIES = 256;
const YTMUSIC_HOME_DEFAULT_LIMIT = 6;
const YTMUSIC_HOME_MAX_LIMIT = 20;
const YTMUSIC_PLAYLIST_DEFAULT_LIMIT = 100;
const YTMUSIC_PLAYLIST_MAX_LIMIT = 500;
const YTMUSIC_MOOD_PARAMS_MAX_LENGTH = 512;
const ytBrowseCache = new Map<string, { data: any; expiresAt: number }>();

function getCachedOrNull<T>(key: string): T | null {
    const entry = ytBrowseCache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.data as T;
    if (entry) ytBrowseCache.delete(key);
    return null;
}

function setCache(key: string, data: any): void {
    pruneExpiredCacheEntries();
    ytBrowseCache.set(key, { data, expiresAt: Date.now() + YTMUSIC_BROWSE_TTL_MS });
    trimCacheIfNeeded();
}

function trimCacheIfNeeded(): void {
    while (ytBrowseCache.size > YTMUSIC_BROWSE_MAX_CACHE_ENTRIES) {
        const oldestKey = ytBrowseCache.keys().next().value;
        if (!oldestKey) return;
        ytBrowseCache.delete(oldestKey);
    }
}

function pruneExpiredCacheEntries(now = Date.now()): void {
    for (const [key, entry] of ytBrowseCache.entries()) {
        if (entry.expiresAt <= now) {
            ytBrowseCache.delete(key);
        }
    }
}

function parseBoundedInt(
    value: unknown,
    fallback: number,
    min: number,
    max: number
): number {
    if (typeof value !== "string") {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
}

function parseMoodParams(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim();
    if (!trimmed || trimmed.length > YTMUSIC_MOOD_PARAMS_MAX_LENGTH) {
        return null;
    }

    return trimmed;
}

function parseProviderUrlCandidate(rawUrl: string): URL | null {
    try {
        return new URL(rawUrl);
    } catch {
        const hasExplicitScheme = /^[a-z][a-z0-9+.-]*:/i.test(rawUrl);
        if (hasExplicitScheme) {
            return null;
        }
        try {
            return new URL(`https://${rawUrl}`);
        } catch {
            return null;
        }
    }
}

function resolveHttpStatusFromError(error: any): number | null {
    const status = error?.response?.status;
    if (typeof status === "number" && status >= 400 && status <= 599) {
        return status;
    }
    return null;
}

async function ensureYtMusicEnabled(res: Response): Promise<boolean> {
    const settings = await getSystemSettings();
    if (!settings?.ytMusicEnabled) {
        res.status(403).json({ error: "YouTube Music integration is not enabled" });
        return false;
    }

    return true;
}

const YTMUSIC_REGION = process.env.YTMUSIC_REGION || "US";

// All routes require authentication
router.use(requireAuthOrToken);

// ── Browse image proxy (disk-cached) ────────────────────────────

const BROWSE_IMAGE_ALLOWED_HOSTS = [
    ".googleusercontent.com",
    ".ytimg.com",
    ".ggpht.com",
];

function isBrowseImageHostAllowed(hostname: string): boolean {
    const lower = hostname.toLowerCase();
    return BROWSE_IMAGE_ALLOWED_HOSTS.some((suffix) => lower.endsWith(suffix));
}

/**
 * @openapi
 * /api/browse/ytmusic/image:
 *   get:
 *     summary: Proxy and cache a YouTube Music thumbnail image
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: url
 *         required: true
 *         schema:
 *           type: string
 *         description: External thumbnail URL to proxy
 *     responses:
 *       200:
 *         description: Cached image bytes
 *         content:
 *           image/jpeg:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: Missing or disallowed URL
 *       404:
 *         description: Image could not be fetched
 *       401:
 *         description: Not authenticated
 */
router.get("/ytmusic/image", imageLimiter, async (req: Request, res: Response) => {
    const rawUrl = req.query.url;
    if (typeof rawUrl !== "string" || !rawUrl.trim()) {
        return res.status(400).json({ error: "url query parameter is required" });
    }

    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return res.status(400).json({ error: "Invalid URL" });
    }

    if (!isBrowseImageHostAllowed(parsed.hostname)) {
        return res.status(400).json({ error: "URL host not allowed" });
    }

    const key = browseImageCacheKey(rawUrl);

    // Check disk cache
    const cached = getBrowseImageFromCache(key);
    if (cached) {
        res.set("Content-Type", cached.contentType);
        res.set("Cache-Control", "public, max-age=604800, immutable");
        return res.sendFile(cached.filePath);
    }

    // Fetch, cache, and serve
    const entry = await fetchAndCacheBrowseImage(rawUrl);
    if (!entry) {
        return res.status(404).json({ error: "Failed to fetch image" });
    }

    res.set("Content-Type", entry.contentType);
    res.set("Cache-Control", "public, max-age=604800, immutable");
    return res.sendFile(entry.filePath);
});

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
 *     summary: Parse a playlist URL from Spotify, Deezer, YouTube, or TIDAL
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
 *                 description: Playlist URL from Spotify, Deezer, YouTube, or TIDAL
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
        const normalizedUrl = String(url).trim();
        const parsedUrl = parseProviderUrlCandidate(normalizedUrl);
        const normalizedHost = parsedUrl?.hostname.toLowerCase().replace(/^www\./, "");
        const normalizedPath = parsedUrl?.pathname.replace(/\/+$/, "");

        // Try Deezer
        const deezerParsed =
            normalizedHost === "deezer.com"
                ? deezerService.parseUrl(normalizedUrl)
                : null;
        if (deezerParsed && deezerParsed.type === "playlist") {
            return res.json({
                source: "deezer",
                type: "playlist",
                id: deezerParsed.id,
                url: `https://www.deezer.com/playlist/${deezerParsed.id}`,
            });
        }

        // Try Spotify
        const isSpotifyUri = normalizedUrl.toLowerCase().startsWith("spotify:");
        const spotifyParsed =
            isSpotifyUri ||
            normalizedHost === "spotify.com" ||
            normalizedHost === "open.spotify.com" ||
            normalizedHost === "play.spotify.com"
                ? spotifyService.parseUrl(normalizedUrl)
                : null;
        if (spotifyParsed && spotifyParsed.type === "playlist") {
            return res.json({
                source: "spotify",
                type: "playlist",
                id: spotifyParsed.id,
                url: `https://open.spotify.com/playlist/${spotifyParsed.id}`,
            });
        }

        // Try YouTube Music / YouTube playlist
        const isYouTubeHost =
            normalizedHost === "music.youtube.com" ||
            normalizedHost === "youtube.com" ||
            normalizedHost === "m.youtube.com";
        const ytListId =
            isYouTubeHost && normalizedPath === "/playlist"
                ? parsedUrl?.searchParams.get("list") ?? null
                : null;
        if (ytListId && /^[A-Za-z0-9_-]+$/.test(ytListId)) {
            return res.json({
                source: "youtube",
                type: "playlist",
                id: ytListId,
                url: `https://music.youtube.com/playlist?list=${ytListId}`,
            });
        }

        // Try TIDAL playlist
        const isTidalHost = normalizedHost === "tidal.com" || normalizedHost === "listen.tidal.com";
        const tidalPathSegments = (normalizedPath ?? "")
            .split("/")
            .filter(Boolean);
        let tidalPlaylistId: string | null = null;
        if (isTidalHost) {
            if (
                tidalPathSegments.length === 2 &&
                tidalPathSegments[0].toLowerCase() === "playlist"
            ) {
                tidalPlaylistId = tidalPathSegments[1];
            } else if (
                tidalPathSegments.length === 3 &&
                tidalPathSegments[0].toLowerCase() === "browse" &&
                tidalPathSegments[1].toLowerCase() === "playlist"
            ) {
                tidalPlaylistId = tidalPathSegments[2];
            }
        }
        if (tidalPlaylistId && /^[0-9a-f-]+$/i.test(tidalPlaylistId)) {
            return res.json({
                source: "tidal",
                type: "playlist",
                id: tidalPlaylistId,
                url: `https://listen.tidal.com/playlist/${tidalPlaylistId}`,
            });
        }

        return res.status(400).json({
            error: "Invalid or unsupported URL. Supported: Spotify, Deezer, YouTube Music, and TIDAL playlist URLs.",
        });
    } catch (error: any) {
        logger.error("Parse URL error:", error);
        res.status(500).json({ error: "Failed to parse URL" });
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
 *       401:
 *         description: Not authenticated
 */
router.get("/ytmusic/charts", async (req: Request, res: Response) => {
    try {
        if (!(await ensureYtMusicEnabled(res))) {
            return;
        }

        const userId = req.user?.id;
        const country = (req.query.country as string) || YTMUSIC_REGION;
        const cacheKey = `charts:${country}:${userId ?? "public"}`;

        const cached = getCachedOrNull(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const charts = await ytMusicService.getCharts(country, userId);
        const result = { charts, country, source: "ytmusic" as const };
        setCache(cacheKey, result);
        res.json(result);
    } catch (error: any) {
        logger.error("[Browse] YT Music charts error:", error);
        res.status(500).json({ error: "Failed to fetch charts" });
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
 *       401:
 *         description: Not authenticated
 */
router.get("/ytmusic/categories", async (req: Request, res: Response) => {
    try {
        if (!(await ensureYtMusicEnabled(res))) {
            return;
        }

        const userId = req.user?.id;
        const cacheKey = `categories:${userId ?? "public"}`;
        const cached = getCachedOrNull(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const categories = await ytMusicService.getMoodCategories(userId);
        const result = { categories, source: "ytmusic" as const };
        setCache(cacheKey, result);
        res.json(result);
    } catch (error: any) {
        logger.error("[Browse] YT Music categories error:", error);
        res.status(500).json({ error: "Failed to fetch categories" });
    }
});

/**
 * @openapi
 * /api/browse/ytmusic/home:
 *   get:
 *     summary: Get YT Music home shelves (featured/curated content)
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 6
 *         description: Number of shelves to fetch
 *     responses:
 *       200:
 *         description: Array of shelves with contents
 *       401:
 *         description: Not authenticated
 */
router.get("/ytmusic/home", async (req: Request, res: Response) => {
    try {
        if (!(await ensureYtMusicEnabled(res))) {
            return;
        }

        const userId = req.user?.id;
        const limit = parseBoundedInt(
            req.query.limit,
            YTMUSIC_HOME_DEFAULT_LIMIT,
            1,
            YTMUSIC_HOME_MAX_LIMIT
        );
        const cacheKey = `home:${limit}:${userId ?? "public"}`;

        const cached = getCachedOrNull(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const shelves = await ytMusicService.getHome(limit, userId);
        const result = { shelves, source: "ytmusic" as const };
        setCache(cacheKey, result);
        res.json(result);
    } catch (error: any) {
        const status = resolveHttpStatusFromError(error);
        if (status && status >= 400 && status < 500) {
            return res.status(status).json({
                error:
                    typeof error?.response?.data?.detail === "string"
                        ? error.response.data.detail
                        : "Invalid request for home content",
            });
        }
        logger.error("[Browse] YT Music home error:", error);
        res.status(500).json({ error: "Failed to fetch home content" });
    }
});

/**
 * @openapi
 * /api/browse/ytmusic/mood-playlists:
 *   get:
 *     summary: Get playlists for a specific mood/genre category
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: params
 *         required: true
 *         schema:
 *           type: string
 *         description: Category params string from mood categories endpoint
 *     responses:
 *       200:
 *         description: Array of playlists for the mood category
 *       400:
 *         description: Missing params
 *       401:
 *         description: Not authenticated
 */
router.get("/ytmusic/mood-playlists", async (req: Request, res: Response) => {
    try {
        if (!(await ensureYtMusicEnabled(res))) {
            return;
        }

        const userId = req.user?.id;
        const params = parseMoodParams(req.query.params);
        if (!params) {
            return res.status(400).json({
                error:
                    "params query parameter is required and must be a non-empty string up to 512 characters",
            });
        }

        const cacheKey = `mood-playlists:${params}:${userId ?? "public"}`;

        const cached = getCachedOrNull(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const playlists = await ytMusicService.getMoodPlaylists(params, userId);
        const result = { playlists, source: "ytmusic" as const };
        setCache(cacheKey, result);
        res.json(result);
    } catch (error: any) {
        const status = resolveHttpStatusFromError(error);
        if (status && status >= 400 && status < 500) {
            return res.status(status).json({
                error:
                    typeof error?.response?.data?.detail === "string"
                        ? error.response.data.detail
                        : "Invalid request for mood playlists",
            });
        }
        logger.error("[Browse] YT Music mood playlists error:", error);
        res.status(500).json({ error: "Failed to fetch mood playlists" });
    }
});

/**
 * @openapi
 * /api/browse/ytmusic/album/{id}:
 *   get:
 *     summary: Get a YT Music album by browse ID
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
 *         description: YT Music album browse ID (e.g. MPREb_...)
 *     responses:
 *       200:
 *         description: Album details normalized to playlist shape
 *       404:
 *         description: Album not found
 *       401:
 *         description: Not authenticated
 */
router.get("/ytmusic/album/:id", async (req: Request, res: Response) => {
    try {
        if (!(await ensureYtMusicEnabled(res))) {
            return;
        }

        const { id } = req.params;
        const cacheKey = `album:${id}`;

        const cached = getCachedOrNull(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const album = await ytMusicService.getBrowseAlbum(id);

        // Normalize to YtMusicBrowsePlaylist shape so the frontend detail page
        // can render it uniformly without knowing whether it's an album or playlist.
        const description = [
            album.artist,
            album.year,
        ].filter(Boolean).join(" \u00B7 ");

        const result = {
            id,
            title: album.title,
            description,
            trackCount: album.trackCount ?? album.tracks.length,
            thumbnailUrl: album.coverUrl,
            tracks: album.tracks.map((t) => ({
                videoId: t.videoId,
                title: t.title,
                artist: t.artist,
                artists: t.artists,
                album: album.title ?? "",
                duration: t.duration_seconds ?? 0,
                thumbnailUrl: album.coverUrl,
            })),
            source: "ytmusic" as const,
            type: "album" as const,
        };
        setCache(cacheKey, result);
        res.json(result);
    } catch (error: any) {
        if (error.response?.status === 404) {
            return res.status(404).json({ error: "Album not found" });
        }
        logger.error("[Browse] YT Music album error:", error);
        res.status(500).json({ error: "Failed to fetch album" });
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
 *       404:
 *         description: Playlist not found
 *       401:
 *         description: Not authenticated
 */
router.get("/ytmusic/playlist/:id", async (req: Request, res: Response) => {
    try {
        if (!(await ensureYtMusicEnabled(res))) {
            return;
        }

        const { id } = req.params;
        const limit = parseBoundedInt(
            req.query.limit,
            YTMUSIC_PLAYLIST_DEFAULT_LIMIT,
            1,
            YTMUSIC_PLAYLIST_MAX_LIMIT
        );
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
        res.status(500).json({ error: "Failed to fetch playlist" });
    }
});

// ── Simple TTL cache for TIDAL browse data ───────────────────
const TIDAL_BROWSE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const TIDAL_BROWSE_MAX_CACHE_ENTRIES = 256;
const tidalBrowseCache = new Map<string, { data: any; expiresAt: number }>();

/**
 * Clear the TIDAL browse cache (exported for test isolation).
 */
export function _resetTidalBrowseCache(): void {
    tidalBrowseCache.clear();
}

function getTidalCachedOrNull<T>(key: string): T | null {
    const entry = tidalBrowseCache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.data as T;
    if (entry) tidalBrowseCache.delete(key);
    return null;
}

function setTidalCache(key: string, data: any): void {
    // Prune expired
    const now = Date.now();
    for (const [k, v] of tidalBrowseCache.entries()) {
        if (v.expiresAt <= now) tidalBrowseCache.delete(k);
    }
    tidalBrowseCache.set(key, { data, expiresAt: Date.now() + TIDAL_BROWSE_TTL_MS });
    while (tidalBrowseCache.size > TIDAL_BROWSE_MAX_CACHE_ENTRIES) {
        const oldestKey = tidalBrowseCache.keys().next().value;
        if (!oldestKey) break;
        tidalBrowseCache.delete(oldestKey);
    }
}

/**
 * Check that TIDAL integration is both enabled and the sidecar is reachable.
 * Returns false (and sends 403) when not available.
 */
async function ensureTidalEnabled(req: Request, res: Response): Promise<boolean> {
    const [enabled, available] = await Promise.all([
        tidalStreamingService.isEnabled(),
        tidalStreamingService.isAvailable(),
    ]);
    if (!enabled || !available) {
        res.status(403).json({ error: "TIDAL integration is not enabled or not available" });
        return false;
    }
    // Verify user has authenticated TIDAL credentials
    const userId = req.user?.id;
    if (userId) {
        try {
            const authStatus = await tidalStreamingService.getAuthStatus(userId);
            if (!authStatus.authenticated) {
                res.status(403).json({ error: "TIDAL credentials not authenticated" });
                return false;
            }
        } catch {
            // If we can't verify auth, allow through — sidecar will enforce
        }
    }
    return true;
}

const TIDAL_IMAGE_ALLOWED_HOSTS = [
    "resources.tidal.com",
    ".tidal.com",
];

function isTidalImageHostAllowed(hostname: string): boolean {
    const lower = hostname.toLowerCase();
    return TIDAL_IMAGE_ALLOWED_HOSTS.some((suffix) => lower.endsWith(suffix));
}

// ── TIDAL Browse Routes ─────────────────────────────────────────

/**
 * @openapi
 * /api/browse/tidal/image:
 *   get:
 *     summary: Proxy and cache a TIDAL thumbnail image
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: url
 *         required: true
 *         schema:
 *           type: string
 *         description: External thumbnail URL to proxy
 *     responses:
 *       200:
 *         description: Cached image bytes
 *         content:
 *           image/jpeg:
 *             schema:
 *               type: string
 *               format: binary
 *       400:
 *         description: Missing or disallowed URL
 *       404:
 *         description: Image could not be fetched
 *       401:
 *         description: Not authenticated
 */
router.get("/tidal/image", imageLimiter, async (req: Request, res: Response) => {
    const rawUrl = req.query.url;
    if (typeof rawUrl !== "string" || !rawUrl.trim()) {
        return res.status(400).json({ error: "url query parameter is required" });
    }

    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return res.status(400).json({ error: "Invalid URL" });
    }

    if (!isTidalImageHostAllowed(parsed.hostname)) {
        return res.status(400).json({ error: "URL host not allowed" });
    }

    const key = browseImageCacheKey(rawUrl);

    // Check disk cache
    const cached = getBrowseImageFromCache(key);
    if (cached) {
        res.set("Content-Type", cached.contentType);
        res.set("Cache-Control", "public, max-age=604800, immutable");
        return res.sendFile(cached.filePath);
    }

    // Fetch, cache, and serve
    const entry = await fetchAndCacheBrowseImage(rawUrl);
    if (!entry) {
        return res.status(404).json({ error: "Failed to fetch image" });
    }

    res.set("Content-Type", entry.contentType);
    res.set("Cache-Control", "public, max-age=604800, immutable");
    return res.sendFile(entry.filePath);
});

/**
 * @openapi
 * /api/browse/tidal/home:
 *   get:
 *     summary: Get TIDAL personalized home shelves
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Array of shelves with contents
 *       403:
 *         description: TIDAL integration not enabled or unavailable
 *       401:
 *         description: Not authenticated
 */
router.get("/tidal/home", async (req: Request, res: Response) => {
    try {
        if (!(await ensureTidalEnabled(req, res))) {
            return;
        }

        const userId = req.user!.id;
        const quality = await tidalStreamingService.getUserPreferredQuality(userId);
        const cacheKey = `tidal:home:${quality}:${userId}`;

        const cached = getTidalCachedOrNull(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const shelves = await tidalStreamingService.getHomeShelves(userId, quality);
        const result = { shelves, source: "tidal" as const };
        setTidalCache(cacheKey, result);
        res.json(result);
    } catch (error: any) {
        logger.error("[Browse] TIDAL home error:", error?.message || "unknown");
        res.status(500).json({ error: "Failed to fetch TIDAL home content" });
    }
});

/**
 * @openapi
 * /api/browse/tidal/explore:
 *   get:
 *     summary: Get TIDAL editorial/explore shelves
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Array of shelves with contents
 *       403:
 *         description: TIDAL integration not enabled or unavailable
 *       401:
 *         description: Not authenticated
 */
router.get("/tidal/explore", async (req: Request, res: Response) => {
    try {
        if (!(await ensureTidalEnabled(req, res))) {
            return;
        }

        const userId = req.user!.id;
        const quality = await tidalStreamingService.getUserPreferredQuality(userId);
        const cacheKey = `tidal:explore:${quality}:${userId}`;

        const cached = getTidalCachedOrNull(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const shelves = await tidalStreamingService.getExploreShelves(userId, quality);
        const result = { shelves, source: "tidal" as const };
        setTidalCache(cacheKey, result);
        res.json(result);
    } catch (error: any) {
        logger.error("[Browse] TIDAL explore error:", error?.message || "unknown");
        res.status(500).json({ error: "Failed to fetch TIDAL explore content" });
    }
});

/**
 * @openapi
 * /api/browse/tidal/genres:
 *   get:
 *     summary: Get TIDAL genre categories
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of genre categories
 *       403:
 *         description: TIDAL integration not enabled or unavailable
 *       401:
 *         description: Not authenticated
 */
router.get("/tidal/genres", async (req: Request, res: Response) => {
    try {
        if (!(await ensureTidalEnabled(req, res))) {
            return;
        }

        const userId = req.user!.id;
        const quality = await tidalStreamingService.getUserPreferredQuality(userId);
        const cacheKey = `tidal:genres:${quality}:${userId}`;

        const cached = getTidalCachedOrNull(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const genres = await tidalStreamingService.getGenres(userId, quality);
        const result = { genres, source: "tidal" as const };
        setTidalCache(cacheKey, result);
        res.json(result);
    } catch (error: any) {
        logger.error("[Browse] TIDAL genres error:", error?.message || "unknown");
        res.status(500).json({ error: "Failed to fetch TIDAL genres" });
    }
});

/**
 * @openapi
 * /api/browse/tidal/moods:
 *   get:
 *     summary: Get TIDAL mood categories
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of mood categories
 *       403:
 *         description: TIDAL integration not enabled or unavailable
 *       401:
 *         description: Not authenticated
 */
router.get("/tidal/moods", async (req: Request, res: Response) => {
    try {
        if (!(await ensureTidalEnabled(req, res))) {
            return;
        }

        const userId = req.user!.id;
        const quality = await tidalStreamingService.getUserPreferredQuality(userId);
        const cacheKey = `tidal:moods:${quality}:${userId}`;

        const cached = getTidalCachedOrNull(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const moods = await tidalStreamingService.getMoods(userId, quality);
        const result = { moods, source: "tidal" as const };
        setTidalCache(cacheKey, result);
        res.json(result);
    } catch (error: any) {
        logger.error("[Browse] TIDAL moods error:", error?.message || "unknown");
        res.status(500).json({ error: "Failed to fetch TIDAL moods" });
    }
});

/**
 * @openapi
 * /api/browse/tidal/mixes:
 *   get:
 *     summary: Get TIDAL personal mixes (daily discovery, etc.)
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of personal mix previews
 *       403:
 *         description: TIDAL integration not enabled or unavailable
 *       401:
 *         description: Not authenticated
 */
router.get("/tidal/mixes", async (req: Request, res: Response) => {
    try {
        if (!(await ensureTidalEnabled(req, res))) {
            return;
        }

        const userId = req.user!.id;
        const quality = await tidalStreamingService.getUserPreferredQuality(userId);
        const cacheKey = `tidal:mixes:${quality}:${userId}`;

        const cached = getTidalCachedOrNull(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const mixes = await tidalStreamingService.getMixes(userId, quality);
        const result = { mixes, source: "tidal" as const };
        setTidalCache(cacheKey, result);
        res.json(result);
    } catch (error: any) {
        logger.error("[Browse] TIDAL mixes error:", error?.message || "unknown");
        res.status(500).json({ error: "Failed to fetch TIDAL mixes" });
    }
});

/**
 * @openapi
 * /api/browse/tidal/genre-playlists:
 *   get:
 *     summary: Get TIDAL playlists for a specific genre/mood path
 *     tags: [Browse]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Genre or mood path string
 *     responses:
 *       200:
 *         description: Array of playlist previews for the genre
 *       400:
 *         description: Missing path query parameter
 *       403:
 *         description: TIDAL integration not enabled or unavailable
 *       401:
 *         description: Not authenticated
 */
router.get("/tidal/genre-playlists", async (req: Request, res: Response) => {
    try {
        if (!(await ensureTidalEnabled(req, res))) {
            return;
        }

        const path = req.query.path;
        if (typeof path !== "string" || !path.trim()) {
            return res.status(400).json({ error: "path query parameter is required" });
        }
        if (path.length > 200) {
            return res.status(400).json({ error: "path parameter too long" });
        }

        const userId = req.user!.id;
        const quality = await tidalStreamingService.getUserPreferredQuality(userId);
        const cacheKey = `tidal:genre-playlists:${quality}:${path}:${userId}`;

        const cached = getTidalCachedOrNull(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const playlists = await tidalStreamingService.getGenrePlaylists(userId, path, quality);
        const result = { playlists, source: "tidal" as const };
        setTidalCache(cacheKey, result);
        res.json(result);
    } catch (error: any) {
        logger.error("[Browse] TIDAL genre playlists error:", error?.message || "unknown");
        res.status(500).json({ error: "Failed to fetch TIDAL genre playlists" });
    }
});

/**
 * @openapi
 * /api/browse/tidal/playlist/{id}:
 *   get:
 *     summary: Get a TIDAL browse playlist with tracks
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
 *         description: TIDAL playlist ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Maximum number of tracks to fetch
 *     responses:
 *       200:
 *         description: Playlist details with tracks
 *       403:
 *         description: TIDAL integration not enabled or unavailable
 *       401:
 *         description: Not authenticated
 */
router.get("/tidal/playlist/:id", async (req: Request, res: Response) => {
    try {
        if (!(await ensureTidalEnabled(req, res))) {
            return;
        }

        const { id } = req.params;
        const userId = req.user!.id;
        const limitRaw = req.query.limit;
        const limit = typeof limitRaw === "string" && limitRaw.trim()
            ? Number.parseInt(limitRaw, 10)
            : undefined;
        const validLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0
            ? Math.min(limit, 500)
            : undefined;
        const quality = await tidalStreamingService.getUserPreferredQuality(userId);
        const cacheKey = `tidal:playlist:${quality}:${id}:${validLimit ?? "all"}:${userId}`;

        const cached = getTidalCachedOrNull(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const playlist = await tidalStreamingService.getBrowsePlaylist(userId, id, quality, validLimit);
        const result = { ...playlist, source: "tidal" as const };
        setTidalCache(cacheKey, result);
        res.json(result);
    } catch (error: any) {
        logger.error("[Browse] TIDAL playlist error:", error?.message || "unknown");
        res.status(500).json({ error: "Failed to fetch TIDAL playlist" });
    }
});

/**
 * @openapi
 * /api/browse/tidal/mix/{id}:
 *   get:
 *     summary: Get a TIDAL browse mix with tracks
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
 *         description: TIDAL mix ID
 *     responses:
 *       200:
 *         description: Mix details with tracks
 *       403:
 *         description: TIDAL integration not enabled or unavailable
 *       401:
 *         description: Not authenticated
 */
router.get("/tidal/mix/:id", async (req: Request, res: Response) => {
    try {
        if (!(await ensureTidalEnabled(req, res))) {
            return;
        }

        const { id } = req.params;
        const userId = req.user!.id;
        const quality = await tidalStreamingService.getUserPreferredQuality(userId);
        const cacheKey = `tidal:mix:${quality}:${id}:${userId}`;

        const cached = getTidalCachedOrNull(cacheKey);
        if (cached) {
            return res.json(cached);
        }

        const mix = await tidalStreamingService.getBrowseMix(userId, id, quality);
        const result = { ...mix, source: "tidal" as const };
        setTidalCache(cacheKey, result);
        res.json(result);
    } catch (error: any) {
        logger.error("[Browse] TIDAL mix error:", error?.message || "unknown");
        res.status(500).json({ error: "Failed to fetch TIDAL mix" });
    }
});

export default router;
