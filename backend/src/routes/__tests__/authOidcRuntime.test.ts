const mockConfig = {
    localLoginEnabled: true,
    oidc: {
        enabled: true,
        issuerUrl: "https://idp.example",
        clientId: "soundspan",
        clientSecret: "secret",
        redirectUri: "https://music.example/api/auth/oidc/callback",
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
const apiLimiter = jest.fn((_req: unknown, _res: unknown, next: () => void) =>
    next(),
);
jest.mock("../../middleware/rateLimiter", () => ({
    authLimiter,
    apiLimiter,
}));

const generateToken = jest.fn(() => "jwt-access");
const generateRefreshToken = jest.fn(() => "jwt-refresh");
jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
    requireInteractiveSession: (
        _req: unknown,
        _res: unknown,
        next: () => void,
    ) => next(),
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
    externalIdentity: { create: jest.fn() },
    inviteCode: {
        findUnique: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
    },
    inviteCodeUsage: { create: jest.fn() },
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
jest.mock("../../utils/encryption", () => ({
    encrypt: (value: string) => `enc(${value})`,
    decrypt: (value: string) => value.replace(/^enc\((.*)\)$/, "$1"),
}));
const runDummyBcrypt = jest.fn();
jest.mock("../../utils/dummyCredential", () => ({ runDummyBcrypt }));

import router from "../auth";

type Method = "get" | "post";

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

function callbackRequest(state = "state-1") {
    return {
        query: { state, code: "authorization-code" },
        session: {
            regenerate: jest.fn((done: (error?: Error) => void) => done()),
        },
    };
}

describe("OIDC auth routes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        values.clear();
        mockConfig.localLoginEnabled = true;
        mockConfig.oidc.enabled = true;
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
        loadUsableInviteCode.mockResolvedValue({ id: "invite-1" });
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
        ["get", "/oidc/login"],
        ["get", "/oidc/callback"],
        ["post", "/oidc/exchange"],
        ["post", "/oidc/confirm-link"],
        ["post", "/oidc/redeem-invite"],
    ] as const)("attaches authLimiter first on %s %s", (method, path) => {
        expect(getLayer(path, method).route.stack[0].handle).toBe(authLimiter);
    });

    it("stores pending state and redirects with state, nonce, and PKCE", async () => {
        const res = createRes();
        await getHandler("/oidc/login", "get")(
            { query: { returnTo: "/settings" } },
            res,
        );

        expect(putOnce).toHaveBeenCalledWith(
            "oidc:pending:state-1",
            {
                nonce: "nonce-1",
                codeVerifier: "verifier-1",
                returnTo: "/settings",
            },
            600,
        );
        expect(res.redirectUrl).toContain("state=state-1");
        expect(res.redirectUrl).toContain("nonce=nonce-1");
        expect(res.redirectUrl).toContain("code_challenge=");
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
        });
        await callback(callbackRequest(), createRes());
        const replayRes = createRes();
        await callback(callbackRequest(), replayRes);
        expect(replayRes.redirectUrl).toBe("/login?ssoError=invalid_state");
        expect(handleCallback).toHaveBeenCalledTimes(1);
    });

    it("hands a linked identity to the SPA through a single-use exchange code", async () => {
        values.set("oidc:pending:state-1", {
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
            returnTo: "/library",
        });
        const callbackRes = createRes();
        const callbackReq = callbackRequest();
        await getHandler("/oidc/callback", "get")(callbackReq, callbackRes);
        expect(callbackReq.session.regenerate).toHaveBeenCalledTimes(1);
        expect(callbackRes.redirectUrl).toMatch(
            /^\/login\?ssoCode=[A-Za-z0-9_-]+&returnTo=%2Flibrary$/,
        );
        const code = new URL(
            callbackRes.redirectUrl!,
            "https://music.example",
        ).searchParams.get("ssoCode");
        expect(code).not.toBeNull();

        const exchange = getHandler("/oidc/exchange", "post");
        const first = createRes();
        await exchange({ body: { code } }, first);
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

        const replay = createRes();
        await exchange({ body: { code } }, replay);
        expect(replay.statusCode).toBe(401);
    });

    it.each([
        ["link", "ssoLink"],
        ["invite", "ssoInvite"],
    ] as const)(
        "redirects a %s resolution with opaque state",
        async (kind, key) => {
            values.set("oidc:pending:state-1", {
                nonce: "nonce-1",
                codeVerifier: "verifier-1",
                returnTo: "/",
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
        },
    );

    it("rejects an email-matched account already linked to the provider", async () => {
        values.set("oidc:pending:state-1", {
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
            returnTo: "/",
        });
        resolveOidcAccount.mockResolvedValueOnce({ kind: "alreadyLinked" });
        const res = createRes();

        await getHandler("/oidc/callback", "get")(callbackRequest(), res);

        expect(res.redirectUrl).toBe("/login?ssoError=account_already_linked");
    });

    it("rejects wrong and null local passwords during link confirmation", async () => {
        const confirm = getHandler("/oidc/confirm-link", "post");
        const entry = {
            provider: "oidc:https://idp.example",
            providerSubject: "subject-1",
            email: "alice@example.com",
            displayName: "Alice",
            userId: "u1",
            groups: [],
        };
        values.set("oidc:link:wrong-token-value", entry);
        bcryptCompare.mockResolvedValueOnce(false);
        const wrong = createRes();
        await confirm(
            { body: { linkToken: "wrong-token-value", password: "bad" } },
            wrong,
        );
        expect(wrong.statusCode).toBe(401);

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
            },
            nullPassword,
        );
        expect(nullPassword.statusCode).toBe(401);
        expect(bcryptCompare).toHaveBeenCalledTimes(1);
    });

    it("restores the same link token for the two-step 2FA challenge", async () => {
        const entry = {
            provider: "oidc:https://idp.example",
            providerSubject: "subject-1",
            email: "alice@example.com",
            displayName: "Alice",
            userId: "u1",
            groups: [],
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
            600,
        );
    });

    it("creates the external identity, syncs role, and returns login data after confirmation", async () => {
        const entry = {
            provider: "oidc:https://idp.example",
            providerSubject: "subject-1",
            email: "alice@example.com",
            displayName: "Alice",
            userId: "u1",
            groups: ["admins"],
        };
        values.set("oidc:link:successful-link-token", entry);
        const res = createRes();

        await getHandler("/oidc/confirm-link", "post")(
            {
                body: {
                    linkToken: "successful-link-token",
                    password: "correct",
                },
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
    });

    it("keeps an invalid invite token retryable and provisions a valid one", async () => {
        const redeem = getHandler("/oidc/redeem-invite", "post");
        const entry = {
            provider: "oidc:https://idp.example",
            providerSubject: "subject-1",
            email: "alice@example.com",
            displayName: "Alice",
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
            },
            invalid,
        );
        expect(invalid.statusCode).toBe(400);
        expect(values.get("oidc:invite:invite-token-value")).toEqual(entry);

        const valid = createRes();
        await redeem(
            {
                body: {
                    inviteToken: "invite-token-value",
                    inviteCode: "GOOD",
                },
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
    });

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
