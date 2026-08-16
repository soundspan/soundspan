const originalJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET =
    process.env.JWT_SECRET || "auth-interactive-route-test-secret";

jest.mock("../../config", () => ({
    config: {
        redisUrl: "redis://localhost:6379",
        localLoginEnabled: true,
        secureCookies: false,
        oidc: {
            enabled: true,
            issuerUrl: "",
            clientId: "",
            clientSecret: "",
            redirectUri: "",
            scopes: "openid profile email",
            autoProvision: false,
            manageRoles: false,
            groupsClaim: "groups",
            adminGroup: "",
            emailClaim: "email",
            nameClaim: "name",
            providerName: "SSO",
        },
    },
}));

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: any, _res: any, next: () => void) => next(),
    requireInteractiveSession: (req: any, res: any, next: () => void) =>
        jest
            .requireActual<
                typeof import("../../middleware/auth")
            >("../../middleware/auth")
            .requireInteractiveSession(req, res, next),
    requireAdmin: (_req: any, _res: any, next: () => void) => next(),
    generateToken: jest.fn(),
    generateRefreshToken: jest.fn(),
    verifyAuthToken: jest.fn(),
}));

const mockBcryptCompare = jest.fn();
jest.mock("bcrypt", () => ({
    __esModule: true,
    default: {
        compare: (...args: unknown[]) => mockBcryptCompare(...args),
        hash: jest.fn(),
    },
}));

const mockTotpVerify = jest.fn();
jest.mock("otplib", () => ({
    generateSecret: jest.fn(() => "NEW-SECRET"),
    generateURI: jest.fn(() => "otpauth://test"),
    verify: (...args: unknown[]) => mockTotpVerify(...args),
}));

jest.mock("qrcode", () => ({
    __esModule: true,
    default: { toDataURL: jest.fn(() => "data:image/png;base64,test") },
}));

jest.mock("../../utils/encryption", () => ({
    encrypt: (value: string) => `enc(${value})`,
    decrypt: (value: string) => value.replace(/^enc\((.*)\)$/, "$1"),
}));

const prisma = {
    user: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
    },
    appPassword: {
        count: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
    },
    externalIdentity: {
        findFirst: jest.fn(),
        count: jest.fn(),
        delete: jest.fn(),
    },
    $executeRaw: jest.fn(),
    $transaction: jest.fn(),
};
jest.mock("../../utils/db", () => ({ prisma }));

const scopedLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
scopedLogger.child.mockReturnValue(scopedLogger);
jest.mock("../../utils/logger", () => ({ logger: scopedLogger }));

jest.mock("../../middleware/rateLimiter", () => ({
    adminSurfaceLimiter: (_req: any, _res: any, next: () => void) => next(),
    authLimiter: (_req: any, _res: any, next: () => void) => next(),
    apiLimiter: (_req: any, _res: any, next: () => void) => next(),
    oidcFlowLimiter: (_req: any, _res: any, next: () => void) => next(),
}));

const buildAuthorizationRequest = jest.fn();
jest.mock("../../services/oidcAuth", () => ({
    buildAuthorizationRequest,
    getOidcProviderId: jest.fn(),
    handleCallback: jest.fn(),
}));
jest.mock("../../services/oidcAccountResolution", () => ({
    provisionOidcUser: jest.fn(),
    resolveOidcAccount: jest.fn(),
    syncOidcRole: jest.fn(),
}));
jest.mock("../../services/inviteCodes", () => ({
    InviteCodeExhaustedError: class extends Error {},
    InviteCodeValidationError: class extends Error {},
    claimInviteCode: jest.fn(),
    loadUsableInviteCode: jest.fn(),
    recordInviteCodeUsage: jest.fn(),
}));
const putOnce = jest.fn();
jest.mock("../../utils/redisKv", () => ({
    putOnce,
    takeOnce: jest.fn(),
}));

