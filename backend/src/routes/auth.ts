import { Router } from "express";
import { logger } from "../utils/logger";
import bcrypt from "bcrypt";
import { prisma } from "../utils/db";
import { z } from "zod";
import speakeasy from "speakeasy";
import QRCode from "qrcode";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import {
    requireAuth,
    requireAdmin,
    generateToken,
    generateRefreshToken,
} from "../middleware/auth";
import { encrypt, decrypt } from "../utils/encryption";
import { BRAND_NAME } from "../config/brand";

const router = Router();

const loginSchema = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
});

const inviteCodeSchema = z.object({
    ttl: z.enum(["1h", "6h", "24h", "7d", "30d", "never"]),
    maxUses: z.number().int().min(1).max(100).default(1),
});

const registerSchema = z.object({
    inviteCode: z.string().min(1),
    username: z
        .string()
        .min(3)
        .max(32)
        .regex(/^[a-zA-Z0-9_]+$/, "Username must be alphanumeric (underscores allowed)"),
    displayName: z.string().min(1).max(64),
    password: z.string().min(6).max(128),
    confirmPassword: z.string(),
    email: z.string().email(),
}).refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
});

// Unambiguous character set for invite codes (no 0/O/1/I/L)
const INVITE_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateInviteCode(): string {
    const bytes = crypto.randomBytes(8);
    let code = "";
    for (let i = 0; i < 8; i++) {
        code += INVITE_CODE_CHARS[bytes[i] % INVITE_CODE_CHARS.length];
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

const subsonicPasswordSchema = z.object({
    password: z.string().min(8).max(128),
});

// Use shared encryption module for 2FA secrets
const encrypt2FASecret = encrypt;
const decrypt2FASecret = decrypt;

/**
 * @openapi
 * /auth/login:
 *   post:
 *     summary: Login with username and password
 *     tags: [Authentication]
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
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// POST /auth/login
router.post("/login", async (req, res) => {
    try {
        logger.debug(`[AUTH] Login attempt for user: ${req.body?.username}`);
        const { username, password } = loginSchema.parse(req.body);
        const { token } = req.body; // 2FA token if provided

        // Look up by username first, then by email
        const user =
            (await prisma.user.findUnique({ where: { username } })) ??
            (await prisma.user.findUnique({ where: { email: username } }));
        if (!user) {
            logger.debug(`[AUTH] User not found: ${username}`);
            return res.status(401).json({ error: "Invalid credentials" });
        }

        logger.debug(`[AUTH] Verifying password for user: ${username}`);
        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
            logger.debug(`[AUTH] Invalid password for user: ${username}`);
            return res.status(401).json({ error: "Invalid credentials" });
        }
        logger.debug(`[AUTH] Password verified for user: ${username}`);

        // Check if 2FA is enabled
        if (user.twoFactorEnabled && user.twoFactorSecret) {
            if (!token) {
                return res.status(200).json({
                    requires2FA: true,
                    message: "2FA token required",
                });
            }

            // Check if it's a recovery code
            const isRecoveryCode = /^[A-F0-9]{8}$/i.test(token);

            if (isRecoveryCode && user.twoFactorRecoveryCodes) {
                const encryptedCodes = user.twoFactorRecoveryCodes;
                const decryptedCodes = decrypt2FASecret(encryptedCodes);
                const hashedCodes = decryptedCodes.split(",");

                const providedHash = crypto
                    .createHash("sha256")
                    .update(token.toUpperCase())
                    .digest("hex");

                const codeIndex = hashedCodes.indexOf(providedHash);
                if (codeIndex === -1) {
                    return res
                        .status(401)
                        .json({ error: "Invalid recovery code" });
                }

                hashedCodes.splice(codeIndex, 1);
                await prisma.user.update({
                    where: { id: user.id },
                    data: {
                        twoFactorRecoveryCodes: encrypt2FASecret(
                            hashedCodes.join(",")
                        ),
                    },
                });
            } else {
                // Verify TOTP token
                const secret = decrypt2FASecret(user.twoFactorSecret);
                const verified = speakeasy.totp.verify({
                    secret,
                    encoding: "base32",
                    token,
                    window: 2,
                });

                if (!verified) {
                    return res.status(401).json({ error: "Invalid 2FA token" });
                }
            }
        }

        // Generate JWT tokens
        const jwtToken = generateToken({
            id: user.id,
            username: user.username,
            role: user.role,
            tokenVersion: user.tokenVersion,
        });
        const refreshToken = generateRefreshToken({
            id: user.id,
            tokenVersion: user.tokenVersion,
        });

        res.json({
            token: jwtToken,
            refreshToken: refreshToken,
            user: {
                id: user.id,
                username: user.username,
                displayName: user.displayName,
                role: user.role,
            },
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: err.errors });
        }
        logger.error("Login error:", err);
        res.status(500).json({ error: "Internal error" });
    }
});

/**
 * @openapi
 * /api/auth/logout:
 *   post:
 *     summary: Logout the current user
 *     tags: [Authentication]
 *     responses:
 *       200:
 *         description: Logged out successfully
 */
// POST /auth/logout - JWT is stateless, logout is handled client-side
router.post("/logout", (req, res) => {
    // With JWT, logout is handled by client removing the token
    // No server-side session to destroy
    res.json({ message: "Logged out" });
});

/**
 * @openapi
 * /api/auth/refresh:
 *   post:
 *     summary: Refresh access token using a refresh token
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: New access and refresh tokens
 *       400:
 *         description: Refresh token required
 *       401:
 *         description: Invalid or expired refresh token
 */
// POST /auth/refresh - Refresh access token using refresh token
router.post("/refresh", async (req, res) => {
    const { refreshToken } = req.body;

    if (!refreshToken) {
        return res.status(400).json({ error: "Refresh token required" });
    }

    try {
        const decoded = jwt.verify(
            refreshToken,
            process.env.JWT_SECRET || process.env.SESSION_SECRET!
        ) as any;

        if (decoded.type !== "refresh") {
            return res.status(401).json({ error: "Invalid refresh token" });
        }

        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: {
                id: true,
                username: true,
                role: true,
                tokenVersion: true,
            },
        });

        if (!user) {
            return res.status(401).json({ error: "User not found" });
        }

        // Validate tokenVersion
        if (decoded.tokenVersion !== user.tokenVersion) {
            return res.status(401).json({ error: "Token invalidated" });
        }

        const newAccessToken = generateToken(user);
        const newRefreshToken = generateRefreshToken(user);

        return res.json({
            token: newAccessToken,
            refreshToken: newRefreshToken,
        });
    } catch (error) {
        return res.status(401).json({ error: "Invalid refresh token" });
    }
});

