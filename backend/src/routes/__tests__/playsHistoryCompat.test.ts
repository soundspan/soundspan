import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        track: {
            findUnique: jest.fn(),
        },
        play: {
            create: jest.fn(),
            findMany: jest.fn(),
            count: jest.fn(),
            deleteMany: jest.fn(),
        },
    },
}));

import router from "../plays";
import { prisma } from "../../utils/db";

const mockTrackFindUnique = prisma.track.findUnique as jest.Mock;
const mockPlayCreate = prisma.play.create as jest.Mock;
const mockPlayFindMany = prisma.play.findMany as jest.Mock;
const mockPlayCount = prisma.play.count as jest.Mock;
const mockPlayDeleteMany = prisma.play.deleteMany as jest.Mock;

function getGetHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.get
    );
    if (!layer) throw new Error(`GET route not found: ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getDeleteHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.delete
    );
    if (!layer) throw new Error(`DELETE route not found: ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getPostHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.post
    );
    if (!layer) throw new Error(`POST route not found: ${path}`);
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

describe("plays history compatibility", () => {
    const summaryHandler = getGetHandler("/summary");
    const clearHistoryHandler = getDeleteHandler("/history");
    const createPlayHandler = getPostHandler("/");
    const listPlaysHandler = getGetHandler("/");

    beforeEach(() => {
        jest.clearAllMocks();
        mockTrackFindUnique.mockResolvedValue({ id: "track-1" });
        mockPlayCreate.mockResolvedValue({
            id: "play-1",
            userId: "user-1",
            trackId: "track-1",
        });
        mockPlayFindMany.mockResolvedValue([]);
    });

    it("returns grouped history counts for summary", async () => {
        mockPlayCount
            .mockResolvedValueOnce(111) // allTime
            .mockResolvedValueOnce(11) // 7d
            .mockResolvedValueOnce(31) // 30d
            .mockResolvedValueOnce(87); // 365d

        const req = {
            session: { userId: "user-1" },
            query: {},
        } as any;
        const res = createRes();

        await summaryHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            allTime: 111,
            last7Days: 11,
            last30Days: 31,
            last365Days: 87,
        });
        expect(mockPlayCount).toHaveBeenCalledTimes(4);
    });

    it("returns 500 when summary query fails", async () => {
        mockPlayCount.mockRejectedValueOnce(new Error("summary failed"));
        const req = { session: { userId: "user-1" }, query: {} } as any;
        const res = createRes();

        await summaryHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get play history summary" });
    });

    it("clears all history when range=all", async () => {
        mockPlayDeleteMany.mockResolvedValue({ count: 55 });

        const req = {
            session: { userId: "user-1" },
            query: { range: "all" },
        } as any;
        const res = createRes();

        await clearHistoryHandler(req, res);

        expect(mockPlayDeleteMany).toHaveBeenCalledWith({
            where: { userId: "user-1" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            range: "all",
            deletedCount: 55,
        });
    });

    it("clears bounded history when range=30d", async () => {
        mockPlayDeleteMany.mockResolvedValue({ count: 22 });

        const req = {
            session: { userId: "user-1" },
            query: { range: "30d" },
        } as any;
        const res = createRes();

        await clearHistoryHandler(req, res);

        expect(mockPlayDeleteMany).toHaveBeenCalledTimes(1);
        expect(mockPlayDeleteMany.mock.calls[0][0].where).toEqual(
            expect.objectContaining({
                userId: "user-1",
                playedAt: expect.objectContaining({
                    gte: expect.any(Date),
                    lte: expect.any(Date),
                }),
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            range: "30d",
            deletedCount: 22,
        });
    });

    it("returns 400 for invalid range", async () => {
        const req = {
            session: { userId: "user-1" },
            query: { range: "bad-range" },
        } as any;
        const res = createRes();

        await clearHistoryHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Invalid range. Expected one of: 7d, 30d, 365d, all",
        });
        expect(mockPlayDeleteMany).not.toHaveBeenCalled();
    });

    it("returns 500 when history clear fails", async () => {
        mockPlayDeleteMany.mockRejectedValueOnce(new Error("delete failed"));
        const req = {
            session: { userId: "user-1" },
            query: { range: "all" },
        } as any;
        const res = createRes();

        await clearHistoryHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to clear play history" });
    });

    it("validates, creates, and fails play-logging requests", async () => {
        const invalidReq = {
            session: { userId: "user-1" },
            body: {},
        } as any;
        const invalidRes = createRes();
        await createPlayHandler(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body.error).toBe("Invalid request");

        mockTrackFindUnique.mockResolvedValueOnce(null);
        const missingReq = {
            session: { userId: "user-1" },
            body: { trackId: "missing-track" },
        } as any;
        const missingRes = createRes();
        await createPlayHandler(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);
        expect(missingRes.body).toEqual({ error: "Track not found" });

        const okReq = {
            session: { userId: "user-1" },
            body: { trackId: "track-1" },
        } as any;
        const okRes = createRes();
        await createPlayHandler(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(mockPlayCreate).toHaveBeenCalledWith({
            data: { userId: "user-1", trackId: "track-1" },
        });

        mockTrackFindUnique.mockRejectedValueOnce(new Error("create failed"));
        const errReq = {
            session: { userId: "user-1" },
            body: { trackId: "track-1" },
        } as any;
        const errRes = createRes();
        await createPlayHandler(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to log play" });
    });

    it("lists recent plays with default/custom limits and handles failures", async () => {
        const defaultReq = {
            session: { userId: "user-1" },
            query: {},
        } as any;
        const defaultRes = createRes();
        await listPlaysHandler(defaultReq, defaultRes);
        expect(defaultRes.statusCode).toBe(200);
        expect(mockPlayFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: "user-1" },
                take: 50,
            })
        );

        const customReq = {
            session: { userId: "user-1" },
            query: { limit: "12" },
        } as any;
        const customRes = createRes();
        await listPlaysHandler(customReq, customRes);
        expect(customRes.statusCode).toBe(200);
        expect(mockPlayFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: "user-1" },
                take: 12,
            })
        );

        mockPlayFindMany.mockRejectedValueOnce(new Error("find failed"));
        const errReq = {
            session: { userId: "user-1" },
            query: {},
        } as any;
        const errRes = createRes();
        await listPlaysHandler(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to get plays" });
    });
});
