import type {
    CookieOptions,
    Request,
    RequestHandler,
    Response,
    Router,
} from "express";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { z } from "zod";
import { prisma } from "../../utils/db";
import { requireAuth, requireInteractiveSession } from "../../middleware/auth";
import { authLimiter, oidcFlowLimiter } from "../../middleware/rateLimiter";
import { config } from "../../config";
import {
    buildAuthorizationRequest,
    getOidcProviderId,
    handleCallback,
    type OidcClaims,
} from "../../services/oidcAuth";
import {
    provisionOidcUser,
    resolveOidcAccount,
    syncOidcRole,
    type LoginUser,
    type OidcAccountResolution,
} from "../../services/oidcAccountResolution";
import {
    InviteCodeExhaustedError,
    InviteCodeValidationError,
    loadUsableInviteCode,
} from "../../services/inviteCodes";
import { putOnce, takeOnce } from "../../utils/redisKv";
import { timingSafeCompare } from "../../utils/timingSafe";
import { runDummyBcrypt } from "../../utils/dummyCredential";
import { sendRouteError } from "../routeErrorResponse";
import {
    hasErrorCode,
    oidcLog,
    sendLoginSuccess,
    verifyLoginSecondFactor,
} from "./shared";

const OIDC_PENDING_TTL_SECONDS = 600;
const OIDC_EXCHANGE_TTL_SECONDS = 60;
const OIDC_FLOW_COOKIE_BASE_NAME = "soundspan_oidc_flow";
const MAX_COOKIE_HEADER_LENGTH = 4096;
const MAX_COOKIE_COUNT = 64;
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

/** Register OIDC and public authentication-capability routes. */
export default function registerOidcRoutes(router: Router): void {
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
}
