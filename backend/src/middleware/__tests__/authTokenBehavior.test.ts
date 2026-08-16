/**
 * Behavioral token-validation tests for the auth middleware.
 *
 * Unlike `auth.test.ts` (which mocks `jsonwebtoken` to unit-test branch
 * logic), this suite exercises REAL token signing and verification so
 * token-type confusion, expiry, wrong-secret, and `alg: none` handling are
 * proven against the actual `jsonwebtoken` implementation and cannot regress
 * behind a mock.
 */

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

import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../../utils/db";

// API-key hashing needs a pepper at call time; provide one explicitly so this
// suite never depends on ambient SESSION_SECRET state (mirrors auth.test.ts).
process.env.SETTINGS_ENCRYPTION_KEY =
    process.env.SETTINGS_ENCRYPTION_KEY ||
    "auth-behavior-test-api-key-pepper-123456789";

const TEST_SECRET = "behavioral-test-jwt-secret";
const WRONG_SECRET = "some-other-secret-entirely";

const mockUserFindUnique = prisma.user.findUnique as jest.Mock;

type AuthModule = typeof import("../auth") & {
    verifyAccessToken?: (token: string) => import("../auth").JWTPayload;
};

let authModule: AuthModule;

const testUser = {
    id: "user-1",
    username: "alice",
    role: "user",
    tokenVersion: 3,
};

