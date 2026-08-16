import { createHash } from "crypto";

const mockConfig = {
    localLoginEnabled: true,
    secureCookies: false,
    oidc: {
        enabled: true,
        issuerUrl: "https://idp.example",
        clientId: "soundspan",
        clientSecret: "secret",
        redirectUri: "https://music.example/api/auth/oidc/callback",
        webBaseUrl: "",
        scopes: "openid profile email",
        autoProvision: false,
        manageRoles: false,
        groupsClaim: "groups",
        adminGroup: "admins",
        emailClaim: "email",
        nameClaim: "name",
        providerName: "Company SSO",
    },
};
jest.mock("../../config", () => ({ config: mockConfig }));

const scopedLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
scopedLogger.child.mockReturnValue(scopedLogger);
jest.mock("../../utils/logger", () => ({ logger: scopedLogger }));

const authLimiter = jest.fn((_req: unknown, _res: unknown, next: () => void) =>
    next(),
);
const oidcFlowLimiter = jest.fn(
    (_req: unknown, _res: unknown, next: () => void) => next(),
);
const apiLimiter = jest.fn((_req: unknown, _res: unknown, next: () => void) =>
    next(),
);
jest.mock("../../middleware/rateLimiter", () => ({
    adminSurfaceLimiter: apiLimiter,
    authLimiter,
    apiLimiter,
    oidcFlowLimiter,
}));

const generateToken = jest.fn(() => "jwt-access");
const generateRefreshToken = jest.fn(() => "jwt-refresh");
const requireAuth = jest.fn((_req: unknown, _res: unknown, next: () => void) =>
    next(),
);
const requireInteractiveSession = jest.fn(
    (_req: unknown, _res: unknown, next: () => void) => next(),
);
jest.mock("../../middleware/auth", () => ({
    requireAuth,
    requireInteractiveSession,
    requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
    generateToken,
    generateRefreshToken,
    verifyAuthToken: jest.fn(),
}));

const buildAuthorizationRequest = jest.fn();
const handleCallback = jest.fn();
jest.mock("../../services/oidcAuth", () => ({
    buildAuthorizationRequest,
    handleCallback,
    getOidcProviderId: () => "oidc:https://idp.example",
}));

const resolveOidcAccount = jest.fn();
const syncOidcRole = jest.fn();
const provisionOidcUser = jest.fn();
jest.mock("../../services/oidcAccountResolution", () => ({
    resolveOidcAccount,
    syncOidcRole,
    provisionOidcUser,
}));

const loadUsableInviteCode = jest.fn();
class InviteCodeValidationError extends Error {}
class InviteCodeExhaustedError extends Error {}
jest.mock("../../services/inviteCodes", () => ({
    loadUsableInviteCode,
    InviteCodeValidationError,
    InviteCodeExhaustedError,
    consumeInviteCode: jest.fn(),
    claimInviteCode: jest.fn(),
    recordInviteCodeUsage: jest.fn(),
}));

const values = new Map<string, unknown>();
const putOnce = jest.fn(async (key: string, value: unknown) => {
    if (values.has(key)) return false;
    values.set(key, value);
    return true;
});
const takeOnce = jest.fn(async (key: string) => {
    const value = values.get(key) ?? null;
    values.delete(key);
    return value;
});
jest.mock("../../utils/redisKv", () => ({ putOnce, takeOnce }));

const prisma = {
    user: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
    },
    userSettings: { create: jest.fn() },
    externalIdentity: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        count: jest.fn(),
        delete: jest.fn(),
    },
    appPassword: {
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
    },
    inviteCode: {
        findUnique: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
    },
    inviteCodeUsage: { create: jest.fn() },
    $executeRaw: jest.fn(),
    $transaction: jest.fn(),
};
jest.mock("../../utils/db", () => ({ prisma }));

const bcryptCompare = jest.fn();
const bcryptHash = jest.fn();
jest.mock("bcrypt", () => ({
    __esModule: true,
    default: { compare: bcryptCompare, hash: bcryptHash },
}));

const verifyTotp = jest.fn();
jest.mock("otplib", () => ({
    generateSecret: jest.fn(),
    generateURI: jest.fn(),
    verify: verifyTotp,
}));
jest.mock("qrcode", () => ({
    __esModule: true,
    default: { toDataURL: jest.fn() },
}));
const encrypt = jest.fn((value: string) => `enc(${value})`);
const decrypt = jest.fn((value: string) =>
    value.replace(/^enc\((.*)\)$/, "$1"),
);
jest.mock("../../utils/encryption", () => ({ encrypt, decrypt }));
const runDummyBcrypt = jest.fn();
jest.mock("../../utils/dummyCredential", () => ({ runDummyBcrypt }));

import router from "../auth";

type Method = "get" | "post" | "delete";

function getLayer(path: string, method: Method) {
    const layer = (
        router as unknown as { stack: Array<Record<string, any>> }
    ).stack.find(
        (entry) => entry.route?.path === path && entry.route.methods?.[method],
    );
    if (!layer) throw new Error(`${method.toUpperCase()} ${path} not found`);
    return layer;
}

function getHandler(path: string, method: Method) {
    const stack = getLayer(path, method).route.stack;
    return stack[stack.length - 1].handle;
}

