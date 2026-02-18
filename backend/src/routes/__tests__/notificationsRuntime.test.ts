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

import router from "../notifications";

function getHandler(
    path: string,
    method: "get" | "post" | "put" | "delete"
) {
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

async function flushAsyncWork() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
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
        expect(listErrRes.body).toEqual({ error: "Failed to fetch notifications" });

        notificationService.getUnreadCount.mockRejectedValueOnce(new Error("boom"));
        const unreadErrRes = createRes();
        await getUnreadCount(req, unreadErrRes);
        expect(unreadErrRes.statusCode).toBe(500);
        expect(unreadErrRes.body).toEqual({ error: "Failed to fetch unread count" });

        notificationService.markAsRead.mockRejectedValueOnce(new Error("boom"));
        const readErrRes = createRes();
        await markRead(req, readErrRes);
        expect(readErrRes.statusCode).toBe(500);
        expect(readErrRes.body).toEqual({
            error: "Failed to mark notification as read",
        });

        notificationService.markAllAsRead.mockRejectedValueOnce(new Error("boom"));
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
        expect(clearErrRes.body).toEqual({ error: "Failed to clear notification" });

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
            clearDownloadErrRes
        );
        expect(clearDownloadErrRes.statusCode).toBe(500);
        expect(clearDownloadErrRes.body).toEqual({
            error: "Failed to clear download",
        });

        prisma.downloadJob.updateMany.mockRejectedValueOnce(new Error("boom"));
        const clearAllDownloadsErrRes = createRes();
        await clearAllDownloads(
            { user: { id: "u1" } } as any,
            clearAllDownloadsErrRes
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
            ])
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
        expect(activeRes.body).toEqual([{ id: "active-1", status: "processing" }]);

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
        const req = { user: { id: "u1" }, params: { id: "job-missing" } } as any;
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

        const missingMetaReq = { user: { id: "u1" }, params: { id: "job-1" } } as any;
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
            "Soulseek credentials not configured"
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

        const noMatchReq = { user: { id: "u1" }, params: { id: "job-pending-search" } } as any;
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
            })
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
            })
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
        soulseekService.downloadBestMatch.mockRejectedValueOnce(
            new Error("socket closed"),
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
                    error: "socket closed",
                }),
            })
        );
    });

    it("validates spotify_import retries and generic retries", async () => {
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

        prisma.downloadJob.findFirst.mockResolvedValueOnce({
            id: "job-generic",
            userId: "u1",
            subject: "Artist - Album",
            type: "album",
            targetMbid: "mbid-generic",
            artistMbid: "artist-mbid",
            metadata: { albumTitle: "Album" },
        });
        prisma.downloadJob.create.mockResolvedValueOnce({
            id: "job-new-generic",
            metadata: {},
        });
        simpleDownloadManager.startDownload.mockResolvedValueOnce({
            success: true,
            error: null,
        });
        const genericReq = {
            user: { id: "u1" },
            params: { id: "job-generic" },
        } as any;
        const genericRes = createRes();
        await retryDownload(genericReq, genericRes);
        expect(genericRes.statusCode).toBe(200);
        expect(genericRes.body).toEqual({
            success: true,
            newJobId: "job-new-generic",
            error: null,
        });
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
            })
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
        simpleDownloadManager.startDownload.mockResolvedValueOnce({
            success: false,
            error: "lidarr failed",
        });

        const lidarrFailReq = {
            user: { id: "u1" },
            params: { id: "job-spotify-lidarr-fail" },
        } as any;
        const lidarrFailRes = createRes();
        await retryDownload(lidarrFailReq, lidarrFailRes);
        await flushAsyncWork();
        expect(lidarrFailRes.statusCode).toBe(200);
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-new-spotify-lidarr-fail" },
                data: expect.objectContaining({
                    status: "failed",
                    error: "lidarr failed",
                }),
            })
        );

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
            })
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
        soulseekService.searchAndDownloadBatch.mockRejectedValueOnce(
            new Error("soulseek crashed"),
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
                    error: "soulseek crashed",
                }),
            })
        );
    });

    it("returns 500 when retry handler throws unexpectedly", async () => {
        prisma.downloadJob.findFirst.mockRejectedValueOnce(new Error("db exploded"));
        const req = { user: { id: "u1" }, params: { id: "job-any" } } as any;
        const res = createRes();
        await retryDownload(req, res);
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to retry download" });
    });
});
