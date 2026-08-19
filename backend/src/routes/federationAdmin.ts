import { Router, type Response } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import {
    createFederationPairingCode,
    createBothFederationPeer,
    createHostFederationPeer,
    deleteFederationPeer,
    FEDERATION_SCOPE_VALUES,
    FederationPeerConflictError,
    FederationScopeMismatchError,
    linkConsumerFederationPeer,
    listFederationPeers,
    pairAndLinkConsumerFederationPeer,
    revokeFederationPeer,
    rotateFederationPeerCredential,
    updateFederationPeerSettings,
} from "../services/federationPeers";
import {
    arbitrateFederationTrackDedup,
    listFederationPeerDedup,
} from "../services/federationDedupArbitration";
import { listFederationPeerHealth } from "../services/federationPeerHealth";
import { enqueueFederationSyncNow } from "../workers/federationJobs";
import { sendRouteError } from "./routeErrorResponse";

const router = Router();
const scopeSchema = z.enum(FEDERATION_SCOPE_VALUES);
const scopesSchema = z
    .array(scopeSchema)
    .min(1)
    .max(FEDERATION_SCOPE_VALUES.length)
    .refine((values) => new Set(values).size === values.length)
    .refine(
        (values) =>
            !values.includes("embeddings:read") ||
            values.includes("library:read"),
    );
const httpsUrlSchema = z
    .url()
    .refine((value) => new URL(value).protocol === "https:");
const hostPeerSchema = z.strictObject({
    direction: z.literal("HOST").optional(),
    name: z.string().trim().min(1).max(120),
    scopes: scopesSchema,
    baseUrl: httpsUrlSchema.optional(),
});
const bothPeerSchema = z.strictObject({
    direction: z.literal("BOTH"),
    name: z.string().trim().min(1).max(120),
    scopes: scopesSchema,
    baseUrl: httpsUrlSchema,
    token: z.string().trim().min(1).max(4_096),
});
const createPeerSchema = z.union([hostPeerSchema, bothPeerSchema]);
const pairingCodeSchema = z.strictObject({
    scopes: scopesSchema.default(["library:read", "stream:read"]),
});
const peerParamsSchema = z.strictObject({
    id: z.string().trim().min(1).max(128),
});
const consumerOnlyLinkSchema = z.strictObject({
    direction: z.literal("CONSUMER").optional(),
    baseUrl: httpsUrlSchema,
    token: z.string().trim().min(1).max(4_096),
    name: z.string().trim().min(1).max(120).optional(),
});
const bothLinkSchema = z.strictObject({
    direction: z.literal("BOTH"),
    baseUrl: httpsUrlSchema,
    token: z.string().trim().min(1).max(4_096),
    name: z.string().trim().min(1).max(120).optional(),
    scopes: scopesSchema,
});
const consumerLinkSchema = z.union([consumerOnlyLinkSchema, bothLinkSchema]);
const consumerPairSchema = z.strictObject({
    direction: z.enum(["CONSUMER", "BOTH"]).default("CONSUMER"),
    baseUrl: httpsUrlSchema,
    code: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-HJ-NP-Z2-9]{8}$/),
    name: z.string().trim().min(1).max(120),
    scopes: scopesSchema.default(["library:read", "stream:read"]),
});
const peerSettingsSchema = z.strictObject({
    showDedupedCopies: z.boolean().optional(),
    maxConcurrentStreams: z.number().int().min(1).max(64).nullable().optional(),
    maxStreamKbps: z.number().int().min(64).max(100_000).nullable().optional(),
});
const dedupListQuerySchema = z.strictObject({
    cursor: z.string().trim().min(1).max(128).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
});
const dedupActionSchema = z.discriminatedUnion("action", [
    z.strictObject({
        action: z.literal("link"),
        localTrackId: z.string().trim().min(1).max(128),
    }),
    z.strictObject({ action: z.literal("unlink") }),
    z.strictObject({ action: z.literal("reset") }),
]);

function invalidRequest(res: Response): Response {
    return sendRouteError(res, 400, "Invalid federation peer request");
}

router.use(requireAuth, requireAdmin);

