import express, { type Router } from "express";

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

const passThrough = (
    req: Record<string, unknown>,
    _res: unknown,
    next: () => void,
) => {
    req.user ??= { id: "u1", username: "alice", role: "admin" };
    next();
};

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
    appPassword: { findMany: jest.fn() },
    externalIdentity: { findMany: jest.fn() },
    inviteCode: { findMany: jest.fn() },
    user: { findUnique: jest.fn() },
};

jest.mock("../../utils/db", () => ({ prisma }));

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);
jest.mock("../../utils/logger", () => ({ logger: mockLogger }));

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
jest.mock("../../utils/encryption", () => ({
    encrypt: jest.fn(),
    decrypt: jest.fn(),
}));
jest.mock("bcrypt", () => ({
    __esModule: true,
    default: { compare: jest.fn(), hash: jest.fn() },
}));
jest.mock("otplib", () => ({
    generateSecret: jest.fn(),
    generateURI: jest.fn(),
    verify: jest.fn(),
}));
jest.mock("qrcode", () => ({
    __esModule: true,
    default: { toDataURL: jest.fn() },
}));

import registerOidcRoutes from "../auth/oidc";
import registerLocalCredentialRoutes from "../auth/localCredentials";
import { registerSecondFactorAndSubsonicRoutes } from "../auth/accountSecurity";
import registerAppPasswordRoutes from "../auth/appPasswords";
import registerLinkedIdentityRoutes from "../auth/linkedIdentities";
import registerAdminUserInviteRoutes from "../auth/adminUserInvites";

type HttpMethod = "get" | "post";

function createRouter(registerRoutes: (router: Router) => void): Router {
    const router = express.Router();
    registerRoutes(router);
    return router;
}

function createResponse() {
    const response: {
        statusCode: number;
        body: unknown;
        status: jest.Mock;
        json: jest.Mock;
    } = {
        statusCode: 200,
        body: undefined,
        status: jest.fn((statusCode: number) => {
            response.statusCode = statusCode;
            return response;
        }),
        json: jest.fn((body: unknown) => {
            response.body = body;
            return response;
        }),
    };
    return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function findRouteHandlers(
    router: Router,
    method: HttpMethod,
    path: string,
): Function[] {
    const stackValue: unknown = Reflect.get(router, "stack");
    if (!Array.isArray(stackValue)) throw new Error("Router stack not found");
    const entries: unknown[] = stackValue;
    for (const entryValue of entries) {
        if (!isRecord(entryValue) || !isRecord(entryValue.route)) continue;
        const route = entryValue.route;
        if (route.path !== path || !isRecord(route.methods)) continue;
        if (route.methods[method] !== true || !Array.isArray(route.stack)) {
            continue;
        }
        const handlers: Function[] = [];
        const layers: unknown[] = route.stack;
        for (const layerValue of layers) {
            if (!isRecord(layerValue)) continue;
            const handler = layerValue.handle;
            if (typeof handler === "function") handlers.push(handler);
        }
        return handlers;
    }
    throw new Error(`${method.toUpperCase()} ${path} not found`);
}

async function executeRoute(
    registerRoutes: (router: Router) => void,
    method: HttpMethod,
    path: string,
): Promise<ReturnType<typeof createResponse>> {
    const router = createRouter(registerRoutes);
    const handlers = findRouteHandlers(router, method, path);
    const req: Record<string, unknown> = {
        body: {},
        headers: {},
        params: {},
        query: {},
    };
    const res = createResponse();
    const dispatch = async (index: number): Promise<void> => {
        const handler = handlers[index];
        if (!handler) return;
        await Reflect.apply(handler, undefined, [
            req,
            res,
            (error?: unknown) => {
                if (error) throw error;
                return dispatch(index + 1);
            },
        ]);
    };
    await dispatch(0);
    return res;
}

describe("auth concern module boundaries", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        prisma.appPassword.findMany.mockResolvedValue([]);
        prisma.externalIdentity.findMany.mockResolvedValue([]);
        prisma.inviteCode.findMany.mockResolvedValue([]);
        prisma.user.findUnique.mockResolvedValue({ twoFactorEnabled: false });
    });

    it("serves the OIDC capability route", async () => {
        const response = await executeRoute(
            registerOidcRoutes,
            "get",
            "/config",
        );

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual({
            localLoginEnabled: true,
            oidcEnabled: false,
            oidcProviderName: "SSO",
        });
    });

    it("serves the local credential logout route", async () => {
        const response = await executeRoute(
            registerLocalCredentialRoutes,
            "post",
            "/logout",
        );

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual({ message: "Logged out" });
    });

    it("serves the account-security status route", async () => {
        const response = await executeRoute(
            registerSecondFactorAndSubsonicRoutes,
            "get",
            "/2fa/status",
        );

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual({ enabled: false });
    });

    it("serves the app-password listing route", async () => {
        const response = await executeRoute(
            registerAppPasswordRoutes,
            "get",
            "/app-passwords",
        );

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual({ appPasswords: [] });
    });

    it("serves the linked-identity listing route", async () => {
        const response = await executeRoute(
            registerLinkedIdentityRoutes,
            "get",
            "/identities",
        );

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual({ identities: [] });
    });

    it("serves the admin invite listing route", async () => {
        const response = await executeRoute(
            registerAdminUserInviteRoutes,
            "get",
            "/invite-codes",
        );

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual([]);
    });
});
