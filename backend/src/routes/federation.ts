import { Router, type Request, type Response } from "express";
import { pipeline } from "node:stream/promises";
import type { Transform } from "node:stream";
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
    findExportedFederationAudiobook,
    findExportedFederationAlbum,
    findExportedFederationTrack,
    getFederationCatalogDelta,
    getFederationCatalogItem,
    getFederationCatalogItems,
    getFederationManifest,
    type FederationCatalogResponse,
} from "../services/federationCatalog";
import {
    acceptsFederationEmbeddingSpace,
    FEDERATION_EMBEDDING_SPACE_ACCEPT_HEADER,
    FEDERATION_EMBEDDING_SPACE_HEADER,
} from "../services/federationEmbeddingSpaceHeader";
import {
    federationCapabilitiesSchema,
    FEDERATION_CAPABILITY_VALUES,
} from "../services/federationCapabilities";
import { audiobookshelfService } from "../services/audiobookshelf";
import {
    consumeFederationPairingRequest,
    FEDERATION_SCOPE_VALUES,
} from "../services/federationPeers";
import { safeResolvePath } from "../utils/safeResolvePath";
import { handleGetCoverArt } from "./library/coverArt";
import { sendRouteError } from "./routeErrorResponse";
import { handleAudiobookCover } from "./audiobooks";
import { withFederationStreamControls } from "../services/federationStreamControls";
import { getFederationPresenceExport } from "../services/federationPresence";
import { recordFederationPresenceUsersExported } from "../metrics";
import {
    getFederationPlaylistDetail,
    getFederationPlaylistPage,
} from "../services/federationPlaylistExport";

const router = Router();
const albumParamsSchema = z.strictObject({
    albumId: z.string().trim().min(1).max(128),
});
const trackParamsSchema = z.strictObject({
    trackId: z.string().trim().min(1).max(128),
});
const audiobookParamsSchema = z.strictObject({
    audiobookId: z.string().trim().min(1).max(128),
});
const pageLimitSchema = z.coerce.number().int().min(1).max(500).default(200);
const catalogItemsSchema = z.strictObject({
    type: z.enum(["artist", "album", "track", "podcast", "audiobook"]),
    cursor: z.string().trim().min(1).max(128).optional(),
    limit: pageLimitSchema,
});
const catalogItemParamsSchema = z.strictObject({
    type: z.enum(["artist", "album", "track", "podcast", "audiobook"]),
    id: z.string().trim().min(1).max(128),
});
const deltaQuerySchema = z.strictObject({
    since: z.iso
        .datetime({ offset: true })
        .transform((value) => new Date(value)),
    epoch: z.string().trim().min(1).max(128),
    cursor: z.string().trim().min(1).max(512).optional(),
    limit: pageLimitSchema,
});
const pairingCodeValueSchema = z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-HJ-NP-Z2-9]{8}$/);
const pairingScopesSchema = z
    .array(z.enum(FEDERATION_SCOPE_VALUES))
    .min(1)
    .max(FEDERATION_SCOPE_VALUES.length)
    .refine((values) => new Set(values).size === values.length)
    .refine(
        (values) =>
            !values.includes("embeddings:read") ||
            values.includes("library:read"),
    )
    .refine(
        (values) =>
            !values.includes("social:read") || values.includes("library:read"),
    );
const pairingSchema = z.strictObject({
    code: pairingCodeValueSchema,
    name: z.string().trim().min(1).max(120),
    baseUrl: z
        .url()
        .refine((value) => new URL(value).protocol === "https:")
        .optional(),
    reciprocalPairingCode: pairingCodeValueSchema.optional(),
    reciprocalScopes: pairingScopesSchema.optional(),
    requestedScopes: pairingScopesSchema.optional(),
    capabilities: federationCapabilitiesSchema,
});
const streamQuerySchema = z.strictObject({
    quality: z.enum(["original", "high", "medium", "low"]).default("original"),
});
const emptyQuerySchema = z.strictObject({});
const playlistPageQuerySchema = z.strictObject({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(100).default(100),
});
const playlistParamsSchema = z.strictObject({
    id: z.string().trim().min(1).max(256),
});