/**
 * @openapi
 * /auth/me:
 *   get:
 *     summary: Get current authenticated user
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
 *     responses:
 *       200:
 *         description: Current user information
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// GET /auth/me
router.get("/me", requireAuth, async (req, res) => {
    const user = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: {
            id: true,
            username: true,
            displayName: true,
            email: true,
            role: true,
            onboardingComplete: true,
            enrichmentSettings: true,
            createdAt: true,
        },
    });

    if (!user) {
        return res.status(404).json({ error: "User not found" });
    }

    res.json(user);
});

/**
 * @openapi
 * /api/auth/change-password:
 *   post:
 *     summary: Change the current user's password
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - currentPassword
 *               - newPassword
 *             properties:
 *               currentPassword:
 *                 type: string
 *                 format: password
 *               newPassword:
 *                 type: string
 *                 format: password
 *     responses:
 *       200:
 *         description: Password changed successfully
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Current password is incorrect
 *       404:
 *         description: User not found
 */
// POST /auth/change-password
router.post("/change-password", requireAuth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword) {
            return res
                .status(400)
                .json({ error: "Current and new password are required" });
        }

        if (newPassword.length < 6) {
            return res
                .status(400)
                .json({ error: "New password must be at least 6 characters" });
        }

        // Verify current password
        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const valid = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!valid) {
            return res
                .status(401)
                .json({ error: "Current password is incorrect" });
        }

        // Update password and increment tokenVersion to invalidate all existing tokens
        const newPasswordHash = await bcrypt.hash(newPassword, 10);
        await prisma.user.update({
            where: { id: req.user!.id },
            data: {
                passwordHash: newPasswordHash,
                tokenVersion: { increment: 1 },
            },
        });

        res.json({ message: "Password changed successfully" });
    } catch (error) {
        logger.error("Change password error:", error);
        res.status(500).json({ error: "Failed to change password" });
    }
});

