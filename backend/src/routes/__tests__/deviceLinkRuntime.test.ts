jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: any, _res: any, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const prisma = {
    deviceLinkCode: {
        deleteMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
    },
    apiKey: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        delete: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({
    prisma,
}));

import router from "../deviceLink";
import { prisma as prismaClient } from "../../utils/db";

const mockDeviceCodeDeleteMany = prismaClient.deviceLinkCode
    .deleteMany as jest.Mock;
const mockDeviceCodeFindUnique = prismaClient.deviceLinkCode
    .findUnique as jest.Mock;
const mockDeviceCodeCreate = prismaClient.deviceLinkCode.create as jest.Mock;
const mockDeviceCodeUpdate = prismaClient.deviceLinkCode.update as jest.Mock;

const mockApiKeyCreate = prismaClient.apiKey.create as jest.Mock;
const mockApiKeyFindMany = prismaClient.apiKey.findMany as jest.Mock;
const mockApiKeyFindFirst = prismaClient.apiKey.findFirst as jest.Mock;
const mockApiKeyDelete = prismaClient.apiKey.delete as jest.Mock;

function getHandler(
    path: string,
    method: "get" | "post" | "delete",
    stackIndex?: number
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );

    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }

    const resolvedIndex =
        typeof stackIndex === "number"
            ? stackIndex
            : layer.route.stack.length - 1;
    return layer.route.stack[resolvedIndex].handle;
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

