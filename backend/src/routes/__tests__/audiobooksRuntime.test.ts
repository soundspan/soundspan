import type { Request, Response } from "express";

const mockLookup = jest.fn();

jest.mock("dns/promises", () => ({
    lookup: (...args: unknown[]) => mockLookup(...args),
}));

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (req: Request, _res: Response, next: () => void) => {
        req.user = {
            id: "authenticated-user",
            username: "authenticated-user",
            role: req.headers["x-test-role"] === "admin" ? "admin" : "user",
        };
        next();
    },
    requireAdmin: (req: Request, res: Response, next: () => void) => {
        if (req.user?.role !== "admin") {
            return res.status(403).json({ error: "Admin access required" });
        }
        next();
    },
}));

jest.mock("../../middleware/rateLimiter", () => ({
    apiLimiter: (_req: Request, _res: Response, next: () => void) => next(),
    coverArtLimiter: (_req: Request, _res: Response, next: () => void) =>
        next(),
    streamingLimiter: (_req: Request, _res: Response, next: () => void) =>
        next(),
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

jest.mock("../../services/federationAudiobookProxy", () => ({
    proxyFederatedAudiobookStream: jest.fn(),
    proxyFederatedAudiobookCover: jest.fn(),
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

jest.mock("../../config", () => ({
    config: {
        features: { federation: false },
        music: {
            musicPath: "/music",
        },
    },
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

const MAX_ROUTE_HANDLERS = 4;

function getHandler(path: string, method: "get" | "post") {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer) {
        throw new Error(`${method.toUpperCase()} route not found: ${path}`);
    }
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invokeRouteStack(
    path: string,
    method: "get" | "post",
    req: any,
    res: any,
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    const stack = layer?.route?.stack ?? [];
    if (stack.length > MAX_ROUTE_HANDLERS) {
        throw new Error(`Too many route handlers: ${stack.length}`);
    }
    for (let index = 0; index < MAX_ROUTE_HANDLERS; index += 1) {
        const entry = stack[index];
        if (!entry) return;
        let nextCalled = false;
        await entry.handle(req, res, () => {
            nextCalled = true;
        });
        if (!nextCalled) return;
    }
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
        send: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
        sendFile: jest.fn(function (filePath: string) {
            res.body = filePath;
            return res;
        }),
        setHeader: jest.fn(),
    };
    return res;
}

describe("audiobooks route runtime", () => {
    const continueListeningHandler = getHandler("/continue-listening", "get");
    const syncHandler = getHandler("/sync", "post");
    const searchHandler = getHandler("/search", "get");
    const listHandler = getHandler("/", "get");
    const seriesHandler = getHandler("/series/:seriesName", "get");
    const coverHandler = getHandler("/:id/cover", "get");

    beforeEach(() => {
        jest.clearAllMocks();
        mockLookup.mockReset();
        mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);

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
        getSystemSettings.mockResolvedValueOnce({
            audiobookshelfEnabled: false,
        });

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
            {
                id: "p2",
                coverUrl: "https://cdn.example/cover-2.jpg",
                currentTime: 40,
            },
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
            new Error("progress read failed"),
        );

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await continueListeningHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to fetch continue listening",
        });
    });

    it("rejects sync when audiobookshelf is disabled", async () => {
        getSystemSettings.mockResolvedValueOnce({
            audiobookshelfEnabled: false,
        });

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await syncHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Audiobookshelf not enabled" });
        expect(audiobookCacheService.syncAll).not.toHaveBeenCalled();
    });

    it("rejects an authenticated non-admin sync request", async () => {
        const req = { headers: { "x-test-role": "user" } } as any;
        const res = createRes();

        await invokeRouteStack("/sync", "post", req, res);

        expect(req.user).toEqual(expect.objectContaining({ role: "user" }));
        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: "Admin access required" });
        expect(audiobookCacheService.syncAll).not.toHaveBeenCalled();
    });

    it("syncs audiobooks and notifies the current user", async () => {
        audiobookCacheService.syncAll.mockResolvedValueOnce({
            synced: 7,
            failed: 0,
            skipped: 1,
            deleted: 2,
            errors: [],
        });
        prisma.audiobook.count.mockResolvedValueOnce(3);

        const req = { user: { id: "user-42" } } as any;
        const res = createRes();
        await syncHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            result: {
                synced: 7,
                failed: 0,
                skipped: 1,
                deleted: 2,
                errors: [],
            },
        });
        expect(notificationService.notifySystem).toHaveBeenCalledWith(
            "user-42",
            "Audiobook Sync Complete",
            "Synced 7 audiobooks (3 with series)",
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
            new Error("sync service down"),
        );

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await syncHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Sync failed",
        });
    });

    it("surfaces an already-running audiobook sync as a conflict", async () => {
        audiobookCacheService.syncAll.mockRejectedValueOnce(
            new Error("audiobook sync already running"),
        );

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await syncHandler(req, res);

        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({
            error: "audiobook sync already running",
        });
    });

    it("rejects an unsafe cached ABS cover path before proxy fetch", async () => {
        const existsSpy = jest.spyOn(require("fs"), "existsSync");
        existsSpy.mockReturnValue(false);
        const fetchMock = jest.fn();
        (global as any).fetch = fetchMock;
        prisma.audiobook.findUnique.mockResolvedValueOnce({
            localCoverPath: null,
            coverUrl: "items/../../api/me",
        });
        getSystemSettings.mockResolvedValueOnce({
            audiobookshelfUrl: "https://audiobooks.example",
            audiobookshelfApiKey: "abs-key",
        });

        const req = { params: { id: "book-1" } } as any;
        const res = createRes();

        await coverHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Cover not found" });
        expect(fetchMock).not.toHaveBeenCalled();
        existsSpy.mockRestore();
    });

    it("does not probe a fallback cover filename for an unsafe local id", async () => {
        const existsSpy = jest.spyOn(require("fs"), "existsSync");
        existsSpy.mockReturnValue(true);
        prisma.audiobook.findUnique.mockResolvedValueOnce({
            localCoverPath: null,
            coverUrl: null,
            peerId: null,
        });

        const req = { params: { id: "victim:cover" } } as any;
        const res = createRes();

        await coverHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Cover not found" });
        expect(existsSpy).not.toHaveBeenCalled();
        expect(prisma.audiobook.update).not.toHaveBeenCalled();
        existsSpy.mockRestore();
    });

    it("cancels failed Audiobookshelf cover responses and returns 404", async () => {
        const existsSpy = jest.spyOn(require("fs"), "existsSync");
        existsSpy.mockReturnValue(false);
        const cancel = jest.fn().mockResolvedValue(undefined);
        const fetchMock = jest.fn().mockResolvedValue({
            ok: false,
            body: { cancel },
        });
        (global as any).fetch = fetchMock;
        prisma.audiobook.findUnique.mockResolvedValueOnce({
            localCoverPath: null,
            coverUrl: "items/book-1/cover",
        });
        getSystemSettings.mockResolvedValueOnce({
            audiobookshelfUrl: "https://audiobooks.example",
            audiobookshelfApiKey: "abs-key",
        });

        const req = { params: { id: "book-1" } } as any;
        const res = createRes();

        await coverHandler(req, res);

        expect(cancel).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Cover not found" });
        existsSpy.mockRestore();
    });

    it("streams successful Audiobookshelf cover responses without cancelling", async () => {
        const existsSpy = jest.spyOn(require("fs"), "existsSync");
        existsSpy.mockReturnValue(false);
        const cancel = jest.fn().mockResolvedValue(undefined);
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(Uint8Array.from([1, 2, 3]));
                controller.close();
            },
            cancel,
        });
        const fetchMock = jest.fn().mockResolvedValue(
            new Response(body, {
                status: 200,
                headers: { "content-type": "image/jpeg" },
            }),
        );
        (global as any).fetch = fetchMock;
        prisma.audiobook.findUnique.mockResolvedValueOnce({
            localCoverPath: null,
            coverUrl: "items/book-1/cover",
        });
        getSystemSettings.mockResolvedValueOnce({
            audiobookshelfUrl: "https://audiobooks.example",
            audiobookshelfApiKey: "abs-key",
        });

        const req = { params: { id: "book-1" } } as any;
        const res = createRes();

        await coverHandler(req, res);

        expect(cancel).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.send).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
        existsSpy.mockRestore();
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
            "dune",
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(results);
    });

    it("returns configured=false payload for list endpoint when disabled", async () => {
        getSystemSettings.mockResolvedValueOnce({
            audiobookshelfEnabled: false,
        });

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
        getSystemSettings.mockResolvedValueOnce({
            audiobookshelfEnabled: false,
        });

        const req = {
            user: { id: "user-1" },
            params: { seriesName: encodeURIComponent("Series Name") },
        } as any;
        const res = createRes();
        await seriesHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("uses the Express-decoded series name and maps series progress response", async () => {
        const seriesName = "The Expanse: Saga";
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
                series: seriesName,
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
            params: { seriesName },
        } as any;
        const res = createRes();
        await seriesHandler(req, res);

        expect(prisma.audiobook.findMany).toHaveBeenCalledWith({
            where: { series: seriesName },
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
                series: { name: seriesName, sequence: "2" },
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

    it.each([
        "100% Series",
        "Volume%2FPart",
        "\u65e5\u672c\u8a9e\u30b7\u30ea\u30fc\u30ba",
    ])(
        "preserves the Express-decoded series lookup key %s verbatim",
        async (seriesName) => {
            prisma.audiobook.findMany.mockImplementation(
                async ({ where }: { where: { series: string } }) =>
                    where.series === seriesName
                        ? [
                              {
                                  id: "matching-book",
                                  title: "Matching Book",
                                  author: "Author",
                                  narrator: null,
                                  description: null,
                                  localCoverPath: null,
                                  coverUrl: null,
                                  duration: 120,
                                  libraryId: "library-1",
                                  series: seriesName,
                                  seriesSequence: "1",
                                  genres: [],
                              },
                          ]
                        : [],
            );

            const req = {
                user: { id: "user-1" },
                params: { seriesName },
            } as any;
            const res = createRes();

            await seriesHandler(req, res);

            expect(prisma.audiobook.findMany).toHaveBeenCalledTimes(1);
            expect(prisma.audiobook.findMany).toHaveBeenCalledWith({
                where: { series: seriesName },
                orderBy: { seriesSequence: "asc" },
            });
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual([
                expect.objectContaining({
                    id: "matching-book",
                    series: { name: seriesName, sequence: "1" },
                }),
            ]);
        },
    );

    it("falls back to a decoded series key for legacy double-encoded clients", async () => {
        const legacyRouteName = "Legacy%20Series";
        prisma.audiobook.findMany.mockImplementation(
            async ({ where }: { where: { series: string } }) =>
                where.series === "Legacy Series"
                    ? [
                          {
                              id: "legacy-book",
                              title: "Legacy Book",
                              author: "Author",
                              narrator: null,
                              description: null,
                              localCoverPath: null,
                              coverUrl: null,
                              duration: 120,
                              libraryId: "library-1",
                              series: "Legacy Series",
                              seriesSequence: "1",
                              genres: [],
                          },
                      ]
                    : [],
        );

        const req = {
            user: { id: "user-1" },
            params: { seriesName: legacyRouteName },
        } as any;
        const res = createRes();

        await seriesHandler(req, res);

        expect(prisma.audiobook.findMany.mock.calls).toEqual([
            [
                {
                    where: { series: legacyRouteName },
                    orderBy: { seriesSequence: "asc" },
                },
            ],
            [
                {
                    where: { series: "Legacy Series" },
                    orderBy: { seriesSequence: "asc" },
                },
            ],
        ]);
        expect(res.body).toEqual([
            expect.objectContaining({ id: "legacy-book" }),
        ]);
    });
});