function createRes() {
    const res: {
        statusCode: number;
        body: unknown;
        redirectUrl: string | undefined;
        status: jest.Mock;
        json: jest.Mock;
        redirect: jest.Mock;
        cookie: jest.Mock;
        clearCookie: jest.Mock;
    } = {
        statusCode: 200,
        body: undefined as unknown,
        redirectUrl: undefined as string | undefined,
        status: jest.fn((code: number) => {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn((body: unknown) => {
            res.body = body;
            return res;
        }),
        redirect: jest.fn((url: string) => {
            res.statusCode = 302;
            res.redirectUrl = url;
            return res;
        }),
        cookie: jest.fn(() => res),
        clearCookie: jest.fn(() => res),
    };
    return res;
}

const loginUser = {
    id: "u1",
    username: "alice",
    displayName: "Alice",
    role: "user",
    tokenVersion: 1,
};

const FLOW_BINDING = "browser-flow-binding";
const FLOW_BINDING_HASH = createHash("sha256")
    .update(FLOW_BINDING)
    .digest("hex");

function callbackRequest(
    state = "state-1",
    flowBinding: string | null = FLOW_BINDING,
) {
    return {
        query: { state, code: "authorization-code" },
        headers: flowBinding
            ? { cookie: `soundspan_oidc_flow=${flowBinding}` }
            : {},
        originalUrl: `/api/auth/oidc/callback?state=${state}&code=authorization-code`,
        path: "/api/auth/oidc/callback",
    };
}

describe("OIDC auth routes", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        values.clear();
        mockConfig.localLoginEnabled = true;
        mockConfig.secureCookies = false;
        mockConfig.oidc.enabled = true;
        mockConfig.oidc.webBaseUrl = "";
        buildAuthorizationRequest.mockResolvedValue({
            redirectUrl:
                "https://idp.example/authorize?state=state-1&nonce=nonce-1&code_challenge=challenge&code_challenge_method=S256",
            state: "state-1",
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
        });
        handleCallback.mockResolvedValue({
            sub: "subject-1",
            email: "alice@example.com",
            emailVerified: true,
            name: "Alice",
            preferredUsername: "alice",
            groups: [],
        });
        resolveOidcAccount.mockResolvedValue({
            kind: "authenticated",
            user: loginUser,
        });
        syncOidcRole.mockImplementation(async (user) => user);
        provisionOidcUser.mockResolvedValue(loginUser);
        bcryptCompare.mockResolvedValue(true);
        bcryptHash.mockResolvedValue("hash");
        verifyTotp.mockResolvedValue({ valid: true });
        runDummyBcrypt.mockResolvedValue(undefined);
        prisma.user.findUnique.mockResolvedValue({
            ...loginUser,
            passwordHash: "hash",
            twoFactorEnabled: false,
            twoFactorSecret: null,
            twoFactorRecoveryCodes: null,
        });
        prisma.externalIdentity.create.mockResolvedValue({});
        prisma.externalIdentity.findMany.mockResolvedValue([]);
        prisma.externalIdentity.findUnique.mockResolvedValue(null);
        prisma.externalIdentity.findFirst.mockResolvedValue(null);
        prisma.externalIdentity.count.mockResolvedValue(2);
        prisma.externalIdentity.delete.mockResolvedValue({});
        prisma.appPassword.findMany.mockResolvedValue([]);
        prisma.appPassword.count.mockResolvedValue(0);
        prisma.appPassword.create.mockResolvedValue({
            id: "app-1",
            displayName: "Phone",
            createdAt: new Date("2026-08-15T12:00:00.000Z"),
            lastUsedAt: null,
        });
        prisma.appPassword.updateMany.mockResolvedValue({ count: 1 });
        loadUsableInviteCode.mockResolvedValue({ id: "invite-1" });
        prisma.$executeRaw.mockResolvedValue(0);
        prisma.$transaction.mockImplementation(async (run) => run(prisma));
    });

    it("returns public login capabilities", async () => {
        const res = createRes();
        await getHandler("/config", "get")({}, res);

        expect(res.body).toEqual({
            localLoginEnabled: true,
            oidcEnabled: true,
            oidcProviderName: "Company SSO",
        });
    });

    it.each([
        ["post", "/oidc/exchange"],
        ["post", "/oidc/confirm-link"],
        ["post", "/oidc/redeem-invite"],
        ["post", "/oidc/link/start"],
    ] as const)("attaches authLimiter first on %s %s", (method, path) => {
        expect(getLayer(path, method).route.stack[0].handle).toBe(authLimiter);
    });

    it("uses the flow limiter on OIDC redirect endpoints", () => {
        expect(getLayer("/oidc/login", "get").route.stack[0].handle).toBe(
            oidcFlowLimiter,
        );
        expect(
            getLayer("/oidc/callback", "get").route.stack[0].handle,
        ).not.toBe(authLimiter);
    });

    it("strips callback query data only while the flow limiter runs", async () => {
        const middleware = getLayer("/oidc/callback", "get").route.stack[0]
            .handle;
        const req = callbackRequest();
        let downstreamUrl = "";
        oidcFlowLimiter.mockImplementationOnce((limitedReq, _res, next) => {
            expect((limitedReq as typeof req).originalUrl).toBe(
                "/api/auth/oidc/callback",
            );
            next();
        });

        await middleware(req, createRes(), () => {
            downstreamUrl = req.originalUrl;
        });

        expect(downstreamUrl).toBe(
            "/api/auth/oidc/callback?state=state-1&code=authorization-code",
        );
    });

    it("protects the manual link start route with interactive authentication", () => {
        const stack = getLayer("/oidc/link/start", "post").route.stack;
        expect(stack[1].handle).toBe(requireAuth);
        expect(stack[2].handle).toBe(requireInteractiveSession);
    });

    it.each([
        ["get", "/app-passwords", apiLimiter],
        ["post", "/app-passwords", authLimiter],
        ["delete", "/app-passwords/:id", authLimiter],
        ["get", "/identities", apiLimiter],
        ["delete", "/identities/:id", authLimiter],
    ] as const)(
        "rate-limits and authenticates %s %s",
        (method, path, limiter) => {
            const stack = getLayer(path, method).route.stack;
            expect(stack[0].handle).toBe(limiter);
            expect(stack[1].handle).toBe(requireAuth);
        },
    );

    it.each([
        ["post", "/app-passwords"],
        ["delete", "/app-passwords/:id"],
        ["delete", "/identities/:id"],
    ] as const)(
        "requires interactive authentication on %s %s",
        (method, path) => {
            const stack = getLayer(path, method).route.stack;
            expect(stack[2].handle).toBe(requireInteractiveSession);
        },
    );

    it("stores pending state and redirects with state, nonce, and PKCE", async () => {
        const res = createRes();
        await getHandler("/oidc/login", "get")(
            { query: { returnTo: "/settings" } },
            res,
        );

        expect(putOnce).toHaveBeenCalledWith(
            "oidc:pending:state-1",
            expect.objectContaining({
                nonce: "nonce-1",
                codeVerifier: "verifier-1",
                returnTo: "/settings",
                bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
            600,
        );
        expect(res.cookie).toHaveBeenCalledWith(
            "soundspan_oidc_flow",
            expect.stringMatching(/^[A-Za-z0-9_-]+$/),
            {
                httpOnly: true,
                sameSite: "lax",
                secure: false,
                path: "/",
                maxAge: 600_000,
            },
        );
        expect(res.redirectUrl).toContain("state=state-1");
        expect(res.redirectUrl).toContain("nonce=nonce-1");
        expect(res.redirectUrl).toContain("code_challenge=");
    });

    it("uses a __Host- flow cookie on secure deployments", async () => {
        mockConfig.secureCookies = true;
        const loginRes = createRes();

        await getHandler("/oidc/login", "get")(
            { query: { returnTo: "/" } },
            loginRes,
        );

        expect(loginRes.cookie).toHaveBeenCalledWith(
            "__Host-soundspan_oidc_flow",
            expect.any(String),
            expect.objectContaining({ secure: true, path: "/" }),
        );

        values.set("oidc:exchange:secure-exchange", {
            userId: "u1",
            bindingHash: FLOW_BINDING_HASH,
        });
        const exchangeRes = createRes();
        await getHandler("/oidc/exchange", "post")(
            {
                body: { code: "secure-exchange" },
                headers: {
                    cookie: `__Host-soundspan_oidc_flow=${FLOW_BINDING}`,
                },
            },
            exchangeRes,
        );

        expect(exchangeRes.statusCode).toBe(200);
        expect(exchangeRes.clearCookie).toHaveBeenCalledWith(
            "__Host-soundspan_oidc_flow",
            expect.objectContaining({ secure: true, path: "/" }),
        );
    });

    it.each(["//evil.test", "https://evil.test", "\\evil", "/\\evil"])(
        "defaults an unsafe returnTo %s to the root path",
        async (returnTo) => {
            const res = createRes();
            await getHandler("/oidc/login", "get")(
                { query: { returnTo } },
                res,
            );

            expect(putOnce).toHaveBeenCalledWith(
                "oidc:pending:state-1",
                expect.objectContaining({ returnTo: "/" }),
                600,
            );
        },
    );

    it("rejects unknown and replayed callback state without calling the provider", async () => {
        const callback = getHandler("/oidc/callback", "get");
        const firstRes = createRes();
        await callback(callbackRequest("unknown"), firstRes);
        expect(firstRes.redirectUrl).toBe("/login?ssoError=invalid_state");

        values.set("oidc:pending:state-1", {
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
            returnTo: "/library",
            bindingHash: FLOW_BINDING_HASH,
        });
        await callback(callbackRequest(), createRes());
        const replayRes = createRes();
        await callback(callbackRequest(), replayRes);
        expect(replayRes.redirectUrl).toBe("/login?ssoError=invalid_state");
        expect(handleCallback).toHaveBeenCalledTimes(1);
    });

    it("absolutizes invalid-state redirects for a configured web origin", async () => {
        mockConfig.oidc.webBaseUrl = "https://music.example";
        const res = createRes();

        await getHandler("/oidc/callback", "get")(
            callbackRequest("unknown"),
            res,
        );

        expect(res.redirectUrl).toBe(
            "https://music.example/login?ssoError=invalid_state",
        );
    });

    it.each([
        ["missing", null],
        ["mismatched", "different-browser-binding"],
    ] as const)(
        "rejects a callback with a %s flow-binding cookie",
        async (_case, flowBinding) => {
            values.set("oidc:pending:state-1", {
                nonce: "nonce-1",
                codeVerifier: "verifier-1",
                returnTo: "/library",
                bindingHash: FLOW_BINDING_HASH,
            });
            const res = createRes();

            await getHandler("/oidc/callback", "get")(
                callbackRequest("state-1", flowBinding),
                res,
            );

            expect(res.redirectUrl).toBe("/login?ssoError=invalid_state");
            expect(handleCallback).not.toHaveBeenCalled();
        },
    );

    it("hands a linked identity to the SPA through a single-use exchange code", async () => {
        values.set("oidc:pending:state-1", {
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
            returnTo: "/library",
            bindingHash: FLOW_BINDING_HASH,
        });
        const callbackRes = createRes();
        const callbackReq = callbackRequest();
        await getHandler("/oidc/callback", "get")(callbackReq, callbackRes);
        expect(callbackRes.redirectUrl).toMatch(
            /^\/login\?ssoCode=[A-Za-z0-9_-]+&returnTo=%2Flibrary$/,
        );
        const code = new URL(
            callbackRes.redirectUrl!,
            "https://music.example",
        ).searchParams.get("ssoCode");
        expect(code).not.toBeNull();
        expect(values.get(`oidc:exchange:${code}`)).toEqual({
            userId: "u1",
            bindingHash: FLOW_BINDING_HASH,
        });

        const exchange = getHandler("/oidc/exchange", "post");
        const first = createRes();
        await exchange(
            {
                body: { code },
                headers: { cookie: `soundspan_oidc_flow=${FLOW_BINDING}` },
            },
            first,
        );
        expect(first.body).toEqual({
            token: "jwt-access",
            refreshToken: "jwt-refresh",
            user: {
                id: "u1",
                username: "alice",
                displayName: "Alice",
                role: "user",
            },
        });
        expect(first.clearCookie).toHaveBeenCalledWith("soundspan_oidc_flow", {
            httpOnly: true,
            sameSite: "lax",
            secure: false,
            path: "/",
        });

        const replay = createRes();
        await exchange(
            {
                body: { code },
                headers: { cookie: `soundspan_oidc_flow=${FLOW_BINDING}` },
            },
            replay,
        );
        expect(replay.statusCode).toBe(401);
    });

    it("absolutizes the SSO exchange-code callback target", async () => {
        mockConfig.oidc.webBaseUrl = "https://music.example";
        values.set("oidc:pending:state-1", {
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
            returnTo: "/library",
            bindingHash: FLOW_BINDING_HASH,
        });
        const res = createRes();

        await getHandler("/oidc/callback", "get")(callbackRequest(), res);

        expect(res.redirectUrl).toMatch(
            /^https:\/\/music\.example\/login\?ssoCode=[A-Za-z0-9_-]+&returnTo=%2Flibrary$/,
        );
    });

    it("rejects a nonce mismatch without creating an exchange code", async () => {
        values.set("oidc:pending:state-1", {
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
            returnTo: "/library",
            bindingHash: FLOW_BINDING_HASH,
        });
        handleCallback.mockRejectedValueOnce(
            new Error("unexpected nonce value in ID token"),
        );
        const req = callbackRequest();
        const res = createRes();

        await getHandler("/oidc/callback", "get")(req, res);

        expect(res.redirectUrl).toBe("/login?ssoError=oidc_failed");
        expect(resolveOidcAccount).not.toHaveBeenCalled();
        expect(
            [...values.keys()].some((key) => key.startsWith("oidc:exchange:")),
        ).toBe(false);
    });

    it.each([
        ["link", "ssoLink"],
        ["invite", "ssoInvite"],
    ] as const)(
        "redirects a %s resolution with opaque state",
        async (kind, key) => {
            const now = 1_800_000_000_000;
            jest.spyOn(Date, "now").mockReturnValue(now);
            values.set("oidc:pending:state-1", {
                nonce: "nonce-1",
                codeVerifier: "verifier-1",
                returnTo: "/",
                bindingHash: FLOW_BINDING_HASH,
            });
            resolveOidcAccount.mockResolvedValueOnce({
                kind,
                entry:
                    kind === "link"
                        ? {
                              provider: "oidc:https://idp.example",
                              providerSubject: "subject-1",
                              email: "alice@example.com",
                              displayName: "Alice",
                              userId: "u1",
                              groups: [],
                          }
                        : {
                              provider: "oidc:https://idp.example",
                              providerSubject: "subject-1",
                              email: "alice@example.com",
                              displayName: "Alice",
                          },
            });
            const res = createRes();

            await getHandler("/oidc/callback", "get")(callbackRequest(), res);

            expect(res.redirectUrl).toMatch(
                new RegExp(`^/login\\?${key}=[A-Za-z0-9_-]+&returnTo=%2F$`),
            );
            const token = new URL(
                res.redirectUrl!,
                "https://music.example",
            ).searchParams.get(key);
            expect(values.get(`oidc:${kind}:${token}`)).toEqual(
                expect.objectContaining({
                    bindingHash: FLOW_BINDING_HASH,
                    expiresAt: now + 600_000,
                }),
            );
        },
    );

    it.each([
        ["link", "ssoLink"],
        ["invite", "ssoInvite"],
    ] as const)("absolutizes a %s callback target", async (kind, parameter) => {
        mockConfig.oidc.webBaseUrl = "https://music.example";
        values.set("oidc:pending:state-1", {
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
            returnTo: "/",
            bindingHash: FLOW_BINDING_HASH,
        });
        resolveOidcAccount.mockResolvedValueOnce({
            kind,
            entry:
                kind === "link"
                    ? {
                          provider: "oidc:https://idp.example",
                          providerSubject: "subject-1",
                          email: "alice@example.com",
                          displayName: "Alice",
                          userId: "u1",
                          groups: [],
                      }
                    : {
                          provider: "oidc:https://idp.example",
                          providerSubject: "subject-1",
                          email: "alice@example.com",
                          displayName: "Alice",
                      },
        });
        const res = createRes();

        await getHandler("/oidc/callback", "get")(callbackRequest(), res);

        expect(res.redirectUrl).toMatch(
            new RegExp(
                `^https://music\\.example/login\\?${parameter}=[A-Za-z0-9_-]+&returnTo=%2F$`,
            ),
        );
    });

    it("rejects an email-matched account already linked to the provider", async () => {
        values.set("oidc:pending:state-1", {
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
            returnTo: "/",
            bindingHash: FLOW_BINDING_HASH,
        });
        resolveOidcAccount.mockResolvedValueOnce({ kind: "alreadyLinked" });
        const res = createRes();

        await getHandler("/oidc/callback", "get")(callbackRequest(), res);

        expect(res.redirectUrl).toBe("/login?ssoError=account_already_linked");
    });

    it("absolutizes callback failure redirects", async () => {
        mockConfig.oidc.webBaseUrl = "https://music.example";
        values.set("oidc:pending:state-1", {
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
            returnTo: "/",
            bindingHash: FLOW_BINDING_HASH,
        });
        handleCallback.mockRejectedValueOnce(new Error("provider failure"));
        const res = createRes();

        await getHandler("/oidc/callback", "get")(callbackRequest(), res);

        expect(res.redirectUrl).toBe(
            "https://music.example/login?ssoError=oidc_failed",
        );
    });

    it("absolutizes an account-already-linked callback target", async () => {
        mockConfig.oidc.webBaseUrl = "https://music.example";
        values.set("oidc:pending:state-1", {
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
            returnTo: "/",
            bindingHash: FLOW_BINDING_HASH,
        });
        resolveOidcAccount.mockResolvedValueOnce({ kind: "alreadyLinked" });
        const res = createRes();

        await getHandler("/oidc/callback", "get")(callbackRequest(), res);

        expect(res.redirectUrl).toBe(
            "https://music.example/login?ssoError=account_already_linked",
        );
    });

    it("starts a user-bound OIDC link flow and rejects it when OIDC is disabled", async () => {
        const start = getHandler("/oidc/link/start", "post");
        const enabled = createRes();
        await start({ user: { id: "initiating-user" }, query: {} }, enabled);

        expect(putOnce).toHaveBeenCalledWith(
            "oidc:pending:state-1",
            expect.objectContaining({
                nonce: "nonce-1",
                codeVerifier: "verifier-1",
                returnTo: "/settings",
                mode: "link",
                userId: "initiating-user",
                bindingHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
            600,
        );
        expect(enabled.cookie).toHaveBeenCalled();
        expect(enabled.redirectUrl).toContain("state=state-1");

        mockConfig.oidc.enabled = false;
        const disabled = createRes();
        await start({ user: { id: "initiating-user" }, query: {} }, disabled);
        expect(disabled.statusCode).toBe(404);
        expect(disabled.body).toEqual({ error: "OIDC is not enabled" });
    });

    it("returns the OIDC provider URL for an authenticated SPA link navigation", async () => {
        const res = createRes();

        await getHandler("/oidc/link/start", "post")(
            {
                user: { id: "initiating-user" },
                body: { responseMode: "json" },
            },
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            redirectUrl:
                "https://idp.example/authorize?state=state-1&nonce=nonce-1&code_challenge=challenge&code_challenge_method=S256",
        });
        expect(res.cookie).toHaveBeenCalledWith(
            "soundspan_oidc_flow",
            expect.any(String),
            expect.objectContaining({ maxAge: 600_000 }),
        );
        expect(res.redirect).not.toHaveBeenCalled();
    });

    it("absolutizes a manual-link start failure target", async () => {
        mockConfig.oidc.webBaseUrl = "https://music.example";
        buildAuthorizationRequest.mockRejectedValueOnce(
            new Error("provider unavailable"),
        );
        const res = createRes();

        await getHandler("/oidc/link/start", "post")(
            { user: { id: "initiating-user" }, body: {} },
            res,
        );

        expect(res.redirectUrl).toBe(
            "https://music.example/settings?ssoError=oidc_failed",
        );
    });

    it("rejects an unsupported OIDC link response mode", async () => {
        const res = createRes();

        await getHandler("/oidc/link/start", "post")(
            {
                user: { id: "initiating-user" },
                body: { responseMode: "redirect" },
            },
            res,
        );

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Invalid request" });
        expect(buildAuthorizationRequest).not.toHaveBeenCalled();
    });

    it("links callback claims to the initiating user without logging in", async () => {
        values.set("oidc:pending:state-1", {
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
            returnTo: "/settings",
            mode: "link",
            userId: "initiating-user",
            bindingHash: FLOW_BINDING_HASH,
        });
        const res = createRes();
        const req = callbackRequest();
        const order: string[] = [];
        prisma.externalIdentity.create.mockImplementationOnce(async () => {
            order.push("link");
            return {};
        });

        await getHandler("/oidc/callback", "get")(req, res);

        expect(prisma.externalIdentity.create).toHaveBeenCalledWith({
            data: {
                userId: "initiating-user",
                provider: "oidc:https://idp.example",
                providerSubject: "subject-1",
                email: "alice@example.com",
                displayName: "Alice",
            },
        });
        expect(res.redirectUrl).toBe("/settings?ssoLinked=1");
        expect(order).toEqual(["link"]);
        expect(res.clearCookie).toHaveBeenCalledWith(
            "soundspan_oidc_flow",
            expect.objectContaining({ path: "/" }),
        );
        expect(resolveOidcAccount).not.toHaveBeenCalled();
        expect(generateToken).not.toHaveBeenCalled();
        expect(generateRefreshToken).not.toHaveBeenCalled();
        expect(
            [...values.keys()].some((key) => key.startsWith("oidc:exchange:")),
        ).toBe(false);
    });

    it.each([
        ["linked", false, "https://music.example/settings?ssoLinked=1"],
        [
            "already linked",
            true,
            "https://music.example/settings?ssoError=identity_already_linked",
        ],
    ] as const)(
        "absolutizes the manual-link %s target",
        async (_outcome, identityExists, expected) => {
            mockConfig.oidc.webBaseUrl = "https://music.example";
            values.set("oidc:pending:state-1", {
                nonce: "nonce-1",
                codeVerifier: "verifier-1",
                returnTo: "/settings",
                mode: "link",
                userId: "initiating-user",
                bindingHash: FLOW_BINDING_HASH,
            });
            prisma.externalIdentity.findUnique.mockResolvedValueOnce(
                identityExists ? { id: "existing-link" } : null,
            );
            const res = createRes();

            await getHandler("/oidc/callback", "get")(callbackRequest(), res);

            expect(res.redirectUrl).toBe(expected);
        },
    );

    it("absolutizes a manual-link callback failure target", async () => {
        mockConfig.oidc.webBaseUrl = "https://music.example";
        values.set("oidc:pending:state-1", {
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
            returnTo: "/settings",
            mode: "link",
            userId: "initiating-user",
            bindingHash: FLOW_BINDING_HASH,
        });
        handleCallback.mockRejectedValueOnce(new Error("provider failure"));
        const res = createRes();

        await getHandler("/oidc/callback", "get")(callbackRequest(), res);

        expect(res.redirectUrl).toBe(
            "https://music.example/settings?ssoError=oidc_failed",
        );
    });

    it("rejects malformed link state instead of falling through to login", async () => {
        values.set("oidc:pending:state-1", {
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
            returnTo: "/settings",
            mode: "link",
            bindingHash: FLOW_BINDING_HASH,
        });
        const res = createRes();

        await getHandler("/oidc/callback", "get")(callbackRequest(), res);

        expect(res.redirectUrl).toBe("/login?ssoError=invalid_state");
        expect(handleCallback).not.toHaveBeenCalled();
        expect(resolveOidcAccount).not.toHaveBeenCalled();
    });

    it("rejects a manual link when the provider subject is already linked", async () => {
        values.set("oidc:pending:state-1", {
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
            returnTo: "/settings",
            mode: "link",
            userId: "initiating-user",
            bindingHash: FLOW_BINDING_HASH,
        });
        prisma.externalIdentity.findUnique.mockResolvedValueOnce({
            id: "existing-link",
        });
        const res = createRes();

        await getHandler("/oidc/callback", "get")(callbackRequest(), res);

        expect(res.redirectUrl).toBe(
            "/settings?ssoError=identity_already_linked",
        );
        expect(prisma.externalIdentity.create).not.toHaveBeenCalled();
        expect(resolveOidcAccount).not.toHaveBeenCalled();
        expect(res.clearCookie).not.toHaveBeenCalled();
    });

    it("maps a database user-provider uniqueness conflict to already linked", async () => {
        values.set("oidc:pending:state-1", {
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
            returnTo: "/settings",
            mode: "link",
            userId: "initiating-user",
            bindingHash: FLOW_BINDING_HASH,
        });
        prisma.externalIdentity.create.mockRejectedValueOnce({
            code: "P2002",
            meta: { target: ["userId", "provider"] },
        });
        const res = createRes();

        await getHandler("/oidc/callback", "get")(callbackRequest(), res);

        expect(res.redirectUrl).toBe(
            "/settings?ssoError=identity_already_linked",
        );
        expect(res.clearCookie).not.toHaveBeenCalled();
    });

    it("creates an encrypted app password once and lists only safe active metadata", async () => {
        const created = createRes();
        await getHandler("/app-passwords", "post")(
            {
                user: { id: "u1" },
                body: { displayName: "  Phone  " },
            },
            created,
        );

        const createData = prisma.appPassword.create.mock.calls[0][0].data;
        expect(createData).toEqual({
            userId: "u1",
            displayName: "Phone",
            encryptedSecret: expect.stringMatching(/^enc\(ssap_/),
        });
        expect(created.statusCode).toBe(201);
        expect(created.body).toEqual({
            appPassword: {
                id: "app-1",
                displayName: "Phone",
                createdAt: new Date("2026-08-15T12:00:00.000Z"),
                lastUsedAt: null,
                secret: expect.stringMatching(/^ssap_[A-Za-z0-9_-]{32}$/),
            },
        });

        prisma.appPassword.findMany.mockResolvedValueOnce([
            {
                id: "app-1",
                displayName: "Phone",
                createdAt: new Date("2026-08-15T12:00:00.000Z"),
                lastUsedAt: null,
            },
        ]);
        const listed = createRes();
        await getHandler("/app-passwords", "get")(
            { user: { id: "u1" } },
            listed,
        );

        expect(prisma.appPassword.findMany).toHaveBeenCalledWith({
            where: { userId: "u1", revokedAt: null },
            select: {
                id: true,
                displayName: true,
                createdAt: true,
                lastUsedAt: true,
            },
            orderBy: { createdAt: "desc" },
        });
        expect(listed.body).toEqual({
            appPasswords: [
                {
                    id: "app-1",
                    displayName: "Phone",
                    createdAt: new Date("2026-08-15T12:00:00.000Z"),
                    lastUsedAt: null,
                },
            ],
        });
        expect(JSON.stringify(listed.body)).not.toContain("secret");
    });

    it("serializes app-password count and creation inside the transaction", async () => {
        const order: string[] = [];
        prisma.$executeRaw.mockImplementationOnce(async () => {
            order.push("lock");
            return 0;
        });
        prisma.appPassword.count.mockImplementationOnce(async () => {
            order.push("count");
            return 0;
        });
        prisma.appPassword.create.mockImplementationOnce(async () => {
            order.push("create");
            return {
                id: "app-1",
                displayName: "Phone",
                createdAt: new Date("2026-08-15T12:00:00.000Z"),
                lastUsedAt: null,
            };
        });
        const res = createRes();

        await getHandler("/app-passwords", "post")(
            { user: { id: "u1" }, body: { displayName: "Phone" } },
            res,
        );

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(order).toEqual(["lock", "count", "create"]);
        expect(res.statusCode).toBe(201);
    });

    it("caps active app passwords at twenty and soft-revokes owned credentials", async () => {
        prisma.appPassword.count.mockResolvedValueOnce(20);
        const capped = createRes();
        await getHandler("/app-passwords", "post")(
            { user: { id: "u1" }, body: { displayName: "Tablet" } },
            capped,
        );
        expect(capped.statusCode).toBe(400);
        expect(capped.body).toEqual({
            error: "A maximum of 20 active app passwords is allowed",
        });
        expect(prisma.appPassword.create).not.toHaveBeenCalled();

        const revoked = createRes();
        await getHandler("/app-passwords/:id", "delete")(
            { user: { id: "u1" }, params: { id: "app1" } },
            revoked,
        );
        expect(prisma.appPassword.updateMany).toHaveBeenCalledWith({
            where: { id: "app1", userId: "u1", revokedAt: null },
            data: { revokedAt: expect.any(Date) },
        });
        expect(revoked.body).toEqual({ message: "App password revoked" });
    });

    it("lists identities without full subjects and unlinks an owned identity", async () => {
        prisma.externalIdentity.findMany.mockResolvedValueOnce([
            {
                id: "identity-1",
                provider: "oidc:https://idp.example",
                providerSubject: "subject-123456789",
                email: "alice@example.com",
                displayName: "Alice",
                createdAt: new Date("2026-08-15T12:00:00.000Z"),
            },
        ]);
        const listed = createRes();
        await getHandler("/identities", "get")({ user: { id: "u1" } }, listed);
        expect(listed.body).toEqual({
            identities: [
                {
                    id: "identity-1",
                    provider: "oidc:https://idp.example",
                    email: "alice@example.com",
                    displayName: "Alice",
                    createdAt: new Date("2026-08-15T12:00:00.000Z"),
                    subjectHint: "subject-…",
                },
            ],
        });
        expect(JSON.stringify(listed.body)).not.toContain("123456789");

        prisma.externalIdentity.findFirst.mockResolvedValueOnce({
            id: "identity1",
        });
        prisma.user.findUnique.mockResolvedValueOnce({ passwordHash: "hash" });
        const unlinked = createRes();
        await getHandler("/identities/:id", "delete")(
            { user: { id: "u1" }, params: { id: "identity1" } },
            unlinked,
        );
        expect(prisma.externalIdentity.delete).toHaveBeenCalledWith({
            where: { id: "identity1" },
        });
        expect(unlinked.body).toEqual({ message: "Identity unlinked" });
    });

    it("returns 404 when revoking or unlinking another user's credential", async () => {
        prisma.appPassword.updateMany.mockResolvedValueOnce({ count: 0 });
        const appPassword = createRes();
        await getHandler("/app-passwords/:id", "delete")(
            { user: { id: "u1" }, params: { id: "otherapp" } },
            appPassword,
        );
        expect(appPassword.statusCode).toBe(404);
        expect(appPassword.body).toEqual({ error: "App password not found" });

        prisma.externalIdentity.findFirst.mockResolvedValueOnce(null);
        const identity = createRes();
        await getHandler("/identities/:id", "delete")(
            { user: { id: "u1" }, params: { id: "otheridentity" } },
            identity,
        );
        expect(identity.statusCode).toBe(404);
        expect(identity.body).toEqual({ error: "Identity not found" });
    });

    it("blocks unlinking the last credential for a null-hash user", async () => {
        prisma.externalIdentity.findFirst.mockResolvedValueOnce({
            id: "identity1",
        });
        prisma.user.findUnique.mockResolvedValueOnce({ passwordHash: null });
        prisma.externalIdentity.count.mockResolvedValueOnce(1);
        const res = createRes();

        await getHandler("/identities/:id", "delete")(
            { user: { id: "u1" }, params: { id: "identity1" } },
            res,
        );

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Cannot unlink the last sign-in method",
        });
        expect(prisma.externalIdentity.delete).not.toHaveBeenCalled();
    });

    it.each(["/app-passwords/:id", "/identities/:id"] as const)(
        "returns the canonical 404 for malformed %s path parameters",
        async (path) => {
            const res = createRes();

            await getHandler(path, "delete")(
                { user: { id: "u1" }, params: { id: "bad-id!" } },
                res,
            );

            expect(res.statusCode).toBe(404);
            expect(prisma.appPassword.updateMany).not.toHaveBeenCalled();
            expect(prisma.$transaction).not.toHaveBeenCalled();
        },
    );

    it("serializes the unlink strand guard and rechecks inside the transaction", async () => {
        const order: string[] = [];
        prisma.$executeRaw.mockImplementationOnce(async () => {
            order.push("lock");
            return 0;
        });
        prisma.externalIdentity.findFirst.mockImplementationOnce(async () => {
            order.push("identity");
            return { id: "identity1" };
        });
        prisma.user.findUnique.mockImplementationOnce(async () => {
            order.push("user");
            return { passwordHash: null };
        });
        prisma.externalIdentity.count.mockImplementationOnce(async () => {
            order.push("count");
            return 1;
        });
        const res = createRes();

        await getHandler("/identities/:id", "delete")(
            { user: { id: "u1" }, params: { id: "identity1" } },
            res,
        );

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(order).toEqual(["lock", "identity", "user", "count"]);
        expect(res.statusCode).toBe(400);
        expect(prisma.externalIdentity.delete).not.toHaveBeenCalled();
    });

    it.each([
        [
            "exchange",
            "/oidc/exchange",
            "code",
            "exchange-token",
            "Invalid or expired OIDC code",
        ],
        [
            "link",
            "/oidc/confirm-link",
            "linkToken",
            "link-token-value",
            "Invalid or expired link",
        ],
        [
            "invite",
            "/oidc/redeem-invite",
            "inviteToken",
            "invite-token-value",
            "Invalid or expired invite",
        ],
    ] as const)(
        "rejects missing and mismatched binding cookies for %s tokens",
        async (prefix, path, field, token, error) => {
            const entry =
                prefix === "exchange"
                    ? { userId: "u1", bindingHash: FLOW_BINDING_HASH }
                    : {
                          provider: "oidc:https://idp.example",
                          providerSubject: "subject-1",
                          email: "alice@example.com",
                          displayName: "Alice",
                          ...(prefix === "link"
                              ? { userId: "u1", groups: [] }
                              : {}),
                          bindingHash: FLOW_BINDING_HASH,
                          expiresAt: Date.now() + 600_000,
                      };
            const body = {
                [field]: token,
                ...(prefix === "link" ? { password: "correct" } : {}),
                ...(prefix === "invite" ? { inviteCode: "INVITE" } : {}),
            };
            for (const headers of [
                {},
                { cookie: "soundspan_oidc_flow=wrong-browser" },
            ]) {
                values.set(`oidc:${prefix}:${token}`, entry);
                const res = createRes();
                await getHandler(path, "post")({ body, headers }, res);
                expect(res.statusCode).toBe(401);
                expect(res.body).toEqual({ error });
            }
        },
    );

    it("restores the same link token after a wrong password so confirmation can be retried", async () => {
        const confirm = getHandler("/oidc/confirm-link", "post");
        const entry = {
            provider: "oidc:https://idp.example",
            providerSubject: "subject-1",
            email: "alice@example.com",
            displayName: "Alice",
            userId: "u1",
            groups: [],
            bindingHash: FLOW_BINDING_HASH,
            expiresAt: Date.now() + 600_000,
        };
        values.set("oidc:link:wrong-token-value", entry);
        bcryptCompare.mockResolvedValueOnce(false);
        const wrong = createRes();
        await confirm(
            {
                body: { linkToken: "wrong-token-value", password: "bad" },
                headers: { cookie: `soundspan_oidc_flow=${FLOW_BINDING}` },
            },
            wrong,
        );
        expect(wrong.statusCode).toBe(401);
        expect(values.get("oidc:link:wrong-token-value")).toEqual(entry);

        const retry = createRes();
        await confirm(
            {
                body: {
                    linkToken: "wrong-token-value",
                    password: "correct",
                },
                headers: { cookie: `soundspan_oidc_flow=${FLOW_BINDING}` },
            },
            retry,
        );

        expect(retry.statusCode).toBe(200);
        expect(retry.body).toEqual(
            expect.objectContaining({
                token: "jwt-access",
                refreshToken: "jwt-refresh",
            }),
        );
        expect(prisma.externalIdentity.create).toHaveBeenCalledTimes(1);
    });

    it("rejects a null local password without restoring the link", async () => {
        const confirm = getHandler("/oidc/confirm-link", "post");
        const entry = {
            provider: "oidc:https://idp.example",
            providerSubject: "subject-1",
            email: "alice@example.com",
            displayName: "Alice",
            userId: "u1",
            groups: [],
            bindingHash: FLOW_BINDING_HASH,
            expiresAt: Date.now() + 600_000,
        };

        values.set("oidc:link:null-password-token", entry);
        prisma.user.findUnique.mockResolvedValueOnce({
            ...loginUser,
            passwordHash: null,
            twoFactorEnabled: false,
            twoFactorSecret: null,
            twoFactorRecoveryCodes: null,
        });
        const nullPassword = createRes();
        await confirm(
            {
                body: {
                    linkToken: "null-password-token",
                    password: "bad",
                },
                headers: { cookie: `soundspan_oidc_flow=${FLOW_BINDING}` },
            },
            nullPassword,
        );
        expect(nullPassword.statusCode).toBe(401);
        expect(bcryptCompare).not.toHaveBeenCalled();
        expect(runDummyBcrypt).toHaveBeenCalledTimes(1);
        expect(values.has("oidc:link:null-password-token")).toBe(false);
    });

    it("runs dummy bcrypt work for a missing link token", async () => {
        const res = createRes();

        await getHandler("/oidc/confirm-link", "post")(
            {
                body: {
                    linkToken: "missing-link-token",
                    password: "password",
                },
                headers: { cookie: `soundspan_oidc_flow=${FLOW_BINDING}` },
            },
            res,
        );

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Invalid or expired link" });
        expect(runDummyBcrypt).toHaveBeenCalledTimes(1);
        expect(putOnce).not.toHaveBeenCalled();
        expect(values.has("oidc:link:missing-link-token")).toBe(false);
    });

    it("does not restore a link token when the linked user vanished", async () => {
        const entry = {
            provider: "oidc:https://idp.example",
            providerSubject: "subject-1",
            email: "alice@example.com",
            displayName: "Alice",
            userId: "missing-user",
            groups: [],
            bindingHash: FLOW_BINDING_HASH,
            expiresAt: Date.now() + 600_000,
        };
        values.set("oidc:link:vanished-user-token", entry);
        prisma.user.findUnique.mockResolvedValueOnce(null);
        const res = createRes();

        await getHandler("/oidc/confirm-link", "post")(
            {
                body: {
                    linkToken: "vanished-user-token",
                    password: "password",
                },
                headers: { cookie: `soundspan_oidc_flow=${FLOW_BINDING}` },
            },
            res,
        );

        expect(res.statusCode).toBe(401);
        expect(values.has("oidc:link:vanished-user-token")).toBe(false);
        expect(putOnce).not.toHaveBeenCalled();
    });

    it("restores the same link token for the two-step 2FA challenge", async () => {
        const now = 1_800_000_000_000;
        jest.spyOn(Date, "now").mockReturnValue(now);
        const entry = {
            provider: "oidc:https://idp.example",
            providerSubject: "subject-1",
            email: "alice@example.com",
            displayName: "Alice",
            userId: "u1",
            groups: [],
            bindingHash: FLOW_BINDING_HASH,
            expiresAt: now + 450_000,
        };
        values.set("oidc:link:two-factor-token", entry);
        prisma.user.findUnique.mockResolvedValueOnce({
            ...loginUser,
            passwordHash: "hash",
            twoFactorEnabled: true,
            twoFactorSecret: "enc(SECRET)",
            twoFactorRecoveryCodes: null,
        });
        const res = createRes();

        await getHandler("/oidc/confirm-link", "post")(
            {
                body: {
                    linkToken: "two-factor-token",
                    password: "correct",
                },
                headers: { cookie: `soundspan_oidc_flow=${FLOW_BINDING}` },
            },
            res,
        );

        expect(res.body).toEqual({
            requires2FA: true,
            message: "2FA token required",
        });
        expect(putOnce).toHaveBeenCalledWith(
            "oidc:link:two-factor-token",
            entry,
            450,
        );
    });

    it("shrinks the restored link TTL as the absolute deadline approaches", async () => {
        const createdAt = 1_800_000_000_000;
        const now = createdAt + 125_000;
        jest.spyOn(Date, "now").mockReturnValue(now);
        const entry = {
            provider: "oidc:https://idp.example",
            providerSubject: "subject-1",
            email: "alice@example.com",
            displayName: "Alice",
            userId: "u1",
            groups: [],
            bindingHash: FLOW_BINDING_HASH,
            expiresAt: createdAt + 600_000,
        };
        values.set("oidc:link:shrinking-token", entry);
        bcryptCompare.mockResolvedValueOnce(false);
        const res = createRes();

        await getHandler("/oidc/confirm-link", "post")(
            {
                body: { linkToken: "shrinking-token", password: "bad" },
                headers: { cookie: `soundspan_oidc_flow=${FLOW_BINDING}` },
            },
            res,
        );

        expect(res.statusCode).toBe(401);
        expect(putOnce).toHaveBeenCalledWith(
            "oidc:link:shrinking-token",
            entry,
            475,
        );
    });

    it("consumes a link entry that expires before it can be restored", async () => {
        const now = 1_800_000_000_000;
        jest.spyOn(Date, "now").mockReturnValue(now);
        const entry = {
            provider: "oidc:https://idp.example",
            providerSubject: "subject-1",
            email: "alice@example.com",
            displayName: "Alice",
            userId: "u1",
            groups: [],
            bindingHash: FLOW_BINDING_HASH,
            expiresAt: now,
        };
        values.set("oidc:link:expired-token", entry);
        bcryptCompare.mockResolvedValueOnce(false);
        const res = createRes();

        await getHandler("/oidc/confirm-link", "post")(
            {
                body: { linkToken: "expired-token", password: "bad" },
                headers: { cookie: `soundspan_oidc_flow=${FLOW_BINDING}` },
            },
            res,
        );

        expect(res.statusCode).toBe(401);
        expect(values.has("oidc:link:expired-token")).toBe(false);
        expect(putOnce).not.toHaveBeenCalled();
    });

    it("restores the same link token after invalid TOTP so confirmation can be retried", async () => {
        const confirm = getHandler("/oidc/confirm-link", "post");
        const entry = {
            provider: "oidc:https://idp.example",
            providerSubject: "subject-1",
            email: "alice@example.com",
            displayName: "Alice",
            userId: "u1",
            groups: [],
            bindingHash: FLOW_BINDING_HASH,
            expiresAt: Date.now() + 600_000,
        };
        values.set("oidc:link:invalid-totp-token", entry);
        prisma.user.findUnique.mockResolvedValue({
            ...loginUser,
            passwordHash: "hash",
            twoFactorEnabled: true,
            twoFactorSecret: "enc(SECRET)",
            twoFactorRecoveryCodes: null,
        });
        verifyTotp.mockResolvedValueOnce({ valid: false });
        const invalid = createRes();

        await confirm(
            {
                body: {
                    linkToken: "invalid-totp-token",
                    password: "correct",
                    twoFactorToken: "000000",
                },
                headers: { cookie: `soundspan_oidc_flow=${FLOW_BINDING}` },
            },
            invalid,
        );

        expect(invalid.statusCode).toBe(401);
        expect(invalid.body).toEqual({ error: "Invalid 2FA token" });
        expect(values.get("oidc:link:invalid-totp-token")).toEqual(entry);

        const retry = createRes();
        await confirm(
            {
                body: {
                    linkToken: "invalid-totp-token",
                    password: "correct",
                    twoFactorToken: "123456",
                },
                headers: { cookie: `soundspan_oidc_flow=${FLOW_BINDING}` },
            },
            retry,
        );

        expect(retry.statusCode).toBe(200);
        expect(retry.body).toEqual(
            expect.objectContaining({
                token: "jwt-access",
                refreshToken: "jwt-refresh",
            }),
        );
        expect(prisma.externalIdentity.create).toHaveBeenCalledTimes(1);
    });

    it("creates the external identity, syncs role, and returns login data after confirmation", async () => {
        const entry = {
            provider: "oidc:https://idp.example",
            providerSubject: "subject-1",
            email: "alice@example.com",
            displayName: "Alice",
            userId: "u1",
            groups: ["admins"],
            bindingHash: FLOW_BINDING_HASH,
            expiresAt: Date.now() + 600_000,
        };
        values.set("oidc:link:successful-link-token", entry);
        const res = createRes();

        await getHandler("/oidc/confirm-link", "post")(
            {
                body: {
                    linkToken: "successful-link-token",
                    password: "correct",
                },
                headers: { cookie: `soundspan_oidc_flow=${FLOW_BINDING}` },
            },
            res,
        );

        expect(prisma.externalIdentity.create).toHaveBeenCalledWith({
            data: {
                userId: "u1",
                provider: "oidc:https://idp.example",
                providerSubject: "subject-1",
                email: "alice@example.com",
                displayName: "Alice",
            },
        });
        expect(syncOidcRole).toHaveBeenCalledWith(
            expect.objectContaining({ id: "u1" }),
            ["admins"],
        );
        expect(res.body).toEqual(
            expect.objectContaining({
                token: "jwt-access",
                refreshToken: "jwt-refresh",
            }),
        );
        expect(res.clearCookie).toHaveBeenCalledWith(
            "soundspan_oidc_flow",
            expect.objectContaining({ path: "/" }),
        );
    });

    it("keeps an invalid invite token retryable and provisions a valid one", async () => {
        const now = 1_800_000_000_000;
        jest.spyOn(Date, "now").mockReturnValue(now);
        const redeem = getHandler("/oidc/redeem-invite", "post");
        const entry = {
            provider: "oidc:https://idp.example",
            providerSubject: "subject-1",
            email: "alice@example.com",
            displayName: "Alice",
            bindingHash: FLOW_BINDING_HASH,
            expiresAt: now + 320_000,
        };
        values.set("oidc:invite:invite-token-value", entry);
        loadUsableInviteCode.mockRejectedValueOnce(
            new InviteCodeValidationError("Invalid invite code"),
        );
        const invalid = createRes();
        await redeem(
            {
                body: {
                    inviteToken: "invite-token-value",
                    inviteCode: "BAD",
                },
                headers: { cookie: `soundspan_oidc_flow=${FLOW_BINDING}` },
            },
            invalid,
        );
        expect(invalid.statusCode).toBe(400);
        expect(values.get("oidc:invite:invite-token-value")).toEqual(entry);
        expect(putOnce).toHaveBeenCalledWith(
            "oidc:invite:invite-token-value",
            entry,
            320,
        );

        const valid = createRes();
        await redeem(
            {
                body: {
                    inviteToken: "invite-token-value",
                    inviteCode: "GOOD",
                },
                headers: { cookie: `soundspan_oidc_flow=${FLOW_BINDING}` },
            },
            valid,
        );
        expect(provisionOidcUser).toHaveBeenCalledWith(
            expect.objectContaining({ sub: "subject-1" }),
            "oidc:https://idp.example",
            { id: "invite-1" },
        );
        expect(valid.body).toEqual(
            expect.objectContaining({
                token: "jwt-access",
                refreshToken: "jwt-refresh",
            }),
        );
        expect(valid.clearCookie).toHaveBeenCalledWith(
            "soundspan_oidc_flow",
            expect.objectContaining({ path: "/" }),
        );
    });

    // The spec's disabled-user criterion maps to LOCAL_LOGIN_ENABLED here; User has no disabled flag.
    it("returns generic local-login failures for null hashes and blocks disabled web login", async () => {
        const login = getHandler("/login", "post");
        prisma.user.findUnique.mockResolvedValueOnce({
            ...loginUser,
            passwordHash: null,
            twoFactorEnabled: false,
            twoFactorSecret: null,
            twoFactorRecoveryCodes: null,
        });
        const nullHash = createRes();
        await login(
            { body: { username: "alice", password: "password" } },
            nullHash,
        );
        expect(nullHash.statusCode).toBe(401);
        expect(nullHash.body).toEqual({ error: "Invalid credentials" });
        expect(runDummyBcrypt).toHaveBeenCalledTimes(1);
        expect(bcryptCompare).not.toHaveBeenCalled();

        mockConfig.localLoginEnabled = false;
        const disabled = createRes();
        await login(
            { body: { username: "alice", password: "password" } },
            disabled,
        );
        expect(disabled.statusCode).toBe(403);
        expect(disabled.body).toEqual({ error: "Local login is disabled" });
    });

    it("rejects null hashes without bcrypt in password-change and 2FA-disable routes", async () => {
        prisma.user.findUnique.mockResolvedValue({
            ...loginUser,
            passwordHash: null,
            twoFactorEnabled: true,
            twoFactorSecret: "enc(SECRET)",
            twoFactorRecoveryCodes: null,
        });
        const changePassword = createRes();
        await getHandler("/change-password", "post")(
            {
                user: { id: "u1" },
                body: {
                    currentPassword: "current-password",
                    newPassword: "new-password",
                },
            },
            changePassword,
        );
        expect(changePassword.statusCode).toBe(401);

        const disable2fa = createRes();
        await getHandler("/2fa/disable", "post")(
            {
                user: { id: "u1" },
                body: { password: "current-password", token: "123456" },
            },
            disable2fa,
        );
        expect(disable2fa.statusCode).toBe(401);
        expect(bcryptCompare).not.toHaveBeenCalled();
    });
});
