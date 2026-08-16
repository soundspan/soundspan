import { NextFunction, Request, Response } from "express";
import { createHash } from "crypto";
import bcrypt from "bcrypt";
import { timingSafeCompare } from "../utils/timingSafe";
import { runDummyBcrypt } from "../utils/dummyCredential";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { prisma } from "../utils/db";
import { decrypt } from "../utils/encryption";
import { APP_PASSWORD_SECRET_PREFIX } from "../utils/appPasswords";
import { findApiKeyRecord, isApiKeyExpired } from "../utils/apiKeyHash";
import { logger } from "../utils/logger";
import {
    getResponseFormat,
    type ResponseFormat,
    sendSubsonicError,
    SubsonicErrorCode,
} from "../utils/subsonicResponse";
import { createRedisRateLimitOptions } from "./rateLimitStore";

const subsonicAuthLog = logger.child("SubsonicAuth");

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

interface ActiveAppPassword {
    id: string;
    encryptedSecret: string;
}

async function loadActiveAppPasswords(
    userId: string,
): Promise<ActiveAppPassword[]> {
    return prisma.appPassword.findMany({
        where: { userId, revokedAt: null },
        select: { id: true, encryptedSecret: true },
        orderBy: { createdAt: "desc" },
    });
}

function decryptAppPasswordSecret(
    appPassword: ActiveAppPassword,
): string | null {
    try {
        return decrypt(appPassword.encryptedSecret);
    } catch (error) {
        subsonicAuthLog.debug(
            "Failed to decrypt app password during Subsonic auth",
            {
                appPasswordId: appPassword.id,
                error,
            },
        );
        return null;
    }
}

function matchAppPasswordToken(
    appPasswords: ActiveAppPassword[],
    token: string,
    salt: string,
): string | null {
    let matchingId: string | null = null;
    for (const appPassword of appPasswords) {
        const secret = decryptAppPasswordSecret(appPassword);
        if (!secret?.startsWith(APP_PASSWORD_SECRET_PREFIX)) continue;
        const expected = createHash("md5")
            .update(secret + salt)
            .digest("hex");
        if (timingSafeCompare(expected.toLowerCase(), token.toLowerCase())) {
            matchingId ??= appPassword.id;
        }
    }
    return matchingId;
}

function matchPlainAppPassword(
    appPasswords: ActiveAppPassword[],
    providedSecret: string,
): string | null {
    let matchingId: string | null = null;
    for (const appPassword of appPasswords) {
        const secret = decryptAppPasswordSecret(appPassword);
        if (secret && timingSafeCompare(secret, providedSecret)) {
            matchingId ??= appPassword.id;
        }
    }
    return matchingId;
}

function touchAppPassword(appPasswordId: string): void {
    prisma.appPassword
        .update({
            where: { id: appPasswordId },
            data: { lastUsedAt: new Date() },
        })
        .catch((error: unknown) => {
            subsonicAuthLog.debug(
                "Failed to update app password lastUsedAt",
                error,
            );
        });
}

interface PasswordAuthResult {
    authenticated: boolean;
    bcryptWorkPerformed: boolean;
    invalidEncoding: boolean;
}

interface SubsonicUserCredentials {
    id: string;
    passwordHash: string | null;
    subsonicPassword: string | null;
}

async function authenticateTokenCredential(
    user: SubsonicUserCredentials,
    token: string,
    salt: string,
): Promise<{ authenticated: boolean; appPasswords: ActiveAppPassword[] }> {
    const appPasswords = await loadActiveAppPasswords(user.id);
    const appPasswordId = matchAppPasswordToken(appPasswords, token, salt);
    if (appPasswordId) {
        touchAppPassword(appPasswordId);
        return { authenticated: true, appPasswords };
    }
    if (!user.subsonicPassword) {
        return { authenticated: false, appPasswords };
    }
    try {
        const secret = decrypt(user.subsonicPassword);
        const expected = createHash("md5")
            .update(secret + salt)
            .digest("hex");
        return {
            authenticated: timingSafeCompare(
                expected.toLowerCase(),
                token.toLowerCase(),
            ),
            appPasswords,
        };
    } catch (error) {
        subsonicAuthLog.debug(
            "Subsonic token auth failed, trying password auth",
            error,
        );
        return { authenticated: false, appPasswords };
    }
}