import router from "../auth";

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined,
        status: jest.fn((statusCode: number) => {
            res.statusCode = statusCode;
            return res;
        }),
        json: jest.fn((body: unknown) => {
            res.body = body;
            return res;
        }),
        cookie: jest.fn(() => res),
        clearCookie: jest.fn(() => res),
        redirect: jest.fn((url: string) => {
            res.statusCode = 302;
            res.redirectUrl = url;
            return res;
        }),
    };
    return res;
}

async function executeRoute(
    path: string,
    req: any,
    res: any,
    method: "post" | "delete" = "post",
): Promise<void> {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer)
        throw new Error(`Missing ${method.toUpperCase()} route ${path}`);

    const dispatch = async (index: number): Promise<void> => {
        const handler = layer.route.stack[index]?.handle;
        if (!handler) return;
        await handler(req, res, (error?: unknown) => {
            if (error) throw error;
            return dispatch(index + 1);
        });
    };
    await dispatch(0);
}

function interactiveRequest(body: Record<string, unknown>): any {
    return {
        body,
        headers: {},
        session: { userId: "u1" },
        user: { id: "u1", username: "alice", role: "user" },
        params: { id: "credential1" },
    };
}

function bearerRequest(body: Record<string, unknown>): any {
    return {
        body,
        headers: { authorization: "Bearer access-token" },
        user: { id: "u1", username: "alice", role: "user" },
        params: { id: "credential1" },
    };
}

function apiKeyRequest(body: Record<string, unknown>): any {
    return {
        body,
        headers: { "x-api-key": "stolen-key" },
        user: { id: "u1", username: "alice", role: "user" },
        params: { id: "credential1" },
    };
}

