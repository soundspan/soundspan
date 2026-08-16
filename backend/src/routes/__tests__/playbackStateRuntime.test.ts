import express from "express";
import request from "supertest";

jest.mock("../../middleware/rateLimitStore", () => {
    const { MemoryStore } = jest.requireActual("express-rate-limit");
    return {
        createRedisRateLimitOptions: () => ({
            store: new MemoryStore(),
            passOnStoreError: true,
        }),
    };
});

jest.mock("../../middleware/auth", () => ({
    requireAuth: (req: any, _res: any, next: () => void) => {
        req.user ??= { id: "u1" };
        next();
    },
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
import { requireAuth } from "../../middleware/auth";
import { playbackStateLimiter } from "../../middleware/rateLimiter";
import { prisma as prismaClient, Prisma as PrismaClient } from "../../utils/db";

const mockFindUnique = prismaClient.playbackState.findUnique as jest.Mock;
const mockUpsert = prismaClient.playbackState.upsert as jest.Mock;
const mockDeleteMany = prismaClient.playbackState.deleteMany as jest.Mock;

function getHandler(method: "get" | "post" | "delete", path: string) {
    const handlers = getRouteHandlers(method, path);
    return handlers[handlers.length - 1];
}

function getRouteHandlers(method: "get" | "post" | "delete", path: string) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );

    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }

    return layer.route.stack.map((entry: any) => entry.handle);
}