/**
 * @openapi
 * /api/auth/change-email:
 *   post:
 *     summary: Change the current user's email address
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: Email updated successfully
 *       400:
 *         description: Invalid email or email already in use
 *       401:
 *         description: Not authenticated
 */
// POST /auth/change-email
router.post("/change-email", requireAuth, async (req, res) => {
    try {
        const schema = z.object({ email: z.string().email() });
        const { email } = schema.parse(req.body);

        // Check uniqueness
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing && existing.id !== req.user!.id) {
            return res.status(400).json({ error: "Email already in use" });
        }

        await prisma.user.update({
            where: { id: req.user!.id },
            data: { email },
        });

        res.json({ message: "Email updated", email });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ error: "Invalid email address" });
        }
        logger.error("Change email error:", error);
        res.status(500).json({ error: "Failed to change email" });
    }
});

/**
 * @openapi
 * /api/auth/users:
 *   get:
 *     summary: List all users (admin only)
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of all users
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Admin access required
 */
// GET /auth/users (Admin only)
router.get("/users", requireAuth, requireAdmin, async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            select: {
                id: true,
                username: true,
                email: true,
                role: true,
                onboardingComplete: true,
                createdAt: true,
            },
            orderBy: { createdAt: "asc" },
        });

        res.json(users);
    } catch (error) {
        logger.error("Get users error:", error);
        res.status(500).json({ error: "Failed to get users" });
    }
});

