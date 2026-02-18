jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: any, _res: any, next: () => void) => next(),
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
    apiKey: {
        create: jest.fn(),
        findMany: jest.fn(),
        deleteMany: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({
    prisma,
}));

import router from "../apiKeys";
import { prisma as prismaClient } from "../../utils/db";

const mockCreateApiKey = prismaClient.apiKey.create as jest.Mock;
const mockFindManyApiKeys = prismaClient.apiKey.findMany as jest.Mock;
const mockDeleteManyApiKeys = prismaClient.apiKey.deleteMany as jest.Mock;

function getHandler(method: "get" | "post" | "delete", path: string) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
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

describe("apiKeys routes runtime", () => {
    const postCreate = getHandler("post", "/");
    const getList = getHandler("get", "/");
    const deleteKey = getHandler("delete", "/:id");

    beforeEach(() => {
        jest.clearAllMocks();

        mockCreateApiKey.mockResolvedValue({
            id: "k1",
            key: "a".repeat(64),
            name: "My Phone",
            createdAt: new Date("2026-02-17T00:00:00.000Z"),
        });
        mockFindManyApiKeys.mockResolvedValue([
            {
                id: "k1",
                name: "My Phone",
                lastUsed: null,
                createdAt: new Date("2026-02-16T00:00:00.000Z"),
            },
        ]);
        mockDeleteManyApiKeys.mockResolvedValue({ count: 1 });
    });

    it("validates create payload and requires authentication identity", async () => {
        const missingNameReq = {
            body: { deviceName: "   " },
            user: { id: "u1" },
        } as any;
        const missingNameRes = createRes();

        await postCreate(missingNameReq, missingNameRes);

        expect(missingNameRes.statusCode).toBe(400);
        expect(missingNameRes.body).toEqual({ error: "Device name is required" });

        const unauthReq = { body: { deviceName: "Phone" } } as any;
        const unauthRes = createRes();

        await postCreate(unauthReq, unauthRes);

        expect(unauthRes.statusCode).toBe(401);
        expect(unauthRes.body).toEqual({ error: "Not authenticated" });
    });

    it("creates a key using session fallback and trims device name", async () => {
        const req = {
            body: { deviceName: "  Tablet  " },
            session: { userId: "session-user" },
        } as any;
        const res = createRes();

        await postCreate(req, res);

        expect(mockCreateApiKey).toHaveBeenCalledWith({
            data: {
                userId: "session-user",
                name: "Tablet",
                key: expect.stringMatching(/^[0-9a-f]{64}$/),
            },
        });
        expect(res.statusCode).toBe(201);
        expect(res.body).toEqual(
            expect.objectContaining({
                apiKey: "a".repeat(64),
                name: "My Phone",
                message:
                    "API key created successfully. Save this key - you won't see it again!",
            })
        );
    });

    it("returns 500 when key creation fails", async () => {
        mockCreateApiKey.mockRejectedValueOnce(new Error("db down"));
        const req = {
            body: { deviceName: "Laptop" },
            user: { id: "u1" },
        } as any;
        const res = createRes();

        await postCreate(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to create API key" });
    });

    it("lists keys for the authenticated user and handles failures", async () => {
        const req = { session: { userId: "session-user" } } as any;
        const res = createRes();

        await getList(req, res);

        expect(mockFindManyApiKeys).toHaveBeenCalledWith({
            where: { userId: "session-user" },
            select: {
                id: true,
                name: true,
                lastUsed: true,
                createdAt: true,
            },
            orderBy: { createdAt: "desc" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            apiKeys: expect.arrayContaining([
                expect.objectContaining({ id: "k1", name: "My Phone" }),
            ]),
        });

        const unauthReq = {} as any;
        const unauthRes = createRes();
        await getList(unauthReq, unauthRes);
        expect(unauthRes.statusCode).toBe(401);
        expect(unauthRes.body).toEqual({ error: "Not authenticated" });

        mockFindManyApiKeys.mockRejectedValueOnce(new Error("db down"));
        const errorReq = { user: { id: "u1" } } as any;
        const errorRes = createRes();
        await getList(errorReq, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "Failed to list API keys" });
    });

    it("deletes owned keys, returns 404 for missing keys, and handles failures", async () => {
        const req = { params: { id: "k1" }, user: { id: "u1" } } as any;
        const res = createRes();

        await deleteKey(req, res);

        expect(mockDeleteManyApiKeys).toHaveBeenCalledWith({
            where: { id: "k1", userId: "u1" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ message: "API key revoked successfully" });

        mockDeleteManyApiKeys.mockResolvedValueOnce({ count: 0 });
        const notFoundRes = createRes();
        await deleteKey(req, notFoundRes);
        expect(notFoundRes.statusCode).toBe(404);
        expect(notFoundRes.body).toEqual({
            error: "API key not found or already deleted",
        });

        const unauthReq = { params: { id: "k1" } } as any;
        const unauthRes = createRes();
        await deleteKey(unauthReq, unauthRes);
        expect(unauthRes.statusCode).toBe(401);
        expect(unauthRes.body).toEqual({ error: "Not authenticated" });

        mockDeleteManyApiKeys.mockRejectedValueOnce(new Error("db down"));
        const errorRes = createRes();
        await deleteKey(req, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "Failed to revoke API key" });
    });
});