/** @openapi
 * /api/federation/admin/peers:
 *   get:
 *     summary: List federation peers with independent inbound and outbound statuses
 *     tags: [Federation Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Federation peer list }
 *       403: { description: Administrator access required }
 *       429: { description: Request rate limit exceeded }
 */
router.get(
    "/peers",
    asyncHandler(async (_req, res) => {
        return res.json({ peers: await listFederationPeers() });
    }),
);

/** @openapi
 * /api/federation/admin/peers/health:
 *   get:
 *     summary: List bounded per-peer federation health and catalog status
 *     tags: [Federation Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Federation peer health list }
 *       403: { description: Administrator access required }
 *       429: { description: Request rate limit exceeded }
 */
router.get(
    "/peers/health",
    asyncHandler(async (_req, res) => {
        return res.json({ peers: await listFederationPeerHealth() });
    }),
);

/** @openapi
 * /api/federation/admin/peers/{id}/settings:
 *   patch:
 *     summary: Update per-peer duplicate visibility and host stream caps
 *     tags: [Federation Admin]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: false
 *             properties:
 *               showDedupedCopies: { type: boolean }
 *               maxConcurrentStreams: { type: integer, minimum: 1, maximum: 64, nullable: true }
 *               maxStreamKbps: { type: integer, minimum: 64, maximum: 100000, nullable: true }
 *     responses:
 *       200: { description: Updated public federation peer }
 *       400: { description: Invalid settings }
 *       404: { description: Federation peer not found }
 */
router.patch(
    "/peers/:id/settings",
    asyncHandler(async (req, res) => {
        const params = peerParamsSchema.safeParse(req.params);
        const body = peerSettingsSchema.safeParse(req.body);
        if (!params.success || !body.success) return invalidRequest(res);
        const peer = await updateFederationPeerSettings(
            params.data.id,
            body.data,
        );
        if (!peer) {
            return sendRouteError(res, 404, "Federation peer not found");
        }
        return res.json(peer);
    }),
);

/** @openapi
 * /api/federation/admin/peers/{id}/dedup:
 *   get:
 *     summary: List linked or pinned federated tracks for one peer
 *     tags: [Federation Admin]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: query, name: cursor, schema: { type: string } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100, default: 50 } }
 *     responses:
 *       200: { description: Keyset page of dedup arbitration rows }
 *       400: { description: Invalid pagination }
 *       404: { description: Federation peer not found }
 */
router.get(
    "/peers/:id/dedup",
    asyncHandler(async (req, res) => {
        const params = peerParamsSchema.safeParse(req.params);
        const query = dedupListQuerySchema.safeParse(req.query);
        if (!params.success || !query.success) return invalidRequest(res);
        const page = await listFederationPeerDedup({
            peerId: params.data.id,
            cursor: query.data.cursor,
            limit: query.data.limit,
        });
        if (!page) {
            return sendRouteError(res, 404, "Federation peer not found");
        }
        return res.json(page);
    }),
);

/** @openapi
 * /api/federation/admin/tracks/{id}/dedup:
 *   post:
 *     summary: Pin, unlink, or reset one federated track dedup decision
 *     tags: [Federation Admin]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             oneOf:
 *               - { type: object, required: [action, localTrackId], properties: { action: { type: string, enum: [link] }, localTrackId: { type: string } } }
 *               - { type: object, required: [action], properties: { action: { type: string, enum: [unlink, reset] } } }
 *     responses:
 *       200: { description: Updated dedup arbitration row }
 *       400: { description: Invalid action }
 *       404: { description: Federated track or local link target not found }
 */
router.post(
    "/tracks/:id/dedup",
    asyncHandler(async (req, res) => {
        const params = peerParamsSchema.safeParse(req.params);
        const body = dedupActionSchema.safeParse(req.body);
        if (!params.success || !body.success) return invalidRequest(res);
        const result = await arbitrateFederationTrackDedup(
            params.data.id,
            body.data,
        );
        if (!result) {
            return sendRouteError(
                res,
                404,
                "Federation dedup resource not found",
            );
        }
        return res.json(result);
    }),
);

/** @openapi
 * /api/federation/admin/peers:
 *   post:
 *     summary: Create a host or bidirectional federation peer
 *     tags: [Federation Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Peer and one-time credential }
 *       400: { description: Invalid peer input }
 *       429: { description: Request rate limit exceeded }
 */
