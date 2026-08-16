import type { Request, Response, Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../utils/db";
import { encrypt } from "../../utils/encryption";
import {
    generateAppPasswordSecret,
    MAX_ACTIVE_APP_PASSWORDS,
} from "../../utils/appPasswords";
import { requireAuth, requireInteractiveSession } from "../../middleware/auth";
import { apiLimiter, authLimiter } from "../../middleware/rateLimiter";
import {
    acquireUserScopedLock,
    USER_LOCK_NAMESPACES,
} from "../../utils/advisoryLocks";
import { sendRouteError } from "../routeErrorResponse";
import { credentialLog, resourceIdParamsSchema } from "./shared";

const appPasswordSchema = z
    .object({
        displayName: z.string().trim().min(1).max(64),
    })
    .strict();

async function listAppPasswordsHandler(
    req: Request,
    res: Response,
): Promise<Response> {
    try {
        const appPasswords = await prisma.appPassword.findMany({
            where: { userId: req.user!.id, revokedAt: null },
            select: {
                id: true,
                displayName: true,
                createdAt: true,
                lastUsedAt: true,
            },
            orderBy: { createdAt: "desc" },
        });
        return res.json({ appPasswords });
    } catch (error) {
        credentialLog.error("List app passwords failed", { error });
        return sendRouteError(res, 500, "Failed to list app passwords");
    }
}

async function createAppPasswordHandler(
    req: Request,
    res: Response,
): Promise<Response> {
    const parsed = appPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
        return sendRouteError(
            res,
            400,
            "Display name must be between 1 and 64 characters",
        );
    }
    try {
        const result = await prisma.$transaction((tx) =>
            createAppPasswordInTransaction(
                tx,
                req.user!.id,
                parsed.data.displayName,
            ),
        );
        if (result.kind === "capReached") {
            return sendRouteError(
                res,
                400,
                `A maximum of ${MAX_ACTIVE_APP_PASSWORDS} active app passwords is allowed`,
            );
        }
        return res.status(201).json({ appPassword: result.appPassword });
    } catch (error) {
        credentialLog.error("Create app password failed", { error });
        return sendRouteError(res, 500, "Failed to create app password");
    }
}

type AppPasswordCreationResult =
    | { kind: "capReached" }
    | {
          kind: "created";
          appPassword: {
              id: string;
              displayName: string;
              createdAt: Date;
              lastUsedAt: Date | null;
              secret: string;
          };
      };

async function createAppPasswordInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    displayName: string,
): Promise<AppPasswordCreationResult> {
    await acquireUserScopedLock(
        tx,
        USER_LOCK_NAMESPACES.appPasswordCreate,
        userId,
    );
    const activeCount = await tx.appPassword.count({
        where: { userId, revokedAt: null },
    });
    if (activeCount >= MAX_ACTIVE_APP_PASSWORDS) return { kind: "capReached" };
    const secret = generateAppPasswordSecret();
    const appPassword = await tx.appPassword.create({
        data: { userId, displayName, encryptedSecret: encrypt(secret) },
        select: {
            id: true,
            displayName: true,
            createdAt: true,
            lastUsedAt: true,
        },
    });
    return { kind: "created", appPassword: { ...appPassword, secret } };
}

async function revokeAppPasswordHandler(
    req: Request<{ id: string }>,
    res: Response,
): Promise<Response> {
    const params = resourceIdParamsSchema.safeParse(req.params);
    if (!params.success) {
        return sendRouteError(res, 404, "App password not found");
    }
    try {
        const revoked = await prisma.appPassword.updateMany({
            where: {
                id: params.data.id,
                userId: req.user!.id,
                revokedAt: null,
            },
            data: { revokedAt: new Date() },
        });
        if (revoked.count === 0) {
            return sendRouteError(res, 404, "App password not found");
        }
        return res.json({ message: "App password revoked" });
    } catch (error) {
        credentialLog.error("Revoke app password failed", { error });
        return sendRouteError(res, 500, "Failed to revoke app password");
    }
}

/** Register app-password management routes. */
export default function registerAppPasswordRoutes(router: Router): void {
    /**
     * @openapi
     * /api/auth/app-passwords:
     *   get:
     *     summary: List active app passwords for the current user
     *     tags: [Authentication]
     *     security:
     *       - bearerAuth: []
     *       - apiKeyAuth: []
     *     responses:
     *       200:
     *         description: Active app-password metadata without secrets
     *       401:
     *         description: Not authenticated
     */
    router.get(
        "/app-passwords",
        apiLimiter,
        requireAuth,
        listAppPasswordsHandler,
    );

    /**
     * @openapi
     * /api/auth/app-passwords:
     *   post:
     *     summary: Create an app password for the current user
     *     tags: [Authentication]
     *     security:
     *       - bearerAuth: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [displayName]
     *             properties:
     *               displayName:
     *                 type: string
     *                 minLength: 1
     *                 maxLength: 64
     *     responses:
     *       201:
     *         description: App password with its one-time plaintext secret
     *       400:
     *         description: Invalid request or active app-password cap reached
     *       401:
     *         description: Not authenticated
     *       403:
     *         description: Interactive session authentication required
     */
    router.post(
        "/app-passwords",
        authLimiter,
        requireAuth,
        requireInteractiveSession,
        createAppPasswordHandler,
    );

    /**
     * @openapi
     * /api/auth/app-passwords/{id}:
     *   delete:
     *     summary: Revoke an owned app password
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
     *         description: App password revoked
     *       401:
     *         description: Not authenticated
     *       403:
     *         description: Interactive session authentication required
     *       404:
     *         description: App password not found
     */
    router.delete(
        "/app-passwords/:id",
        authLimiter,
        requireAuth,
        requireInteractiveSession,
        revokeAppPasswordHandler,
    );
}
