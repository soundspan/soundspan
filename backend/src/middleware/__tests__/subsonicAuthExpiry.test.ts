process.env.SETTINGS_ENCRYPTION_KEY =
    process.env.SETTINGS_ENCRYPTION_KEY ||
    "subsonic-expiry-test-pepper-1234567890123456";

import type { NextFunction, Request, Response } from "express";

const mockApiKeyFindUnique = jest.fn();
const mockApiKeyUpdate = jest.fn();

jest.mock("../../utils/db", () => ({
    prisma: {
        user: {
            findUnique: jest.fn(),
        },
        apiKey: {
            findUnique: mockApiKeyFindUnique,
            update: mockApiKeyUpdate,
        },
    },
}));

const testLogger = {
    debug: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
testLogger.child.mockReturnValue(testLogger);
jest.mock("../../utils/logger", () => ({ logger: testLogger }));

import { requireSubsonicAuth } from "../subsonicAuth";

function createRequest(apiKey: string): Request {
    return {
        query: { v: "1.16.1", c: "test-client", f: "json", apiKey },
    } as unknown as Request;
}

function createResponse() {
    const response = {
        body: "",
        locals: {},
        status: jest.fn(),
        type: jest.fn(),
        send: jest.fn((body: string) => {
            response.body = body;
        }),
    };
    return response;
}

function buildApiKeyRecord(createdAt: unknown) {
    return {
        id: "key-1",
        createdAt,
        user: {
            id: "user-1",
            username: "alice",
            role: "user",
        },
    };
}

describe("Subsonic API key expiry", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockApiKeyUpdate.mockResolvedValue({});
    });

    it.each([
        ["expired", new Date(Date.now() - 91 * 24 * 60 * 60 * 1000)],
        ["missing", undefined],
        ["invalid", new Date(Number.NaN)],
    ])("rejects a %s API key at a /rest endpoint", async (_case, createdAt) => {
        mockApiKeyFindUnique.mockResolvedValue(buildApiKeyRecord(createdAt));
        const req = createRequest("expired-key");
        const res = createResponse();
        const next: NextFunction = jest.fn();

        await requireSubsonicAuth(req, res as unknown as Response, next);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(JSON.parse(res.body)["subsonic-response"]).toEqual(
            expect.objectContaining({
                status: "failed",
                error: {
                    code: 40,
                    message: "Wrong username or password",
                },
            }),
        );
        expect(mockApiKeyUpdate).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
    });

    it("allows a fresh API key through a /rest endpoint", async () => {
        mockApiKeyFindUnique.mockResolvedValue(
            buildApiKeyRecord(new Date(Date.now() - 24 * 60 * 60 * 1000)),
        );
        const req = createRequest("fresh-key");
        const res = createResponse();
        const next: NextFunction = jest.fn();

        await requireSubsonicAuth(req, res as unknown as Response, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(mockApiKeyUpdate).toHaveBeenCalledWith({
            where: { id: "key-1" },
            data: { lastUsed: expect.any(Date) },
        });
    });
});
