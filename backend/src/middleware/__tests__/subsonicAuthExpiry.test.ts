process.env.SETTINGS_ENCRYPTION_KEY =
    process.env.SETTINGS_ENCRYPTION_KEY ||
    "subsonic-expiry-test-pepper-1234567890123456";

import express from "express";
import request from "supertest";

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

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        error: jest.fn(),
    },
}));

import { requireSubsonicAuth } from "../subsonicAuth";

const app = express();
app.get("/rest/ping.view", requireSubsonicAuth, (_req, res) => {
    res.json({ authenticated: true });
});

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

        const response = await request(app).get("/rest/ping.view").query({
            v: "1.16.1",
            c: "test-client",
            f: "json",
            apiKey: "expired-key",
        });

        expect(response.status).toBe(200);
        expect(response.body["subsonic-response"]).toEqual(
            expect.objectContaining({
                status: "failed",
                error: {
                    code: 40,
                    message: "Wrong username or password",
                },
            }),
        );
        expect(mockApiKeyUpdate).not.toHaveBeenCalled();
    });

    it("allows a fresh API key through a /rest endpoint", async () => {
        mockApiKeyFindUnique.mockResolvedValue(
            buildApiKeyRecord(new Date(Date.now() - 24 * 60 * 60 * 1000)),
        );

        const response = await request(app).get("/rest/ping.view").query({
            v: "1.16.1",
            c: "test-client",
            f: "json",
            apiKey: "fresh-key",
        });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ authenticated: true });
        expect(mockApiKeyUpdate).toHaveBeenCalledWith({
            where: { id: "key-1" },
            data: { lastUsed: expect.any(Date) },
        });
    });
});
