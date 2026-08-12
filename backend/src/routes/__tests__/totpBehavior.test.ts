const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);
jest.mock("../../utils/logger", () => ({ logger: mockLogger }));

const mockRequireAuth = jest.fn((_req: any, _res: any, next: () => void) =>
    next(),
);
const mockRequireAdmin = jest.fn((_req: any, _res: any, next: () => void) =>
    next(),
);
const mockGenerateToken = jest.fn();
const mockGenerateRefreshToken = jest.fn();
const mockVerifyAuthToken = jest.fn();

jest.mock("../../middleware/auth", () => ({
    requireAuth: mockRequireAuth,
    requireAdmin: mockRequireAdmin,
    generateToken: mockGenerateToken,
    generateRefreshToken: mockGenerateRefreshToken,
    verifyAuthToken: mockVerifyAuthToken,
}));

const prisma = {
    user: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({
    prisma,
}));

const mockBcryptCompare = jest.fn();
const mockBcryptHash = jest.fn();
jest.mock("bcrypt", () => ({
    __esModule: true,
    default: {
        compare: (...args: any[]) => mockBcryptCompare(...args),
        hash: (...args: any[]) => mockBcryptHash(...args),
    },
}));

const mockQrCodeToDataUrl = jest.fn();
jest.mock("qrcode", () => ({
    __esModule: true,
    default: {
        toDataURL: (...args: any[]) => mockQrCodeToDataUrl(...args),
    },
}));

const mockJwtVerify = jest.fn();
jest.mock("jsonwebtoken", () => ({
    __esModule: true,
    default: {
        verify: (...args: any[]) => mockJwtVerify(...args),
    },
}));

const mockEncrypt = jest.fn((value: string) => `enc(${value})`);
const mockDecrypt = jest.fn((value: string) => {
    if (typeof value !== "string") {
        return "";
    }
    if (value.startsWith("enc(") && value.endsWith(")")) {
        return value.slice(4, -1);
    }
    return value;
});

jest.mock("../../utils/encryption", () => ({
    encrypt: mockEncrypt,
    decrypt: mockDecrypt,
}));

import router from "../auth";

const FIXED_EPOCH_MS = 1754700000000;
const SECRET_B32 = "HEYHKYLRO4TCQKL2JZIEA4BUIBITUJTBLVOXWOTEORWFI3SBKQ4Q";

