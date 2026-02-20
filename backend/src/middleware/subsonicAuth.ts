import { NextFunction, Request, Response } from "express";
import { createHash } from "crypto";
import bcrypt from "bcrypt";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { prisma } from "../utils/db";
import { decrypt, encrypt } from "../utils/encryption";
import {
    getResponseFormat,
    sendSubsonicError,
    SubsonicErrorCode,
} from "../utils/subsonicResponse";

declare global {
    namespace Express {
        interface Request {
            subsonicClient?: string;
            subsonicVersion?: string;
        }
    }
}

function decodeSubsonicPassword(input: string): string | null {
    if (!input.startsWith("enc:")) {
        return input;
    }

    try {
        return Buffer.from(input.substring(4), "hex").toString("utf-8");
    } catch {
        return null;
    }
}

/** Validates OpenSubsonic credentials and enriches request context for `/rest` handlers. */
export async function requireSubsonicAuth(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    const format = getResponseFormat(req.query);
    const callback = typeof req.query.callback === "string" ? req.query.callback : undefined;

    const username = typeof req.query.u === "string" ? req.query.u : "";
    const password = typeof req.query.p === "string" ? req.query.p : "";
    const token = typeof req.query.t === "string" ? req.query.t : "";
    const salt = typeof req.query.s === "string" ? req.query.s : "";
    const apiKey = typeof req.query.apiKey === "string" ? req.query.apiKey : "";
    const version = typeof req.query.v === "string" ? req.query.v : "";
    const client = typeof req.query.c === "string" ? req.query.c : "";

    if (!version) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'v' (version) is missing",
            format,
            callback,
        );
        return;
    }

    if (!client) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'c' (client) is missing",
            format,
            callback,
        );
        return;
    }

    const hasPasswordAuth = Boolean(password);
    const hasTokenAuth = Boolean(token && salt);
    const hasApiKeyAuth = Boolean(apiKey);

    if (hasApiKeyAuth && (hasPasswordAuth || hasTokenAuth)) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MULTIPLE_AUTH_MECHANISMS,
            "Provide either apiKey or password/token authentication, not both",
            format,
            callback,
        );
        return;
    }

    if (!hasApiKeyAuth && !username) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'u' (username) is missing",
            format,
            callback,
        );
        return;
    }

    if (!hasPasswordAuth && !hasTokenAuth && !hasApiKeyAuth) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'p' (password), 't'+'s' (token+salt), or 'apiKey' is missing",
            format,
            callback,
        );
        return;
    }

    if (hasApiKeyAuth) {
        const apiKeyRecord = await prisma.apiKey.findUnique({
            where: { key: apiKey },
            include: {
                user: {
                    select: {
                        id: true,
                        username: true,
                        role: true,
                    },
                },
            },
        });

        if (!apiKeyRecord || !apiKeyRecord.user) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.INVALID_API_KEY,
                "Invalid API key",
                format,
                callback,
            );
            return;
        }

        if (username && username !== apiKeyRecord.user.username) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.WRONG_CREDENTIALS,
                "Wrong username or password",
                format,
                callback,
            );
            return;
        }

        prisma.apiKey
            .update({
                where: { id: apiKeyRecord.id },
                data: { lastUsed: new Date() },
            })
            .catch(() => undefined);

        req.user = {
            id: apiKeyRecord.user.id,
            username: apiKeyRecord.user.username,
            role: apiKeyRecord.user.role,
        };
        req.subsonicClient = client;
        req.subsonicVersion = version;
        next();
        return;
    }

    const user = await prisma.user.findUnique({
        where: { username },
        select: {
            id: true,
            username: true,
            role: true,
            passwordHash: true,
            subsonicPassword: true,
        },
    });

    if (!user) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.WRONG_CREDENTIALS,
            "Wrong username or password",
            format,
            callback,
        );
        return;
    }

    let authenticated = false;

    if (hasTokenAuth && user.subsonicPassword) {
        try {
            const subsonicSecret = decrypt(user.subsonicPassword);
            const expectedToken = createHash("md5")
                .update(subsonicSecret + salt)
                .digest("hex");
            if (expectedToken.toLowerCase() === token.toLowerCase()) {
                authenticated = true;
            }
        } catch {
            // Fall through to alternate auth path.
        }
    }

    if (!authenticated && hasPasswordAuth) {
        const decodedPassword = decodeSubsonicPassword(password);
        if (decodedPassword === null) {
            sendSubsonicError(
                res,
                SubsonicErrorCode.WRONG_CREDENTIALS,
                "Invalid password encoding",
                format,
                callback,
            );
            return;
        }

        const validPassword = await bcrypt.compare(
            decodedPassword,
            user.passwordHash,
        );

        if (validPassword) {
            authenticated = true;

            // Keep token auth working without separate credential management.
            await prisma.user.update({
                where: { id: user.id },
                data: { subsonicPassword: encrypt(decodedPassword) },
            });
        }
    }

    if (!authenticated) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.WRONG_CREDENTIALS,
            "Wrong username or password",
            format,
            callback,
        );
        return;
    }

    req.user = {
        id: user.id,
        username: user.username,
        role: user.role,
    };
    req.subsonicClient = client;
    req.subsonicVersion = version;

    next();
}

/** Rate-limits failed Subsonic auth attempts per IP and username pair. */
export const subsonicRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
        const ip = ipKeyGenerator(req.ip || "");
        const username = typeof req.query.u === "string" ? req.query.u : "";
        return `subsonic:${ip}:${username}`;
    },
});
