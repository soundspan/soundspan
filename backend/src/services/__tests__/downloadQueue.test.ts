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
        downloadJob: {
            findMany: jest.fn(),
            updateMany: jest.fn(),
            findFirst: jest.fn(),
            update: jest.fn(),
            create: jest.fn(),
        },
        discoveryAlbum: {
            updateMany: jest.fn(),
        },
        user: {
            findFirst: jest.fn(),
        },
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../workers/queues", () => ({
    scanQueue: {
        add: jest.fn(),
    },
}));

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        get: jest.fn(),
        post: jest.fn(),
        delete: jest.fn(),
    },
}));

async function loadHarness() {
    jest.resetModules();

    const { downloadQueueManager } = await import("../downloadQueue");
    const { prisma } = await import("../../utils/db");
    const { getSystemSettings } = await import("../../utils/systemSettings");
    const { scanQueue } = await import("../../workers/queues");
    const axios = (await import("axios")).default as any;

    return {
        manager: downloadQueueManager as any,
        prisma,
        getSystemSettings: getSystemSettings as jest.Mock,
        scanQueue,
        axios,
    };
}

describe("downloadQueueManager", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    it("tracks new downloads and starts timeout for first active job", async () => {
        const { manager } = await loadHarness();
        const linkSpy = jest
            .spyOn(manager as any, "linkDownloadJob")
            .mockResolvedValue(undefined);
        const startTimeoutSpy = jest.spyOn(manager as any, "startTimeout");

        manager.addDownload(
            "dl-1",
            "Album One",
            "mbid-1",
            "Artist One",
            11,
            22,
            { userId: "u1", artistMbid: "artist-mbid-1", tier: "top" }
        );

        const status = manager.getStatus();
        expect(status.activeDownloads).toBe(1);
        expect(status.timeoutActive).toBe(true);
        expect(startTimeoutSpy).toHaveBeenCalledTimes(1);
        expect(linkSpy).toHaveBeenCalledWith("dl-1", "mbid-1");

        manager.shutdown();
    });

    it("completes downloads and triggers full refresh when queue empties", async () => {
        const { manager } = await loadHarness();
        jest.spyOn(manager as any, "linkDownloadJob").mockResolvedValue(undefined);
        const refreshSpy = jest
            .spyOn(manager as any, "triggerFullRefresh")
            .mockResolvedValue(undefined);

        manager.addDownload("dl-1", "Album", "mbid", "Artist");
        await manager.completeDownload("dl-1", "Album");

        const status = manager.getStatus();
        expect(status.activeDownloads).toBe(0);
        expect(status.timeoutActive).toBe(false);
        expect(refreshSpy).toHaveBeenCalledTimes(1);

        manager.shutdown();
    });

    it("retries failed downloads before max attempts", async () => {
        const { manager } = await loadHarness();
        jest.spyOn(manager as any, "linkDownloadJob").mockResolvedValue(undefined);
        const retrySpy = jest
            .spyOn(manager as any, "retryDownload")
            .mockResolvedValue(undefined);

        manager.addDownload("dl-2", "Album 2", "mbid-2", "Artist 2");
        await manager.failDownload("dl-2", "network error");

        const active = manager.getActiveDownloads().get("dl-2");
        expect(retrySpy).toHaveBeenCalledTimes(1);
        expect(active.attempts).toBe(2);
        expect(manager.getStatus().activeDownloads).toBe(1);

        manager.shutdown();
    });

    it("ignores failDownload for untracked IDs", async () => {
        const { manager } = await loadHarness();
        const retrySpy = jest
            .spyOn(manager as any, "retryDownload")
            .mockResolvedValue(undefined);
        const cleanupSpy = jest
            .spyOn(manager as any, "cleanupFailedAlbum")
            .mockResolvedValue(undefined);
        const refreshSpy = jest
            .spyOn(manager as any, "triggerFullRefresh")
            .mockResolvedValue(undefined);

        await manager.failDownload("missing-download", "not tracked");

        expect(retrySpy).not.toHaveBeenCalled();
        expect(cleanupSpy).not.toHaveBeenCalled();
        expect(refreshSpy).not.toHaveBeenCalled();
        expect(manager.getStatus().activeDownloads).toBe(0);

        manager.shutdown();
    });

    it("gives up after max retries, cleans up, and refreshes when done", async () => {
        const { manager } = await loadHarness();
        jest.spyOn(manager as any, "linkDownloadJob").mockResolvedValue(undefined);
        const cleanupSpy = jest
            .spyOn(manager as any, "cleanupFailedAlbum")
            .mockResolvedValue(undefined);
        const refreshSpy = jest
            .spyOn(manager as any, "triggerFullRefresh")
            .mockResolvedValue(undefined);

        manager.addDownload("dl-3", "Album 3", "mbid-3", "Artist 3");
        const info = manager.getActiveDownloads().get("dl-3");
        info.attempts = 3;

        await manager.failDownload("dl-3", "permanent failure");

        expect(cleanupSpy).toHaveBeenCalledTimes(1);
        expect(manager.getStatus().activeDownloads).toBe(0);
        expect(refreshSpy).toHaveBeenCalledTimes(1);

        manager.shutdown();
    });

    it("returns early from retryDownload when Lidarr settings are incomplete", async () => {
        const { manager, getSystemSettings, axios } = await loadHarness();

        getSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "",
            lidarrApiKey: "",
        });

        await (manager as any).retryDownload({
            downloadId: "dl-retry-missing-settings",
            albumTitle: "Album",
            albumMbid: "mbid",
            artistName: "Artist",
            albumId: 42,
            attempts: 1,
            startTime: Date.now(),
        });

        expect(axios.post).not.toHaveBeenCalled();

        manager.shutdown();
    });

    it("cleanupFailedAlbum notifies all callbacks with metadata payload", async () => {
        const { manager, getSystemSettings, prisma } = await loadHarness();
        const mockUpdateMany = prisma.discoveryAlbum.updateMany as jest.Mock;

        getSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr.local",
            lidarrApiKey: "test-api-key",
        });
        mockUpdateMany.mockResolvedValue({ count: 1 });

        const failingCallback = jest
            .fn()
            .mockRejectedValue(new Error("callback failure"));
        const successfulCallback = jest.fn().mockResolvedValue(undefined);

        manager.onUnavailableAlbum(failingCallback);
        manager.onUnavailableAlbum(successfulCallback);

        const info = {
            downloadId: "dl-cleanup",
            albumTitle: "Failed Album",
            albumMbid: "failed-mbid",
            artistName: "Failed Artist",
            artistMbid: "artist-mbid",
            attempts: 3,
            startTime: Date.now(),
            userId: "user-42",
            tier: "recommended",
            similarity: 0.91,
        };

        await (manager as any).cleanupFailedAlbum(info);

        expect(mockUpdateMany).toHaveBeenCalledWith({
            where: { albumTitle: "Failed Album" },
            data: { status: "DELETED" },
        });
        expect(failingCallback).toHaveBeenCalledWith({
            albumTitle: "Failed Album",
            artistName: "Failed Artist",
            albumMbid: "failed-mbid",
            artistMbid: "artist-mbid",
            userId: "user-42",
            tier: "recommended",
            similarity: 0.91,
        });
        expect(successfulCallback).toHaveBeenCalledWith({
            albumTitle: "Failed Album",
            artistName: "Failed Artist",
            albumMbid: "failed-mbid",
            artistMbid: "artist-mbid",
            userId: "user-42",
            tier: "recommended",
            similarity: 0.91,
        });

        manager.shutdown();
    });

    it("cleans stale in-memory downloads", async () => {
        const { manager } = await loadHarness();
        jest.spyOn(manager as any, "linkDownloadJob").mockResolvedValue(undefined);

        manager.addDownload("fresh", "Fresh Album", "fresh-mbid", "Fresh Artist");
        manager.addDownload("stale", "Stale Album", "stale-mbid", "Stale Artist");

        const staleInfo = manager.getActiveDownloads().get("stale");
        staleInfo.startTime = Date.now() - 31 * 60 * 1000;

        const cleaned = manager.cleanupStaleDownloads();

        expect(cleaned).toBe(1);
        expect(manager.getActiveDownloads().has("fresh")).toBe(true);
        expect(manager.getActiveDownloads().has("stale")).toBe(false);

        manager.shutdown();
    });

    it("returns zero when cleanupStaleDownloads finds no stale entries", async () => {
        const { manager } = await loadHarness();
        jest.spyOn(manager as any, "linkDownloadJob").mockResolvedValue(undefined);

        manager.addDownload("fresh-1", "Fresh Album 1", "fresh-mbid-1", "Artist 1");
        manager.addDownload("fresh-2", "Fresh Album 2", "fresh-mbid-2", "Artist 2");

        const cleaned = manager.cleanupStaleDownloads();

        expect(cleaned).toBe(0);
        expect(manager.getActiveDownloads().size).toBe(2);

        manager.shutdown();
    });

    it("reconciles startup state from database jobs", async () => {
        const { manager, prisma } = await loadHarness();
        const mockUpdateMany = prisma.downloadJob.updateMany as jest.Mock;
        const mockFindMany = prisma.downloadJob.findMany as jest.Mock;

        mockUpdateMany.mockResolvedValue({ count: 2 });
        mockFindMany.mockResolvedValue([
            {
                id: "job-1",
                subject: "Artist - Album",
                targetMbid: "mbid-100",
                lidarrRef: "lidarr-100",
                metadata: {
                    artistName: "Artist",
                    artistMbid: "artist-mbid",
                    lidarrAlbumId: 99,
                    lidarrArtistId: 77,
                    userId: "u100",
                    tier: "recommended",
                    similarity: 0.88,
                },
                startedAt: new Date("2026-02-17T10:00:00.000Z"),
                attempts: 2,
            },
        ]);

        const result = await manager.reconcileOnStartup();

        expect(result).toEqual({ loaded: 1, failed: 2 });
        expect(manager.getActiveDownloads().has("lidarr-100")).toBe(true);
        expect(mockUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ status: "processing" }),
                data: expect.objectContaining({ status: "failed" }),
            })
        );

        manager.shutdown();
    });

    it("manualRefresh delegates to full refresh", async () => {
        const { manager } = await loadHarness();
        const refreshSpy = jest
            .spyOn(manager as any, "triggerFullRefresh")
            .mockResolvedValue(undefined);

        await manager.manualRefresh();
        expect(refreshSpy).toHaveBeenCalledTimes(1);

        manager.shutdown();
    });

    it("linkDownloadJob updates matching pending jobs", async () => {
        const { manager, prisma } = await loadHarness();
        const mockFindMany = prisma.downloadJob.findMany as jest.Mock;
        const mockUpdateMany = prisma.downloadJob.updateMany as jest.Mock;

        mockFindMany.mockResolvedValue([
            { id: "j1", status: "pending", lidarrRef: null, targetMbid: "mbid-1" },
        ]);
        mockUpdateMany.mockResolvedValue({ count: 1 });

        await (manager as any).linkDownloadJob("lidarr-dl-1", "mbid-1");

        expect(mockUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    targetMbid: "mbid-1",
                    status: { in: ["pending", "processing"] },
                }),
                data: expect.objectContaining({
                    lidarrRef: "lidarr-dl-1",
                    status: "processing",
                }),
            })
        );

        manager.shutdown();
    });

    it("triggerLibrarySync queues a scan job for first user", async () => {
        const { manager, prisma, scanQueue } = await loadHarness();
        const mockFindFirst = prisma.user.findFirst as jest.Mock;
        const scanAdd = scanQueue.add as jest.Mock;

        mockFindFirst.mockResolvedValue({ id: "user-1" });
        scanAdd.mockResolvedValue({});

        const result = await (manager as any).triggerLibrarySync();

        expect(result).toBe(true);
        expect(scanAdd).toHaveBeenCalledWith(
            "scan",
            expect.objectContaining({
                userId: "user-1",
                source: "download-queue",
            })
        );

        manager.shutdown();
    });

    it("triggerLibrarySync returns false when no users exist", async () => {
        const { manager, prisma, scanQueue } = await loadHarness();
        const mockFindFirst = prisma.user.findFirst as jest.Mock;
        const scanAdd = scanQueue.add as jest.Mock;

        mockFindFirst.mockResolvedValue(null);

        const result = await (manager as any).triggerLibrarySync();

        expect(result).toBe(false);
        expect(scanAdd).not.toHaveBeenCalled();

        manager.shutdown();
    });

    it("triggerLibrarySync returns false when queueing scan throws", async () => {
        const { manager, prisma, scanQueue } = await loadHarness();
        const mockFindFirst = prisma.user.findFirst as jest.Mock;
        const scanAdd = scanQueue.add as jest.Mock;

        mockFindFirst.mockResolvedValue({ id: "user-1" });
        scanAdd.mockRejectedValue(new Error("queue unavailable"));

        const result = await (manager as any).triggerLibrarySync();

        expect(result).toBe(false);
        expect(scanAdd).toHaveBeenCalledWith(
            "scan",
            expect.objectContaining({
                userId: "user-1",
                source: "download-queue",
            })
        );

        manager.shutdown();
    });

    it("linkDownloadJob no-ops cleanly when there are no candidate jobs", async () => {
        const { manager, prisma } = await loadHarness();
        const mockFindMany = prisma.downloadJob.findMany as jest.Mock;
        const mockUpdateMany = prisma.downloadJob.updateMany as jest.Mock;

        mockFindMany.mockResolvedValue([]);
        mockUpdateMany.mockResolvedValue({ count: 0 });

        await (manager as any).linkDownloadJob("lidarr-empty", "mbid-empty");

        expect(mockFindMany).toHaveBeenCalledWith({
            where: { targetMbid: "mbid-empty" },
            select: {
                id: true,
                status: true,
                lidarrRef: true,
                targetMbid: true,
            },
        });
        expect(mockUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    targetMbid: "mbid-empty",
                }),
            })
        );

        manager.shutdown();
    });

    it("timeout callback triggers refresh when timer expires with empty queue", async () => {
        const { manager } = await loadHarness();
        const refreshSpy = jest
            .spyOn(manager as any, "triggerFullRefresh")
            .mockResolvedValue(undefined);

        (manager as any).startTimeout();
        jest.advanceTimersByTime(10 * 60 * 1000);
        await Promise.resolve();

        expect(refreshSpy).toHaveBeenCalledTimes(1);

        manager.shutdown();
    });

    it("shutdown clears timers and active state", async () => {
        const { manager } = await loadHarness();
        jest.spyOn(manager as any, "linkDownloadJob").mockResolvedValue(undefined);
        manager.addDownload("dl-shutdown", "Album", "mbid", "Artist");

        manager.shutdown();
        const status = manager.getStatus();

        expect(status.activeDownloads).toBe(0);
        expect(status.timeoutActive).toBe(false);
    });

    it("addDownload tolerates asynchronous link failures", async () => {
        const { manager } = await loadHarness();
        jest.spyOn(manager as any, "linkDownloadJob").mockRejectedValue(new Error("link failed"));

        manager.addDownload("dl-link-fail", "Album", "mbid", "Artist");
        await Promise.resolve();

        expect(manager.getStatus().activeDownloads).toBe(1);
        manager.shutdown();
    });

    it("clears unavailable album callbacks", async () => {
        const { manager } = await loadHarness();
        manager.onUnavailableAlbum(jest.fn());
        manager.onUnavailableAlbum(jest.fn());

        manager.clearUnavailableCallbacks();

        expect((manager as any).unavailableCallbacks).toHaveLength(0);
        manager.shutdown();
    });

    it("retryDownload returns early when albumId is missing", async () => {
        const { manager, getSystemSettings, axios } = await loadHarness();

        getSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr.local",
            lidarrApiKey: "api-key",
        });

        await (manager as any).retryDownload({
            downloadId: "dl-no-album-id",
            albumTitle: "Album",
            albumMbid: "mbid",
            artistName: "Artist",
            attempts: 1,
            startTime: Date.now(),
        });

        expect(axios.post).not.toHaveBeenCalled();
        manager.shutdown();
    });

    it("retryDownload triggers Lidarr album search when settings are complete", async () => {
        const { manager, getSystemSettings, axios } = await loadHarness();

        getSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr.local",
            lidarrApiKey: "api-key",
        });
        axios.post.mockResolvedValue({});

        await (manager as any).retryDownload({
            downloadId: "dl-retry-ok",
            albumTitle: "Album",
            albumMbid: "mbid",
            artistName: "Artist",
            albumId: 777,
            attempts: 2,
            startTime: Date.now(),
        });

        expect(axios.post).toHaveBeenCalledWith(
            "http://lidarr.local/api/v1/command",
            {
                name: "AlbumSearch",
                albumIds: [777],
            },
            expect.objectContaining({
                headers: { "X-Api-Key": "api-key" },
                timeout: 10000,
            }),
        );
        manager.shutdown();
    });

    it("retryDownload swallows Lidarr command errors", async () => {
        const { manager, getSystemSettings, axios } = await loadHarness();

        getSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr.local",
            lidarrApiKey: "api-key",
        });
        axios.post.mockRejectedValue(new Error("command failed"));

        await expect(
            (manager as any).retryDownload({
                downloadId: "dl-retry-error",
                albumTitle: "Album",
                albumMbid: "mbid",
                artistName: "Artist",
                albumId: 888,
                attempts: 2,
                startTime: Date.now(),
            }),
        ).resolves.toBeUndefined();

        manager.shutdown();
    });

    it("cleanupFailedAlbum returns early when Lidarr is not configured", async () => {
        const { manager, getSystemSettings, prisma } = await loadHarness();
        const mockUpdateMany = prisma.discoveryAlbum.updateMany as jest.Mock;

        getSystemSettings.mockResolvedValue({
            lidarrEnabled: false,
            lidarrUrl: "",
            lidarrApiKey: "",
        });

        await (manager as any).cleanupFailedAlbum({
            downloadId: "dl-cleanup-skip",
            albumTitle: "Album",
            albumMbid: "mbid",
            artistName: "Artist",
            attempts: 3,
            startTime: Date.now(),
        });

        expect(mockUpdateMany).not.toHaveBeenCalled();
        manager.shutdown();
    });

    it("cleanupFailedAlbum continues when album or artist removal fails", async () => {
        const { manager, getSystemSettings, prisma, axios } = await loadHarness();
        const mockUpdateMany = prisma.discoveryAlbum.updateMany as jest.Mock;

        getSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr.local",
            lidarrApiKey: "api-key",
        });
        axios.delete
            .mockRejectedValueOnce(new Error("album delete failed"))
            .mockRejectedValueOnce(new Error("artist delete failed"));
        axios.get.mockResolvedValue({
            data: {
                albums: [],
            },
        });
        mockUpdateMany.mockResolvedValue({ count: 1 });

        await expect(
            (manager as any).cleanupFailedAlbum({
                downloadId: "dl-cleanup-errors",
                albumTitle: "Album",
                albumMbid: "mbid",
                artistName: "Artist",
                albumId: 10,
                artistId: 20,
                attempts: 3,
                startTime: Date.now(),
            }),
        ).resolves.toBeUndefined();

        expect(mockUpdateMany).toHaveBeenCalledWith({
            where: { albumTitle: "Album" },
            data: { status: "DELETED" },
        });
        manager.shutdown();
    });

    it("cleanupFailedAlbum catches top-level cleanup errors", async () => {
        const { manager, getSystemSettings, prisma } = await loadHarness();
        const mockUpdateMany = prisma.discoveryAlbum.updateMany as jest.Mock;

        getSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr.local",
            lidarrApiKey: "api-key",
        });
        mockUpdateMany.mockRejectedValue(new Error("db write failed"));

        await expect(
            (manager as any).cleanupFailedAlbum({
                downloadId: "dl-cleanup-top-level",
                albumTitle: "Album",
                albumMbid: "mbid",
                artistName: "Artist",
                attempts: 3,
                startTime: Date.now(),
            }),
        ).resolves.toBeUndefined();

        manager.shutdown();
    });

    it("timeout callback marks pending downloads as failed before continuing", async () => {
        const { manager } = await loadHarness();
        jest.spyOn(manager as any, "linkDownloadJob").mockResolvedValue(undefined);
        const failSpy = jest
            .spyOn(manager as any, "failDownload")
            .mockResolvedValue(undefined);

        manager.addDownload("dl-timeout-1", "Album 1", "mbid-1", "Artist 1");
        manager.addDownload("dl-timeout-2", "Album 2", "mbid-2", "Artist 2");

        (manager as any).startTimeout();
        jest.advanceTimersByTime(10 * 60 * 1000);
        await Promise.resolve();

        expect(failSpy).toHaveBeenCalledWith(
            "dl-timeout-1",
            "Download timeout - never completed",
        );
        expect(failSpy).toHaveBeenCalledWith(
            "dl-timeout-2",
            "Download timeout - never completed",
        );
        manager.shutdown();
    });

    it("triggerFullRefresh runs Lidarr cleanup and soundspan sync when successful", async () => {
        const { manager } = await loadHarness();
        const clearSpy = jest
            .spyOn(manager as any, "clearFailedLidarrImports")
            .mockResolvedValue(undefined);
        const syncSpy = jest
            .spyOn(manager as any, "triggerLibrarySync")
            .mockResolvedValue(true);

        await (manager as any).triggerFullRefresh();

        expect(clearSpy).toHaveBeenCalledTimes(1);
        expect(syncSpy).toHaveBeenCalledTimes(1);
        manager.shutdown();
    });

    it("triggerFullRefresh exits early when soundspan sync fails", async () => {
        const { manager } = await loadHarness();
        const clearSpy = jest
            .spyOn(manager as any, "clearFailedLidarrImports")
            .mockResolvedValue(undefined);
        const syncSpy = jest
            .spyOn(manager as any, "triggerLibrarySync")
            .mockResolvedValue(false);

        await (manager as any).triggerFullRefresh();

        expect(clearSpy).toHaveBeenCalledTimes(1);
        expect(syncSpy).toHaveBeenCalledTimes(1);
        manager.shutdown();
    });

    it("clearFailedLidarrImports skips when Lidarr is not configured", async () => {
        const { manager, getSystemSettings, axios } = await loadHarness();
        getSystemSettings.mockResolvedValue({
            lidarrEnabled: false,
            lidarrUrl: "",
            lidarrApiKey: "",
        });

        await (manager as any).clearFailedLidarrImports();

        expect(axios.get).not.toHaveBeenCalled();
        manager.shutdown();
    });

    it("clearFailedLidarrImports skips when Lidarr API key is missing", async () => {
        const { manager, getSystemSettings, axios } = await loadHarness();
        getSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr.local",
            lidarrApiKey: "",
        });

        await (manager as any).clearFailedLidarrImports();

        expect(axios.get).not.toHaveBeenCalled();
        manager.shutdown();
    });

    it("clearFailedLidarrImports returns when queue has no failed imports", async () => {
        const { manager, getSystemSettings, axios } = await loadHarness();
        getSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr.local",
            lidarrApiKey: "api-key",
        });
        axios.get.mockResolvedValue({
            data: {
                records: [{ status: "completed", trackedDownloadStatus: "ok" }],
            },
        });

        await (manager as any).clearFailedLidarrImports();

        expect(axios.delete).not.toHaveBeenCalled();
        expect(axios.post).not.toHaveBeenCalled();
        manager.shutdown();
    });

    it("clearFailedLidarrImports removes failed queue entries and retriggers searchable albums", async () => {
        const { manager, getSystemSettings, axios } = await loadHarness();
        getSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr.local",
            lidarrApiKey: "api-key",
        });
        axios.get.mockResolvedValue({
            data: {
                records: [
                    {
                        id: 1,
                        trackedDownloadStatus: "error",
                        artist: { artistName: "Artist A" },
                        album: { title: "Album A", id: 99 },
                    },
                    {
                        id: 2,
                        status: "failed",
                        artist: { name: "Artist B" },
                        album: { name: "Album B" },
                    },
                ],
            },
        });
        axios.delete.mockResolvedValue({});
        axios.post.mockResolvedValue({});

        await (manager as any).clearFailedLidarrImports();

        expect(axios.delete).toHaveBeenCalledTimes(2);
        expect(axios.post).toHaveBeenCalledTimes(1);
        expect(axios.post).toHaveBeenCalledWith(
            "http://lidarr.local/api/v1/command",
            { name: "AlbumSearch", albumIds: [99] },
            expect.objectContaining({
                headers: { "X-Api-Key": "api-key" },
                timeout: 10000,
            }),
        );
        manager.shutdown();
    });

    it("clearFailedLidarrImports tolerates per-item processing errors", async () => {
        const { manager, getSystemSettings, axios } = await loadHarness();
        getSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr.local",
            lidarrApiKey: "api-key",
        });
        axios.get.mockResolvedValue({
            data: {
                records: [
                    {
                        id: 1,
                        trackedDownloadStatus: "warning",
                        artist: { artistName: "Artist A" },
                        album: { title: "Album A", id: 123 },
                    },
                ],
            },
        });
        axios.delete.mockRejectedValue(new Error("delete failed"));

        await expect(
            (manager as any).clearFailedLidarrImports(),
        ).resolves.toBeUndefined();

        manager.shutdown();
    });

    it("clearFailedLidarrImports catches top-level queue fetch errors", async () => {
        const { manager, getSystemSettings, axios } = await loadHarness();
        getSystemSettings.mockResolvedValue({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr.local",
            lidarrApiKey: "api-key",
        });
        axios.get.mockRejectedValue(new Error("queue unreachable"));

        await expect(
            (manager as any).clearFailedLidarrImports(),
        ).resolves.toBeUndefined();

        manager.shutdown();
    });

    it("linkDownloadJob catches persistence errors", async () => {
        const { manager, prisma } = await loadHarness();
        const mockFindMany = prisma.downloadJob.findMany as jest.Mock;

        mockFindMany.mockRejectedValue(new Error("findMany failed"));

        await expect(
            (manager as any).linkDownloadJob("lidarr-error", "mbid-error"),
        ).resolves.toBeUndefined();

        manager.shutdown();
    });
});
