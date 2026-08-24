jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: any, _res: any, next: () => void) => next(),
    requireAdmin: (req: any, res: any, next: () => void) => {
        if (!req.user || req.user.role !== "admin") {
            return res.status(403).json({ error: "Admin access required" });
        }
        next();
    },
}));

const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
};
jest.mock("../../utils/logger", () => ({ logger: mockLogger }));

const notificationService = {
    getForUser: jest.fn(),
    getUnreadCount: jest.fn(),
    markAsRead: jest.fn(),
    markAllAsRead: jest.fn(),
    clear: jest.fn(),
    clearAll: jest.fn(),
};
jest.mock("../../services/notificationService", () => ({
    notificationService,
}));

const prisma = {
    downloadJob: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
    },
    playlist: {
        findUnique: jest.fn(),
    },
    playlistPendingTrack: {
        findUnique: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({
    prisma,
}));

const soulseekService = {
    searchTrack: jest.fn(),
    downloadBestMatch: jest.fn(),
    searchAndDownloadBatch: jest.fn(),
};
jest.mock("../../services/soulseek", () => ({
    soulseekService,
}));

const getSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings,
}));

const scanQueue = {
    add: jest.fn(),
};
jest.mock("../../workers/queues", () => ({
    scanQueue,
}));

const simpleDownloadManager = {
    startDownload: jest.fn(),
};
jest.mock("../../services/simpleDownloadManager", () => ({
    simpleDownloadManager,
}));

const dispatchAlbumDownload = jest.fn();
jest.mock("../../services/downloadDispatcher", () => ({
    dispatchAlbumDownload: (...args: unknown[]) =>
        dispatchAlbumDownload(...args),
}));

import router from "../notifications";
import { requireAdmin } from "../../middleware/auth";

type HttpMethod = "get" | "post" | "put" | "delete";
const MAX_ROUTE_HANDLERS = 4;

function getRouteLayer(path: string, method: HttpMethod) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer) {
        throw new Error(`${method.toUpperCase()} route not found: ${path}`);
    }
    return layer;
}

function getHandler(path: string, method: HttpMethod) {
    const layer = getRouteLayer(path, method);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function invokeRouteStack(
    path: string,
    method: HttpMethod,
    req: any,
    res: any,
) {
    const { stack } = getRouteLayer(path, method).route;
    if (stack.length > MAX_ROUTE_HANDLERS) {
        throw new Error(`Too many route handlers: ${stack.length}`);
    }
    for (let index = 0; index < MAX_ROUTE_HANDLERS; index += 1) {
        const entry = stack[index];
        if (!entry) {
            return;
        }
        let nextCalled = false;
        await entry.handle(req, res, () => {
            nextCalled = true;
        });
        if (!nextCalled) {
            return;
        }
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
    };
    return res;
}

async function flushAsyncWork() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
}

async function captureUnhandledRejections(
    run: () => Promise<void>,
): Promise<unknown[]> {
    const rejections: unknown[] = [];
    const capture = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", capture);
    try {
        await run();
        await flushAsyncWork();
        return rejections;
    } finally {
        process.off("unhandledRejection", capture);
    }
}

function prepareSpotifyImportFallback(id: string): void {
    prisma.downloadJob.findFirst.mockResolvedValueOnce({
        id: `job-${id}`,
        userId: "u1",
        subject: "Artist - Album",
        type: "album",
        targetMbid: `mbid-${id}`,
        artistMbid: "artist-mbid",
        metadata: {
            downloadType: "spotify_import",
            artistName: "Artist",
            albumTitle: "Album",
        },
    });
    prisma.downloadJob.create.mockResolvedValueOnce({
        id: `job-new-${id}`,
        metadata: {},
    });
    getSystemSettings.mockResolvedValueOnce({ musicPath: "/music" });
    soulseekService.searchAndDownloadBatch.mockResolvedValueOnce({
        successful: 0,
        files: [],
    });
}

