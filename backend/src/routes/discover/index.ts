import { Router, type RequestHandler } from "express";
import { config } from "../../config";
import { requireAdmin, requireAuthOrToken } from "../../middleware/auth";
import { handleModernBatchStatus } from "./batchStatus";
import { handleGenerateStatus, handleModernGenerate } from "./generation";
import { handleModernCurrent } from "./current";
import { handleModernLike, handleModernUnlike } from "./albumActions";
import {
    handleGetDiscoverConfig,
    handleUpdateDiscoverConfig,
} from "./configuration";
import { handlePopularArtists } from "./popularArtists";
import { handleModernClear } from "./clear";
import {
    handleClearExclusions,
    handleGetExclusions,
    handleRemoveExclusion,
} from "./exclusions";
import {
    handleModernCleanupLidarr,
    handleModernFixTagging,
} from "./maintenance";
import { handleLegacyBatchStatus } from "./legacy/batchStatus";
import { handleLegacyGenerate } from "./legacy/generation";
import { handleLegacyCurrent } from "./legacy/current";
import { handleLegacyLike, handleLegacyUnlike } from "./legacy/albumActions";
import { handleLegacyClear } from "./legacy/clear";
import {
    handleLegacyCleanupLidarr,
    handleLegacyFixTagging,
} from "./legacy/maintenance";

const router = Router();
const isLegacyDiscoveryMode = config.discover.mode === "legacy";

function modeHandler(
    modernHandler: RequestHandler,
    legacyHandler: RequestHandler,
): RequestHandler {
    return isLegacyDiscoveryMode ? legacyHandler : modernHandler;
}

router.use(requireAuthOrToken);

/**
 * @openapi
 * /api/discover/batch-status:
 *   get:
 *     summary: Check if there is an active batch being processed
 *     tags: [Discover]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Current batch processing status
 *       401:
 *         description: Not authenticated
 */
router.get(
    "/batch-status",
    modeHandler(handleModernBatchStatus, handleLegacyBatchStatus),
);

/**
 * @openapi
 * /api/discover/generate:
 *   post:
 *     summary: Generate new Discover Weekly playlist
 *     tags: [Discover]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Generation job started successfully
 *       409:
 *         description: Generation already in progress
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Legacy-mode generation is restricted to administrators
 */
router.post(
    "/generate",
    modeHandler(handleModernGenerate, handleLegacyGenerate),
);

/**
 * @openapi
 * /api/discover/generate/status/{jobId}:
 *   get:
 *     summary: Check generation job status
 *     tags: [Discover]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema:
 *           type: string
 *         description: Bull queue job ID
 *     responses:
 *       200:
 *         description: Job status, progress, and result
 *       404:
 *         description: Job not found
 *       401:
 *         description: Not authenticated
 */
router.get("/generate/status/:jobId", handleGenerateStatus);

/**
 * @openapi
 * /api/discover/current:
 *   get:
 *     summary: Get current week's Discover Weekly playlist
 *     tags: [Discover]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Current discovery playlist with tracks and unavailable albums
 *       401:
 *         description: Not authenticated
 */
router.get("/current", modeHandler(handleModernCurrent, handleLegacyCurrent));

/**
 * @openapi
 * /api/discover/like:
 *   post:
 *     summary: Like a discovery album (marks entire album for keeping)
 *     tags: [Discover]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - albumId
 *             properties:
 *               albumId:
 *                 type: string
 *                 description: MusicBrainz release group MBID of the album
 *     responses:
 *       200:
 *         description: Album liked successfully
 *       404:
 *         description: Album not in active discovery
 *       410:
 *         description: Endpoint disabled for recommendation-only discovery mode
 *       401:
 *         description: Not authenticated
 */
router.post("/like", modeHandler(handleModernLike, handleLegacyLike));

/**
 * @openapi
 * /api/discover/unlike:
 *   delete:
 *     summary: Unlike a previously liked discovery album
 *     tags: [Discover]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - albumId
 *             properties:
 *               albumId:
 *                 type: string
 *                 description: MusicBrainz release group MBID of the album
 *     responses:
 *       200:
 *         description: Album unliked successfully
 *       404:
 *         description: Album not liked
 *       410:
 *         description: Endpoint disabled for recommendation-only discovery mode
 *       401:
 *         description: Not authenticated
 */