describe("deviceLink routes runtime", () => {
    const postGenerate = getHandler("/generate", "post");
    const postVerify = getHandler("/verify", "post");
    const getStatus = getHandler("/status/:code", "get");
    const getDevices = getHandler("/devices", "get");
    const deleteDevice = getHandler("/devices/:id", "delete");

    beforeEach(() => {
        jest.clearAllMocks();

        mockDeviceCodeDeleteMany.mockResolvedValue({ count: 0 });
        mockDeviceCodeFindUnique.mockResolvedValue(null);
        mockDeviceCodeCreate.mockImplementation(async ({ data }: any) => ({
            id: "link-1",
            ...data,
        }));
        mockDeviceCodeUpdate.mockResolvedValue({});

        mockApiKeyCreate.mockResolvedValue({ id: "api-key-1" });
        mockApiKeyFindMany.mockResolvedValue([
            {
                id: "api-key-1",
                name: "Mobile Device",
                lastUsed: null,
                createdAt: new Date("2026-02-17T00:00:00.000Z"),
            },
        ]);
        mockApiKeyFindFirst.mockResolvedValue({ id: "api-key-1" });
        mockApiKeyDelete.mockResolvedValue({ id: "api-key-1" });
    });

    it("generates a unique link code and returns expiry metadata", async () => {
        const req = { user: { id: "u1" } } as any;
        const res = createRes();

        await postGenerate(req, res);

        expect(mockDeviceCodeDeleteMany).toHaveBeenCalledWith({
            where: { userId: "u1", usedAt: null },
        });
        expect(mockDeviceCodeFindUnique).toHaveBeenCalled();
        expect(mockDeviceCodeCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: "u1",
                code: expect.stringMatching(/^[A-Z2-9]{6}$/),
                expiresAt: expect.any(Date),
            }),
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                code: expect.stringMatching(/^[A-Z2-9]{6}$/),
                expiresIn: 300,
                expiresAt: expect.any(Date),
            })
        );
    });

    it("returns 500 when unique-code generation exceeds retry budget", async () => {
        mockDeviceCodeFindUnique.mockResolvedValue({ id: "existing-code" });
        const req = { user: { id: "u1" } } as any;
        const res = createRes();

        await postGenerate(req, res);

        expect(mockDeviceCodeCreate).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to generate unique code" });
    });

    it("returns 500 when generate fails unexpectedly", async () => {
        mockDeviceCodeDeleteMany.mockRejectedValueOnce(new Error("db down"));
        const req = { user: { id: "u1" } } as any;
        const res = createRes();

        await postGenerate(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to generate device link code" });
    });

    it("validates verify payload and handles all code state branches", async () => {
        const missingReq = { body: {} } as any;
        const missingRes = createRes();
        await postVerify(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(400);
        expect(missingRes.body).toEqual({ error: "Code is required" });

        mockDeviceCodeFindUnique.mockResolvedValueOnce(null);
        const notFoundReq = { body: { code: "abc123" } } as any;
        const notFoundRes = createRes();
        await postVerify(notFoundReq, notFoundRes);
        expect(notFoundRes.statusCode).toBe(404);
        expect(notFoundRes.body).toEqual({ error: "Invalid code" });

        mockDeviceCodeFindUnique.mockResolvedValueOnce({
            id: "link-1",
            code: "ABC123",
            userId: "u1",
            usedAt: new Date("2026-02-17T00:00:00.000Z"),
            expiresAt: new Date("2026-02-18T00:00:00.000Z"),
            user: { username: "alice" },
        });
        const usedRes = createRes();
        await postVerify(notFoundReq, usedRes);
        expect(usedRes.statusCode).toBe(400);
        expect(usedRes.body).toEqual({ error: "Code already used" });

        mockDeviceCodeFindUnique.mockResolvedValueOnce({
            id: "link-1",
            code: "ABC123",
            userId: "u1",
            usedAt: null,
            expiresAt: new Date("2026-02-16T00:00:00.000Z"),
            user: { username: "alice" },
        });
        const expiredRes = createRes();
        await postVerify(notFoundReq, expiredRes);
        expect(expiredRes.statusCode).toBe(400);
        expect(expiredRes.body).toEqual({ error: "Code expired" });
    });

    it("verifies code, creates API key, and marks link as used", async () => {
        mockDeviceCodeFindUnique.mockResolvedValueOnce({
            id: "link-1",
            code: "ABC123",
            userId: "u1",
            usedAt: null,
            expiresAt: new Date("2026-12-31T00:00:00.000Z"),
            user: { username: "alice" },
        });

        const req = {
            body: { code: "abc123", deviceName: "Living Room Tablet" },
        } as any;
        const res = createRes();

        await postVerify(req, res);

        expect(mockDeviceCodeFindUnique).toHaveBeenCalledWith({
            where: { code: "ABC123" },
            include: { user: true },
        });
        expect(mockApiKeyCreate).toHaveBeenCalledWith({
            data: {
                userId: "u1",
                key: expect.stringMatching(/^[0-9a-f]{64}$/),
                name: "Living Room Tablet",
            },
        });
        expect(mockDeviceCodeUpdate).toHaveBeenCalledWith({
            where: { id: "link-1" },
            data: expect.objectContaining({
                usedAt: expect.any(Date),
                deviceName: "Living Room Tablet",
                apiKeyId: "api-key-1",
            }),
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            apiKey: expect.stringMatching(/^[0-9a-f]{64}$/),
            userId: "u1",
            username: "alice",
        });
    });

    it("returns 500 on verify exceptions", async () => {
        mockDeviceCodeFindUnique.mockRejectedValueOnce(new Error("db down"));
        const req = { body: { code: "abc123" } } as any;
        const res = createRes();

        await postVerify(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to verify device link code" });
    });

    it("returns code status across pending/used/expired/not-found and handles failures", async () => {
        mockDeviceCodeFindUnique.mockResolvedValueOnce(null);
        const invalidReq = { params: { code: "abc123" } } as any;
        const invalidRes = createRes();
        await getStatus(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(404);
        expect(invalidRes.body).toEqual({ error: "Invalid code" });

        mockDeviceCodeFindUnique.mockResolvedValueOnce({
            id: "link-1",
            code: "ABC123",
            usedAt: null,
            expiresAt: new Date("2026-02-16T00:00:00.000Z"),
        });
        const expiredRes = createRes();
        await getStatus(invalidReq, expiredRes);
        expect(expiredRes.statusCode).toBe(200);
        expect(expiredRes.body).toEqual({
            status: "expired",
            expiresAt: new Date("2026-02-16T00:00:00.000Z"),
        });

        mockDeviceCodeFindUnique.mockResolvedValueOnce({
            id: "link-1",
            code: "ABC123",
            usedAt: new Date("2026-02-17T00:00:00.000Z"),
            deviceName: "Phone",
            expiresAt: new Date("2026-12-31T00:00:00.000Z"),
        });
        const usedRes = createRes();
        await getStatus(invalidReq, usedRes);
        expect(usedRes.statusCode).toBe(200);
        expect(usedRes.body).toEqual({
            status: "used",
            usedAt: new Date("2026-02-17T00:00:00.000Z"),
            deviceName: "Phone",
        });

        mockDeviceCodeFindUnique.mockResolvedValueOnce({
            id: "link-1",
            code: "ABC123",
            usedAt: null,
            expiresAt: new Date("2026-12-31T00:00:00.000Z"),
        });
        const pendingRes = createRes();
        await getStatus(invalidReq, pendingRes);
        expect(pendingRes.statusCode).toBe(200);
        expect(pendingRes.body).toEqual({
            status: "pending",
            expiresAt: new Date("2026-12-31T00:00:00.000Z"),
        });

        mockDeviceCodeFindUnique.mockRejectedValueOnce(new Error("db down"));
        const errorRes = createRes();
        await getStatus(invalidReq, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "Failed to check status" });
    });

    it("lists devices and handles list failure", async () => {
        const req = { user: { id: "u1" } } as any;
        const res = createRes();

        await getDevices(req, res);

        expect(mockApiKeyFindMany).toHaveBeenCalledWith({
            where: { userId: "u1" },
            orderBy: { lastUsed: "desc" },
            select: {
                id: true,
                name: true,
                lastUsed: true,
                createdAt: true,
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ id: "api-key-1", name: "Mobile Device" }),
            ])
        );

        mockApiKeyFindMany.mockRejectedValueOnce(new Error("db down"));
        const errorRes = createRes();
        await getDevices(req, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "Failed to get devices" });
    });

    it("revokes only owned devices and handles missing/error branches", async () => {
        const req = { user: { id: "u1" }, params: { id: "api-key-1" } } as any;
        const res = createRes();

        await deleteDevice(req, res);

        expect(mockApiKeyFindFirst).toHaveBeenCalledWith({
            where: { id: "api-key-1", userId: "u1" },
        });
        expect(mockApiKeyDelete).toHaveBeenCalledWith({
            where: { id: "api-key-1" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true });

        mockApiKeyFindFirst.mockResolvedValueOnce(null);
        const missingRes = createRes();
        await deleteDevice(req, missingRes);
        expect(missingRes.statusCode).toBe(404);
        expect(missingRes.body).toEqual({ error: "Device not found" });

        mockApiKeyFindFirst.mockRejectedValueOnce(new Error("db down"));
        const errorRes = createRes();
        await deleteDevice(req, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "Failed to revoke device" });
    });
});
