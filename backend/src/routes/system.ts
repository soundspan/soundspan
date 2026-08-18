import { Router } from "express";
import { featureDetection } from "../services/featureDetection";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { logger } from "../utils/logger";
import { config } from "../config";

const router = Router();

/**
 * @openapi
 * /api/system/features:
 *   get:
 *     summary: Get available system features based on running services and configured feature flags
 *     tags: [System]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Available features, configured flags, and cached vibe provider and migration state.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vibe:
 *                   type: object
 *                   required: [provider, activeSpace, migration]
 *                   properties:
 *                     provider:
 *                       type: object
 *                       required: [configured, reachable, checkedAt, fresh]
 *                       properties:
 *                         configured: { type: boolean }
 *                         reachable: { type: boolean, nullable: true }
 *                         checkedAt: { type: string, format: date-time, nullable: true }
 *                         fresh: { type: boolean }
 *                     activeSpace:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         id: { type: string }
 *                         family: { type: string }
 *                     migration:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         spaceId: { type: string }
 *                         family: { type: string }
 *                         coverage:
 *                           type: object
 *                           nullable: true
 *                           properties:
 *                             embedded: { type: integer, minimum: 0 }
 *                             pending: { type: integer, minimum: 0 }
 *                             failed: { type: integer, minimum: 0 }
 *                         cutoverThreshold: { type: number, minimum: 0, maximum: 1 }
 *                 loudnessTargetLufs:
 *                   type: number
 *                   minimum: -30
 *                   maximum: -10
 *                   description: Server reference loudness used for normalization metadata.
 *       401:
 *         description: Not authenticated
 */
router.get("/features", requireAuth, async (req, res) => {
    try {
        const features = await featureDetection.getFeatures();
        res.json({
            ...features,
            audioAnalysis: config.features.audioAnalysis,
            discovery: config.features.discovery,
            autoPlaylists: config.features.autoPlaylists,
            federation: config.features.federation,
            loudnessTargetLufs: config.loudnessTargetLufs,
        });
    } catch (error: any) {
        logger.error("Feature detection error:", error);
        res.status(500).json({ error: "Failed to detect features" });
    }
});

/**
 * @openapi
 * /api/system/ui-settings:
 *   get:
 *     summary: Get public-facing UI settings
 *     tags: [System]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: UI settings (non-sensitive)
 *       401:
 *         description: Not authenticated
 */
router.get("/ui-settings", requireAuth, async (req, res) => {
    try {
        const settings = await prisma.systemSettings.findUnique({
            where: { id: "default" },
            select: { showVersion: true },
        });
        res.json({ showVersion: settings?.showVersion ?? false });
    } catch (error: any) {
        logger.error("UI settings error:", error);
        res.status(500).json({ error: "Failed to get UI settings" });
    }
});

export default router;