router.post(
    "/peers",
    asyncHandler(async (req, res) => {
        const parsed = createPeerSchema.safeParse(req.body);
        if (!parsed.success || !req.user) {
            return invalidRequest(res);
        }
        const result =
            parsed.data.direction === "BOTH"
                ? await createBothFederationPeer({
                      name: parsed.data.name,
                      scopes: parsed.data.scopes,
                      baseUrl: parsed.data.baseUrl,
                      outboundToken: parsed.data.token,
                      createdById: req.user.id,
                  })
                : await createHostFederationPeer({
                      name: parsed.data.name,
                      scopes: parsed.data.scopes,
                      baseUrl: parsed.data.baseUrl,
                      createdById: req.user.id,
                  });
        return res.status(201).json(result);
    }),
);

/** @openapi
 * /api/federation/admin/peers/link:
 *   post:
 *     summary: Validate and link a consumer or bidirectional federation peer
 *     tags: [Federation Admin]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [baseUrl, token]
 *             properties:
 *               direction:
 *                 type: string
 *                 enum: [CONSUMER, BOTH]
 *                 default: CONSUMER
 *                 description: BOTH explicitly enables sharing this instance back to the linked peer; omission creates a consumer-only link.
 *               baseUrl: { type: string, format: uri }
 *               token: { type: string }
 *               name: { type: string }
 *               scopes:
 *                 type: array
 *                 items: { type: string, enum: [library:read, stream:read, embeddings:read] }
 *     responses:
 *       201: { description: Consumer peer linked }
 *       400: { description: Invalid link input }
 *       422: { description: Requested and peer scopes do not overlap }
 *       429: { description: Request rate limit exceeded }
 *       502: { description: Peer manifest validation failed }
 */
router.post(
    "/peers/link",
    asyncHandler(async (req, res) => {
        const parsed = consumerLinkSchema.safeParse(req.body);
        if (!parsed.success || !req.user) {
            return invalidRequest(res);
        }
        try {
            if (parsed.data.direction === "BOTH") {
                const result = await createBothFederationPeer({
                    baseUrl: parsed.data.baseUrl,
                    outboundToken: parsed.data.token,
                    name: parsed.data.name,
                    scopes: parsed.data.scopes,
                    createdById: req.user.id,
                });
                return res.status(201).json(result);
            }
            const peer = await linkConsumerFederationPeer({
                ...parsed.data,
                createdById: req.user.id,
            });
            return res.status(201).json({ peer });
        } catch (error: unknown) {
            if (error instanceof FederationPeerConflictError) {
                return sendRouteError(
                    res,
                    409,
                    "Federation consumer peer already exists",
                    { code: "FEDERATION_PEER_CONFLICT" },
                );
            }
            if (error instanceof FederationScopeMismatchError) {
                return sendRouteError(
                    res,
                    422,
                    "Federation peer scopes do not overlap",
                    { code: error.code },
                );
            }
            return sendRouteError(res, 502, "Peer manifest validation failed", {
                code: "FEDERATION_PEER_INVALID",
            });
        }
    }),
);

/** @openapi
 * /api/federation/admin/peers/link/pair:
 *   post:
 *     summary: Pair a consumer peer with optional reciprocal sharing
 *     tags: [Federation Admin]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [baseUrl, code, name]
 *             properties:
 *               direction:
 *                 type: string
 *                 enum: [CONSUMER, BOTH]
 *                 default: CONSUMER
 *                 description: BOTH opts into a reciprocal callback and library grant; omission never shares this instance back.
 *               baseUrl: { type: string, format: uri }
 *               code: { type: string, pattern: '^[A-HJ-NP-Z2-9]{8}$' }
 *               name: { type: string }
 *               scopes:
 *                 type: array
 *                 items: { type: string, enum: [library:read, stream:read, embeddings:read] }
 *     responses:
 *       201: { description: Consumer peer paired and linked }
 *       400: { description: Invalid pairing input }
 *       422: { description: Requested and peer scopes do not overlap }
 *       429: { description: Request rate limit exceeded }
 *       502: { description: Peer pairing or manifest validation failed }
 */
