jest.mock("../../config", () => ({
    config: {
        localLoginEnabled: true,
        secureCookies: false,
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
    adminSurfaceLimiter: passThrough,
    apiLimiter: passThrough,
    authLimiter: passThrough,
    oidcFlowLimiter: passThrough,
}));

const prisma = {
    user: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
    },
    $executeRaw: jest.fn(),
    $transaction: jest.fn(),
};
jest.mock("../../utils/db", () => ({ prisma }));

const cleanupListenTogetherForUser = jest.fn();
jest.mock("../../services/listenTogetherUserCleanup", () => ({
    cleanupListenTogetherForUser,
}));

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

type HttpMethod = "get" | "patch" | "delete";

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
        prisma.user.count.mockResolvedValue(1);
        prisma.user.delete.mockResolvedValue({});
        prisma.user.updateMany.mockResolvedValue({ count: 1 });
        prisma.user.deleteMany.mockResolvedValue({ count: 1 });
        prisma.$executeRaw.mockResolvedValue(0);
        prisma.$transaction.mockImplementation(async (run) => run(prisma));
        cleanupListenTogetherForUser.mockResolvedValue(undefined);
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

    it("takes the role guard lock before admin demotion", async () => {
        const order: string[] = [];
        prisma.user.findUnique.mockResolvedValue({
            id: "admin-2",
            username: "second-admin",
            email: "admin@example.com",
            role: "admin",
        });
        prisma.$executeRaw.mockImplementation(async () => {
            order.push("lock");
            return 0;
        });
        prisma.user.count.mockImplementation(async () => {
            order.push("count");
            return 1;
        });
        prisma.user.update.mockImplementationOnce(async () => {
            order.push("update");
            return {
                id: "admin-2",
                username: "second-admin",
                email: "admin@example.com",
                role: "user",
                createdAt: new Date("2026-08-15T12:00:00.000Z"),
            };
        });
        const res = createRes();

        await getHandler("/users/:id", "patch")(
            { params: { id: "admin-2" }, body: { role: "user" } },
            res,
        );

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(order).toEqual(["lock", "count", "update"]);
        expect(prisma.user.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { role: "user" } }),
        );
        expect(prisma.user.count).toHaveBeenCalledWith({
            where: {
                role: "admin",
                id: { not: "admin-2" },
                pendingDeletionAt: null,
            },
        });
        expect(res.statusCode).toBe(200);
    });

    it("takes the role guard lock before admin deletion", async () => {
        const order: string[] = [];
        prisma.user.findUnique.mockResolvedValue({
            id: "admin-2",
            role: "admin",
        });
        prisma.$executeRaw.mockImplementation(async () => {
            order.push("lock");
            return 0;
        });
        prisma.user.count.mockImplementation(async () => {
            order.push("count");
            return 1;
        });
        prisma.user.updateMany.mockImplementationOnce(async () => {
            order.push("reserve");
            return { count: 1 };
        });
        prisma.user.deleteMany.mockImplementationOnce(async () => {
            order.push("delete");
            return { count: 1 };
        });
        cleanupListenTogetherForUser.mockImplementationOnce(async () => {
            order.push("listen-together-cleanup");
        });
        const res = createRes();

        await getHandler("/users/:id", "delete")(
            { user: { id: "admin-1" }, params: { id: "admin-2" } },
            res,
        );

        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
        expect(order).toEqual([
            "lock",
            "count",
            "reserve",
            "listen-together-cleanup",
            "lock",
            "count",
            "delete",
        ]);
        expect(res.body).toEqual({ message: "User deleted successfully" });
    });

    it("leaves the marker set and returns a retryable response when cleanup fails", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: "user-2",
            role: "user",
            pendingDeletionAt: null,
        });
        cleanupListenTogetherForUser.mockRejectedValueOnce(
            new Error("publication failed"),
        );
        const res = createRes();

        await getHandler("/users/:id", "delete")(
            { user: { id: "admin-1" }, params: { id: "user-2" } },
            res,
        );

        expect(prisma.user.updateMany).toHaveBeenCalledWith({
            where: { id: "user-2", pendingDeletionAt: null },
            data: { pendingDeletionAt: expect.any(Date) },
        });
        expect(prisma.user.deleteMany).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({
            error: "User deletion is pending. Retry to finish cleanup.",
            code: "USER_DELETION_PENDING",
            retryable: true,
        });

        prisma.user.findUnique.mockResolvedValue({
            id: "user-2",
            role: "user",
            pendingDeletionAt: new Date("2026-08-21T12:00:00.000Z"),
        });
        cleanupListenTogetherForUser.mockResolvedValueOnce(undefined);
        const retryRes = createRes();
        await getHandler("/users/:id", "delete")(
            { user: { id: "admin-1" }, params: { id: "user-2" } },
            retryRes,
        );

        expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
        expect(prisma.user.deleteMany).toHaveBeenCalledTimes(1);
        expect(retryRes.body).toEqual({
            message: "User deleted successfully",
        });
    });

    it("retries an already-marked deletion and deletes after cleanup succeeds", async () => {
        const pendingDeletionAt = new Date("2026-08-21T12:00:00.000Z");
        prisma.user.findUnique.mockResolvedValue({
            id: "user-2",
            role: "user",
            pendingDeletionAt,
        });
        const res = createRes();

        await getHandler("/users/:id", "delete")(
            { user: { id: "admin-1" }, params: { id: "user-2" } },
            res,
        );

        expect(prisma.user.updateMany).not.toHaveBeenCalled();
        expect(cleanupListenTogetherForUser).toHaveBeenCalledWith("user-2");
        expect(prisma.user.deleteMany).toHaveBeenCalledWith({
            where: {
                id: "user-2",
                pendingDeletionAt: { not: null },
            },
        });
        expect(res.body).toEqual({ message: "User deleted successfully" });
    });

    it("keeps a reserved admin when another admin is demoted during cleanup", async () => {
        const pendingDeletionAt = new Date("2026-08-21T12:00:00.000Z");
        prisma.user.findUnique
            .mockResolvedValueOnce({
                id: "admin-b",
                role: "admin",
                pendingDeletionAt: null,
            })
            .mockResolvedValueOnce({
                id: "admin-b",
                role: "admin",
                pendingDeletionAt,
            });
        prisma.user.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
        cleanupListenTogetherForUser.mockImplementationOnce(async () => {
            // Admin A is demoted after B was legitimately deletion-reserved.
        });
        const res = createRes();

        await getHandler("/users/:id", "delete")(
            { user: { id: "admin-a" }, params: { id: "admin-b" } },
            res,
        );

        expect(cleanupListenTogetherForUser).toHaveBeenCalledWith("admin-b");
        expect(prisma.user.deleteMany).not.toHaveBeenCalled();
        expect(prisma.user.updateMany).toHaveBeenLastCalledWith({
            where: { id: "admin-b", pendingDeletionAt: { not: null } },
            data: { pendingDeletionAt: null },
        });
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Cannot delete the last admin" });
    });

    it("keeps the final admin when deletion or demotion is requested", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: "admin-2",
            username: "second-admin",
            email: "admin@example.com",
            role: "admin",
        });
        prisma.user.count.mockResolvedValue(0);

        const demotion = createRes();
        await getHandler("/users/:id", "patch")(
            { params: { id: "admin-2" }, body: { role: "user" } },
            demotion,
        );
        expect(demotion.statusCode).toBe(400);
        expect(demotion.body).toEqual({
            error: "Cannot demote the last admin",
        });

        const deletion = createRes();
        await getHandler("/users/:id", "delete")(
            { user: { id: "admin-1" }, params: { id: "admin-2" } },
            deletion,
        );
        expect(deletion.statusCode).toBe(400);
        expect(deletion.body).toEqual({
            error: "Cannot delete the last admin",
        });
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.user.delete).not.toHaveBeenCalled();
        expect(cleanupListenTogetherForUser).not.toHaveBeenCalled();
    });
});