/**
 * @openapi
 * /api/auth/create-user:
 *   post:
 *     summary: Create a new user account (admin only)
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
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
router.post("/create-user", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { username, password, role } = req.body;

        if (!username || !password) {
            return res
                .status(400)
                .json({ error: "Username and password are required" });
        }

        if (password.length < 6) {
            return res
                .status(400)
                .json({ error: "Password must be at least 6 characters" });
        }

        if (role && !["user", "admin"].includes(role)) {
            return res.status(400).json({ error: "Invalid role" });
        }

        // Check if username exists
        const existing = await prisma.user.findUnique({
            where: { username },
        });

        if (existing) {
            return res.status(400).json({ error: "Username already taken" });
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
});

/**
 * @openapi
 * /api/auth/users/{id}:
 *   patch:
 *     summary: Update a user's username, email, or password (admin only)
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
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
router.patch("/users/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const updateSchema = z.object({
            username: z
                .string()
                .min(3)
                .max(32)
                .regex(/^[a-zA-Z0-9_]+$/, "Username must be alphanumeric (underscores allowed)")
                .optional(),
            email: z.string().email().optional().nullable(),
            password: z.string().min(6).max(128).optional(),
        });

        const data = updateSchema.parse(req.body);

        // Check the target user exists
        const targetUser = await prisma.user.findUnique({ where: { id } });
        if (!targetUser) {
            return res.status(404).json({ error: "User not found" });
        }

        // Check username uniqueness if changing
        if (data.username && data.username !== targetUser.username) {
            const existing = await prisma.user.findUnique({
                where: { username: data.username },
            });
            if (existing) {
                return res.status(400).json({ error: "Username already taken" });
            }
        }

        // Check email uniqueness if changing
        if (data.email && data.email !== targetUser.email) {
            const existing = await prisma.user.findUnique({
                where: { email: data.email },
            });
            if (existing) {
                return res.status(400).json({ error: "Email already in use" });
            }
        }

        // Build update payload
        const updateData: Record<string, unknown> = {};
        if (data.username) updateData.username = data.username;
        if (data.email !== undefined) updateData.email = data.email;
        if (data.password) {
            updateData.passwordHash = await bcrypt.hash(data.password, 10);
            updateData.tokenVersion = { increment: 1 };
        }

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ error: "No fields to update" });
        }

        const updated = await prisma.user.update({
            where: { id },
            data: updateData,
            select: {
                id: true,
                username: true,
                email: true,
                role: true,
                createdAt: true,
            },
        });

        res.json(updated);
    } catch (err) {
        if (err instanceof z.ZodError) {
            const firstError = err.errors[0];
            return res.status(400).json({
                error: firstError.message,
                details: err.errors,
            });
        }
        logger.error("Update user error:", err);
        res.status(500).json({ error: "Failed to update user" });
    }
});

/**
 * @openapi
 * /api/auth/users/{id}:
 *   delete:
 *     summary: Delete a user account (admin only)
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
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
router.delete("/users/:id", requireAuth, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Prevent deleting yourself
        if (id === req.user!.id) {
            return res
                .status(400)
                .json({ error: "Cannot delete your own account" });
        }

        // Delete user (cascade will handle related data)
        await prisma.user.delete({
            where: { id },
        });

        res.json({ message: "User deleted successfully" });
    } catch (error: any) {
        logger.error("Delete user error:", error);
        if (error.code === "P2025") {
            return res.status(404).json({ error: "User not found" });
        }
        res.status(500).json({ error: "Failed to delete user" });
    }
});

/**
 * @openapi
 * /api/auth/invite-codes:
 *   post:
 *     summary: Generate a new invite code (admin only)
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
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
                return res
                    .status(400)
                    .json({ error: "Invalid request", details: err.errors });
            }
            logger.error("Create invite code error:", err);
            res.status(500).json({ error: "Failed to create invite code" });
        }
    }
);

/**
 * @openapi
 * /api/auth/invite-codes:
 *   get:
 *     summary: List all invite codes (admin only)
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
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
    }
);

/**
 * @openapi
 * /api/auth/invite-codes/{id}:
 *   delete:
 *     summary: Revoke an invite code (admin only)
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
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
router.delete(
    "/invite-codes/:id",
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
                return res.status(404).json({ error: "Invite code not found" });
            }
            logger.error("Revoke invite code error:", err);
            res.status(500).json({ error: "Failed to revoke invite code" });
        }
    }
);

/**
 * @openapi
 * /api/auth/register:
 *   post:
 *     summary: Register a new user account with an invite code
 *     tags: [Authentication]
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
// POST /auth/register - Public registration with invite code
router.post("/register", async (req, res) => {
    try {
        const data = registerSchema.parse(req.body);

        // Validate invite code
        const invite = await prisma.inviteCode.findUnique({
            where: { code: data.inviteCode.toUpperCase() },
        });

        if (!invite) {
            return res.status(400).json({ error: "Invalid invite code" });
        }
        if (invite.revoked) {
            return res.status(400).json({ error: "This invite code has been revoked" });
        }
        if (invite.useCount >= invite.maxUses) {
            return res.status(400).json({ error: "This invite code has been fully used" });
        }
        if (invite.expiresAt && invite.expiresAt < new Date()) {
            return res.status(400).json({ error: "This invite code has expired" });
        }

        // Check username uniqueness
        const existingUser = await prisma.user.findUnique({
            where: { username: data.username },
        });
        if (existingUser) {
            return res.status(400).json({ error: "Username already taken" });
        }

        // Check email uniqueness
        const existingEmail = await prisma.user.findFirst({
            where: { email: data.email },
        });
        if (existingEmail) {
            return res.status(400).json({ error: "Email already in use" });
        }

        // Create user, settings, and usage record in a transaction
        const passwordHash = await bcrypt.hash(data.password, 10);

        const result = await prisma.$transaction(async (tx) => {
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

            await tx.inviteCodeUsage.create({
                data: {
                    inviteCodeId: invite.id,
                    usedBy: user.id,
                },
            });

            await tx.inviteCode.update({
                where: { id: invite.id },
                data: { useCount: { increment: 1 } },
            });

            return user;
        });

        // Generate JWT tokens
        const jwtToken = generateToken({
            id: result.id,
            username: result.username,
            role: result.role,
            tokenVersion: result.tokenVersion,
        });
        const refreshToken = generateRefreshToken({
            id: result.id,
            tokenVersion: result.tokenVersion,
        });

        res.json({
            token: jwtToken,
            refreshToken,
            user: {
                id: result.id,
                username: result.username,
                displayName: result.displayName,
                role: result.role,
            },
        });
    } catch (err) {
        if (err instanceof z.ZodError) {
            const firstError = err.errors[0];
            return res.status(400).json({
                error: firstError.message,
                details: err.errors,
            });
        }
        logger.error("Registration error:", err);
        res.status(500).json({ error: "Registration failed" });
    }
});

/**
 * @openapi
 * /api/auth/2fa/setup:
 *   post:
 *     summary: Generate a 2FA secret and QR code for setup
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: 2FA secret and QR code generated
 *       400:
 *         description: 2FA is already enabled
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: User not found
 */
