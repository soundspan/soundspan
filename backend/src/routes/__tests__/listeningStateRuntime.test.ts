// requireAuth populates req.user (never req.session) — this mock mirrors that
// so tests exercise the same request shape a real authenticated client
// produces. Unused by the getHandler-extraction calls below (they bypass
// router.use middleware entirely), kept accurate so it isn't misleading.
jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: () => void) => {
        req.user = { id: "u1", username: "u1", role: "user" };
        next();
    },
}));

const mockLoggerError = jest.fn();
jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

const prisma = {
    listeningState: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({
    prisma,
}));

import router from "../listeningState";
import { prisma as prismaClient } from "../../utils/db";

const mockUpsert = prismaClient.listeningState.upsert as jest.Mock;
const mockFindUnique = prismaClient.listeningState.findUnique as jest.Mock;
const mockFindMany = prismaClient.listeningState.findMany as jest.Mock;

function getHandler(method: "get" | "post", path: string) {
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

describe("listeningState routes runtime", () => {
    const postState = getHandler("post", "/");
    const getState = getHandler("get", "/");
    const getRecent = getHandler("get", "/recent");

    beforeEach(() => {
        jest.clearAllMocks();

        mockUpsert.mockResolvedValue({
            id: "state-1",
            userId: "u1",
            kind: "music",
            entityId: "album-1",
            trackId: "track-1",
            positionMs: 30000,
        });
        mockFindUnique.mockResolvedValue({
            id: "state-1",
            userId: "u1",
            kind: "music",
            entityId: "album-1",
            trackId: "track-1",
            positionMs: 30000,
        });
        mockFindMany.mockResolvedValue([
            { id: "state-1", updatedAt: new Date("2026-02-17T00:00:00.000Z") },
        ]);
    });

    it("validates payload for POST / and returns zod details", async () => {
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            body: { kind: "music", entityId: "album-1", positionMs: -1 },
        } as any;
        const res = createRes();

        await postState(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Invalid request",
            details: expect.any(Array),
        });
        expect(mockUpsert).not.toHaveBeenCalled();
    });

    it("upserts listening state for authenticated session user", async () => {
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            body: {
                kind: "music",
                entityId: "album-1",
                trackId: "track-1",
                positionMs: 30000,
            },
        } as any;
        const res = createRes();

        await postState(req, res);

        expect(mockUpsert).toHaveBeenCalledWith({
            where: {
                userId_kind_entityId: {
                    userId: "u1",
                    kind: "music",
                    entityId: "album-1",
                },
            },
            create: {
                userId: "u1",
                kind: "music",
                entityId: "album-1",
                trackId: "track-1",
                positionMs: 30000,
            },
            update: {
                trackId: "track-1",
                positionMs: 30000,
                updatedAt: expect.any(Date),
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "state-1",
                userId: "u1",
                kind: "music",
            })
        );
    });

    it("returns 500 for unexpected POST errors", async () => {
        mockUpsert.mockRejectedValueOnce(new Error("db down"));
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            body: {
                kind: "music",
                entityId: "album-1",
                positionMs: 30000,
            },
        } as any;
        const res = createRes();

        await postState(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to update listening state" });
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Update listening state error:",
            expect.any(Error)
        );
    });

    it("requires kind/entityId for GET / and handles missing/not-found/success", async () => {
        const missingReq = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            query: {},
        } as any;
        const missingRes = createRes();

        await getState(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(400);
        expect(missingRes.body).toEqual({ error: "kind and entityId required" });

        mockFindUnique.mockResolvedValueOnce(null);
        const notFoundReq = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            query: { kind: "music", entityId: "album-1" },
        } as any;
        const notFoundRes = createRes();
        await getState(notFoundReq, notFoundRes);
        expect(notFoundRes.statusCode).toBe(404);
        expect(notFoundRes.body).toEqual({ error: "No listening state found" });

        const okRes = createRes();
        await getState(notFoundReq, okRes);
        expect(mockFindUnique).toHaveBeenCalledWith({
            where: {
                userId_kind_entityId: {
                    userId: "u1",
                    kind: "music",
                    entityId: "album-1",
                },
            },
        });
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual(
            expect.objectContaining({
                id: "state-1",
                entityId: "album-1",
            })
        );
    });

    it("returns 500 on GET / query failures", async () => {
        mockFindUnique.mockRejectedValueOnce(new Error("db down"));
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            query: { kind: "music", entityId: "album-1" },
        } as any;
        const res = createRes();

        await getState(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get listening state" });
    });

    it("returns recent listening states with default and explicit limits", async () => {
        const defaultReq = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            query: {},
        } as any;
        const defaultRes = createRes();
        await getRecent(defaultReq, defaultRes);
        expect(mockFindMany).toHaveBeenCalledWith({
            where: { userId: "u1" },
            orderBy: { updatedAt: "desc" },
            take: 10,
        });
        expect(defaultRes.statusCode).toBe(200);
        expect(defaultRes.body).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: "state-1" })])
        );

        const customReq = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            query: { limit: "3" },
        } as any;
        const customRes = createRes();
        await getRecent(customReq, customRes);
        expect(mockFindMany).toHaveBeenLastCalledWith({
            where: { userId: "u1" },
            orderBy: { updatedAt: "desc" },
            take: 3,
        });
        expect(customRes.statusCode).toBe(200);
    });

    it("scopes /recent to the authenticated user, not a hardcoded id", async () => {
        // Regression guard for the req.session.userId! bug (roadmap F11 step 1):
        // a second, differently-authenticated user must see their OWN userId
        // reach Prisma, proving userId is read from req.user and not stale
        // session state or a copy-pasted literal.
        const otherUserReq = {
            session: {},
            user: { id: "u2", username: "u2", role: "user" },
            query: {},
        } as any;
        const res = createRes();

        await getRecent(otherUserReq, res);

        expect(mockFindMany).toHaveBeenCalledWith({
            where: { userId: "u2" },
            orderBy: { updatedAt: "desc" },
            take: 10,
        });
    });

    it("returns 500 when recent state query fails", async () => {
        mockFindMany.mockRejectedValueOnce(new Error("db down"));
        const req = {
            session: {},
            user: { id: "u1", username: "u1", role: "user" },
            query: {},
        } as any;
        const res = createRes();

        await getRecent(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to get recent listening states",
        });
    });
});
