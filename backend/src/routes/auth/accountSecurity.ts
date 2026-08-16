import type { Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { generateSecret, generateURI } from "otplib";
import QRCode from "qrcode";
import crypto from "crypto";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import { requireAuth, requireInteractiveSession } from "../../middleware/auth";
import { apiLimiter, authLimiter } from "../../middleware/rateLimiter";
import { BRAND_NAME } from "../../config/brand";
import { encrypt } from "../../utils/encryption";
import { decrypt2FASecret, encrypt2FASecret, verifyTotpToken } from "./shared";

const subsonicPasswordSchema = z.object({
    password: z.string().min(8).max(128),
});

/** Register password and email account-security routes. */
export function registerAccountProfileRoutes(router: Router): void {
    /**
     * @openapi
     * /api/auth/change-password:
     *   post:
     *     summary: Change the current user's password
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
    router.post(
        "/change-password",
        authLimiter,
        requireAuth,
        async (req, res) => {
            try {
                const { currentPassword, newPassword } = req.body;

                if (!currentPassword || !newPassword) {
                    return res.status(400).json({
                        error: "Current and new password are required",
                    });
                }

                if (newPassword.length < 6) {
                    return res.status(400).json({
                        error: "New password must be at least 6 characters",
                    });
                }

                // Verify current password
                const user = await prisma.user.findUnique({
                    where: { id: req.user!.id },
                });

                if (!user) {
                    return res.status(404).json({ error: "User not found" });
                }

                if (!user.passwordHash) {
                    return res
                        .status(401)
                        .json({ error: "Current password is incorrect" });
                }

                const valid = await bcrypt.compare(
                    currentPassword,
                    user.passwordHash,
                );
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
                        subsonicPassword: null,
                    },
                });

                res.json({ message: "Password changed successfully" });
            } catch (error) {
                logger.error("Change password error:", error);
                res.status(500).json({ error: "Failed to change password" });
            }
        },
    );

    /**
     * @openapi
     * /api/auth/change-email:
     *   post:
     *     summary: Change the current user's email address
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
    router.post("/change-email", apiLimiter, requireAuth, async (req, res) => {
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
}

/** Register 2FA and Subsonic credential routes. */
export function registerSecondFactorAndSubsonicRoutes(router: Router): void {
    /**
     * @openapi
     * /api/auth/2fa/setup:
     *   post:
     *     summary: Generate a 2FA secret and QR code for setup
     *     tags: [Authentication]
     *     security:
     *       - bearerAuth: []
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
    router.post(
        "/2fa/setup",
        authLimiter,
        requireAuth,
        requireInteractiveSession,
        async (req, res) => {
            try {
                const user = await prisma.user.findUnique({
                    where: { id: req.user!.id },
                    select: { username: true, twoFactorEnabled: true },
                });

                if (!user) {
                    return res.status(404).json({ error: "User not found" });
                }

                if (user.twoFactorEnabled) {
                    return res
                        .status(400)
                        .json({ error: "2FA is already enabled" });
                }

                // Generate secret
                const secret = generateSecret();
                const otpauthUrl = generateURI({
                    issuer: BRAND_NAME,
                    label: user.username,
                    secret,
                });

                // Generate QR code
                const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

                res.json({
                    secret,
                    qrCode: qrCodeDataUrl,
                });
            } catch (error) {
                logger.error("2FA setup error:", error);
                res.status(500).json({ error: "Failed to setup 2FA" });
            }
        },
    );

    /**
     * @openapi
     * /api/auth/2fa/enable:
     *   post:
     *     summary: Verify token and enable 2FA for the current user
     *     tags: [Authentication]
     *     security:
     *       - bearerAuth: []
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
    router.post(
        "/2fa/enable",
        authLimiter,
        requireAuth,
        requireInteractiveSession,
        async (req, res) => {
            try {
                const { secret, token } = req.body;

                if (!secret || !token) {
                    return res
                        .status(400)
                        .json({ error: "Secret and token are required" });
                }

                // Verify the token with the secret
                const verified = await verifyTotpToken(secret, token);

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
                    const code = crypto
                        .randomBytes(4)
                        .toString("hex")
                        .toUpperCase();
                    recoveryCodes.push(code);
                    // Hash the code before storing
                    hashedRecoveryCodes.push(
                        crypto.createHash("sha256").update(code).digest("hex"),
                    );
                }

                // Encrypt the hashed codes for storage
                const encryptedRecoveryCodes = encrypt2FASecret(
                    hashedRecoveryCodes.join(","),
                );

                // Encrypt and save the secret
                const encryptedSecret = encrypt2FASecret(secret);
                const enabled = await prisma.user.updateMany({
                    where: { id: req.user!.id, twoFactorEnabled: false },
                    data: {
                        twoFactorEnabled: true,
                        twoFactorSecret: encryptedSecret,
                        twoFactorRecoveryCodes: encryptedRecoveryCodes,
                    },
                });
                if (enabled.count !== 1) {
                    return res
                        .status(409)
                        .json({ error: "2FA is already enabled" });
                }

                // Return the plain recovery codes to the user (only time they'll see them)
                res.json({
                    message: "2FA enabled successfully",
                    recoveryCodes: recoveryCodes,
                });
            } catch (error) {
                logger.error("2FA enable error:", error);
                res.status(500).json({ error: "Failed to enable 2FA" });
            }
        },
    );

    /**
     * @openapi
     * /api/auth/2fa/disable:
     *   post:
     *     summary: Disable 2FA for the current user
     *     tags: [Authentication]
     *     security:
     *       - bearerAuth: []
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
    router.post(
        "/2fa/disable",
        authLimiter,
        requireAuth,
        requireInteractiveSession,
        async (req, res) => {
            try {
                const { password, token } = req.body;

                if (!password || !token) {
                    return res.status(400).json({
                        error: "Password and current 2FA token are required",
                    });
                }

                const user = await prisma.user.findUnique({
                    where: { id: req.user!.id },
                });

                if (!user) {
                    return res.status(404).json({ error: "User not found" });
                }

                if (!user.passwordHash) {
                    return res.status(401).json({ error: "Invalid password" });
                }

                // Verify password
                const validPassword = await bcrypt.compare(
                    password,
                    user.passwordHash,
                );
                if (!validPassword) {
                    return res.status(401).json({ error: "Invalid password" });
                }

                // Verify 2FA token
                if (user.twoFactorSecret) {
                    const secret = decrypt2FASecret(user.twoFactorSecret);
                    const verified = await verifyTotpToken(secret, token);

                    if (!verified) {
                        return res
                            .status(401)
                            .json({ error: "Invalid 2FA token" });
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
        },
    );

    /**
     * @openapi
     * /api/auth/2fa/status:
     *   get:
     *     summary: Check if 2FA is enabled for the current user
     *     tags: [Authentication]
     *     security:
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
    router.get("/2fa/status", apiLimiter, requireAuth, async (req, res) => {
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
    router.get(
        "/subsonic-password",
        apiLimiter,
        requireAuth,
        async (req, res) => {
            try {
                const user = await prisma.user.findUnique({
                    where: { id: req.user!.id },
                    select: { subsonicPassword: true },
                });

                if (!user) {
                    return res.status(404).json({ error: "User not found" });
                }

                return res.json({
                    hasPassword: Boolean(user.subsonicPassword),
                });
            } catch (error) {
                logger.error("Subsonic password status error:", error);
                return res
                    .status(500)
                    .json({ error: "Failed to get Subsonic password status" });
            }
        },
    );

    /**
     * @openapi
     * /api/auth/subsonic-password:
     *   post:
     *     summary: Set or update the Subsonic password
     *     tags: [Authentication]
     *     security:
     *       - bearerAuth: []
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
     *       403:
     *         description: Interactive session authentication required
     */
    // POST /auth/subsonic-password - Set Subsonic password
    router.post(
        "/subsonic-password",
        authLimiter,
        requireAuth,
        requireInteractiveSession,
        async (req, res) => {
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
                return res
                    .status(500)
                    .json({ error: "Failed to set Subsonic password" });
            }
        },
    );

    /**
     * @openapi
     * /api/auth/subsonic-password:
     *   delete:
     *     summary: Clear the Subsonic password
     *     tags: [Authentication]
     *     security:
     *       - bearerAuth: []
     *     responses:
     *       200:
     *         description: Subsonic password deleted successfully
     *       401:
     *         description: Not authenticated
     *       403:
     *         description: Interactive session authentication required
     */
    // DELETE /auth/subsonic-password - Clear Subsonic password
    router.delete(
        "/subsonic-password",
        authLimiter,
        requireAuth,
        requireInteractiveSession,
        async (req, res) => {
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
        },
    );
}