router.post(
    "/peers/link/pair",
    asyncHandler(async (req, res) => {
        const parsed = consumerPairSchema.safeParse(req.body);
        if (!parsed.success || !req.user) {
            return invalidRequest(res);
        }
        try {
            const result = await pairAndLinkConsumerFederationPeer({
                ...parsed.data,
                createdById: req.user.id,
            });
            return res.status(201).json(result);
        } catch (error: unknown) {
            if (error instanceof FederationScopeMismatchError) {
                return sendRouteError(
                    res,
                    422,
                    "Federation peer scopes do not overlap",
                    { code: error.code },
                );
            }
            return sendRouteError(res, 502, "Peer pairing failed", {
                code: "FEDERATION_PAIR_FAILED",
            });
        }
    }),
);

/** @openapi
 * /api/federation/admin/peers/{id}/rotate:
 *   post:
 *     summary: Rotate a federation peer credential
 *     tags: [Federation Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Peer and replacement one-time credential }
 *       404: { description: Federation peer not found }
 *       429: { description: Request rate limit exceeded }
 */
router.post(
    "/peers/:id/rotate",
    asyncHandler(async (req, res) => {
        const parsed = peerParamsSchema.safeParse(req.params);
        if (!parsed.success) return invalidRequest(res);
        const result = await rotateFederationPeerCredential(parsed.data.id);
        if (!result)
            return sendRouteError(res, 404, "Federation peer not found");
        return res.json(result);
    }),
);

/** @openapi
 * /api/federation/admin/peers/{id}/revoke:
 *   post:
 *     summary: Revoke a federation peer while retaining its audit row
 *     tags: [Federation Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Federation peer revoked }
 *       404: { description: Federation peer not found }
 *       429: { description: Request rate limit exceeded }
 */
router.post(
    "/peers/:id/revoke",
    asyncHandler(async (req, res) => {
        const parsed = peerParamsSchema.safeParse(req.params);
        if (!parsed.success) return invalidRequest(res);
        if (!(await revokeFederationPeer(parsed.data.id))) {
            return sendRouteError(res, 404, "Federation peer not found");
        }
        return res.json({ success: true });
    }),
);

/** @openapi
 * /api/federation/admin/peers/{id}/sync:
 *   post:
 *     summary: Enqueue an immediate consumer catalog sync
 *     tags: [Federation Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       202: { description: Sync job queued or coalesced }
 *       400: { description: Invalid peer id }
 *       429: { description: Request rate limit exceeded }
 */
router.post(
    "/peers/:id/sync",
    asyncHandler(async (req, res) => {
        const parsed = peerParamsSchema.safeParse(req.params);
        if (!parsed.success) return invalidRequest(res);
        await enqueueFederationSyncNow(parsed.data.id);
        return res.status(202).json({ queued: true });
    }),
);

/** @openapi
 * /api/federation/admin/peers/{id}:
 *   delete:
 *     summary: Permanently delete a federation peer
 *     tags: [Federation Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       204: { description: Federation peer deleted }
 *       404: { description: Federation peer not found }
 *       429: { description: Request rate limit exceeded }
 */
router.delete(
    "/peers/:id",
    asyncHandler(async (req, res) => {
        const parsed = peerParamsSchema.safeParse(req.params);
        if (!parsed.success) return invalidRequest(res);
        if (!(await deleteFederationPeer(parsed.data.id))) {
            return sendRouteError(res, 404, "Federation peer not found");
        }
        return res.status(204).end();
    }),
);

/** @openapi
 * /api/federation/admin/pairing-codes:
 *   post:
 *     summary: Create a short-lived federation pairing code
 *     tags: [Federation Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Eight-character pairing code and expiry }
 *       400: { description: Invalid scope input }
 *       429: { description: Request rate limit exceeded }
 */
router.post(
    "/pairing-codes",
    asyncHandler(async (req, res) => {
        const parsed = pairingCodeSchema.safeParse(req.body ?? {});
        if (!parsed.success || !req.user) return invalidRequest(res);
        const code = await createFederationPairingCode({
            createdById: req.user.id,
            scopes: parsed.data.scopes,
        });
        return res.status(201).json(code);
    }),
);

export default router;
