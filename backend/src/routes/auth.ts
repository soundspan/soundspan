import {
    Router,
    type CookieOptions,
    type Request,
    type RequestHandler,
    type Response,
} from "express";
import type { InviteCode, Prisma } from "@prisma/client";
import { logger } from "../utils/logger";
import bcrypt from "bcrypt";
import { prisma } from "../utils/db";
import { z } from "zod";
import { generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";
import crypto from "crypto";
import {
    requireAuth,
    requireInteractiveSession,
    requireAdmin,
    generateToken,
    generateRefreshToken,
    verifyAuthToken,
} from "../middleware/auth";
import { encrypt, decrypt } from "../utils/encryption";
import {
    generateAppPasswordSecret,
    MAX_ACTIVE_APP_PASSWORDS,
} from "../utils/appPasswords";
import { BRAND_NAME } from "../config/brand";
import { timingSafeCompare } from "../utils/timingSafe";
import { runDummyBcrypt } from "../utils/dummyCredential";
import {
    apiLimiter,
    authLimiter,
    oidcFlowLimiter,
} from "../middleware/rateLimiter";
import { config } from "../config";
import {
    buildAuthorizationRequest,
    getOidcProviderId,
    handleCallback,
    type OidcClaims,
} from "../services/oidcAuth";
import {
    provisionOidcUser,
    resolveOidcAccount,
    syncOidcRole,
    type LoginUser,
    type OidcAccountResolution,
} from "../services/oidcAccountResolution";
import {
    InviteCodeExhaustedError,
    InviteCodeValidationError,
    claimInviteCode,
    loadUsableInviteCode,
    recordInviteCodeUsage,
} from "../services/inviteCodes";
import { putOnce, takeOnce } from "../utils/redisKv";
import { sendRouteError } from "./routeErrorResponse";
import {
    acquireRoleGuardLock,
    acquireUserScopedLock,
    USER_LOCK_NAMESPACES,
} from "../utils/advisoryLocks";

async function verifyTotpToken(
    secret: string,
    token: string,
): Promise<boolean> {
    if (
        typeof secret !== "string" ||
        typeof token !== "string" ||
        !/^\d{6}$/.test(token)
    ) {
        return false;
    }

    try {
        // 60 seconds of epoch tolerance matches the former speakeasy window of 2.
        const result = await verify({ secret, token, epochTolerance: 60 });
        return result.valid;
    } catch {
        // Deliberately fail closed when otplib rejects a malformed secret.
        return false;
    }
}

const router = Router();

const loginSchema = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
    token: z.string().min(1).optional(),
});

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

const subsonicPasswordSchema = z.object({
    password: z.string().min(8).max(128),
});

const appPasswordSchema = z
    .object({
        displayName: z.string().trim().min(1).max(64),
    })
    .strict();

// Use shared encryption module for 2FA secrets
const encrypt2FASecret = encrypt;
const decrypt2FASecret = decrypt;

interface SecondFactorUser {
    id: string;
    twoFactorEnabled: boolean;
    twoFactorSecret: string | null;
    twoFactorRecoveryCodes: string | null;
}

type SecondFactorResult =
    | { kind: "ok" }
    | { kind: "required" }
    | { kind: "invalid"; message: string };

async function verifyRecoveryCode(
    user: SecondFactorUser,
    token: string,
): Promise<boolean> {
    if (!user.twoFactorRecoveryCodes) return false;
    const hashes = decrypt2FASecret(user.twoFactorRecoveryCodes).split(",");
    const providedHash = crypto
        .createHash("sha256")
        .update(token.toUpperCase())
        .digest("hex");
    let matchIndex = -1;
    for (let index = 0; index < hashes.length; index += 1) {
        if (timingSafeCompare(hashes[index], providedHash)) matchIndex = index;
    }
    if (matchIndex === -1) return false;
    hashes.splice(matchIndex, 1);
    await prisma.user.update({
        where: { id: user.id },
        data: {
            twoFactorRecoveryCodes: encrypt2FASecret(hashes.join(",")),
        },
    });
    return true;
}

