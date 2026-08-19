import { Router, type Response } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import {
    getLibraryHealthAnalysis,
    getLibraryHealthDashboardSummary,
    getLibraryHealthDuplicates,
    getLibraryHealthMetadataGaps,
    getLibraryHealthQuality,
    getLibraryHealthStorage,
    invalidateLibraryHealthDashboardCache,
    METADATA_GAP_KINDS,
} from "../services/libraryHealthDashboard";
import { logger } from "../utils/logger";
import { sendInternalRouteError, sendRouteError } from "./routeErrorResponse";

const router = Router();
const log = logger.child("LibraryHealthDashboard");
const emptySchema = z.strictObject({});
const paginationShape = {
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
};
const paginationSchema = z.strictObject(paginationShape);
const duplicatePaginationSchema = z.strictObject({
    ...paginationShape,
    limit: z.coerce.number().int().min(1).max(50).default(50),
});
const qualityQuerySchema = z.strictObject({
    ...paginationShape,
    floor: z.coerce.number().min(32).max(2_000).default(192),
});
const gapParamsSchema = z.strictObject({
    kind: z.enum(METADATA_GAP_KINDS),
});

function invalidRequest(res: Response): Response {
    return sendRouteError(res, 400, "Invalid library health request");
}

function internalFailure(res: Response, operation: string, error: unknown) {
    log.error(`${operation} failed`, { error });
    return sendInternalRouteError(res, `Failed to ${operation}`);
}

router.use(requireAuth, requireAdmin);

/**
 * @openapi
 * /api/library-health/summary:
 *   get:
 *     summary: Get all Library Health dashboard panel counts
 *     tags: [Library Health]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Cached dashboard summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [metadataGaps, analysisCoverage, storage, quality, duplicates]
 *       400: { description: Invalid query parameters }
 *       401: { description: Not authenticated }
 *       403: { description: Administrator access required }
 *       500: { description: Summary load failed }
 */
router.get(
    "/summary",
    asyncHandler(async (req, res) => {
        if (!emptySchema.safeParse(req.query).success)
            return invalidRequest(res);
        try {
            return res.json(await getLibraryHealthDashboardSummary());
        } catch (error) {
            return internalFailure(res, "load library health summary", error);
        }
    }),
);

/**
 * @openapi
 * /api/library-health/gaps/{kind}:
 *   get:
 *     summary: List one metadata-gap category
 *     tags: [Library Health]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: kind, required: true, schema: { type: string, enum: [missing-art, missing-mbid, missing-genres, missing-lyrics] } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 50 } }
 *       - { in: query, name: offset, schema: { type: integer, minimum: 0, maximum: 1000000, default: 0 } }
 *     responses:
 *       200:
 *         description: Metadata-gap counts and drill-down page
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [kind, counts, items, total, limit, offset]
 *       400: { description: Invalid kind or pagination }
 *       401: { description: Not authenticated }
 *       403: { description: Administrator access required }
 *       500: { description: Metadata-gap load failed }
 */
router.get(
    "/gaps/:kind",
    asyncHandler(async (req, res) => {
        const params = gapParamsSchema.safeParse(req.params);
        const query = paginationSchema.safeParse(req.query);
        if (!params.success || !query.success) return invalidRequest(res);
        try {
            return res.json(
                await getLibraryHealthMetadataGaps(
                    params.data.kind,
                    query.data,
                ),
            );
        } catch (error) {
            return internalFailure(
                res,
                "load library health metadata gaps",
                error,
            );
        }
    }),
);

/**
 * @openapi
 * /api/library-health/analysis:
 *   get:
 *     summary: Get analysis, vibe, and loudness coverage with failed tracks
 *     tags: [Library Health]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 50 } }
 *       - { in: query, name: offset, schema: { type: integer, minimum: 0, maximum: 1000000, default: 0 } }
 *     responses:
 *       200:
 *         description: Coverage counts and failed-track page
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [total, analysisStatus, vibeAnalysisStatus, loudness, failed]
 *       400: { description: Invalid pagination }
 *       401: { description: Not authenticated }
 *       403: { description: Administrator access required }
 *       500: { description: Analysis coverage load failed }
 */
