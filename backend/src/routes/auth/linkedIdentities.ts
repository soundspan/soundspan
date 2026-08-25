import type { Request, Response, Router } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { requireAuth, requireInteractiveSession } from "../../middleware/auth";
import { apiLimiter, authLimiter } from "../../middleware/rateLimiter";
import {
    acquireUserScopedLock,
    USER_LOCK_NAMESPACES,
} from "../../utils/advisoryLocks";
import { sendRouteError } from "../../utils/routeErrorResponse";
import { credentialLog, hasErrorCode, resourceIdParamsSchema } from "./shared";

type UnlinkIdentityResult = "notFound" | "lastCredential" | "unlinked";

async function unlinkIdentityInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    identityId: string,
): Promise<UnlinkIdentityResult> {
    await acquireUserScopedLock(
        tx,
        USER_LOCK_NAMESPACES.identityUnlink,
        userId,
    );
    const identity = await tx.externalIdentity.findFirst({
        where: { id: identityId, userId },
        select: { id: true },
    });
    if (!identity) return "notFound";
    const user = await tx.user.findUnique({
        where: { id: userId },
        select: { passwordHash: true },
    });
    if (!user) return "notFound";
    const identityCount = await tx.externalIdentity.count({
        where: { userId },
    });
    if (user.passwordHash === null && identityCount <= 1) {
        return "lastCredential";
    }
    await tx.externalIdentity.delete({ where: { id: identity.id } });
    return "unlinked";
}

async function listIdentitiesHandler(
    req: Request,
    res: Response,
): Promise<Response> {
    try {
        const rows = await prisma.externalIdentity.findMany({
            where: { userId: req.user!.id },
            select: {
                id: true,
                provider: true,
                providerSubject: true,
                email: true,
                displayName: true,
                createdAt: true,
            },
            orderBy: { createdAt: "desc" },
        });
        const identities = rows.map(({ providerSubject, ...identity }) => ({
            ...identity,
            subjectHint: `${providerSubject.slice(0, 8)}…`,
        }));
        return res.json({ identities });
    } catch (error) {
        credentialLog.error("List external identities failed", { error });
        return sendRouteError(res, 500, "Failed to list identities");
    }
}

async function unlinkIdentityHandler(
    req: Request<{ id: string }>,
    res: Response,
): Promise<Response> {
    const params = resourceIdParamsSchema.safeParse(req.params);
    if (!params.success) return sendRouteError(res, 404, "Identity not found");
    try {
        const result = await prisma.$transaction((tx) =>
            unlinkIdentityInTransaction(tx, req.user!.id, params.data.id),
        );
        if (result === "notFound") {
            return sendRouteError(res, 404, "Identity not found");
        }
        if (result === "lastCredential") {
            return sendRouteError(
                res,
                400,
                "Cannot unlink the last sign-in method",
            );
        }
        return res.json({ message: "Identity unlinked" });
    } catch (error) {
        if (hasErrorCode(error, "P2025")) {
            return sendRouteError(res, 404, "Identity not found");
        }
        credentialLog.error("Unlink external identity failed", { error });
        return sendRouteError(res, 500, "Failed to unlink identity");
    }
}

/** Register linked-identity management routes. */
export default function registerLinkedIdentityRoutes(router: Router): void {
    /**
     * @openapi
     * /api/auth/identities:
     *   get:
     *     summary: List external identities for the current user
     *     tags: [Authentication]
     *     security:
     *       - bearerAuth: []
     *       - apiKeyAuth: []
     *     responses:
     *       200:
     *         description: External identity metadata with truncated subject hints
     *       401:
     *         description: Not authenticated
     */
    router.get("/identities", apiLimiter, requireAuth, listIdentitiesHandler);

    /**
     * @openapi
     * /api/auth/identities/{id}:
     *   delete:
     *     summary: Unlink an owned external identity
     *     tags: [Authentication]
     *     security:
     *       - bearerAuth: []
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *     responses:
     *       200:
     *         description: Identity unlinked
     *       400:
     *         description: Unlink would leave the account without a sign-in method
     *       401:
     *         description: Not authenticated
     *       403:
     *         description: Interactive session authentication required
     *       404:
     *         description: Identity not found
     */
    router.delete(
        "/identities/:id",
        authLimiter,
        requireAuth,
        requireInteractiveSession,
        unlinkIdentityHandler,
    );
}
