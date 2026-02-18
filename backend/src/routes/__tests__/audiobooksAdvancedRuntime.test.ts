import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (
        _req: Request,
        _res: Response,
        next: () => void
    ) => next(),
}));

jest.mock("../../middleware/rateLimiter", () => ({
    apiLimiter: (_req: Request, _res: Response, next: () => void) => next(),
    imageLimiter: (_req: Request, _res: Response, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/music",
        },
    },
}));

const fsExistsSync = jest.fn();
jest.mock("fs", () => ({
    existsSync: (...args: unknown[]) => fsExistsSync(...args),
}));

const audiobookshelfService = {
    getAllAudiobooks: jest.fn(),
    getAudiobook: jest.fn(),
    searchAudiobooks: jest.fn(),
    streamAudiobook: jest.fn(),
    updateProgress: jest.fn(),
};
jest.mock("../../services/audiobookshelf", () => ({
    audiobookshelfService,
}));

const audiobookCacheService = {
    syncAll: jest.fn(),
    getAudiobook: jest.fn(),
};
jest.mock("../../services/audiobookCache", () => ({
    audiobookCacheService,
}));

const getSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings,
}));

const prisma = {
    audiobook: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
    },
    audiobookProgress: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        upsert: jest.fn(),
        deleteMany: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({
    prisma,
}));

const mockFetch = jest.fn();
(global as any).fetch = (...args: unknown[]) => mockFetch(...args);

import router from "../audiobooks";

function getHandler(path: string, method: "get" | "post" | "delete" | "options") {
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
    const eventHandlers: Record<string, (...args: unknown[]) => void> = {};
    const res: any = {
        statusCode: 200,
        headersSent: false,
        body: undefined as unknown,
        headers: {} as Record<string, string>,
        sentFilePath: undefined as string | undefined,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            res.headersSent = true;
            return res;
        }),
        send: jest.fn(function (payload: unknown) {
            res.body = payload;
            res.headersSent = true;
            return res;
        }),
        sendFile: jest.fn(function (filePath: string) {
            res.sentFilePath = filePath;
            res.headersSent = true;
            return res;
        }),
        setHeader: jest.fn(function (key: string, value: string) {
            res.headers[key] = value;
            return res;
        }),
        end: jest.fn(function () {
            res.headersSent = true;
            return res;
        }),
        on: jest.fn(function (event: string, handler: (...args: unknown[]) => void) {
            eventHandlers[event] = handler;
            return res;
        }),
        emit: (event: string, ...args: unknown[]) => {
            if (eventHandlers[event]) {
                eventHandlers[event](...args);
            }
        },
    };
    return res;
}

function createMockStream() {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const stream: any = {
        destroyed: false,
        pipe: jest.fn(),
        destroy: jest.fn(() => {
            stream.destroyed = true;
        }),
        on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
            handlers[event] = handler;
            return stream;
        }),
        emit: (event: string, ...args: unknown[]) => {
            if (handlers[event]) {
                handlers[event](...args);
            }
        },
    };
    return stream;
}