async function verifyLoginSecondFactor(
    user: SecondFactorUser,
    token?: string,
): Promise<SecondFactorResult> {
    if (!user.twoFactorEnabled || !user.twoFactorSecret) return { kind: "ok" };
    if (!token) return { kind: "required" };
    if (/^[A-F0-9]{8}$/i.test(token)) {
        const valid = await verifyRecoveryCode(user, token);
        return valid
            ? { kind: "ok" }
            : { kind: "invalid", message: "Invalid recovery code" };
    }
    const secret = decrypt2FASecret(user.twoFactorSecret);
    const valid = await verifyTotpToken(secret, token);
    return valid
        ? { kind: "ok" }
        : { kind: "invalid", message: "Invalid 2FA token" };
}

function sendLoginSuccess(res: Response, user: LoginUser): Response {
    return res.json({
        token: generateToken(user),
        refreshToken: generateRefreshToken(user),
        user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            role: user.role,
        },
    });
}

const OIDC_PENDING_TTL_SECONDS = 600;
const OIDC_EXCHANGE_TTL_SECONDS = 60;
const OIDC_FLOW_COOKIE_BASE_NAME = "soundspan_oidc_flow";
const MAX_COOKIE_HEADER_LENGTH = 4096;
const MAX_COOKIE_COUNT = 64;
const oidcLog = logger.child("OIDCAuth");
const credentialLog = logger.child("AuthCredentials");
const opaqueValueSchema = z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/);
const bindingHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const pendingOidcSchema = z
    .object({
        nonce: z.string().min(1),
        codeVerifier: z.string().min(1),
        returnTo: z
            .string()
            .refine((value) => normalizeReturnTo(value) === value),
        mode: z.literal("link").optional(),
        userId: z.string().min(1).optional(),
        bindingHash: bindingHashSchema,
    })
    .refine(
        (pending) =>
            pending.mode === "link"
                ? pending.userId !== undefined
                : pending.userId === undefined,
        { path: ["userId"] },
    );
const linkEntrySchema = z.object({
    provider: z.string().min(1),
    providerSubject: z.string().min(1),
    email: z.string().email().nullable(),
    displayName: z.string().nullable(),
    userId: z.string().min(1),
    groups: z.array(z.string()).default([]),
    bindingHash: bindingHashSchema,
    expiresAt: z.number().int().positive(),
});
const inviteEntrySchema = z.object({
    provider: z.string().min(1),
    providerSubject: z.string().min(1),
    email: z.string().email().nullable(),
    displayName: z.string().nullable(),
    preferredUsername: z.string().nullable().optional(),
    bindingHash: bindingHashSchema,
    expiresAt: z.number().int().positive(),
});
const exchangeEntrySchema = z.object({
    userId: z.string().min(1),
    bindingHash: bindingHashSchema,
});
const exchangeBodySchema = z.object({ code: opaqueValueSchema });
const linkStartBodySchema = z
    .object({ responseMode: z.literal("json").optional() })
    .strict();
const confirmLinkBodySchema = z.object({
    linkToken: opaqueValueSchema,
    password: z.string().min(1),
    twoFactorToken: z.string().min(1).optional(),
});
const redeemInviteBodySchema = z.object({
    inviteToken: opaqueValueSchema,
    inviteCode: z.string().min(1),
});
const resourceIdParamsSchema = z
    .object({
        id: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-z0-9]+$/),
    })
    .strict();
const callbackQuerySchema = z
    .object({
        state: opaqueValueSchema,
        code: z.string().optional(),
        iss: z.string().optional(),
        error: z.string().optional(),
        error_description: z.string().optional(),
        error_uri: z.string().optional(),
    })
    .loose();

function normalizeReturnTo(value: unknown): string {
    if (typeof value !== "string") return "/";
    if (!value.startsWith("/") || value.startsWith("//")) return "/";
    if (value.includes("\\")) return "/";
    try {
        const parsed = new URL(value, "https://soundspan.invalid");
        return parsed.origin === "https://soundspan.invalid" ? value : "/";
    } catch {
        return "/";
    }
}

function randomOpaqueValue(): string {
    return crypto.randomBytes(32).toString("base64url");
}