describe("notifications route runtime", () => {
    const getNotifications = getHandler("/", "get");
    const getUnreadCount = getHandler("/unread-count", "get");
    const markRead = getHandler("/:id/read", "post");
    const markAllRead = getHandler("/read-all", "post");
    const clearOne = getHandler("/:id/clear", "post");
    const clearAll = getHandler("/clear-all", "post");
    const getDownloadHistory = getHandler("/downloads/history", "get");
    const getActiveDownloads = getHandler("/downloads/active", "get");
    const clearDownload = getHandler("/downloads/:id/clear", "post");
    const clearAllDownloads = getHandler("/downloads/clear-all", "post");
    const retryDownload = getHandler("/downloads/:id/retry", "post");

    beforeEach(() => {
        jest.clearAllMocks();

        notificationService.getForUser.mockResolvedValue([{ id: "n1" }]);
        notificationService.getUnreadCount.mockResolvedValue(3);
        notificationService.markAsRead.mockResolvedValue(undefined);
        notificationService.markAllAsRead.mockResolvedValue(undefined);
        notificationService.clear.mockResolvedValue(undefined);
        notificationService.clearAll.mockResolvedValue(undefined);

        prisma.downloadJob.findMany.mockResolvedValue([]);
        prisma.downloadJob.updateMany.mockResolvedValue({ count: 1 });
        prisma.downloadJob.findFirst.mockResolvedValue(null);
        prisma.downloadJob.update.mockResolvedValue({});
        prisma.downloadJob.create.mockResolvedValue({
            id: "job-new",
            metadata: {},
        });

        prisma.playlist.findUnique.mockResolvedValue({
            id: "pl-1",
            userId: "u1",
        });
        prisma.playlistPendingTrack.findUnique.mockResolvedValue({
            id: "pt-1",
            spotifyArtist: "Artist",
            spotifyTitle: "Title",
            spotifyAlbum: "Unknown Album",
            albumMbid: null,
            artistMbid: null,
        });

        getSystemSettings.mockResolvedValue({
            musicPath: null,
            soulseekUsername: null,
            soulseekPassword: null,
            soulseekConcurrentDownloads: 4,
        });

        soulseekService.searchTrack.mockResolvedValue({
            found: false,
            allMatches: [],
        });
        soulseekService.downloadBestMatch.mockResolvedValue({
            success: true,
            filePath: "/tmp/song.mp3",
        });
        soulseekService.searchAndDownloadBatch.mockResolvedValue({
            successful: 0,
            files: [],
        });
        scanQueue.add.mockResolvedValue({ id: "scan-1" });
        simpleDownloadManager.startDownload.mockResolvedValue({
            success: true,
            error: null,
        });
        dispatchAlbumDownload.mockResolvedValue(undefined);
    });

    it("requires admin authorization for download retries", () => {
        const middlewares = getRouteLayer(
            "/downloads/:id/retry",
            "post",
        ).route.stack.map((entry: { handle: unknown }) => entry.handle);

        expect(middlewares).toContain(requireAdmin);
    });

    it("rejects non-admin download retries before downloads or writes", async () => {
        const req = {
            user: { id: "u1", role: "user" },
            params: { id: "job-1" },
        } as any;
        const res = createRes();

        await invokeRouteStack("/downloads/:id/retry", "post", req, res);

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: "Admin access required" });
        expect(soulseekService.downloadBestMatch).not.toHaveBeenCalled();
        expect(soulseekService.searchAndDownloadBatch).not.toHaveBeenCalled();
        expect(simpleDownloadManager.startDownload).not.toHaveBeenCalled();
        expect(dispatchAlbumDownload).not.toHaveBeenCalled();
        expect(prisma.downloadJob.updateMany).not.toHaveBeenCalled();
        expect(prisma.downloadJob.update).not.toHaveBeenCalled();
        expect(prisma.downloadJob.create).not.toHaveBeenCalled();
    });

    it("routes an admin generic album retry through the dispatcher", async () => {
        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-generic",
            userId: "u1",
            subject: "Artist - Album",
            type: "album",
            targetMbid: "album-mbid",
            artistMbid: "artist-mbid",
            metadata: {},
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-new-generic",
            metadata: {},
        });
        let resolveDispatch!: () => void;
        dispatchAlbumDownload.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveDispatch = resolve;
                }),
        );
        const req = {
            user: { id: "u1", role: "admin" },
            params: { id: "job-generic" },
        } as any;
        const res = createRes();

        const retryPromise = invokeRouteStack(
            "/downloads/:id/retry",
            "post",
            req,
            res,
        );
        await flushAsyncWork();

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            newJobId: "job-new-generic",
            error: null,
        });
        expect(dispatchAlbumDownload).toHaveBeenCalledWith({
            jobId: "job-new-generic",
            type: "album",
            mbid: "album-mbid",
            subject: "Artist - Album",
            artistName: "Artist",
            albumTitle: "Album",
        });
        resolveDispatch();
        await retryPromise;
        await flushAsyncWork();
        expect(simpleDownloadManager.startDownload).not.toHaveBeenCalled();
    });

    it("marks a scheduled generic album retry failed when dispatch rejects", async () => {
        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-generic-failed",
            userId: "u1",
            subject: "Artist - Album",
            type: "album",
            targetMbid: "album-mbid",
            artistMbid: "artist-mbid",
            metadata: { albumTitle: "Album" },
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-new-generic-failed",
            metadata: {},
        });
        const dispatchError = new Error("provider token=dispatch-secret");
        dispatchAlbumDownload.mockRejectedValueOnce(dispatchError);
        const req = {
            user: { id: "u1", role: "admin" },
            params: { id: "job-generic-failed" },
        } as any;
        const res = createRes();

        await retryDownload(req, res);
        await flushAsyncWork();

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            newJobId: "job-new-generic-failed",
            error: null,
        });
        expect(prisma.downloadJob.update).toHaveBeenCalledWith({
            where: { id: "job-new-generic-failed" },
            data: {
                status: "failed",
                error: "Download dispatch failed",
                completedAt: expect.any(Date),
            },
        });
        expect(
            JSON.stringify(prisma.downloadJob.update.mock.calls),
        ).not.toContain("dispatch-secret");
        expect(mockLogger.error).toHaveBeenCalledWith(
            "[Retry] Album dispatch error:",
            dispatchError,
        );
        expect(simpleDownloadManager.startDownload).not.toHaveBeenCalled();
    });

    it("logs when generic album dispatch failure persistence rejects", async () => {
        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-generic-persistence-failed",
            userId: "u1",
            subject: "Artist - Album",
            type: "album",
            targetMbid: "album-mbid",
            artistMbid: "artist-mbid",
            metadata: { albumTitle: "Album" },
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-new-generic-persistence-failed",
            metadata: {},
        });
        const dispatchError = new Error("dispatch unavailable");
        const persistenceError = new Error("database unavailable");
        dispatchAlbumDownload.mockRejectedValueOnce(dispatchError);
        prisma.downloadJob.update
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(persistenceError);
        const req = {
            user: { id: "u1", role: "admin" },
            params: { id: "job-generic-persistence-failed" },
        } as any;
        const res = createRes();

        await retryDownload(req, res);
        await flushAsyncWork();

        expect(res.body).toEqual({
            success: true,
            newJobId: "job-new-generic-persistence-failed",
            error: null,
        });
        expect(mockLogger.error).toHaveBeenCalledWith(
            "[Retry] Failed to persist album dispatch failure:",
            persistenceError,
        );
    });

    it("keeps generic artist retries on the simple download manager", async () => {
        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-artist",
            userId: "u1",
            subject: "Artist Name",
            type: "artist",
            targetMbid: "artist-target-mbid",
            artistMbid: "artist-mbid",
            metadata: {},
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-new-artist",
            metadata: {},
        });
        const req = {
            user: { id: "u1", role: "admin" },
            params: { id: "job-artist" },
        } as any;
        const res = createRes();

        await retryDownload(req, res);

        expect(simpleDownloadManager.startDownload).toHaveBeenCalledWith(
            "job-new-artist",
            "Artist Name",
            "Artist Name",
            "artist-target-mbid",
            "u1",
            false,
        );
        expect(dispatchAlbumDownload).not.toHaveBeenCalled();
        expect(res.body).toEqual({
            success: true,
            newJobId: "job-new-artist",
            error: null,
        });
    });

    it("handles notification listing/read/clear endpoints", async () => {
        const req = { user: { id: "u1" }, params: { id: "n1" } } as any;

        const listRes = createRes();
        await getNotifications(req, listRes);
        expect(listRes.statusCode).toBe(200);
        expect(listRes.body).toEqual([{ id: "n1" }]);

        const unreadRes = createRes();
        await getUnreadCount(req, unreadRes);
        expect(unreadRes.statusCode).toBe(200);
        expect(unreadRes.body).toEqual({ count: 3 });

        const readRes = createRes();
        await markRead(req, readRes);
        expect(readRes.statusCode).toBe(200);
        expect(notificationService.markAsRead).toHaveBeenCalledWith("n1", "u1");

        const readAllRes = createRes();
        await markAllRead(req, readAllRes);
        expect(readAllRes.statusCode).toBe(200);
        expect(notificationService.markAllAsRead).toHaveBeenCalledWith("u1");

        const clearRes = createRes();
        await clearOne(req, clearRes);
        expect(clearRes.statusCode).toBe(200);
        expect(notificationService.clear).toHaveBeenCalledWith("n1", "u1");

        const clearAllRes = createRes();
        await clearAll(req, clearAllRes);
        expect(clearAllRes.statusCode).toBe(200);
        expect(notificationService.clearAll).toHaveBeenCalledWith("u1");
    });

    it("maps notification endpoint failures to 500 responses", async () => {
        const req = { user: { id: "u1" }, params: { id: "n1" } } as any;

        notificationService.getForUser.mockRejectedValueOnce(new Error("boom"));
        const listErrRes = createRes();
        await getNotifications(req, listErrRes);
        expect(listErrRes.statusCode).toBe(500);
        expect(listErrRes.body).toEqual({
            error: "Failed to fetch notifications",
        });

        notificationService.getUnreadCount.mockRejectedValueOnce(
            new Error("boom"),
        );
        const unreadErrRes = createRes();
        await getUnreadCount(req, unreadErrRes);
        expect(unreadErrRes.statusCode).toBe(500);
        expect(unreadErrRes.body).toEqual({
            error: "Failed to fetch unread count",
        });

        notificationService.markAsRead.mockRejectedValueOnce(new Error("boom"));
        const readErrRes = createRes();
        await markRead(req, readErrRes);
        expect(readErrRes.statusCode).toBe(500);
        expect(readErrRes.body).toEqual({
            error: "Failed to mark notification as read",
        });

        notificationService.markAllAsRead.mockRejectedValueOnce(
            new Error("boom"),
        );
        const readAllErrRes = createRes();
        await markAllRead(req, readAllErrRes);
        expect(readAllErrRes.statusCode).toBe(500);
        expect(readAllErrRes.body).toEqual({
            error: "Failed to mark all notifications as read",
        });

        notificationService.clear.mockRejectedValueOnce(new Error("boom"));
        const clearErrRes = createRes();
        await clearOne(req, clearErrRes);
        expect(clearErrRes.statusCode).toBe(500);
        expect(clearErrRes.body).toEqual({
            error: "Failed to clear notification",
        });

        notificationService.clearAll.mockRejectedValueOnce(new Error("boom"));
        const clearAllErrRes = createRes();
        await clearAll(req, clearAllErrRes);
        expect(clearAllErrRes.statusCode).toBe(500);
        expect(clearAllErrRes.body).toEqual({
            error: "Failed to clear all notifications",
        });

        prisma.downloadJob.findMany.mockRejectedValueOnce(new Error("boom"));
        const historyErrRes = createRes();
        await getDownloadHistory({ user: { id: "u1" } } as any, historyErrRes);
        expect(historyErrRes.statusCode).toBe(500);
        expect(historyErrRes.body).toEqual({
            error: "Failed to fetch download history",
        });

        prisma.downloadJob.findMany.mockRejectedValueOnce(new Error("boom"));
        const activeErrRes = createRes();
        await getActiveDownloads({ user: { id: "u1" } } as any, activeErrRes);
        expect(activeErrRes.statusCode).toBe(500);
        expect(activeErrRes.body).toEqual({
            error: "Failed to fetch active downloads",
        });

        prisma.downloadJob.updateMany.mockRejectedValueOnce(new Error("boom"));
        const clearDownloadErrRes = createRes();
        await clearDownload(
            { user: { id: "u1" }, params: { id: "job-1" } } as any,
            clearDownloadErrRes,
        );
        expect(clearDownloadErrRes.statusCode).toBe(500);
        expect(clearDownloadErrRes.body).toEqual({
            error: "Failed to clear download",
        });

        prisma.downloadJob.updateMany.mockRejectedValueOnce(new Error("boom"));
        const clearAllDownloadsErrRes = createRes();
        await clearAllDownloads(
            { user: { id: "u1" } } as any,
            clearAllDownloadsErrRes,
        );
        expect(clearAllDownloadsErrRes.statusCode).toBe(500);
        expect(clearAllDownloadsErrRes.body).toEqual({
            error: "Failed to clear all downloads",
        });
    });

    it("deduplicates download history by subject and limits output", async () => {
        prisma.downloadJob.findMany.mockResolvedValue(
            Array.from({ length: 55 }).flatMap((_, i) => [
                {
                    id: `job-${i}-new`,
                    subject: `Album-${i}`,
                    status: "failed",
                },
                {
                    id: `job-${i}-old`,
                    subject: `Album-${i}`,
                    status: "completed",
                },
            ]),
        );

        const req = { user: { id: "u1" } } as any;
        const res = createRes();
        await getDownloadHistory(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toHaveLength(50);
        expect(res.body[0].id).toBe("job-0-new");
    });

    it("fetches active downloads and clears download history entries", async () => {
        prisma.downloadJob.findMany.mockResolvedValueOnce([
            { id: "active-1", status: "processing" },
        ]);

        const activeReq = { user: { id: "u1" } } as any;
        const activeRes = createRes();
        await getActiveDownloads(activeReq, activeRes);
        expect(activeRes.statusCode).toBe(200);
        expect(activeRes.body).toEqual([
            { id: "active-1", status: "processing" },
        ]);

        const clearReq = { user: { id: "u1" }, params: { id: "job-1" } } as any;
        const clearRes = createRes();
        await clearDownload(clearReq, clearRes);
        expect(clearRes.statusCode).toBe(200);
        expect(prisma.downloadJob.updateMany).toHaveBeenCalledWith({
            where: {
                id: "job-1",
                userId: "u1",
            },
            data: { cleared: true },
        });

        const clearAllReq = { user: { id: "u1" } } as any;
        const clearAllRes = createRes();
        await clearAllDownloads(clearAllReq, clearAllRes);
        expect(clearAllRes.statusCode).toBe(200);
        expect(prisma.downloadJob.updateMany).toHaveBeenCalledWith({
            where: {
                userId: "u1",
                status: { in: ["completed", "failed", "exhausted"] },
                cleared: false,
            },
            data: { cleared: true },
        });
    });

    it("returns 404 when retry target is missing", async () => {
        prisma.downloadJob.findFirst.mockResolvedValueOnce(null);
        const req = {
            user: { id: "u1" },
            params: { id: "job-missing" },
        } as any;
        const res = createRes();
        await retryDownload(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Download not found or not failed" });
    });

    it("validates pending-track retry metadata and ownership checks", async () => {
        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-1",
            userId: "u1",
            subject: "Artist - Title",
            type: "track",
            targetMbid: "target-1",
            artistMbid: null,
            metadata: { downloadType: "pending-track-retry" },
        });

        const missingMetaReq = {
            user: { id: "u1" },
            params: { id: "job-1" },
        } as any;
        const missingMetaRes = createRes();
        await retryDownload(missingMetaReq, missingMetaRes);
        expect(missingMetaRes.statusCode).toBe(400);

        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-2",
            userId: "u1",
            subject: "Artist - Title",
            type: "track",
            targetMbid: "target-2",
            artistMbid: null,
            metadata: {
                downloadType: "pending-track-retry",
                playlistId: "pl-1",
                pendingTrackId: "pt-1",
            },
        });
        prisma.playlist.findUnique.mockResolvedValueOnce(null);
        const missingPlaylistReq = {
            user: { id: "u1" },
            params: { id: "job-2" },
        } as any;
        const missingPlaylistRes = createRes();
        await retryDownload(missingPlaylistReq, missingPlaylistRes);
        expect(missingPlaylistRes.statusCode).toBe(404);

        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-3",
            userId: "u1",
            subject: "Artist - Title",
            type: "track",
            targetMbid: "target-3",
            artistMbid: null,
            metadata: {
                downloadType: "pending-track-retry",
                playlistId: "pl-1",
                pendingTrackId: "pt-1",
            },
        });
        prisma.playlist.findUnique.mockResolvedValueOnce({
            id: "pl-1",
            userId: "u1",
        });
        prisma.playlistPendingTrack.findUnique.mockResolvedValueOnce(null);
        const missingPendingReq = {
            user: { id: "u1" },
            params: { id: "job-3" },
        } as any;
        const missingPendingRes = createRes();
        await retryDownload(missingPendingReq, missingPendingRes);
        expect(missingPendingRes.statusCode).toBe(404);
    });

    it("handles pending-track retry precondition failures", async () => {
        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-pending",
            userId: "u1",
            subject: "Artist - Title",
            type: "track",
            targetMbid: "target-pending",
            artistMbid: null,
            metadata: {
                downloadType: "pending-track-retry",
                playlistId: "pl-1",
                pendingTrackId: "pt-1",
            },
        });

        getSystemSettings.mockResolvedValueOnce({ musicPath: null });
        const noPathReq = {
            user: { id: "u1" },
            params: { id: "job-pending" },
        } as any;
        const noPathRes = createRes();
        await retryDownload(noPathReq, noPathRes);
        expect(noPathRes.statusCode).toBe(200);
        expect(noPathRes.body).toEqual({
            success: false,
            newJobId: "job-new",
            error: "Music path not configured",
        });

        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-pending-2",
            userId: "u1",
            subject: "Artist - Title",
            type: "track",
            targetMbid: "target-pending-2",
            artistMbid: null,
            metadata: {
                downloadType: "pending-track-retry",
                playlistId: "pl-1",
                pendingTrackId: "pt-1",
            },
        });
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekUsername: null,
            soulseekPassword: null,
        });
        const noCredsReq = {
            user: { id: "u1" },
            params: { id: "job-pending-2" },
        } as any;
        const noCredsRes = createRes();
        await retryDownload(noCredsReq, noCredsRes);
        expect(noCredsRes.statusCode).toBe(200);
        expect(noCredsRes.body.error).toBe(
            "Soulseek credentials not configured",
        );
    });

    it("handles pending-track retry search and background download outcomes", async () => {
        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-pending-search",
            userId: "u1",
            subject: "Artist - Title",
            type: "track",
            targetMbid: "target-pending-search",
            artistMbid: null,
            metadata: {
                downloadType: "pending-track-retry",
                playlistId: "pl-1",
                pendingTrackId: "pt-1",
            },
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-new-search",
            metadata: {},
        });
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekUsername: "user",
            soulseekPassword: "pass",
        });
        soulseekService.searchTrack.mockResolvedValueOnce({
            found: false,
            allMatches: [],
        });

        const noMatchReq = {
            user: { id: "u1" },
            params: { id: "job-pending-search" },
        } as any;
        const noMatchRes = createRes();
        await retryDownload(noMatchReq, noMatchRes);
        expect(noMatchRes.statusCode).toBe(200);
        expect(noMatchRes.body).toEqual({
            success: false,
            newJobId: "job-new-search",
            error: "No matching files found",
        });

        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-pending-success",
            userId: "u1",
            subject: "Artist - Title",
            type: "track",
            targetMbid: "target-pending-success",
            artistMbid: null,
            metadata: {
                downloadType: "pending-track-retry",
                playlistId: "pl-1",
                pendingTrackId: "pt-1",
            },
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-new-success",
            metadata: {},
        });
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekUsername: "user",
            soulseekPassword: "pass",
        });
        soulseekService.searchTrack.mockResolvedValueOnce({
            found: true,
            allMatches: [{ id: "m1" }],
        });
        soulseekService.downloadBestMatch.mockResolvedValueOnce({
            success: true,
            filePath: "/music/Artist/Album/track.flac",
        });
        scanQueue.add.mockResolvedValueOnce({ id: "scan-success" });

        const successReq = {
            user: { id: "u1" },
            params: { id: "job-pending-success" },
        } as any;
        const successRes = createRes();
        await retryDownload(successReq, successRes);
        await flushAsyncWork();
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            success: true,
            newJobId: "job-new-success",
        });
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-new-success" },
                data: expect.objectContaining({
                    status: "completed",
                    metadata: expect.objectContaining({
                        filePath: "/music/Artist/Album/track.flac",
                    }),
                }),
            }),
        );

        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-pending-failed",
            userId: "u1",
            subject: "Artist - Title",
            type: "track",
            targetMbid: "target-pending-failed",
            artistMbid: null,
            metadata: {
                downloadType: "pending-track-retry",
                playlistId: "pl-1",
                pendingTrackId: "pt-1",
            },
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-new-failed",
            metadata: {},
        });
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekUsername: "user",
            soulseekPassword: "pass",
        });
        soulseekService.searchTrack.mockResolvedValueOnce({
            found: true,
            allMatches: [{ id: "m1" }],
        });
        soulseekService.downloadBestMatch.mockResolvedValueOnce({
            success: false,
            error: "download failed",
        });

        const failedReq = {
            user: { id: "u1" },
            params: { id: "job-pending-failed" },
        } as any;
        const failedRes = createRes();
        await retryDownload(failedReq, failedRes);
        await flushAsyncWork();
        expect(failedRes.statusCode).toBe(200);
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-new-failed" },
                data: expect.objectContaining({
                    status: "failed",
                    error: "download failed",
                }),
            }),
        );

        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-pending-throw",
            userId: "u1",
            subject: "Artist - Title",
            type: "track",
            targetMbid: "target-pending-throw",
            artistMbid: null,
            metadata: {
                downloadType: "pending-track-retry",
                playlistId: "pl-1",
                pendingTrackId: "pt-1",
            },
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-new-throw",
            metadata: {},
        });
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekUsername: "user",
            soulseekPassword: "pass",
        });
        soulseekService.searchTrack.mockResolvedValueOnce({
            found: true,
            allMatches: [{ id: "m1" }],
        });
        const pendingRawError =
            "ECONNRESET soulseek-internal token=pending-secret";
        soulseekService.downloadBestMatch.mockRejectedValueOnce(
            new Error(pendingRawError),
        );

        const throwReq = {
            user: { id: "u1" },
            params: { id: "job-pending-throw" },
        } as any;
        const throwRes = createRes();
        await retryDownload(throwReq, throwRes);
        await flushAsyncWork();
        expect(throwRes.statusCode).toBe(200);
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-new-throw" },
                data: expect.objectContaining({
                    status: "failed",
                    error: "Download exception",
                }),
            }),
        );
        expect(
            JSON.stringify(prisma.downloadJob.update.mock.calls),
        ).not.toContain(pendingRawError);
    });

    it("logs when pending-track failure persistence rejects", async () => {
        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-pending-persistence-failed",
            userId: "u1",
            subject: "Artist - Title",
            type: "track",
            targetMbid: "target-pending-persistence-failed",
            artistMbid: null,
            metadata: {
                downloadType: "pending-track-retry",
                playlistId: "pl-1",
                pendingTrackId: "pt-1",
            },
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-new-pending-persistence-failed",
            metadata: {},
        });
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekUsername: "user",
            soulseekPassword: "pass",
        });
        soulseekService.searchTrack.mockResolvedValueOnce({
            found: true,
            allMatches: [{ id: "m1" }],
        });
        soulseekService.downloadBestMatch.mockRejectedValueOnce(
            new Error("download unavailable"),
        );
        const persistenceError = new Error("database unavailable");
        prisma.downloadJob.update
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(persistenceError);
        const req = {
            user: { id: "u1" },
            params: { id: "job-pending-persistence-failed" },
        } as any;
        const res = createRes();

        await retryDownload(req, res);
        await flushAsyncWork();

        expect(res.body).toEqual({
            success: true,
            newJobId: "job-new-pending-persistence-failed",
        });
        expect(mockLogger.error).toHaveBeenCalledWith(
            "[Retry] Failed to persist download exception:",
            persistenceError,
        );
    });

    it("validates spotify_import retries and generic retry MBIDs", async () => {
        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-spotify-1",
            userId: "u1",
            subject: "Artist - Album",
            type: "album",
            targetMbid: "mbid-1",
            artistMbid: "artist-mbid",
            metadata: { downloadType: "spotify_import" },
        });
        const badSpotifyReq = {
            user: { id: "u1" },
            params: { id: "job-spotify-1" },
        } as any;
        const badSpotifyRes = createRes();
        await retryDownload(badSpotifyReq, badSpotifyRes);
        expect(badSpotifyRes.statusCode).toBe(400);

        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-spotify-2",
            userId: "u1",
            subject: "Artist - Album",
            type: "album",
            targetMbid: "mbid-2",
            artistMbid: "artist-mbid",
            metadata: {
                downloadType: "spotify_import",
                artistName: "Artist",
                albumTitle: "Album",
            },
        });
        getSystemSettings.mockResolvedValueOnce({ musicPath: null });
        const noPathSpotifyReq = {
            user: { id: "u1" },
            params: { id: "job-spotify-2" },
        } as any;
        const noPathSpotifyRes = createRes();
        await retryDownload(noPathSpotifyReq, noPathSpotifyRes);
        expect(noPathSpotifyRes.statusCode).toBe(200);
        expect(noPathSpotifyRes.body).toEqual({
            success: false,
            newJobId: "job-new",
            error: "Music path not configured",
        });

        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-generic-no-mbid",
            userId: "u1",
            subject: "Artist - Album",
            type: "album",
            targetMbid: null,
            artistMbid: "artist-mbid",
            metadata: {},
        });
        const noMbidReq = {
            user: { id: "u1" },
            params: { id: "job-generic-no-mbid" },
        } as any;
        const noMbidRes = createRes();
        await retryDownload(noMbidReq, noMbidRes);
        expect(noMbidRes.statusCode).toBe(400);
        expect(noMbidRes.body.error).toBe("Cannot retry: missing album MBID");
    });

    it("handles spotify_import retry async success/fallback/catch branches", async () => {
        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-spotify-success",
            userId: "u1",
            subject: "Artist - Album",
            type: "album",
            targetMbid: "mbid-spotify-success",
            artistMbid: "artist-mbid",
            metadata: {
                downloadType: "spotify_import",
                artistName: "Artist",
                albumTitle: "Album",
            },
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-new-spotify-success",
            metadata: {},
        });
        getSystemSettings.mockResolvedValueOnce({
            musicPath: "/music",
            soulseekConcurrentDownloads: 3,
        });
        soulseekService.searchAndDownloadBatch.mockResolvedValueOnce({
            successful: 1,
            files: ["/music/Artist/Album/track.flac"],
        });
        scanQueue.add.mockResolvedValueOnce({ id: "scan-spotify" });

        const successReq = {
            user: { id: "u1" },
            params: { id: "job-spotify-success" },
        } as any;
        const successRes = createRes();
        await retryDownload(successReq, successRes);
        await flushAsyncWork();
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            success: true,
            newJobId: "job-new-spotify-success",
        });
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-new-spotify-success" },
                data: expect.objectContaining({
                    status: "completed",
                    metadata: expect.objectContaining({
                        source: "soulseek",
                        tracksDownloaded: 1,
                    }),
                }),
            }),
        );

        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-spotify-lidarr-fail",
            userId: "u1",
            subject: "Artist - Album",
            type: "album",
            targetMbid: "mbid-spotify-lidarr-fail",
            artistMbid: "artist-mbid",
            metadata: {
                downloadType: "spotify_import",
                artistName: "Artist",
                albumTitle: "Album",
            },
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-new-spotify-lidarr-fail",
            metadata: {},
        });
        getSystemSettings.mockResolvedValueOnce({ musicPath: "/music" });
        soulseekService.searchAndDownloadBatch.mockResolvedValueOnce({
            successful: 0,
            files: [],
        });
        const lidarrFailReq = {
            user: { id: "u1" },
            params: { id: "job-spotify-lidarr-fail" },
        } as any;
        const lidarrFailRes = createRes();
        await retryDownload(lidarrFailReq, lidarrFailRes);
        await flushAsyncWork();
        expect(lidarrFailRes.statusCode).toBe(200);
        expect(dispatchAlbumDownload).toHaveBeenCalledWith({
            jobId: "job-new-spotify-lidarr-fail",
            type: "album",
            mbid: "mbid-spotify-lidarr-fail",
            subject: "Artist - Album",
            artistName: "Artist",
            albumTitle: "Album",
        });
        expect(simpleDownloadManager.startDownload).not.toHaveBeenCalled();

        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-spotify-no-mbid",
            userId: "u1",
            subject: "Artist - Album",
            type: "album",
            targetMbid: "retry_123",
            artistMbid: "artist-mbid",
            metadata: {
                downloadType: "spotify_import",
                artistName: "Artist",
                albumTitle: "Album",
            },
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-new-spotify-no-mbid",
            metadata: {},
        });
        getSystemSettings.mockResolvedValueOnce({ musicPath: "/music" });
        soulseekService.searchAndDownloadBatch.mockResolvedValueOnce({
            successful: 0,
            files: [],
        });

        const noMbidFallbackReq = {
            user: { id: "u1" },
            params: { id: "job-spotify-no-mbid" },
        } as any;
        const noMbidFallbackRes = createRes();
        await retryDownload(noMbidFallbackReq, noMbidFallbackRes);
        await flushAsyncWork();
        expect(noMbidFallbackRes.statusCode).toBe(200);
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-new-spotify-no-mbid" },
                data: expect.objectContaining({
                    status: "failed",
                    error: "No tracks found on Soulseek, no MBID for Lidarr fallback",
                }),
            }),
        );

        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-spotify-catch",
            userId: "u1",
            subject: "Artist - Album",
            type: "album",
            targetMbid: "mbid-spotify-catch",
            artistMbid: "artist-mbid",
            metadata: {
                downloadType: "spotify_import",
                artistName: "Artist",
                albumTitle: "Album",
            },
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-new-spotify-catch",
            metadata: {},
        });
        getSystemSettings.mockResolvedValueOnce({ musicPath: "/music" });
        const spotifyRawError =
            "ECONNREFUSED soulseek-internal token=spotify-secret";
        soulseekService.searchAndDownloadBatch.mockRejectedValueOnce(
            new Error(spotifyRawError),
        );

        const catchReq = {
            user: { id: "u1" },
            params: { id: "job-spotify-catch" },
        } as any;
        const catchRes = createRes();
        await retryDownload(catchReq, catchRes);
        await flushAsyncWork();
        expect(catchRes.statusCode).toBe(200);
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-new-spotify-catch" },
                data: expect.objectContaining({
                    status: "failed",
                    error: "Soulseek error",
                }),
            }),
        );
        expect(
            JSON.stringify(prisma.downloadJob.update.mock.calls),
        ).not.toContain(spotifyRawError);
    });

    it("attributes spotify_import fallback dispatch rejection to dispatch", async () => {
        prepareSpotifyImportFallback("spotify-dispatch-failed");
        const dispatchError = new Error("configured source unavailable");
        dispatchAlbumDownload.mockRejectedValueOnce(dispatchError);
        const req = {
            user: { id: "u1" },
            params: { id: "job-spotify-dispatch-failed" },
        } as any;
        const res = createRes();

        const unhandledRejections = await captureUnhandledRejections(
            async () => {
                await retryDownload(req, res);
            },
        );

        expect(res.statusCode).toBe(200);
        expect(prisma.downloadJob.update).toHaveBeenCalledWith({
            where: { id: "job-new-spotify-dispatch-failed" },
            data: {
                status: "failed",
                error: "Download dispatch failed",
                completedAt: expect.any(Date),
            },
        });
        expect(prisma.downloadJob.update).not.toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ error: "Soulseek error" }),
            }),
        );
        expect(mockLogger.error).toHaveBeenCalledWith(
            "[Retry] Album dispatch error:",
            dispatchError,
        );
        expect(unhandledRejections).toEqual([]);
    });

    it("observes spotify_import fallback failure-persistence rejection", async () => {
        prepareSpotifyImportFallback("spotify-dispatch-persistence-failed");
        const persistenceError = new Error("database unavailable");
        dispatchAlbumDownload.mockRejectedValueOnce(
            new Error("configured source unavailable"),
        );
        prisma.downloadJob.update
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(persistenceError);
        const req = {
            user: { id: "u1" },
            params: { id: "job-spotify-dispatch-persistence-failed" },
        } as any;
        const res = createRes();

        const unhandledRejections = await captureUnhandledRejections(
            async () => {
                await retryDownload(req, res);
            },
        );

        expect(mockLogger.error).toHaveBeenCalledWith(
            "[Retry] Failed to persist album dispatch failure:",
            persistenceError,
        );
        expect(unhandledRejections).toEqual([]);
    });

    it("logs when spotify_import failure persistence rejects", async () => {
        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-spotify-persistence-failed",
            userId: "u1",
            subject: "Artist - Album",
            type: "album",
            targetMbid: "mbid-spotify-persistence-failed",
            artistMbid: "artist-mbid",
            metadata: {
                downloadType: "spotify_import",
                artistName: "Artist",
                albumTitle: "Album",
            },
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-new-spotify-persistence-failed",
            metadata: {},
        });
        getSystemSettings.mockResolvedValueOnce({ musicPath: "/music" });
        soulseekService.searchAndDownloadBatch.mockRejectedValueOnce(
            new Error("soulseek unavailable"),
        );
        const persistenceError = new Error("database unavailable");
        prisma.downloadJob.update
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(persistenceError);
        const req = {
            user: { id: "u1" },
            params: { id: "job-spotify-persistence-failed" },
        } as any;
        const res = createRes();

        await retryDownload(req, res);
        await flushAsyncWork();

        expect(res.body).toEqual({
            success: true,
            newJobId: "job-new-spotify-persistence-failed",
        });
        expect(mockLogger.error).toHaveBeenCalledWith(
            "[Retry] Failed to persist Soulseek error:",
            persistenceError,
        );
    });

    it("returns 500 when retry handler throws unexpectedly", async () => {
        prisma.downloadJob.findFirst.mockRejectedValueOnce(
            new Error("db exploded"),
        );
        const req = { user: { id: "u1" }, params: { id: "job-any" } } as any;
        const res = createRes();
        await retryDownload(req, res);
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to retry download" });
    });
});