async function authenticatePasswordCredential(
    user: SubsonicUserCredentials,
    password: string,
    loadedAppPasswords: ActiveAppPassword[] | null,
): Promise<PasswordAuthResult> {
    const decoded = decodeSubsonicPassword(password);
    if (decoded === null) {
        return {
            authenticated: false,
            bcryptWorkPerformed: false,
            invalidEncoding: true,
        };
    }
    if (decoded.startsWith(APP_PASSWORD_SECRET_PREFIX)) {
        const appPasswords =
            loadedAppPasswords ?? (await loadActiveAppPasswords(user.id));
        const appPasswordId = matchPlainAppPassword(appPasswords, decoded);
        if (appPasswordId) {
            touchAppPassword(appPasswordId);
            return {
                authenticated: true,
                bcryptWorkPerformed: false,
                invalidEncoding: false,
            };
        }
    }
    if (user.passwordHash) {
        return {
            authenticated: await bcrypt.compare(decoded, user.passwordHash),
            bcryptWorkPerformed: true,
            invalidEncoding: false,
        };
    }
    await runDummyBcrypt();
    return {
        authenticated: false,
        bcryptWorkPerformed: true,
        invalidEncoding: false,
    };
}

interface SubsonicAuthInput {
    username: string;
    password: string;
    token: string;
    salt: string;
    apiKey: string;
    version: string;
    client: string;
    hasPasswordAuth: boolean;
    hasTokenAuth: boolean;
    hasApiKeyAuth: boolean;
}

interface SubsonicPrincipal {
    id: string;
    username: string;
    role: string;
}

interface AuthFailure {
    code: SubsonicErrorCode;
    message: string;
}

type AuthenticationResult =
    | { user: SubsonicPrincipal }
    | { failure: AuthFailure };

function readQueryString(req: Request, key: string): string {
    const value = req.query[key];
    return typeof value === "string" ? value : "";
}

function readAuthInput(req: Request): SubsonicAuthInput {
    const password = readQueryString(req, "p");
    const token = readQueryString(req, "t");
    const salt = readQueryString(req, "s");
    const apiKey = readQueryString(req, "apiKey");
    return {
        username: readQueryString(req, "u"),
        password,
        token,
        salt,
        apiKey,
        version: readQueryString(req, "v"),
        client: readQueryString(req, "c"),
        hasPasswordAuth: Boolean(password),
        hasTokenAuth: Boolean(token && salt),
        hasApiKeyAuth: Boolean(apiKey),
    };
}

function validateAuthInput(input: SubsonicAuthInput): AuthFailure | null {
    if (!input.version) {
        return {
            code: SubsonicErrorCode.MISSING_PARAMETER,
            message: "Required parameter 'v' (version) is missing",
        };
    }
    if (!input.client) {
        return {
            code: SubsonicErrorCode.MISSING_PARAMETER,
            message: "Required parameter 'c' (client) is missing",
        };
    }
    if (input.hasApiKeyAuth && (input.hasPasswordAuth || input.hasTokenAuth)) {
        return {
            code: SubsonicErrorCode.MULTIPLE_AUTH_MECHANISMS,
            message:
                "Provide either apiKey or password/token authentication, not both",
        };
    }
    if (!input.hasApiKeyAuth && !input.username) {
        return {
            code: SubsonicErrorCode.MISSING_PARAMETER,
            message: "Required parameter 'u' (username) is missing",
        };
    }
    if (!input.hasPasswordAuth && !input.hasTokenAuth && !input.hasApiKeyAuth) {
        return {
            code: SubsonicErrorCode.MISSING_PARAMETER,
            message:
                "Required parameter 'p' (password), 't'+'s' (token+salt), or 'apiKey' is missing",
        };
    }
    return null;
}