describe("interactive authentication for sensitive credential management", () => {
    afterAll(() => {
        if (originalJwtSecret === undefined) {
            delete process.env.JWT_SECRET;
        } else {
            process.env.JWT_SECRET = originalJwtSecret;
        }
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockBcryptCompare.mockResolvedValue(true);
        mockTotpVerify.mockResolvedValue({ valid: true });
        prisma.user.findUnique.mockResolvedValue({
            id: "u1",
            username: "alice",
            passwordHash: "password-hash",
            twoFactorEnabled: false,
            twoFactorSecret: null,
        });
        prisma.user.update.mockResolvedValue({});
        prisma.user.updateMany.mockResolvedValue({ count: 1 });
        prisma.appPassword.count.mockResolvedValue(0);
        prisma.appPassword.create.mockResolvedValue({
            id: "credential1",
            displayName: "Phone",
            createdAt: new Date("2026-08-15T12:00:00.000Z"),
            lastUsedAt: null,
        });
        prisma.appPassword.updateMany.mockResolvedValue({ count: 1 });
        prisma.externalIdentity.findFirst.mockResolvedValue({
            id: "credential1",
        });
        prisma.externalIdentity.count.mockResolvedValue(2);
        prisma.externalIdentity.delete.mockResolvedValue({});
        prisma.$executeRaw.mockResolvedValue(0);
        prisma.$transaction.mockImplementation(async (run) => run(prisma));
        buildAuthorizationRequest.mockResolvedValue({
            redirectUrl: "https://idp.example/authorize",
            state: "state-1",
            nonce: "nonce-1",
            codeVerifier: "verifier-1",
        });
        putOnce.mockResolvedValue(true);
    });

    test.each([
        ["/2fa/setup", {}],
        ["/2fa/enable", { secret: "NEW-SECRET", token: "123456" }],
        ["/2fa/disable", { password: "secret", token: "123456" }],
    ] as const)("rejects API-key authentication on %s", async (path, body) => {
        const res = createRes();

        await executeRoute(path, apiKeyRequest(body), res);

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({
            error: "Interactive session authentication required",
        });
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    test.each([
        ["post", { password: "my-subsonic-password" }],
        ["delete", {}],
    ] as const)(
        "rejects API-key authentication on %s /subsonic-password without mutating credentials",
        async (method, body) => {
            const res = createRes();

            await executeRoute(
                "/subsonic-password",
                apiKeyRequest(body),
                res,
                method,
            );

            expect(res.statusCode).toBe(403);
            expect(res.body).toEqual({
                error: "Interactive session authentication required",
            });
            expect(prisma.user.update).not.toHaveBeenCalled();
        },
    );

    test.each([
        ["post", "/oidc/link/start", { responseMode: "json" }],
        ["post", "/app-passwords", { displayName: "Phone" }],
        ["delete", "/app-passwords/:id", {}],
        ["delete", "/identities/:id", {}],
    ] as const)(
        "rejects API-key authentication on %s %s",
        async (method, path, body) => {
            const res = createRes();

            await executeRoute(path, apiKeyRequest(body), res, method);

            expect(res.statusCode).toBe(403);
            expect(res.body).toEqual({
                error: "Interactive session authentication required",
            });
        },
    );

    it("allows bearer authentication on OIDC and app-password mutations", async () => {
        const link = createRes();
        await executeRoute(
            "/oidc/link/start",
            bearerRequest({ responseMode: "json" }),
            link,
        );
        expect(link.statusCode).toBe(200);

        const create = createRes();
        await executeRoute(
            "/app-passwords",
            bearerRequest({ displayName: "Phone" }),
            create,
        );
        expect(create.statusCode).toBe(201);

        const revoke = createRes();
        await executeRoute(
            "/app-passwords/:id",
            bearerRequest({}),
            revoke,
            "delete",
        );
        expect(revoke.statusCode).toBe(200);

        const unlink = createRes();
        await executeRoute(
            "/identities/:id",
            bearerRequest({}),
            unlink,
            "delete",
        );
        expect(unlink.statusCode).toBe(200);
    });

    it("allows an interactive session to create a Subsonic credential", async () => {
        const res = createRes();

        await executeRoute(
            "/subsonic-password",
            interactiveRequest({ password: "my-subsonic-password" }),
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: "u1" },
            data: { subsonicPassword: "enc(my-subsonic-password)" },
        });
    });

    it("allows an interactive session to delete a Subsonic credential", async () => {
        const res = createRes();

        await executeRoute(
            "/subsonic-password",
            interactiveRequest({}),
            res,
            "delete",
        );

        expect(res.statusCode).toBe(200);
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: "u1" },
            data: { subsonicPassword: null },
        });
    });

    it("allows setup with the existing empty payload", async () => {
        const res = createRes();

        await executeRoute("/2fa/setup", interactiveRequest({}), res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            secret: "NEW-SECRET",
            qrCode: "data:image/png;base64,test",
        });
    });

    it("allows enable with the existing secret and token payload", async () => {
        const res = createRes();

        await executeRoute(
            "/2fa/enable",
            interactiveRequest({ secret: "NEW-SECRET", token: "123456" }),
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(prisma.user.updateMany).toHaveBeenCalledWith({
            where: { id: "u1", twoFactorEnabled: false },
            data: expect.objectContaining({
                twoFactorEnabled: true,
                twoFactorSecret: "enc(NEW-SECRET)",
            }),
        });
    });

    it("rejects an existing or concurrently enabled factor", async () => {
        prisma.user.updateMany.mockResolvedValueOnce({ count: 0 });
        const res = createRes();

        await executeRoute(
            "/2fa/enable",
            interactiveRequest({ secret: "NEW-SECRET", token: "123456" }),
            res,
        );

        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({ error: "2FA is already enabled" });
    });

    it("keeps disable protected by the existing password and current token", async () => {
        prisma.user.findUnique.mockResolvedValueOnce({
            id: "u1",
            passwordHash: "password-hash",
            twoFactorEnabled: true,
            twoFactorSecret: "enc(CURRENT-SECRET)",
        });
        const res = createRes();

        await executeRoute(
            "/2fa/disable",
            interactiveRequest({ password: "secret", token: "123456" }),
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(mockBcryptCompare).toHaveBeenCalledWith(
            "secret",
            "password-hash",
        );
        expect(mockTotpVerify).toHaveBeenCalledWith({
            secret: "CURRENT-SECRET",
            token: "123456",
            epochTolerance: 60,
        });
    });
});