function validationError(res: Response): Response {
    return sendRouteError(res, 400, "Invalid federation request");
}

function pairingFailure(
    res: Response,
    reason: "not_found" | "used" | "expired" | "scope_mismatch" | "invalid",
): Response {
    if (reason === "used") {
        return sendRouteError(res, 400, "Pairing code has already been used", {
            code: "FEDERATION_CODE_USED",
        });
    }
    if (reason === "expired") {
        return sendRouteError(res, 400, "Pairing code has expired", {
            code: "FEDERATION_CODE_EXPIRED",
        });
    }
    if (reason === "scope_mismatch") {
        return sendRouteError(
            res,
            400,
            "Requested federation scopes are not granted",
            {
                code: "FEDERATION_SCOPE_MISMATCH",
            },
        );
    }
    return sendRouteError(res, 400, "Invalid or expired pairing code");
}

function includesEmbeddingScope(req: Request): boolean {
    return req.federationPeer?.scopes.includes("embeddings:read") ?? false;
}

function embeddingExportRequest(req: Request) {
    const peer = req.federationPeer;
    if (!peer) throw new Error("Federation catalog peer is unavailable");
    return {
        includeEmbeddings: includesEmbeddingScope(req),
        peerId: peer.id,
        peerCapabilities: peer.capabilities,
        acceptsEmbeddingSpace: acceptsFederationEmbeddingSpace(
            req.headers[FEDERATION_EMBEDDING_SPACE_ACCEPT_HEADER.toLowerCase()],
        ),
    };
}

function sendCatalogResponse(
    res: Response,
    response: FederationCatalogResponse<unknown>,
): Response {
    if (response.embeddingSpaceHeaderValue) {
        res.setHeader(
            FEDERATION_EMBEDDING_SPACE_HEADER,
            response.embeddingSpaceHeaderValue,
        );
    }
    return res.json(response.body);
}

/** @openapi
 * /api/federation/v1/pair:
 *   post:
 *     summary: Consume a federation pairing code for one host link
 *     tags: [Federation]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code, name]
 *             properties:
 *               code: { type: string, pattern: '^[A-HJ-NP-Z2-9]{8}$' }
 *               name: { type: string }
 *               requestedScopes:
 *                 type: array
 *                 description: social:read and embeddings:read each require library:read
 *                 items: { type: string, enum: [library:read, stream:read, embeddings:read, social:read] }
 *               reciprocalScopes:
 *                 type: array
 *                 deprecated: true
 *                 description: Legacy field; social:read and embeddings:read each require library:read
 *                 items: { type: string, enum: [library:read, stream:read, embeddings:read, social:read] }
 *     responses:
 *       201: { description: Peer credential issued once }
 *       400: { description: Invalid pairing input, FEDERATION_CODE_USED, FEDERATION_CODE_EXPIRED, or FEDERATION_SCOPE_MISMATCH }
 *       429: { description: Pairing rate limit exceeded }
 */
router.post(
    "/pair",
    federationPairingLimiter,
    asyncHandler(async (req, res) => {
        const parsed = pairingSchema.safeParse(req.body);
        const query = emptyQuerySchema.safeParse(req.query);
        if (!parsed.success || !query.success) return validationError(res);
        const result = await consumeFederationPairingRequest(parsed.data);
        if (!result.ok) return pairingFailure(res, result.reason);
        return res.status(201).json({
            peer: result.peer,
            token: result.token,
            capabilities: [...FEDERATION_CAPABILITY_VALUES],
        });
    }),
);

