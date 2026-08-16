import type { Request, Response, Router } from "express";
import bcrypt from "bcrypt";
import { z } from "zod";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import {
    generateRefreshToken,
    generateToken,
    requireAuth,
    verifyAuthToken,
} from "../../middleware/auth";
import { apiLimiter, authLimiter } from "../../middleware/rateLimiter";
import { config } from "../../config";
import { runDummyBcrypt } from "../../utils/dummyCredential";
import { sendRouteError } from "../routeErrorResponse";
import { sendLoginSuccess, verifyLoginSecondFactor } from "./shared";

const loginSchema = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
    token: z.string().min(1).optional(),
});

/** Register local login, logout, refresh, and current-user routes. */
export default function registerLocalCredentialRoutes(router: Router): void {
    /**
     * @openapi
     * /api/auth/login:
     *   post:
     *     summary: Login with username and password
     *     tags: [Authentication]
     *     security: []
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
     *               oneOf:
     *                 - $ref: '#/components/schemas/LoginTokenResponse'
     *                 - $ref: '#/components/schemas/LoginTwoFactorChallenge'
     *       401:
     *         description: Invalid credentials
     *         content:
     *           application/json:
     *             schema:
     *               $ref: '#/components/schemas/Error'
     */
    async function findLocalLoginUser(username: string) {
        return (
            (await prisma.user.findUnique({ where: { username } })) ??
            (await prisma.user.findUnique({ where: { email: username } }))
        );
    }

    async function localLoginHandler(
        req: Request,
        res: Response,
    ): Promise<Response> {
        if (!config.localLoginEnabled) {
            return sendRouteError(res, 403, "Local login is disabled");
        }
        try {
            const { username, password, token } = loginSchema.parse(req.body);
            const user = await findLocalLoginUser(username);
            if (!user || !user.passwordHash) {
                await runDummyBcrypt();
                return sendRouteError(res, 401, "Invalid credentials");
            }
            const valid = await bcrypt.compare(password, user.passwordHash);
            if (!valid) return sendRouteError(res, 401, "Invalid credentials");
            const secondFactor = await verifyLoginSecondFactor(user, token);
            if (secondFactor.kind === "required") {
                return res.json({
                    requires2FA: true,
                    message: "2FA token required",
                });
            }
            if (secondFactor.kind === "invalid") {
                return sendRouteError(res, 401, secondFactor.message);
            }
            return sendLoginSuccess(res, user);
        } catch (err) {
            if (err instanceof z.ZodError) {
                return res
                    .status(400)
                    .json({ error: "Invalid request", details: err.issues });
            }
            logger.error("Login error:", err);
            return res.status(500).json({ error: "Internal error" });
        }
    }

    // POST /auth/login
    router.post("/login", localLoginHandler);

    /**
     * @openapi
     * /api/auth/logout:
     *   post:
     *     summary: Logout the current user
     *     tags: [Authentication]
     *     security: []
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
     *     security: []
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
    router.post("/refresh", authLimiter, async (req, res) => {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            return res.status(400).json({ error: "Refresh token required" });
        }

        try {
            // Verify through the shared helper: it pins the HS256 algorithm and
            // resolves the secret from one validated source (no inline process.env
            // read, no `as any`).
            const decoded = verifyAuthToken(refreshToken);

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
     * /api/auth/me:
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
    router.get("/me", apiLimiter, requireAuth, async (req, res) => {
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
}
