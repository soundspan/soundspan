jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: any, _res: any, next: () => void) => next(),
}));

const mockLoggerWarn = jest.fn();
const mockLoggerError = jest.fn();
jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: (...args: unknown[]) => mockLoggerWarn(...args),
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));

const prisma = {
    playbackState: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
    },
};

const Prisma = {
    DbNull: { __dbNull: true },
};

jest.mock("../../utils/db", () => ({
    prisma,
    Prisma,
}));

import router from "../playbackState";
import { prisma as prismaClient, Prisma as PrismaClient } from "../../utils/db";

const mockFindUnique = prismaClient.playbackState.findUnique as jest.Mock;
const mockUpsert = prismaClient.playbackState.upsert as jest.Mock;
const mockDeleteMany = prismaClient.playbackState.deleteMany as jest.Mock;

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

describe("playbackState routes runtime", () => {
    const getState = getHandler("get", "/");
    const postState = getHandler("post", "/");
    const deleteState = getHandler("delete", "/");

    beforeEach(() => {
        jest.clearAllMocks();
        mockFindUnique.mockReset();
        mockUpsert.mockReset();
        mockDeleteMany.mockReset();
    });

    it("gets state for a device-specific record", async () => {
        mockFindUnique.mockResolvedValueOnce({
            id: "state-1",
            userId: "u1",
            deviceId: "device-A",
            playbackType: "track",
        });

        const req = {
            user: { id: "u1" },
            header: (name: string) =>
                name === "X-Playback-Device-Id" ? "  device-A  " : undefined,
        } as any;
        const res = createRes();

        await getState(req, res);

        expect(mockFindUnique).toHaveBeenCalledWith({
            where: { userId_deviceId: { userId: "u1", deviceId: "device-A" } },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "state-1",
                playbackType: "track",
            })
        );
    });

    it("falls back to legacy state and migrates it for non-legacy devices", async () => {
        const legacyState = {
            id: "legacy-state",
            userId: "u1",
            deviceId: "legacy",
            playbackType: "podcast",
            trackId: null,
            audiobookId: null,
            podcastId: "pod-1",
            queue: null,
            currentIndex: 1,
            isShuffle: false,
            currentTime: 45,
        };

        mockFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(legacyState);
        mockUpsert.mockResolvedValueOnce({ id: "migrated" });

        const req = {
            user: { id: "u1" },
            header: () => "mobile",
        } as any;
        const res = createRes();

        await getState(req, res);

        expect(mockFindUnique).toHaveBeenNthCalledWith(1, {
            where: { userId_deviceId: { userId: "u1", deviceId: "mobile" } },
        });
        expect(mockFindUnique).toHaveBeenNthCalledWith(2, {
            where: { userId_deviceId: { userId: "u1", deviceId: "legacy" } },
        });
        expect(mockUpsert).toHaveBeenCalledWith({
            where: { userId_deviceId: { userId: "u1", deviceId: "mobile" } },
            update: expect.objectContaining({
                playbackType: "podcast",
                queue: PrismaClient.DbNull,
                currentIndex: 1,
                currentTime: 45,
            }),
            create: expect.objectContaining({
                userId: "u1",
                deviceId: "mobile",
                queue: PrismaClient.DbNull,
            }),
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe(legacyState);
    });

    it("returns null when neither device nor legacy state exists", async () => {
        mockFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

        const req = {
            user: { id: "u1" },
            header: () => "",
        } as any;
        const res = createRes();

        await getState(req, res);

        expect(mockFindUnique).toHaveBeenCalledTimes(2);
        expect(mockUpsert).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toBeNull();
    });

    it("returns 500 when get state fails", async () => {
        mockFindUnique.mockRejectedValueOnce(new Error("db down"));

        const req = {
            user: { id: "u1" },
            header: () => "device-1",
        } as any;
        const res = createRes();

        await getState(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get playback state" });
    });

    it("validates playbackType and rejects invalid values", async () => {
        const missingReq = {
            user: { id: "u1" },
            header: () => "d1",
            body: {},
        } as any;
        const missingRes = createRes();
        await postState(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(400);
        expect(missingRes.body).toEqual({ error: "playbackType is required" });

        const invalidReq = {
            user: { id: "u1" },
            header: () => "d1",
            body: { playbackType: "video" },
        } as any;
        const invalidRes = createRes();
        await postState(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({ error: "Invalid playbackType" });
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "[PlaybackState] Invalid playbackType: video"
        );
    });

    it("sanitizes queue payload and upserts bounded values", async () => {
        mockUpsert.mockResolvedValueOnce({
            id: "state-2",
            userId: "u1",
            deviceId: "legacy",
            playbackType: "track",
        });

        const req = {
            user: { id: "u1" },
            header: () => "   ",
            body: {
                playbackType: "track",
                trackId: "track-1",
                queue: [
                    {
                        id: "t1",
                        title: "First Track",
                        duration: "215",
                        artist: { id: "a1", name: "Artist A" },
                        album: { id: "al1", title: "Album A", coverArt: "/img/a.jpg" },
                    },
                    null,
                    { title: "missing id" },
                    {
                        id: "t2",
                        title: "Second Track",
                        duration: 180,
                        artist: null,
                        album: null,
                    },
                ],
                currentIndex: 999,
                currentTime: -25,
                isShuffle: true,
            },
        } as any;
        const res = createRes();

        await postState(req, res);

        expect(mockUpsert).toHaveBeenCalledWith({
            where: { userId_deviceId: { userId: "u1", deviceId: "legacy" } },
            update: expect.objectContaining({
                playbackType: "track",
                trackId: "track-1",
                queue: [
                    expect.objectContaining({ id: "t1", duration: 215 }),
                    expect.objectContaining({ id: "t2", duration: 180 }),
                ],
                currentIndex: 1,
                currentTime: 0,
                isShuffle: true,
            }),
            create: expect.objectContaining({
                userId: "u1",
                deviceId: "legacy",
                queue: [
                    expect.objectContaining({ id: "t1" }),
                    expect.objectContaining({ id: "t2" }),
                ],
            }),
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "state-2",
                playbackType: "track",
            })
        );
    });

    it("falls back to DbNull when queue sanitization throws", async () => {
        mockUpsert.mockResolvedValueOnce({ id: "state-3" });

        const badItem: any = {};
        Object.defineProperty(badItem, "id", {
            get() {
                throw new Error("bad getter");
            },
        });

        const req = {
            user: { id: "u1" },
            header: () =>
                "device-id-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            body: {
                playbackType: "podcast",
                podcastId: "pod-9",
                queue: [badItem],
            },
        } as any;
        const res = createRes();

        await postState(req, res);

        const whereArg = mockUpsert.mock.calls[0][0].where;
        expect(whereArg.userId_deviceId.deviceId).toHaveLength(128);
        expect(mockUpsert.mock.calls[0][0].update.queue).toBe(PrismaClient.DbNull);
        expect(res.statusCode).toBe(200);
    });

    it("returns 500 with details when save fails", async () => {
        mockUpsert.mockRejectedValueOnce(new Error("write failed"));

        const req = {
            user: { id: "u1" },
            header: () => "dev",
            body: { playbackType: "track", trackId: "t1" },
        } as any;
        const res = createRes();

        await postState(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Internal server error",
            details: "write failed",
        });
    });

    it("deletes state for the current device and handles failures", async () => {
        mockDeleteMany.mockResolvedValueOnce({ count: 1 });
        const req = {
            user: { id: "u1" },
            header: () => "mobile",
        } as any;
        const res = createRes();

        await deleteState(req, res);

        expect(mockDeleteMany).toHaveBeenCalledWith({
            where: { userId: "u1", deviceId: "mobile" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true });

        mockDeleteMany.mockRejectedValueOnce(new Error("delete failed"));
        const errorRes = createRes();
        await deleteState(req, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "Failed to delete playback state" });
    });
});
