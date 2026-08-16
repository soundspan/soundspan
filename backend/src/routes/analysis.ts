import { Router } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { getSystemSettings } from "../utils/systemSettings";
import { enrichmentFailureService } from "../services/enrichmentFailureService";
import {
    countEmbeddedLocalTracks,
    missingActiveEmbeddingWhere,
} from "../services/trackEmbeddings";
import { getActiveSpace } from "../services/embeddingSpaces";
import analysisInternalRoutes from "./analysisInternal";
import os from "os";
import {
    LOCAL_TRACK_WHERE,
    TRACK_VISIBLE_WHERE,
} from "../utils/librarySorting";

const router = Router();

// Redis queue key for audio analysis
const ANALYSIS_QUEUE = "audio:analysis:queue";
const VIBE_QUEUE = "audio:clap:queue";

function buildVibePendingReset() {
    return {
        vibeAnalysisStatus: "pending" as const,
        vibeAnalysisError: null,
        vibeAnalysisStartedAt: null,
        vibeAnalysisStatusUpdatedAt: new Date(),
    };
}

/**
 * @openapi
 * /api/analysis/status:
 *   get:
 *     summary: Get audio analysis status and progress
 *     tags: [Analysis]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Analysis status with counts by state, queue length, and CLAP embedding progress
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * GET /api/analysis/status
 * Get audio analysis status and progress
 */
router.get("/status", requireAuth, async (req, res) => {
    try {
        // Get counts by status
        const statusCounts = await prisma.track.groupBy({
            by: ["analysisStatus"],
            where: { ...TRACK_VISIBLE_WHERE, ...LOCAL_TRACK_WHERE },
            _count: true,
        });

        const total = statusCounts.reduce((sum, s) => sum + s._count, 0);
        const completed =
            statusCounts.find((s) => s.analysisStatus === "completed")
                ?._count || 0;
        const failed =
            statusCounts.find((s) => s.analysisStatus === "failed")?._count ||
            0;
        const processing =
            statusCounts.find((s) => s.analysisStatus === "processing")
                ?._count || 0;
        const pending =
            statusCounts.find((s) => s.analysisStatus === "pending")?._count ||
            0;

        // Get queue length from Redis
        const queueLength = await redisClient.lLen(ANALYSIS_QUEUE);

        // Get CLAP embedding count
        const withEmbeddings = await countEmbeddedLocalTracks();

        const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

        res.json({
            total,
            completed,
            failed,
            processing,
            pending,
            queueLength,
            progress,
            isComplete: pending === 0 && processing === 0 && queueLength === 0,
            clap: {
                withEmbeddings,
                embeddingProgress:
                    total > 0 ? Math.round((withEmbeddings / total) * 100) : 0,
            },
        });
    } catch (error: any) {
        logger.error("Analysis status error:", error);
        res.status(500).json({ error: "Failed to get analysis status" });
    }
});

/**
 * @openapi
 * /api/analysis/start:
 *   post:
 *     summary: Start audio analysis for pending tracks
 *     tags: [Analysis]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               limit:
 *                 type: integer
 *                 default: 100
 *               priority:
 *                 type: string
 *                 enum: [recent, alphabetical]
 *                 default: recent
 *     responses:
 *       200:
 *         description: Tracks queued for analysis
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * POST /api/analysis/start
 * Start audio analysis for pending tracks (admin only)
 */
router.post("/start", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { limit = 100, priority = "recent" } = req.body;

        // Find pending tracks
        const tracks = await prisma.track.findMany({
            where: {
                analysisStatus: "pending",
                ...TRACK_VISIBLE_WHERE,
                ...LOCAL_TRACK_WHERE,
            },
            select: {
                id: true,
                filePath: true,
                duration: true,
            },
            orderBy:
                priority === "recent"
                    ? { fileModified: "desc" }
                    : { title: "asc" },
            take: Math.min(limit, 1000),
        });

        if (tracks.length === 0) {
            return res.json({
                message: "No pending tracks to analyze",
                queued: 0,
            });
        }

        // Queue tracks for analysis
        const pipeline = redisClient.multi();
        for (const track of tracks) {
            pipeline.rPush(
                ANALYSIS_QUEUE,
                JSON.stringify({
                    trackId: track.id,
                    filePath: track.filePath,
                    duration: track.duration,
                }),
            );
        }
        await pipeline.exec();

        logger.debug(`Queued ${tracks.length} tracks for audio analysis`);

        res.json({
            message: `Queued ${tracks.length} tracks for analysis`,
            queued: tracks.length,
        });
    } catch (error: any) {
        logger.error("Analysis start error:", error);
        res.status(500).json({ error: "Failed to start analysis" });
    }
});