/** @openapi
 * /api/federation/v1/manifest:
 *   get:
 *     summary: Get the host federation manifest
 *     tags: [Federation]
 *     security: [{ federationPeerAuth: [] }]
 *     parameters:
 *       - in: header
 *         name: X-Soundspan-Embedding-Space-Accept
 *         required: false
 *         schema: { type: string, enum: ["1"] }
 *         description: Advertises that the consumer validates embedding-space identities
 *     responses:
 *       200: { description: Federation manifest }
 *       401: { description: Peer authentication required }
 *       403: { description: library:read scope required }
 *       429: { description: Federation peer rate limit exceeded }
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
 * /api/federation/v1/social/presence:
 *   get:
 *     summary: Get the host's privacy-filtered online presence
 *     tags: [Federation]
 *     security: [{ federationPeerAuth: [] }]
 *     responses:
 *       200:
 *         description: At most 100 users who opted into peer presence sharing
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [users]
 *               properties:
 *                 users:
 *                   type: array
 *                   maxItems: 100
 *                   items:
 *                     type: object
 *                     required: [username, status, updatedAt]
 *                     properties:
 *                       username: { type: string }
 *                       displayName: { type: string }
 *                       status: { type: string, enum: [playing, paused, idle] }
 *                       track:
 *                         type: object
 *                         required: [title, artist, album]
 *                         properties:
 *                           title: { type: string }
 *                           artist: { type: string }
 *                           album: { type: string }
 *                       updatedAt: { type: string, format: date-time }
 *       401: { description: Peer authentication required }
 *       403: { description: social:read scope required }
 *       429: { description: Federation peer rate limit exceeded }
 */
router.get(
    "/social/presence",
    requireFederationPeer("social:read"),
    federationPeerLimiter,
    asyncHandler(async (req, res) => {
        const query = emptyQuerySchema.safeParse(req.query);
        if (!query.success) return validationError(res);
        const payload = await getFederationPresenceExport();
        recordFederationPresenceUsersExported(
            req.federationPeer?.id ?? "unknown",
            payload.users.length,
        );
        return res.json(payload);
    }),
);

/** @openapi
 * /api/federation/v1/social/playlists:
 *   get:
 *     summary: List public playlists whose owners opted into peer sharing
 *     tags: [Federation]
 *     security: [{ federationPeerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: offset
 *         schema: { type: integer, minimum: 0, default: 0 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 100 }
 *     responses:
 *       200: { description: Privacy-filtered bounded playlist page }
 *       401: { description: Peer authentication required }
 *       403: { description: social:read scope required }
 */
router.get(
    "/social/playlists",
    requireFederationPeer("social:read"),
    federationPeerLimiter,
    asyncHandler(async (req, res) => {
        const parsed = playlistPageQuerySchema.safeParse(req.query);
        if (!parsed.success) return validationError(res);
        return res.json(await getFederationPlaylistPage(parsed.data));
    }),
);

/** @openapi
 * /api/federation/v1/social/playlists/{id}:
 *   get:
 *     summary: Get one still-public, still-opted-in peer playlist
 *     tags: [Federation]
 *     security: [{ federationPeerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Playlist detail with at most 1000 tracks }
 *       401: { description: Peer authentication required }
 *       403: { description: social:read scope required }
 *       404: { description: Playlist not exported }
 */
router.get(
    "/social/playlists/:id",
    requireFederationPeer("social:read"),
    federationPeerLimiter,
    asyncHandler(async (req, res) => {
        const params = playlistParamsSchema.safeParse(req.params);
        const query = emptyQuerySchema.safeParse(req.query);
        if (!params.success || !query.success) return validationError(res);
        const detail = await getFederationPlaylistDetail(params.data.id);
        if (!detail) return sendRouteError(res, 404, "Playlist not found");
        return res.json(detail);
    }),
);

/** @openapi
 * /api/federation/v1/catalog/items:
 *   get:
 *     summary: Get a keyset page of federation catalog items
 *     tags: [Federation]
 *     security: [{ federationPeerAuth: [] }]
 *     parameters:
 *       - in: header
 *         name: X-Soundspan-Embedding-Space-Accept
 *         required: false
 *         schema: { type: string, enum: ["1"] }
 *         description: Advertises that the consumer validates embedding-space identities
 *     responses:
 *       200:
 *         description: Generic catalog envelope page
 *         headers:
 *           X-Soundspan-Embedding-Space:
 *             description: JSON embedding-space tuple when the body carries vectors; preprocessingHash is additive and may be absent from older 2.3 peers
 *             schema: { type: string }
 *       400: { description: Invalid query }
 *       429: { description: Federation peer rate limit exceeded }
 */
