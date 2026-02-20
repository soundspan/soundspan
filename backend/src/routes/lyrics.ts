import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth } from "../middleware/auth";
import { lyricsMutationLimiter } from "../middleware/rateLimiter";
import {
    getLyrics,
    clearLyricsCache,
    type LyricsLookupContext,
} from "../services/lyrics";

const router = Router();
// Keep this above service-level LRCLIB timeout + embedded fallback chain to avoid
// returning temporary false negatives during first-open lookup.
const LYRICS_ROUTE_TIMEOUT_MS = 20000;

class LyricsRouteTimeoutError extends Error {
    constructor(trackId: string) {
        super(
            `Lyrics lookup timed out for ${trackId} after ${LYRICS_ROUTE_TIMEOUT_MS}ms`
        );
        this.name = "LyricsRouteTimeoutError";
    }
}

router.use(requireAuth);

async function getLyricsWithRouteTimeout(
    trackId: string,
    context: LyricsLookupContext
) {
    return new Promise<{
        syncedLyrics: string | null;
        plainLyrics: string | null;
        source: string;
        synced: boolean;
    }>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            logger.warn(
                `[Lyrics] GET /lyrics/${trackId} timed out after ${LYRICS_ROUTE_TIMEOUT_MS}ms`
            );
            reject(new LyricsRouteTimeoutError(trackId));
        }, LYRICS_ROUTE_TIMEOUT_MS);

        getLyrics(trackId, context)
            .then((result) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve(result);
            })
            .catch((error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                reject(error);
            });
    });
}

/**
 * @openapi
 * /lyrics/{trackId}:
 *   get:
 *     summary: Get lyrics for a track
 *     description: |
 *       Retrieves synced (LRC format) or plain lyrics for a track.
 *       Uses a waterfall strategy: DB cache → embedded file tags → LRCLIB API.
 *       Results are cached in the database for subsequent requests.
 *     tags: [Lyrics]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: trackId
 *         required: true
 *         schema:
 *           type: string
 *         description: The track ID to fetch lyrics for
 *       - in: query
 *         name: artist
 *         required: false
 *         schema:
 *           type: string
 *         description: Optional artist name for non-library/synthetic tracks
 *       - in: query
 *         name: title
 *         required: false
 *         schema:
 *           type: string
 *         description: Optional track title for non-library/synthetic tracks
 *       - in: query
 *         name: album
 *         required: false
 *         schema:
 *           type: string
 *         description: Optional album title for non-library/synthetic tracks
 *       - in: query
 *         name: duration
 *         required: false
 *         schema:
 *           type: number
 *         description: Optional track duration in seconds
 *     responses:
 *       200:
 *         description: Lyrics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 syncedLyrics:
 *                   type: string
 *                   nullable: true
 *                   description: LRC-format synced lyrics (e.g. "[00:12.34] Line text")
 *                 plainLyrics:
 *                   type: string
 *                   nullable: true
 *                   description: Plain text lyrics without timestamps
 *                 source:
 *                   type: string
 *                   enum: [lrclib, embedded, none]
 *                   description: Where the lyrics were sourced from
 *                 synced:
 *                   type: boolean
 *                   description: Whether synced (timestamped) lyrics are available
 *       404:
 *         description: Track not found
 *       500:
 *         description: Server error
 *       504:
 *         description: Lyrics lookup timed out
 */
router.get("/:trackId", async (req, res) => {
    const startedAt = Date.now();
    try {
        const { trackId } = req.params;
        const artistName =
            typeof req.query.artist === "string" ? req.query.artist : undefined;
        const trackName =
            typeof req.query.title === "string" ? req.query.title : undefined;
        const albumName =
            typeof req.query.album === "string" ? req.query.album : undefined;
        const durationRaw =
            typeof req.query.duration === "string"
                ? Number(req.query.duration)
                : undefined;
        const duration =
            typeof durationRaw === "number" &&
            Number.isFinite(durationRaw) &&
            durationRaw > 0
                ? durationRaw
                : undefined;

        const result = await getLyricsWithRouteTimeout(trackId, {
            artistName,
            trackName,
            albumName,
            duration,
        });
        logger.debug(
            `[Lyrics] GET /lyrics/${trackId} source=${result.source} synced=${result.synced} (${Date.now() - startedAt}ms)`
        );
        res.json(result);
    } catch (error) {
        if (error instanceof LyricsRouteTimeoutError) {
            return res.status(504).json({
                error: "Lyrics lookup timed out",
            });
        }
        logger.error(`Get lyrics error for track ${req.params.trackId}:`, error);
        res.status(503).json({ error: "Failed to load lyrics" });
    }
});

/**
 * @openapi
 * /lyrics/{trackId}:
 *   delete:
 *     summary: Clear cached lyrics for a track
 *     description: Removes cached lyrics so they are re-fetched on next request
 *     tags: [Lyrics]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: trackId
 *         required: true
 *         schema:
 *           type: string
 *         description: The track ID to clear lyrics cache for
 *     responses:
 *       200:
 *         description: Cache cleared
 *       500:
 *         description: Server error
 */
router.delete("/:trackId", lyricsMutationLimiter, async (req, res) => {
    try {
        const { trackId } = req.params;
        await clearLyricsCache(trackId);
        res.json({ message: "Lyrics cache cleared" });
    } catch (error) {
        logger.error(`Clear lyrics cache error for track ${req.params.trackId}:`, error);
        res.status(500).json({ error: "Failed to clear lyrics cache" });
    }
});

export default router;