/**
 * @openapi
 * /api/analysis/retry-failed:
 *   post:
 *     summary: Retry all failed audio analysis jobs
 *     tags: [Analysis]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Failed tracks reset to pending
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * POST /api/analysis/retry-failed
 * Retry failed analysis jobs (admin only)
 */
router.post("/retry-failed", requireAuth, requireAdmin, async (req, res) => {
    try {
        // Reset failed tracks to pending
        const result = await prisma.track.updateMany({
            where: {
                analysisStatus: "failed",
                ...LOCAL_TRACK_WHERE,
            },
            data: {
                analysisStatus: "pending",
                analysisError: null,
                analysisRetryCount: 0,
                analysisStartedAt: null,
            },
        });

        res.json({
            message: `Reset ${result.count} failed tracks to pending`,
            reset: result.count,
        });
    } catch (error: any) {
        logger.error("Retry failed error:", error);
        res.status(500).json({ error: "Failed to retry analysis" });
    }
});

/**
 * @openapi
 * /api/analysis/analyze/{trackId}:
 *   post:
 *     summary: Queue a specific track for audio analysis
 *     tags: [Analysis]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: trackId
 *         required: true
 *         schema:
 *           type: string
 *         description: The track ID to analyze
 *     responses:
 *       200:
 *         description: Track queued for analysis
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Track not found
 */
/**
 * POST /api/analysis/analyze/:trackId
 * Queue a specific track for analysis
 */
router.post<{ trackId: string }>(
    "/analyze/:trackId",
    requireAuth,
    requireAdmin,
    async (req, res) => {
        try {
            const { trackId } = req.params;

            const track = await prisma.track.findFirst({
                where: {
                    id: trackId,
                    ...TRACK_VISIBLE_WHERE,
                    ...LOCAL_TRACK_WHERE,
                },
                select: {
                    id: true,
                    filePath: true,
                    duration: true,
                    analysisStatus: true,
                },
            });

            if (!track) {
                return res.status(404).json({ error: "Track not found" });
            }

            // Queue for analysis
            await redisClient.rPush(
                ANALYSIS_QUEUE,
                JSON.stringify({
                    trackId: track.id,
                    filePath: track.filePath,
                    duration: track.duration,
                }),
            );

            // Mark as pending if not already
            if (track.analysisStatus !== "processing") {
                await prisma.track.update({
                    where: { id: trackId },
                    data: { analysisStatus: "pending" },
                });
            }

            res.json({
                message: "Track queued for analysis",
                trackId,
            });
        } catch (error: any) {
            logger.error("Analyze track error:", error);
            res.status(500).json({
                error: "Failed to queue track for analysis",
            });
        }
    },
);

/**
 * @openapi
 * /api/analysis/track/{trackId}:
 *   get:
 *     summary: Get analysis data for a specific track
 *     tags: [Analysis]
 *     security:
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: trackId
 *         required: true
 *         schema:
 *           type: string
 *         description: The track ID
 *     responses:
 *       200:
 *         description: Track analysis data including BPM, key, energy, mood predictions, and genre tags
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 *       404:
 *         description: Track not found
 */
/**
 * GET /api/analysis/track/:trackId
 * Get analysis data for a specific track
 */
router.get<{ trackId: string }>(
    "/track/:trackId",
    requireAuth,
    async (req, res) => {
        try {
            const { trackId } = req.params;

            const track = await prisma.track.findFirst({
                where: {
                    id: trackId,
                    ...TRACK_VISIBLE_WHERE,
                    ...LOCAL_TRACK_WHERE,
                },
                select: {
                    id: true,
                    title: true,
                    analysisStatus: true,
                    analyzedAt: true,
                    analysisVersion: true,
                    analysisMode: true,
                    bpm: true,
                    beatsCount: true,
                    key: true,
                    keyScale: true,
                    keyStrength: true,
                    energy: true,
                    loudness: true,
                    dynamicRange: true,
                    danceability: true,
                    valence: true,
                    arousal: true,
                    instrumentalness: true,
                    acousticness: true,
                    speechiness: true,
                    // MusiCNN mood predictions
                    moodHappy: true,
                    moodSad: true,
                    moodRelaxed: true,
                    moodAggressive: true,
                    moodParty: true,
                    moodAcoustic: true,
                    moodElectronic: true,
                    moodTags: true,
                    essentiaGenres: true,
                    lastfmTags: true,
                },
            });

            if (!track) {
                return res.status(404).json({ error: "Track not found" });
            }

            res.json(track);
        } catch (error: any) {
            logger.error("Get track analysis error:", error);
            res.status(500).json({ error: "Failed to get track analysis" });
        }
    },
);