function wrongCredentialsFailure(): AuthenticationResult {
    return {
        failure: {
            code: SubsonicErrorCode.WRONG_CREDENTIALS,
            message: "Wrong username or password",
        },
    };
}

function touchApiKey(apiKeyId: string): void {
    prisma.apiKey
        .update({
            where: { id: apiKeyId },
            data: { lastUsed: new Date() },
        })
        .catch((error: unknown) => {
            subsonicAuthLog.debug(
                "Failed to update API key lastUsed (subsonic)",
                error,
            );
        });
}

async function resolveApiKeyAuth(
    input: SubsonicAuthInput,
): Promise<AuthenticationResult> {
    const record = await findApiKeyRecord(input.apiKey, (key) =>
        prisma.apiKey.findUnique({
            where: { key },
            include: {
                user: {
                    select: { id: true, username: true, role: true },
                },
            },
        }),
    );
    if (!record?.user) {
        return {
            failure: {
                code: SubsonicErrorCode.INVALID_API_KEY,
                message: "Invalid API key",
            },
        };
    }
    if (isApiKeyExpired(record.createdAt)) return wrongCredentialsFailure();
    if (input.username && input.username !== record.user.username) {
        return wrongCredentialsFailure();
    }
    touchApiKey(record.id);
    return { user: record.user };
}

async function resolveUserAuth(
    input: SubsonicAuthInput,
): Promise<AuthenticationResult> {
    const user = await prisma.user.findUnique({
        where: { username: input.username },
        select: {
            id: true,
            username: true,
            role: true,
            passwordHash: true,
            subsonicPassword: true,
        },
    });
    if (!user) {
        await runDummyBcrypt();
        return wrongCredentialsFailure();
    }
    let authenticated = false;
    let bcryptWorkPerformed = false;
    let appPasswords: ActiveAppPassword[] | null = null;
    if (input.hasTokenAuth) {
        const tokenResult = await authenticateTokenCredential(
            user,
            input.token,
            input.salt,
        );
        authenticated = tokenResult.authenticated;
        appPasswords = tokenResult.appPasswords;
    }
    if (!authenticated && input.hasPasswordAuth) {
        const result = await authenticatePasswordCredential(
            user,
            input.password,
            appPasswords,
        );
        if (result.invalidEncoding) {
            await runDummyBcrypt();
            return {
                failure: {
                    code: SubsonicErrorCode.WRONG_CREDENTIALS,
                    message: "Invalid password encoding",
                },
            };
        }
        authenticated = result.authenticated;
        bcryptWorkPerformed = result.bcryptWorkPerformed;
    }
    if (!authenticated) {
        if (!bcryptWorkPerformed) await runDummyBcrypt();
        return wrongCredentialsFailure();
    }
    return {
        user: { id: user.id, username: user.username, role: user.role },
    };
}

function sendAuthFailure(
    res: Response,
    failure: AuthFailure,
    format: ResponseFormat,
    callback?: string,
): void {
    sendSubsonicError(res, failure.code, failure.message, format, callback);
}

function attachSubsonicContext(
    req: Request,
    principal: SubsonicPrincipal,
    input: SubsonicAuthInput,
): void {
    req.user = principal;
    req.subsonicClient = input.client;
    req.subsonicVersion = input.version;
}

/** Validates OpenSubsonic credentials and enriches request context for `/rest` handlers. */
export async function requireSubsonicAuth(
    req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    const format = getResponseFormat(req.query);
    const callback =
        typeof req.query.callback === "string" ? req.query.callback : undefined;
    const input = readAuthInput(req);
    const validationFailure = validateAuthInput(input);
    if (validationFailure) {
        sendAuthFailure(res, validationFailure, format, callback);
        return;
    }
    const result = input.hasApiKeyAuth
        ? await resolveApiKeyAuth(input)
        : await resolveUserAuth(input);
    if ("failure" in result) {
        sendAuthFailure(res, result.failure, format, callback);
        return;
    }
    attachSubsonicContext(req, result.user, input);
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
    ...createRedisRateLimitOptions("subsonic-auth"),
});
