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
        user: {
            findUnique: jest.fn(),
        },
        apiKey: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
    },
}));

jest.mock("jsonwebtoken", () => ({
    __esModule: true,
    default: {
        sign: jest.fn(),
        verify: jest.fn(),
    },
}));

import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";

const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
const mockApiKeyFindUnique = prisma.apiKey.findUnique as jest.Mock;
const mockApiKeyUpdate = prisma.apiKey.update as jest.Mock;
const mockJwtSign = jwt.sign as jest.Mock;
const mockJwtVerify = jwt.verify as jest.Mock;

let generateToken: typeof import("../auth").generateToken;
let generateRefreshToken: typeof import("../auth").generateRefreshToken;
let requireAuth: typeof import("../auth").requireAuth;
let requireAdmin: typeof import("../auth").requireAdmin;
let requireAuthOrToken: typeof import("../auth").requireAuthOrToken;

type TestRequest = {
    session: Record<string, unknown>;
    headers: Record<string, unknown>;
    query: Record<string, unknown>;
    user?: { id: string; username: string; role: string };
};

function createReq(overrides: Record<string, unknown> = {}) {
    return {
        session: {},
        headers: {},
        query: {},
        ...overrides,
    } as TestRequest;
}

type TestResponse = {
    statusCode: number;
    body: unknown;
    status: jest.MockedFunction<(code: number) => TestResponse>;
    json: jest.MockedFunction<(payload: unknown) => TestResponse>;
};

