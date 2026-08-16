import type { Request, Response, Router } from "express";
import type { InviteCode, Prisma } from "@prisma/client";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { requireAdmin, requireAuth } from "../../middleware/auth";
import { apiLimiter, authLimiter } from "../../middleware/rateLimiter";
import {
    InviteCodeExhaustedError,
    InviteCodeValidationError,
    claimInviteCode,
    loadUsableInviteCode,
    recordInviteCodeUsage,
} from "../../services/inviteCodes";
import type { LoginUser } from "../../services/oidcAccountResolution";
import { acquireRoleGuardLock } from "../../utils/advisoryLocks";
import { sendRouteError } from "../routeErrorResponse";
import { hasErrorCode, sendLoginSuccess } from "./shared";

const inviteCodeSchema = z.object({
    ttl: z.enum(["1h", "6h", "24h", "7d", "30d", "never"]),
    maxUses: z.number().int().min(1).max(100).default(1),
});

const registerSchema = z
    .object({
        inviteCode: z.string().min(1),
        username: z
            .string()
            .min(3)
            .max(32)
            .regex(
                /^[a-zA-Z0-9_]+$/,
                "Username must be alphanumeric (underscores allowed)",
            ),
        displayName: z.string().min(1).max(64),
        password: z.string().min(6).max(128),
        confirmPassword: z.string(),
        email: z.string().email(),
    })
    .refine((data) => data.password === data.confirmPassword, {
        message: "Passwords do not match",
        path: ["confirmPassword"],
    });

// Unambiguous character set for invite codes (no 0/O/1/I/L)
const INVITE_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateInviteCode(): string {
    let code = "";
    for (let i = 0; i < 8; i++) {
        code +=
            INVITE_CODE_CHARS[crypto.randomInt(0, INVITE_CODE_CHARS.length)];
    }
    return code;
}

function ttlToExpiresAt(ttl: string): Date | null {
    const now = Date.now();
    switch (ttl) {
        case "1h":
            return new Date(now + 60 * 60 * 1000);
        case "6h":
            return new Date(now + 6 * 60 * 60 * 1000);
        case "24h":
            return new Date(now + 24 * 60 * 60 * 1000);
        case "7d":
            return new Date(now + 7 * 24 * 60 * 60 * 1000);
        case "30d":
            return new Date(now + 30 * 24 * 60 * 60 * 1000);
        case "never":
            return null;
        default:
            return new Date(now + 24 * 60 * 60 * 1000);
    }
}

