import crypto from "crypto";

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const mockRequireAuth = jest.fn((_req: any, _res: any, next: () => void) => next());
const mockRequireAdmin = jest.fn((_req: any, _res: any, next: () => void) => next());
const mockGenerateToken = jest.fn();
const mockGenerateRefreshToken = jest.fn();

jest.mock("../../middleware/auth", () => ({
    requireAuth: mockRequireAuth,
    requireAdmin: mockRequireAdmin,
    generateToken: mockGenerateToken,
    generateRefreshToken: mockGenerateRefreshToken,
}));

const prisma = {
    user: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
    },
    userSettings: {
        create: jest.fn(),
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

const mockSpeakeasyVerify = jest.fn();
const mockSpeakeasyGenerateSecret = jest.fn();
jest.mock("speakeasy", () => ({
    __esModule: true,
    default: {
        totp: {
            verify: (...args: any[]) => mockSpeakeasyVerify(...args),
        },
        generateSecret: (...args: any[]) => mockSpeakeasyGenerateSecret(...args),
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

function getHandler(
    path: string,
    method: "get" | "post" | "put" | "delete"
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
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

describe("auth routes runtime", () => {
    const login = getHandler("/login", "post");
    const logout = getHandler("/logout", "post");
    const refresh = getHandler("/refresh", "post");
    const me = getHandler("/me", "get");
    const changePassword = getHandler("/change-password", "post");
    const listUsers = getHandler("/users", "get");
    const createUser = getHandler("/create-user", "post");
    const deleteUser = getHandler("/users/:id", "delete");
    const twoFaSetup = getHandler("/2fa/setup", "post");
    const twoFaEnable = getHandler("/2fa/enable", "post");
    const twoFaDisable = getHandler("/2fa/disable", "post");
    const twoFaStatus = getHandler("/2fa/status", "get");
    const getSubsonicPassword = getHandler("/subsonic-password", "get");
    const setSubsonicPassword = getHandler("/subsonic-password", "post");
    const deleteSubsonicPassword = getHandler("/subsonic-password", "delete");

    beforeEach(() => {
        jest.clearAllMocks();

        mockGenerateToken.mockReturnValue("jwt-access");
        mockGenerateRefreshToken.mockReturnValue("jwt-refresh");

        prisma.user.findUnique.mockResolvedValue({
            id: "u1",
            username: "alice",
            role: "user",
            passwordHash: "hash-1",
            tokenVersion: 1,
            onboardingComplete: false,
            enrichmentSettings: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            twoFactorEnabled: false,
            twoFactorSecret: null,
            twoFactorRecoveryCodes: null,
            subsonicPassword: null,
        });
        prisma.user.findMany.mockResolvedValue([]);
        prisma.user.create.mockResolvedValue({
            id: "u-new",
            username: "new-user",
            role: "user",
            createdAt: new Date("2026-02-01T00:00:00.000Z"),
        });
        prisma.user.update.mockResolvedValue({});
        prisma.user.delete.mockResolvedValue({});
        prisma.userSettings.create.mockResolvedValue({});

        mockBcryptCompare.mockResolvedValue(true);
        mockBcryptHash.mockResolvedValue("new-hash");

        mockSpeakeasyVerify.mockReturnValue(true);
        mockSpeakeasyGenerateSecret.mockReturnValue({
            base32: "BASE32SECRET",
            otpauth_url: "otpauth://totp/soundspan:alice?secret=BASE32SECRET",
        });
        mockQrCodeToDataUrl.mockResolvedValue("data:image/png;base64,abc");
        mockJwtVerify.mockReturnValue({
            type: "refresh",
            userId: "u1",
            tokenVersion: 1,
        });
    });

    it("validates login payload and handles invalid credentials", async () => {
        const invalidReq = { body: { username: "", password: "" } } as any;
        const invalidRes = createRes();
        await login(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);

        prisma.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
        const missingReq = { body: { username: "bob", password: "pw" } } as any;
        const missingRes = createRes();
        await login(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(401);

        prisma.user.findUnique.mockResolvedValueOnce({
            id: "u2",
            username: "bob",
            role: "user",
            passwordHash: "hash-bob",
            tokenVersion: 1,
            twoFactorEnabled: false,
            twoFactorSecret: null,
            twoFactorRecoveryCodes: null,
        });
        mockBcryptCompare.mockResolvedValueOnce(false);
        const badPwReq = { body: { username: "bob", password: "wrong" } } as any;
        const badPwRes = createRes();
        await login(badPwReq, badPwRes);
        expect(badPwRes.statusCode).toBe(401);
    });

    it("supports 2FA challenge, TOTP verification, and recovery-code rejection on login", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: "u1",
            username: "alice",
            role: "user",
            passwordHash: "hash-1",
            tokenVersion: 1,
            twoFactorEnabled: true,
            twoFactorSecret: "enc(SECRET123)",
            twoFactorRecoveryCodes: "enc(hash-one,hash-two)",
        });

        const challengeReq = {
            body: { username: "alice", password: "pw" },
        } as any;
        const challengeRes = createRes();
        await login(challengeReq, challengeRes);
        expect(challengeRes.statusCode).toBe(200);
        expect(challengeRes.body).toEqual({
            requires2FA: true,
            message: "2FA token required",
        });

        mockSpeakeasyVerify.mockReturnValueOnce(true);
        const totpReq = {
            body: { username: "alice", password: "pw", token: "123456" },
        } as any;
        const totpRes = createRes();
        await login(totpReq, totpRes);
        expect(totpRes.statusCode).toBe(200);
        expect(totpRes.body).toEqual({
            token: "jwt-access",
            refreshToken: "jwt-refresh",
            user: {
                id: "u1",
                username: "alice",
                role: "user",
            },
        });

        const recoveryReq = {
            body: { username: "alice", password: "pw", token: "ABCDEF12" },
        } as any;
        const recoveryRes = createRes();
        await login(recoveryReq, recoveryRes);
        expect(recoveryRes.statusCode).toBe(401);
        expect(recoveryRes.body).toEqual({ error: "Invalid recovery code" });
    });

    it("rejects login when provided 2FA token is invalid", async () => {
        prisma.user.findUnique.mockResolvedValue({
            id: "u1",
            username: "alice",
            role: "user",
            passwordHash: "hash-1",
            tokenVersion: 1,
            twoFactorEnabled: true,
            twoFactorSecret: "enc(SECRET123)",
            twoFactorRecoveryCodes: null,
        });
        mockSpeakeasyVerify.mockReturnValueOnce(false);

        const req = {
            body: { username: "alice", password: "pw", token: "000000" },
        } as any;
        const res = createRes();
        await login(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Invalid 2FA token" });
    });

    it("consumes a valid 2FA recovery code and updates stored hashes", async () => {
        const goodCode = "A1B2C3D4";
        const goodHash = crypto
            .createHash("sha256")
            .update(goodCode)
            .digest("hex");

        prisma.user.findUnique.mockResolvedValue({
            id: "u1",
            username: "alice",
            role: "user",
            passwordHash: "hash-1",
            tokenVersion: 1,
            twoFactorEnabled: true,
            twoFactorSecret: "enc(SECRET123)",
            twoFactorRecoveryCodes: `enc(${goodHash},other-hash)`,
        });

        const req = {
            body: { username: "alice", password: "pw", token: goodCode },
        } as any;
        const res = createRes();
        await login(req, res);

        expect(res.statusCode).toBe(200);
        expect(prisma.user.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "u1" },
                data: {
                    twoFactorRecoveryCodes: expect.stringContaining("other-hash"),
                },
            })
        );
    });

    it("handles logout and refresh-token validation paths", async () => {
        const logoutRes = createRes();
        await logout({} as any, logoutRes);
        expect(logoutRes.statusCode).toBe(200);
        expect(logoutRes.body).toEqual({ message: "Logged out" });

        const missingReq = { body: {} } as any;
        const missingRes = createRes();
        await refresh(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(400);

        mockJwtVerify.mockReturnValueOnce({ type: "access", userId: "u1" });
        const wrongTypeReq = { body: { refreshToken: "rt" } } as any;
        const wrongTypeRes = createRes();
        await refresh(wrongTypeReq, wrongTypeRes);
        expect(wrongTypeRes.statusCode).toBe(401);

        prisma.user.findUnique.mockResolvedValueOnce(null);
        const noUserReq = { body: { refreshToken: "rt" } } as any;
        const noUserRes = createRes();
        await refresh(noUserReq, noUserRes);
        expect(noUserRes.statusCode).toBe(401);

        prisma.user.findUnique.mockResolvedValueOnce({
            id: "u1",
            username: "alice",
            role: "user",
            tokenVersion: 2,
        });
        const invalidatedReq = { body: { refreshToken: "rt" } } as any;
        const invalidatedRes = createRes();
        await refresh(invalidatedReq, invalidatedRes);
        expect(invalidatedRes.statusCode).toBe(401);
        expect(invalidatedRes.body).toEqual({ error: "Token invalidated" });

        prisma.user.findUnique.mockResolvedValueOnce({
            id: "u1",
            username: "alice",
            role: "user",
            tokenVersion: 1,
        });
        const okReq = { body: { refreshToken: "rt" } } as any;
        const okRes = createRes();
        await refresh(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual({
            token: "jwt-access",
            refreshToken: "jwt-refresh",
        });

        mockJwtVerify.mockImplementationOnce(() => {
            throw new Error("bad token");
        });
        const badJwtReq = { body: { refreshToken: "rt" } } as any;
        const badJwtRes = createRes();
        await refresh(badJwtReq, badJwtRes);
        expect(badJwtRes.statusCode).toBe(401);
    });

    it("returns current user profile and handles missing user", async () => {
        prisma.user.findUnique.mockResolvedValueOnce(null);
        const missingReq = { user: { id: "u1" } } as any;
        const missingRes = createRes();
        await me(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);

        prisma.user.findUnique.mockResolvedValueOnce({
            id: "u1",
            username: "alice",
            role: "user",
            onboardingComplete: true,
            enrichmentSettings: { genre: true },
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
        });
        const okReq = { user: { id: "u1" } } as any;
        const okRes = createRes();
        await me(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body.username).toBe("alice");
    });

    it("changes password with full validation and token-version increment", async () => {
        const missingReq = {
            user: { id: "u1" },
            body: { currentPassword: "", newPassword: "" },
        } as any;
        const missingRes = createRes();
        await changePassword(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(400);

        const shortReq = {
            user: { id: "u1" },
            body: { currentPassword: "old", newPassword: "123" },
        } as any;
        const shortRes = createRes();
        await changePassword(shortReq, shortRes);
        expect(shortRes.statusCode).toBe(400);

        prisma.user.findUnique.mockResolvedValueOnce(null);
        const noUserReq = {
            user: { id: "u1" },
            body: { currentPassword: "old", newPassword: "new-password" },
        } as any;
        const noUserRes = createRes();
        await changePassword(noUserReq, noUserRes);
        expect(noUserRes.statusCode).toBe(404);

        prisma.user.findUnique.mockResolvedValueOnce({
            id: "u1",
            passwordHash: "hash-1",
        });
        mockBcryptCompare.mockResolvedValueOnce(false);
        const badCurrentReq = {
            user: { id: "u1" },
            body: { currentPassword: "old", newPassword: "new-password" },
        } as any;
        const badCurrentRes = createRes();
        await changePassword(badCurrentReq, badCurrentRes);
        expect(badCurrentRes.statusCode).toBe(401);

        prisma.user.findUnique.mockResolvedValueOnce({
            id: "u1",
            passwordHash: "hash-1",
        });
        mockBcryptCompare.mockResolvedValueOnce(true);
        const okReq = {
            user: { id: "u1" },
            body: { currentPassword: "old", newPassword: "new-password" },
        } as any;
        const okRes = createRes();
        await changePassword(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: "u1" },
            data: {
                passwordHash: "new-hash",
                tokenVersion: { increment: 1 },
            },
        });
    });

    it("returns 500 for change-password handler failures", async () => {
        prisma.user.findUnique.mockRejectedValue(new Error("db"));
        const req = {
            user: { id: "u1" },
            body: { currentPassword: "old", newPassword: "new-password" },
        } as any;
        const res = createRes();
        await changePassword(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to change password" });
    });

    it("handles admin user list/create/delete flows", async () => {
        prisma.user.findMany.mockResolvedValueOnce([
            { id: "u1", username: "alice", role: "admin" },
        ]);
        const listReq = { user: { id: "admin-1" } } as any;
        const listRes = createRes();
        await listUsers(listReq, listRes);
        expect(listRes.statusCode).toBe(200);
        expect(listRes.body).toHaveLength(1);

        const missingFieldsReq = { body: { username: "", password: "" } } as any;
        const missingFieldsRes = createRes();
        await createUser(missingFieldsReq, missingFieldsRes);
        expect(missingFieldsRes.statusCode).toBe(400);

        const shortPwReq = {
            body: { username: "x", password: "12345", role: "user" },
        } as any;
        const shortPwRes = createRes();
        await createUser(shortPwReq, shortPwRes);
        expect(shortPwRes.statusCode).toBe(400);

        const badRoleReq = {
            body: { username: "x", password: "123456", role: "root" },
        } as any;
        const badRoleRes = createRes();
        await createUser(badRoleReq, badRoleRes);
        expect(badRoleRes.statusCode).toBe(400);

        prisma.user.findUnique.mockResolvedValueOnce({ id: "exists" });
        const existsReq = {
            body: { username: "alice", password: "123456", role: "user" },
        } as any;
        const existsRes = createRes();
        await createUser(existsReq, existsRes);
        expect(existsRes.statusCode).toBe(400);

        prisma.user.findUnique.mockResolvedValueOnce(null);
        const createReq = {
            body: { username: "new-user", password: "123456", role: "admin" },
        } as any;
        const createUserRes = createRes();
        await createUser(createReq, createUserRes);
        expect(createUserRes.statusCode).toBe(200);
        expect(prisma.userSettings.create).toHaveBeenCalled();

        const selfDeleteReq = {
            user: { id: "u1" },
            params: { id: "u1" },
        } as any;
        const selfDeleteRes = createRes();
        await deleteUser(selfDeleteReq, selfDeleteRes);
        expect(selfDeleteRes.statusCode).toBe(400);

        prisma.user.delete.mockRejectedValueOnce({ code: "P2025" });
        const missingDeleteReq = {
            user: { id: "admin-1" },
            params: { id: "u404" },
        } as any;
        const missingDeleteRes = createRes();
        await deleteUser(missingDeleteReq, missingDeleteRes);
        expect(missingDeleteRes.statusCode).toBe(404);

        prisma.user.delete.mockResolvedValueOnce({});
        const okDeleteReq = {
            user: { id: "admin-1" },
            params: { id: "u2" },
        } as any;
        const okDeleteRes = createRes();
        await deleteUser(okDeleteReq, okDeleteRes);
        expect(okDeleteRes.statusCode).toBe(200);
    });

    it("returns 500 when listing users fails", async () => {
        prisma.user.findMany.mockRejectedValue(new Error("db"));
        const req = { user: { id: "admin-1" } } as any;
        const res = createRes();
        await listUsers(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get users" });
    });

    it("returns 500 when creating user fails", async () => {
        prisma.user.findUnique.mockResolvedValueOnce(null);
        prisma.user.create.mockRejectedValue(new Error("db"));
        const req = {
            body: { username: "new-user", password: "123456", role: "user" },
        } as any;
        const res = createRes();
        await createUser(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to create user" });
    });

    it("returns 500 for generic delete-user failures", async () => {
        prisma.user.delete.mockRejectedValue(new Error("db"));
        const req = {
            user: { id: "admin-1" },
            params: { id: "u2" },
        } as any;
        const res = createRes();
        await deleteUser(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to delete user" });
    });

    it("handles 2FA setup, enable, disable, and status endpoints", async () => {
        prisma.user.findUnique.mockResolvedValueOnce(null);
        const missingSetupReq = { user: { id: "u1" } } as any;
        const missingSetupRes = createRes();
        await twoFaSetup(missingSetupReq, missingSetupRes);
        expect(missingSetupRes.statusCode).toBe(404);

        prisma.user.findUnique.mockResolvedValueOnce({
            username: "alice",
            twoFactorEnabled: true,
        });
        const enabledSetupReq = { user: { id: "u1" } } as any;
        const enabledSetupRes = createRes();
        await twoFaSetup(enabledSetupReq, enabledSetupRes);
        expect(enabledSetupRes.statusCode).toBe(400);

        prisma.user.findUnique.mockResolvedValueOnce({
            username: "alice",
            twoFactorEnabled: false,
        });
        const okSetupReq = { user: { id: "u1" } } as any;
        const okSetupRes = createRes();
        await twoFaSetup(okSetupReq, okSetupRes);
        expect(okSetupRes.statusCode).toBe(200);
        expect(okSetupRes.body).toEqual({
            secret: "BASE32SECRET",
            qrCode: "data:image/png;base64,abc",
        });

        const enableMissingReq = { user: { id: "u1" }, body: {} } as any;
        const enableMissingRes = createRes();
        await twoFaEnable(enableMissingReq, enableMissingRes);
        expect(enableMissingRes.statusCode).toBe(400);

        mockSpeakeasyVerify.mockReturnValueOnce(false);
        const enableBadTokenReq = {
            user: { id: "u1" },
            body: { secret: "BASE32SECRET", token: "123456" },
        } as any;
        const enableBadTokenRes = createRes();
        await twoFaEnable(enableBadTokenReq, enableBadTokenRes);
        expect(enableBadTokenRes.statusCode).toBe(401);

        mockSpeakeasyVerify.mockReturnValueOnce(true);
        const enableOkReq = {
            user: { id: "u1" },
            body: { secret: "BASE32SECRET", token: "123456" },
        } as any;
        const enableOkRes = createRes();
        await twoFaEnable(enableOkReq, enableOkRes);
        expect(enableOkRes.statusCode).toBe(200);
        expect(enableOkRes.body.message).toBe("2FA enabled successfully");
        expect(enableOkRes.body.recoveryCodes).toHaveLength(10);

        const disableMissingReq = { user: { id: "u1" }, body: {} } as any;
        const disableMissingRes = createRes();
        await twoFaDisable(disableMissingReq, disableMissingRes);
        expect(disableMissingRes.statusCode).toBe(400);

        prisma.user.findUnique.mockResolvedValueOnce(null);
        const disableNoUserReq = {
            user: { id: "u1" },
            body: { password: "old", token: "123456" },
        } as any;
        const disableNoUserRes = createRes();
        await twoFaDisable(disableNoUserReq, disableNoUserRes);
        expect(disableNoUserRes.statusCode).toBe(404);

        prisma.user.findUnique.mockResolvedValueOnce({
            id: "u1",
            passwordHash: "hash-1",
            twoFactorSecret: "enc(BASE32SECRET)",
        });
        mockBcryptCompare.mockResolvedValueOnce(false);
        const disableBadPwReq = {
            user: { id: "u1" },
            body: { password: "wrong", token: "123456" },
        } as any;
        const disableBadPwRes = createRes();
        await twoFaDisable(disableBadPwReq, disableBadPwRes);
        expect(disableBadPwRes.statusCode).toBe(401);

        prisma.user.findUnique.mockResolvedValueOnce({
            id: "u1",
            passwordHash: "hash-1",
            twoFactorSecret: "enc(BASE32SECRET)",
        });
        mockBcryptCompare.mockResolvedValueOnce(true);
        mockSpeakeasyVerify.mockReturnValueOnce(false);
        const disableBadTokenReq = {
            user: { id: "u1" },
            body: { password: "old", token: "000000" },
        } as any;
        const disableBadTokenRes = createRes();
        await twoFaDisable(disableBadTokenReq, disableBadTokenRes);
        expect(disableBadTokenRes.statusCode).toBe(401);

        prisma.user.findUnique.mockResolvedValueOnce({
            id: "u1",
            passwordHash: "hash-1",
            twoFactorSecret: "enc(BASE32SECRET)",
        });
        mockBcryptCompare.mockResolvedValueOnce(true);
        mockSpeakeasyVerify.mockReturnValueOnce(true);
        const disableOkReq = {
            user: { id: "u1" },
            body: { password: "old", token: "123456" },
        } as any;
        const disableOkRes = createRes();
        await twoFaDisable(disableOkReq, disableOkRes);
        expect(disableOkRes.statusCode).toBe(200);

        prisma.user.findUnique.mockResolvedValueOnce(null);
        const statusMissingReq = { user: { id: "u1" } } as any;
        const statusMissingRes = createRes();
        await twoFaStatus(statusMissingReq, statusMissingRes);
        expect(statusMissingRes.statusCode).toBe(404);

        prisma.user.findUnique.mockResolvedValueOnce({ twoFactorEnabled: true });
        const statusReq = { user: { id: "u1" } } as any;
        const statusRes = createRes();
        await twoFaStatus(statusReq, statusRes);
        expect(statusRes.statusCode).toBe(200);
        expect(statusRes.body).toEqual({ enabled: true });
    });

    it("returns 500 for 2FA setup failures", async () => {
        prisma.user.findUnique.mockResolvedValueOnce({
            username: "alice",
            twoFactorEnabled: false,
        });
        mockSpeakeasyGenerateSecret.mockImplementationOnce(() => {
            throw new Error("qrcode");
        });

        const req = { user: { id: "u1" } } as any;
        const res = createRes();
        await twoFaSetup(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to setup 2FA" });
    });

    it("returns 500 for 2FA enable failures", async () => {
        mockSpeakeasyVerify.mockReturnValueOnce(true);
        prisma.user.update.mockRejectedValueOnce(new Error("db"));

        const req = {
            user: { id: "u1" },
            body: { secret: "BASE32SECRET", token: "123456" },
        } as any;
        const res = createRes();
        await twoFaEnable(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to enable 2FA" });
    });

    it("returns 500 for 2FA disable failures", async () => {
        prisma.user.findUnique.mockResolvedValueOnce({
            id: "u1",
            passwordHash: "hash-1",
            twoFactorSecret: "enc(BASE32SECRET)",
        });
        mockBcryptCompare.mockResolvedValueOnce(true);
        mockSpeakeasyVerify.mockReturnValueOnce(true);
        prisma.user.update.mockRejectedValueOnce(new Error("db"));

        const req = {
            user: { id: "u1" },
            body: { password: "old", token: "123456" },
        } as any;
        const res = createRes();
        await twoFaDisable(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to disable 2FA" });
    });

    it("returns 500 for 2FA status failures", async () => {
        prisma.user.findUnique.mockRejectedValue(new Error("db"));

        const req = { user: { id: "u1" } } as any;
        const res = createRes();
        await twoFaStatus(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get 2FA status" });
    });

    it("handles Subsonic password status, set, and delete endpoints", async () => {
        prisma.user.findUnique.mockResolvedValueOnce(null);
        const missingReq = { user: { id: "u1" } } as any;
        const missingRes = createRes();
        await getSubsonicPassword(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);

        prisma.user.findUnique.mockResolvedValueOnce({ subsonicPassword: "enc(x)" });
        const statusReq = { user: { id: "u1" } } as any;
        const statusRes = createRes();
        await getSubsonicPassword(statusReq, statusRes);
        expect(statusRes.statusCode).toBe(200);
        expect(statusRes.body).toEqual({ hasPassword: true });

        const invalidSetReq = { user: { id: "u1" }, body: { password: "123" } } as any;
        const invalidSetRes = createRes();
        await setSubsonicPassword(invalidSetReq, invalidSetRes);
        expect(invalidSetRes.statusCode).toBe(400);

        const setReq = {
            user: { id: "u1" },
            body: { password: "my-subsonic-password" },
        } as any;
        const setRes = createRes();
        await setSubsonicPassword(setReq, setRes);
        expect(setRes.statusCode).toBe(200);
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: "u1" },
            data: {
                subsonicPassword: "enc(my-subsonic-password)",
            },
        });

        const deleteReq = { user: { id: "u1" } } as any;
        const deleteRes = createRes();
        await deleteSubsonicPassword(deleteReq, deleteRes);
        expect(deleteRes.statusCode).toBe(200);
        expect(deleteRes.body).toEqual({ success: true });
    });

    it("returns 500 for Subsonic password endpoint failures", async () => {
        prisma.user.findUnique.mockRejectedValueOnce(new Error("db"));
        const statusReq = { user: { id: "u1" } } as any;
        const statusRes = createRes();
        await getSubsonicPassword(statusReq, statusRes);
        expect(statusRes.statusCode).toBe(500);
        expect(statusRes.body).toEqual({
            error: "Failed to get Subsonic password status",
        });

        prisma.user.update.mockRejectedValueOnce(new Error("db"));
        const setReq = {
            user: { id: "u1" },
            body: { password: "my-subsonic-password" },
        } as any;
        const setRes = createRes();
        await setSubsonicPassword(setReq, setRes);
        expect(setRes.statusCode).toBe(500);
        expect(setRes.body).toEqual({
            error: "Failed to set Subsonic password",
        });

        prisma.user.update.mockRejectedValueOnce(new Error("db"));
        const deleteReq = { user: { id: "u1" } } as any;
        const deleteRes = createRes();
        await deleteSubsonicPassword(deleteReq, deleteRes);
        expect(deleteRes.statusCode).toBe(500);
        expect(deleteRes.body).toEqual({
            error: "Failed to delete Subsonic password",
        });
    });
});
