import { Router } from "express";
import { logger } from "../utils/logger";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { enrichmentService } from "../services/enrichment";
import {
    getEnrichmentProgress,
    runFullEnrichment,
    reRunArtistsOnly,
    reRunMoodTagsOnly,
    reRunAudioAnalysisOnly,
    reRunVibeEmbeddingsOnly,
    triggerEnrichmentNow,
} from "../workers/unifiedEnrichment";
import { enrichmentStateService } from "../services/enrichmentState";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import { musicBrainzService } from "../services/musicbrainz";
import {
    getSystemSettings,
    invalidateSystemSettingsCache,
} from "../utils/systemSettings";
import { rateLimiter } from "../services/rateLimiter";
import { redisClient } from "../utils/redis";

const router = Router();

router.use(requireAuth);

const MBID_FORMAT_EXAMPLE = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
const MBID_UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidMusicBrainzId(value: string): boolean {
    return MBID_UUID_REGEX.test(value);
}

/**
 * @openapi
 * /api/enrichment/progress:
 *   get:
 *     summary: Get comprehensive enrichment progress
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Progress data for artists, track tags, and audio analysis
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /enrichment/progress
 * Get comprehensive enrichment progress (artists, track tags, audio analysis)
 */
router.get("/progress", async (req, res) => {
    try {
        const progress = await getEnrichmentProgress();
        res.json(progress);
    } catch (error) {
        logger.error("Get enrichment progress error:", error);
        res.status(500).json({ error: "Failed to get progress" });
    }
});

/**
 * @openapi
 * /api/enrichment/status:
 *   get:
 *     summary: Get detailed enrichment state
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Enrichment state including running, paused, or idle status
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /enrichment/status
 * Get detailed enrichment state (running, paused, etc.)
 */
router.get("/status", async (req, res) => {
    try {
        const state = await enrichmentStateService.getState();
        res.json(state || { status: "idle", currentPhase: null });
    } catch (error) {
        logger.error("Get enrichment status error:", error);
        res.status(500).json({ error: "Failed to get status" });
    }
});

/**
 * @openapi
 * /api/enrichment/pause:
 *   post:
 *     summary: Pause the enrichment process
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Enrichment paused
 *       400:
 *         description: Cannot pause enrichment in current state
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * POST /enrichment/pause
 * Pause the enrichment process
 */