/** Register invite administration, user administration, and registration routes. */
export default function registerAdminUserInviteRoutes(router: Router): void {
    /**
     * @openapi
     * /api/auth/users:
     *   get:
     *     summary: List all users (admin only)
     *     tags: [Authentication]
     *     security:
     *       - apiKeyAuth: []
     *     responses:
     *       200:
     *         description: List of all users
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 type: object
     *                 required: [id, username, role, createdAt, hasPassword, linkedProviders]
     *                 properties:
     *                   id:
     *                     type: string
     *                   username:
     *                     type: string
     *                   email:
     *                     type: string
     *                     format: email
     *                     nullable: true
     *                   role:
     *                     type: string
     *                     enum: [user, admin]
     *                   onboardingComplete:
     *                     type: boolean
     *                   createdAt:
     *                     type: string
     *                     format: date-time
     *                   hasPassword:
     *                     type: boolean
     *                   linkedProviders:
     *                     type: array
     *                     items:
     *                       type: string
     *       401:
     *         description: Not authenticated
     *       403:
     *         description: Admin access required
     */
    // GET /auth/users (Admin only)
    router.get(
        "/users",
        apiLimiter,
        requireAuth,
        requireAdmin,
        async (req, res) => {
            try {
                const users = await prisma.user.findMany({
                    select: {
                        id: true,
                        username: true,
                        email: true,
                        role: true,
                        onboardingComplete: true,
                        createdAt: true,
                        passwordHash: true,
                        externalIdentities: { select: { provider: true } },
                    },
                    orderBy: { createdAt: "asc" },
                });

                const summaries = users.map(
                    ({ passwordHash, externalIdentities, ...user }) => ({
                        ...user,
                        hasPassword: passwordHash !== null,
                        linkedProviders: externalIdentities.map(
                            (identity) => identity.provider,
                        ),
                    }),
                );
                res.json(summaries);
            } catch (error) {
                logger.error("Get users error:", error);
                res.status(500).json({ error: "Failed to get users" });
            }
        },
    );

    const adminUserUpdateSchema = z.object({
        username: z
            .string()
            .min(3)
            .max(32)
            .regex(
                /^[a-zA-Z0-9_]+$/,
                "Username must be alphanumeric (underscores allowed)",
            )
            .optional(),
        email: z.string().email().optional().nullable(),
        password: z.string().min(6).max(128).optional(),
        role: z.enum(["user", "admin"]).optional(),
    });

    type AdminUserUpdateData = {
        username?: string;
        email?: string | null;
        passwordHash?: string;
        tokenVersion?: { increment: number };
        subsonicPassword?: null;
        role?: "user" | "admin";
    };

    const adminUserSelect = {
        id: true,
        username: true,
        email: true,
        role: true,
        createdAt: true,
    } as const;

    type GuardedUserUpdateResult =
        | { kind: "lastAdmin" }
        | { kind: "notFound" }
        | { kind: "updated"; user: unknown };

    async function buildAdminUserUpdateData(
        data: z.infer<typeof adminUserUpdateSchema>,
    ): Promise<AdminUserUpdateData> {
        const updateData: AdminUserUpdateData = {};
        if (data.username) updateData.username = data.username;
        if (data.email !== undefined) updateData.email = data.email;
        if (data.role) updateData.role = data.role;
        if (data.password) {
            updateData.passwordHash = await bcrypt.hash(data.password, 10);
            updateData.tokenVersion = { increment: 1 };
            updateData.subsonicPassword = null;
        }
        return updateData;
    }

    async function updateUserWithRoleGuard(
        userId: string,
        updateData: AdminUserUpdateData,
    ): Promise<GuardedUserUpdateResult> {
        return prisma.$transaction(async (tx) => {
            await acquireRoleGuardLock(tx);
            const target = await tx.user.findUnique({
                where: { id: userId },
                select: { role: true },
            });
            if (!target) return { kind: "notFound" };
            if (target.role === "admin") {
                const otherAdmins = await tx.user.count({
                    where: { role: "admin", id: { not: userId } },
                });
                if (otherAdmins === 0) return { kind: "lastAdmin" };
            }
            const user = await tx.user.update({
                where: { id: userId },
                data: updateData,
                select: adminUserSelect,
            });
            return { kind: "updated", user };
        });
    }

    async function persistAdminUserUpdate(
        userId: string,
        updateData: AdminUserUpdateData,
    ): Promise<GuardedUserUpdateResult> {
        if (updateData.role === "user") {
            return updateUserWithRoleGuard(userId, updateData);
        }
        const user = await prisma.user.update({
            where: { id: userId },
            data: updateData,
            select: adminUserSelect,
        });
        return { kind: "updated", user };
    }

    /**
     * @openapi
     * /api/auth/create-user:
     *   post:
     *     summary: Create a new user account (admin only)
     *     tags: [Authentication]
     *     security:
     *       - apiKeyAuth: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required:
     *               - username
     *               - password
     *             properties:
     *               username:
     *                 type: string
     *               password:
     *                 type: string
     *                 format: password
     *               role:
     *                 type: string
     *                 enum: [user, admin]
     *     responses:
     *       200:
     *         description: User created successfully
     *       400:
     *         description: Invalid request or username already taken
     *       401:
     *         description: Not authenticated
     *       403:
     *         description: Admin access required
     */
    // POST /auth/create-user (Admin only)
    router.post(
        "/create-user",
        authLimiter,
        requireAuth,
        requireAdmin,
        async (req, res) => {
            try {
                const { username, password, role } = req.body;

                if (!username || !password) {
                    return res
                        .status(400)
                        .json({ error: "Username and password are required" });
                }

                if (password.length < 6) {
                    return res.status(400).json({
                        error: "Password must be at least 6 characters",
                    });
                }

                if (role && !["user", "admin"].includes(role)) {
                    return res.status(400).json({ error: "Invalid role" });
                }

                // Check if username exists
                const existing = await prisma.user.findUnique({
                    where: { username },
                });

                if (existing) {
                    return res
                        .status(400)
                        .json({ error: "Username already taken" });
                }

                // Create user
                const passwordHash = await bcrypt.hash(password, 10);
                const user = await prisma.user.create({
                    data: {
                        username,
                        passwordHash,
                        role: role || "user",
                        onboardingComplete: true, // Skip onboarding for created users
                    },
                });

                // Create default user settings
                await prisma.userSettings.create({
                    data: {
                        userId: user.id,
                        playbackQuality: "original",
                        wifiOnly: false,
                        offlineEnabled: false,
                        maxCacheSizeMb: 10240,
                    },
                });

                res.json({
                    id: user.id,
                    username: user.username,
                    role: user.role,
                    createdAt: user.createdAt,
                });
            } catch (error) {
                logger.error("Create user error:", error);
                res.status(500).json({ error: "Failed to create user" });
            }
        },
    );

    /**
     * @openapi
     * /api/auth/users/{id}:
     *   patch:
     *     summary: Update a user's username, email, password, or role (admin only)
     *     tags: [Authentication]
     *     security:
     *       - apiKeyAuth: []
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The user ID
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               username:
     *                 type: string
     *               email:
     *                 type: string
     *                 format: email
     *               password:
     *                 type: string
     *                 format: password
     *               role:
     *                 type: string
     *                 enum: [user, admin]
     *     responses:
     *       200:
     *         description: User updated successfully
     *       400:
     *         description: Invalid request or no fields to update
     *       401:
     *         description: Not authenticated
     *       403:
     *         description: Admin access required
     *       404:
     *         description: User not found
     */
    // PATCH /auth/users/:id (Admin only) - Edit user's username, email, or password
    router.patch<{ id: string }>(
        "/users/:id",
        authLimiter,
        requireAuth,
        requireAdmin,
        async (req, res) => {
            try {
                const { id } = req.params;
                const data = adminUserUpdateSchema.parse(req.body);

                // Check the target user exists
                const targetUser = await prisma.user.findUnique({
                    where: { id },
                });
                if (!targetUser) {
                    return res.status(404).json({ error: "User not found" });
                }

                // Check username uniqueness if changing
                if (data.username && data.username !== targetUser.username) {
                    const existing = await prisma.user.findUnique({
                        where: { username: data.username },
                    });
                    if (existing) {
                        return res
                            .status(400)
                            .json({ error: "Username already taken" });
                    }
                }

                // Check email uniqueness if changing
                if (data.email && data.email !== targetUser.email) {
                    const existing = await prisma.user.findUnique({
                        where: { email: data.email },
                    });
                    if (existing) {
                        return res
                            .status(400)
                            .json({ error: "Email already in use" });
                    }
                }

                const updateData = await buildAdminUserUpdateData(data);
                if (Object.keys(updateData).length === 0) {
                    return res
                        .status(400)
                        .json({ error: "No fields to update" });
                }
                const result = await persistAdminUserUpdate(id, updateData);
                if (result.kind === "notFound") {
                    return res.status(404).json({ error: "User not found" });
                }
                if (result.kind === "lastAdmin") {
                    return res
                        .status(400)
                        .json({ error: "Cannot demote the last admin" });
                }
                return res.json(result.user);
            } catch (err) {
                if (err instanceof z.ZodError) {
                    const firstError = err.issues[0];
                    return res.status(400).json({
                        error: firstError.message,
                        details: err.issues,
                    });
                }
                logger.error("Update user error:", err);
                res.status(500).json({ error: "Failed to update user" });
            }
        },
    );

    type DeleteUserResult = "deleted" | "lastAdmin" | "notFound";

    async function deleteUserWithRoleGuard(
        userId: string,
    ): Promise<DeleteUserResult> {
        return prisma.$transaction(async (tx) => {
            await acquireRoleGuardLock(tx);
            const target = await tx.user.findUnique({
                where: { id: userId },
                select: { role: true },
            });
            if (!target) return "notFound";
            if (target.role === "admin") {
                const otherAdmins = await tx.user.count({
                    where: { role: "admin", id: { not: userId } },
                });
                if (otherAdmins === 0) return "lastAdmin";
            }
            await tx.user.delete({ where: { id: userId } });
            return "deleted";
        });
    }

    /**
     * @openapi
     * /api/auth/users/{id}:
     *   delete:
     *     summary: Delete a user account (admin only)
     *     tags: [Authentication]
     *     security:
     *       - apiKeyAuth: []
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The user ID
     *     responses:
     *       200:
     *         description: User deleted successfully
     *       400:
     *         description: Cannot delete your own account
     *       401:
     *         description: Not authenticated
     *       403:
     *         description: Admin access required
     *       404:
     *         description: User not found
     */
    // DELETE /auth/users/:id (Admin only)
    router.delete<{ id: string }>(
        "/users/:id",
        apiLimiter,
        requireAuth,
        requireAdmin,
        async (req, res) => {
            try {
                const { id } = req.params;

                // Prevent deleting yourself
                if (id === req.user!.id) {
                    return res
                        .status(400)
                        .json({ error: "Cannot delete your own account" });
                }

                const result = await deleteUserWithRoleGuard(id);
                if (result === "notFound") {
                    return res.status(404).json({ error: "User not found" });
                }
                if (result === "lastAdmin") {
                    return res
                        .status(400)
                        .json({ error: "Cannot delete the last admin" });
                }

                return res.json({ message: "User deleted successfully" });
            } catch (error: unknown) {
                logger.error("Delete user error:", error);
                if (hasErrorCode(error, "P2025")) {
                    return res.status(404).json({ error: "User not found" });
                }
                return res.status(500).json({ error: "Failed to delete user" });
            }
        },
    );

    /**
     * @openapi
     * /api/auth/invite-codes:
     *   post:
     *     summary: Generate a new invite code (admin only)
     *     tags: [Authentication]
     *     security:
     *       - apiKeyAuth: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required:
     *               - ttl
     *             properties:
     *               ttl:
     *                 type: string
     *                 enum: [1h, 6h, 24h, 7d, 30d, never]
     *               maxUses:
     *                 type: integer
     *                 minimum: 1
     *                 maximum: 100
     *                 default: 1
     *     responses:
     *       200:
     *         description: Invite code created successfully
     *       400:
     *         description: Invalid request
     *       401:
     *         description: Not authenticated
     *       403:
     *         description: Admin access required
     */
    // POST /auth/invite-codes - Generate a new invite code (admin only)
    router.post(
        "/invite-codes",
        apiLimiter,
        requireAuth,
        requireAdmin,
        async (req, res) => {
            try {
                const { ttl, maxUses } = inviteCodeSchema.parse(req.body);
                const expiresAt = ttlToExpiresAt(ttl);

                // Retry loop for uniqueness
                let code: string;
                let attempts = 0;
                do {
                    code = generateInviteCode();
                    const existing = await prisma.inviteCode.findUnique({
                        where: { code },
                    });
                    if (!existing) break;
                    attempts++;
                } while (attempts < 10);

                if (attempts >= 10) {
                    return res
                        .status(500)
                        .json({ error: "Failed to generate unique code" });
                }

                const inviteCode = await prisma.inviteCode.create({
                    data: {
                        code,
                        createdBy: req.user!.id,
                        expiresAt,
                        maxUses,
                    },
                });

                res.json({
                    id: inviteCode.id,
                    code: inviteCode.code,
                    expiresAt: inviteCode.expiresAt,
                    maxUses: inviteCode.maxUses,
                    createdAt: inviteCode.createdAt,
                });
            } catch (err) {
                if (err instanceof z.ZodError) {
                    return res.status(400).json({
                        error: "Invalid request",
                        details: err.issues,
                    });
                }
                logger.error("Create invite code error:", err);
                res.status(500).json({ error: "Failed to create invite code" });
            }
        },
    );

    /**
     * @openapi
     * /api/auth/invite-codes:
     *   get:
     *     summary: List all invite codes (admin only)
     *     tags: [Authentication]
     *     security:
     *       - apiKeyAuth: []
     *     responses:
     *       200:
     *         description: List of all invite codes with status
     *       401:
     *         description: Not authenticated
     *       403:
     *         description: Admin access required
     */
    // GET /auth/invite-codes - List all invite codes (admin only)
    router.get(
        "/invite-codes",
        apiLimiter,
        requireAuth,
        requireAdmin,
        async (_req, res) => {
            try {
                const codes = await prisma.inviteCode.findMany({
                    orderBy: { createdAt: "desc" },
                    include: {
                        creator: {
                            select: { username: true },
                        },
                    },
                });

                const now = new Date();
                const codesWithStatus = codes.map((c) => {
                    let status: string;
                    if (c.revoked) {
                        status = "revoked";
                    } else if (c.useCount >= c.maxUses) {
                        status = "exhausted";
                    } else if (c.expiresAt && c.expiresAt < now) {
                        status = "expired";
                    } else {
                        status = "active";
                    }
                    return {
                        id: c.id,
                        code: c.code,
                        status,
                        maxUses: c.maxUses,
                        useCount: c.useCount,
                        expiresAt: c.expiresAt,
                        createdAt: c.createdAt,
                        createdBy: c.creator.username,
                    };
                });

                res.json(codesWithStatus);
            } catch (err) {
                logger.error("List invite codes error:", err);
                res.status(500).json({ error: "Failed to list invite codes" });
            }
        },
    );

    /**
     * @openapi
     * /api/auth/invite-codes/{id}:
     *   delete:
     *     summary: Revoke an invite code (admin only)
     *     tags: [Authentication]
     *     security:
     *       - apiKeyAuth: []
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: The invite code ID
     *     responses:
     *       200:
     *         description: Invite code revoked successfully
     *       401:
     *         description: Not authenticated
     *       403:
     *         description: Admin access required
     *       404:
     *         description: Invite code not found
     */
    // DELETE /auth/invite-codes/:id - Revoke an invite code (admin only)
    router.delete<{ id: string }>(
        "/invite-codes/:id",
        apiLimiter,
        requireAuth,
        requireAdmin,
        async (req, res) => {
            try {
                await prisma.inviteCode.update({
                    where: { id: req.params.id },
                    data: { revoked: true },
                });
                res.json({ message: "Invite code revoked" });
            } catch (err: any) {
                if (err.code === "P2025") {
                    return res
                        .status(404)
                        .json({ error: "Invite code not found" });
                }
                logger.error("Revoke invite code error:", err);
                res.status(500).json({ error: "Failed to revoke invite code" });
            }
        },
    );

    /**
     * @openapi
     * /api/auth/register:
     *   post:
     *     summary: Register a new user account with an invite code
     *     tags: [Authentication]
     *     security: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required:
     *               - inviteCode
     *               - username
     *               - displayName
     *               - password
     *               - confirmPassword
     *               - email
     *             properties:
     *               inviteCode:
     *                 type: string
     *               username:
     *                 type: string
     *               displayName:
     *                 type: string
     *               password:
     *                 type: string
     *                 format: password
     *               confirmPassword:
     *                 type: string
     *                 format: password
     *               email:
     *                 type: string
     *                 format: email
     *     responses:
     *       200:
     *         description: Registration successful, returns JWT tokens
     *       400:
     *         description: Invalid request, invite code, or username/email already taken
     */
    type RegisterInput = z.infer<typeof registerSchema>;

    async function findRegistrationConflict(
        data: RegisterInput,
    ): Promise<string | null> {
        const existingUser = await prisma.user.findUnique({
            where: { username: data.username },
        });
        if (existingUser) return "Username already taken";
        const existingEmail = await prisma.user.findFirst({
            where: { email: data.email },
        });
        return existingEmail ? "Email already in use" : null;
    }

    async function createLocalRegisteredUser(
        data: RegisterInput,
        invite: InviteCode,
        passwordHash: string,
    ): Promise<LoginUser> {
        return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            await claimInviteCode(tx, invite);
            const user = await tx.user.create({
                data: {
                    username: data.username,
                    displayName: data.displayName,
                    email: data.email,
                    passwordHash,
                    role: "user",
                    onboardingComplete: true,
                },
            });
            await tx.userSettings.create({
                data: {
                    userId: user.id,
                    playbackQuality: "original",
                    wifiOnly: false,
                    offlineEnabled: false,
                    maxCacheSizeMb: 10240,
                },
            });
            await recordInviteCodeUsage(tx, invite, user.id);
            return user;
        });
    }

    async function registerHandler(
        req: Request,
        res: Response,
    ): Promise<Response> {
        try {
            const data = registerSchema.parse(req.body);
            const invite = await loadUsableInviteCode(data.inviteCode);
            const conflict = await findRegistrationConflict(data);
            if (conflict) return sendRouteError(res, 400, conflict);
            const passwordHash = await bcrypt.hash(data.password, 10);
            const user = await createLocalRegisteredUser(
                data,
                invite,
                passwordHash,
            );
            return sendLoginSuccess(res, user);
        } catch (err) {
            if (err instanceof z.ZodError) {
                const firstError = err.issues[0];
                return res.status(400).json({
                    error: firstError.message,
                    details: err.issues,
                });
            }
            if (
                err instanceof InviteCodeValidationError ||
                err instanceof InviteCodeExhaustedError
            ) {
                return sendRouteError(res, 400, err.message);
            }
            logger.error("Registration error:", err);
            return res.status(500).json({ error: "Registration failed" });
        }
    }

    // POST /auth/register - Public registration with invite code
    router.post("/register", authLimiter, registerHandler);
}