router.get(
    "/catalog/items",
    requireFederationPeer("library:read"),
    federationPeerLimiter,
    asyncHandler(async (req, res) => {
        const parsed = catalogItemsSchema.safeParse(req.query);
        if (!parsed.success) return validationError(res);
        const response = await getFederationCatalogItems({
            mediaType: parsed.data.type,
            cursor: parsed.data.cursor,
            limit: parsed.data.limit,
            ...embeddingExportRequest(req),
        });
        return sendCatalogResponse(res, response);
    }),
);

/** @openapi
 * /api/federation/v1/catalog/items/{type}/{id}:
 *   get:
 *     summary: Get one federation catalog item by remote identity
 *     tags: [Federation]
 *     security: [{ federationPeerAuth: [] }]
 *     parameters:
 *       - in: header
 *         name: X-Soundspan-Embedding-Space-Accept
 *         required: false
 *         schema: { type: string, enum: ["1"] }
 *         description: Advertises that the consumer validates embedding-space identities
 *     responses:
 *       200:
 *         description: Generic catalog item envelope
 *         headers:
 *           X-Soundspan-Embedding-Space:
 *             description: JSON embedding-space tuple when the body carries a vector; preprocessingHash is additive and may be absent from older 2.3 peers
 *             schema: { type: string }
 *       404: { description: Exported catalog item not found }
 *       429: { description: Federation peer rate limit exceeded }
 */
router.get(
    "/catalog/items/:type/:id",
    requireFederationPeer("library:read"),
    federationPeerLimiter,
    asyncHandler(async (req, res) => {
        const params = catalogItemParamsSchema.safeParse(req.params);
        const query = emptyQuerySchema.safeParse(req.query);
        if (!params.success || !query.success) return validationError(res);
        const response = await getFederationCatalogItem({
            mediaType: params.data.type,
            id: params.data.id,
            ...embeddingExportRequest(req),
        });
        if (!response)
            return sendRouteError(res, 404, "Catalog item not found");
        return sendCatalogResponse(res, response);
    }),
);

/** @openapi
 * /api/federation/v1/catalog/delta:
 *   get:
 *     summary: Get catalog changes and tombstones since an instant
 *     tags: [Federation]
 *     security: [{ federationPeerAuth: [] }]
 *     parameters:
 *       - in: header
 *         name: X-Soundspan-Embedding-Space-Accept
 *         required: false
 *         schema: { type: string, enum: ["1"] }
 *         description: Advertises that the consumer validates embedding-space identities
 *     responses:
 *       200:
 *         description: Bounded delta page
 *         headers:
 *           X-Soundspan-Embedding-Space:
 *             description: JSON embedding-space tuple when the body carries vectors; preprocessingHash is additive and may be absent from older 2.3 peers
 *             schema: { type: string }
 *       409: { description: Catalog epoch mismatch; full resync required }
 *       429: { description: Federation peer rate limit exceeded }
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
        const response = await getFederationCatalogDelta({
            since: parsed.data.since,
            epoch: parsed.data.epoch,
            cursor,
            limit: parsed.data.limit,
            ...embeddingExportRequest(req),
        });
        const result = response.body;
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
        if (result.kind === "staleCursor") {
            return sendRouteError(
                res,
                409,
                "Federation catalog cursor is stale",
                {
                    code: "FEDERATION_STALE_CURSOR",
                    currentEpoch: result.currentEpoch,
                },
            );
        }
        return sendCatalogResponse(res, response);
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
 *       429: { description: Federation peer rate limit exceeded }
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

/** @openapi
 * /api/federation/v1/cover/audiobook/{audiobookId}:
 *   get:
 *     summary: Get cover art for an exported audiobook
 *     tags: [Federation]
 *     security: [{ federationPeerAuth: [] }]
 *     responses:
 *       200: { description: Cover image bytes }
 *       404: { description: Exported audiobook or cover not found }
 *       429: { description: Federation peer rate limit exceeded }
 */