function hashOpaqueValue(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function flowCookieOptions(): CookieOptions {
    return {
        httpOnly: true,
        sameSite: "lax",
        secure: config.secureCookies,
        path: "/",
    };
}

function flowCookieName(): string {
    return config.secureCookies
        ? `__Host-${OIDC_FLOW_COOKIE_BASE_NAME}`
        : OIDC_FLOW_COOKIE_BASE_NAME;
}

function setFlowBindingCookie(res: Response, binding: string): void {
    res.cookie(flowCookieName(), binding, {
        ...flowCookieOptions(),
        maxAge: OIDC_PENDING_TTL_SECONDS * 1000,
    });
}

function clearFlowBindingCookie(res: Response): void {
    res.clearCookie(flowCookieName(), flowCookieOptions());
}

function readFlowBindingCookie(req: Request): string | null {
    const header = req.headers.cookie;
    if (!header || header.length > MAX_COOKIE_HEADER_LENGTH) return null;
    const cookies = header.split(";").slice(0, MAX_COOKIE_COUNT);
    for (const cookie of cookies) {
        const [name, value] = cookie.trim().split("=", 2);
        if (name === flowCookieName() && value) return value;
    }
    return null;
}

function hasMatchingFlowBinding(req: Request, bindingHash: string): boolean {
    const binding = readFlowBindingCookie(req);
    if (!binding) return false;
    return timingSafeCompare(hashOpaqueValue(binding), bindingHash);
}

async function storeOpaqueEntry(
    prefix: "link" | "invite" | "exchange",
    entry: unknown,
    ttlSeconds: number,
): Promise<string> {
    const token = randomOpaqueValue();
    const stored = await putOnce(`oidc:${prefix}:${token}`, entry, ttlSeconds);
    if (!stored) throw new Error("Failed to allocate one-time OIDC state");
    return token;
}

async function takeParsed<T>(
    key: string,
    schema: z.ZodType<T>,
): Promise<T | null> {
    const value = await takeOnce(key);
    if (value === null) return null;
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

function appendCallbackValue(url: URL, key: string, value: unknown): void {
    if (typeof value === "string") url.searchParams.set(key, value);
}

function buildCurrentCallbackUrl(query: z.infer<typeof callbackQuerySchema>) {
    const url = new URL(config.oidc.redirectUri);
    appendCallbackValue(url, "state", query.state);
    appendCallbackValue(url, "code", query.code);
    appendCallbackValue(url, "iss", query.iss);
    appendCallbackValue(url, "error", query.error);
    appendCallbackValue(url, "error_description", query.error_description);
    appendCallbackValue(url, "error_uri", query.error_uri);
    return url.toString();
}

async function regenerateSession(req: Request): Promise<void> {
    if (!req.session?.regenerate) return;
    await new Promise<void>((resolve, reject) => {
        req.session.regenerate((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

function loginRedirect(parameter: string, value: string, returnTo?: string) {
    const suffix = returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : "";
    return webRedirectTarget(
        `/login?${parameter}=${encodeURIComponent(value)}${suffix}`,
    );
}

function webRedirectTarget(path: string): string {
    return config.oidc.webBaseUrl ? `${config.oidc.webBaseUrl}${path}` : path;
}

function redirectResponse(res: Response, url: string): Response {
    res.redirect(url);
    return res;
}

interface OidcFlowBinding {
    returnTo: string;
    mode?: "link";
    userId?: string;
}

async function startOidcFlow(
    res: Response,
    binding: OidcFlowBinding,
    responseMode: "redirect" | "json" = "redirect",
): Promise<Response> {
    const authorization = await buildAuthorizationRequest();
    const flowBinding = randomOpaqueValue();
    const pending = {
        nonce: authorization.nonce,
        codeVerifier: authorization.codeVerifier,
        bindingHash: hashOpaqueValue(flowBinding),
        ...binding,
    };
    const stored = await putOnce(
        `oidc:pending:${authorization.state}`,
        pending,
        OIDC_PENDING_TTL_SECONDS,
    );
    if (!stored) throw new Error("Failed to store OIDC pending state");
    setFlowBindingCookie(res, flowBinding);
    if (responseMode === "json") {
        return res.json({ redirectUrl: authorization.redirectUrl });
    }
    return redirectResponse(res, authorization.redirectUrl);
}

async function redirectForResolution(
    res: Response,
    resolution: OidcAccountResolution,
    returnTo: string,
    bindingHash: string,
): Promise<Response> {
    if (resolution.kind === "alreadyLinked") {
        return redirectResponse(
            res,
            webRedirectTarget("/login?ssoError=account_already_linked"),
        );
    }
    if (resolution.kind === "authenticated") {
        const code = await storeOpaqueEntry(
            "exchange",
            { userId: resolution.user.id, bindingHash },
            OIDC_EXCHANGE_TTL_SECONDS,
        );
        return redirectResponse(res, loginRedirect("ssoCode", code, returnTo));
    }
    const prefix = resolution.kind;
    const expiresAt = Date.now() + OIDC_PENDING_TTL_SECONDS * 1000;
    const token = await storeOpaqueEntry(
        prefix,
        { ...resolution.entry, bindingHash, expiresAt },
        OIDC_PENDING_TTL_SECONDS,
    );
    const parameter = resolution.kind === "link" ? "ssoLink" : "ssoInvite";
    return redirectResponse(res, loginRedirect(parameter, token, returnTo));
}

async function oidcLoginHandler(
    req: Request,
    res: Response,
): Promise<Response> {
    if (!config.oidc.enabled) {
        return sendRouteError(res, 404, "OIDC is not enabled");
    }
    try {
        return await startOidcFlow(res, {
            returnTo: normalizeReturnTo(req.query.returnTo),
        });
    } catch (error) {
        oidcLog.error("OIDC login failed", { error });
        return redirectResponse(
            res,
            webRedirectTarget("/login?ssoError=oidc_failed"),
        );
    }
}

async function oidcLinkStartHandler(
    req: Request,
    res: Response,
): Promise<Response> {
    if (!config.oidc.enabled) {
        return sendRouteError(res, 404, "OIDC is not enabled");
    }
    const parsed = linkStartBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return sendRouteError(res, 400, "Invalid request");
    const responseMode = parsed.data.responseMode ?? "redirect";
    try {
        return await startOidcFlow(
            res,
            {
                returnTo: "/settings",
                mode: "link",
                userId: req.user!.id,
            },
            responseMode,
        );
    } catch (error) {
        oidcLog.error("OIDC link start failed", { error });
        if (responseMode === "json") {
            return sendRouteError(res, 500, "Failed to start OIDC link");
        }
        return redirectResponse(
            res,
            webRedirectTarget("/settings?ssoError=oidc_failed"),
        );
    }
}

function hasErrorCode(error: unknown, code: string): boolean {
    if (typeof error !== "object" || error === null) return false;
    return "code" in error && error.code === code;
}

async function createManualOidcLink(
    userId: string,
    claims: OidcClaims,
): Promise<boolean> {
    const provider = getOidcProviderId();
    const existing = await prisma.externalIdentity.findUnique({
        where: {
            provider_providerSubject: {
                provider,
                providerSubject: claims.sub,
            },
        },
        select: { id: true },
    });
    if (existing) return false;
    try {
        await prisma.externalIdentity.create({
            data: {
                userId,
                provider,
                providerSubject: claims.sub,
                email: claims.email,
                displayName: claims.name,
            },
        });
        return true;
    } catch (error) {
        if (hasErrorCode(error, "P2002")) return false;
        throw error;
    }
}

async function completeManualOidcLink(
    res: Response,
    userId: string,
    claims: OidcClaims,
): Promise<Response> {
    const linked = await createManualOidcLink(userId, claims);
    if (linked) clearFlowBindingCookie(res);
    const target = linked
        ? "/settings?ssoLinked=1"
        : "/settings?ssoError=identity_already_linked";
    return redirectResponse(res, webRedirectTarget(target));
}

async function oidcCallbackHandler(
    req: Request,
    res: Response,
): Promise<Response> {
    if (!config.oidc.enabled) {
        return sendRouteError(res, 404, "OIDC is not enabled");
    }
    const queryResult = callbackQuerySchema.safeParse(req.query);
    if (!queryResult.success) return rejectInvalidOidcState(res);
    const pending = await takeParsed(
        `oidc:pending:${queryResult.data.state}`,
        pendingOidcSchema,
    );
    if (!pending) return rejectInvalidOidcState(res);
    if (!hasMatchingFlowBinding(req, pending.bindingHash)) {
        return rejectInvalidOidcState(res);
    }
    try {
        const claims = await handleCallback(
            buildCurrentCallbackUrl(queryResult.data),
            { state: queryResult.data.state, ...pending },
        );
        await regenerateSession(req);
        if (pending.mode === "link" && pending.userId) {
            return await completeManualOidcLink(res, pending.userId, claims);
        }
        const resolution = await resolveOidcAccount(claims);
        return redirectForResolution(
            res,
            resolution,
            pending.returnTo,
            pending.bindingHash,
        );
    } catch (error) {
        oidcLog.error("OIDC callback failed", { error });
        const failureTarget =
            pending.mode === "link"
                ? "/settings?ssoError=oidc_failed"
                : "/login?ssoError=oidc_failed";
        return redirectResponse(res, webRedirectTarget(failureTarget));
    }
}

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

function rejectInvalidOidcState(res: Response): Response {
    oidcLog.warn("Rejected OIDC callback with invalid state");
    return redirectResponse(
        res,
        webRedirectTarget("/login?ssoError=invalid_state"),
    );
}

function queryStrippedLimiter(limiter: RequestHandler): RequestHandler {
    return (req, res, next): void => {
        const originalDescriptor = Object.getOwnPropertyDescriptor(
            req,
            "originalUrl",
        );
        const fullOriginalUrl = req.originalUrl;
        const pathOnly = req.path;
        const restore = (): void => {
            if (originalDescriptor) {
                Object.defineProperty(req, "originalUrl", originalDescriptor);
            } else {
                Reflect.deleteProperty(req, "originalUrl");
                req.originalUrl = fullOriginalUrl;
            }
        };
        // express-rate-limit can include originalUrl in debug output; hide the
        // OIDC callback query only while its middleware is executing.
        Object.defineProperty(req, "originalUrl", {
            configurable: true,
            value: pathOnly,
        });
        limiter(req, res, (error?: unknown) => {
            restore();
            next(error);
        });
    };
}

async function oidcExchangeHandler(
    req: Request,
    res: Response,
): Promise<Response> {
    const parsed = exchangeBodySchema.safeParse(req.body);
    if (!parsed.success) return sendRouteError(res, 400, "Invalid request");
    const exchange = await takeParsed(
        `oidc:exchange:${parsed.data.code}`,
        exchangeEntrySchema,
    );
    if (!exchange || !hasMatchingFlowBinding(req, exchange.bindingHash)) {
        return sendRouteError(res, 401, "Invalid or expired OIDC code");
    }
    const user = await prisma.user.findUnique({
        where: { id: exchange.userId },
        select: {
            id: true,
            username: true,
            displayName: true,
            role: true,
            tokenVersion: true,
        },
    });
    if (!user) {
        return sendRouteError(res, 401, "Invalid or expired OIDC code");
    }
    clearFlowBindingCookie(res);
    return sendLoginSuccess(res, user);
}

async function restoreLinkForRetry(
    token: string,
    entry: z.infer<typeof linkEntrySchema>,
): Promise<void> {
    const ttlSeconds = remainingEntryTtlSeconds(entry.expiresAt);
    if (ttlSeconds === null) return;
    const restored = await putOnce(`oidc:link:${token}`, entry, ttlSeconds);
    if (!restored) throw new Error("Failed to restore OIDC link state");
}

function remainingEntryTtlSeconds(expiresAt: number): number | null {
    const remainingMilliseconds = expiresAt - Date.now();
    if (remainingMilliseconds <= 0) return null;
    return Math.max(1, Math.floor(remainingMilliseconds / 1000));
}

async function oidcConfirmLinkHandler(
    req: Request,
    res: Response,
): Promise<Response> {
    const parsed = confirmLinkBodySchema.safeParse(req.body);
    if (!parsed.success) return sendRouteError(res, 400, "Invalid request");
    const entry = await takeParsed(
        `oidc:link:${parsed.data.linkToken}`,
        linkEntrySchema,
    );
    if (!entry || !hasMatchingFlowBinding(req, entry.bindingHash)) {
        await runDummyBcrypt();
        return sendRouteError(res, 401, "Invalid or expired link");
    }
    try {
        const user = await prisma.user.findUnique({
            where: { id: entry.userId },
        });
        if (!user) {
            await runDummyBcrypt();
            return sendRouteError(res, 401, "Invalid credentials");
        }
        if (!user.passwordHash) {
            await runDummyBcrypt();
            return sendRouteError(res, 401, "Invalid credentials");
        }
        const valid = await bcrypt.compare(
            parsed.data.password,
            user.passwordHash,
        );
        if (!valid) {
            await restoreLinkForRetry(parsed.data.linkToken, entry);
            return sendRouteError(res, 401, "Invalid credentials");
        }
        const secondFactor = await verifyLoginSecondFactor(
            user,
            parsed.data.twoFactorToken,
        );
        if (secondFactor.kind === "required") {
            await restoreLinkForRetry(parsed.data.linkToken, entry);
            return res.json({
                requires2FA: true,
                message: "2FA token required",
            });
        }
        if (secondFactor.kind === "invalid") {
            await restoreLinkForRetry(parsed.data.linkToken, entry);
            return sendRouteError(res, 401, secondFactor.message);
        }
        return completeOidcLink(res, user, entry);
    } catch (error) {
        oidcLog.error("OIDC link confirmation failed", { error });
        return sendRouteError(res, 500, "Failed to link OIDC account");
    }
}

async function completeOidcLink(
    res: Response,
    user: LoginUser,
    entry: z.infer<typeof linkEntrySchema>,
): Promise<Response> {
    await prisma.externalIdentity.create({
        data: {
            userId: user.id,
            provider: entry.provider,
            providerSubject: entry.providerSubject,
            email: entry.email,
            displayName: entry.displayName,
        },
    });
    const syncedUser = await syncOidcRole(user, entry.groups);
    clearFlowBindingCookie(res);
    return sendLoginSuccess(res, syncedUser);
}

async function restoreInviteForRetry(
    token: string,
    entry: z.infer<typeof inviteEntrySchema>,
): Promise<void> {
    const ttlSeconds = remainingEntryTtlSeconds(entry.expiresAt);
    if (ttlSeconds === null) return;
    const restored = await putOnce(`oidc:invite:${token}`, entry, ttlSeconds);
    if (!restored) throw new Error("Failed to restore OIDC invite state");
}

function claimsFromInvite(
    entry: z.infer<typeof inviteEntrySchema>,
): OidcClaims {
    return {
        sub: entry.providerSubject,
        email: entry.email,
        emailVerified: entry.email !== null,
        name: entry.displayName,
        preferredUsername: entry.preferredUsername ?? null,
        groups: [],
    };
}

async function oidcRedeemInviteHandler(
    req: Request,
    res: Response,
): Promise<Response> {
    const parsed = redeemInviteBodySchema.safeParse(req.body);
    if (!parsed.success) return sendRouteError(res, 400, "Invalid request");
    const entry = await takeParsed(
        `oidc:invite:${parsed.data.inviteToken}`,
        inviteEntrySchema,
    );
    if (!entry || !hasMatchingFlowBinding(req, entry.bindingHash)) {
        return sendRouteError(res, 401, "Invalid or expired invite");
    }
    try {
        const invite = await loadUsableInviteCode(parsed.data.inviteCode);
        const user = await provisionOidcUser(
            claimsFromInvite(entry),
            entry.provider,
            invite,
        );
        clearFlowBindingCookie(res);
        return sendLoginSuccess(res, user);
    } catch (error) {
        if (
            error instanceof InviteCodeValidationError ||
            error instanceof InviteCodeExhaustedError
        ) {
            await restoreInviteForRetry(parsed.data.inviteToken, entry);
            return sendRouteError(res, 400, error.message);
        }
        oidcLog.error("OIDC invite redemption failed", { error });
        return sendRouteError(res, 500, "Failed to redeem OIDC invite");
    }
}

/**
 * @openapi
 * /api/auth/config:
 *   get:
 *     summary: Get public authentication capabilities
 *     tags: [Authentication]
 *     security: []
 *     responses:
 *       200:
 *         description: Authentication capabilities
 */
router.get("/config", (_req, res) =>
    res.json({
        localLoginEnabled: config.localLoginEnabled,
        oidcEnabled: config.oidc.enabled,
        oidcProviderName: config.oidc.providerName,
    }),
);

/**
 * @openapi
 * /api/auth/oidc/login:
 *   get:
 *     summary: Start OIDC login
 *     tags: [Authentication]
 *     security: []
 *     responses:
 *       302:
 *         description: Redirect to the OIDC provider
 *       404:
 *         description: OIDC is disabled
 */
router.get("/oidc/login", oidcFlowLimiter, oidcLoginHandler);

/**
 * @openapi
 * /api/auth/oidc/link/start:
 *   post:
 *     summary: Start linking an OIDC identity to the current user
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               responseMode:
 *                 type: string
 *                 enum: [json]
 *     responses:
 *       200:
 *         description: OIDC provider URL for an authenticated SPA navigation
 *       302:
 *         description: Redirect to the OIDC provider
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Not authenticated
 *       403:
 *         description: Interactive session authentication required
 *       404:
 *         description: OIDC is disabled
 */
router.post(
    "/oidc/link/start",
    authLimiter,
    requireAuth,
    requireInteractiveSession,
    oidcLinkStartHandler,
);

/**
 * @openapi
 * /api/auth/oidc/callback:
 *   get:
 *     summary: Complete OIDC login
 *     tags: [Authentication]
 *     security: []
 *     responses:
 *       302:
 *         description: Redirect to the SPA login hand-off
 */
router.get(
    "/oidc/callback",
    queryStrippedLimiter(oidcFlowLimiter),
    oidcCallbackHandler,
);

/**
 * @openapi
 * /api/auth/oidc/exchange:
 *   post:
 *     summary: Exchange a one-time OIDC code for login tokens
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code]
 *             properties:
 *               code:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 256
 *                 pattern: '^[A-Za-z0-9_-]+$'
 *     responses:
 *       200:
 *         description: Login tokens and user
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginTokenResponse'
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Invalid or expired code
 */
router.post("/oidc/exchange", authLimiter, oidcExchangeHandler);

/**
 * @openapi
 * /api/auth/oidc/confirm-link:
 *   post:
 *     summary: Confirm an OIDC account link with local credentials
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [linkToken, password]
 *             properties:
 *               linkToken:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 256
 *                 pattern: '^[A-Za-z0-9_-]+$'
 *               password:
 *                 type: string
 *                 format: password
 *                 minLength: 1
 *               twoFactorToken:
 *                 type: string
 *                 minLength: 1
 *     responses:
 *       200:
 *         description: Login response or 2FA challenge
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - $ref: '#/components/schemas/LoginTokenResponse'
 *                 - $ref: '#/components/schemas/LoginTwoFactorChallenge'
 *       400:
 *         description: Invalid request
 *       401:
 *         description: Invalid credentials or link
 *       500:
 *         description: Failed to link OIDC account
 */
router.post("/oidc/confirm-link", authLimiter, oidcConfirmLinkHandler);

/**
 * @openapi
 * /api/auth/oidc/redeem-invite:
 *   post:
 *     summary: Redeem an invite for OIDC account provisioning
 *     tags: [Authentication]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [inviteToken, inviteCode]
 *             properties:
 *               inviteToken:
 *                 type: string
 *                 minLength: 1
 *                 maxLength: 256
 *                 pattern: '^[A-Za-z0-9_-]+$'
 *               inviteCode:
 *                 type: string
 *                 minLength: 1
 *     responses:
 *       200:
 *         description: Login tokens and provisioned user
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LoginTokenResponse'
 *       400:
 *         description: Invalid invite code
 *       401:
 *         description: Invalid or expired invite
 *       500:
 *         description: Failed to redeem OIDC invite
 */
router.post("/oidc/redeem-invite", authLimiter, oidcRedeemInviteHandler);

/**
 * @openapi
 * /api/auth/app-passwords:
 *   get:
 *     summary: List active app passwords for the current user
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Active app-password metadata without secrets
 *       401:
 *         description: Not authenticated
 */
router.get("/app-passwords", apiLimiter, requireAuth, listAppPasswordsHandler);

/**
 * @openapi
 * /api/auth/app-passwords:
 *   post:
 *     summary: Create an app password for the current user
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
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
 *       - sessionAuth: []
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

/**
 * @openapi
 * /api/auth/identities:
 *   get:
 *     summary: List external identities for the current user
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
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
 *       - sessionAuth: []
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
router.post("/change-password", authLimiter, requireAuth, async (req, res) => {
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

        if (!user.passwordHash) {
            return res
                .status(401)
                .json({ error: "Current password is incorrect" });
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
                subsonicPassword: null,
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
                return res.status(400).json({ error: "No fields to update" });
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
                return res
                    .status(400)
                    .json({ error: "Invalid request", details: err.issues });
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
                return res.status(404).json({ error: "Invite code not found" });
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

async function registerHandler(req: Request, res: Response): Promise<Response> {
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

/**
 * @openapi
 * /api/auth/2fa/setup:
 *   post:
 *     summary: Generate a 2FA secret and QR code for setup
 *     tags: [Authentication]
 *     security:
 *       - sessionAuth: []
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
 *       - sessionAuth: []
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
 *       - sessionAuth: []
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
    },
);

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
router.get("/subsonic-password", apiLimiter, requireAuth, async (req, res) => {
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
 *       - sessionAuth: []
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

export default router;
