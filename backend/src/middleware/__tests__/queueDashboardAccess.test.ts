jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        user: { findUnique: jest.fn() },
        apiKey: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
    },
}));

jest.mock("../../config", () => ({
    config: { secureCookies: false },
}));

import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../../utils/db";

const TEST_SECRET = "queue-dashboard-test-secret";
const WRONG_SECRET = "queue-dashboard-wrong-secret";
const mockUserFindUnique = prisma.user.findUnique as jest.Mock;

type AuthModule = typeof import("../auth");
let authModule: AuthModule;

type TestRequest = {
    headers: Record<string, string>;
    query: Record<string, string>;
    user?: { id: string; username: string; role: string };
};

type TestResponse = {
    statusCode: number;
    body: unknown;
    status: jest.Mock;
    json: jest.Mock;
};

const adminUser = {
    id: "admin-1",
    username: "admin",
    role: "admin",
    tokenVersion: 4,
};

function createReq(headers: Record<string, string> = {}): TestRequest {
    return { headers, query: {} };
}

function createRes(): TestResponse {
    const res = {} as TestResponse;
    res.statusCode = 200;
    res.body = undefined;
    res.status = jest.fn((statusCode: number) => {
        res.statusCode = statusCode;
        return res;
    });
    res.json = jest.fn((body: unknown) => {
        res.body = body;
        return res;
    });
    return res;
}

function queueCookie(token: string): string {
    return `soundspan-queues=${token}`;
}

async function runQueueAccess(req: TestRequest) {
    const res = createRes();
    const next = jest.fn();
    await authModule.requireQueueDashboardAccess(
        req as unknown as Request,
        res as unknown as Response,
        next as unknown as NextFunction,
    );
    return { req, res, next };
}

function expectUnauthorized(result: {
    res: TestResponse;
    next: jest.Mock;
}): void {
    expect(result.next).not.toHaveBeenCalled();
    expect(result.res.statusCode).toBe(401);
    expect(result.res.body).toEqual({
        error: "Not authenticated",
        code: "AUTH_REQUIRED",
    });
}

