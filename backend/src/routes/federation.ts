import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config";
import { asyncHandler } from "../middleware/asyncHandler";
import { requireFederationPeer } from "../middleware/federationAuth";
import {
    federationPairingLimiter,
    federationPeerLimiter,
} from "../middleware/rateLimiter";
import {
    AudioStreamingService,
    type Quality,
} from "../services/audioStreaming";
import {
    decodeFederationDeltaCursor,
    findExportedFederationAlbum,
    findExportedFederationTrack,
    getFederationCatalogDelta,
    getFederationCatalogItems,
    getFederationManifest,
} from "../services/federationCatalog";
import { consumePairingCode } from "../services/federationPeers";
import { safeResolvePath } from "../utils/safeResolvePath";
import { handleGetCoverArt } from "./library/coverArt";
import { sendRouteError } from "./routeErrorResponse";

const router = Router();
const albumParamsSchema = z.strictObject({
    albumId: z.string().trim().min(1).max(128),
});
const trackParamsSchema = z.strictObject({
    trackId: z.string().trim().min(1).max(128),
});
const pageLimitSchema = z.coerce.number().int().min(1).max(500).default(200);
const catalogItemsSchema = z.strictObject({
    type: z.enum(["artist", "album", "track"]),
    cursor: z.string().trim().min(1).max(128).optional(),
    limit: pageLimitSchema,
});
const deltaQuerySchema = z.strictObject({
    since: z.iso
        .datetime({ offset: true })
        .transform((value) => new Date(value)),
    epoch: z.string().trim().min(1).max(128),
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: pageLimitSchema,
});
const pairingSchema = z.strictObject({
    code: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-HJ-NP-Z2-9]{8}$/),
    name: z.string().trim().min(1).max(120),
    baseUrl: z.url().refine((value) => new URL(value).protocol === "https:"),
});
const streamQuerySchema = z.strictObject({
    quality: z.enum(["original", "high", "medium", "low"]).default("original"),
});
const emptyQuerySchema = z.strictObject({});

function validationError(res: Response): Response {
    return sendRouteError(res, 400, "Invalid federation request");
}

function includesEmbeddingScope(req: Request): boolean {
    return req.federationPeer?.scopes.includes("embeddings:read") ?? false;
}

/** @openapi
 * /api/federation/v1/pair:
 *   post:
 *     summary: Consume a federation pairing code
 *     tags: [Federation]
 *     responses:
 *       201: { description: Peer credential issued once }
 *       400: { description: Invalid or expired pairing code }
 *       429: { description: Pairing rate limit exceeded }
 */
router.post(
    "/pair",
    federationPairingLimiter,
    asyncHandler(async (req, res) => {
        const parsed = pairingSchema.safeParse(req.body);
        const query = emptyQuerySchema.safeParse(req.query);
        if (!parsed.success || !query.success) return validationError(res);
        const result = await consumePairingCode(parsed.data);
        if (!result)
            return sendRouteError(res, 400, "Invalid or expired pairing code");
        return res.status(201).json(result);
    }),
);

/** @openapi
 * /api/federation/v1/manifest:
 *   get:
 *     summary: Get the host federation manifest
 *     tags: [Federation]
 *     security: [{ federationPeerAuth: [] }]
 *     responses:
 *       200: { description: Federation manifest }
 *       401: { description: Peer authentication required }
 *       403: { description: library:read scope required }
 */
router.get(
    "/manifest",
    requireFederationPeer("library:read"),
    federationPeerLimiter,
    asyncHandler(async (req, res) => {
        const query = emptyQuerySchema.safeParse(req.query);
        if (!query.success) return validationError(res);
        return res.json(
            await getFederationManifest(includesEmbeddingScope(req)),
        );
    }),
);

/** @openapi
 * /api/federation/v1/catalog/items:
 *   get:
 *     summary: Get a keyset page of federation catalog items
 *     tags: [Federation]
 *     security: [{ federationPeerAuth: [] }]
 *     responses:
 *       200: { description: Generic catalog envelope page }
 *       400: { description: Invalid query }
 */
router.get(
    "/catalog/items",
    requireFederationPeer("library:read"),
    federationPeerLimiter,
    asyncHandler(async (req, res) => {
        const parsed = catalogItemsSchema.safeParse(req.query);
        if (!parsed.success) return validationError(res);
        return res.json(
            await getFederationCatalogItems({
                mediaType: parsed.data.type,
                cursor: parsed.data.cursor,
                limit: parsed.data.limit,
                includeEmbeddings: includesEmbeddingScope(req),
            }),
        );
    }),
);