function getHandler(path: string, method: "get" | "post" | "put" | "delete") {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer) {
        throw new Error(`${method.toUpperCase()} route not found: ${path}`);
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

describe("auth TOTP behavior", () => {
    const login = getHandler("/login", "post");
    const twoFaSetup = getHandler("/2fa/setup", "post");
    const twoFaEnable = getHandler("/2fa/enable", "post");
    const twoFaDisable = getHandler("/2fa/disable", "post");

    beforeEach(() => {
        jest.clearAllMocks();
        jest.spyOn(Date, "now").mockReturnValue(FIXED_EPOCH_MS);

        prisma.user.update.mockResolvedValue({});
        prisma.user.updateMany.mockResolvedValue({ count: 1 });
        mockBcryptCompare.mockResolvedValue(true);
        mockGenerateToken.mockReturnValue("tok");
        mockGenerateRefreshToken.mockReturnValue("rtok");
        mockQrCodeToDataUrl.mockResolvedValue("data:image/png;base64,x");
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("enables 2FA with the current TOTP token", async () => {
        const req = {
            user: { id: "u1" },
            body: { secret: SECRET_B32, token: "981430" },
        } as any;
        const res = createRes();

        await twoFaEnable(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.recoveryCodes).toHaveLength(10);
        expect(res.body.recoveryCodes).toEqual(
            expect.arrayContaining([expect.stringMatching(/^[A-F0-9]{8}$/)]),
        );
        expect(res.body.recoveryCodes).toEqual(
            res.body.recoveryCodes.filter((code: string) =>
                /^[A-F0-9]{8}$/.test(code),
            ),
        );
        expect(prisma.user.updateMany).toHaveBeenCalledWith({
            where: { id: "u1", twoFactorEnabled: false },
            data: {
                twoFactorEnabled: true,
                twoFactorSecret: `enc(${SECRET_B32})`,
                twoFactorRecoveryCodes: expect.stringMatching(/^enc\(.+\)$/),
            },
        });
    });

    it.each([
        ["step -2", "266218"],
        ["step +2", "039010"],
    ])("accepts the %s edge-of-window token", async (_step, token) => {
        const req = {
            user: { id: "u1" },
            body: { secret: SECRET_B32, token },
        } as any;
        const res = createRes();

        await twoFaEnable(req, res);

        expect(res.statusCode).toBe(200);
    });

    it.each([
        ["outside-window", "231815"],
        ["incorrect", "000000"],
    ])("rejects an %s token when enabling 2FA", async (_kind, token) => {
        const req = {
            user: { id: "u1" },
            body: { secret: SECRET_B32, token },
        } as any;
        const res = createRes();

        await twoFaEnable(req, res);

        expect(res.statusCode).toBe(401);
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it("logs in with a valid TOTP token", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: "u1",
            username: "alice",
            displayName: undefined,
            passwordHash: "hashed",
            role: "USER",
            tokenVersion: 0,
            twoFactorEnabled: true,
            twoFactorSecret: `enc(${SECRET_B32})`,
            twoFactorRecoveryCodes: null,
        });
        const req = {
            body: {
                username: "alice",
                password: "password",
                token: "981430",
            },
        } as any;
        const res = createRes();

        await login(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            token: "tok",
            refreshToken: "rtok",
            user: {
                id: "u1",
                username: "alice",
                displayName: undefined,
                role: "USER",
            },
        });
    });

    it("rejects login with an outside-window TOTP token", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: "u1",
            username: "alice",
            passwordHash: "hashed",
            role: "USER",
            tokenVersion: 0,
            twoFactorEnabled: true,
            twoFactorSecret: `enc(${SECRET_B32})`,
            twoFactorRecoveryCodes: null,
        });
        const req = {
            body: {
                username: "alice",
                password: "password",
                token: "231815",
            },
        } as any;
        const res = createRes();

        await login(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Invalid 2FA token" });
    });

    it("returns a real base32 setup secret and its QR code", async () => {
        prisma.user.findUnique.mockResolvedValue({
            username: "alice",
            twoFactorEnabled: false,
        });
        const req = { user: { id: "u1" } } as any;
        const res = createRes();

        await twoFaSetup(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.secret).toMatch(/^[A-Z2-7]+=*$/);
        expect(res.body.secret.length).toBeGreaterThanOrEqual(16);
        expect(mockQrCodeToDataUrl).toHaveBeenCalledWith(
            expect.stringMatching(
                new RegExp(`^otpauth://totp/.*secret=${res.body.secret}`),
            ),
        );
        expect(res.body.qrCode).toBe("data:image/png;base64,x");
    });

    it("disables 2FA with a valid TOTP token", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: "u1",
            passwordHash: "hashed",
            twoFactorEnabled: true,
            twoFactorSecret: `enc(${SECRET_B32})`,
        });
        const req = {
            user: { id: "u1" },
            body: { password: "password", token: "981430" },
        } as any;
        const res = createRes();

        await twoFaDisable(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ message: "2FA disabled successfully" });
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: "u1" },
            data: {
                twoFactorEnabled: false,
                twoFactorSecret: null,
                twoFactorRecoveryCodes: null,
            },
        });
    });

    it("rejects disabling 2FA with an outside-window TOTP token", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: "u1",
            passwordHash: "hashed",
            twoFactorEnabled: true,
            twoFactorSecret: `enc(${SECRET_B32})`,
        });
        const req = {
            user: { id: "u1" },
            body: { password: "password", token: "231815" },
        } as any;
        const res = createRes();

        await twoFaDisable(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Invalid 2FA token" });
        expect(prisma.user.update).not.toHaveBeenCalled();
    });
});