// POST /auth/2fa/setup - Generate 2FA secret and QR code
router.post("/2fa/setup", requireAuth, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: { username: true, twoFactorEnabled: true },
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        if (user.twoFactorEnabled) {
            return res.status(400).json({ error: "2FA is already enabled" });
        }

        // Generate secret
        const secret = speakeasy.generateSecret({
            name: `${BRAND_NAME} (${user.username})`,
            issuer: BRAND_NAME,
        });

        // Generate QR code
        const qrCodeDataUrl = await QRCode.toDataURL(secret.otpauth_url!);

        res.json({
            secret: secret.base32,
            qrCode: qrCodeDataUrl,
        });
    } catch (error) {
        logger.error("2FA setup error:", error);
        res.status(500).json({ error: "Failed to setup 2FA" });
    }
});

/**
 * @openapi
 * /api/auth/2fa/enable:
 *   post:
 *     summary: Verify token and enable 2FA for the current user
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - secret
 *               - token
 *             properties:
 *               secret:
 *                 type: string
 *                 description: The base32-encoded 2FA secret from setup
 *               token:
 *                 type: string
 *                 description: The TOTP token to verify
 *     responses:
 *       200:
 *         description: 2FA enabled, returns recovery codes
 *       400:
 *         description: Secret and token are required
 *       401:
 *         description: Invalid token or not authenticated
 */
// POST /auth/2fa/enable - Verify token and enable 2FA
router.post("/2fa/enable", requireAuth, async (req, res) => {
    try {
        const { secret, token } = req.body;

        if (!secret || !token) {
            return res
                .status(400)
                .json({ error: "Secret and token are required" });
        }

        // Verify the token with the secret
        const verified = speakeasy.totp.verify({
            secret,
            encoding: "base32",
            token,
            window: 2,
        });

        if (!verified) {
            return res
                .status(401)
                .json({ error: "Invalid token. Please try again." });
        }

        // Generate 10 recovery codes
        const recoveryCodes: string[] = [];
        const hashedRecoveryCodes: string[] = [];

        for (let i = 0; i < 10; i++) {
            // Generate 8-character alphanumeric code
            const code = crypto.randomBytes(4).toString("hex").toUpperCase();
            recoveryCodes.push(code);
            // Hash the code before storing
            hashedRecoveryCodes.push(
                crypto.createHash("sha256").update(code).digest("hex")
            );
        }

        // Encrypt the hashed codes for storage
        const encryptedRecoveryCodes = encrypt2FASecret(
            hashedRecoveryCodes.join(",")
        );

        // Encrypt and save the secret
        const encryptedSecret = encrypt2FASecret(secret);
        await prisma.user.update({
            where: { id: req.user!.id },
            data: {
                twoFactorEnabled: true,
                twoFactorSecret: encryptedSecret,
                twoFactorRecoveryCodes: encryptedRecoveryCodes,
            },
        });

        // Return the plain recovery codes to the user (only time they'll see them)
        res.json({
            message: "2FA enabled successfully",
            recoveryCodes: recoveryCodes,
        });
    } catch (error) {
        logger.error("2FA enable error:", error);
        res.status(500).json({ error: "Failed to enable 2FA" });
    }
});

/**
 * @openapi
 * /api/auth/2fa/disable:
 *   post:
 *     summary: Disable 2FA for the current user
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - password
 *               - token
 *             properties:
 *               password:
 *                 type: string
 *                 format: password
 *               token:
 *                 type: string
 *                 description: Current TOTP token
 *     responses:
 *       200:
 *         description: 2FA disabled successfully
 *       400:
 *         description: Password and token are required
 *       401:
 *         description: Invalid password or token
 *       404:
 *         description: User not found
 */
