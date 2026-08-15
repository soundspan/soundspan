import { Router, type Response } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { asyncHandler } from "../middleware/asyncHandler";
import {
    createFederationPairingCode,
    createHostFederationPeer,
    deleteFederationPeer,
    FEDERATION_SCOPE_VALUES,
    listFederationPeers,
    revokeFederationPeer,
    rotateFederationPeerCredential,
} from "../services/federationPeers";
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

function invalidRequest(res: Response): Response {
    return sendRouteError(res, 400, "Invalid federation peer request");
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
 */
router.post(
    "/peers",
    asyncHandler(async (req, res) => {
        const parsed = createPeerSchema.safeParse(req.body);
        if (!parsed.success || !req.user) return invalidRequest(res);
        const result = await createHostFederationPeer({
            ...parsed.data,
            createdById: req.user.id,
        });
        return res.status(201).json(result);
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
 * /api/federation/admin/peers/{id}:
 *   delete:
 *     summary: Permanently delete a federation peer
 *     tags: [Federation Admin]
 *     security: [{ sessionAuth: [] }, { bearerAuth: [] }]
 *     responses:
 *       204: { description: Federation peer deleted }
 *       404: { description: Federation peer not found }
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