router.post("/pause", requireAdmin, async (req, res) => {
    try {
        const state = await enrichmentStateService.pause();
        res.json({
            message: "Enrichment paused",
            state,
        });
    } catch (error: any) {
        logger.error("Pause enrichment error:", error);
        res.status(400).json({
            error: error.message || "Failed to pause enrichment",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/resume:
 *   post:
 *     summary: Resume a paused enrichment process
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Enrichment resumed
 *       400:
 *         description: Cannot resume enrichment in current state
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * POST /enrichment/resume
 * Resume a paused enrichment process
 */
router.post("/resume", requireAdmin, async (req, res) => {
    try {
        const state = await enrichmentStateService.resume();
        res.json({
            message: "Enrichment resumed",
            state,
        });
    } catch (error: any) {
        logger.error("Resume enrichment error:", error);
        res.status(400).json({
            error: error.message || "Failed to resume enrichment",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/stop:
 *   post:
 *     summary: Stop the enrichment process
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Enrichment stopping
 *       400:
 *         description: Cannot stop enrichment in current state
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * POST /enrichment/stop
 * Stop the enrichment process
 */
router.post("/stop", requireAdmin, async (req, res) => {
    try {
        const state = await enrichmentStateService.stop();
        res.json({
            message: "Enrichment stopping...",
            state,
        });
    } catch (error: any) {
        logger.error("Stop enrichment error:", error);
        res.status(400).json({
            error: error.message || "Failed to stop enrichment",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/full:
 *   post:
 *     summary: Trigger full enrichment of all content
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               forceVibeRebuild:
 *                 type: boolean
 *                 default: false
 *               forceMoodBucketBackfill:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       200:
 *         description: Full enrichment started in background
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * POST /enrichment/full
 * Trigger full enrichment (re-enriches everything regardless of status)
 * Admin only
 */
router.post("/full", requireAdmin, async (req, res) => {
    try {
        const forceVibeRebuild = req.body?.forceVibeRebuild === true;
        const forceMoodBucketBackfill =
            req.body?.forceMoodBucketBackfill === true;

        // This runs in the background
        runFullEnrichment({
            forceVibeRebuild,
            forceMoodBucketBackfill,
        }).catch((err) => {
            logger.error("Full enrichment error:", err);
        });

        res.json({
            message: "Full enrichment started",
            description:
                forceVibeRebuild ?
                    "All artists, track tags, audio analysis, and CLAP embeddings will be re-processed"
                :   "All artists, track tags, and audio analysis will be re-processed",
            forceVibeRebuild,
            forceMoodBucketBackfill,
        });
    } catch (error) {
        logger.error("Trigger full enrichment error:", error);
        res.status(500).json({ error: "Failed to start full enrichment" });
    }
});

/**
 * @openapi
 * /api/enrichment/reset-artists:
 *   post:
 *     summary: Reset and re-run artist enrichment only
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Artist enrichment reset and queued for re-processing
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * POST /enrichment/reset-artists
 * Reset only artist enrichment (keeps mood tags and audio analysis intact)
 * Admin only - selective re-enrichment for large libraries
 */
router.post("/reset-artists", requireAdmin, async (req, res) => {
     try {
         const result = await reRunArtistsOnly();

         res.json({
             message: "Artist enrichment reset",
             description: `${result.count} artists queued for re-enrichment`,
             count: result.count,
         });
     } catch (error) {
         logger.error("Reset artists error:", error);
         res.status(500).json({ error: "Failed to reset artist enrichment" });
     }
 });

/**
 * @openapi
 * /api/enrichment/reset-mood-tags:
 *   post:
 *     summary: Reset and re-run mood tag enrichment only
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Mood tags reset and queued for re-processing
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * POST /enrichment/reset-mood-tags
 * Reset only mood tags (keeps artist metadata and audio analysis intact)
 * Admin only - selective re-enrichment for large libraries
 */
router.post("/reset-mood-tags", requireAdmin, async (req, res) => {
     try {
         const result = await reRunMoodTagsOnly();

         res.json({
             message: "Mood tags reset",
             description: `${result.count} tracks queued for mood tag re-enrichment`,
             count: result.count,
         });
     } catch (error) {
         logger.error("Reset mood tags error:", error);
         res.status(500).json({ error: "Failed to reset mood tags" });
     }
 });

/**
 * @openapi
 * /api/enrichment/reset-audio-analysis:
 *   post:
 *     summary: Reset and re-run audio analysis only
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Audio analysis reset and queued for re-processing
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * POST /enrichment/reset-audio-analysis
 * Reset only audio analysis (keeps artist metadata and mood tags intact)
 * Admin only - selective re-enrichment for large libraries
 */
router.post("/reset-audio-analysis", requireAdmin, async (req, res) => {
     try {
         const queued = await reRunAudioAnalysisOnly();

         res.json({
             message: "Audio analysis reset",
             description: `${queued} tracks queued for audio re-analysis`,
             count: queued,
         });
     } catch (error) {
         logger.error("Reset audio analysis error:", error);
         res.status(500).json({ error: "Failed to reset audio analysis" });
     }
 });

/**
 * @openapi
 * /api/enrichment/reset-vibe-embeddings:
 *   post:
 *     summary: Reset and re-run vibe embedding generation only
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Vibe embeddings reset and queued for re-processing
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
 /**
  * POST /enrichment/reset-vibe-embeddings
  * Reset only vibe embeddings (keeps all other enrichment intact)
  * Admin only - selective re-enrichment for large libraries
  */
 router.post("/reset-vibe-embeddings", requireAdmin, async (req, res) => {
     try {
         const queued = await reRunVibeEmbeddingsOnly();

         res.json({
             message: "Vibe embeddings reset",
             description: `${queued} tracks queued for vibe embedding re-analysis`,
             count: queued,
         });
     } catch (error) {
         logger.error("Reset vibe embeddings error:", error);
         res.status(500).json({ error: "Failed to reset vibe embeddings" });
     }
 });

/**
 * @openapi
 * /api/enrichment/sync:
 *   post:
 *     summary: Trigger incremental enrichment sync
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Incremental sync started, processing new and pending items only
 *       401:
 *         description: Not authenticated
 */
 /**
  * POST /enrichment/sync
  * Trigger incremental enrichment (only processes pending items)
  * Fast sync that picks up new content without re-processing everything
  */
 router.post("/sync", async (req, res) => {
     try {
         const result = await triggerEnrichmentNow();

         res.json({
             message: "Incremental sync started",
             description: "Processing new and pending items only",
             result,
         });
     } catch (error: any) {
         logger.error("Trigger sync error:", error);
         res.status(500).json({
             error: error.message || "Failed to start sync",
         });
     }
 });

/**
 * @openapi
 * /api/enrichment/settings:
 *   get:
 *     summary: Get enrichment settings for the current user
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: User enrichment settings
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /enrichment/settings
 * Get enrichment settings for current user
 */
router.get("/settings", async (req, res) => {
    try {
        const userId = req.user!.id;
        const settings = await enrichmentService.getSettings(userId);
        res.json(settings);
    } catch (error) {
        logger.error("Get enrichment settings error:", error);
        res.status(500).json({ error: "Failed to get settings" });
    }
});

/**
 * @openapi
 * /api/enrichment/settings:
 *   put:
 *     summary: Update enrichment settings for the current user
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Enrichment settings to update
 *     responses:
 *       200:
 *         description: Updated enrichment settings
 *       401:
 *         description: Not authenticated
 */
/**
 * PUT /enrichment/settings
 * Update enrichment settings for current user
 */
router.put("/settings", async (req, res) => {
    try {
        const userId = req.user!.id;
        const settings = await enrichmentService.updateSettings(
            userId,
            req.body
        );
        res.json(settings);
    } catch (error) {
        logger.error("Update enrichment settings error:", error);
        res.status(500).json({ error: "Failed to update settings" });
    }
});

/**
 * @openapi
 * /api/enrichment/artist/{id}:
 *   post:
 *     summary: Enrich a single artist
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The artist ID
 *     responses:
 *       200:
 *         description: Artist enrichment data with confidence score
 *       400:
 *         description: Enrichment is not enabled
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: No enrichment data found
 */
/**
 * POST /enrichment/artist/:id
 * Enrich a single artist
 */
router.post("/artist/:id", async (req, res) => {
    try {
        const userId = req.user!.id;
        const settings = await enrichmentService.getSettings(userId);

        if (!settings.enabled) {
            return res.status(400).json({ error: "Enrichment is not enabled" });
        }

        const enrichmentData = await enrichmentService.enrichArtist(
            req.params.id,
            settings
        );

        if (!enrichmentData) {
            return res.status(404).json({ error: "No enrichment data found" });
        }

        if (enrichmentData.confidence > 0.3) {
            await enrichmentService.applyArtistEnrichment(
                req.params.id,
                enrichmentData
            );
        }

        res.json({
            success: true,
            confidence: enrichmentData.confidence,
            data: enrichmentData,
        });
    } catch (error: any) {
        logger.error("Enrich artist error:", error);
        res.status(500).json({
            error: error.message || "Failed to enrich artist",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/album/{id}:
 *   post:
 *     summary: Enrich a single album
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The album ID
 *     responses:
 *       200:
 *         description: Album enrichment data with confidence score
 *       400:
 *         description: Enrichment is not enabled
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: No enrichment data found
 */
/**
 * POST /enrichment/album/:id
 * Enrich a single album
 */
router.post("/album/:id", async (req, res) => {
    try {
        const userId = req.user!.id;
        const settings = await enrichmentService.getSettings(userId);

        if (!settings.enabled) {
            return res.status(400).json({ error: "Enrichment is not enabled" });
        }

        const enrichmentData = await enrichmentService.enrichAlbum(
            req.params.id,
            settings
        );

        if (!enrichmentData) {
            return res.status(404).json({ error: "No enrichment data found" });
        }

        if (enrichmentData.confidence > 0.3) {
            await enrichmentService.applyAlbumEnrichment(
                req.params.id,
                enrichmentData
            );
        }

        res.json({
            success: true,
            confidence: enrichmentData.confidence,
            data: enrichmentData,
        });
    } catch (error: any) {
        logger.error("Enrich album error:", error);
        res.status(500).json({
            error: error.message || "Failed to enrich album",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/start:
 *   post:
 *     summary: Start library-wide enrichment in background
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Library enrichment started in background
 *       400:
 *         description: Enrichment is not enabled in settings
 *       401:
 *         description: Not authenticated
 */
/**
 * POST /enrichment/start
 * Start library-wide enrichment (runs in background)
 * Delegates to the unified enrichment worker for consistent state tracking,
 * failure recording, and pause/stop support.
 */
router.post("/start", async (req, res) => {
    try {
        const { prisma } = await import("../utils/db");
        const systemSettings = await prisma.systemSettings.findUnique({
            where: { id: "default" },
            select: { autoEnrichMetadata: true },
        });

        if (!systemSettings?.autoEnrichMetadata) {
            return res.status(400).json({
                error: "Enrichment is not enabled. Enable it in settings first.",
            });
        }

        // Run via unified worker (handles state, failures, notifications)
        runFullEnrichment().catch((err) => {
            logger.error("Background enrichment failed:", err);
        });

        res.json({
            success: true,
            message: "Library enrichment started in background",
        });
    } catch (error: any) {
        logger.error("Start enrichment error:", error);
        res.status(500).json({
            error: error.message || "Failed to start enrichment",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/search/musicbrainz/artists:
 *   get:
 *     summary: Search MusicBrainz for artists by name
 *     tags: [Enrichment]
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
 *         description: Artist name search query
 *     responses:
 *       200:
 *         description: List of matching MusicBrainz artists
 *       400:
 *         description: Query must be at least 2 characters
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /enrichment/search/musicbrainz/artists
 * Search MusicBrainz for artists by name.
 * Used by metadata editing workflows to assist MBID correction.
 */
router.get("/search/musicbrainz/artists", async (req, res) => {
    try {
        const query = String(req.query.q || "").trim();
        if (query.length < 2) {
            return res
                .status(400)
                .json({ error: "Query must be at least 2 characters" });
        }

        const results = await musicBrainzService.searchArtist(query, 10);
        const artists = results.map((artist: any) => ({
            mbid: artist.id,
            name: artist.name,
            disambiguation: artist.disambiguation || null,
            country: artist.country || null,
            type: artist.type || null,
            score:
                typeof artist.score === "number" ?
                    artist.score
                :   Number.parseInt(artist.score || "0", 10),
        }));

        res.json({ artists });
    } catch (error: any) {
        logger.error("MusicBrainz artist search error:", error);
        res.status(500).json({
            error: error?.message || "Search failed",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/search/musicbrainz/release-groups:
 *   get:
 *     summary: Search MusicBrainz for release groups by title
 *     tags: [Enrichment]
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
 *         description: Release group title search query
 *       - in: query
 *         name: artist
 *         schema:
 *           type: string
 *         description: Optional artist name to constrain results
 *     responses:
 *       200:
 *         description: List of matching MusicBrainz release groups
 *       400:
 *         description: Query must be at least 2 characters
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /enrichment/search/musicbrainz/release-groups
 * Search MusicBrainz for release groups by title (optionally constrained by artist).
 * Used by metadata editing workflows to assist release-group MBID correction.
 */
router.get("/search/musicbrainz/release-groups", async (req, res) => {
    try {
        const query = String(req.query.q || "").trim();
        const artistName = String(req.query.artist || "").trim();

        if (query.length < 2) {
            return res
                .status(400)
                .json({ error: "Query must be at least 2 characters" });
        }

        const releaseGroups = await musicBrainzService.searchReleaseGroups(
            query,
            artistName || undefined,
            10
        );

        const albums = releaseGroups.map((rg: any) => ({
            rgMbid: rg.id,
            title: rg.title,
            primaryType: rg["primary-type"] || "Album",
            secondaryTypes: rg["secondary-types"] || [],
            firstReleaseDate: rg["first-release-date"] || null,
            artistCredit:
                rg["artist-credit"]
                    ?.map((credit: any) => credit.name || credit.artist?.name)
                    .filter(Boolean)
                    .join(", ") || "Unknown Artist",
            score:
                typeof rg.score === "number" ?
                    rg.score
                :   Number.parseInt(rg.score || "0", 10),
        }));

        res.json({ albums });
    } catch (error: any) {
        logger.error("MusicBrainz release-group search error:", error);
        res.status(500).json({
            error: error?.message || "Search failed",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/failures:
 *   get:
 *     summary: Get all enrichment failures with filtering
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: entityType
 *         schema:
 *           type: string
 *           enum: [artist, track, audio, vibe]
 *         description: Filter by entity type
 *       - in: query
 *         name: includeSkipped
 *         schema:
 *           type: string
 *           enum: ["true", "false"]
 *         description: Include skipped failures
 *       - in: query
 *         name: includeResolved
 *         schema:
 *           type: string
 *           enum: ["true", "false"]
 *         description: Include resolved failures
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of enrichment failures
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /enrichment/failures
 * Get all enrichment failures with filtering
 */
router.get("/failures", async (req, res) => {
    try {
        const { entityType, includeSkipped, includeResolved, limit, offset } =
            req.query;

        const options: any = {};
        if (entityType) options.entityType = entityType as string;
        if (includeSkipped === "true") options.includeSkipped = true;
        if (includeResolved === "true") options.includeResolved = true;
        if (limit) options.limit = parseInt(limit as string);
        if (offset) options.offset = parseInt(offset as string);

        const result = await enrichmentFailureService.getFailures(options);
        res.json(result);
    } catch (error) {
        logger.error("Get failures error:", error);
        res.status(500).json({ error: "Failed to get failures" });
    }
});

/**
 * @openapi
 * /api/enrichment/failures/counts:
 *   get:
 *     summary: Get enrichment failure counts by type
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Failure counts grouped by entity type
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /enrichment/failures/counts
 * Get failure counts by type
 */
router.get("/failures/counts", async (req, res) => {
    try {
        const counts = await enrichmentFailureService.getFailureCounts();
        res.json(counts);
    } catch (error) {
        logger.error("Get failure counts error:", error);
        res.status(500).json({ error: "Failed to get failure counts" });
    }
});

/**
 * @openapi
 * /api/enrichment/retry:
 *   post:
 *     summary: Retry specific failed enrichment items
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of failure record IDs to retry
 *     responses:
 *       200:
 *         description: Items queued for retry
 *       400:
 *         description: Must provide array of failure IDs
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * POST /enrichment/retry
 * Retry specific failed items
 */
router.post("/retry", requireAdmin, async (req, res) => {
    try {
        const { ids } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res
                .status(400)
                .json({ error: "Must provide array of failure IDs" });
        }

        // Reset retry count for these failures
        await enrichmentFailureService.resetRetryCount(ids);

        // Get the failures to determine what to retry
        const failures = await Promise.all(
            ids.map((id) => enrichmentFailureService.getFailure(id))
        );

        // Group by type and trigger appropriate re-enrichment
        const { prisma } = await import("../utils/db");
        let queued = 0;
        let skipped = 0;

        for (const failure of failures) {
            if (!failure) continue;

            try {
                if (failure.entityType === "artist") {
                    // Check if artist still exists
                    const artist = await prisma.artist.findUnique({
                        where: { id: failure.entityId },
                        select: { id: true },
                    });

                    if (!artist) {
                        // Entity was deleted - mark failure as resolved
                        await enrichmentFailureService.resolveFailures([
                            failure.id,
                        ]);
                        skipped++;
                        continue;
                    }

                    // Reset artist enrichment status
                    await prisma.artist.update({
                        where: { id: failure.entityId },
                        data: { enrichmentStatus: "pending" },
                    });
                    queued++;
                } else if (failure.entityType === "track") {
                    // Check if track still exists
                    const track = await prisma.track.findUnique({
                        where: { id: failure.entityId },
                        select: { id: true },
                    });

                    if (!track) {
                        // Entity was deleted - mark failure as resolved
                        await enrichmentFailureService.resolveFailures([
                            failure.id,
                        ]);
                        skipped++;
                        continue;
                    }

                    // Reset track tag status
                    await prisma.track.update({
                        where: { id: failure.entityId },
                        data: { lastfmTags: [] },
                    });
                    queued++;
                } else if (failure.entityType === "audio") {
                    // Check if track still exists
                    const track = await prisma.track.findUnique({
                        where: { id: failure.entityId },
                        select: { id: true },
                    });

                    if (!track) {
                        // Entity was deleted - mark failure as resolved
                        await enrichmentFailureService.resolveFailures([
                            failure.id,
                        ]);
                        skipped++;
                        continue;
                    }

                    // Reset audio analysis status
                    await prisma.track.update({
                        where: { id: failure.entityId },
                        data: {
                            analysisStatus: "pending",
                            analysisRetryCount: 0,
                        },
                    });
                    queued++;
                }
            } catch (error) {
                logger.error(
                    `Failed to reset ${failure.entityType} ${failure.entityId}:`,
                    error
                );
                // Don't re-throw - continue processing other failures
            }
        }

        res.json({
            message: `Queued ${queued} items for retry, ${skipped} skipped (entities no longer exist)`,
            queued,
            skipped,
        });
    } catch (error: any) {
        logger.error("Retry failures error:", error);
        res.status(500).json({
            error: error.message || "Failed to retry failures",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/skip:
 *   post:
 *     summary: Skip specific enrichment failures
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of failure record IDs to skip
 *     responses:
 *       200:
 *         description: Failures marked as skipped
 *       400:
 *         description: Must provide array of failure IDs
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * POST /enrichment/skip
 * Skip specific failures (won't retry automatically)
 */
router.post("/skip", requireAdmin, async (req, res) => {
    try {
        const { ids } = req.body;

        if (!ids || !Array.isArray(ids) || ids.length === 0) {
            return res
                .status(400)
                .json({ error: "Must provide array of failure IDs" });
        }

        const count = await enrichmentFailureService.skipFailures(ids);
        res.json({
            message: `Skipped ${count} failures`,
            count,
        });
    } catch (error: any) {
        logger.error("Skip failures error:", error);
        res.status(500).json({
            error: error.message || "Failed to skip failures",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/failures:
 *   delete:
 *     summary: Clear all unresolved enrichment failures
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: entityType
 *         schema:
 *           type: string
 *           enum: [artist, track, audio]
 *         description: Optional filter to clear failures of a specific type only
 *     responses:
 *       200:
 *         description: Failures cleared
 *       400:
 *         description: Invalid entityType
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * DELETE /enrichment/failures
 * Clear all unresolved failures (optionally filtered by type)
 */
router.delete("/failures", requireAdmin, async (req, res) => {
    try {
        const entityType = req.query.entityType as "artist" | "track" | "audio" | undefined;

        if (entityType && !["artist", "track", "audio"].includes(entityType)) {
            return res.status(400).json({ error: "Invalid entityType" });
        }

        const count = await enrichmentFailureService.clearAllFailures(entityType);

        res.json({
            message: `Cleared ${count} failure${count !== 1 ? "s" : ""}`,
            count,
        });
    } catch (error: any) {
        logger.error("Clear all failures error:", error);
        res.status(500).json({
            error: error.message || "Failed to clear failures",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/failures/{id}:
 *   delete:
 *     summary: Delete a specific enrichment failure record
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The failure record ID
 *     responses:
 *       200:
 *         description: Failure deleted
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * DELETE /enrichment/failures/:id
 * Delete a specific failure record
 */
router.delete("/failures/:id", requireAdmin, async (req, res) => {
    try {
        const count = await enrichmentFailureService.deleteFailures([
            req.params.id,
        ]);
        res.json({
            message: "Failure deleted",
            count,
        });
    } catch (error: any) {
        logger.error("Delete failure error:", error);
        res.status(500).json({
            error: error.message || "Failed to delete failure",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/artists/{id}/metadata:
 *   put:
 *     summary: Update artist metadata manually (non-destructive overrides)
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The artist ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               bio:
 *                 type: string
 *               genres:
 *                 type: array
 *                 items:
 *                   type: string
 *               heroUrl:
 *                 type: string
 *               mbid:
 *                 type: string
 *                 description: MusicBrainz artist ID (UUID format)
 *     responses:
 *       200:
 *         description: Updated artist with override metadata
 *       400:
 *         description: Invalid MusicBrainz ID format
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Artist not found
 *       409:
 *         description: MusicBrainz ID conflict with another artist
 */
/**
 * PUT /enrichment/artists/:id/metadata
 * Update artist metadata manually (non-destructive overrides)
 * User edits are stored as overrides; canonical data preserved for API lookups
 */
router.put("/artists/:id/metadata", async (req, res) => {
    try {
        const { name, bio, genres, heroUrl, mbid } = req.body;

        const updateData: any = {};
        let hasOverrides = false;

        // Map user edits to override fields (non-destructive)
        if (name !== undefined) {
            updateData.displayName = name;
            hasOverrides = true;
        }
        if (bio !== undefined) {
            updateData.userSummary = bio;
            hasOverrides = true;
        }
        if (heroUrl !== undefined) {
            updateData.userHeroUrl = heroUrl;
            hasOverrides = true;
        }
        if (genres !== undefined) {
            updateData.userGenres = genres;
            hasOverrides = true;
        }
        const { prisma } = await import("../utils/db");

        // MBID changes are canonical-link corrections (not override fields).
        if (mbid !== undefined) {
            if (typeof mbid !== "string") {
                return res.status(400).json({
                    error: "Invalid MusicBrainz ID format",
                    code: "INVALID_MBID_FORMAT",
                    field: "mbid",
                    expectedFormat: MBID_FORMAT_EXAMPLE,
                });
            }

            const normalizedMbid = mbid.trim();
            if (normalizedMbid) {
                // Only validate strict UUID format when the value is actually being changed.
                // Existing temporary MBIDs should not block unrelated override edits.
                const existingArtist = await prisma.artist.findUnique({
                    where: { id: req.params.id },
                    select: { mbid: true },
                });

                if (!existingArtist) {
                    return res.status(404).json({
                        error: "Artist not found",
                        message: "The artist may have been deleted",
                    });
                }

                if (
                    existingArtist.mbid !== normalizedMbid &&
                    !isValidMusicBrainzId(normalizedMbid)
                ) {
                    return res.status(400).json({
                        error: "Invalid MusicBrainz ID format",
                        code: "INVALID_MBID_FORMAT",
                        field: "mbid",
                        expectedFormat: MBID_FORMAT_EXAMPLE,
                    });
                }

                if (existingArtist.mbid !== normalizedMbid) {
                    const conflictingArtist = await prisma.artist.findFirst({
                        where: {
                            mbid: normalizedMbid,
                            id: { not: req.params.id },
                        },
                        select: { id: true },
                    });

                    if (conflictingArtist) {
                        return res.status(409).json({
                            error: "MusicBrainz ID is already used by another artist",
                            code: "MBID_CONFLICT",
                            field: "mbid",
                            hint: "Use MusicBrainz lookup to pick the correct artist MBID",
                        });
                    }

                    updateData.mbid = normalizedMbid;
                }
            }
        }

        // Set override flag
        if (hasOverrides) {
            updateData.hasUserOverrides = true;
        }

        const artist = await prisma.artist.update({
            where: { id: req.params.id },
            data: updateData,
            include: {
                albums: {
                    select: {
                        id: true,
                        title: true,
                        year: true,
                        coverUrl: true,
                    },
                },
            },
        });

        // Invalidate Redis cache for artist hero image
        try {
            await redisClient.del(`hero:${req.params.id}`);
        } catch (err) {
            logger.warn("Failed to invalidate Redis cache:", err);
        }

        res.json(artist);
    } catch (error: any) {
        if (error?.code === "P2002") {
            return res.status(409).json({
                error: "MusicBrainz ID is already used by another artist",
                code: "MBID_CONFLICT",
                field: "mbid",
                hint: "Use MusicBrainz lookup to pick the correct artist MBID",
            });
        }
        logger.error("Update artist metadata error:", error);
        res.status(500).json({
            error: error.message || "Failed to update artist",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/albums/{id}/metadata:
 *   put:
 *     summary: Update album metadata manually (non-destructive overrides)
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The album ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               year:
 *                 type: integer
 *               genres:
 *                 type: array
 *                 items:
 *                   type: string
 *               coverUrl:
 *                 type: string
 *               rgMbid:
 *                 type: string
 *                 description: MusicBrainz release-group ID (UUID format)
 *     responses:
 *       200:
 *         description: Updated album with override metadata
 *       400:
 *         description: Invalid release-group MBID format
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Album not found
 *       409:
 *         description: Release-group MBID conflict with another album
 */
/**
 * PUT /enrichment/albums/:id/metadata
 * Update album metadata manually (non-destructive overrides)
 * User edits are stored as overrides; canonical data preserved for API lookups
 */
router.put("/albums/:id/metadata", async (req, res) => {
    try {
        const { title, year, genres, coverUrl, rgMbid } = req.body;

        const updateData: any = {};
        let hasOverrides = false;

        // Map user edits to override fields (non-destructive)
        if (title !== undefined) {
            updateData.displayTitle = title;
            hasOverrides = true;
        }
        if (year !== undefined) {
            updateData.displayYear = parseInt(year);
            hasOverrides = true;
        }
        if (coverUrl !== undefined) {
            updateData.userCoverUrl = coverUrl;
            hasOverrides = true;
        }
        if (genres !== undefined) {
            updateData.userGenres = genres;
            hasOverrides = true;
        }
        const normalizedRgMbid =
            typeof rgMbid === "string" && rgMbid.trim() ? rgMbid.trim() : null;
        if (normalizedRgMbid) {
            updateData.rgMbid = normalizedRgMbid;
        }

        // Set override flag
        if (hasOverrides) {
            updateData.hasUserOverrides = true;
        }

        const { prisma } = await import("../utils/db");

        if (normalizedRgMbid) {
            const existingAlbum = await prisma.album.findUnique({
                where: { id: req.params.id },
                select: { artistId: true, rgMbid: true, location: true },
            });

            if (!existingAlbum) {
                return res.status(404).json({
                    error: "Album not found",
                    message: "The album may have been deleted",
                });
            }

            if (existingAlbum.rgMbid !== normalizedRgMbid) {
                if (!isValidMusicBrainzId(normalizedRgMbid)) {
                    return res.status(400).json({
                        error: "Invalid release-group MBID format",
                        code: "INVALID_RG_MBID_FORMAT",
                        field: "rgMbid",
                        expectedFormat: MBID_FORMAT_EXAMPLE,
                    });
                }

                const conflictingAlbum = await prisma.album.findFirst({
                    where: {
                        rgMbid: normalizedRgMbid,
                        id: { not: req.params.id },
                    },
                    select: { id: true },
                });

                if (conflictingAlbum) {
                    return res.status(409).json({
                        error: "Release-group MBID is already used by another album",
                        code: "RG_MBID_CONFLICT",
                        field: "rgMbid",
                        hint: "Use MusicBrainz lookup to pick the correct release-group MBID",
                    });
                }

                if (existingAlbum.location === "LIBRARY") {
                    await prisma.ownedAlbum.deleteMany({
                        where: {
                            artistId: existingAlbum.artistId,
                            rgMbid: existingAlbum.rgMbid,
                        },
                    });

                    await prisma.ownedAlbum.upsert({
                        where: {
                            artistId_rgMbid: {
                                artistId: existingAlbum.artistId,
                                rgMbid: normalizedRgMbid,
                            },
                        },
                        create: {
                            artistId: existingAlbum.artistId,
                            rgMbid: normalizedRgMbid,
                            source: "metadata_edit",
                        },
                        update: {},
                    });
                }
            }
        }

        const album = await prisma.album.update({
            where: { id: req.params.id },
            data: updateData,
            include: {
                artist: {
                    select: {
                        id: true,
                        name: true,
                    },
                },
                tracks: {
                    select: {
                        id: true,
                        title: true,
                        trackNo: true,
                        duration: true,
                    },
                },
            },
        });

        res.json(album);
    } catch (error: any) {
        if (error?.code === "P2002") {
            return res.status(409).json({
                error: "Release-group MBID is already used by another album",
                code: "RG_MBID_CONFLICT",
                field: "rgMbid",
                hint: "Use MusicBrainz lookup to pick the correct release-group MBID",
            });
        }
        logger.error("Update album metadata error:", error);
        res.status(500).json({
            error: error.message || "Failed to update album",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/tracks/{id}/metadata:
 *   put:
 *     summary: Update track metadata manually (non-destructive overrides)
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The track ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               trackNo:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Updated track with override metadata
 *       401:
 *         description: Not authenticated
 */
/**
 * PUT /enrichment/tracks/:id/metadata
 * Update track metadata manually (non-destructive overrides)
 * User edits are stored as overrides; canonical data preserved
 */
router.put("/tracks/:id/metadata", async (req, res) => {
    try {
        const { title, trackNo } = req.body;

        const updateData: any = {};
        let hasOverrides = false;

        // Map user edits to override fields (non-destructive)
        if (title !== undefined) {
            updateData.displayTitle = title;
            hasOverrides = true;
        }
        if (trackNo !== undefined) {
            updateData.displayTrackNo = parseInt(trackNo);
            hasOverrides = true;
        }

        // Set override flag
        if (hasOverrides) {
            updateData.hasUserOverrides = true;
        }

        const { prisma } = await import("../utils/db");
        const track = await prisma.track.update({
            where: { id: req.params.id },
            data: updateData,
            include: {
                album: {
                    select: {
                        id: true,
                        title: true,
                        artist: {
                            select: {
                                id: true,
                                name: true,
                            },
                        },
                    },
                },
            },
        });

        res.json(track);
    } catch (error: any) {
        logger.error("Update track metadata error:", error);
        res.status(500).json({
            error: error.message || "Failed to update track",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/artists/{id}/reset:
 *   post:
 *     summary: Reset artist metadata to canonical values
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The artist ID
 *     responses:
 *       200:
 *         description: Artist metadata reset to original values
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Artist not found
 */
/**
 * POST /enrichment/artists/:id/reset
 * Reset artist metadata to canonical values (clear all user overrides)
 */
router.post("/artists/:id/reset", async (req, res) => {
    try {
        const { prisma } = await import("../utils/db");

        // Check if artist exists first
        const existingArtist = await prisma.artist.findUnique({
            where: { id: req.params.id },
            select: { id: true },
        });

        if (!existingArtist) {
            return res.status(404).json({
                error: "Artist not found",
                message: "The artist may have been deleted",
            });
        }

        const artist = await prisma.artist.update({
            where: { id: req.params.id },
            data: {
                displayName: null,
                userSummary: null,
                userHeroUrl: null,
                userGenres: [],
                hasUserOverrides: false,
            },
            include: {
                albums: {
                    select: {
                        id: true,
                        title: true,
                        year: true,
                        coverUrl: true,
                    },
                },
            },
        });

        // Invalidate Redis cache for artist hero image
        try {
            await redisClient.del(`hero:${req.params.id}`);
        } catch (err) {
            logger.warn("Failed to invalidate Redis cache:", err);
        }

        res.json({
            message: "Artist metadata reset to original values",
            artist,
        });
    } catch (error: any) {
        // Handle P2025 specifically in case of race condition
        if (error.code === "P2025") {
            return res.status(404).json({
                error: "Artist not found",
                message: "The artist may have been deleted",
            });
        }
        logger.error("Reset artist metadata error:", error);
        res.status(500).json({
            error: error.message || "Failed to reset artist metadata",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/albums/{id}/reset:
 *   post:
 *     summary: Reset album metadata to canonical values
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The album ID
 *     responses:
 *       200:
 *         description: Album metadata reset to original values
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Album not found
 */
/**
 * POST /enrichment/albums/:id/reset
 * Reset album metadata to canonical values (clear all user overrides)
 */
router.post("/albums/:id/reset", async (req, res) => {
    try {
        const { prisma } = await import("../utils/db");

        // Check if album exists first
        const existingAlbum = await prisma.album.findUnique({
            where: { id: req.params.id },
            select: { id: true },
        });

        if (!existingAlbum) {
            return res.status(404).json({
                error: "Album not found",
                message: "The album may have been deleted",
            });
        }

        const album = await prisma.album.update({
            where: { id: req.params.id },
            data: {
                displayTitle: null,
                displayYear: null,
                userCoverUrl: null,
                userGenres: [],
                hasUserOverrides: false,
            },
            include: {
                artist: {
                    select: {
                        id: true,
                        name: true,
                    },
                },
                tracks: {
                    select: {
                        id: true,
                        title: true,
                        trackNo: true,
                        duration: true,
                    },
                },
            },
        });

        res.json({
            message: "Album metadata reset to original values",
            album,
        });
    } catch (error: any) {
        // Handle P2025 specifically in case of race condition
        if (error.code === "P2025") {
            return res.status(404).json({
                error: "Album not found",
                message: "The album may have been deleted",
            });
        }
        logger.error("Reset album metadata error:", error);
        res.status(500).json({
            error: error.message || "Failed to reset album metadata",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/tracks/{id}/reset:
 *   post:
 *     summary: Reset track metadata to canonical values
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The track ID
 *     responses:
 *       200:
 *         description: Track metadata reset to original values
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: Track not found
 */
/**
 * POST /enrichment/tracks/:id/reset
 * Reset track metadata to canonical values (clear all user overrides)
 */
router.post("/tracks/:id/reset", async (req, res) => {
    try {
        const { prisma } = await import("../utils/db");

        // Check if track exists first
        const existingTrack = await prisma.track.findUnique({
            where: { id: req.params.id },
            select: { id: true },
        });

        if (!existingTrack) {
            return res.status(404).json({
                error: "Track not found",
                message: "The track may have been deleted",
            });
        }

        const track = await prisma.track.update({
            where: { id: req.params.id },
            data: {
                displayTitle: null,
                displayTrackNo: null,
                hasUserOverrides: false,
            },
            include: {
                album: {
                    select: {
                        id: true,
                        title: true,
                        artist: {
                            select: {
                                id: true,
                                name: true,
                            },
                        },
                    },
                },
            },
        });

        res.json({
            message: "Track metadata reset to original values",
            track,
        });
    } catch (error: any) {
        // Handle P2025 specifically in case of race condition
        if (error.code === "P2025") {
            return res.status(404).json({
                error: "Track not found",
                message: "The track may have been deleted",
            });
        }
        logger.error("Reset track metadata error:", error);
        res.status(500).json({
            error: error.message || "Failed to reset track metadata",
        });
    }
});

/**
 * @openapi
 * /api/enrichment/concurrency:
 *   get:
 *     summary: Get enrichment concurrency configuration
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Current concurrency setting and estimated processing speeds
 *       401:
 *         description: Not authenticated
 */
/**
 * GET /enrichment/concurrency
 * Get current enrichment concurrency configuration
 */
router.get("/concurrency", async (req, res) => {
    try {
        const settings = await getSystemSettings();
        const concurrency = settings?.enrichmentConcurrency || 1;

        // Calculate estimated speeds based on concurrency
        const artistsPerMin = Math.round(10 * concurrency);
        const tracksPerMin = Math.round(60 * concurrency);

        res.json({
            concurrency,
            estimatedSpeed: `~${artistsPerMin} artists/min, ~${tracksPerMin} tracks/min`,
            artistsPerMin,
            tracksPerMin,
        });
    } catch (error) {
        logger.error("Failed to get enrichment settings:", error);
        res.status(500).json({ error: "Failed to get enrichment settings" });
    }
});

/**
 * @openapi
 * /api/enrichment/concurrency:
 *   put:
 *     summary: Update enrichment concurrency configuration
 *     tags: [Enrichment]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [concurrency]
 *             properties:
 *               concurrency:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 5
 *     responses:
 *       200:
 *         description: Concurrency updated with estimated processing speeds
 *       400:
 *         description: Missing or invalid concurrency parameter
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * PUT /enrichment/concurrency
 * Update enrichment concurrency configuration
 */
router.put("/concurrency", requireAdmin, async (req, res) => {
    try {
        const { concurrency } = req.body;

        if (!concurrency || typeof concurrency !== "number") {
            return res
                .status(400)
                .json({ error: "Missing or invalid 'concurrency' parameter" });
        }

        // Clamp concurrency to 1-5
        const clampedConcurrency = Math.max(
            1,
            Math.min(5, Math.floor(concurrency))
        );

        // Update system settings in database
        const { prisma } = await import("../utils/db");
        await prisma.systemSettings.upsert({
            where: { id: "default" },
            create: {
                id: "default",
                enrichmentConcurrency: clampedConcurrency,
            },
            update: {
                enrichmentConcurrency: clampedConcurrency,
            },
        });

        // Invalidate cache so next read gets fresh value
        invalidateSystemSettingsCache();

        // Update rate limiter concurrency multiplier
        rateLimiter.updateConcurrencyMultiplier(clampedConcurrency);

        // Calculate estimated speeds
        const artistsPerMin = Math.round(10 * clampedConcurrency);
        const tracksPerMin = Math.round(60 * clampedConcurrency);

        logger.debug(
            `[Enrichment Settings] Updated concurrency to ${clampedConcurrency}`
        );

        res.json({
            concurrency: clampedConcurrency,
            estimatedSpeed: `~${artistsPerMin} artists/min, ~${tracksPerMin} tracks/min`,
            artistsPerMin,
            tracksPerMin,
        });
    } catch (error) {
        logger.error("Failed to update enrichment settings:", error);
        res.status(500).json({ error: "Failed to update enrichment settings" });
    }
});

export default router;
