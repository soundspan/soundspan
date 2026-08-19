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
function scalarQueryValue(value: unknown): unknown {
    if (
        value === undefined ||
        typeof value === "string" ||
        typeof value === "number"
    ) {
        return value;
    }
    return Number.NaN;
}

const paginationShape = {
    limit: z.preprocess(
        scalarQueryValue,
        z.coerce.number().int().min(1).max(100).default(50),
    ),
    offset: z.preprocess(
        scalarQueryValue,
        z.coerce.number().int().min(0).max(1_000_000).default(0),
    ),
};
const paginationSchema = z.strictObject(paginationShape);
const duplicatePaginationSchema = z.strictObject({
    ...paginationShape,
    limit: z.preprocess(
        scalarQueryValue,
        z.coerce.number().int().min(1).max(50).default(50),
    ),
});
const qualityQuerySchema = z.strictObject({
    ...paginationShape,
    floor: z.preprocess(
        scalarQueryValue,
        z.coerce.number().min(32).max(2_000).default(192),
    ),
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
 *               properties:
 *                 metadataGaps:
 *                   type: object
 *                   required: [missingArt, missingMbid, missingGenres, missingLyrics]
 *                   properties:
 *                     missingArt: { type: object, required: [albums, artists], properties: { albums: { type: integer }, artists: { type: integer } } }
 *                     missingMbid: { type: object, required: [albums, artists], properties: { albums: { type: integer }, artists: { type: integer } } }
 *                     missingGenres: { type: integer }
 *                     missingLyrics: { type: integer }
 *                 analysisCoverage:
 *                   type: object
 *                   required: [total, analysisStatus, vibeAnalysisStatus, loudness]
 *                   properties:
 *                     total: { type: integer }
 *                     analysisStatus: { type: object, required: [pending, processing, failed, completed], properties: { pending: { type: integer }, processing: { type: integer }, failed: { type: integer }, completed: { type: integer } } }
 *                     vibeAnalysisStatus: { type: object, required: [pending, processing, failed, completed], properties: { pending: { type: integer }, processing: { type: integer }, failed: { type: integer }, completed: { type: integer } } }
 *                     loudness: { type: object, required: [measured, missing], properties: { measured: { type: integer }, missing: { type: integer } } }
 *                 storage:
 *                   type: object
 *                   required: [tracks, totalFileSize, mimeTypes, artists, isTruncated]
 *                   properties:
 *                     tracks: { type: integer }
 *                     totalFileSize: { type: number }
 *                     mimeTypes: { type: integer }
 *                     artists: { type: integer }
 *                     isTruncated: { type: boolean }
 *                 quality:
 *                   type: object
 *                   required: [floorKbps, albumsBelowFloor, isTruncated]
 *                   properties:
 *                     floorKbps: { type: number }
 *                     albumsBelowFloor: { type: integer }
 *                     isTruncated: { type: boolean }
 *                 duplicates:
 *                   type: object
 *                   required: [clusters, byTier, isTruncated]
 *                   properties:
 *                     clusters: { type: integer }
 *                     byTier: { type: object, required: [audioHash, recordingMbid, isrc], properties: { audioHash: { type: integer }, recordingMbid: { type: integer }, isrc: { type: integer } } }
 *                     isTruncated: { type: boolean }
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
 *               properties:
 *                 kind: { type: string, enum: [missing-art, missing-mbid, missing-genres, missing-lyrics] }
 *                 counts:
 *                   type: object
 *                   properties:
 *                     artists: { type: integer }
 *                     albums: { type: integer }
 *                     tracks: { type: integer }
 *                 items:
 *                   type: array
 *                   items:
 *                     oneOf:
 *                       - type: object
 *                         required: [id, title, rgMbid, coverUrl, userCoverUrl, artist]
 *                         properties:
 *                           id: { type: string }
 *                           title: { type: string }
 *                           rgMbid: { type: string, nullable: true }
 *                           coverUrl: { type: string, nullable: true }
 *                           userCoverUrl: { type: string, nullable: true }
 *                           artist: { type: object, required: [id, name], properties: { id: { type: string }, name: { type: string } } }
 *                       - type: object
 *                         required: [id, title, filePath, albumTitle, artistName]
 *                         properties:
 *                           id: { type: string }
 *                           title: { type: string }
 *                           filePath: { type: string, nullable: true }
 *                           albumTitle: { type: string }
 *                           artistName: { type: string }
 *                 total: { type: integer }
 *                 limit: { type: integer }
 *                 offset: { type: integer }
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
 *               properties:
 *                 total: { type: integer }
 *                 analysisStatus: { type: object, required: [pending, processing, failed, completed], properties: { pending: { type: integer }, processing: { type: integer }, failed: { type: integer }, completed: { type: integer } } }
 *                 vibeAnalysisStatus: { type: object, required: [pending, processing, failed, completed], properties: { pending: { type: integer }, processing: { type: integer }, failed: { type: integer }, completed: { type: integer } } }
 *                 loudness: { type: object, required: [measured, missing], properties: { measured: { type: integer }, missing: { type: integer } } }
 *                 failed:
 *                   type: object
 *                   required: [items, total, limit, offset]
 *                   properties:
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         required: [id, title, artistName, albumTitle, analysisError]
 *                         properties:
 *                           id: { type: string }
 *                           title: { type: string }
 *                           artistName: { type: string }
 *                           albumTitle: { type: string }
 *                           analysisError: { type: string, nullable: true }
 *                     total: { type: integer }
 *                     limit: { type: integer }
 *                     offset: { type: integer }
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
 *               properties:
 *                 formats:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [mime, trackCount, totalFileSize, averageBitrateKbps, bitrateSampleSize]
 *                     properties:
 *                       mime: { type: string, nullable: true }
 *                       trackCount: { type: integer }
 *                       totalFileSize: { type: number }
 *                       averageBitrateKbps: { type: number, nullable: true }
 *                       bitrateSampleSize: { type: integer }
 *                 topArtists:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [artistId, artistName, trackCount, totalFileSize]
 *                     properties:
 *                       artistId: { type: string }
 *                       artistName: { type: string }
 *                       trackCount: { type: integer }
 *                       totalFileSize: { type: number }
 *                 sampledTracks: { type: integer }
 *                 sampleLimit: { type: integer }
 *                 isTruncated: { type: boolean }
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
 *               properties:
 *                 floorKbps: { type: number }
 *                 items:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [albumId, title, artist, averageBitrateKbps, trackCount]
 *                     properties:
 *                       albumId: { type: string }
 *                       title: { type: string }
 *                       artist: { type: object, required: [id, name], properties: { id: { type: string }, name: { type: string } } }
 *                       averageBitrateKbps: { type: number }
 *                       trackCount: { type: integer }
 *                 total: { type: integer }
 *                 limit: { type: integer }
 *                 offset: { type: integer }
 *                 sampledTracks: { type: integer }
 *                 sampleLimit: { type: integer }
 *                 isTruncated: { type: boolean }
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
 *               properties:
 *                 clusters:
 *                   type: array
 *                   items:
 *                     type: object
 *                     required: [tier, identity, memberCount, totalFileSize, members]
 *                     properties:
 *                       tier: { type: string, enum: [audioHash, recordingMbid, isrc] }
 *                       identity: { type: string }
 *                       memberCount: { type: integer }
 *                       totalFileSize: { type: number }
 *                       members:
 *                         type: array
 *                         maxItems: 8
 *                         items:
 *                           type: object
 *                           required: [id, title, albumTitle, artistName, filePath, fileSize, mime]
 *                           properties:
 *                             id: { type: string }
 *                             title: { type: string }
 *                             albumTitle: { type: string }
 *                             artistName: { type: string }
 *                             filePath: { type: string, nullable: true }
 *                             fileSize: { type: number }
 *                             mime: { type: string, nullable: true }
 *                 total: { type: integer }
 *                 byTier: { type: object, required: [audioHash, recordingMbid, isrc], properties: { audioHash: { type: integer }, recordingMbid: { type: integer }, isrc: { type: integer } } }
 *                 isTruncated: { type: boolean }
 *                 limit: { type: integer }
 *                 offset: { type: integer }
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
 *               properties:
 *                 metadataGaps: { type: object }
 *                 analysisCoverage: { type: object }
 *                 storage: { type: object }
 *                 quality: { type: object }
 *                 duplicates: { type: object }
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
