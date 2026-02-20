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

const notificationService = {
    notifySystem: jest.fn(),
};
jest.mock("../../services/notificationService", () => ({
    notificationService,
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

import router from "../audiobooks";

function getHandler(path: string, method: "get" | "post") {
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

describe("audiobooks route runtime", () => {
    const continueListeningHandler = getHandler("/continue-listening", "get");
    const syncHandler = getHandler("/sync", "post");
    const searchHandler = getHandler("/search", "get");
    const listHandler = getHandler("/", "get");
    const seriesHandler = getHandler("/series/:seriesName", "get");

    beforeEach(() => {
        jest.clearAllMocks();

        getSystemSettings.mockResolvedValue({
            audiobookshelfEnabled: true,
            audiobookshelfUrl: "http://audiobookshelf.local",
            audiobookshelfApiKey: "abs-token",
        });
        audiobookCacheService.syncAll.mockResolvedValue({ synced: 0 });
        notificationService.notifySystem.mockResolvedValue(undefined);
        audiobookshelfService.searchAudiobooks.mockResolvedValue([]);
        prisma.audiobook.findMany.mockResolvedValue([]);
        prisma.audiobookProgress.findMany.mockResolvedValue([]);
        prisma.audiobook.count.mockResolvedValue(0);
    });

    it("returns an empty continue-listening response when audiobookshelf is disabled", async () => {
        getSystemSettings.mockResolvedValueOnce({ audiobookshelfEnabled: false });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await continueListeningHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([]);
        expect(prisma.audiobookProgress.findMany).not.toHaveBeenCalled();
    });

    it("transforms continue-listening cover paths and preserves absolute URLs", async () => {
        prisma.audiobookProgress.findMany.mockResolvedValueOnce([
            { id: "p1", coverUrl: "items/cover-1.jpg", currentTime: 20 },
            { id: "p2", coverUrl: "https://cdn.example/cover-2.jpg", currentTime: 40 },
            { id: "p3", coverUrl: null, currentTime: 60 },
        ]);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await continueListeningHandler(req, res);

        expect(prisma.audiobookProgress.findMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                isFinished: false,
                currentTime: { gt: 0 },
            },
            orderBy: { lastPlayedAt: "desc" },
            take: 10,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([
            expect.objectContaining({
                id: "p1",
                coverUrl: "audiobook__items/cover-1.jpg",
            }),
            expect.objectContaining({
                id: "p2",
                coverUrl: "https://cdn.example/cover-2.jpg",
            }),
            expect.objectContaining({
                id: "p3",
                coverUrl: null,
            }),
        ]);
    });

    it("returns 500 when continue-listening query fails", async () => {
        prisma.audiobookProgress.findMany.mockRejectedValueOnce(
            new Error("progress read failed")
        );

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await continueListeningHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to fetch continue listening",
            message: "progress read failed",
        });
    });

    it("rejects sync when audiobookshelf is disabled", async () => {
        getSystemSettings.mockResolvedValueOnce({ audiobookshelfEnabled: false });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await syncHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Audiobookshelf not enabled" });
        expect(audiobookCacheService.syncAll).not.toHaveBeenCalled();
    });

    it("syncs audiobooks and notifies the current user", async () => {
        audiobookCacheService.syncAll.mockResolvedValueOnce({ synced: 7 });
        prisma.audiobook.count.mockResolvedValueOnce(3);

        const req = { user: { id: "user-42" } } as any;
        const res = createRes();
        await syncHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            result: { synced: 7 },
        });
        expect(notificationService.notifySystem).toHaveBeenCalledWith(
            "user-42",
            "Audiobook Sync Complete",
            "Synced 7 audiobooks (3 with series)"
        );
    });

    it("syncs audiobooks without notification when request has no user id", async () => {
        audiobookCacheService.syncAll.mockResolvedValueOnce({ synced: 2 });
        prisma.audiobook.count.mockResolvedValueOnce(1);

        const req = {} as any;
        const res = createRes();
        await syncHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            result: { synced: 2 },
        });
        expect(notificationService.notifySystem).not.toHaveBeenCalled();
    });

    it("returns 500 when sync fails", async () => {
        audiobookCacheService.syncAll.mockRejectedValueOnce(
            new Error("sync service down")
        );

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await syncHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Sync failed",
            message: "sync service down",
        });
    });

    it("validates search query input", async () => {
        const req = { query: {}, user: { id: "user-1" } } as any;
        const res = createRes();
        await searchHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Query parameter required" });
        expect(audiobookshelfService.searchAudiobooks).not.toHaveBeenCalled();
    });

    it("searches audiobooks with a valid query", async () => {
        const results = [{ id: "book-1", title: "Dune" }];
        audiobookshelfService.searchAudiobooks.mockResolvedValueOnce(results);

        const req = { query: { q: "dune" }, user: { id: "user-1" } } as any;
        const res = createRes();
        await searchHandler(req, res);

        expect(audiobookshelfService.searchAudiobooks).toHaveBeenCalledWith(
            "dune"
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(results);
    });

    it("returns configured=false payload for list endpoint when disabled", async () => {
        getSystemSettings.mockResolvedValueOnce({ audiobookshelfEnabled: false });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await listHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            configured: false,
            enabled: false,
            audiobooks: [],
        });
    });

    it("applies limit and offset pagination parameters for list endpoint", async () => {
        prisma.audiobook.findMany.mockResolvedValueOnce([
            {
                id: "book-2",
                title: "Book Two",
                author: "Author Two",
                narrator: null,
                description: null,
                localCoverPath: null,
                coverUrl: null,
                duration: 120,
                libraryId: "lib-1",
                series: null,
                seriesSequence: null,
                genres: [],
            },
        ]);

        const req = {
            user: { id: "user-1" },
            query: { limit: "1", offset: "1" },
        } as any;
        const res = createRes();
        await listHandler(req, res);

        expect(prisma.audiobook.findMany).toHaveBeenCalledWith({
            orderBy: { title: "asc" },
            take: 1,
            skip: 1,
        });
        expect(prisma.audiobookProgress.findMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                audiobookshelfId: { in: ["book-2"] },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body).toHaveLength(1);
    });

    it("maps audiobook list response with user progress and normalized fields", async () => {
        const lastPlayedAt = new Date("2026-01-15T10:00:00.000Z");

        prisma.audiobook.findMany.mockResolvedValueOnce([
            {
                id: "book-1",
                title: "First Book",
                author: null,
                narrator: "Narrator One",
                description: "Desc One",
                localCoverPath: null,
                coverUrl: "items/cover-1.jpg",
                duration: 300,
                libraryId: "lib-1",
                series: "Saga",
                seriesSequence: null,
                genres: null,
            },
            {
                id: "book-2",
                title: "Second Book",
                author: "Known Author",
                narrator: null,
                description: null,
                localCoverPath: null,
                coverUrl: null,
                duration: null,
                libraryId: "lib-2",
                series: null,
                seriesSequence: null,
                genres: ["Fantasy"],
            },
        ]);
        prisma.audiobookProgress.findMany.mockResolvedValueOnce([
            {
                userId: "user-1",
                audiobookshelfId: "book-1",
                currentTime: 75,
                duration: 300,
                isFinished: false,
                lastPlayedAt,
            },
        ]);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await listHandler(req, res);

        expect(prisma.audiobookProgress.findMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                audiobookshelfId: { in: ["book-1", "book-2"] },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([
            {
                id: "book-1",
                title: "First Book",
                author: "Unknown Author",
                narrator: "Narrator One",
                description: "Desc One",
                coverUrl: "/audiobooks/book-1/cover",
                duration: 300,
                libraryId: "lib-1",
                series: { name: "Saga", sequence: "1" },
                genres: [],
                progress: {
                    currentTime: 75,
                    progress: 25,
                    isFinished: false,
                    lastPlayedAt,
                },
            },
            {
                id: "book-2",
                title: "Second Book",
                author: "Known Author",
                narrator: null,
                description: null,
                coverUrl: null,
                duration: 0,
                libraryId: "lib-2",
                series: null,
                genres: ["Fantasy"],
                progress: null,
            },
        ]);
    });

    it("returns an empty series list when audiobookshelf is disabled", async () => {
        getSystemSettings.mockResolvedValueOnce({ audiobookshelfEnabled: false });

        const req = {
            user: { id: "user-1" },
            params: { seriesName: encodeURIComponent("Series Name") },
        } as any;
        const res = createRes();
        await seriesHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("decodes series name and maps series progress response", async () => {
        const decodedName = "The Expanse: Saga";
        const encodedName = encodeURIComponent(decodedName);
        const lastPlayedAt = new Date("2026-01-16T10:00:00.000Z");

        prisma.audiobook.findMany.mockResolvedValueOnce([
            {
                id: "series-1",
                title: "Leviathan Wakes",
                author: null,
                narrator: "Narrator X",
                description: "Book in series",
                localCoverPath: "/cache/series-1.jpg",
                coverUrl: null,
                duration: null,
                libraryId: "lib-series",
                series: decodedName,
                seriesSequence: "2",
                genres: null,
            },
        ]);
        prisma.audiobookProgress.findMany.mockResolvedValueOnce([
            {
                userId: "user-1",
                audiobookshelfId: "series-1",
                currentTime: 90,
                duration: 180,
                isFinished: false,
                lastPlayedAt,
            },
        ]);

        const req = {
            user: { id: "user-1" },
            params: { seriesName: encodedName },
        } as any;
        const res = createRes();
        await seriesHandler(req, res);

        expect(prisma.audiobook.findMany).toHaveBeenCalledWith({
            where: { series: decodedName },
            orderBy: { seriesSequence: "asc" },
        });
        expect(prisma.audiobookProgress.findMany).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                audiobookshelfId: { in: ["series-1"] },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([
            {
                id: "series-1",
                title: "Leviathan Wakes",
                author: "Unknown Author",
                narrator: "Narrator X",
                description: "Book in series",
                coverUrl: "/audiobooks/series-1/cover",
                duration: 0,
                libraryId: "lib-series",
                series: { name: decodedName, sequence: "2" },
                genres: [],
                progress: {
                    currentTime: 90,
                    progress: 50,
                    isFinished: false,
                    lastPlayedAt,
                },
            },
        ]);
    });
});