router.get(
    "/analysis",
    asyncHandler(async (req, res) => {
        const query = paginationSchema.safeParse(req.query);
        if (!query.success) return invalidRequest(res);
        try {
            return res.json(await getLibraryHealthAnalysis(query.data));
        } catch (error) {
            return internalFailure(res, "load library health analysis", error);
        }
    }),
);

/**
 * @openapi
 * /api/library-health/storage:
 *   get:
 *     summary: Get local-library storage and format analytics
 *     tags: [Library Health]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: MIME totals, derived bitrate samples, and top storage artists
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [formats, topArtists, sampledTracks, sampleLimit, isTruncated]
 *       400: { description: Invalid query parameters }
 *       401: { description: Not authenticated }
 *       403: { description: Administrator access required }
 *       500: { description: Storage analytics load failed }
 */
router.get(
    "/storage",
    asyncHandler(async (req, res) => {
        if (!emptySchema.safeParse(req.query).success)
            return invalidRequest(res);
        try {
            return res.json(await getLibraryHealthStorage());
        } catch (error) {
            return internalFailure(res, "load library health storage", error);
        }
    }),
);

/**
 * @openapi
 * /api/library-health/quality:
 *   get:
 *     summary: List lossy albums below a derived bitrate floor
 *     tags: [Library Health]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: floor, schema: { type: number, minimum: 32, maximum: 2000, default: 192 } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 50 } }
 *       - { in: query, name: offset, schema: { type: integer, minimum: 0, maximum: 1000000, default: 0 } }
 *     responses:
 *       200:
 *         description: Paginated low-bitrate lossy albums
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [floorKbps, items, total, limit, offset, sampledTracks, sampleLimit, isTruncated]
 *       400: { description: Invalid floor or pagination }
 *       401: { description: Not authenticated }
 *       403: { description: Administrator access required }
 *       500: { description: Quality analytics load failed }
 */
router.get(
    "/quality",
    asyncHandler(async (req, res) => {
        const query = qualityQuerySchema.safeParse(req.query);
        if (!query.success) return invalidRequest(res);
        const { floor, limit, offset } = query.data;
        try {
            return res.json(
                await getLibraryHealthQuality(floor, { limit, offset }),
            );
        } catch (error) {
            return internalFailure(res, "load library health quality", error);
        }
    }),
);

/**
 * @openapi
 * /api/library-health/duplicates:
 *   get:
 *     summary: List report-only durable-identity duplicate clusters
 *     tags: [Library Health]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 50, default: 50 } }
 *       - { in: query, name: offset, schema: { type: integer, minimum: 0, maximum: 1000000, default: 0 } }
 *     responses:
 *       200:
 *         description: Tier-ordered duplicate-cluster page
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [clusters, total, byTier, isTruncated, limit, offset]
 *       400: { description: Invalid pagination }
 *       401: { description: Not authenticated }
 *       403: { description: Administrator access required }
 *       500: { description: Duplicate cluster load failed }
 */
router.get(
    "/duplicates",
    asyncHandler(async (req, res) => {
        const query = duplicatePaginationSchema.safeParse(req.query);
        if (!query.success) return invalidRequest(res);
        try {
            return res.json(await getLibraryHealthDuplicates(query.data));
        } catch (error) {
            return internalFailure(
                res,
                "load library health duplicates",
                error,
            );
        }
    }),
);

/**
 * @openapi
 * /api/library-health/refresh:
 *   post:
 *     summary: Invalidate Library Health caches and return a fresh summary
 *     tags: [Library Health]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Fresh dashboard summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [metadataGaps, analysisCoverage, storage, quality, duplicates]
 *       400: { description: Invalid request }
 *       401: { description: Not authenticated }
 *       403: { description: Administrator access required }
 *       500: { description: Dashboard refresh failed }
 */
router.post(
    "/refresh",
    asyncHandler(async (req, res) => {
        if (
            !emptySchema.safeParse(req.query).success ||
            !emptySchema.safeParse(req.body ?? {}).success
        ) {
            return invalidRequest(res);
        }
        try {
            await invalidateLibraryHealthDashboardCache();
            return res.json(await getLibraryHealthDashboardSummary());
        } catch (error) {
            return internalFailure(
                res,
                "refresh library health dashboard",
                error,
            );
        }
    }),
);

export default router;