/** @openapi
 * /api/federation/v1/catalog/delta:
 *   get:
 *     summary: Get catalog changes and tombstones since an instant
 *     tags: [Federation]
 *     security: [{ federationPeerAuth: [] }]
 *     responses:
 *       200: { description: Bounded delta page }
 *       409: { description: Catalog epoch mismatch; full resync required }
 */
router.get(
    "/catalog/delta",
    requireFederationPeer("library:read"),
    federationPeerLimiter,
    asyncHandler(async (req, res) => {
        const parsed = deltaQuerySchema.safeParse(req.query);
        if (!parsed.success) return validationError(res);
        let cursor;
        try {
            cursor = parsed.data.cursor
                ? decodeFederationDeltaCursor(parsed.data.cursor)
                : undefined;
        } catch (_error: unknown) {
            return validationError(res);
        }
        const result = await getFederationCatalogDelta({
            since: parsed.data.since,
            epoch: parsed.data.epoch,
            cursor,
            limit: parsed.data.limit,
            includeEmbeddings: includesEmbeddingScope(req),
        });
        if (result.kind === "epochMismatch") {
            return sendRouteError(
                res,
                409,
                "Federation catalog epoch mismatch",
                {
                    code: "FEDERATION_EPOCH_MISMATCH",
                    currentEpoch: result.currentEpoch,
                },
            );
        }
        return res.json(result);
    }),
);

/** @openapi
 * /api/federation/v1/cover/{albumId}:
 *   get:
 *     summary: Get cover art for an exported album
 *     tags: [Federation]
 *     security: [{ federationPeerAuth: [] }]
 *     responses:
 *       200: { description: Cover image bytes }
 *       304: { description: Cover is unchanged }
 *       404: { description: Exported album or cover not found }
 */
router.get(
    "/cover/:albumId",
    requireFederationPeer("library:read"),
    federationPeerLimiter,
    asyncHandler(async (req, res) => {
        const params = albumParamsSchema.safeParse(req.params);
        const query = emptyQuerySchema.safeParse(req.query);
        if (!params.success || !query.success) return validationError(res);
        if (!(await findExportedFederationAlbum(params.data.albumId))) {
            return sendRouteError(res, 404, "Album cover not found");
        }
        req.params.id = params.data.albumId;
        return handleGetCoverArt(req, res);
    }),
);

async function streamExportedTrack(
    req: Request,
    res: Response,
    trackId: string,
    quality: Quality,
) {
    const track = await findExportedFederationTrack(trackId);
    if (!track?.filePath) return sendRouteError(res, 404, "Track not found");
    const absolutePath = safeResolvePath(
        config.music.musicPath,
        track.filePath.replace(/\\/g, "/"),
    );
    if (!absolutePath) return sendRouteError(res, 404, "Track not found");
    const service = new AudioStreamingService(
        config.music.musicPath,
        config.music.transcodeCachePath,
        config.music.transcodeCacheMaxGb,
    );
    try {
        const streamFile = await service.getStreamFilePath(
            track.id,
            quality,
            track.fileModified,
            absolutePath,
        );
        await service.streamFileWithRangeSupport(
            req,
            res,
            streamFile.filePath,
            streamFile.mimeType,
        );
        return undefined;
    } finally {
        service.destroy();
    }
}

/** @openapi
 * /api/federation/v1/stream/{trackId}:
 *   get:
 *     summary: Stream an exported track with HTTP Range support
 *     tags: [Federation]
 *     security: [{ federationPeerAuth: [] }]
 *     responses:
 *       200: { description: Full audio response }
 *       206: { description: Partial audio response }
 *       404: { description: Exported track not found }
 */
router.get(
    "/stream/:trackId",
    requireFederationPeer("stream:read"),
    federationPeerLimiter,
    asyncHandler(async (req, res) => {
        const params = trackParamsSchema.safeParse(req.params);
        const query = streamQuerySchema.safeParse(req.query);
        if (!params.success || !query.success) return validationError(res);
        return streamExportedTrack(
            req,
            res,
            params.data.trackId,
            query.data.quality,
        );
    }),
);

export default router;