describe("audiobooks advanced runtime", () => {
    const debugSeriesHandler = getHandler("/debug-series", "get");
    const coverOptionsHandler = getHandler("/:id/cover", "options");
    const coverHandler = getHandler("/:id/cover", "get");
    const detailsHandler = getHandler("/:id", "get");
    const streamHandler = getHandler("/:id/stream", "get");
    const progressHandler = getHandler("/:id/progress", "post");
    const deleteProgressHandler = getHandler("/:id/progress", "delete");
    const searchHandler = getHandler("/search", "get");
    const listHandler = getHandler("/", "get");
    const seriesHandler = getHandler("/series/:seriesName", "get");

    beforeEach(() => {
        jest.clearAllMocks();

        getSystemSettings.mockResolvedValue({
            audiobookshelfEnabled: true,
            audiobookshelfUrl: "http://audiobookshelf.local/",
            audiobookshelfApiKey: "abs-token",
        });

        prisma.audiobook.findMany.mockResolvedValue([]);
        prisma.audiobook.findUnique.mockResolvedValue(null);
        prisma.audiobook.update.mockResolvedValue({});
        prisma.audiobookProgress.findMany.mockResolvedValue([]);
        prisma.audiobookProgress.findUnique.mockResolvedValue(null);
        prisma.audiobookProgress.upsert.mockResolvedValue({
            currentTime: 0,
            duration: 0,
            isFinished: false,
        });
        prisma.audiobookProgress.deleteMany.mockResolvedValue({ count: 1 });

        audiobookshelfService.getAllAudiobooks.mockResolvedValue([]);
        audiobookshelfService.getAudiobook.mockResolvedValue({
            media: { chapters: [], audioFiles: [] },
        });
        audiobookshelfService.searchAudiobooks.mockResolvedValue([]);
        audiobookshelfService.updateProgress.mockResolvedValue(undefined);
        audiobookCacheService.getAudiobook.mockResolvedValue(null);

        fsExistsSync.mockReturnValue(false);
        mockFetch.mockReset();
    });

    it("handles debug-series disabled, success, and failure branches", async () => {
        getSystemSettings.mockResolvedValueOnce({ audiobookshelfEnabled: false });

        const disabledRes = createRes();
        await debugSeriesHandler({ user: { id: "u1" } } as any, disabledRes);
        expect(disabledRes.statusCode).toBe(400);
        expect(disabledRes.body).toEqual({ error: "Audiobookshelf not enabled" });

        audiobookshelfService.getAllAudiobooks.mockResolvedValueOnce([
            {
                id: "b1",
                title: "Book One",
                media: {
                    metadata: {
                        title: "Book One",
                        series: [{ name: "Series A", sequence: "1" }],
                        seriesName: "Series A",
                        seriesSequence: "1",
                    },
                },
            },
            {
                id: "b2",
                title: "Book Two",
                media: {
                    metadata: {
                        title: "Book Two",
                    },
                },
            },
        ]);

        const successRes = createRes();
        await debugSeriesHandler({ user: { id: "u1" } } as any, successRes);
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual(
            expect.objectContaining({
                totalBooks: 2,
                booksWithSeriesCount: 1,
                fullSampleWithSeries: {
                    id: "b1",
                    media: expect.any(Object),
                },
            })
        );

        audiobookshelfService.getAllAudiobooks.mockRejectedValueOnce(
            new Error("debug fetch failed")
        );
        const errorRes = createRes();
        await debugSeriesHandler({ user: { id: "u1" } } as any, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "debug fetch failed" });
    });

    it("serves OPTIONS preflight for cover endpoint", async () => {
        const req = { params: { id: "book-1" }, headers: { origin: "https://app.example" } } as any;
        const res = createRes();

        await coverOptionsHandler(req, res);

        expect(res.statusCode).toBe(204);
        expect(res.headers["Access-Control-Allow-Origin"]).toBe("https://app.example");
        expect(res.headers["Access-Control-Allow-Credentials"]).toBe("true");
        expect(res.headers["Access-Control-Allow-Methods"]).toBe("GET, OPTIONS");
        expect(res.end).toHaveBeenCalled();
    });

    it("serves local cover paths and fallback disk covers", async () => {
        prisma.audiobook.findUnique
            .mockResolvedValueOnce({ localCoverPath: "/cache/book-1.jpg", coverUrl: null })
            .mockResolvedValueOnce({ localCoverPath: null, coverUrl: null });

        fsExistsSync.mockImplementation((targetPath: string) =>
            targetPath === "/cache/book-1.jpg" ||
            targetPath === "/music/cover-cache/audiobooks/book-2.jpg"
        );

        const localRes = createRes();
        await coverHandler(
            { params: { id: "book-1" }, headers: { origin: "https://app.example" } } as any,
            localRes
        );
        expect(localRes.statusCode).toBe(200);
        expect(localRes.sentFilePath).toBe("/cache/book-1.jpg");
        expect(localRes.headers["Cache-Control"]).toBe(
            "public, max-age=31536000, immutable"
        );

        const fallbackRes = createRes();
        await coverHandler(
            { params: { id: "book-2" }, headers: {} } as any,
            fallbackRes
        );

        expect(prisma.audiobook.update).toHaveBeenCalledWith({
            where: { id: "book-2" },
            data: { localCoverPath: "/music/cover-cache/audiobooks/book-2.jpg" },
        });
        expect(fallbackRes.sentFilePath).toBe("/music/cover-cache/audiobooks/book-2.jpg");
    });

    it("proxies cover from audiobookshelf and handles proxy miss/error", async () => {
        prisma.audiobook.findUnique
            .mockResolvedValueOnce({ localCoverPath: null, coverUrl: "items/covers/book-3.jpg" })
            .mockResolvedValueOnce({ localCoverPath: null, coverUrl: "items/covers/book-4.jpg" })
            .mockResolvedValueOnce({ localCoverPath: null, coverUrl: null });

        mockFetch.mockResolvedValueOnce({
            ok: true,
            headers: {
                get: jest.fn().mockReturnValue("image/png"),
            },
            arrayBuffer: jest
                .fn()
                .mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
        });

        const proxyRes = createRes();
        await coverHandler(
            { params: { id: "book-3" }, headers: { origin: "https://app.example" } } as any,
            proxyRes
        );

        expect(mockFetch).toHaveBeenCalledWith(
            "http://audiobookshelf.local/api/items/covers/book-3.jpg",
            {
                headers: {
                    Authorization: "Bearer abs-token",
                },
            }
        );
        expect(proxyRes.statusCode).toBe(200);
        expect(proxyRes.body).toEqual(Buffer.from([1, 2, 3]));
        expect(proxyRes.headers["Content-Type"]).toBe("image/png");
        expect(proxyRes.headers["Cache-Control"]).toBe("public, max-age=86400");

        mockFetch.mockRejectedValueOnce(new Error("proxy down"));
        const proxyMissRes = createRes();
        await coverHandler({ params: { id: "book-4" }, headers: {} } as any, proxyMissRes);
        expect(proxyMissRes.statusCode).toBe(404);
        expect(proxyMissRes.body).toEqual({ error: "Cover not found" });

        const noCoverRes = createRes();
        await coverHandler({ params: { id: "book-5" }, headers: {} } as any, noCoverRes);
        expect(noCoverRes.statusCode).toBe(404);
        expect(noCoverRes.body).toEqual({ error: "Cover not found" });
    });

    it("returns 500 when cover lookup throws unexpectedly", async () => {
        prisma.audiobook.findUnique.mockRejectedValueOnce(new Error("cover db failed"));

        const res = createRes();
        await coverHandler({ params: { id: "book-err" }, headers: {} } as any, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to serve cover",
            message: "cover db failed",
        });
    });

    it("serves audiobook details from cache/fallback and handles missing/error states", async () => {
        getSystemSettings.mockResolvedValueOnce({ audiobookshelfEnabled: false });
        const disabledRes = createRes();
        await detailsHandler(
            { params: { id: "book-1" }, user: { id: "u1" } } as any,
            disabledRes
        );
        expect(disabledRes.statusCode).toBe(200);
        expect(disabledRes.body).toEqual({ configured: false, enabled: false });

        const playedAt = new Date("2026-01-18T10:00:00.000Z");
        prisma.audiobook.findUnique.mockResolvedValueOnce({
            id: "book-1",
            title: "Cached Title",
            author: null,
            narrator: "Narrator",
            description: "Desc",
            localCoverPath: "/cache/book-1.jpg",
            coverUrl: null,
            duration: 200,
            libraryId: "lib-1",
            lastSyncedAt: new Date(),
        });
        audiobookshelfService.getAudiobook.mockResolvedValueOnce({
            media: {
                chapters: [{ id: 1 }],
                audioFiles: [{ ino: "file-1" }],
            },
        });
        prisma.audiobookProgress.findUnique.mockResolvedValueOnce({
            currentTime: 50,
            duration: 200,
            isFinished: false,
            lastPlayedAt: playedAt,
        });

        const detailRes = createRes();
        await detailsHandler(
            { params: { id: "book-1" }, user: { id: "u1" } } as any,
            detailRes
        );

        expect(audiobookCacheService.getAudiobook).not.toHaveBeenCalled();
        expect(detailRes.statusCode).toBe(200);
        expect(detailRes.body).toEqual(
            expect.objectContaining({
                id: "book-1",
                author: "Unknown Author",
                coverUrl: "/audiobooks/book-1/cover",
                chapters: [{ id: 1 }],
                audioFiles: [{ ino: "file-1" }],
                progress: {
                    currentTime: 50,
                    progress: 25,
                    isFinished: false,
                    lastPlayedAt: playedAt,
                },
            })
        );

        prisma.audiobook.findUnique.mockResolvedValueOnce({
            id: "book-2",
            title: "Stale",
            author: "Author",
            narrator: null,
            description: null,
            localCoverPath: null,
            coverUrl: null,
            duration: null,
            libraryId: "lib-2",
            lastSyncedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
        });
        audiobookCacheService.getAudiobook.mockResolvedValueOnce({
            id: "book-2",
            title: "Refetched",
            author: "Author",
            narrator: null,
            description: null,
            localCoverPath: null,
            coverUrl: null,
            duration: 0,
            libraryId: "lib-2",
        });
        audiobookshelfService.getAudiobook.mockRejectedValueOnce(
            new Error("api unavailable")
        );
        prisma.audiobookProgress.findUnique.mockResolvedValueOnce(null);

        const staleRes = createRes();
        await detailsHandler(
            { params: { id: "book-2" }, user: { id: "u1" } } as any,
            staleRes
        );

        expect(audiobookCacheService.getAudiobook).toHaveBeenCalledWith("book-2");
        expect(staleRes.statusCode).toBe(200);
        expect(staleRes.body.chapters).toEqual([]);
        expect(staleRes.body.audioFiles).toEqual([]);
        expect(staleRes.body.progress).toBeNull();

        prisma.audiobook.findUnique.mockResolvedValueOnce(null);
        audiobookCacheService.getAudiobook.mockResolvedValueOnce(null);
        const missingRes = createRes();
        await detailsHandler(
            { params: { id: "book-404" }, user: { id: "u1" } } as any,
            missingRes
        );
        expect(missingRes.statusCode).toBe(404);
        expect(missingRes.body).toEqual({ error: "Audiobook not found" });

        prisma.audiobook.findUnique.mockRejectedValueOnce(new Error("details exploded"));
        const errorRes = createRes();
        await detailsHandler(
            { params: { id: "book-err" }, user: { id: "u1" } } as any,
            errorRes
        );
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({
            error: "Failed to fetch audiobook",
            message: "details exploded",
        });
    });

    it("streams audiobook content with headers/defaults and handles failures", async () => {
        getSystemSettings.mockResolvedValueOnce({ audiobookshelfEnabled: false });
        const disabledRes = createRes();
        await streamHandler(
            { params: { id: "stream-1" }, headers: {}, user: { id: "u1" } } as any,
            disabledRes
        );
        expect(disabledRes.statusCode).toBe(503);
        expect(disabledRes.body).toEqual({ error: "Audiobookshelf is not configured" });

        const stream = createMockStream();
        audiobookshelfService.streamAudiobook.mockResolvedValueOnce({
            stream,
            headers: {
                "content-type": "audio/flac",
                "content-length": "1234",
                "content-range": "bytes 0-10/100",
            },
            status: 206,
        });

        const successRes = createRes();
        await streamHandler(
            {
                params: { id: "stream-2" },
                headers: { range: "bytes=0-10" },
                user: { id: "u1" },
            } as any,
            successRes
        );

        expect(successRes.statusCode).toBe(206);
        expect(successRes.headers["Content-Type"]).toBe("audio/flac");
        expect(successRes.headers["Content-Length"]).toBe("1234");
        expect(successRes.headers["Accept-Ranges"]).toBe("bytes");
        expect(successRes.headers["Content-Range"]).toBe("bytes 0-10/100");
        expect(stream.pipe).toHaveBeenCalledWith(successRes);

        successRes.emit("close");
        expect(stream.destroy).toHaveBeenCalled();

        const defaultStream = createMockStream();
        audiobookshelfService.streamAudiobook.mockResolvedValueOnce({
            stream: defaultStream,
            headers: {},
            status: undefined,
        });

        const defaultRes = createRes();
        await streamHandler(
            { params: { id: "stream-3" }, headers: {}, user: { id: "u1" } } as any,
            defaultRes
        );

        expect(defaultRes.statusCode).toBe(200);
        expect(defaultRes.headers["Content-Type"]).toBe("audio/mpeg");
        expect(defaultRes.headers["Accept-Ranges"]).toBe("bytes");

        const errorStream = createMockStream();
        audiobookshelfService.streamAudiobook.mockResolvedValueOnce({
            stream: errorStream,
            headers: {},
            status: undefined,
        });
        const streamErrorRes = createRes();
        await streamHandler(
            { params: { id: "stream-4" }, headers: {}, user: { id: "u1" } } as any,
            streamErrorRes
        );
        errorStream.emit("error", new Error("stream write failed"));
        expect(streamErrorRes.statusCode).toBe(500);
        expect(streamErrorRes.body).toEqual({
            error: "Failed to stream audiobook",
            message: "stream write failed",
        });

        const postHeaderStream = createMockStream();
        audiobookshelfService.streamAudiobook.mockResolvedValueOnce({
            stream: postHeaderStream,
            headers: {},
            status: undefined,
        });
        const headersSentRes = createRes();
        await streamHandler(
            { params: { id: "stream-5" }, headers: {}, user: { id: "u1" } } as any,
            headersSentRes
        );
        headersSentRes.headersSent = true;
        postHeaderStream.emit("error", new Error("late error"));
        expect(headersSentRes.end).toHaveBeenCalled();

        audiobookshelfService.streamAudiobook.mockRejectedValueOnce(
            new Error("service stream failed")
        );
        const catchRes = createRes();
        await streamHandler(
            { params: { id: "stream-6" }, headers: {}, user: { id: "u1" } } as any,
            catchRes
        );
        expect(catchRes.statusCode).toBe(500);
        expect(catchRes.body).toEqual({
            error: "Failed to stream audiobook",
            message: "service stream failed",
        });
    });

    it("updates progress with sanitization/fallbacks and handles sync/error branches", async () => {
        getSystemSettings.mockResolvedValueOnce({ audiobookshelfEnabled: false });
        const disabledRes = createRes();
        await progressHandler(
            {
                params: { id: "book-1" },
                body: { currentTime: 1, duration: 2, isFinished: false },
                user: { id: "u1", username: "user1" },
            } as any,
            disabledRes
        );
        expect(disabledRes.statusCode).toBe(200);
        expect(disabledRes.body).toEqual({
            success: false,
            message: "Audiobookshelf is not configured",
        });

        prisma.audiobook.findUnique.mockResolvedValueOnce({
            title: "Cached Title",
            author: "Cached Author",
            coverUrl: "covers/book-2.jpg",
            duration: 360,
            libraryId: "lib-1",
            localCoverPath: null,
        });
        prisma.audiobookProgress.findUnique.mockResolvedValueOnce({
            title: "Existing Title",
            author: "Existing Author",
            coverUrl: "existing-cover.jpg",
            duration: 120,
        });
        prisma.audiobookProgress.upsert.mockResolvedValueOnce({
            currentTime: 0,
            duration: 360,
            isFinished: true,
        });

        const successRes = createRes();
        await progressHandler(
            {
                params: { id: "book-2" },
                body: { currentTime: -5, duration: Number.NaN, isFinished: true },
                user: { id: "u1", username: "user1" },
            } as any,
            successRes
        );

        expect(prisma.audiobookProgress.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    title: "Cached Title",
                    author: "Cached Author",
                    coverUrl: "covers/book-2.jpg",
                    currentTime: 0,
                    duration: 360,
                    isFinished: true,
                }),
                update: expect.objectContaining({
                    currentTime: 0,
                    duration: 360,
                    isFinished: true,
                }),
            })
        );
        expect(audiobookshelfService.updateProgress).toHaveBeenCalledWith(
            "book-2",
            0,
            360,
            true
        );
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            success: true,
            progress: {
                currentTime: 0,
                progress: 0,
                isFinished: true,
            },
        });

        prisma.audiobook.findUnique.mockResolvedValueOnce(null);
        prisma.audiobookProgress.findUnique.mockResolvedValueOnce({
            title: "Saved Title",
            author: "Saved Author",
            coverUrl: "saved-cover.jpg",
            duration: 240,
        });
        prisma.audiobookProgress.upsert.mockResolvedValueOnce({
            currentTime: 60,
            duration: 240,
            isFinished: false,
        });
        audiobookshelfService.updateProgress.mockRejectedValueOnce(
            new Error("remote sync failed")
        );

        const syncFailRes = createRes();
        await progressHandler(
            {
                params: { id: "book-3" },
                body: { currentTime: 60, duration: 0, isFinished: false },
                user: { id: "u1", username: "user1" },
            } as any,
            syncFailRes
        );

        expect(prisma.audiobookProgress.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    title: "Saved Title",
                    author: "Saved Author",
                    coverUrl: "saved-cover.jpg",
                    duration: 240,
                }),
            })
        );
        expect(syncFailRes.statusCode).toBe(200);
        expect(syncFailRes.body).toEqual({
            success: true,
            progress: {
                currentTime: 60,
                progress: 25,
                isFinished: false,
            },
        });

        prisma.audiobook.findUnique.mockRejectedValueOnce(new Error("progress failed"));
        const errorRes = createRes();
        await progressHandler(
            {
                params: { id: "book-4" },
                body: { currentTime: 10, duration: 100 },
                user: { id: "u1", username: "user1" },
            } as any,
            errorRes
        );

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({
            error: "Failed to update progress",
            message: "progress failed",
        });
    });

    it("deletes progress with disabled, success, remote-failure, and error paths", async () => {
        getSystemSettings.mockResolvedValueOnce({ audiobookshelfEnabled: false });
        const disabledRes = createRes();
        await deleteProgressHandler(
            {
                params: { id: "book-1" },
                user: { id: "u1", username: "user1" },
            } as any,
            disabledRes
        );
        expect(disabledRes.statusCode).toBe(200);
        expect(disabledRes.body).toEqual({
            success: false,
            message: "Audiobookshelf is not configured",
        });

        const successRes = createRes();
        await deleteProgressHandler(
            {
                params: { id: "book-2" },
                user: { id: "u1", username: "user1" },
            } as any,
            successRes
        );
        expect(prisma.audiobookProgress.deleteMany).toHaveBeenCalledWith({
            where: {
                userId: "u1",
                audiobookshelfId: "book-2",
            },
        });
        expect(audiobookshelfService.updateProgress).toHaveBeenCalledWith(
            "book-2",
            0,
            0,
            false
        );
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            success: true,
            message: "Progress removed",
        });

        audiobookshelfService.updateProgress.mockRejectedValueOnce(
            new Error("reset failed")
        );
        const remoteFailRes = createRes();
        await deleteProgressHandler(
            {
                params: { id: "book-3" },
                user: { id: "u1", username: "user1" },
            } as any,
            remoteFailRes
        );
        expect(remoteFailRes.statusCode).toBe(200);
        expect(remoteFailRes.body).toEqual({
            success: true,
            message: "Progress removed",
        });

        prisma.audiobookProgress.deleteMany.mockRejectedValueOnce(
            new Error("delete failed")
        );
        const errorRes = createRes();
        await deleteProgressHandler(
            {
                params: { id: "book-4" },
                user: { id: "u1", username: "user1" },
            } as any,
            errorRes
        );
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({
            error: "Failed to remove progress",
            message: "delete failed",
        });
    });

    it("covers search/list/series non-happy branches", async () => {
        getSystemSettings.mockResolvedValueOnce({ audiobookshelfEnabled: false });
        const searchDisabledRes = createRes();
        await searchHandler(
            { query: { q: "dune" }, user: { id: "u1" } } as any,
            searchDisabledRes
        );
        expect(searchDisabledRes.statusCode).toBe(200);
        expect(searchDisabledRes.body).toEqual([]);

        audiobookshelfService.searchAudiobooks.mockRejectedValueOnce(
            new Error("search failed")
        );
        const searchErrorRes = createRes();
        await searchHandler(
            { query: { q: "dune" }, user: { id: "u1" } } as any,
            searchErrorRes
        );
        expect(searchErrorRes.statusCode).toBe(500);
        expect(searchErrorRes.body).toEqual({
            error: "Failed to search audiobooks",
            message: "search failed",
        });

        prisma.audiobook.findMany.mockResolvedValueOnce([]);
        const listRes = createRes();
        await listHandler({ user: { id: "u1" } } as any, listRes);
        expect(prisma.audiobookProgress.findMany).not.toHaveBeenCalled();
        expect(listRes.statusCode).toBe(200);
        expect(listRes.body).toEqual([]);

        prisma.audiobook.findMany.mockRejectedValueOnce(new Error("list failed"));
        const listErrorRes = createRes();
        await listHandler({ user: { id: "u1" } } as any, listErrorRes);
        expect(listErrorRes.statusCode).toBe(500);
        expect(listErrorRes.body).toEqual({
            error: "Failed to fetch audiobooks",
            message: "list failed",
        });

        prisma.audiobook.findMany.mockRejectedValueOnce(new Error("series failed"));
        const seriesErrorRes = createRes();
        await seriesHandler(
            {
                params: { seriesName: encodeURIComponent("Series Name") },
                user: { id: "u1" },
            } as any,
            seriesErrorRes
        );
        expect(seriesErrorRes.statusCode).toBe(500);
        expect(seriesErrorRes.body).toEqual({
            error: "Failed to fetch series",
            message: "series failed",
        });
    });
});
