import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { trackMappingService } from "../services/trackMappingService";
import { logger } from "../utils/logger";

const router = Router();

/**
 * @openapi
 * /api/track-mappings/album/{albumId}:
 *   get:
 *     summary: Get all track mappings for an album
 *     tags: [Track Mappings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: albumId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Array of track mappings with provider details
 *       401:
 *         description: Not authenticated
 */
router.get(
    "/album/:albumId",
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const { albumId } = req.params;
            const mappings =
                await trackMappingService.getMappingsForAlbum(albumId);
            res.json({ mappings });
        } catch (err) {
            logger.error(
                "[TrackMappings] Failed to get album mappings:",
                err
            );
            res.status(500).json({ error: "Failed to get album mappings" });
        }
    }
);

const mappingPayloadSchema = z
    .object({
        trackId: z.string().trim().min(1).optional(),
        trackTidalId: z.string().trim().min(1).optional(),
        trackYtMusicId: z.string().trim().min(1).optional(),
        confidence: z.number().min(0).max(1),
        source: z.enum(["gap-fill", "isrc", "import-match", "manual"]),
    })
    .refine(
        (mapping) =>
            Boolean(
                mapping.trackId || mapping.trackTidalId || mapping.trackYtMusicId
            ),
        {
            message:
                "At least one linkage key is required: trackId, trackTidalId, or trackYtMusicId",
        }
    );

const batchCreateSchema = z.object({
    mappings: z.array(mappingPayloadSchema).min(1).max(100),
});

function buildLinkageKey(mapping: {
    trackId?: string;
    trackTidalId?: string;
    trackYtMusicId?: string;
}): string {
    return [
        mapping.trackId ?? "",
        mapping.trackTidalId ?? "",
        mapping.trackYtMusicId ?? "",
    ].join("|");
}

/**
 * @openapi
 * /api/track-mappings/batch:
 *   post:
 *     summary: Batch create track mappings
 *     tags: [Track Mappings]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mappings:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     trackId:
 *                       type: string
 *                     trackTidalId:
 *                       type: string
 *                     trackYtMusicId:
 *                       type: string
 *                     confidence:
 *                       type: number
 *                     source:
 *                       type: string
 *     responses:
 *       200:
 *         description: Created mappings
 *       400:
 *         description: Invalid request body
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
router.post(
    "/batch",
    requireAuth,
    requireAdmin,
    async (req: Request, res: Response) => {
        try {
            const parsed = batchCreateSchema.safeParse(req.body);
            if (!parsed.success) {
                return res
                    .status(400)
                    .json({ error: "Invalid mappings array", details: parsed.error.issues });
            }

            const linkageKeys = new Set<string>();
            for (const mapping of parsed.data.mappings) {
                const linkageKey = buildLinkageKey(mapping);
                if (linkageKeys.has(linkageKey)) {
                    return res.status(400).json({
                        error: "Duplicate mapping linkage in batch payload",
                    });
                }
                linkageKeys.add(linkageKey);
            }

            const results = [];
            for (const mapping of parsed.data.mappings) {
                const created = await trackMappingService.createMapping(mapping);
                results.push(created);
            }

            logger.info(
                `[TrackMappings] Admin user ${req.user?.id ?? "unknown"} created ${results.length} mapping(s)`
            );

            res.json({ mappings: results });
        } catch (err) {
            logger.error(
                "[TrackMappings] Failed to batch create mappings:",
                err
            );
            res.status(500).json({ error: "Failed to create mappings" });
        }
    }
);

export default router;