router.get(
    "/cover/audiobook/:audiobookId",
    requireFederationPeer("library:read"),
    federationPeerLimiter,
    asyncHandler(async (req, res) => {
        const params = audiobookParamsSchema.safeParse(req.params);
        const query = emptyQuerySchema.safeParse(req.query);
        if (!params.success || !query.success) return validationError(res);
        const exported = await findExportedFederationAudiobook(
            params.data.audiobookId,
        );
        if (!exported) {
            return sendRouteError(res, 404, "Audiobook cover not found");
        }
        req.params.id = exported.id;
        return handleAudiobookCover(req as Request<{ id: string }>, res);
    }),
);

async function streamExportedTrack(
    req: Request,
    res: Response,
    trackId: string,
    quality: Quality,
    pacing: Transform | null,
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
            pacing ?? undefined,
        );
        return undefined;
    } finally {
        service.destroy();
    }
}

function authenticatedStreamLimits(req: Request) {
    const peer = req.federationPeer;
    if (!peer) throw new Error("Federation stream peer is unavailable");
    return {
        peerId: peer.id,
        maxConcurrentStreams: peer.maxConcurrentStreams,
        maxStreamKbps: peer.maxStreamKbps,
    };
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
 *       429: { description: Federation peer rate limit exceeded }
 */
router.get(
    "/stream/:trackId",
    requireFederationPeer("stream:read"),
    federationPeerLimiter,
    asyncHandler(async (req, res) => {
        const params = trackParamsSchema.safeParse(req.params);
        const query = streamQuerySchema.safeParse(req.query);
        if (!params.success || !query.success) return validationError(res);
        return withFederationStreamControls(
            req,
            res,
            authenticatedStreamLimits(req),
            (pacing) =>
                streamExportedTrack(
                    req,
                    res,
                    params.data.trackId,
                    query.data.quality,
                    pacing,
                ),
        );
    }),
);

const AUDIOBOOK_STREAM_HEADERS = [
    "content-type",
    "content-length",
    "accept-ranges",
    "content-range",
] as const;

function copyAudiobookStreamHeaders(
    res: Response,
    headers: Record<string, unknown>,
): void {
    for (const name of AUDIOBOOK_STREAM_HEADERS) {
        const value = headers[name];
        if (typeof value === "string" || typeof value === "number") {
            res.setHeader(name, String(value));
        }
    }
    if (!res.hasHeader("accept-ranges")) {
        res.setHeader("accept-ranges", "bytes");
    }
}

/** @openapi
 * /api/federation/v1/stream/audiobook/{audiobookId}:
 *   get:
 *     summary: Stream an exported audiobook through its Audiobookshelf proxy
 *     tags: [Federation]
 *     security: [{ federationPeerAuth: [] }]
 *     responses:
 *       200: { description: Full audiobook response }
 *       206: { description: Partial audiobook response }
 *       404: { description: Exported audiobook not found }
 *       429: { description: Federation peer rate limit exceeded }
 */
router.get(
    "/stream/audiobook/:audiobookId",
    requireFederationPeer("stream:read"),
    federationPeerLimiter,
    asyncHandler(async (req, res) => {
        const params = audiobookParamsSchema.safeParse(req.params);
        const query = emptyQuerySchema.safeParse(req.query);
        if (!params.success || !query.success) return validationError(res);
        return withFederationStreamControls(
            req,
            res,
            authenticatedStreamLimits(req),
            async (pacing) => {
                const exported = await findExportedFederationAudiobook(
                    params.data.audiobookId,
                );
                if (!exported) {
                    return sendRouteError(res, 404, "Audiobook not found");
                }
                const range =
                    typeof req.headers.range === "string"
                        ? req.headers.range
                        : undefined;
                const result = await audiobookshelfService.streamAudiobook(
                    exported.id,
                    range,
                    { request: req, response: res },
                );
                res.status(result.status || (range ? 206 : 200));
                copyAudiobookStreamHeaders(res, result.headers);
                if (pacing) await pipeline(result.stream, pacing, res);
                else await pipeline(result.stream, res);
                return undefined;
            },
        );
    }),
);

export default router;
