import { NextFunction, Request, Response } from "express";
import { createHash } from "crypto";

jest.mock("../../utils/db", () => ({
    prisma: {
        user: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        apiKey: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
    },
}));

jest.mock("bcrypt", () => ({
    compare: jest.fn(),
}));

jest.mock("../../utils/encryption", () => ({
    decrypt: jest.fn(),
    encrypt: jest.fn((value: string) => `enc:${value}`),
}));

jest.mock("../../utils/subsonicResponse", () => ({
    getResponseFormat: jest.fn(() => "json"),
    sendSubsonicError: jest.fn(),
    SubsonicErrorCode: {
        MISSING_PARAMETER: 10,
        WRONG_CREDENTIALS: 40,
        MULTIPLE_AUTH_MECHANISMS: 43,
        INVALID_API_KEY: 44,
    },
}));

import bcrypt from "bcrypt";
import { prisma } from "../../utils/db";
import { decrypt } from "../../utils/encryption";
import { sendSubsonicError } from "../../utils/subsonicResponse";
import { requireSubsonicAuth } from "../subsonicAuth";

function buildReq(query: Record<string, string>): Request {
    return { query } as unknown as Request;
}

function buildRes(): Response {
    return {} as Response;
}

describe("requireSubsonicAuth", () => {
    const mockFindUnique = prisma.user.findUnique as jest.Mock;
    const mockUpdate = prisma.user.update as jest.Mock;
    const mockApiKeyFindUnique = prisma.apiKey.findUnique as jest.Mock;
    const mockApiKeyUpdate = prisma.apiKey.update as jest.Mock;
    const mockCompare = bcrypt.compare as jest.Mock;
    const mockDecrypt = decrypt as jest.Mock;
    const mockSendError = sendSubsonicError as jest.Mock;
    let next: NextFunction;

    beforeEach(() => {
        jest.clearAllMocks();
        next = jest.fn();
    });

    it("returns missing parameter error when version is missing", async () => {
        await requireSubsonicAuth(
            buildReq({ c: "client", u: "alice", p: "secret" }),
            buildRes(),
            next,
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'v' (version) is missing",
            "json",
            undefined,
        );
        expect(next).not.toHaveBeenCalled();
    });

    it("returns missing parameter error when client is missing", async () => {
        await requireSubsonicAuth(
            buildReq({ v: "1.16.1", u: "alice", p: "secret" }),
            buildRes(),
            next,
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'c' (client) is missing",
            "json",
            undefined,
        );
        expect(next).not.toHaveBeenCalled();
    });

    it("returns missing parameter error when username is missing", async () => {
        await requireSubsonicAuth(
            buildReq({ v: "1.16.1", c: "client", p: "secret" }),
            buildRes(),
            next,
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'u' (username) is missing",
            "json",
            undefined,
        );
        expect(next).not.toHaveBeenCalled();
    });

    it("returns missing credentials error when no password/token/apiKey is provided", async () => {
        await requireSubsonicAuth(
            buildReq({ v: "1.16.1", c: "client", u: "alice" }),
            buildRes(),
            next,
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            10,
            "Required parameter 'p' (password), 't'+'s' (token+salt), or 'apiKey' is missing",
            "json",
            undefined,
        );
        expect(next).not.toHaveBeenCalled();
    });

    it("authenticates password mode and stores subsonic password", async () => {
        mockFindUnique.mockResolvedValue({
            id: "u1",
            username: "alice",
            role: "user",
            passwordHash: "hash",
            subsonicPassword: null,
        });
        mockCompare.mockResolvedValue(true);
        mockUpdate.mockResolvedValue({});
        mockApiKeyUpdate.mockResolvedValue({});

        const req = buildReq({
            u: "alice",
            v: "1.16.1",
            c: "symfonium",
            p: "secret",
        });

        await requireSubsonicAuth(req, buildRes(), next);

        expect(mockCompare).toHaveBeenCalledWith("secret", "hash");
        expect(mockUpdate).toHaveBeenCalledWith({
            where: { id: "u1" },
            data: { subsonicPassword: "enc:secret" },
        });
        expect((req as any).user).toEqual({
            id: "u1",
            username: "alice",
            role: "user",
        });
        expect((req as any).subsonicClient).toBe("symfonium");
        expect((req as any).subsonicVersion).toBe("1.16.1");
        expect(next).toHaveBeenCalled();
    });

    it("returns invalid password encoding when encoded subsonic password cannot be decoded", async () => {
        const bufferFromSpy = jest
            .spyOn(Buffer as any, "from")
            .mockImplementationOnce(() => {
                throw new Error("bad payload");
            });

        mockFindUnique.mockResolvedValue({
            id: "u1",
            username: "alice",
            role: "user",
            passwordHash: "hash",
            subsonicPassword: null,
        });
        mockCompare.mockResolvedValue(false);
        mockUpdate.mockResolvedValue({});
        mockApiKeyUpdate.mockResolvedValue({});

        await requireSubsonicAuth(
            buildReq({
                u: "alice",
                v: "1.16.1",
                c: "client",
                p: "enc:not-a-hex",
            }),
            buildRes(),
            next,
        );

        bufferFromSpy.mockRestore();

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            40,
            "Invalid password encoding",
            "json",
            undefined,
        );
        expect(mockCompare).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
    });

    it("authenticates token mode using stored subsonic password", async () => {
        const salt = "abc123";
        const plain = "secret";
        const token = createHash("md5").update(plain + salt).digest("hex");

        mockFindUnique.mockResolvedValue({
            id: "u1",
            username: "alice",
            role: "admin",
            passwordHash: "hash",
            subsonicPassword: "cipher",
        });
        mockDecrypt.mockReturnValue(plain);

        const req = buildReq({
            u: "alice",
            v: "1.16.1",
            c: "dsub",
            t: token,
            s: salt,
        });

        await requireSubsonicAuth(req, buildRes(), next);

        expect(mockDecrypt).toHaveBeenCalledWith("cipher");
        expect(mockCompare).not.toHaveBeenCalled();
        expect(mockUpdate).not.toHaveBeenCalled();
        expect((req as any).user).toEqual({
            id: "u1",
            username: "alice",
            role: "admin",
        });
        expect(next).toHaveBeenCalled();
    });

    it("accepts token auth with case-insensitive hashes", async () => {
        const salt = "salt";
        const plain = "secret";
        const token = createHash("md5").update(plain + salt).digest("hex").toUpperCase();

        mockFindUnique.mockResolvedValue({
            id: "u1",
            username: "alice",
            role: "user",
            passwordHash: "hash",
            subsonicPassword: "cipher",
        });
        mockDecrypt.mockReturnValue(plain);

        const req = buildReq({
            u: "alice",
            v: "1.16.1",
            c: "client",
            t: token,
            s: salt,
        });

        await requireSubsonicAuth(
            req,
            buildRes(),
            next,
        );

        expect(mockDecrypt).toHaveBeenCalledWith("cipher");
        expect(mockCompare).not.toHaveBeenCalled();
        expect((req as any).user).toEqual({
            id: "u1",
            username: "alice",
            role: "user",
        });
        expect(next).toHaveBeenCalled();
    });

    it("falls back to wrong-credentials when token decryption fails and password is not provided", async () => {
        const salt = "abc";
        const token = createHash("md5").update("secret").update(salt).digest("hex");

        mockFindUnique.mockResolvedValue({
            id: "u1",
            username: "alice",
            role: "user",
            passwordHash: "hash",
            subsonicPassword: "cipher",
        });
        mockDecrypt.mockImplementation(() => {
            throw new Error("bad secret");
        });

        await requireSubsonicAuth(
            buildReq({
                u: "alice",
                v: "1.16.1",
                c: "client",
                t: token,
                s: salt,
            }),
            buildRes(),
            next,
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            40,
            "Wrong username or password",
            "json",
            undefined,
        );
        expect(mockCompare).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
    });

    it("returns wrong credentials when token does not match stored secret", async () => {
        const salt = "abc";

        mockFindUnique.mockResolvedValue({
            id: "u1",
            username: "alice",
            role: "user",
            passwordHash: "hash",
            subsonicPassword: "cipher",
        });
        mockDecrypt.mockReturnValue("secret");

        await requireSubsonicAuth(
            buildReq({
                u: "alice",
                v: "1.16.1",
                c: "client",
                t: "badtoken",
                s: salt,
            }),
            buildRes(),
            next,
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            40,
            "Wrong username or password",
            "json",
            undefined,
        );
        expect(mockCompare).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
    });

    it("supports enc: hex password format", async () => {
        const encoded = Buffer.from("secret", "utf-8").toString("hex");

        mockFindUnique.mockResolvedValue({
            id: "u1",
            username: "alice",
            role: "user",
            passwordHash: "hash",
            subsonicPassword: null,
        });
        mockCompare.mockResolvedValue(true);
        mockUpdate.mockResolvedValue({});
        mockApiKeyUpdate.mockResolvedValue({});

        await requireSubsonicAuth(
            buildReq({
                u: "alice",
                v: "1.16.1",
                c: "client",
                p: `enc:${encoded}`,
            }),
            buildRes(),
            next,
        );

        expect(mockCompare).toHaveBeenCalledWith("secret", "hash");
        expect(next).toHaveBeenCalled();
    });

    it("returns wrong credentials when password and token auth both fail", async () => {
        mockFindUnique.mockResolvedValue({
            id: "u1",
            username: "alice",
            role: "user",
            passwordHash: "hash",
            subsonicPassword: null,
        });
        mockCompare.mockResolvedValue(false);

        await requireSubsonicAuth(
            buildReq({
                u: "alice",
                v: "1.16.1",
                c: "client",
                p: "bad",
            }),
            buildRes(),
            next,
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            40,
            "Wrong username or password",
            "json",
            undefined,
        );
        expect(next).not.toHaveBeenCalled();
    });

    it("authenticates apiKey mode without password/token parameters", async () => {
        mockApiKeyFindUnique.mockResolvedValue({
            id: "key-1",
            user: {
                id: "u1",
                username: "alice",
                role: "user",
            },
        });
        mockApiKeyUpdate.mockResolvedValue({});

        const req = buildReq({
            v: "1.16.1",
            c: "symfonium",
            apiKey: "apikey-secret",
        });

        await requireSubsonicAuth(req, buildRes(), next);

        expect(mockApiKeyFindUnique).toHaveBeenCalledWith({
            where: { key: "apikey-secret" },
            include: {
                user: {
                    select: {
                        id: true,
                        username: true,
                        role: true,
                    },
                },
            },
        });
        expect(mockCompare).not.toHaveBeenCalled();
        expect((req as any).user).toEqual({
            id: "u1",
            username: "alice",
            role: "user",
        });
        expect(next).toHaveBeenCalled();
    });

    it("rejects invalid apiKey", async () => {
        mockApiKeyFindUnique.mockResolvedValue(null);

        await requireSubsonicAuth(
            buildReq({
                v: "1.16.1",
                c: "client",
                apiKey: "bad-key",
            }),
            buildRes(),
            next,
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            44,
            "Invalid API key",
            "json",
            undefined,
        );
        expect(next).not.toHaveBeenCalled();
    });

    it("rejects when apiKey and password/token auth are both provided", async () => {
        await requireSubsonicAuth(
            buildReq({
                u: "alice",
                v: "1.16.1",
                c: "client",
                apiKey: "apikey-secret",
                p: "secret",
            }),
            buildRes(),
            next,
        );

        expect(mockSendError).toHaveBeenCalledWith(
            expect.anything(),
            43,
            "Provide either apiKey or password/token authentication, not both",
            "json",
            undefined,
        );
        expect(next).not.toHaveBeenCalled();
    });
});
