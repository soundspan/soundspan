import { Request, Response } from "express";

// The route reports a pepper fingerprint via utils/apiKeyHash, which resolves
// its pepper from env; set one before the module under test loads.
process.env.SETTINGS_ENCRYPTION_KEY =
    process.env.SETTINGS_ENCRYPTION_KEY ||
    "admin-secrets-status-test-key-123456";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
    requireAdmin: (_req: Request, _res: Response, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(() => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        })),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        libraryHealthRecord: {
            findMany: jest.fn(),
            count: jest.fn(),
            delete: jest.fn(),
        },
        user: { findMany: jest.fn() },
        userSettings: { findMany: jest.fn() },
        federationPeer: { findMany: jest.fn() },
        systemSettings: { findMany: jest.fn() },
        apiKey: { findMany: jest.fn() },
    },
}));

jest.mock("../../config", () => ({
    config: { workers: { trackRemovalRetentionDays: 90 } },
}));

import router from "../admin";
import { prisma } from "../../utils/db";

const mockUserFindMany = prisma.user.findMany as unknown as jest.Mock;
const mockUserSettingsFindMany = prisma.userSettings
    .findMany as unknown as jest.Mock;
const mockFederationPeerFindMany = prisma.federationPeer
    .findMany as unknown as jest.Mock;
const mockSystemSettingsFindMany = prisma.systemSettings
    .findMany as unknown as jest.Mock;
const mockApiKeyFindMany = prisma.apiKey.findMany as unknown as jest.Mock;

function getHandler(path: string, method: "get" | "delete") {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

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

describe("admin secrets-status route", () => {
    const handler = getHandler("/secrets-status", "get");

    beforeEach(() => {
        jest.clearAllMocks();
        mockFederationPeerFindMany.mockResolvedValue([]);
    });

    it("counts legacy vs v2 encrypted settings values per model", async () => {
        // subsonicPassword: 1 v2 + 1 legacy (the null is ignored).
        // 2FA columns are also part of the inventory: twoFactorSecret v2,
        // twoFactorRecoveryCodes legacy.
        mockUserFindMany.mockResolvedValue([
            {
                subsonicPassword: "v2:salt:iv:tag:ct",
                twoFactorSecret: "v2:a2:b2:c2:d2",
                twoFactorRecoveryCodes: "0099:aabb", // legacy
            },
            { subsonicPassword: "00aa:bbcc" }, // legacy CBC ivHex:ctHex
            { subsonicPassword: null },
        ]);
        // 1 v2 + 1 legacy across the two columns of one row.
        mockUserSettingsFindMany.mockResolvedValue([
            { ytMusicOAuthJson: "v2:a:b:c:d", tidalOAuthJson: "11:22" },
        ]);
        mockFederationPeerFindMany.mockResolvedValue([
            { outboundToken: "v2:peer:salt:tag:ciphertext" },
        ]);
        // 1 v2 + 1 legacy; unset columns ignored.
        mockSystemSettingsFindMany.mockResolvedValue([
            { lidarrApiKey: "v2:x:y:z:w", openaiApiKey: "33:44" },
        ]);
        // 2 hashed + 1 legacy plaintext API key.
        mockApiKeyFindMany.mockResolvedValue([
            { key: "hmac:" + "a".repeat(64) },
            { key: "b".repeat(64) }, // legacy plaintext
            { key: "hmac:" + "c".repeat(64) },
        ]);

        const res = createRes();
        await handler({} as any, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            settingsCipher: {
                total: 9,
                v2: 5,
                legacy: 4,
                migrationComplete: false,
                byModel: {
                    federationPeer: { total: 1, v2: 1, legacy: 0 },
                    // subsonicPassword (v2 + legacy) + twoFactorSecret (v2) +
                    // twoFactorRecoveryCodes (legacy)
                    user: { total: 4, v2: 2, legacy: 2 },
                    userSettings: { total: 2, v2: 1, legacy: 1 },
                    systemSettings: { total: 2, v2: 1, legacy: 1 },
                },
            },
            apiKeys: {
                total: 3,
                hashed: 2,
                plaintext: 1,
                migrationComplete: false,
                // 8-hex pepper-VALUE fingerprint: comparing it against the
                // backfill script's logged fingerprint catches a script-env vs
                // app-env pepper mismatch before --apply writes anything.
                pepperFingerprint: expect.stringMatching(/^[0-9a-f]{8}$/),
            },
        });
        // Only counts are returned — never the secret values themselves.
        expect(JSON.stringify(res.body)).not.toContain("v2:salt:iv:tag:ct");
    });

    it("reports migrationComplete once everything is v2 (no legacy left)", async () => {
        mockUserFindMany.mockResolvedValue([
            { subsonicPassword: "v2:a:b:c:d" },
        ]);
        mockUserSettingsFindMany.mockResolvedValue([]);
        mockSystemSettingsFindMany.mockResolvedValue([
            { lidarrApiKey: "v2:e:f:g:h" },
        ]);
        mockApiKeyFindMany.mockResolvedValue([
            { key: "hmac:" + "a".repeat(64) },
        ]);

        const res = createRes();
        await handler({} as any, res);

        expect(res.body.settingsCipher.legacy).toBe(0);
        expect(res.body.settingsCipher.v2).toBe(2);
        expect(res.body.settingsCipher.migrationComplete).toBe(true);
        expect(res.body.apiKeys.plaintext).toBe(0);
        expect(res.body.apiKeys.migrationComplete).toBe(true);
    });

    it("returns 500 when a query fails", async () => {
        mockUserFindMany.mockRejectedValue(new Error("db down"));

        const res = createRes();
        await handler({} as any, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to compute secrets status",
        });
    });
});
