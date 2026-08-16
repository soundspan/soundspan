import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";
import { prisma } from "../utils/db";
import { findApiKeyRecord, isApiKeyExpired } from "../utils/apiKeyHash";
import jwt from "jsonwebtoken";
import { sendRouteError } from "../routes/routeErrorResponse";

// JWT_SECRET is required - SESSION_SECRET (a required, stable deploy secret;
// docker-entrypoint.sh fails fast when it is missing) is the fallback.
const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET;

if (!JWT_SECRET) {
    throw new Error(
        "JWT_SECRET or SESSION_SECRET environment variable is required for authentication",
    );
}

// Type assertion after validation - JWT_SECRET is guaranteed to be a string
const JWT_SECRET_VALIDATED: string = JWT_SECRET;

declare global {
    namespace Express {
        interface Request {
            user?: {
                id: string;
                username: string;
                role: string;
            };
        }
    }
}

export interface AuthenticatedRequest extends Request {
    user: {
        id: string;
        username: string;
        role: string;
    };
}

export interface JWTPayload {
    userId: string;
    username?: string;
    role?: string;
    tokenVersion?: number;
    type?: string;
}

function isJwtPayloadShape(value: unknown): value is { userId: string } {
    return (
        typeof value === "object" &&
        value !== null &&
        "userId" in value &&
        typeof value.userId === "string"
    );
}

/** Creates a short-lived access token for authenticated API flows. */
export function generateToken(user: {
    id: string;
    username: string;
    role: string;
    tokenVersion: number;
}): string {
    return jwt.sign(
        {
            userId: user.id,
            username: user.username,
            role: user.role,
            tokenVersion: user.tokenVersion,
        },
        JWT_SECRET_VALIDATED,
        { expiresIn: "24h" },
    );
}

/** Creates a long-lived refresh token tied to the user's token version. */
export function generateRefreshToken(user: {
    id: string;
    tokenVersion: number;
}): string {
    return jwt.sign(
        {
            userId: user.id,
            tokenVersion: user.tokenVersion,
            type: "refresh",
        },
        JWT_SECRET_VALIDATED,
        { expiresIn: "30d" },
    );
}

/**
 * Verify an HS256 access/refresh token against the validated JWT secret and
 * require an object payload with a string `userId`. The `algorithms` pin
 * prevents a token from being accepted under a different (weaker or `none`)
 * algorithm, and centralizes secret resolution so callers never re-read
 * `process.env` inline. Throws on an invalid, expired, wrong-algorithm, or
 * malformed token.
 */
export function verifyAuthToken(token: string): JWTPayload {
    const payload = jwt.verify(token, JWT_SECRET_VALIDATED, {
        algorithms: ["HS256"],
    });
    if (!isJwtPayloadShape(payload)) {
        throw new Error("Malformed token payload");
    }
    // Runtime validation above establishes the required JWTPayload invariant.
    return payload as JWTPayload;
}

/**
 * Verify a credential presented for direct API/socket access as a short-lived
 * access token. Delegates to `verifyAuthToken` (HS256-pinned, single validated
 * secret) and rejects all non-access token types, including refresh tokens.
 * Only tokens minted without a `type` claim are accepted. Throws on an invalid,
 * expired, wrong-algorithm, malformed, or non-access token.
 */
export function verifyAccessToken(token: string): JWTPayload {
    const payload = verifyAuthToken(token);
    if (payload.type !== undefined) {
        throw new Error("Token is not an access token");
    }
    return payload;
}

/**
 * Resolve an access token to its user, enforcing token type (via
 * `verifyAccessToken`) and `tokenVersion` freshness. Returns `null` when the
 * user no longer exists or the token predates a password change; throws when
 * the token itself fails verification.
 */
async function resolveAccessTokenUser(
    token: string,
): Promise<{ id: string; username: string; role: string } | null> {
    const decoded = verifyAccessToken(token);
    const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        select: { id: true, username: true, role: true, tokenVersion: true },
    });
    if (!user) {
        return null;
    }
    // Validate tokenVersion - reject if password was changed
    if (
        decoded.tokenVersion === undefined ||
        decoded.tokenVersion !== user.tokenVersion
    ) {
        return null;
    }
    return { id: user.id, username: user.username, role: user.role };
}

/**
 * Helper function to authenticate a request using an API key or JWT
 * @param req Express request object
 * @param checkQueryToken Whether to check for token in query params (for streaming)
 * @returns User object if authenticated, null otherwise
 */