/**
 * @openapi
 * /api/analysis/features:
 *   get:
 *     summary: Get aggregated audio feature statistics for the library
 *     tags: [Analysis]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Aggregated statistics including average BPM, energy, danceability, valence, and distributions
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * GET /api/analysis/features
 * Get aggregated feature statistics for the library
 */
router.get("/features", requireAuth, async (req, res) => {
    try {
        // Get analyzed tracks
        const analyzed = await prisma.track.findMany({
            where: {
                ...TRACK_VISIBLE_WHERE,
                ...LOCAL_TRACK_WHERE,
                analysisStatus: "completed",
                bpm: { not: null },
            },
            select: {
                bpm: true,
                energy: true,
                danceability: true,
                valence: true,
                keyScale: true,
            },
        });

        if (analyzed.length === 0) {
            return res.json({
                count: 0,
                averages: null,
                distributions: null,
            });
        }

        // Calculate averages
        const avgBpm =
            analyzed.reduce((sum, t) => sum + (t.bpm || 0), 0) /
            analyzed.length;
        const avgEnergy =
            analyzed.reduce((sum, t) => sum + (t.energy || 0), 0) /
            analyzed.length;
        const avgDanceability =
            analyzed.reduce((sum, t) => sum + (t.danceability || 0), 0) /
            analyzed.length;
        const avgValence =
            analyzed.reduce((sum, t) => sum + (t.valence || 0), 0) /
            analyzed.length;

        // Key distribution
        const majorCount = analyzed.filter(
            (t) => t.keyScale === "major",
        ).length;
        const minorCount = analyzed.filter(
            (t) => t.keyScale === "minor",
        ).length;

        // BPM distribution (buckets)
        const bpmBuckets = {
            slow: analyzed.filter((t) => (t.bpm || 0) < 90).length,
            moderate: analyzed.filter(
                (t) => (t.bpm || 0) >= 90 && (t.bpm || 0) < 120,
            ).length,
            upbeat: analyzed.filter(
                (t) => (t.bpm || 0) >= 120 && (t.bpm || 0) < 150,
            ).length,
            fast: analyzed.filter((t) => (t.bpm || 0) >= 150).length,
        };

        res.json({
            count: analyzed.length,
            averages: {
                bpm: Math.round(avgBpm),
                energy: Math.round(avgEnergy * 100) / 100,
                danceability: Math.round(avgDanceability * 100) / 100,
                valence: Math.round(avgValence * 100) / 100,
            },
            distributions: {
                key: { major: majorCount, minor: minorCount },
                bpm: bpmBuckets,
            },
        });
    } catch (error: any) {
        logger.error("Get features error:", error);
        res.status(500).json({ error: "Failed to get feature statistics" });
    }
});

/**
 * @openapi
 * /api/analysis/workers:
 *   get:
 *     summary: Get audio analyzer worker configuration
 *     tags: [Analysis]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Current worker count, CPU cores, and recommended configuration
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * GET /api/analysis/workers
 * Get current audio analyzer worker configuration
 */
router.get("/workers", requireAuth, requireAdmin, async (req, res) => {
    try {
        const settings = await getSystemSettings();
        const cpuCores = os.cpus().length;
        const currentWorkers = settings?.audioAnalyzerWorkers || 2;

        // Recommended: 50% of CPU cores, min 2, max 8
        const recommended = Math.max(2, Math.min(8, Math.floor(cpuCores / 2)));

        res.json({
            workers: currentWorkers,
            cpuCores,
            recommended,
            description: `Using ${currentWorkers} of ${cpuCores} available CPU cores`,
        });
    } catch (error: any) {
        logger.error("Get workers config error:", error);
        res.status(500).json({ error: "Failed to get worker configuration" });
    }
});