// POST /auth/2fa/disable - Disable 2FA
router.post("/2fa/disable", requireAuth, async (req, res) => {
    try {
        const { password, token } = req.body;

        if (!password || !token) {
            return res
                .status(400)
                .json({ error: "Password and current 2FA token are required" });
        }

        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user.passwordHash);
        if (!validPassword) {
            return res.status(401).json({ error: "Invalid password" });
        }

        // Verify 2FA token
        if (user.twoFactorSecret) {
            const secret = decrypt2FASecret(user.twoFactorSecret);
            const verified = speakeasy.totp.verify({
                secret,
                encoding: "base32",
                token,
                window: 2,
            });

            if (!verified) {
                return res.status(401).json({ error: "Invalid 2FA token" });
            }
        }

        // Disable 2FA
        await prisma.user.update({
            where: { id: req.user!.id },
            data: {
                twoFactorEnabled: false,
                twoFactorSecret: null,
                twoFactorRecoveryCodes: null,
            },
        });

        res.json({ message: "2FA disabled successfully" });
    } catch (error) {
        logger.error("2FA disable error:", error);
        res.status(500).json({ error: "Failed to disable 2FA" });
    }
});

/**
 * @openapi
 * /api/auth/2fa/status:
 *   get:
 *     summary: Check if 2FA is enabled for the current user
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: 2FA status
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: User not found
 */
// GET /auth/2fa/status - Check if 2FA is enabled
router.get("/2fa/status", requireAuth, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: { twoFactorEnabled: true },
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        res.json({ enabled: user.twoFactorEnabled });
    } catch (error) {
        logger.error("2FA status error:", error);
        res.status(500).json({ error: "Failed to get 2FA status" });
    }
});

/**
 * @openapi
 * /api/auth/subsonic-password:
 *   get:
 *     summary: Check if a Subsonic password is configured
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Subsonic password status
 *       401:
 *         description: Not authenticated
 *       404:
 *         description: User not found
 */
// GET /auth/subsonic-password - Check if Subsonic password is configured
router.get("/subsonic-password", requireAuth, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: req.user!.id },
            select: { subsonicPassword: true },
        });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        return res.json({ hasPassword: Boolean(user.subsonicPassword) });
    } catch (error) {
        logger.error("Subsonic password status error:", error);
        return res
            .status(500)
            .json({ error: "Failed to get Subsonic password status" });
    }
});

/**
 * @openapi
 * /api/auth/subsonic-password:
 *   post:
 *     summary: Set or update the Subsonic password
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - password
 *             properties:
 *               password:
 *                 type: string
 *                 format: password
 *                 minLength: 8
 *                 maxLength: 128
 *     responses:
 *       200:
 *         description: Subsonic password set successfully
 *       400:
 *         description: Invalid password
 *       401:
 *         description: Not authenticated
 */
// POST /auth/subsonic-password - Set Subsonic password
router.post("/subsonic-password", requireAuth, async (req, res) => {
    try {
        const { password } = subsonicPasswordSchema.parse(req.body);

        await prisma.user.update({
            where: { id: req.user!.id },
            data: {
                subsonicPassword: encrypt(password),
            },
        });

        return res.json({ success: true });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({
                error: "Password must be between 8 and 128 characters",
            });
        }
        logger.error("Set Subsonic password error:", error);
        return res.status(500).json({ error: "Failed to set Subsonic password" });
    }
});

/**
 * @openapi
 * /api/auth/subsonic-password:
 *   delete:
 *     summary: Clear the Subsonic password
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Subsonic password deleted successfully
 *       401:
 *         description: Not authenticated
 */
// DELETE /auth/subsonic-password - Clear Subsonic password
router.delete("/subsonic-password", requireAuth, async (req, res) => {
    try {
        await prisma.user.update({
            where: { id: req.user!.id },
            data: {
                subsonicPassword: null,
            },
        });

        return res.json({ success: true });
    } catch (error) {
        logger.error("Delete Subsonic password error:", error);
        return res
            .status(500)
            .json({ error: "Failed to delete Subsonic password" });
    }
});

export default router;