function createRuntimeApp() {
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json());
    app.use("/", router);
    return app;
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

    it("attaches the playback-state limiter before auth on every route", () => {
        for (const method of ["get", "post", "delete"] as const) {
            const handlers = getRouteHandlers(method, "/");
            expect(handlers).toHaveLength(3);
            expect(handlers[0]).toBe(playbackStateLimiter);
            expect(handlers[1]).toBe(requireAuth);
        }
    });

    it("allows the normal four playback-state updates per minute", async () => {
        mockUpsert.mockResolvedValue({ id: "state-normal-cadence" });
        const app = createRuntimeApp();
        const statuses: number[] = [];

        for (let update = 0; update < 4; update += 1) {
            const response = await request(app)
                .post("/")
                .set("X-Forwarded-For", "198.51.100.10")
                .send({
                    playbackType: "track",
                    trackId: "track-1",
                    currentTime: update * 15,
                });
            statuses.push(response.status);
        }

        expect(statuses).toEqual([200, 200, 200, 200]);
        expect(mockUpsert).toHaveBeenCalledTimes(4);
    });

    it("returns 429 at the finite playback-state request boundary", async () => {
        mockFindUnique.mockResolvedValue({ id: "state-rate-boundary" });
        const app = createRuntimeApp();

        for (let requestCount = 1; requestCount <= 600; requestCount += 1) {
            const response = await request(app)
                .get("/")
                .set("X-Forwarded-For", "198.51.100.11");
            expect(response.status).toBe(200);
        }

        const limitedResponse = await request(app)
            .get("/")
            .set("X-Forwarded-For", "198.51.100.11");

        expect(limitedResponse.status).toBe(429);
        expect(mockFindUnique).toHaveBeenCalledTimes(600);
    }, 30_000);

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
            }),
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
            isPlaying: false,
            currentTime: 45,
        };

        mockFindUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(legacyState);
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
                queue: (PrismaClient as any).DbNull,
                currentIndex: 1,
                isPlaying: false,
                currentTime: 45,
            }),
            create: expect.objectContaining({
                userId: "u1",
                deviceId: "mobile",
                isPlaying: false,
                queue: (PrismaClient as any).DbNull,
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
            "[PlaybackState] Invalid playbackType: video",
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
                        streamSource: "youtube",
                        youtubeVideoId: "yt-123",
                        artist: { id: "a1", name: "Artist A" },
                        album: {
                            id: "al1",
                            title: "Album A",
                            coverArt: "/img/a.jpg",
                        },
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
                isPlaying: true,
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
                    expect.objectContaining({
                        id: "t1",
                        duration: 215,
                        mediaSource: "youtube",
                        streamSource: "youtube",
                        youtubeVideoId: "yt-123",
                        provider: expect.objectContaining({
                            source: "youtube",
                            providerTrackId: "yt-123",
                        }),
                    }),
                    expect.objectContaining({ id: "t2", duration: 180 }),
                ],
                currentIndex: 1,
                currentTime: 0,
                isShuffle: true,
                isPlaying: true,
            }),
            create: expect.objectContaining({
                userId: "u1",
                deviceId: "legacy",
                isPlaying: true,
                queue: [
                    expect.objectContaining({
                        id: "t1",
                        mediaSource: "youtube",
                        provider: expect.objectContaining({
                            source: "youtube",
                            providerTrackId: "yt-123",
                        }),
                    }),
                    expect.objectContaining({ id: "t2" }),
                ],
            }),
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "state-2",
                playbackType: "track",
            }),
        );
    });

    it("round-trips youtube-direct queue items with their audio format", async () => {
        mockUpsert.mockResolvedValueOnce({
            id: "state-yt-direct",
            userId: "u1",
            deviceId: "desktop",
            playbackType: "track",
        });

        const req = {
            user: { id: "u1" },
            header: () => "desktop",
            body: {
                playbackType: "track",
                trackId: "yt-dQw4w9WgXcQ",
                queue: [
                    {
                        id: "yt-dQw4w9WgXcQ",
                        title: "Some DJ Set",
                        duration: 7200,
                        streamSource: "youtube-direct",
                        youtubeVideoId: "dQw4w9WgXcQ",
                        youtubeAudioFormat: "webm",
                        artist: { name: "Uploader" },
                        album: { title: "YouTube" },
                    },
                ],
                currentIndex: 0,
            },
        } as any;
        const res = createRes();

        await postState(req, res);

        expect(mockUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: expect.objectContaining({
                    queue: [
                        expect.objectContaining({
                            id: "yt-dQw4w9WgXcQ",
                            mediaSource: "youtube-direct",
                            streamSource: "youtube-direct",
                            youtubeVideoId: "dQw4w9WgXcQ",
                            youtubeAudioFormat: "webm",
                            provider: expect.objectContaining({
                                source: "youtube-direct",
                                providerTrackId: "dQw4w9WgXcQ",
                                youtubeVideoId: "dQw4w9WgXcQ",
                                youtubeAudioFormat: "webm",
                            }),
                        }),
                    ],
                }),
            }),
        );
        expect(res.statusCode).toBe(200);
    });

    it("passes through podcast episode queue items and defaults tracks to itemType track", async () => {
        mockUpsert.mockResolvedValueOnce({
            id: "state-mixed",
            userId: "u1",
            deviceId: "legacy",
            playbackType: "podcast",
        });

        const req = {
            user: { id: "u1" },
            header: () => "",
            body: {
                playbackType: "podcast",
                podcastId: "pod-1:ep-1",
                queue: [
                    {
                        itemType: "episode",
                        id: "pod-1:ep-1",
                        title: "Episode One",
                        podcastTitle: "My Podcast",
                        podcastId: "pod-1",
                        episodeId: "ep-1",
                        coverUrl: "/covers/pod.jpg",
                        duration: "3600",
                        description: "should be stripped",
                    },
                    {
                        // Derives podcastId/episodeId from the composite id.
                        itemType: "episode",
                        id: "pod-2:ep-9",
                        title: "Episode Nine",
                        duration: 120,
                    },
                    {
                        id: "t1",
                        title: "Queued Track",
                        duration: 200,
                        artist: { id: "a1", name: "Artist A" },
                        album: { id: "al1", title: "Album A", coverArt: null },
                    },
                ],
                currentIndex: 0,
            },
        } as any;
        const res = createRes();

        await postState(req, res);

        const savedQueue = mockUpsert.mock.calls[0][0].update.queue;
        expect(savedQueue).toHaveLength(3);
        expect(savedQueue[0]).toEqual({
            itemType: "episode",
            id: "pod-1:ep-1",
            title: "Episode One",
            podcastTitle: "My Podcast",
            podcastId: "pod-1",
            episodeId: "ep-1",
            coverUrl: "/covers/pod.jpg",
            duration: 3600,
        });
        expect(savedQueue[1]).toEqual(
            expect.objectContaining({
                itemType: "episode",
                podcastId: "pod-2",
                episodeId: "ep-9",
                coverUrl: null,
            }),
        );
        expect(savedQueue[2]).toEqual(
            expect.objectContaining({
                itemType: "track",
                id: "t1",
                title: "Queued Track",
            }),
        );
        expect(res.statusCode).toBe(200);
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
        expect(mockUpsert.mock.calls[0][0].update.queue).toBe(
            (PrismaClient as any).DbNull,
        );
        expect(res.statusCode).toBe(200);
    });

    it("does not overwrite persisted play intent when isPlaying is omitted", async () => {
        mockUpsert.mockResolvedValueOnce({ id: "state-4" });

        const req = {
            user: { id: "u1" },
            header: () => "desktop",
            body: {
                playbackType: "track",
                trackId: "track-77",
            },
        } as any;
        const res = createRes();

        await postState(req, res);

        expect(mockUpsert.mock.calls[0][0].update).toEqual(
            expect.not.objectContaining({ isPlaying: expect.anything() }),
        );
        expect(mockUpsert.mock.calls[0][0].update).toEqual(
            expect.not.objectContaining({
                queue: expect.anything(),
                currentIndex: expect.anything(),
                isShuffle: expect.anything(),
                currentTime: expect.anything(),
            }),
        );
        expect(mockUpsert.mock.calls[0][0].create.isPlaying).toBe(false);
        expect(mockUpsert.mock.calls[0][0].create.currentTime).toBe(0);
        expect(mockUpsert.mock.calls[0][0].create.currentIndex).toBe(0);
        expect(mockUpsert.mock.calls[0][0].create.queue).toBe(
            (PrismaClient as any).DbNull,
        );
        expect(res.statusCode).toBe(200);
    });

    it("returns a sanitized 500 when save fails", async () => {
        mockUpsert.mockRejectedValueOnce(new Error("write failed"));

        const req = {
            user: { id: "u1" },
            header: () => "dev",
            body: { playbackType: "track", trackId: "t1" },
        } as any;
        const res = createRes();

        await postState(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to save playback state" });
        expect(JSON.stringify(res.body)).not.toContain("write failed");
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
            where: { userId: "u1", deviceId: { in: ["mobile", "legacy"] } },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ success: true });

        mockDeleteMany.mockRejectedValueOnce(new Error("delete failed"));
        const errorRes = createRes();
        await deleteState(req, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({
            error: "Failed to delete playback state",
        });
    });
});