/**
 * @openapi
 * /api/analysis/workers:
 *   put:
 *     summary: Update audio analyzer worker count
 *     tags: [Analysis]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workers]
 *             properties:
 *               workers:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 8
 *     responses:
 *       200:
 *         description: Worker count updated successfully
 *       400:
 *         description: Workers must be a number between 1 and 8
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * PUT /api/analysis/workers
 * Update audio analyzer worker count
 */
router.put("/workers", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { workers } = req.body;

        if (typeof workers !== "number" || workers < 1 || workers > 8) {
            return res.status(400).json({
                error: "Workers must be a number between 1 and 8",
            });
        }

        // Update SystemSettings
        await prisma.systemSettings.update({
            where: { id: "default" },
            data: { audioAnalyzerWorkers: workers },
        });

        // Publish control signal to Redis for Python worker to pick up
        await redisClient.publish(
            "audio:analysis:control",
            JSON.stringify({ command: "set_workers", count: workers }),
        );

        const cpuCores = os.cpus().length;
        const recommended = Math.max(2, Math.min(8, Math.floor(cpuCores / 2)));

        logger.info(`Audio analyzer workers updated to ${workers}`);

        res.json({
            workers,
            cpuCores,
            recommended,
            description: `Using ${workers} of ${cpuCores} available CPU cores`,
        });
    } catch (error: any) {
        logger.error("Update workers config error:", error);
        res.status(500).json({
            error: "Failed to update worker configuration",
        });
    }
});

/**
 * @openapi
 * /api/analysis/clap-workers:
 *   get:
 *     summary: Get CLAP analyzer worker configuration
 *     tags: [Analysis]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Current CLAP worker count, CPU cores, and recommended configuration
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * GET /api/analysis/clap-workers
 * Get current CLAP analyzer worker configuration
 */
router.get("/clap-workers", requireAuth, requireAdmin, async (req, res) => {
    try {
        const settings = await getSystemSettings();
        const cpuCores = os.cpus().length;
        const currentWorkers = settings?.clapWorkers || 2;

        const recommended = Math.max(1, Math.min(8, Math.floor(cpuCores / 2)));

        res.json({
            workers: currentWorkers,
            cpuCores,
            recommended,
            description: `Using ${currentWorkers} of ${cpuCores} available CPU cores`,
        });
    } catch (error: any) {
        logger.error("Get CLAP workers config error:", error);
        res.status(500).json({
            error: "Failed to get CLAP worker configuration",
        });
    }
});

/**
 * @openapi
 * /api/analysis/clap-workers:
 *   put:
 *     summary: Update CLAP analyzer worker count
 *     tags: [Analysis]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [workers]
 *             properties:
 *               workers:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 8
 *     responses:
 *       200:
 *         description: CLAP worker count updated successfully
 *       400:
 *         description: CLAP workers must be a number between 1 and 8
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * PUT /api/analysis/clap-workers
 * Update CLAP analyzer worker count
 */
router.put("/clap-workers", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { workers } = req.body;

        if (typeof workers !== "number" || workers < 1 || workers > 8) {
            return res.status(400).json({
                error: "CLAP workers must be a number between 1 and 8",
            });
        }

        // Update SystemSettings
        await prisma.systemSettings.update({
            where: { id: "default" },
            data: { clapWorkers: workers },
        });

        // Publish control signal to Redis for CLAP analyzer to pick up
        await redisClient.publish(
            "audio:clap:control",
            JSON.stringify({ command: "set_workers", count: workers }),
        );

        const cpuCores = os.cpus().length;
        const recommended = Math.max(1, Math.min(8, Math.floor(cpuCores / 2)));

        logger.info(`CLAP analyzer workers updated to ${workers}`);

        res.json({
            workers,
            cpuCores,
            recommended,
            description: `Using ${workers} of ${cpuCores} available CPU cores`,
        });
    } catch (error: any) {
        logger.error("Update CLAP workers config error:", error);
        res.status(500).json({
            error: "Failed to update CLAP worker configuration",
        });
    }
});

/**
 * @openapi
 * /api/analysis/vibe/start:
 *   post:
 *     summary: Queue tracks for vibe embedding generation
 *     tags: [Analysis]
 *     security:
 *       - apiKeyAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               limit:
 *                 type: integer
 *                 default: 500
 *               force:
 *                 type: boolean
 *                 default: false
 *                 description: If true, delete all existing embeddings and re-queue all tracks
 *     responses:
 *       200:
 *         description: Tracks queued for vibe embedding generation
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * POST /api/analysis/vibe/start
 * Queue tracks for vibe embedding generation (admin only)
 *
 * @param force - If true, delete all embeddings and re-queue all tracks
 */
