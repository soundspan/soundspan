describe("queueCleaner", () => {
    const originalEnv = process.env;

    afterEach(() => {
        jest.useRealTimers();
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadQueueCleaner() {
        process.env = { ...originalEnv };

        class PrismaClientKnownRequestError extends Error {
            code: string;
            constructor(message: string, code: string) {
                super(message);
                this.code = code;
            }
        }
        class PrismaClientRustPanicError extends Error {}
        class PrismaClientUnknownRequestError extends Error {}

        const Prisma = {
            PrismaClientKnownRequestError,
            PrismaClientRustPanicError,
            PrismaClientUnknownRequestError,
        };

        const prisma = {
            $connect: jest.fn(async () => undefined),
            downloadJob: {
                findMany: jest.fn(),
                update: jest.fn(async () => ({})),
                updateMany: jest.fn(async () => ({ count: 0 })),
                count: jest.fn(async () => 0),
            },
            album: {
                findMany: jest.fn(),
            },
        };

        const logger = {
            debug: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        const getSystemSettings = jest.fn(async () => null);
        const cleanStuckDownloads = jest.fn(async () => ({ removed: 0, items: [] }));
        const getRecentCompletedDownloads = jest.fn(async () => []);
        const scanQueue = { add: jest.fn(async () => ({ id: "scan-1" })) };
        const simpleDownloadManager = {
            markStaleJobsAsFailed: jest.fn(async () => 0),
            reconcileWithLidarr: jest.fn(async () => ({ reconciled: 0 })),
            syncWithLidarrQueue: jest.fn(async () => ({ cancelled: 0 })),
        };
        const discoverWeeklyService = {
            checkStuckBatches: jest.fn(async () => 0),
            checkBatchCompletion: jest.fn(async () => undefined),
        };
        const matchAlbum = jest.fn(() => false);
        const yieldToEventLoop = jest.fn(async () => undefined);

        jest.doMock("../../utils/db", () => ({ prisma }));
        jest.doMock("../../utils/logger", () => ({ logger }));
        jest.doMock("../../utils/systemSettings", () => ({ getSystemSettings }));
        jest.doMock("../../services/lidarr", () => ({
            cleanStuckDownloads,
            getRecentCompletedDownloads,
        }));
        jest.doMock("../../workers/queues", () => ({ scanQueue }));
        jest.doMock("../../services/simpleDownloadManager", () => ({
            simpleDownloadManager,
        }));
        jest.doMock("../../services/discoverWeekly", () => ({
            discoverWeeklyService,
        }));
        jest.doMock("../../utils/fuzzyMatch", () => ({ matchAlbum }));
        jest.doMock("../../utils/async", () => ({ yieldToEventLoop }));
        jest.doMock("@prisma/client", () => ({ Prisma }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { queueCleaner } = require("../queueCleaner");

        return {
            queueCleaner,
            cleanStuckDownloads,
            getRecentCompletedDownloads,
            prisma,
            scanQueue,
            simpleDownloadManager,
            discoverWeeklyService,
            getSystemSettings,
            logger,
            matchAlbum,
            Prisma,
            yieldToEventLoop,
        };
    }

    it("returns zero reconciliation when no processing jobs exist", async () => {
        const { queueCleaner, prisma } = loadQueueCleaner();
        prisma.downloadJob.findMany.mockResolvedValueOnce([]);

        await expect(queueCleaner.reconcileWithLocalLibrary()).resolves.toEqual({
            reconciled: 0,
        });
        expect(prisma.downloadJob.findMany).toHaveBeenCalled();
        expect(prisma.downloadJob.updateMany).not.toHaveBeenCalled();
    });

    it("reconciles matching jobs and runs discovery batch completion", async () => {
        const { queueCleaner, prisma, discoverWeeklyService, yieldToEventLoop } =
            loadQueueCleaner();

        prisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-1",
                status: "processing",
                metadata: { artistName: "Artist A", albumTitle: "Album X" },
                discoveryBatchId: "batch-1",
            },
            {
                id: "job-2",
                status: "pending",
                metadata: { artistName: "Artist B", albumTitle: "Album Y" },
                discoveryBatchId: null,
            },
        ]);
        prisma.album.findMany.mockResolvedValueOnce([
            {
                id: "alb-1",
                title: "Album X",
                artist: { name: "Artist A" },
            },
            {
                id: "alb-2",
                title: "Album Y",
                artist: { name: "Artist B" },
            },
        ]);
        prisma.downloadJob.updateMany.mockResolvedValueOnce({ count: 2 });

        await expect(queueCleaner.reconcileWithLocalLibrary()).resolves.toEqual({
            reconciled: 2,
        });

        expect(prisma.downloadJob.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ["job-1", "job-2"] } },
            data: {
                status: "completed",
                completedAt: expect.any(Date),
                error: null,
            },
        });
        expect(discoverWeeklyService.checkBatchCompletion).toHaveBeenCalledWith(
            "batch-1"
        );
        expect(yieldToEventLoop).toHaveBeenCalledTimes(1);
    });

    it("starts and then stops when Lidarr settings are missing", async () => {
        const { queueCleaner, getSystemSettings, logger } = loadQueueCleaner();

        await queueCleaner.start();
        const status = queueCleaner.getStatus();

        expect(getSystemSettings).toHaveBeenCalled();
        expect(status.isRunning).toBe(false);
        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("Lidarr not configured, stopping queue cleaner")
        );
    });

    it("no-ops cleanup loop when cleaner is not running", async () => {
        const { queueCleaner, getSystemSettings } = loadQueueCleaner();

        await (queueCleaner as any).runCleanup();
        expect(getSystemSettings).not.toHaveBeenCalled();
    });

    it("does not start a duplicate loop when already running", async () => {
        const { queueCleaner, logger } = loadQueueCleaner();
        (queueCleaner as any).isRunning = true;

        await queueCleaner.start();

        expect(logger.debug).toHaveBeenCalledWith(" Queue cleaner already running");
    });

    it("retries transient prisma failures during reconciliation and reconnects", async () => {
        jest.useFakeTimers();
        const { queueCleaner, prisma, logger } = loadQueueCleaner();

        prisma.downloadJob.findMany
            .mockRejectedValueOnce(new Error("Response from the Engine was empty"))
            .mockResolvedValueOnce([]);

        const resultPromise = queueCleaner.reconcileWithLocalLibrary();
        await jest.advanceTimersByTimeAsync(400);

        await expect(resultPromise).resolves.toEqual({ reconciled: 0 });
        expect(prisma.$connect).toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                "[QueueCleaner/Prisma] reconcileWithLocalLibrary.downloadJob.findMany.processing failed"
            ),
            expect.any(Error)
        );
    });

    it("continues retry flow when prisma reconnect attempt fails once", async () => {
        jest.useFakeTimers();
        const { queueCleaner, prisma } = loadQueueCleaner();

        prisma.downloadJob.findMany
            .mockRejectedValueOnce(new Error("Connection reset by peer"))
            .mockResolvedValueOnce([]);
        prisma.$connect.mockRejectedValueOnce(new Error("connect failed"));

        const resultPromise = queueCleaner.reconcileWithLocalLibrary();
        await jest.advanceTimersByTimeAsync(400);

        await expect(resultPromise).resolves.toEqual({ reconciled: 0 });
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
    });

    it("reconciles orphaned completed downloads and triggers scan for non-discovery jobs", async () => {
        const {
            queueCleaner,
            prisma,
            getSystemSettings,
            getRecentCompletedDownloads,
            scanQueue,
        } = loadQueueCleaner();

        (getSystemSettings as jest.Mock).mockResolvedValue({
            lidarrUrl: "http://lidarr",
            lidarrApiKey: "key",
        });
        (getRecentCompletedDownloads as jest.Mock).mockResolvedValue([
            {
                downloadId: "download-1",
                album: { foreignAlbumId: "mbid-1", title: "Album X" },
                artist: { name: "Artist A" },
            },
        ]);

        prisma.downloadJob.findMany
            .mockResolvedValueOnce([]) // reconcileWithLocalLibrary processing jobs
            .mockResolvedValueOnce([{ id: "job-1", discoveryBatchId: null }]); // orphaned jobs
        prisma.downloadJob.count.mockResolvedValueOnce(0);

        (queueCleaner as any).isRunning = true;
        await (queueCleaner as any).runCleanup();

        expect(prisma.downloadJob.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ["job-1"] } },
            data: {
                status: "completed",
                completedAt: expect.any(Date),
            },
        });
        expect(scanQueue.add).toHaveBeenCalledWith("scan", {
            type: "full",
            source: "queue-cleaner-recovery",
        });

        queueCleaner.stop();
    });

    it("runs stale/reconcile/sync/stuck checks and logs skipped incomplete records", async () => {
        const {
            queueCleaner,
            prisma,
            getSystemSettings,
            getRecentCompletedDownloads,
            simpleDownloadManager,
            discoverWeeklyService,
            logger,
        } = loadQueueCleaner();

        (getSystemSettings as jest.Mock).mockResolvedValue({
            lidarrUrl: "http://lidarr",
            lidarrApiKey: "key",
        });
        (simpleDownloadManager.markStaleJobsAsFailed as jest.Mock).mockResolvedValue(1);
        (simpleDownloadManager.reconcileWithLidarr as jest.Mock).mockResolvedValue({
            reconciled: 2,
        });
        (simpleDownloadManager.syncWithLidarrQueue as jest.Mock).mockResolvedValue({
            cancelled: 3,
        });
        (discoverWeeklyService.checkStuckBatches as jest.Mock).mockResolvedValue(1);
        (getRecentCompletedDownloads as jest.Mock).mockResolvedValue([
            { downloadId: "d1", album: null, artist: { name: "Artist A" } },
        ]);

        prisma.downloadJob.findMany.mockResolvedValueOnce([]);
        prisma.downloadJob.count.mockResolvedValueOnce(1);

        (queueCleaner as any).isRunning = true;
        await (queueCleaner as any).runCleanup();

        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("Cleaned up 1 stale download")
        );
        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("Reconciled 2 job(s) with Lidarr")
        );
        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("Synced 3 job(s) with Lidarr queue")
        );
        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("Force-completed 1 stuck discovery batch(es)")
        );
        expect(logger.debug).toHaveBeenCalledWith(
            "   (Skipped 1 incomplete download records)"
        );

        queueCleaner.stop();
    });

    it("logs local library reconciliation and checks discovery batch completion for recovered jobs", async () => {
        const {
            queueCleaner,
            prisma,
            getSystemSettings,
            getRecentCompletedDownloads,
            discoverWeeklyService,
            logger,
        } = loadQueueCleaner();

        (getSystemSettings as jest.Mock).mockResolvedValue({
            lidarrUrl: "http://lidarr",
            lidarrApiKey: "key",
        });
        (getRecentCompletedDownloads as jest.Mock).mockResolvedValue([
            {
                downloadId: "download-2",
                album: { foreignAlbumId: "mbid-2", title: "Album Two" },
                artist: { name: "Artist Two" },
            },
        ]);
        jest.spyOn(queueCleaner, "reconcileWithLocalLibrary").mockResolvedValue({
            reconciled: 1,
        });

        prisma.downloadJob.findMany.mockResolvedValueOnce([
            { id: "job-2", discoveryBatchId: "batch-2" },
        ]);
        prisma.downloadJob.count.mockResolvedValueOnce(1);

        (queueCleaner as any).isRunning = true;
        await (queueCleaner as any).runCleanup();

        expect(logger.debug).toHaveBeenCalledWith(
            "✓ Reconciled 1 job(s) with local library"
        );
        expect(discoverWeeklyService.checkBatchCompletion).toHaveBeenCalledWith(
            "batch-2"
        );
        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("Checking Discovery batch completion: batch-2")
        );

        queueCleaner.stop();
    });

    it("updates retry metadata for cleaned stuck downloads", async () => {
        const {
            queueCleaner,
            prisma,
            getSystemSettings,
            cleanStuckDownloads,
            getRecentCompletedDownloads,
        } = loadQueueCleaner();

        (getSystemSettings as jest.Mock).mockResolvedValue({
            lidarrUrl: "http://lidarr",
            lidarrApiKey: "key",
        });
        (cleanStuckDownloads as jest.Mock).mockResolvedValue({
            removed: 1,
            items: ["Artist A - Album X (2024)"],
        });
        (getRecentCompletedDownloads as jest.Mock).mockResolvedValue([]);

        prisma.downloadJob.findMany
            .mockResolvedValueOnce([]) // reconcileWithLocalLibrary processing jobs
            .mockResolvedValueOnce([{ id: "job-1", metadata: { retryCount: 2 } }]); // matching jobs
        prisma.downloadJob.count.mockResolvedValueOnce(1);

        (queueCleaner as any).isRunning = true;
        await (queueCleaner as any).runCleanup();

        expect(prisma.downloadJob.update).toHaveBeenCalledWith({
            where: { id: "job-1" },
            data: {
                metadata: {
                    retryCount: 3,
                    lastError:
                        "Import failed - searching for alternative release",
                },
            },
        });

        queueCleaner.stop();
    });

    it("stops cleaner after max consecutive empty checks", async () => {
        const {
            queueCleaner,
            prisma,
            getSystemSettings,
            getRecentCompletedDownloads,
        } = loadQueueCleaner();

        (getSystemSettings as jest.Mock).mockResolvedValue({
            lidarrUrl: "http://lidarr",
            lidarrApiKey: "key",
        });
        (getRecentCompletedDownloads as jest.Mock).mockResolvedValue([]);

        prisma.downloadJob.findMany.mockResolvedValueOnce([]);
        prisma.downloadJob.count.mockResolvedValueOnce(0);

        (queueCleaner as any).isRunning = true;
        (queueCleaner as any).emptyQueueChecks = 2;

        await (queueCleaner as any).runCleanup();

        expect(queueCleaner.getStatus().isRunning).toBe(false);
    });

    it("reports next check interval while running", async () => {
        const { queueCleaner } = loadQueueCleaner();
        (queueCleaner as any).isRunning = true;

        expect(queueCleaner.getStatus()).toEqual(
            expect.objectContaining({
                isRunning: true,
                nextCheckIn: "30s",
            })
        );
    });

    it("reschedules next cycle when cleanup throws", async () => {
        const { queueCleaner, getSystemSettings, logger } = loadQueueCleaner();
        (getSystemSettings as jest.Mock).mockRejectedValue(new Error("boom"));

        (queueCleaner as any).isRunning = true;
        await (queueCleaner as any).runCleanup();

        expect(logger.error).toHaveBeenCalledWith(
            " Queue cleanup error:",
            expect.any(Error)
        );
        expect((queueCleaner as any).timeoutId).toBeDefined();

        queueCleaner.stop();
    });

    it("executes the scheduled next-cycle callback after a successful run", async () => {
        jest.useFakeTimers();
        const { queueCleaner, getSystemSettings, prisma } = loadQueueCleaner();

        (getSystemSettings as jest.Mock).mockResolvedValue({
            lidarrUrl: "http://lidarr",
            lidarrApiKey: "key",
        });
        prisma.downloadJob.findMany.mockResolvedValue([]);
        prisma.downloadJob.count.mockResolvedValue(1);

        (queueCleaner as any).isRunning = true;
        await (queueCleaner as any).runCleanup();

        await jest.advanceTimersByTimeAsync(30_000);
        expect((getSystemSettings as jest.Mock).mock.calls.length).toBeGreaterThan(1);

        queueCleaner.stop();
    });

    it("executes the scheduled retry callback after an error cycle", async () => {
        jest.useFakeTimers();
        const { queueCleaner, getSystemSettings } = loadQueueCleaner();

        (getSystemSettings as jest.Mock)
            .mockRejectedValueOnce(new Error("first cycle fails"))
            .mockResolvedValueOnce({
                lidarrUrl: "http://lidarr",
                lidarrApiKey: "key",
            });

        (queueCleaner as any).isRunning = true;
        await (queueCleaner as any).runCleanup();

        await jest.advanceTimersByTimeAsync(30_000);
        expect((getSystemSettings as jest.Mock).mock.calls.length).toBeGreaterThan(1);

        queueCleaner.stop();
    });

    it("uses fuzzy match fallback during local reconciliation", async () => {
        const { queueCleaner, prisma, matchAlbum } = loadQueueCleaner();

        prisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-1",
                status: "processing",
                metadata: { artistName: "Unknown Artist", albumTitle: "Rare Cut" },
                discoveryBatchId: null,
            },
        ]);
        prisma.album.findMany.mockResolvedValueOnce([
            {
                id: "alb-1",
                title: "Completely Different",
                artist: { name: "Different Name" },
            },
        ]);
        matchAlbum.mockReturnValueOnce(true);
        prisma.downloadJob.updateMany.mockResolvedValueOnce({ count: 1 });

        await expect(queueCleaner.reconcileWithLocalLibrary()).resolves.toEqual({
            reconciled: 1,
        });
        expect(prisma.downloadJob.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ["job-1"] } },
            data: {
                status: "completed",
                completedAt: expect.any(Date),
                error: null,
            },
        });
    });

    it("uses contains matching strategy before fuzzy fallback", async () => {
        const { queueCleaner, prisma, matchAlbum } = loadQueueCleaner();

        prisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-contains-1",
                status: "processing",
                metadata: {
                    artistName: "Artist",
                    albumTitle: "Album",
                },
                discoveryBatchId: null,
            },
        ]);
        prisma.album.findMany.mockResolvedValueOnce([
            {
                id: "alb-contains-1",
                title: "Album Deluxe Edition",
                artist: { name: "Artist Featuring Guest" },
            },
        ]);
        prisma.downloadJob.updateMany.mockResolvedValueOnce({ count: 1 });

        await expect(queueCleaner.reconcileWithLocalLibrary()).resolves.toEqual({
            reconciled: 1,
        });
        expect(matchAlbum).not.toHaveBeenCalled();
    });

    it("supports reverse contains matching when local album title is shorter", async () => {
        const { queueCleaner, prisma, matchAlbum } = loadQueueCleaner();

        prisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-contains-reverse-1",
                status: "processing",
                metadata: {
                    artistName: "Artist Name",
                    albumTitle: "Album Name Deluxe Edition",
                },
                discoveryBatchId: null,
            },
        ]);
        prisma.album.findMany.mockResolvedValueOnce([
            {
                id: "alb-contains-reverse-1",
                title: "Album Name",
                artist: { name: "Artist Name" },
            },
        ]);
        prisma.downloadJob.updateMany.mockResolvedValueOnce({ count: 1 });

        await expect(queueCleaner.reconcileWithLocalLibrary()).resolves.toEqual({
            reconciled: 1,
        });
        expect(matchAlbum).not.toHaveBeenCalled();
    });

    it("skips local reconciliation when jobs lack artist/album metadata", async () => {
        const { queueCleaner, prisma } = loadQueueCleaner();

        prisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-invalid",
                status: "processing",
                metadata: {},
                discoveryBatchId: null,
            },
        ]);

        await expect(queueCleaner.reconcileWithLocalLibrary()).resolves.toEqual({
            reconciled: 0,
        });
        expect(prisma.album.findMany).not.toHaveBeenCalled();
    });

    it("keeps jobs pending when no exact/contains/fuzzy local match is found", async () => {
        const { queueCleaner, prisma, matchAlbum } = loadQueueCleaner();

        prisma.downloadJob.findMany.mockResolvedValueOnce([
            {
                id: "job-unmatched-1",
                status: "processing",
                metadata: {
                    artistName: "Artist Unmatched",
                    albumTitle: "Album Unmatched",
                },
                discoveryBatchId: null,
            },
        ]);
        prisma.album.findMany.mockResolvedValueOnce([
            {
                id: "alb-unmatched-1",
                title: "Totally Different Album",
                artist: { name: "Totally Different Artist" },
            },
        ]);
        matchAlbum.mockReturnValueOnce(false);

        await expect(queueCleaner.reconcileWithLocalLibrary()).resolves.toEqual({
            reconciled: 0,
        });
        expect(prisma.downloadJob.updateMany).not.toHaveBeenCalled();
    });

    it("reuses cached fuzzy matcher import across consecutive local reconciliations", async () => {
        const { queueCleaner, prisma } = loadQueueCleaner();
        const baseJobs = [
            {
                id: "job-cache-1",
                status: "processing",
                metadata: {
                    artistName: "Cache Artist",
                    albumTitle: "Cache Album",
                },
                discoveryBatchId: null,
            },
        ];
        const baseAlbums = [
            {
                id: "alb-cache-1",
                title: "Cache Album",
                artist: { name: "Cache Artist" },
            },
        ];
        prisma.downloadJob.findMany
            .mockResolvedValueOnce(baseJobs)
            .mockResolvedValueOnce(baseJobs);
        prisma.album.findMany
            .mockResolvedValueOnce(baseAlbums)
            .mockResolvedValueOnce(baseAlbums);
        prisma.downloadJob.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 1 });

        await expect(queueCleaner.reconcileWithLocalLibrary()).resolves.toEqual({
            reconciled: 1,
        });
        await expect(queueCleaner.reconcileWithLocalLibrary()).resolves.toEqual({
            reconciled: 1,
        });
    });

    it("skips stuck-download retry metadata updates when title cannot be parsed", async () => {
        const {
            queueCleaner,
            prisma,
            getSystemSettings,
            cleanStuckDownloads,
            getRecentCompletedDownloads,
        } = loadQueueCleaner();

        (getSystemSettings as jest.Mock).mockResolvedValue({
            lidarrUrl: "http://lidarr",
            lidarrApiKey: "key",
        });
        (cleanStuckDownloads as jest.Mock).mockResolvedValue({
            removed: 1,
            items: ["TitleWithoutArtistDelimiter"],
        });
        (getRecentCompletedDownloads as jest.Mock).mockResolvedValue([]);
        prisma.downloadJob.findMany.mockResolvedValueOnce([]);
        prisma.downloadJob.count.mockResolvedValueOnce(1);

        (queueCleaner as any).isRunning = true;
        await (queueCleaner as any).runCleanup();

        expect(prisma.downloadJob.update).not.toHaveBeenCalled();
        queueCleaner.stop();
    });

    it("handles orphan recovery with fallback metadata and metadata-less retry jobs", async () => {
        const {
            queueCleaner,
            prisma,
            getSystemSettings,
            cleanStuckDownloads,
            getRecentCompletedDownloads,
        } = loadQueueCleaner();

        (getSystemSettings as jest.Mock).mockResolvedValue({
            lidarrUrl: "http://lidarr",
            lidarrApiKey: "key",
        });
        (cleanStuckDownloads as jest.Mock).mockResolvedValue({
            removed: 1,
            items: ["Artist Z - Album Z"],
        });
        (getRecentCompletedDownloads as jest.Mock).mockResolvedValue([
            {
                downloadId: "download-no-jobs",
                album: { foreignAlbumId: "mbid-no-jobs", title: "Album A" },
                artist: { name: "Artist A" },
            },
            {
                downloadId: "download-fallback",
                album: { foreignAlbumId: "mbid-fallback" },
                artist: undefined,
            },
        ]);

        prisma.downloadJob.findMany
            .mockResolvedValueOnce([]) // reconcileWithLocalLibrary processing jobs
            .mockResolvedValueOnce([{ id: "retry-job-1", metadata: null }]) // cleanStuckDownloads matching jobs
            .mockResolvedValueOnce([]) // orphaned jobs for first completed download
            .mockResolvedValueOnce([
                { id: "orphan-fallback-1", discoveryBatchId: null },
            ]); // orphaned jobs for second completed download
        prisma.downloadJob.count.mockResolvedValueOnce(1);

        (queueCleaner as any).isRunning = true;
        await (queueCleaner as any).runCleanup();

        expect(prisma.downloadJob.update).toHaveBeenCalledWith({
            where: { id: "retry-job-1" },
            data: {
                metadata: {
                    retryCount: 1,
                    lastError:
                        "Import failed - searching for alternative release",
                },
            },
        });
        expect(prisma.downloadJob.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ["orphan-fallback-1"] } },
            data: {
                status: "completed",
                completedAt: expect.any(Date),
            },
        });

        queueCleaner.stop();
    });

    it("retries known-request prisma errors that are marked retryable", async () => {
        jest.useFakeTimers();
        const { queueCleaner, prisma, Prisma } = loadQueueCleaner();

        prisma.downloadJob.findMany
            .mockRejectedValueOnce(
                new Prisma.PrismaClientKnownRequestError("db unavailable", "P1001")
            )
            .mockResolvedValueOnce([]);

        const resultPromise = queueCleaner.reconcileWithLocalLibrary();
        await jest.advanceTimersByTimeAsync(400);

        await expect(resultPromise).resolves.toEqual({ reconciled: 0 });
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
    });

    it("retries rust panic and unknown request prisma errors", async () => {
        jest.useFakeTimers();
        const { queueCleaner, prisma, Prisma } = loadQueueCleaner();

        prisma.downloadJob.findMany
            .mockRejectedValueOnce(new Prisma.PrismaClientRustPanicError("panic"))
            .mockRejectedValueOnce(
                new Prisma.PrismaClientUnknownRequestError(
                    "Response from the Engine was empty"
                )
            )
            .mockResolvedValueOnce([]);

        const resultPromise = queueCleaner.reconcileWithLocalLibrary();
        await jest.advanceTimersByTimeAsync(1200);

        await expect(resultPromise).resolves.toEqual({ reconciled: 0 });
        expect(prisma.$connect).toHaveBeenCalledTimes(2);
    });

    it("does not retry non-retryable known-request prisma errors", async () => {
        const { queueCleaner, prisma, Prisma } = loadQueueCleaner();
        prisma.downloadJob.findMany.mockRejectedValueOnce(
            new Prisma.PrismaClientKnownRequestError("constraint", "P2003")
        );

        await expect(queueCleaner.reconcileWithLocalLibrary()).rejects.toThrow(
            "constraint"
        );
        expect(prisma.$connect).not.toHaveBeenCalled();
    });
});