function createRes() {
    const res = {} as TestResponse;

    Object.assign(res, {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn((code: number) => {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn((payload: unknown) => {
            res.body = payload;
            return res;
        }),
    });

    return res;
}

function asRequest(req: TestRequest): Request {
    return req as unknown as Request;
}

function asResponse(res: TestResponse): Response {
    return res as unknown as Response;
}

function asNext(next: jest.Mock): NextFunction {
    return next as unknown as NextFunction;
}

describe("auth middleware", () => {
    const originalJwtSecret = process.env.JWT_SECRET;
    const originalSessionSecret = process.env.SESSION_SECRET;

    beforeAll(() => {
        process.env.JWT_SECRET = "test-jwt-secret";
        delete process.env.SESSION_SECRET;

        const authModule = require("../auth") as typeof import("../auth");
        generateToken = authModule.generateToken;
        generateRefreshToken = authModule.generateRefreshToken;
        requireAuth = authModule.requireAuth;
        requireAdmin = authModule.requireAdmin;
        requireAuthOrToken = authModule.requireAuthOrToken;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.JWT_SECRET = "test-jwt-secret";
        delete process.env.SESSION_SECRET;

        mockUserFindUnique.mockResolvedValue(null);
        mockApiKeyFindUnique.mockResolvedValue(null);
        mockApiKeyUpdate.mockResolvedValue({});
        mockJwtSign.mockReturnValue("signed-token");
        mockJwtVerify.mockImplementation(() => {
            throw new Error("invalid token");
        });
    });

    afterAll(() => {
        if (originalJwtSecret === undefined) {
            delete process.env.JWT_SECRET;
        } else {
            process.env.JWT_SECRET = originalJwtSecret;
        }

        if (originalSessionSecret === undefined) {
            delete process.env.SESSION_SECRET;
        } else {
            process.env.SESSION_SECRET = originalSessionSecret;
        }
    });

    describe("generateToken", () => {
        it("creates an access token with the expected payload and expiration", () => {
            const token = generateToken({
                id: "user-1",
                username: "alice",
                role: "admin",
                tokenVersion: 9,
            });

            expect(token).toBe("signed-token");
            expect(mockJwtSign).toHaveBeenCalledWith(
                {
                    userId: "user-1",
                    username: "alice",
                    role: "admin",
                    tokenVersion: 9,
                },
                "test-jwt-secret",
                { expiresIn: "24h" }
            );
        });

        it("falls back to SESSION_SECRET when JWT_SECRET is unset", () => {
            delete process.env.JWT_SECRET;
            process.env.SESSION_SECRET = "session-secret";

            jest.isolateModules(() => {
                const isolatedAuth = require("../auth") as typeof import("../auth");
                const isolatedJwt = require("jsonwebtoken").default as typeof jwt;
                const isolatedSign = isolatedJwt.sign as jest.Mock;

                isolatedAuth.generateToken({
                    id: "user-1",
                    username: "alice",
                    role: "user",
                    tokenVersion: 1,
                });

                expect(isolatedSign).toHaveBeenCalledWith(
                    expect.any(Object),
                    "session-secret",
                    { expiresIn: "24h" }
                );
            });
        });
    });

    describe("generateRefreshToken", () => {
        it("creates a refresh token with refresh type and long expiration", () => {
            const token = generateRefreshToken({
                id: "user-1",
                tokenVersion: 4,
            });

            expect(token).toBe("signed-token");
            expect(mockJwtSign).toHaveBeenCalledWith(
                {
                    userId: "user-1",
                    tokenVersion: 4,
                    type: "refresh",
                },
                "test-jwt-secret",
                { expiresIn: "30d" }
            );
        });
    });

    describe("requireAuth", () => {
        it("authenticates via session", async () => {
            mockUserFindUnique.mockResolvedValue({
                id: "u1",
                username: "session-user",
                role: "user",
            });

            const req = createReq({ session: { userId: "u1" } });
            const res = createRes();
            const next = jest.fn();

            await requireAuth(asRequest(req), asResponse(res), asNext(next));

            expect(mockUserFindUnique).toHaveBeenCalledWith({
                where: { id: "u1" },
                select: { id: true, username: true, role: true },
            });
            expect(req.user).toEqual({
                id: "u1",
                username: "session-user",
                role: "user",
            });
            expect(next).toHaveBeenCalledTimes(1);
        });

        it("authenticates via API key and updates lastUsed", async () => {
            mockApiKeyFindUnique.mockResolvedValue({
                id: "key-1",
                user: { id: "u2", username: "api-user", role: "admin" },
            });

            const req = createReq({ headers: { "x-api-key": "abc123" } });
            const res = createRes();
            const next = jest.fn();

            await requireAuth(asRequest(req), asResponse(res), asNext(next));

            expect(mockApiKeyFindUnique).toHaveBeenCalledWith({
                where: { key: "abc123" },
                include: {
                    user: { select: { id: true, username: true, role: true } },
                },
            });
            expect(mockApiKeyUpdate).toHaveBeenCalledWith({
                where: { id: "key-1" },
                data: { lastUsed: expect.any(Date) },
            });
            expect(req.user).toEqual({
                id: "u2",
                username: "api-user",
                role: "admin",
            });
            expect(next).toHaveBeenCalledTimes(1);
        });

        it("authenticates via bearer token when tokenVersion matches", async () => {
            mockJwtVerify.mockReturnValue({ userId: "u3", tokenVersion: 2 });
            mockUserFindUnique.mockResolvedValue({
                id: "u3",
                username: "jwt-user",
                role: "user",
                tokenVersion: 2,
            });

            const req = createReq({
                headers: { authorization: "Bearer access-token" },
            });
            const res = createRes();
            const next = jest.fn();

            await requireAuth(asRequest(req), asResponse(res), asNext(next));

            expect(mockJwtVerify).toHaveBeenCalledWith("access-token", "test-jwt-secret");
            expect(req.user).toEqual({
                id: "u3",
                username: "jwt-user",
                role: "user",
            });
            expect(next).toHaveBeenCalledTimes(1);
        });

        it("rejects when no valid authentication method is found", async () => {
            const req = createReq();
            const res = createRes();
            const next = jest.fn();

            await requireAuth(asRequest(req), asResponse(res), asNext(next));

            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(401);
            expect(res.body).toEqual({ error: "Not authenticated" });
        });

        it("rejects stale bearer tokens after tokenVersion changes", async () => {
            mockJwtVerify.mockReturnValue({ userId: "u4", tokenVersion: 1 });
            mockUserFindUnique.mockResolvedValue({
                id: "u4",
                username: "stale-user",
                role: "user",
                tokenVersion: 3,
            });

            const req = createReq({
                headers: { authorization: "Bearer stale-token" },
            });
            const res = createRes();
            const next = jest.fn();

            await requireAuth(asRequest(req), asResponse(res), asNext(next));

            expect(next).not.toHaveBeenCalled();
            expect(req.user).toBeUndefined();
            expect(res.statusCode).toBe(401);
            expect(res.body).toEqual({ error: "Not authenticated" });
        });
    });

    describe("requireAdmin", () => {
        it("rejects non-admin users", async () => {
            const req = createReq({ user: { id: "u1", username: "alice", role: "user" } });
            const res = createRes();
            const next = jest.fn();

            await requireAdmin(asRequest(req), asResponse(res), asNext(next));

            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(403);
            expect(res.body).toEqual({ error: "Admin access required" });
        });

        it("allows admin users", async () => {
            const req = createReq({ user: { id: "u2", username: "root", role: "admin" } });
            const res = createRes();
            const next = jest.fn();

            await requireAdmin(asRequest(req), asResponse(res), asNext(next));

            expect(next).toHaveBeenCalledTimes(1);
        });
    });

    describe("requireAuthOrToken", () => {
        it("accepts query param tokens for streaming routes", async () => {
            mockJwtVerify.mockReturnValue({ userId: "stream-user", tokenVersion: 5 });
            mockUserFindUnique.mockResolvedValue({
                id: "stream-user",
                username: "streamer",
                role: "user",
                tokenVersion: 5,
            });

            const req = createReq({ query: { token: "stream-token" } });
            const res = createRes();
            const next = jest.fn();

            await requireAuthOrToken(asRequest(req), asResponse(res), asNext(next));

            expect(mockJwtVerify).toHaveBeenCalledWith("stream-token", "test-jwt-secret");
            expect(req.user).toEqual({
                id: "stream-user",
                username: "streamer",
                role: "user",
            });
            expect(next).toHaveBeenCalledTimes(1);
        });

        it("rejects stale query tokens after tokenVersion changes", async () => {
            mockJwtVerify.mockReturnValue({ userId: "stream-user", tokenVersion: 1 });
            mockUserFindUnique.mockResolvedValue({
                id: "stream-user",
                username: "streamer",
                role: "user",
                tokenVersion: 2,
            });

            const req = createReq({ query: { token: "stale-stream-token" } });
            const res = createRes();
            const next = jest.fn();

            await requireAuthOrToken(asRequest(req), asResponse(res), asNext(next));

            expect(next).not.toHaveBeenCalled();
            expect(req.user).toBeUndefined();
            expect(res.statusCode).toBe(401);
            expect(res.body).toEqual({ error: "Not authenticated" });
        });

        it("falls back to bearer tokens when no query token is present", async () => {
            mockJwtVerify.mockReturnValue({ userId: "fallback-user", tokenVersion: 7 });
            mockUserFindUnique.mockResolvedValue({
                id: "fallback-user",
                username: "fallback",
                role: "user",
                tokenVersion: 7,
            });

            const req = createReq({
                headers: { authorization: "Bearer fallback-token" },
            });
            const res = createRes();
            const next = jest.fn();

            await requireAuthOrToken(asRequest(req), asResponse(res), asNext(next));

            expect(req.user).toEqual({
                id: "fallback-user",
                username: "fallback",
                role: "user",
            });
            expect(next).toHaveBeenCalledTimes(1);
        });
    });

    describe("module initialization", () => {
        it("throws when JWT_SECRET and SESSION_SECRET are both missing", () => {
            delete process.env.JWT_SECRET;
            delete process.env.SESSION_SECRET;

            expect(() => {
                jest.isolateModules(() => {
                    require("../auth");
                });
            }).toThrow(
                "JWT_SECRET or SESSION_SECRET environment variable is required for authentication"
            );
        });

        it("logs and rejects API key lookup errors", async () => {
            mockApiKeyFindUnique.mockRejectedValueOnce(new Error("api-key db outage"));

            const req = createReq({ headers: { "x-api-key": "broken-key" } });
            const res = createRes();
            const next = jest.fn();

            await requireAuth(asRequest(req), asResponse(res), asNext(next));

            expect(logger.error).toHaveBeenCalledWith(
                "API key auth error:",
                expect.any(Error)
            );
            expect(next).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(401);
        });
    });
});
