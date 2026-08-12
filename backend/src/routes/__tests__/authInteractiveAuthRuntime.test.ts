jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: any, _res: any, next: () => void) => next(),
    requireAdmin: (_req: any, _res: any, next: () => void) => next(),
    generateToken: jest.fn(),
    generateRefreshToken: jest.fn(),
    verifyAuthToken: jest.fn(),
}));

const mockBcryptCompare = jest.fn();
jest.mock("bcrypt", () => ({
    __esModule: true,
    default: {
        compare: (...args: unknown[]) => mockBcryptCompare(...args),
        hash: jest.fn(),
    },
}));

const mockTotpVerify = jest.fn();
jest.mock("otplib", () => ({
    generateSecret: jest.fn(() => "NEW-SECRET"),
    generateURI: jest.fn(() => "otpauth://test"),
    verify: (...args: unknown[]) => mockTotpVerify(...args),
}));

jest.mock("qrcode", () => ({
    __esModule: true,
    default: { toDataURL: jest.fn(() => "data:image/png;base64,test") },
}));

jest.mock("../../utils/encryption", () => ({
    encrypt: (value: string) => `enc(${value})`,
    decrypt: (value: string) => value.replace(/^enc\((.*)\)$/, "$1"),
}));

const prisma = {
    user: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({ prisma }));

const scopedLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
scopedLogger.child.mockReturnValue(scopedLogger);
jest.mock("../../utils/logger", () => ({ logger: scopedLogger }));

import router from "../auth";

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined,
        status: jest.fn((statusCode: number) => {
            res.statusCode = statusCode;
            return res;
        }),
        json: jest.fn((body: unknown) => {
            res.body = body;
            return res;
        }),
    };
    return res;
}

async function executeRoute(path: string, req: any, res: any): Promise<void> {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.post,
    );
    if (!layer) throw new Error(`Missing POST route ${path}`);

    const dispatch = async (index: number): Promise<void> => {
        const handler = layer.route.stack[index]?.handle;
        if (!handler) return;
        await handler(req, res, (error?: unknown) => {
            if (error) throw error;
            return dispatch(index + 1);
        });
    };
    await dispatch(0);
}

function interactiveRequest(body: Record<string, unknown>): any {
    return {
        body,
        headers: { authorization: "Bearer access-token" },
        user: { id: "u1", username: "alice", role: "user" },
    };
}

describe("MFA management interactive authentication", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockBcryptCompare.mockResolvedValue(true);
        mockTotpVerify.mockResolvedValue({ valid: true });
        prisma.user.findUnique.mockResolvedValue({
            id: "u1",
            username: "alice",
            passwordHash: "password-hash",
            twoFactorEnabled: false,
            twoFactorSecret: null,
        });
        prisma.user.update.mockResolvedValue({});
        prisma.user.updateMany.mockResolvedValue({ count: 1 });
    });

    test.each([
        ["/2fa/setup", {}],
        ["/2fa/enable", { secret: "NEW-SECRET", token: "123456" }],
        ["/2fa/disable", { password: "secret", token: "123456" }],
    ] as const)("rejects API-key authentication on %s", async (path, body) => {
        const req = interactiveRequest(body);
        req.headers["x-api-key"] = "stolen-key";
        const res = createRes();

        await executeRoute(path, req, res);

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({
            error: "Interactive session authentication required",
        });
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
        expect(prisma.user.update).not.toHaveBeenCalled();
        expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it("allows setup with the existing empty payload", async () => {
        const res = createRes();

        await executeRoute("/2fa/setup", interactiveRequest({}), res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            secret: "NEW-SECRET",
            qrCode: "data:image/png;base64,test",
        });
    });

    it("allows enable with the existing secret and token payload", async () => {
        const res = createRes();

        await executeRoute(
            "/2fa/enable",
            interactiveRequest({ secret: "NEW-SECRET", token: "123456" }),
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(prisma.user.updateMany).toHaveBeenCalledWith({
            where: { id: "u1", twoFactorEnabled: false },
            data: expect.objectContaining({
                twoFactorEnabled: true,
                twoFactorSecret: "enc(NEW-SECRET)",
            }),
        });
    });

    it("rejects an existing or concurrently enabled factor", async () => {
        prisma.user.updateMany.mockResolvedValueOnce({ count: 0 });
        const res = createRes();

        await executeRoute(
            "/2fa/enable",
            interactiveRequest({ secret: "NEW-SECRET", token: "123456" }),
            res,
        );

        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({ error: "2FA is already enabled" });
    });

    it("keeps disable protected by the existing password and current token", async () => {
        prisma.user.findUnique.mockResolvedValueOnce({
            id: "u1",
            passwordHash: "password-hash",
            twoFactorEnabled: true,
            twoFactorSecret: "enc(CURRENT-SECRET)",
        });
        const res = createRes();

        await executeRoute(
            "/2fa/disable",
            interactiveRequest({ password: "secret", token: "123456" }),
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(mockBcryptCompare).toHaveBeenCalledWith(
            "secret",
            "password-hash",
        );
        expect(mockTotpVerify).toHaveBeenCalledWith({
            secret: "CURRENT-SECRET",
            token: "123456",
            epochTolerance: 60,
        });
    });
});
