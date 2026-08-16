jest.mock("../../config", () => ({
    config: {
        localLoginEnabled: true,
        oidc: {
            enabled: false,
            redirectUri: "",
            providerName: "SSO",
        },
    },
}));

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);
jest.mock("../../utils/logger", () => ({ logger: mockLogger }));

const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
jest.mock("../../middleware/auth", () => ({
    requireAuth: passThrough,
    requireInteractiveSession: passThrough,
    requireAdmin: passThrough,
    generateToken: jest.fn(),
    generateRefreshToken: jest.fn(),
    verifyAuthToken: jest.fn(),
}));
jest.mock("../../middleware/rateLimiter", () => ({
    apiLimiter: passThrough,
    authLimiter: passThrough,
}));

const prisma = {
    user: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({ prisma }));

const bcryptHash = jest.fn();
jest.mock("bcrypt", () => ({
    __esModule: true,
    default: { compare: jest.fn(), hash: bcryptHash },
}));
jest.mock("../../utils/encryption", () => ({
    encrypt: jest.fn(),
    decrypt: jest.fn(),
}));
jest.mock("../../services/oidcAuth", () => ({
    buildAuthorizationRequest: jest.fn(),
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
jest.mock("../../utils/redisKv", () => ({
    putOnce: jest.fn(),
    takeOnce: jest.fn(),
}));

import router from "../auth";

type HttpMethod = "get" | "patch";

function getHandler(path: string, method: HttpMethod) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route.methods?.[method],
    );
    if (!layer) throw new Error(`${method.toUpperCase()} ${path} not found`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined,
        status: jest.fn((code: number) => {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn((body: unknown) => {
            res.body = body;
            return res;
        }),
    };
    return res;
}

describe("admin SSO user contracts", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        bcryptHash.mockResolvedValue("new-hash");
    });

    it("summarizes local passwords and linked providers in the user list", async () => {
        prisma.user.findMany.mockResolvedValue([
            {
                id: "u-local",
                username: "local-user",
                email: "local@example.com",
                role: "user",
                onboardingComplete: true,
                createdAt: new Date("2026-08-14T12:00:00.000Z"),
                passwordHash: "hash-local",
                externalIdentities: [{ provider: "oidc:https://idp.example" }],
            },
            {
                id: "u-sso",
                username: "sso-user",
                email: "sso@example.com",
                role: "user",
                onboardingComplete: true,
                createdAt: new Date("2026-08-15T12:00:00.000Z"),
                passwordHash: null,
                externalIdentities: [{ provider: "oidc:https://idp.example" }],
            },
        ]);
        const res = createRes();

        await getHandler("/users", "get")({}, res);

        expect(prisma.user.findMany).toHaveBeenCalledWith({
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
        expect(res.body).toEqual([
            expect.objectContaining({
                id: "u-local",
                hasPassword: true,
                linkedProviders: ["oidc:https://idp.example"],
            }),
            expect.objectContaining({
                id: "u-sso",
                hasPassword: false,
                linkedProviders: ["oidc:https://idp.example"],
            }),
        ]);
        expect(res.body[0]).not.toHaveProperty("passwordHash");
        expect(res.body[0]).not.toHaveProperty("externalIdentities");
    });

    it("sets a local password for a passwordless user", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: "u-sso",
            username: "sso-user",
            email: "sso@example.com",
            passwordHash: null,
        });
        prisma.user.update.mockResolvedValue({
            id: "u-sso",
            username: "sso-user",
            email: "sso@example.com",
            role: "user",
            createdAt: new Date("2026-08-15T12:00:00.000Z"),
        });
        const res = createRes();

        await getHandler("/users/:id", "patch")(
            {
                params: { id: "u-sso" },
                body: { password: "new-local-password" },
            },
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(prisma.user.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "u-sso" },
                data: {
                    passwordHash: "new-hash",
                    tokenVersion: { increment: 1 },
                    subsonicPassword: null,
                },
            }),
        );
    });
});