describe("queue dashboard access", () => {
    const originalJwtSecret = process.env.JWT_SECRET;
    const originalSessionSecret = process.env.SESSION_SECRET;

    beforeAll(() => {
        process.env.JWT_SECRET = TEST_SECRET;
        delete process.env.SESSION_SECRET;
        authModule = require("../auth") as AuthModule;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockUserFindUnique.mockResolvedValue({ ...adminUser });
    });

    afterAll(() => {
        if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = originalJwtSecret;
        if (originalSessionSecret === undefined)
            delete process.env.SESSION_SECRET;
        else process.env.SESSION_SECRET = originalSessionSecret;
    });

    it("mints a purpose-bound 15-minute dashboard token", () => {
        const token = authModule.generateQueueDashboardToken(adminUser);
        const payload = jwt.verify(token, TEST_SECRET, {
            algorithms: ["HS256"],
        }) as jwt.JwtPayload;

        expect(payload).toMatchObject({
            userId: adminUser.id,
            tokenVersion: adminUser.tokenVersion,
            purpose: authModule.QUEUE_DASHBOARD_TOKEN_PURPOSE,
        });
        expect(payload.exp! - payload.iat!).toBe(
            authModule.QUEUE_DASHBOARD_TTL_SECONDS,
        );
    });

    it("allows a tokenVersion-matched admin dashboard cookie", async () => {
        const token = authModule.generateQueueDashboardToken(adminUser);
        const result = await runQueueAccess(
            createReq({ cookie: queueCookie(token) }),
        );

        expect(result.req.user).toEqual({
            id: adminUser.id,
            username: adminUser.username,
            role: adminUser.role,
        });
        expect(result.next).toHaveBeenCalledTimes(1);
    });

    it("forbids a valid dashboard cookie owned by a non-admin", async () => {
        mockUserFindUnique.mockResolvedValue({ ...adminUser, role: "user" });
        const token = authModule.generateQueueDashboardToken(adminUser);
        const result = await runQueueAccess(
            createReq({ cookie: queueCookie(token) }),
        );

        expect(result.next).not.toHaveBeenCalled();
        expect(result.res.statusCode).toBe(403);
        expect(result.res.body).toEqual({ error: "Admin access required" });
    });

    it("rejects a normal access token from the dashboard cookie", async () => {
        const result = await runQueueAccess(
            createReq({
                cookie: queueCookie(authModule.generateToken(adminUser)),
            }),
        );

        expectUnauthorized(result);
    });

    it("rejects an expired dashboard cookie", async () => {
        const token = jwt.sign(
            {
                userId: adminUser.id,
                tokenVersion: adminUser.tokenVersion,
                purpose: "queue-dashboard",
            },
            TEST_SECRET,
            { expiresIn: "-1s" },
        );

        expectUnauthorized(
            await runQueueAccess(createReq({ cookie: queueCookie(token) })),
        );
    });

    it("rejects a dashboard cookie signed with the wrong secret", async () => {
        const token = jwt.sign(
            {
                userId: adminUser.id,
                tokenVersion: adminUser.tokenVersion,
                purpose: "queue-dashboard",
            },
            WRONG_SECRET,
            { expiresIn: "15m" },
        );

        expectUnauthorized(
            await runQueueAccess(createReq({ cookie: queueCookie(token) })),
        );
    });

    it("rejects a dashboard cookie after tokenVersion changes", async () => {
        mockUserFindUnique.mockResolvedValue({
            ...adminUser,
            tokenVersion: adminUser.tokenVersion + 1,
        });
        const token = authModule.generateQueueDashboardToken(adminUser);

        expectUnauthorized(
            await runQueueAccess(createReq({ cookie: queueCookie(token) })),
        );
    });

    it("rejects an oversized Cookie header", async () => {
        const token = authModule.generateQueueDashboardToken(adminUser);
        const cookie = `${queueCookie(token)}; padding=${"x".repeat(4096)}`;

        expectUnauthorized(await runQueueAccess(createReq({ cookie })));
        expect(mockUserFindUnique).not.toHaveBeenCalled();
    });

    it("uses a valid bearer header before the dashboard cookie", async () => {
        const bearerUser = { ...adminUser, id: "bearer-admin" };
        const cookieUser = {
            ...adminUser,
            id: "cookie-user",
            role: "user",
        };
        mockUserFindUnique.mockImplementation(
            async ({ where }: { where: { id: string } }) =>
                where.id === bearerUser.id ? bearerUser : cookieUser,
        );
        const bearer = authModule.generateToken(bearerUser);
        const cookie = authModule.generateQueueDashboardToken(cookieUser);

        const result = await runQueueAccess(
            createReq({
                authorization: `Bearer ${bearer}`,
                cookie: queueCookie(cookie),
            }),
        );

        expect(result.req.user?.id).toBe(bearerUser.id);
        expect(result.next).toHaveBeenCalledTimes(1);
        expect(mockUserFindUnique).toHaveBeenCalledTimes(1);
    });

    it("rejects a dashboard token presented as a general Bearer credential", async () => {
        const req = createReq({
            authorization: `Bearer ${authModule.generateQueueDashboardToken(adminUser)}`,
        });
        const res = createRes();
        const next = jest.fn();

        await authModule.requireAuth(
            req as unknown as Request,
            res as unknown as Response,
            next as unknown as NextFunction,
        );

        expectUnauthorized({ res, next });
        expect(mockUserFindUnique).not.toHaveBeenCalled();
    });

    it("returns 503 when the dashboard-token user lookup is unavailable", async () => {
        mockUserFindUnique.mockRejectedValueOnce(new Error("database down"));
        const token = authModule.generateQueueDashboardToken(adminUser);
        const result = await runQueueAccess(
            createReq({ cookie: queueCookie(token) }),
        );

        expect(result.next).not.toHaveBeenCalled();
        expect(result.res.statusCode).toBe(503);
        expect(result.res.body).toEqual({
            error: "Authentication service unavailable",
            code: "AUTH_BACKEND_UNAVAILABLE",
        });
    });
});