function base64url(value: object): string {
    return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Craft an unsigned token claiming `alg: none`. */
function makeAlgNoneToken(payload: object): string {
    return `${base64url({ alg: "none", typ: "JWT" })}.${base64url(payload)}.`;
}

type TestRequest = {
    headers: Record<string, unknown>;
    query: Record<string, unknown>;
    user?: { id: string; username: string; role: string };
};

function createReq(overrides: Partial<TestRequest> = {}): TestRequest {
    return { headers: {}, query: {}, ...overrides };
}

type TestResponse = {
    statusCode: number;
    body: unknown;
    status: jest.Mock;
    json: jest.Mock;
};

function createRes(): TestResponse {
    const res = {} as TestResponse;
    res.statusCode = 200;
    res.body = undefined;
    res.status = jest.fn((code: number) => {
        res.statusCode = code;
        return res;
    });
    res.json = jest.fn((payload: unknown) => {
        res.body = payload;
        return res;
    });
    return res;
}

const asReq = (req: TestRequest) => req as unknown as Request;
const asRes = (res: TestResponse) => res as unknown as Response;
const asNext = (next: jest.Mock) => next as unknown as NextFunction;

describe("auth middleware behavioral token validation (real jsonwebtoken)", () => {
    const originalJwtSecret = process.env.JWT_SECRET;
    const originalSessionSecret = process.env.SESSION_SECRET;

    beforeAll(() => {
        process.env.JWT_SECRET = TEST_SECRET;
        delete process.env.SESSION_SECRET;
        authModule = require("../auth") as AuthModule;
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

    beforeEach(() => {
        jest.clearAllMocks();
        mockUserFindUnique.mockResolvedValue({ ...testUser });
    });

    function accessToken(): string {
        return authModule.generateToken(testUser);
    }

    function refreshToken(): string {
        return authModule.generateRefreshToken(testUser);
    }

    async function runRequireAuth(req: TestRequest) {
        const res = createRes();
        const next = jest.fn();
        await authModule.requireAuth(asReq(req), asRes(res), asNext(next));
        return { req, res, next };
    }

    async function runRequireAuthOrToken(req: TestRequest) {
        const res = createRes();
        const next = jest.fn();
        await authModule.requireAuthOrToken(
            asReq(req),
            asRes(res),
            asNext(next),
        );
        return { req, res, next };
    }

    function expectRejected(result: {
        res: TestResponse;
        next: jest.Mock;
    }): void {
        expect(result.next).not.toHaveBeenCalled();
        expect(result.res.statusCode).toBe(401);
    }

    describe("requireAuth (Bearer)", () => {
        it("accepts a real access token", async () => {
            const result = await runRequireAuth(
                createReq({
                    headers: { authorization: `Bearer ${accessToken()}` },
                }),
            );

            expect(result.next).toHaveBeenCalled();
            expect(result.req.user).toEqual({
                id: testUser.id,
                username: testUser.username,
                role: testUser.role,
            });
        });

        it("rejects a refresh token presented as a Bearer access token", async () => {
            const result = await runRequireAuth(
                createReq({
                    headers: { authorization: `Bearer ${refreshToken()}` },
                }),
            );

            expectRejected(result);
        });

        it("rejects a token with an unexpected type claim", async () => {
            const unexpectedType = jwt.sign(
                {
                    userId: testUser.id,
                    username: testUser.username,
                    role: testUser.role,
                    tokenVersion: testUser.tokenVersion,
                    type: "device-link",
                },
                TEST_SECRET,
                { expiresIn: "24h" },
            );

            const result = await runRequireAuth(
                createReq({
                    headers: {
                        authorization: `Bearer ${unexpectedType}`,
                    },
                }),
            );

            expectRejected(result);
        });

        it("ignores ?token= even when it carries a valid access token", async () => {
            const result = await runRequireAuth(
                createReq({ query: { token: accessToken() } }),
            );

            expectRejected(result);
        });

        it("rejects an expired access token", async () => {
            const expired = jwt.sign(
                {
                    userId: testUser.id,
                    username: testUser.username,
                    role: testUser.role,
                    tokenVersion: testUser.tokenVersion,
                },
                TEST_SECRET,
                { expiresIn: "-1s" },
            );

            const result = await runRequireAuth(
                createReq({ headers: { authorization: `Bearer ${expired}` } }),
            );

            expectRejected(result);
        });

        it("rejects a token signed with the wrong secret", async () => {
            const forged = jwt.sign(
                {
                    userId: testUser.id,
                    username: testUser.username,
                    role: testUser.role,
                    tokenVersion: testUser.tokenVersion,
                },
                WRONG_SECRET,
                { expiresIn: "24h" },
            );

            const result = await runRequireAuth(
                createReq({ headers: { authorization: `Bearer ${forged}` } }),
            );

            expectRejected(result);
        });

        it("rejects an unsigned alg:none token", async () => {
            const none = makeAlgNoneToken({
                userId: testUser.id,
                username: testUser.username,
                role: testUser.role,
                tokenVersion: testUser.tokenVersion,
            });

            const result = await runRequireAuth(
                createReq({ headers: { authorization: `Bearer ${none}` } }),
            );

            expectRejected(result);
        });

        it("rejects an access token whose tokenVersion does not match", async () => {
            mockUserFindUnique.mockResolvedValue({
                ...testUser,
                tokenVersion: testUser.tokenVersion + 1,
            });

            const result = await runRequireAuth(
                createReq({
                    headers: { authorization: `Bearer ${accessToken()}` },
                }),
            );

            expectRejected(result);
        });

        it("rejects an otherwise-valid token that carries no tokenVersion", async () => {
            const versionless = jwt.sign(
                {
                    userId: testUser.id,
                    username: testUser.username,
                    role: testUser.role,
                },
                TEST_SECRET,
                { expiresIn: "24h" },
            );

            const result = await runRequireAuth(
                createReq({
                    headers: { authorization: `Bearer ${versionless}` },
                }),
            );

            expectRejected(result);
        });

        it("rejects an object-payload token without a userId claim", async () => {
            const noUserId = jwt.sign({ foo: "bar" }, TEST_SECRET, {
                expiresIn: "24h",
            });

            const result = await runRequireAuth(
                createReq({
                    headers: { authorization: `Bearer ${noUserId}` },
                }),
            );

            expectRejected(result);
        });
    });

    describe("requireAuthOrToken (query + Bearer)", () => {
        it("accepts a real access token via ?token=", async () => {
            const result = await runRequireAuthOrToken(
                createReq({ query: { token: accessToken() } }),
            );

            expect(result.next).toHaveBeenCalled();
            expect(result.req.user).toEqual({
                id: testUser.id,
                username: testUser.username,
                role: testUser.role,
            });
        });

        it("rejects a refresh token via ?token=", async () => {
            const result = await runRequireAuthOrToken(
                createReq({ query: { token: refreshToken() } }),
            );

            expectRejected(result);
        });

        it("rejects a refresh token presented as a Bearer access token", async () => {
            const result = await runRequireAuthOrToken(
                createReq({
                    headers: { authorization: `Bearer ${refreshToken()}` },
                }),
            );

            expectRejected(result);
        });
    });

    describe("verifyAccessToken", () => {
        it("is exported from the auth middleware module", () => {
            expect(typeof authModule.verifyAccessToken).toBe("function");
        });

        it("returns the decoded payload for a valid access token", () => {
            expect(authModule.verifyAccessToken).toBeDefined();
            const payload = authModule.verifyAccessToken!(accessToken());

            expect(payload.userId).toBe(testUser.id);
            expect(payload.tokenVersion).toBe(testUser.tokenVersion);
        });

        it("throws when given a refresh token", () => {
            expect(authModule.verifyAccessToken).toBeDefined();
            expect(() =>
                authModule.verifyAccessToken!(refreshToken()),
            ).toThrow();
        });

        it("throws when given a token with an unexpected type claim", () => {
            const unexpectedType = jwt.sign(
                {
                    userId: testUser.id,
                    username: testUser.username,
                    role: testUser.role,
                    tokenVersion: testUser.tokenVersion,
                    type: "device-link",
                },
                TEST_SECRET,
                { expiresIn: "24h" },
            );

            expect(authModule.verifyAccessToken).toBeDefined();
            expect(() =>
                authModule.verifyAccessToken!(unexpectedType),
            ).toThrow();
        });

        it("throws when given a bare string payload", () => {
            const stringPayload = jwt.sign("not-an-object", TEST_SECRET);

            expect(authModule.verifyAccessToken).toBeDefined();
            expect(() =>
                authModule.verifyAccessToken!(stringPayload),
            ).toThrow();
        });

        it("throws when given an object payload without a userId claim", () => {
            const noUserId = jwt.sign({ foo: "bar" }, TEST_SECRET, {
                expiresIn: "24h",
            });

            expect(authModule.verifyAccessToken).toBeDefined();
            expect(() => authModule.verifyAccessToken!(noUserId)).toThrow();
        });

        it("throws when given an unsigned alg:none token", () => {
            expect(authModule.verifyAccessToken).toBeDefined();
            expect(() =>
                authModule.verifyAccessToken!(
                    makeAlgNoneToken({ userId: testUser.id }),
                ),
            ).toThrow();
        });
    });
});
