import { Router } from "express";
import { logger } from "../utils/logger";
import { enrichmentFailureService } from "../services/enrichmentFailureService";

const router = Router();

/**
 * @openapi
 * /api/analysis/vibe/failure:
 *   post:
 *     summary: Record a vibe embedding failure (internal)
 *     description: Called by the CLAP analyzer service. Uses x-internal-secret header for authentication instead of user session.
 *     tags: [Analysis]
 *     parameters:
 *       - in: header
 *         name: x-internal-secret
 *         required: true
 *         schema:
 *           type: string
 *         description: Shared secret for internal service authentication
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [trackId]
 *             properties:
 *               trackId:
 *                 type: string
 *               trackName:
 *                 type: string
 *               errorMessage:
 *                 type: string
 *               errorCode:
 *                 type: string
 *     responses:
 *       200:
 *         description: Failure recorded
 *       400:
 *         description: trackId is required
 *       403:
 *         description: Invalid internal secret
 */
/**
 * POST /api/analysis/vibe/failure
 * Record a vibe embedding failure (called by CLAP analyzer)
 */
router.post("/vibe/failure", async (req, res) => {
    // Internal endpoint - verify shared secret from CLAP analyzer
    const internalSecret = req.headers["x-internal-secret"];
    if (internalSecret !== process.env.INTERNAL_API_SECRET) {
        return res.status(403).json({ error: "Forbidden" });
    }

    try {
        const { trackId, trackName, errorMessage, errorCode } = req.body;

        if (!trackId) {
            return res.status(400).json({ error: "trackId is required" });
        }

        await enrichmentFailureService.recordFailure({
            entityType: "vibe",
            entityId: trackId,
            entityName: trackName,
            errorMessage: errorMessage || "Vibe embedding generation failed",
            errorCode: errorCode,
        });

        res.json({ message: "Failure recorded" });
    } catch (error: any) {
        logger.error("Record vibe failure error:", error);
        res.status(500).json({ error: "Failed to record failure" });
    }
});

/**
 * @openapi
 * /api/analysis/vibe/success:
 *   post:
 *     summary: Resolve vibe failure records on success (internal)
 *     description: Called by the CLAP analyzer service. Uses x-internal-secret header for authentication instead of user session.
 *     tags: [Analysis]
 *     parameters:
 *       - in: header
 *         name: x-internal-secret
 *         required: true
 *         schema:
 *           type: string
 *         description: Shared secret for internal service authentication
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [trackId]
 *             properties:
 *               trackId:
 *                 type: string
 *     responses:
 *       200:
 *         description: Stale failures resolved
 *       400:
 *         description: trackId is required
 *       403:
 *         description: Invalid internal secret
 */
/**
 * POST /api/analysis/vibe/success
 * Resolve failure records when a vibe embedding succeeds (called by CLAP analyzer)
 */
router.post("/vibe/success", async (req, res) => {
    // Internal endpoint - verify shared secret from CLAP analyzer
    const internalSecret = req.headers["x-internal-secret"];
    if (internalSecret !== process.env.INTERNAL_API_SECRET) {
        return res.status(403).json({ error: "Forbidden" });
    }

    try {
        const { trackId } = req.body;

        if (!trackId) {
            return res.status(400).json({ error: "trackId is required" });
        }

        // Resolve any stale failure records for this track
        await enrichmentFailureService.resolveByEntity("vibe", trackId);

        res.json({ message: "Stale failures resolved" });
    } catch (error: any) {
        logger.error("Resolve vibe failure error:", error);
        res.status(500).json({ error: "Failed to resolve failures" });
    }
});

/**
 * Machine-to-machine callbacks invoked by the CLAP analyzer service
 * (`/api/analysis/vibe/failure` and `/api/analysis/vibe/success`).
 *
 * Kept in a dedicated router so they stay mounted under `/api/analysis` even
 * when `AUDIO_ANALYSIS_ENABLED=false` — analyzers draining in-flight queue
 * items (e.g. AIO deployments, where the in-container analyzers are not
 * controlled by the flag) must always be able to report results.
 */
export default router;