async function authenticateRequest(
    req: Request,
    checkQueryToken: boolean = false,
): Promise<{ id: string; username: string; role: string } | null> {
    // Check for API key in X-API-Key header
    const apiKey = req.headers["x-api-key"] as string;
    if (apiKey) {
        try {
            const apiKeyRecord = await findApiKeyRecord(apiKey, (key) =>
                prisma.apiKey.findUnique({
                    where: { key },
                    include: {
                        user: {
                            select: { id: true, username: true, role: true },
                        },
                    },
                }),
            );

            if (
                apiKeyRecord &&
                apiKeyRecord.user &&
                !isApiKeyExpired(apiKeyRecord.createdAt)
            ) {
                // Update last used timestamp (async, don't block)
                prisma.apiKey
                    .update({
                        where: { id: apiKeyRecord.id },
                        data: { lastUsed: new Date() },
                    })
                    .catch((err) => {
                        logger.debug("Failed to update API key lastUsed", err);
                    });

                return apiKeyRecord.user;
            }
        } catch (error) {
            logger.error("API key auth error:", error);
        }
    }

    // Check for token in query param (for streaming URLs)
    if (checkQueryToken) {
        const tokenParam = req.query.token as string;
        if (tokenParam) {
            try {
                const user = await resolveAccessTokenUser(tokenParam);
                if (user) return user;
            } catch (error) {
                logger.debug("Query token validation failed", error);
            }
        }
    }

    // Check JWT token in Authorization header
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
        ? authHeader.substring(7)
        : null;

    if (token) {
        try {
            const user = await resolveAccessTokenUser(token);
            if (user) return user;
        } catch (error) {
            logger.debug("Bearer token validation failed", error);
        }
    }

    return null;
}

/** Enforces authenticated access and attaches the resolved user to `req.user`. */
export async function requireAuth(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    const user = await authenticateRequest(req, false);
    if (user) {
        req.user = user;
        return next();
    }
    return res
        .status(401)
        .json({ error: "Not authenticated", code: "AUTH_REQUIRED" });
}

/** Rejects API-key transport for operations that require an interactive user. */
export function requireInteractiveSession(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    // Interactive password/current-factor step-up is a documented frontend follow-up outside this slice.
    if (req.headers["x-api-key"] !== undefined) {
        return sendRouteError(
            res,
            403,
            "Interactive session authentication required",
        );
    }
    return next();
}

/** Enforces administrator role access after `requireAuth` has populated `req.user`. */
export async function requireAdmin(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    if (!req.user || req.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
    }
    next();
}

// For streaming URLs that may use query params or need special handling
/** Authenticates via API key, query token, or bearer token for media routes. */
export async function requireAuthOrToken(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    // Check for API key in X-API-Key header (for mobile/external apps)
    const apiKey = req.headers["x-api-key"] as string;
    if (apiKey) {
        try {
            const apiKeyRecord = await findApiKeyRecord(apiKey, (key) =>
                prisma.apiKey.findUnique({
                    where: { key },
                    include: {
                        user: {
                            select: { id: true, username: true, role: true },
                        },
                    },
                }),
            );

            if (
                apiKeyRecord &&
                apiKeyRecord.user &&
                !isApiKeyExpired(apiKeyRecord.createdAt)
            ) {
                // Update last used timestamp (async, don't block)
                prisma.apiKey
                    .update({
                        where: { id: apiKeyRecord.id },
                        data: { lastUsed: new Date() },
                    })
                    .catch((err) => {
                        logger.debug("Failed to update API key lastUsed", err);
                    });

                req.user = apiKeyRecord.user;
                return next();
            }
        } catch (error) {
            logger.error("API key auth error:", error);
        }
    }

    // Check for token in query param (for streaming URLs from audio elements)
    const tokenParam = req.query.token as string;
    if (tokenParam) {
        try {
            const user = await resolveAccessTokenUser(tokenParam);
            if (user) {
                req.user = user;
                return next();
            }
        } catch (error) {
            logger.debug(
                "Query token validation failed in requireAuthOrToken",
                error,
            );
        }
    }

    // Fallback: check JWT token in Authorization header
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
        ? authHeader.substring(7)
        : null;

    if (token) {
        try {
            const user = await resolveAccessTokenUser(token);
            if (user) {
                req.user = user;
                return next();
            }
        } catch (error) {
            logger.debug(
                "Bearer token validation failed in requireAuthOrToken",
                error,
            );
        }
    }

    return res
        .status(401)
        .json({ error: "Not authenticated", code: "AUTH_REQUIRED" });
}
