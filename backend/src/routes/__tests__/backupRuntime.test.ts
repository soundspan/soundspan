const mockIsBusy = jest.fn();
const mockOpenExport = jest.fn();
const mockPutOnce = jest.fn();
const mockTakeOnce = jest.fn();
const mockWrapKey = jest.fn();
const mockVerifyToken = jest.fn();
const mockGenerateToken = jest.fn();
const mockUserFind = jest.fn();

jest.mock("../../config", () => ({
    config: { secureCookies: true },
}));
jest.mock("../../config/brand", () => ({ BRAND_SLUG: "test-brand" }));
jest.mock("../../config/appVersion", () => ({
    resolveAppVersion: () => "2.6.1",
}));
jest.mock("../../utils/encryption", () => ({
    getSettingsEncryptionKey: () => "k".repeat(32),
}));
jest.mock("../../utils/apiKeyHash", () => ({
    getPepperFingerprint: () => "pepper",
}));
jest.mock("../../middleware/rateLimiter", () => ({
    backupLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock("../../middleware/auth", () => ({
    BACKUP_DOWNLOAD_TOKEN_PURPOSE: "backup-download",
    BACKUP_DOWNLOAD_TTL_SECONDS: 300,
    generateBackupDownloadToken: mockGenerateToken,
    requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
    requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
    requireInteractiveSession: (
        _req: unknown,
        _res: unknown,
        next: () => void,
    ) => next(),
    verifyAuthToken: mockVerifyToken,
}));
jest.mock("../../utils/db", () => ({
    prisma: {
        user: { findUniqueOrThrow: mockUserFind, findUnique: mockUserFind },
    },
}));
jest.mock("../../utils/logger", () => ({
    logger: {
        child: () => ({
            error: jest.fn(),
            warn: jest.fn(),
            info: jest.fn(),
            debug: jest.fn(),
        }),
    },
}));
jest.mock("../../utils/redisKv", () => ({
    putOnce: mockPutOnce,
    takeOnce: mockTakeOnce,
}));
jest.mock("../../services/backup/backupKeyWrap", () => ({
    wrapEncryptionKey: mockWrapKey,
}));
jest.mock("../../services/backup/backupExport", () => ({
    isBackupExportBusy: mockIsBusy,
    openBackupExport: mockOpenExport,
}));

import router from "../backup";

function handler(path: string, method: "get" | "post") {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route.methods[method],
    );
    return layer.route.stack.at(-1).handle;
}

function response() {
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
        sendStatus: jest.fn((code: number) => {
            res.statusCode = code;
            return res;
        }),
        cookie: jest.fn(),
        clearCookie: jest.fn(),
        setHeader: jest.fn(),
        flushHeaders: jest.fn(),
        destroy: jest.fn(),
    };
    return res;
}

describe("backup routes", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockIsBusy.mockResolvedValue(false);
        mockPutOnce.mockResolvedValue(true);
        mockWrapKey.mockResolvedValue({
            wrappedKey: {
                salt: "salt",
                iv: "iv",
                tag: "tag",
                ciphertext: "ciphertext",
            },
            macKey: Buffer.alloc(32, 1),
        });
        mockGenerateToken.mockReturnValue("cookie-token");
        mockUserFind.mockResolvedValue({
            id: "u1",
            role: "admin",
            tokenVersion: 2,
        });
    });

    it("sets the secure, strict, narrow backup cookie", async () => {
        const req = {
            body: { passphrase: "long-enough-passphrase" },
            user: { id: "u1" },
        };
        const res = response();
        await handler("/session", "post")(req, res, (error: unknown) => {
            if (error) throw error;
        });
        expect(res.statusCode).toBe(204);
        expect(res.cookie).toHaveBeenCalledWith(
            "__Secure-soundspan-backup",
            "cookie-token",
            expect.objectContaining({
                httpOnly: true,
                sameSite: "strict",
                secure: true,
                path: "/api/backup/download",
                maxAge: 300_000,
            }),
        );
    });

    it.each([
        [true, "__Secure-soundspan-backup"],
        [false, "soundspan-backup"],
    ])(
        "in auto mode, follows the request scheme (secure=%p sets %s)",
        async (secure, expectedName) => {
            const { config } = jest.requireMock("../../config") as {
                config: { secureCookies: unknown };
            };
            config.secureCookies = "auto";
            try {
                const req = {
                    secure,
                    body: { passphrase: "long-enough-passphrase" },
                    user: { id: "u1" },
                };
                const res = response();
                await handler("/session", "post")(
                    req,
                    res,
                    (error: unknown) => {
                        if (error) throw error;
                    },
                );
                expect(res.cookie).toHaveBeenCalledWith(
                    expectedName,
                    "cookie-token",
                    expect.objectContaining({
                        secure,
                        path: "/api/backup/download",
                    }),
                );
            } finally {
                config.secureCookies = true;
            }
        },
    );

    it("in auto mode, reads the unprefixed cookie on a plain-HTTP request", async () => {
        const { config } = jest.requireMock("../../config") as {
            config: { secureCookies: unknown };
        };
        config.secureCookies = "auto";
        try {
            mockVerifyToken.mockReturnValue({
                userId: "u1",
                tokenVersion: 2,
                purpose: "backup-download",
                downloadId: "d1",
            });
            mockTakeOnce.mockResolvedValueOnce(null);
            const req = {
                secure: false,
                headers: { cookie: "soundspan-backup=token" },
            };
            const res = response();
            await handler("/download", "get")(req, res, jest.fn());
            expect(mockVerifyToken).toHaveBeenCalledWith("token");
        } finally {
            config.secureCookies = true;
        }
    });

    it("consumes a download session once", async () => {
        mockVerifyToken.mockReturnValue({
            userId: "u1",
            tokenVersion: 2,
            purpose: "backup-download",
            downloadId: "d1",
        });
        mockTakeOnce
            .mockResolvedValueOnce({
                userId: "u1",
                wrapped: {
                    salt: "c2FsdA==",
                    iv: "aXY=",
                    tag: "dGFn",
                    ciphertext: "Y2lwaGVy",
                },
                macKey: Buffer.alloc(32, 1).toString("base64"),
            })
            .mockResolvedValueOnce(null);
        const exporter = {
            streamTo: jest.fn().mockResolvedValue(undefined),
            close: jest.fn().mockResolvedValue(undefined),
        };
        mockOpenExport.mockResolvedValue(exporter);
        const req = { headers: { cookie: "__Secure-soundspan-backup=token" } };
        const first = response();
        await handler("/download", "get")(req, first, jest.fn());
        expect(first.statusCode).toBe(200);
        expect(first.flushHeaders).toHaveBeenCalled();
        expect(first.setHeader).toHaveBeenCalledWith(
            "Content-Disposition",
            expect.stringMatching(
                /^attachment; filename="test-brand-backup-\d{8}-\d{6}Z\.soundspan-backup"$/,
            ),
        );

        const second = response();
        await handler("/download", "get")(req, second, jest.fn());
        expect(second.statusCode).toBe(401);
        expect(second.body).toEqual({ error: "Backup session is invalid" });
    });
});
