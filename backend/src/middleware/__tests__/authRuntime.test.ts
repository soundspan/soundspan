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
    sign: jest.fn(),
    verify: jest.fn(),
}));

import { prisma } from "../../utils/db";
import { logger } from "../../utils/logger";
import jwt from "jsonwebtoken";

const mockUserFindUnique = prisma.user.findUnique as jest.Mock;
const mockApiKeyFindUnique = prisma.apiKey.findUnique as jest.Mock;
const mockApiKeyUpdate = prisma.apiKey.update as jest.Mock;
const mockJwtSign = jwt.sign as jest.Mock;
const mockJwtVerify = jwt.verify as jest.Mock;

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
    };
    return res;
}

describe("auth middleware runtime", () => {
    let generateToken: any;
    let generateRefreshToken: any;
    let requireAuth: any;
    let requireAdmin: any;
    let requireAuthOrToken: any;

    beforeAll(() => {
        process.env.JWT_SECRET = "test-jwt-secret";
        const mod = require("../auth");
        generateToken = mod.generateToken;
        generateRefreshToken = mod.generateRefreshToken;
        requireAuth = mod.requireAuth;
        requireAdmin = mod.requireAdmin;
        requireAuthOrToken = mod.requireAuthOrToken;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockUserFindUnique.mockResolvedValue(null);
        mockApiKeyFindUnique.mockResolvedValue(null);
        mockApiKeyUpdate.mockResolvedValue({});
        mockJwtSign.mockReturnValue("signed-token");
        mockJwtVerify.mockImplementation(() => {
            throw new Error("invalid token");
        });
    });

    it("generates access tokens with tokenVersion payload", () => {
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

    it("generates refresh tokens with refresh type", () => {
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

    it("authenticates using session user", async () => {
        mockUserFindUnique.mockResolvedValue({
            id: "u1",
            username: "session-user",
            role: "user",
        });

        const req: any = { session: { userId: "u1" }, headers: {} };
        const res = createRes();
        const next = jest.fn();

        await requireAuth(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user).toEqual({
            id: "u1",
            username: "session-user",
            role: "user",
        });
    });

    it("falls back to API key auth when session lookup fails", async () => {
        mockUserFindUnique.mockRejectedValueOnce(new Error("db error"));
        mockApiKeyFindUnique.mockResolvedValue({
            id: "key-1",
            user: { id: "u2", username: "api-user", role: "admin" },
        });

        const req: any = { session: { userId: "u2" }, headers: { "x-api-key": "abc123" } };
        const res = createRes();
        const next = jest.fn();

        await requireAuth(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user).toEqual({
            id: "u2",
            username: "api-user",
            role: "admin",
        });
        expect(mockApiKeyUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "key-1" },
            })
        );
    });

    it("throws when JWT secret configuration is missing", () => {
        const originalJwtSecret = process.env.JWT_SECRET;
        const originalSessionSecret = process.env.SESSION_SECRET;

        delete process.env.JWT_SECRET;
        delete process.env.SESSION_SECRET;

        expect(() => {
            jest.isolateModules(() => {
                require("../auth");
            });
        }).toThrow(
            "JWT_SECRET or SESSION_SECRET environment variable is required for authentication"
        );

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

    it("logs and rejects when API key auth fails in requireAuth", async () => {
        mockApiKeyFindUnique.mockRejectedValueOnce(new Error("api-key db outage"));

        const req: any = {
            session: {},
            headers: { "x-api-key": "api-key" },
            query: {},
        };
        const res = createRes();
        const next = jest.fn();

        await requireAuth(req, res, next);

        expect(logger.error).toHaveBeenCalledWith(
            "API key auth error:",
            expect.any(Error)
        );
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Not authenticated" });
    });

    it("falls back to API key auth in requireAuthOrToken when session auth throws", async () => {
        mockUserFindUnique.mockRejectedValueOnce(new Error("session db outage"));
        mockApiKeyFindUnique.mockResolvedValueOnce({
            id: "key-2",
            user: { id: "u3", username: "session-fallback-user", role: "user" },
        });

        const req: any = {
            session: { userId: "u3" },
            headers: { "x-api-key": "stream-key" },
            query: {},
        };
        const res = createRes();
        const next = jest.fn();

        await requireAuthOrToken(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user).toEqual({
            id: "u3",
            username: "session-fallback-user",
            role: "user",
        });
        expect(mockApiKeyUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "key-2" },
            })
        );
    });

    it("logs API key error in requireAuthOrToken and returns 401", async () => {
        mockApiKeyFindUnique.mockRejectedValueOnce(new Error("api-key lookup failed"));

        const req: any = {
            session: {},
            headers: { "x-api-key": "broken-key" },
            query: {},
        };
        const res = createRes();
        const next = jest.fn();

        await requireAuthOrToken(req, res, next);

        expect(logger.error).toHaveBeenCalledWith(
            "API key auth error:",
            expect.any(Error)
        );
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Not authenticated" });
    });

    it("authenticates using bearer token with matching tokenVersion", async () => {
        mockJwtVerify.mockReturnValue({
            userId: "u3",
            tokenVersion: 2,
        });
        mockUserFindUnique.mockResolvedValue({
            id: "u3",
            username: "jwt-user",
            role: "user",
            tokenVersion: 2,
        });

        const req: any = {
            headers: { authorization: "Bearer access-token" },
            query: {},
        };
        const res = createRes();
        const next = jest.fn();

        await requireAuth(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user).toEqual({
            id: "u3",
            username: "jwt-user",
            role: "user",
        });
    });

    it("rejects bearer token with mismatched tokenVersion", async () => {
        mockJwtVerify.mockReturnValue({
            userId: "u4",
            tokenVersion: 1,
        });
        mockUserFindUnique.mockResolvedValue({
            id: "u4",
            username: "stale-user",
            role: "user",
            tokenVersion: 3,
        });

        const req: any = { headers: { authorization: "Bearer stale-token" } };
        const res = createRes();
        const next = jest.fn();

        await requireAuth(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Not authenticated" });
    });

    it("returns 401 when no auth method succeeds", async () => {
        const req: any = { headers: {}, query: {}, session: {} };
        const res = createRes();
        const next = jest.fn();

        await requireAuth(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Not authenticated" });
    });

    it("enforces admin-only routes", async () => {
        const denyReq: any = { user: { id: "u1", role: "user" } };
        const denyRes = createRes();
        const denyNext = jest.fn();
        await requireAdmin(denyReq, denyRes, denyNext);
        expect(denyRes.statusCode).toBe(403);
        expect(denyNext).not.toHaveBeenCalled();

        const allowReq: any = { user: { id: "admin", role: "admin" } };
        const allowRes = createRes();
        const allowNext = jest.fn();
        await requireAdmin(allowReq, allowRes, allowNext);
        expect(allowNext).toHaveBeenCalledTimes(1);
    });

    it("authenticates streaming routes using query token", async () => {
        mockJwtVerify.mockReturnValue({
            userId: "stream-user",
            tokenVersion: 5,
        });
        mockUserFindUnique.mockResolvedValue({
            id: "stream-user",
            username: "streamer",
            role: "user",
            tokenVersion: 5,
        });

        const req: any = {
            session: {},
            headers: {},
            query: { token: "stream-token" },
        };
        const res = createRes();
        const next = jest.fn();

        await requireAuthOrToken(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user).toEqual({
            id: "stream-user",
            username: "streamer",
            role: "user",
        });
    });

    it("uses bearer token fallback for requireAuthOrToken", async () => {
        mockJwtVerify.mockReturnValue({
            userId: "fallback-user",
            tokenVersion: 7,
        });
        mockUserFindUnique.mockResolvedValue({
            id: "fallback-user",
            username: "fallback",
            role: "user",
            tokenVersion: 7,
        });

        const req: any = {
            session: {},
            headers: { authorization: "Bearer fallback-token" },
            query: {},
        };
        const res = createRes();
        const next = jest.fn();

        await requireAuthOrToken(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.user).toEqual({
            id: "fallback-user",
            username: "fallback",
            role: "user",
        });
    });

    it("rejects requireAuthOrToken when all auth methods fail", async () => {
        const req: any = { session: {}, headers: {}, query: {} };
        const res = createRes();
        const next = jest.fn();

        await requireAuthOrToken(req, res, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Not authenticated" });
    });
});