router.delete("/unlike", modeHandler(handleModernUnlike, handleLegacyUnlike));

/**
 * @openapi
 * /api/discover/config:
 *   get:
 *     summary: Get user's Discover Weekly configuration
 *     tags: [Discover]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: User's discovery configuration settings
 *       401:
 *         description: Not authenticated
 */
router.get("/config", handleGetDiscoverConfig);

/**
 * @openapi
 * /api/discover/config:
 *   patch:
 *     summary: Update user's Discover Weekly configuration
 *     tags: [Discover]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               playlistSize:
 *                 type: integer
 *                 minimum: 5
 *                 maximum: 50
 *                 description: Playlist size (increments of 5)
 *               maxRetryAttempts:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 10
 *               exclusionMonths:
 *                 type: integer
 *                 minimum: 0
 *                 maximum: 12
 *               downloadRatio:
 *                 type: number
 *                 minimum: 1.0
 *                 maximum: 2.0
 *               enabled:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Updated discovery configuration
 *       400:
 *         description: Invalid configuration values
 *       401:
 *         description: Not authenticated
 */
router.patch("/config", handleUpdateDiscoverConfig);

/**
 * @openapi
 * /api/discover/popular-artists:
 *   get:
 *     summary: Get popular artists from Last.fm charts
 *     tags: [Discover]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Maximum number of artists to return
 *     responses:
 *       200:
 *         description: List of popular chart artists
 *       401:
 *         description: Not authenticated
 */
router.get("/popular-artists", handlePopularArtists);

/**
 * @openapi
 * /api/discover/clear:
 *   delete:
 *     summary: Clear the discovery playlist (move liked to library, delete the rest)
 *     tags: [Discover]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Playlist cleared with summary of moved and deleted albums
 *       401:
 *         description: Not authenticated
 */
router.delete("/clear", modeHandler(handleModernClear, handleLegacyClear));

/**
 * @openapi
 * /api/discover/exclusions:
 *   get:
 *     summary: Get all active discovery exclusions for the current user
 *     tags: [Discover]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of active exclusions with count
 *       401:
 *         description: Not authenticated
 */
router.get("/exclusions", handleGetExclusions);

/**
 * @openapi
 * /api/discover/exclusions:
 *   delete:
 *     summary: Clear all discovery exclusions for the current user
 *     tags: [Discover]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: All exclusions cleared with count
 *       401:
 *         description: Not authenticated
 */
router.delete("/exclusions", handleClearExclusions);

/**
 * @openapi
 * /api/discover/exclusions/{id}:
 *   delete:
 *     summary: Remove a specific discovery exclusion
 *     tags: [Discover]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Exclusion ID
 *     responses:
 *       200:
 *         description: Exclusion removed successfully
 *       404:
 *         description: Exclusion not found
 *       401:
 *         description: Not authenticated
 */
router.delete("/exclusions/:id", handleRemoveExclusion);

/**
 * @openapi
 * /api/discover/cleanup-lidarr:
 *   post:
 *     summary: Remove discovery-only artists from Lidarr
 *     tags: [Discover]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Cleanup summary with removed, kept, and errored artists
 *       400:
 *         description: Lidarr not configured
 *       410:
 *         description: Only available in legacy discovery mode
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
router.post(
    "/cleanup-lidarr",
    requireAdmin,
    modeHandler(handleModernCleanupLidarr, handleLegacyCleanupLidarr),
);

/**
 * @openapi
 * /api/discover/fix-tagging:
 *   post:
 *     summary: Fix albums incorrectly tagged as LIBRARY that should be DISCOVER
 *     tags: [Discover]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Tagging repair summary with fixed albums count
 *       410:
 *         description: Only available in legacy discovery mode
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
router.post(
    "/fix-tagging",
    requireAdmin,
    modeHandler(handleModernFixTagging, handleLegacyFixTagging),
);

export default router;