router.post("/vibe/start", requireAuth, requireAdmin, async (req, res) => {
    try {
        const requestedLimit = Number(req.body.limit ?? 500);
        const limit =
            Number.isSafeInteger(requestedLimit) && requestedLimit > 0
                ? Math.min(requestedLimit, 1000)
                : 500;
        const force = req.body.force === true;
        const activeSpace = await getActiveSpace();

        // If force mode, delete all existing embeddings first
        if (force) {
            await prisma.trackEmbedding.deleteMany({
                where: {
                    spaceId: activeSpace.id,
                    track: LOCAL_TRACK_WHERE,
                },
            });
            await prisma.track.updateMany({
                where: LOCAL_TRACK_WHERE,
                data: {
                    ...buildVibePendingReset(),
                    vibeAnalysisRetryCount: 0,
                },
            });
            await enrichmentFailureService.clearAllFailures("vibe");
            logger.info("Cleared all vibe embeddings for re-generation");
        }

        // Find tracks without vibe embeddings (all tracks if force was used)
        const tracks = await prisma.track.findMany({
            where: {
                ...missingActiveEmbeddingWhere(activeSpace.id),
                ...TRACK_VISIBLE_WHERE,
                ...LOCAL_TRACK_WHERE,
            },
            select: {
                id: true,
                filePath: true,
                duration: true,
                title: true,
            },
            orderBy: { fileModified: "desc" },
            take: limit,
        });

        if (tracks.length === 0) {
            return res.json({
                message: "All tracks have vibe embeddings",
                queued: 0,
            });
        }

        // Align producer state with queue handoff: newly queued tracks should
        // be recoverable as pending if Redis is later drained or workers are down.
        if (!force) {
            await prisma.track.updateMany({
                where: { id: { in: tracks.map((track) => track.id) } },
                data: buildVibePendingReset(),
            });
        }

        // Queue tracks for CLAP embedding
        const pipeline = redisClient.multi();
        for (const track of tracks) {
            pipeline.rPush(
                VIBE_QUEUE,
                JSON.stringify({
                    trackId: track.id,
                    filePath: track.filePath,
                    duration: track.duration,
                }),
            );
        }
        await pipeline.exec();

        // Clear any existing vibe failures for these tracks
        for (const track of tracks) {
            await enrichmentFailureService.clearFailure("vibe", track.id);
        }

        logger.info(
            `Queued ${tracks.length} tracks for vibe embedding${force ? " (force reset)" : ""}`,
        );

        res.json({
            message: `Queued ${tracks.length} tracks for vibe embedding`,
            queued: tracks.length,
        });
    } catch (error: any) {
        logger.error("Start vibe embedding error:", error);
        res.status(500).json({ error: "Failed to start vibe embedding" });
    }
});

/**
 * @openapi
 * /api/analysis/vibe/retry:
 *   post:
 *     summary: Reset all failed vibe embeddings for bounded retry
 *     tags: [Analysis]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Failed tracks reset to pending for bounded background retry
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
/**
 * POST /api/analysis/vibe/retry
 * Retry failed vibe embeddings (admin only)
 */
router.post("/vibe/retry", requireAuth, requireAdmin, async (req, res) => {
    try {
        const result = await prisma.track.updateMany({
            where: {
                vibeAnalysisStatus: "failed",
                ...LOCAL_TRACK_WHERE,
            },
            data: {
                ...buildVibePendingReset(),
                vibeAnalysisRetryCount: 0,
            },
        });

        if (result.count === 0) {
            return res.json({
                message: "No vibe failures to retry",
                reset: 0,
            });
        }

        logger.info(`Reset ${result.count} failed vibe embeddings for retry`);

        res.json({
            message: `Reset ${result.count} failed tracks for vibe embedding retry`,
            reset: result.count,
        });
    } catch (error: any) {
        logger.error("Retry vibe failures error:", error);
        res.status(500).json({ error: "Failed to retry vibe failures" });
    }
});

// Machine callbacks from the CLAP analyzer (/vibe/failure, /vibe/success)
// live in a separate router that index.ts keeps mounted even when the
// audioAnalysis feature flag is off.
router.use(analysisInternalRoutes);

export default router;
