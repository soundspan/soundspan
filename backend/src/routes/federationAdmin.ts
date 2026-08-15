import { Router, type Response } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import {
    createFederationPairingCode,
    createHostFederationPeer,
    deleteFederationPeer,
    FEDERATION_SCOPE_VALUES,
    FederationPeerConflictError,
    linkConsumerFederationPeer,
    listFederationPeers,
    pairAndLinkConsumerFederationPeer,
    revokeFederationPeer,
    rotateFederationPeerCredential,
} from "../services/federationPeers";
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
const createPeerSchema = z.strictObject({
    direction: z.literal("HOST").optional(),
    name: z.string().trim().min(1).max(120),
    scopes: scopesSchema,
    baseUrl: httpsUrlSchema.optional(),
});
const pairingCodeSchema = z.strictObject({
    scopes: scopesSchema.default(["library:read", "stream:read"]),
});
const peerParamsSchema = z.strictObject({
    id: z.string().trim().min(1).max(128),
});
const consumerLinkSchema = z.strictObject({
    direction: z.literal("CONSUMER").optional(),
    baseUrl: httpsUrlSchema,
    token: z.string().trim().min(1).max(4_096),
    name: z.string().trim().min(1).max(120).optional(),
});
const consumerPairSchema = z.strictObject({
    direction: z.literal("CONSUMER").optional(),
    baseUrl: httpsUrlSchema,
    code: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-HJ-NP-Z2-9]{8}$/),
    name: z.string().trim().min(1).max(120),
});

function invalidRequest(res: Response): Response {
    return sendRouteError(res, 400, "Invalid federation peer request");
}

function directionError(res: Response, body: unknown): Response | null {
    if (
        body &&
        typeof body === "object" &&
        "direction" in body &&
        (body as { direction?: unknown }).direction === "BOTH"
    ) {
        return sendRouteError(res, 400, "Peer direction BOTH is not supported");
    }
    return null;
}

router.use(requireAuth, requireAdmin);

/** @openapi
 * /api/federation/admin/peers:
 *   get:
 *     summary: List federation peers without credential material
 *     tags: [Federation Admin]
 *     security: [{ sessionAuth: [] }, { bearerAuth: [] }]
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
 * /api/federation/admin/peers:
 *   post:
 *     summary: Create a host-direction federation credential
 *     tags: [Federation Admin]
 *     security: [{ sessionAuth: [] }, { bearerAuth: [] }]
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
            return directionError(res, req.body) ?? invalidRequest(res);
        }
        const result = await createHostFederationPeer({
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
 *     summary: Validate and link a consumer-direction federation peer
 *     tags: [Federation Admin]
 *     security: [{ sessionAuth: [] }, { bearerAuth: [] }]
 *     responses:
 *       201: { description: Consumer peer linked }
 *       400: { description: Invalid link input }
 *       429: { description: Request rate limit exceeded }
 *       502: { description: Peer manifest validation failed }
 */
router.post(
    "/peers/link",
    asyncHandler(async (req, res) => {
        const parsed = consumerLinkSchema.safeParse(req.body);
        if (!parsed.success || !req.user) {
            return directionError(res, req.body) ?? invalidRequest(res);
        }
        try {
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
            return sendRouteError(res, 502, "Peer manifest validation failed", {
                code: "FEDERATION_PEER_INVALID",
            });
        }
    }),
);

/** @openapi
 * /api/federation/admin/peers/link/pair:
 *   post:
 *     summary: Pair and link a consumer-direction federation peer
 *     tags: [Federation Admin]
 *     security: [{ sessionAuth: [] }, { bearerAuth: [] }]
 *     responses:
 *       201: { description: Consumer peer paired and linked }
 *       400: { description: Invalid pairing input }
 *       429: { description: Request rate limit exceeded }
 *       502: { description: Peer pairing or manifest validation failed }
 */
router.post(
    "/peers/link/pair",
    asyncHandler(async (req, res) => {
        const parsed = consumerPairSchema.safeParse(req.body);
        if (!parsed.success || !req.user) {
            return directionError(res, req.body) ?? invalidRequest(res);
        }
        try {
            const peer = await pairAndLinkConsumerFederationPeer({
                ...parsed.data,
                createdById: req.user.id,
            });
            return res.status(201).json({ peer });
        } catch (_error: unknown) {
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
 *     security: [{ sessionAuth: [] }, { bearerAuth: [] }]
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
 *     security: [{ sessionAuth: [] }, { bearerAuth: [] }]
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
 *     security: [{ sessionAuth: [] }, { bearerAuth: [] }]
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
 *     security: [{ sessionAuth: [] }, { bearerAuth: [] }]
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
 *     security: [{ sessionAuth: [] }, { bearerAuth: [] }]
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
