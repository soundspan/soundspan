const originalSettingsEncryptionKey = process.env.SETTINGS_ENCRYPTION_KEY;

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const mockGenerateToken = jest.fn();
jest.mock("../../middleware/auth", () => ({
    generateToken: mockGenerateToken,
    requireAuth: (_req: any, _res: any, next: () => void) => next(),
    requireAdmin: (_req: any, _res: any, next: () => void) => next(),
}));

const prisma = {
    user: {
        count: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
    userSettings: {
        create: jest.fn(),
    },
    systemSettings: {
        findFirst: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({
    prisma,
}));

const mockBcryptHash = jest.fn();
jest.mock("bcrypt", () => ({
    __esModule: true,
    default: {
        hash: mockBcryptHash,
    },
}));

const mockAxiosGet = jest.fn();
jest.mock("axios", () => ({
    __esModule: true,
    default: {
        get: mockAxiosGet,
    },
}));

const mockEncryptField = jest.fn((value: string) => `enc:${value || ""}`);
jest.mock("../../utils/systemSettings", () => ({
    encryptField: mockEncryptField,
}));

class MockEnvFileSyncSkippedError extends Error {}
const mockWriteEnvFile = jest.fn();
jest.mock("../../utils/envWriter", () => ({
    EnvFileSyncSkippedError: MockEnvFileSyncSkippedError,
    writeEnvFile: mockWriteEnvFile,
}));

const mockJwtVerify = jest.fn();
jest.mock("jsonwebtoken", () => ({
    verify: mockJwtVerify,
}));

import router from "../onboarding";

function getHandler(
    path: string,
    method: "get" | "post" | "put" | "delete"
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );
    if (!layer) throw new Error(`${method.toUpperCase()} route not found: ${path}`);
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

describe("onboarding route runtime", () => {
    const register = getHandler("/register", "post");
    const saveLidarr = getHandler("/lidarr", "post");
    const saveAudiobookshelf = getHandler("/audiobookshelf", "post");
    const saveSoulseek = getHandler("/soulseek", "post");
    const saveEnrichment = getHandler("/enrichment", "post");
    const complete = getHandler("/complete", "post");
    const status = getHandler("/status", "get");

    beforeEach(() => {
        jest.clearAllMocks();

        process.env.SETTINGS_ENCRYPTION_KEY = "default-encryption-key-change-me";

        prisma.user.count.mockResolvedValue(1);
        prisma.user.findUnique.mockResolvedValue(null);
        prisma.user.create.mockResolvedValue({
            id: "u1",
            username: "alice",
            role: "user",
            tokenVersion: 1,
        });
        prisma.user.update.mockResolvedValue({});

        prisma.userSettings.create.mockResolvedValue({});
        prisma.systemSettings.findFirst.mockResolvedValue({ id: "default" });
        prisma.systemSettings.update.mockResolvedValue({});
        prisma.systemSettings.upsert.mockResolvedValue({});

        mockWriteEnvFile.mockResolvedValue(undefined);
        mockGenerateToken.mockReturnValue("jwt-token");
        mockBcryptHash.mockResolvedValue("hash-1");
        mockAxiosGet.mockResolvedValue({ status: 200 });
        mockJwtVerify.mockReturnValue({ userId: "u1" });
    });

    afterAll(() => {
        process.env.SETTINGS_ENCRYPTION_KEY = originalSettingsEncryptionKey;
    });

    it("registers first user as admin and rejects registration after setup", async () => {
        // Validation still runs before the user-count guard
        const invalidReq = { body: { username: "ab", password: "123" } } as any;
        const invalidRes = createRes();
        await register(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);

        // First user (count=0) — allowed, becomes admin
        prisma.user.count.mockResolvedValueOnce(0);
        prisma.user.findUnique.mockResolvedValueOnce(null);
        prisma.user.create.mockResolvedValueOnce({
            id: "admin-1",
            username: "first-admin",
            role: "admin",
            tokenVersion: 1,
        });
        const firstReq = {
            body: { username: "first-admin", password: "secure123" },
        } as any;
        const firstRes = createRes();
        await register(firstReq, firstRes);
        expect(firstRes.statusCode).toBe(200);
        expect(firstRes.body.token).toBe("jwt-token");
        expect(mockWriteEnvFile).toHaveBeenCalled();
        expect(prisma.user.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ role: "admin" }),
            })
        );

        // Second registration attempt (count=1) — rejected (registration closed)
        prisma.user.count.mockResolvedValueOnce(1);
        const closedReq = {
            body: { username: "hacker", password: "secure123" },
        } as any;
        const closedRes = createRes();
        await register(closedReq, closedRes);
        expect(closedRes.statusCode).toBe(403);
        expect(closedRes.body).toEqual({ error: "Registration is closed" });
    });

    it("skips encryption key generation when SETTINGS_ENCRYPTION_KEY is already set", async () => {
        process.env.SETTINGS_ENCRYPTION_KEY = "custom-encryption-key";
        prisma.user.count.mockResolvedValueOnce(0);
        prisma.user.findUnique.mockResolvedValueOnce(null);

        const req = { body: { username: "first", password: "secure123" } } as any;
        const res = createRes();
        await register(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockWriteEnvFile).not.toHaveBeenCalled();
    });

    it("returns 500 when first-user encryption key persistence fails", async () => {
        prisma.user.count.mockResolvedValueOnce(0);
        mockWriteEnvFile.mockRejectedValueOnce(
            new MockEnvFileSyncSkippedError("skip")
        );

        const req = { body: { username: "first", password: "secure123" } } as any;
        const res = createRes();
        await register(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to create account" });
    });

    it("saves lidarr and audiobookshelf settings with enabled/disabled branches", async () => {
        const lidarrDisabledReq = {
            user: { id: "u1" },
            body: { enabled: false, url: "", apiKey: "" },
        } as any;
        const lidarrDisabledRes = createRes();
        await saveLidarr(lidarrDisabledReq, lidarrDisabledRes);
        expect(lidarrDisabledRes.statusCode).toBe(200);
        expect(lidarrDisabledRes.body).toEqual({ success: true, tested: false });

        const lidarrEnabledReq = {
            user: { id: "u1" },
            body: {
                enabled: true,
                url: "http://lidarr.local",
                apiKey: "lidarr-key",
            },
        } as any;
        const lidarrEnabledRes = createRes();
        await saveLidarr(lidarrEnabledReq, lidarrEnabledRes);
        expect(lidarrEnabledRes.statusCode).toBe(200);
        expect(lidarrEnabledRes.body.success).toBe(true);

        const lidarrZodReq = {
            user: { id: "u1" },
            body: { enabled: "yes", url: "not-a-url", apiKey: 123 },
        } as any;
        const lidarrZodRes = createRes();
        await saveLidarr(lidarrZodReq, lidarrZodRes);
        expect(lidarrZodRes.statusCode).toBe(400);
        expect(lidarrZodRes.body).toMatchObject({
            error: "Invalid request",
        });

        const lidarrCatchReq = {
            user: { id: "u1" },
            body: { enabled: true, url: "http://lidarr.local", apiKey: "lidarr-key" },
        } as any;
        const lidarrCatchRes = createRes();
        prisma.systemSettings.upsert.mockRejectedValueOnce(new Error("db down"));
        await saveLidarr(lidarrCatchReq, lidarrCatchRes);
        expect(lidarrCatchRes.statusCode).toBe(500);
        expect(lidarrCatchRes.body).toEqual({
            error: "Failed to save configuration",
        });

        const absEnabledReq = {
            user: { id: "u1" },
            body: {
                enabled: true,
                url: "http://abs.local",
                apiKey: "abs-key",
            },
        } as any;
        const absEnabledRes = createRes();
        await saveAudiobookshelf(absEnabledReq, absEnabledRes);
        expect(absEnabledRes.statusCode).toBe(200);
        expect(absEnabledRes.body.success).toBe(true);

        const invalidAbsReq = {
            user: { id: "u1" },
            body: {
                enabled: true,
                url: "not-a-url",
                apiKey: "key",
            },
        } as any;
        const invalidAbsRes = createRes();
        await saveAudiobookshelf(invalidAbsReq, invalidAbsRes);
        expect(invalidAbsRes.statusCode).toBe(400);

        const absZodReq = {
            user: { id: "u1" },
            body: { enabled: "yes", url: "http://abs.local", apiKey: "abs-key" },
        } as any;
        const absZodRes = createRes();
        await saveAudiobookshelf(absZodReq, absZodRes);
        expect(absZodRes.statusCode).toBe(400);
        expect(absZodRes.body).toMatchObject({ error: "Invalid request" });

        const absCatchReq = {
            user: { id: "u1" },
            body: {
                enabled: true,
                url: "http://abs.local",
                apiKey: "abs-key",
            },
        } as any;
        const absCatchRes = createRes();
        prisma.systemSettings.upsert.mockRejectedValueOnce(new Error("db down"));
        await saveAudiobookshelf(absCatchReq, absCatchRes);
        expect(absCatchRes.statusCode).toBe(500);
        expect(absCatchRes.body).toEqual({ error: "Failed to save configuration" });
    });

    it("saves soulseek settings with credential validation", async () => {
        const disabledReq = {
            user: { id: "u1" },
            body: { enabled: false, username: "", password: "" },
        } as any;
        const disabledRes = createRes();
        await saveSoulseek(disabledReq, disabledRes);
        expect(disabledRes.statusCode).toBe(200);
        expect(disabledRes.body).toEqual({ success: true, tested: false });

        const missingCredsReq = {
            user: { id: "u1" },
            body: { enabled: true, username: "", password: "" },
        } as any;
        const missingCredsRes = createRes();
        await saveSoulseek(missingCredsReq, missingCredsRes);
        expect(missingCredsRes.statusCode).toBe(400);

        const enabledReq = {
            user: { id: "u1" },
            body: { enabled: true, username: "soul", password: "secret" },
        } as any;
        const enabledRes = createRes();
        await saveSoulseek(enabledReq, enabledRes);
        expect(enabledRes.statusCode).toBe(200);
        expect(enabledRes.body).toEqual({ success: true, tested: true });

        const soulseekZodReq = {
            user: { id: "u1" },
            body: { enabled: "yes", username: "soul", password: "secret" },
        } as any;
        const soulseekZodRes = createRes();
        await saveSoulseek(soulseekZodReq, soulseekZodRes);
        expect(soulseekZodRes.statusCode).toBe(400);
        expect(soulseekZodRes.body).toMatchObject({ error: "Invalid request" });

        const soulseekCatchReq = {
            user: { id: "u1" },
            body: { enabled: true, username: "soul", password: "secret" },
        } as any;
        const soulseekCatchRes = createRes();
        prisma.systemSettings.upsert.mockRejectedValueOnce(new Error("db down"));
        await saveSoulseek(soulseekCatchReq, soulseekCatchRes);
        expect(soulseekCatchRes.statusCode).toBe(500);
        expect(soulseekCatchRes.body).toEqual({
            error: "Failed to save configuration",
        });
    });

    it("persists enrichment config and onboarding completion", async () => {
        const invalidReq = { user: { id: "u1" }, body: {} } as any;
        const invalidRes = createRes();
        await saveEnrichment(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);

        const enrichReq = { user: { id: "u1" }, body: { enabled: true } } as any;
        const enrichRes = createRes();
        await saveEnrichment(enrichReq, enrichRes);
        expect(enrichRes.statusCode).toBe(200);
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: "u1" },
            data: {
                enrichmentSettings: {
                    enabled: true,
                    lastRun: null,
                },
            },
        });

        const completeReq = { user: { id: "u1" } } as any;
        const completeRes = createRes();
        await complete(completeReq, completeRes);
        expect(completeRes.statusCode).toBe(200);
        expect(completeRes.body).toEqual({ success: true });

        const enrichmentCatchReq = {
            user: { id: "u1" },
            body: { enabled: true },
        } as any;
        const enrichmentCatchRes = createRes();
        prisma.user.update.mockRejectedValueOnce(new Error("db down"));
        await saveEnrichment(enrichmentCatchReq, enrichmentCatchRes);
        expect(enrichmentCatchRes.statusCode).toBe(500);
        expect(enrichmentCatchRes.body).toEqual({
            error: "Failed to save configuration",
        });

        const completeCatchReq = { user: { id: "u1" } } as any;
        const completeCatchRes = createRes();
        prisma.user.update.mockRejectedValueOnce(new Error("db down"));
        await complete(completeCatchReq, completeCatchRes);
        expect(completeCatchRes.statusCode).toBe(500);
        expect(completeCatchRes.body).toEqual({
            error: "Failed to complete onboarding",
        });
    });

    it("reports onboarding status with and without JWTs", async () => {
        prisma.user.count.mockResolvedValueOnce(0);
        const noUserReq = { headers: {} } as any;
        const noUserRes = createRes();
        await status(noUserReq, noUserRes);
        expect(noUserRes.statusCode).toBe(200);
        expect(noUserRes.body).toEqual({
            needsOnboarding: true,
            hasAccount: false,
        });

        prisma.user.count.mockResolvedValueOnce(1);
        mockJwtVerify.mockReturnValueOnce({ userId: "u1" });
        prisma.user.findUnique.mockResolvedValueOnce({ onboardingComplete: false });
        const tokenReq = {
            headers: { authorization: "Bearer token-1" },
        } as any;
        const tokenRes = createRes();
        await status(tokenReq, tokenRes);
        expect(tokenRes.statusCode).toBe(200);
        expect(tokenRes.body).toEqual({
            needsOnboarding: true,
            hasAccount: true,
        });

        prisma.user.count.mockResolvedValueOnce(1);
        mockJwtVerify.mockReturnValueOnce({ userId: "u1" });
        prisma.user.findUnique.mockResolvedValueOnce({ onboardingComplete: true });
        const onboardingCompleteReq = {
            headers: { authorization: "Bearer token-2" },
        } as any;
        const onboardingCompleteRes = createRes();
        await status(onboardingCompleteReq, onboardingCompleteRes);
        expect(onboardingCompleteRes.statusCode).toBe(200);
        expect(onboardingCompleteRes.body).toEqual({
            needsOnboarding: false,
            hasAccount: true,
        });

        prisma.user.count.mockResolvedValueOnce(1);
        mockJwtVerify.mockImplementationOnce(() => {
            throw new Error("invalid token");
        });
        const badTokenReq = {
            headers: { authorization: "Bearer bad-token" },
        } as any;
        const badTokenRes = createRes();
        await status(badTokenReq, badTokenRes);
        expect(badTokenRes.statusCode).toBe(200);
        expect(badTokenRes.body).toEqual({
            needsOnboarding: false,
            hasAccount: true,
        });
    });

    it("returns 500 on status check failure", async () => {
        prisma.user.count.mockRejectedValueOnce(new Error("db down"));
        const req = { headers: {} } as any;
        const res = createRes();
        await status(req, res);
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to check status" });
    });
});
