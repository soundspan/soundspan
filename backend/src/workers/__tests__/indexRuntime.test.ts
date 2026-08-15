describe("workers runtime behavior", () => {
    const originalEnv = process.env;

    const flushPromises = async (): Promise<void> => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
    };

    function createQueueMock() {
        return {
            process: jest.fn(),
            on: jest.fn(),
            isReady: jest.fn(async () => undefined),
            add: jest.fn(async () => ({ id: "job-1" })),
            close: jest.fn(async () => undefined),
            removeAllListeners: jest.fn(),
            getJobCounts: jest.fn(async () => ({
                waiting: 0,
                active: 0,
                completed: 0,
                failed: 0,
                delayed: 0,
            })),
        };
    }

    function setupWorkerModuleMocks(featureOverrides?: {
        audioAnalysis?: boolean;
        discovery?: boolean;
        autoPlaylists?: boolean;
    }) {
        const scanQueue = createQueueMock();
        const discoverQueue = createQueueMock();
        const imageQueue = createQueueMock();
        const validationQueue = createQueueMock();
        const schedulerQueue = createQueueMock();
        const genericImportQueue = createQueueMock();

        const logger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            child: jest.fn(),
        };
        logger.child.mockReturnValue(logger);

        const startUnifiedEnrichmentWorker = jest.fn(async () => undefined);
        const stopUnifiedEnrichmentWorker = jest.fn(async () => undefined);
        const startMoodBucketWorker = jest.fn(async () => undefined);
        const stopMoodBucketWorker = jest.fn();
        const startDiscoverWeeklyCron = jest.fn();
        const stopDiscoverWeeklyCron = jest.fn();
        const processDiscoverCronTick = jest.fn(async () => ({ ok: true }));
        const processGenericImport = jest.fn(async () => undefined);
        const processTrackRemovalPurge = jest.fn(async () => ({
            deleted: 0,
            continued: false,
        }));
        const finalizeGenericImportQueueFailure = jest.fn(
            async () => undefined,
        );
        const registerRecoveryJobs = jest.fn(async () => undefined);
        const runDataIntegrityCheck = jest.fn(async () => undefined);
        const shutdownDiscoverProcessor = jest.fn(async () => undefined);
        const cleanupExpiredCache = jest.fn(async () => undefined);
        const getSystemSettings = jest.fn(async () => ({
            audiobookshelfEnabled: false,
            audiobookshelfUrl: null,
        }));
        const audiobookCacheService = {
            syncAll: jest.fn(async () => ({ synced: 0 })),
        };
        const isBackfillNeeded = jest.fn(async () => false);
        const backfillAllArtistCounts = jest.fn(async () => ({
            processed: 0,
            errors: 0,
        }));
        const isImageBackfillNeeded = jest.fn(async () => ({
            needed: false,
            artistsWithExternalUrls: 0,
            albumsWithExternalUrls: 0,
        }));
        const backfillAllImages = jest.fn(async () => undefined);
        const lidarrService = {
            getReconciliationSnapshot: jest.fn(async () => ({
                timestamp: Date.now(),
                queue: [],
            })),
        };

        const downloadQueueManager = {
            onUnavailableAlbum: jest.fn(),
            shutdown: jest.fn(),
            reconcileOnStartup: jest.fn(async () => ({ loaded: 0, failed: 0 })),
        };
        const simpleDownloadManager = {
            markStaleJobsAsFailed: jest.fn(async () => 0),
            reconcileWithLidarr: jest.fn(async () => ({ reconciled: 0 })),
            syncWithLidarrQueue: jest.fn(async () => ({ cancelled: 0 })),
            clearLidarrQueue: jest.fn(async () => ({ removed: 0 })),
        };

        const queueCleaner = {
            reconcileWithLocalLibrary: jest.fn(async () => ({ reconciled: 0 })),
        };
        const enrichmentStateService = {
            disconnect: jest.fn(async () => undefined),
        };

        const schedulerLockRedis = {
            get: jest.fn(async () => null as string | null),
            set: jest.fn(async () => "OK"),
            del: jest.fn(async () => 1),
            eval: jest.fn(async () => 1),
            quit: jest.fn(async () => "OK"),
            disconnect: jest.fn(),
        };
        const createIORedisClient = jest.fn(() => schedulerLockRedis);
        const dataCacheService = {
            warmupCache: jest.fn(async () => undefined),
        };
        const trackReconciliationService = {
            reconcileOrphans: jest.fn(async () => ({ created: 0 })),
            reconcileWindow: jest.fn(async () => ({
                result: { processed: 0, linked: 0, skipped: 0 },
                nextCursor: null as {
                    id: string;
                    createdAt: Date;
                } | null,
            })),
            reconcileYoutubeToTidal: jest.fn(async () => ({
                processed: 0,
                upgraded: 0,
                skipped: 0,
            })),
        };

        const prisma = {
            discoveryAlbum: { findFirst: jest.fn(async () => null) },
            unavailableAlbum: { create: jest.fn(async () => undefined) },
            audiobook: { count: jest.fn(async () => 0) },
        };

        jest.doMock("../../utils/logger", () => ({ logger }));
        jest.doMock("music-metadata", () => ({ parseFile: jest.fn() }), {
            virtual: true,
        });
        jest.doMock("../queues", () => ({
            scanQueue,
            discoverQueue,
            imageQueue,
            validationQueue,
            schedulerQueue,
            genericImportQueue,
        }));
        jest.doMock("../processors/scanProcessor", () => ({
            processScan: jest.fn(async () => ({
                tracksAdded: 0,
                tracksUpdated: 0,
                tracksRemoved: 0,
            })),
        }));
        jest.doMock("../processors/discoverProcessor", () => ({
            processDiscoverWeekly: jest.fn(async () => ({
                success: true,
                playlistName: "Discover",
                songCount: 0,
            })),
            shutdownDiscoverProcessor,
        }));
        jest.doMock("../processors/imageProcessor", () => ({
            processImageOptimization: jest.fn(async () => ({ success: true })),
        }));
        jest.doMock("../processors/validationProcessor", () => ({
            processValidation: jest.fn(async () => ({
                tracksChecked: 0,
                tracksRemoved: 0,
            })),
        }));
        jest.doMock("../processors/genericImportProcessor", () => ({
            processGenericImport,
            finalizeGenericImportQueueFailure,
            GENERIC_IMPORT_WORKER_CONCURRENCY: 2,
        }));
        jest.doMock("../processors/trackRemovalPurgeProcessor", () => ({
            TRACK_REMOVAL_PURGE_JOB_NAME: "track-removal-purge",
            processTrackRemovalPurge,
        }));
        jest.doMock("../../services/genericImportJobRunner", () => ({
            genericImportJobRunner: {
                registerRecoveryJobs,
            },
        }));
        jest.doMock("../unifiedEnrichment", () => ({
            startUnifiedEnrichmentWorker,
            stopUnifiedEnrichmentWorker,
        }));
        jest.doMock("../moodBucketWorker", () => ({
            startMoodBucketWorker,
            stopMoodBucketWorker,
        }));
        jest.doMock("../../services/downloadQueue", () => ({
            downloadQueueManager,
        }));
        jest.doMock("../../utils/db", () => ({ prisma }));
        jest.doMock("../discoverCron", () => ({
            startDiscoverWeeklyCron,
            stopDiscoverWeeklyCron,
            processDiscoverCronTick,
        }));
        jest.doMock("../../config", () => ({
            config: {
                features: {
                    audioAnalysis: true,
                    discovery: true,
                    autoPlaylists: true,
                    ...(featureOverrides ?? {}),
                },
            },
        }));
        jest.doMock("../dataIntegrity", () => ({ runDataIntegrityCheck }));
        jest.doMock("../../services/simpleDownloadManager", () => ({
            simpleDownloadManager,
        }));
        jest.doMock("../../jobs/queueCleaner", () => ({ queueCleaner }));
        jest.doMock("../../services/enrichmentState", () => ({
            enrichmentStateService,
        }));
        jest.doMock("../../utils/ioredis", () => ({ createIORedisClient }));
        jest.doMock("../../services/lidarr", () => ({ lidarrService }));
        jest.doMock("../../services/podcastDownload", () => ({
            cleanupExpiredCache,
        }));
        jest.doMock("../../utils/systemSettings", () => ({
            getSystemSettings,
        }));
        jest.doMock("../../services/audiobookCache", () => ({
            audiobookCacheService,
        }));
        jest.doMock("../../services/artistCountsService", () => ({
            isBackfillNeeded,
            backfillAllArtistCounts,
        }));
        jest.doMock("../../services/imageBackfill", () => ({
            isImageBackfillNeeded,
            backfillAllImages,
        }));
        jest.doMock("../../services/dataCache", () => ({
            dataCacheService,
        }));
        jest.doMock("../../services/trackReconciliation", () => ({
            trackReconciliationService,
        }));

        return {
            scanQueue,
            discoverQueue,
            imageQueue,
            validationQueue,
            schedulerQueue,
            genericImportQueue,
            logger,
            startUnifiedEnrichmentWorker,
            stopUnifiedEnrichmentWorker,
            startMoodBucketWorker,
            stopMoodBucketWorker,
            startDiscoverWeeklyCron,
            stopDiscoverWeeklyCron,
            processGenericImport,
            processTrackRemovalPurge,
            finalizeGenericImportQueueFailure,
            registerRecoveryJobs,
            runDataIntegrityCheck,
            downloadQueueManager,
            simpleDownloadManager,
            queueCleaner,
            shutdownDiscoverProcessor,
            enrichmentStateService,
            schedulerLockRedis,
            createIORedisClient,
            cleanupExpiredCache,
            getSystemSettings,
            audiobookCacheService,
            isBackfillNeeded,
            backfillAllArtistCounts,
            isImageBackfillNeeded,
            backfillAllImages,
            lidarrService,
            dataCacheService,
            trackReconciliationService,
        };
    }

    afterEach(() => {
        jest.useRealTimers();
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    it("registers queue processors and startup scheduler jobs at module bootstrap", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        expect(mocks.createIORedisClient).toHaveBeenCalledWith(
            "worker-scheduler-locks",
            expect.objectContaining({ lazyConnect: true }),
        );
        expect(mocks.scanQueue.process).toHaveBeenCalledWith(
            "scan",
            expect.any(Function),
        );
        expect(mocks.discoverQueue.process).toHaveBeenCalledWith(
            "discover-recommendation",
            expect.any(Function),
        );
        expect(mocks.schedulerQueue.process).toHaveBeenCalledWith(
            "*",
            expect.any(Function),
        );
        expect(mocks.genericImportQueue.process).toHaveBeenCalledWith(
            "*",
            2,
            mocks.processGenericImport,
        );
        expect(mocks.registerRecoveryJobs).toHaveBeenCalledTimes(1);
        expect(mocks.startUnifiedEnrichmentWorker).toHaveBeenCalledTimes(1);
        expect(mocks.startMoodBucketWorker).toHaveBeenCalledTimes(1);
        expect(mocks.startDiscoverWeeklyCron).toHaveBeenCalledTimes(1);
        expect(mocks.stopDiscoverWeeklyCron).not.toHaveBeenCalled();
        expect(mocks.schedulerQueue.isReady).toHaveBeenCalledTimes(1);
        expect(mocks.schedulerQueue.add).toHaveBeenCalled();
        expect(mocks.schedulerQueue.add).toHaveBeenCalledWith(
            "track-audio-hash-backfill",
            {
                mode: "startup",
                sweepStartedAt: expect.any(String),
            },
            expect.objectContaining({
                jobId: "scheduler:audio-hash-backfill:startup",
            }),
        );
        expect(mocks.schedulerQueue.add).toHaveBeenCalledWith(
            "track-removal-purge",
            { mode: "startup" },
            {
                jobId: "scheduler:track-removal-purge:startup",
                delay: 60_000,
                attempts: 3,
                backoff: { type: "exponential", delay: 5_000 },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
        expect(mocks.schedulerQueue.add).toHaveBeenCalledWith(
            "track-removal-purge",
            { mode: "repeat" },
            {
                jobId: "scheduler:track-removal-purge:repeat",
                repeat: { every: 24 * 60 * 60 * 1000 },
                attempts: 3,
                backoff: { type: "exponential", delay: 5_000 },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
    });

    it("dispatches track-removal purge jobs through the scheduler", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];
        const job = {
            id: "track-removal-purge-1",
            name: "track-removal-purge",
            data: { mode: "repeat" },
        };

        await schedulerHandler(job);

        expect(mocks.processTrackRemovalPurge).toHaveBeenCalledWith(job);
    });

    it("removes the persisted Discover Weekly repeatable job and reports backlog when discovery is disabled", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks({ discovery: false });
        mocks.discoverQueue.getJobCounts.mockResolvedValueOnce({
            waiting: 2,
            active: 0,
            completed: 0,
            failed: 0,
            delayed: 1,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        expect(mocks.discoverQueue.process).not.toHaveBeenCalledWith(
            "discover-recommendation",
            expect.any(Function),
        );
        expect(mocks.startDiscoverWeeklyCron).not.toHaveBeenCalled();
        expect(mocks.stopDiscoverWeeklyCron).toHaveBeenCalledTimes(1);
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("3 discover job(s)"),
        );
    });

    it("logs but survives a backlog inspection failure when discovery is disabled", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks({ discovery: false });
        mocks.discoverQueue.getJobCounts.mockRejectedValueOnce(
            new Error("redis gone"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        expect(mocks.stopDiscoverWeeklyCron).toHaveBeenCalledTimes(1);
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("discover queue backlog"),
            "redis gone",
        );
    });

    it("feeds the event-loop watchdog registry and logs a start breadcrumb for heavy-queue jobs", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const monitor = require("../../services/workerEventLoopMonitor");
        monitor.clearActiveJobsForTest();

        const findHandler = (queue: { on: jest.Mock }, event: string) =>
            queue.on.mock.calls.find(([name]: [string]) => name === event)?.[1];

        const schedulerActive = findHandler(mocks.schedulerQueue, "active");
        const schedulerCompleted = findHandler(
            mocks.schedulerQueue,
            "completed",
        );
        expect(schedulerActive).toBeDefined();
        expect(schedulerCompleted).toBeDefined();

        schedulerActive({ id: "r1", name: "download-reconciliation-cycle" });
        expect(monitor.getActiveJobs()).toEqual([
            expect.objectContaining({
                queue: "worker-scheduler",
                jobId: "r1",
                jobName: "download-reconciliation-cycle",
            }),
        ]);
        // Unconditional start breadcrumb: a job that pegs the loop until the
        // kubelet kills the process never lets the watchdog interval fire,
        // so this must be the last log line naming the culprit.
        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.stringContaining(
                "job-start queue=worker-scheduler jobId=r1 jobName=download-reconciliation-cycle",
            ),
        );

        schedulerCompleted({ id: "r1", name: "download-reconciliation-cycle" });
        expect(monitor.getActiveJobs()).toEqual([]);

        // Image queue jobs are registered for attribution too (no breadcrumb)
        const imageActive = findHandler(mocks.imageQueue, "active");
        expect(imageActive).toBeDefined();
        imageActive({ id: "i1", name: "optimize" });
        expect(monitor.getActiveJobs()).toEqual([
            expect.objectContaining({
                queue: "image-optimization",
                jobId: "i1",
            }),
        ]);
        monitor.clearActiveJobsForTest();
    });

    it("exposes queue exports for downstream consumers", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const workers = require("../index");
        await flushPromises();

        expect(workers.scanQueue).toBe(mocks.scanQueue);
        expect(workers.discoverQueue).toBe(mocks.discoverQueue);
        expect(workers.imageQueue).toBe(mocks.imageQueue);
        expect(workers.validationQueue).toBe(mocks.validationQueue);
        expect(workers.schedulerQueue).toBe(mocks.schedulerQueue);
        expect(workers.genericImportQueue).toBe(mocks.genericImportQueue);
    });

    it("shuts down workers and queue resources cleanly", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const workers = require("../index");
        await flushPromises();

        await workers.shutdownWorkers();

        expect(mocks.stopUnifiedEnrichmentWorker).toHaveBeenCalledTimes(1);
        expect(mocks.stopMoodBucketWorker).toHaveBeenCalledTimes(1);
        expect(mocks.downloadQueueManager.shutdown).toHaveBeenCalledTimes(1);
        expect(mocks.scanQueue.removeAllListeners).toHaveBeenCalledTimes(1);
        expect(
            mocks.genericImportQueue.removeAllListeners,
        ).toHaveBeenCalledTimes(1);
        expect(mocks.schedulerQueue.close).toHaveBeenCalledTimes(1);
        expect(mocks.genericImportQueue.close).toHaveBeenCalledTimes(1);
        expect(mocks.enrichmentStateService.disconnect).toHaveBeenCalledTimes(
            1,
        );
        expect(mocks.shutdownDiscoverProcessor).toHaveBeenCalledTimes(1);
        expect(mocks.schedulerLockRedis.quit).toHaveBeenCalledTimes(1);
    });

    it("executes scheduler wildcard data-integrity job when claim is acquired", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerProcessCall =
            mocks.schedulerQueue.process.mock.calls.find(
                (call) => call[0] === "*",
            );
        expect(schedulerProcessCall).toBeTruthy();
        const schedulerHandler = schedulerProcessCall[1];

        await schedulerHandler({
            id: "sched-1",
            name: "data-integrity-check",
            data: { mode: "repeat" },
        });

        expect(mocks.runDataIntegrityCheck).toHaveBeenCalledTimes(1);
        expect(mocks.schedulerLockRedis.set).toHaveBeenCalled();
        expect(mocks.schedulerLockRedis.eval).toHaveBeenCalled();
    });

    it("skips scheduler wildcard job execution when claim is held by another worker", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.schedulerLockRedis.set.mockResolvedValueOnce(
            null as unknown as string,
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerProcessCall =
            mocks.schedulerQueue.process.mock.calls.find(
                (call) => call[0] === "*",
            );
        const schedulerHandler = schedulerProcessCall[1];

        await schedulerHandler({
            id: "sched-2",
            name: "data-integrity-check",
            data: { mode: "repeat" },
        });

        expect(mocks.runDataIntegrityCheck).not.toHaveBeenCalled();
        expect(mocks.schedulerLockRedis.eval).not.toHaveBeenCalled();
    });

    it("falls back to default scheduler skip threshold when env override is invalid", async () => {
        process.env = {
            ...originalEnv,
            SCHEDULER_CLAIM_SKIP_WARN_THRESHOLD: "0",
        };
        const mocks = setupWorkerModuleMocks();
        mocks.schedulerLockRedis.set.mockResolvedValue(
            null as unknown as string,
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];
        expect(schedulerHandler).toBeTruthy();

        await schedulerHandler({
            id: "skip-invalid-threshold-1",
            name: "data-integrity-check",
            data: { mode: "repeat" },
        });
        await schedulerHandler({
            id: "skip-invalid-threshold-2",
            name: "data-integrity-check",
            data: { mode: "repeat" },
        });

        expect(mocks.logger.warn).not.toHaveBeenCalledWith(
            expect.stringContaining("data integrity check skipped"),
        );
    });

    it("handles unavailable-album callback without user id as a no-op", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const callback =
            mocks.downloadQueueManager.onUnavailableAlbum.mock.calls[0][0];
        await callback({
            userId: undefined,
            artistName: "Artist",
            albumTitle: "Album",
            albumMbid: "rg-1",
            artistMbid: "a-1",
            similarity: 0.5,
            tier: "high",
        });

        expect(
            mocks.downloadQueueManager.onUnavailableAlbum,
        ).toHaveBeenCalledTimes(1);
        expect(mocks.schedulerQueue.process).toHaveBeenCalled();
    });

    it("swallows duplicate unavailable-album insert errors (P2002)", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        const duplicateError: any = new Error("duplicate");
        duplicateError.code = "P2002";

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const callback =
            mocks.downloadQueueManager.onUnavailableAlbum.mock.calls[0][0];
        const prisma = require("../../utils/db").prisma;
        prisma.unavailableAlbum.create.mockRejectedValueOnce(duplicateError);

        await expect(
            callback({
                userId: "user-1",
                artistName: "Artist",
                albumTitle: "Album",
                albumMbid: "rg-1",
                artistMbid: "a-1",
                similarity: 0.5,
                tier: "high",
            }),
        ).resolves.toBeUndefined();
    });

    it("handles startup scheduler maintenance job types and aliases", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        (mocks.getSystemSettings as jest.Mock).mockResolvedValue({
            audiobookshelfEnabled: true,
            audiobookshelfUrl: "http://audiobookshelf",
        });
        const prisma = require("../../utils/db").prisma;
        prisma.audiobook.count.mockResolvedValue(0);
        mocks.audiobookCacheService.syncAll.mockResolvedValue({ synced: 4 });
        mocks.isBackfillNeeded.mockResolvedValue(true);
        mocks.backfillAllArtistCounts.mockResolvedValue({
            processed: 10,
            errors: 0,
        });
        mocks.isImageBackfillNeeded.mockResolvedValue({
            needed: true,
            artistsWithExternalUrls: 2,
            albumsWithExternalUrls: 3,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];
        expect(schedulerHandler).toBeTruthy();

        await schedulerHandler({ id: "p1", name: "podcast-cleanup", data: {} });
        await schedulerHandler({
            id: "p2",
            name: "podcast-cache-cleanup",
            data: {},
        });
        await schedulerHandler({
            id: "a1",
            name: "audiobook-auto-sync",
            data: {},
        });
        await schedulerHandler({
            id: "a2",
            name: "audiobook-auto-sync-startup",
            data: {},
        });
        await schedulerHandler({
            id: "d1",
            name: "download-queue-reconcile",
            data: {},
        });
        await schedulerHandler({
            id: "d2",
            name: "download-queue-reconcile-startup",
            data: {},
        });
        await schedulerHandler({
            id: "ac1",
            name: "artist-counts-backfill",
            data: {},
        });
        await schedulerHandler({
            id: "ac2",
            name: "artist-counts-backfill-startup",
            data: {},
        });
        await schedulerHandler({ id: "i1", name: "image-backfill", data: {} });
        await schedulerHandler({
            id: "i2",
            name: "image-backfill-startup",
            data: {},
        });

        expect(mocks.cleanupExpiredCache).toHaveBeenCalled();
        expect(mocks.audiobookCacheService.syncAll).toHaveBeenCalled();
        expect(
            mocks.downloadQueueManager.reconcileOnStartup,
        ).toHaveBeenCalled();
        expect(mocks.backfillAllArtistCounts).toHaveBeenCalled();
        expect(mocks.backfillAllImages).toHaveBeenCalled();
    });

    it("runs track-mapping reconcile job including YT->TIDAL upgrade pass", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.trackReconciliationService.reconcileOrphans.mockResolvedValueOnce(
            {
                created: 1,
            },
        );
        const nextCursor = {
            id: "mapping-cursor-2",
            createdAt: new Date("2026-08-14T12:00:00.000Z"),
        };
        mocks.trackReconciliationService.reconcileWindow.mockResolvedValueOnce({
            result: { processed: 2, linked: 1, skipped: 1 },
            nextCursor,
        });
        mocks.trackReconciliationService.reconcileYoutubeToTidal.mockResolvedValueOnce(
            {
                processed: 3,
                upgraded: 2,
                skipped: 1,
            },
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];
        expect(schedulerHandler).toBeTruthy();

        await schedulerHandler({
            id: "track-reconcile-1",
            name: "track-mapping-reconcile",
            data: { mode: "repeat" },
        });

        expect(
            mocks.trackReconciliationService.reconcileOrphans,
        ).toHaveBeenCalledTimes(1);
        expect(
            mocks.trackReconciliationService.reconcileWindow,
        ).toHaveBeenCalledTimes(1);
        expect(mocks.schedulerLockRedis.set).toHaveBeenCalledWith(
            "scheduler:cursor:track-mapping-reconcile",
            JSON.stringify({
                id: nextCursor.id,
                createdAt: nextCursor.createdAt.toISOString(),
            }),
        );
        expect(
            mocks.trackReconciliationService.reconcileYoutubeToTidal,
        ).toHaveBeenCalledTimes(1);
        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.stringContaining("Upgraded 2 YT mappings to TIDAL"),
        );
    });

    it("resumes track reconciliation after the shared cursor", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        const storedCursor = {
            id: "mapping-cursor-1",
            createdAt: "2026-08-14T11:00:00.000Z",
        };
        mocks.schedulerLockRedis.get.mockResolvedValueOnce(
            JSON.stringify(storedCursor),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];
        await schedulerHandler({
            id: "track-reconcile-resume",
            name: "track-mapping-reconcile",
            data: { mode: "repeat" },
        });

        expect(
            mocks.trackReconciliationService.reconcileWindow,
        ).toHaveBeenCalledWith({
            startAfter: {
                id: storedCursor.id,
                createdAt: new Date(storedCursor.createdAt),
            },
        });
        expect(mocks.schedulerLockRedis.del).toHaveBeenCalledWith(
            "scheduler:cursor:track-mapping-reconcile",
        );
    });

    it("discards an invalid shared reconciliation cursor", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.schedulerLockRedis.get.mockResolvedValueOnce("not-json");

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];
        await schedulerHandler({
            id: "track-reconcile-invalid-cursor",
            name: "track-mapping-reconcile",
            data: { mode: "repeat" },
        });

        expect(
            mocks.trackReconciliationService.reconcileWindow,
        ).toHaveBeenCalledWith({});
        expect(mocks.schedulerLockRedis.del).toHaveBeenCalledWith(
            "scheduler:cursor:track-mapping-reconcile",
        );
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            "Discarding invalid persisted track reconciliation cursor",
        );
    });

    it("skips audiobook startup sync when audiobookshelf is disabled or unconfigured", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];
        expect(schedulerHandler).toBeTruthy();

        await schedulerHandler({
            id: "audiobook-skip-disabled",
            name: "audiobook-auto-sync-startup",
            data: {},
        });

        expect(mocks.logger.debug).toHaveBeenCalledWith(
            "Audiobookshelf is disabled or unconfigured - skipping auto-sync",
        );
        expect(mocks.audiobookCacheService.syncAll).not.toHaveBeenCalled();
    });

    it("skips audiobook startup sync when cache is already populated", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        const prisma = require("../../utils/db").prisma;

        (mocks.getSystemSettings as jest.Mock).mockResolvedValue({
            audiobookshelfEnabled: true,
            audiobookshelfUrl: "http://audiobookshelf",
        });
        prisma.audiobook.count.mockResolvedValueOnce(3);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];
        expect(schedulerHandler).toBeTruthy();

        await schedulerHandler({
            id: "audiobook-skip-cached",
            name: "audiobook-auto-sync-startup",
            data: {},
        });

        expect(mocks.logger.debug).toHaveBeenCalledWith(
            "Audiobook cache has 3 entries - skipping auto-sync",
        );
        expect(mocks.audiobookCacheService.syncAll).not.toHaveBeenCalled();
    });

    it("skips startup backfills when artist counts and local images are already complete", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        (mocks.isBackfillNeeded as jest.Mock).mockResolvedValueOnce(false);
        (mocks.isImageBackfillNeeded as jest.Mock).mockResolvedValueOnce({
            needed: false,
            artistsWithExternalUrls: 0,
            albumsWithExternalUrls: 0,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];
        expect(schedulerHandler).toBeTruthy();

        await schedulerHandler({
            id: "artist-counts-skip",
            name: "artist-counts-backfill-startup",
            data: {},
        });
        await schedulerHandler({
            id: "image-backfill-skip",
            name: "image-backfill-startup",
            data: {},
        });

        expect(mocks.logger.debug).toHaveBeenCalledWith(
            "Artist counts already populated",
        );
        expect(mocks.logger.debug).toHaveBeenCalledWith(
            "All images already stored locally",
        );
        expect(mocks.backfillAllArtistCounts).not.toHaveBeenCalled();
        expect(mocks.backfillAllImages).not.toHaveBeenCalled();
    });

    it("propagates timeout-wrapped operation failures from scheduler maintenance jobs", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.cleanupExpiredCache.mockRejectedValueOnce(
            new Error("podcast cleanup failed"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];
        expect(schedulerHandler).toBeTruthy();

        await expect(
            schedulerHandler({
                id: "podcast-cleanup-fail",
                name: "podcast-cache-cleanup",
                data: {},
            }),
        ).rejects.toThrow("podcast cleanup failed");
    });

    it("warns on unknown scheduler wildcard job types", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];

        await schedulerHandler({
            id: "unknown-1",
            name: "unknown-job-type",
            data: {},
        });

        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                'Scheduler wildcard received unknown job type "unknown-job-type"',
            ),
        );
    });

    it("logs scheduler claim acquisition failure after redis retry exhaustion", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.schedulerLockRedis.set.mockRejectedValue(
            new Error("Connection is closed"),
        );
        const setTimeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((cb: (...args: any[]) => void) => {
                cb();
                return 0 as unknown as NodeJS.Timeout;
            }) as any);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];

        const handlerPromise = schedulerHandler({
            id: "sched-claim-fail",
            name: "data-integrity-check",
            data: { mode: "repeat" },
        });
        await handlerPromise;
        setTimeoutSpy.mockRestore();

        expect(mocks.runDataIntegrityCheck).not.toHaveBeenCalled();
        expect(mocks.schedulerLockRedis.disconnect).toHaveBeenCalled();
        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.stringContaining("Failed to claim data integrity check"),
            expect.any(Error),
        );
    });

    it("warns when scheduler claim release fails after job execution", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.schedulerLockRedis.eval.mockRejectedValue(
            new Error("Connection is closed"),
        );
        const setTimeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((cb: (...args: any[]) => void) => {
                cb();
                return 0 as unknown as NodeJS.Timeout;
            }) as any);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];

        const handlerPromise = schedulerHandler({
            id: "sched-release-fail",
            name: "data-integrity-check",
            data: { mode: "repeat" },
        });
        await handlerPromise;
        setTimeoutSpy.mockRestore();

        expect(mocks.runDataIntegrityCheck).toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                "Failed to release claim for data integrity check",
            ),
            expect.any(Error),
        );
    });

    it("retries scheduler claim acquisition across non-Error redis message variants", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        const setTimeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((cb: (...args: any[]) => void) => {
                cb();
                return 0 as unknown as NodeJS.Timeout;
            }) as any);

        mocks.schedulerLockRedis.set
            .mockRejectedValueOnce("Connection is in closing state")
            .mockResolvedValueOnce("OK")
            .mockRejectedValueOnce("ECONNRESET")
            .mockResolvedValueOnce("OK")
            .mockRejectedValueOnce("ETIMEDOUT")
            .mockResolvedValueOnce("OK")
            .mockRejectedValueOnce("EPIPE")
            .mockResolvedValueOnce("OK");

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];

        await schedulerHandler({
            id: "claim-retry-1",
            name: "data-integrity-check",
            data: { mode: "repeat" },
        });
        await schedulerHandler({
            id: "claim-retry-2",
            name: "data-integrity-check",
            data: { mode: "repeat" },
        });
        await schedulerHandler({
            id: "claim-retry-3",
            name: "data-integrity-check",
            data: { mode: "repeat" },
        });
        await schedulerHandler({
            id: "claim-retry-4",
            name: "data-integrity-check",
            data: { mode: "repeat" },
        });
        setTimeoutSpy.mockRestore();

        expect(mocks.runDataIntegrityCheck).toHaveBeenCalledTimes(4);
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("claim acquire for data integrity check"),
            expect.anything(),
        );
    });

    it("registers queue event handlers and logs event activity", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const getHandler = (queue: { on: jest.Mock }, event: string) =>
            queue.on.mock.calls.find((call) => call[0] === event)?.[1];

        const job = { id: "job-1", data: { userId: "u1" }, name: "n1" };

        getHandler(mocks.scanQueue, "completed")(job, {
            tracksAdded: 1,
            tracksUpdated: 2,
            tracksRemoved: 3,
        });
        getHandler(mocks.scanQueue, "failed")(job, new Error("scan-failed"));
        getHandler(mocks.scanQueue, "active")(job);

        getHandler(mocks.discoverQueue, "completed")(job, {
            success: true,
            playlistName: "Discover",
            songCount: 25,
        });
        getHandler(mocks.discoverQueue, "completed")(job, {
            success: false,
            error: "discover-failed",
        });
        getHandler(mocks.discoverQueue, "failed")(
            job,
            new Error("discover-failed"),
        );
        getHandler(mocks.discoverQueue, "active")(job);

        getHandler(mocks.imageQueue, "completed")(job, {
            success: false,
            error: "img-failed",
        });
        getHandler(mocks.imageQueue, "failed")(job, new Error("img-failed"));

        getHandler(mocks.validationQueue, "completed")(job, {
            tracksChecked: 100,
            tracksRemoved: 2,
        });
        getHandler(mocks.validationQueue, "failed")(
            job,
            new Error("val-failed"),
        );
        getHandler(mocks.validationQueue, "active")(job);

        getHandler(mocks.genericImportQueue, "active")(job);
        getHandler(mocks.genericImportQueue, "completed")(job);
        const genericImportError = new Error("import-retries-exhausted");
        getHandler(mocks.genericImportQueue, "failed")(job, genericImportError);
        await flushPromises();

        getHandler(
            mocks.schedulerQueue,
            "completed",
        )({
            ...job,
            name: "data-integrity-check",
        });
        getHandler(mocks.schedulerQueue, "failed")(
            { ...job, name: "data-integrity-check" },
            new Error("sched-failed"),
        );

        expect(mocks.logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("Scan job job-1 completed"),
        );
        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.stringContaining("Scheduler job job-1 failed"),
            "sched-failed",
        );
        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.stringMatching(
                /workerId=.* event=failed queue=worker-scheduler count=\d+/,
            ),
        );
        expect(mocks.finalizeGenericImportQueueFailure).toHaveBeenCalledWith(
            job,
            genericImportError,
        );
    });

    it("handles scheduler failed/completed event logs when job identity is missing", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerCompleted = mocks.schedulerQueue.on.mock.calls.find(
            (call) => call[0] === "completed",
        )?.[1];
        const schedulerFailed = mocks.schedulerQueue.on.mock.calls.find(
            (call) => call[0] === "failed",
        )?.[1];
        expect(schedulerCompleted).toBeTruthy();
        expect(schedulerFailed).toBeTruthy();

        schedulerCompleted({} as any);
        schedulerFailed({} as any, new Error("missing identity"));
        schedulerFailed(undefined, new Error("unknown scheduler failure"));

        expect(mocks.logger.error).toHaveBeenCalledWith(
            expect.stringContaining("Scheduler job unknown failed (unknown)"),
            "unknown scheduler failure",
        );
    });

    it("logs startup failures for enrichment worker startup and scheduler registration", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.startUnifiedEnrichmentWorker.mockRejectedValueOnce(
            new Error("enrichment-startup-fail"),
        );
        mocks.startMoodBucketWorker.mockRejectedValueOnce(
            new Error("mood-startup-fail"),
        );
        mocks.schedulerQueue.isReady.mockRejectedValueOnce(
            new Error("scheduler-not-ready"),
        );
        mocks.registerRecoveryJobs.mockRejectedValueOnce(
            new Error("generic-import-recovery-not-ready"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        expect(mocks.logger.error).toHaveBeenCalledWith(
            "Failed to start unified enrichment worker:",
            expect.any(Error),
        );
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "Failed to start mood bucket worker:",
            expect.any(Error),
        );
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "Failed to register scheduler queue jobs:",
            expect.any(Error),
        );
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "Failed to register generic import recovery jobs",
            expect.objectContaining({ error: expect.any(Error) }),
        );
    });

    it("runs reconciliation scheduler cycles and logs activity counts", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.simpleDownloadManager.markStaleJobsAsFailed.mockResolvedValueOnce(
            2,
        );
        mocks.simpleDownloadManager.reconcileWithLidarr.mockResolvedValueOnce({
            reconciled: 3,
        });
        mocks.queueCleaner.reconcileWithLocalLibrary.mockResolvedValueOnce({
            reconciled: 4,
        });
        mocks.simpleDownloadManager.syncWithLidarrQueue.mockResolvedValueOnce({
            cancelled: 1,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];

        await schedulerHandler({
            id: "reconcile-1",
            name: "download-reconciliation-cycle",
            data: { mode: "repeat" },
        });

        expect(
            mocks.lidarrService.getReconciliationSnapshot,
        ).toHaveBeenCalled();
        expect(
            mocks.simpleDownloadManager.markStaleJobsAsFailed,
        ).toHaveBeenCalled();
        expect(
            mocks.simpleDownloadManager.reconcileWithLidarr,
        ).toHaveBeenCalled();
        expect(mocks.queueCleaner.reconcileWithLocalLibrary).toHaveBeenCalled();
        expect(
            mocks.simpleDownloadManager.syncWithLidarrQueue,
        ).toHaveBeenCalled();
        expect(mocks.logger.debug).toHaveBeenCalledWith(
            expect.stringContaining(
                "Periodic reconcile: 3 job(s) matched in Lidarr",
            ),
        );
    });

    it("handles reconciliation cycles with zero deltas without positive-count logs", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.simpleDownloadManager.markStaleJobsAsFailed.mockResolvedValueOnce(
            0,
        );
        mocks.simpleDownloadManager.reconcileWithLidarr.mockResolvedValueOnce({
            reconciled: 0,
        });
        mocks.queueCleaner.reconcileWithLocalLibrary.mockResolvedValueOnce({
            reconciled: 0,
        });
        mocks.simpleDownloadManager.syncWithLidarrQueue.mockResolvedValueOnce({
            cancelled: 0,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];

        await schedulerHandler({
            id: "reconcile-zero-1",
            name: "download-reconciliation-cycle",
            data: { mode: "repeat" },
        });

        expect(mocks.logger.debug).not.toHaveBeenCalledWith(
            expect.stringContaining("Periodic cleanup: marked"),
        );
        expect(mocks.logger.debug).not.toHaveBeenCalledWith(
            expect.stringContaining(
                "Periodic reconcile: 0 job(s) matched in Lidarr",
            ),
        );
        expect(mocks.logger.debug).not.toHaveBeenCalledWith(
            expect.stringContaining(
                "Periodic sync: 0 job(s) synced with Lidarr queue",
            ),
        );
    });

    it("runs lidarr cleanup in startup/repeat modes and executes cache warmup", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.simpleDownloadManager.clearLidarrQueue
            .mockResolvedValueOnce({ removed: 2 })
            .mockResolvedValueOnce({ removed: 0 })
            .mockResolvedValueOnce({ removed: 1 });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];

        await schedulerHandler({
            id: "cleanup-startup",
            name: "lidarr-cleanup-cycle",
            data: { mode: "startup" },
        });
        await schedulerHandler({
            id: "cleanup-startup-empty",
            name: "lidarr-cleanup-cycle",
            data: { mode: "startup" },
        });
        await schedulerHandler({
            id: "cleanup-repeat",
            name: "lidarr-cleanup-cycle",
            data: { mode: "repeat" },
        });
        await schedulerHandler({
            id: "cache-warmup",
            name: "cache-warmup-startup",
            data: { mode: "startup" },
        });

        expect(
            mocks.simpleDownloadManager.clearLidarrQueue,
        ).toHaveBeenCalledTimes(3);
        expect(mocks.dataCacheService.warmupCache).toHaveBeenCalledTimes(1);
        expect(mocks.logger.debug).toHaveBeenCalledWith(
            "Running initial Lidarr queue cleanup...",
        );
        expect(mocks.logger.debug).toHaveBeenCalledWith(
            "Initial cleanup: queue is clean",
        );
        expect(mocks.logger.debug).toHaveBeenCalledWith(
            "Periodic Lidarr cleanup: removed 1 stuck download(s)",
        );
    });

    it("skips repeat-mode lidarr cleanup logs when nothing is removed", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.simpleDownloadManager.clearLidarrQueue.mockResolvedValueOnce({
            removed: 0,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];

        await schedulerHandler({
            id: "cleanup-repeat-zero",
            name: "lidarr-cleanup-cycle",
            data: { mode: "repeat" },
        });

        expect(mocks.logger.debug).not.toHaveBeenCalledWith(
            "Initial cleanup: queue is clean",
        );
        expect(mocks.logger.debug).not.toHaveBeenCalledWith(
            expect.stringContaining("Periodic Lidarr cleanup: removed"),
        );
    });

    it("times out startup maintenance tasks and skips completion logs when timed out", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        const prisma = require("../../utils/db").prisma;
        const neverSyncAll = () =>
            new Promise<{ synced: number }>(() => undefined);
        const neverReconcileOnStartup = () =>
            new Promise<{ loaded: number; failed: number }>(() => undefined);
        const neverBackfillArtistCounts = () =>
            new Promise<{ processed: number; errors: number }>(() => undefined);
        const neverBackfillImages = () =>
            new Promise<undefined>(() => undefined);
        const setTimeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((cb: (...args: any[]) => void) => {
                cb();
                return 0 as unknown as NodeJS.Timeout;
            }) as any);

        (mocks.getSystemSettings as jest.Mock).mockResolvedValue({
            audiobookshelfEnabled: true,
            audiobookshelfUrl: "http://audiobookshelf",
        });
        prisma.audiobook.count.mockResolvedValueOnce(0);
        mocks.audiobookCacheService.syncAll.mockImplementationOnce(
            neverSyncAll,
        );
        mocks.downloadQueueManager.reconcileOnStartup.mockImplementationOnce(
            neverReconcileOnStartup,
        );
        mocks.isBackfillNeeded.mockResolvedValueOnce(true);
        mocks.backfillAllArtistCounts.mockImplementationOnce(
            neverBackfillArtistCounts,
        );
        mocks.isImageBackfillNeeded.mockResolvedValueOnce({
            needed: true,
            artistsWithExternalUrls: 1,
            albumsWithExternalUrls: 1,
        });
        mocks.backfillAllImages.mockImplementationOnce(neverBackfillImages);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];

        await schedulerHandler({
            id: "podcast-startup-branch",
            name: "podcast-cache-cleanup",
            data: { mode: "startup" },
        });
        await schedulerHandler({
            id: "audiobook-timeout",
            name: "audiobook-auto-sync-startup",
            data: { mode: "startup" },
        });
        await schedulerHandler({
            id: "download-reconcile-timeout",
            name: "download-queue-reconcile-startup",
            data: { mode: "startup" },
        });
        await schedulerHandler({
            id: "artist-backfill-timeout",
            name: "artist-counts-backfill-startup",
            data: { mode: "startup" },
        });
        await schedulerHandler({
            id: "image-backfill-timeout",
            name: "image-backfill-startup",
            data: { mode: "startup" },
        });
        setTimeoutSpy.mockRestore();

        expect(mocks.logger.debug).not.toHaveBeenCalledWith(
            expect.stringContaining("Audiobook auto-sync complete:"),
        );
        expect(mocks.logger.debug).not.toHaveBeenCalledWith(
            expect.stringContaining("Download queue reconciled:"),
        );
        expect(mocks.logger.info).not.toHaveBeenCalledWith(
            expect.stringContaining("Artist counts backfill complete:"),
        );
        expect(mocks.logger.info).not.toHaveBeenCalledWith(
            "Image backfill complete",
        );
    });

    it("emits scheduler claim observability logs after repeated skipped claims", async () => {
        process.env = {
            ...originalEnv,
            SCHEDULER_CLAIM_SKIP_WARN_THRESHOLD: "1",
        };
        const mocks = setupWorkerModuleMocks();
        mocks.schedulerLockRedis.set.mockResolvedValue(
            null as unknown as string,
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];

        for (let i = 0; i < 25; i += 1) {
            await schedulerHandler({
                id: `skip-${i}`,
                name: "data-integrity-check",
                data: { mode: "repeat" },
            });
        }

        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("data integrity check skipped"),
        );
        const claimObservabilityMessage = mocks.logger.info.mock.calls
            .map(([message]) => message)
            .find(
                (message) =>
                    typeof message === "string" &&
                    message.includes("acquired="),
            );
        expect(claimObservabilityMessage).toEqual(
            expect.stringContaining("workerId="),
        );
        expect(claimObservabilityMessage).toEqual(
            expect.stringContaining("acquired="),
        );
    });

    it("handles scheduler timeout paths when lidarr cleanup exceeds timeout", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.simpleDownloadManager.clearLidarrQueue.mockImplementation(
            () => new Promise(() => undefined),
        );
        const setTimeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((cb: (...args: any[]) => void) => {
                cb();
                return 0 as unknown as NodeJS.Timeout;
            }) as any);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];

        await schedulerHandler({
            id: "cleanup-timeout",
            name: "lidarr-cleanup-cycle",
            data: { mode: "startup" },
        });
        setTimeoutSpy.mockRestore();

        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Operation timed out after 180000ms"),
        );
    });

    it("surfaces scheduler processor errors when a job handler throws", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.runDataIntegrityCheck.mockRejectedValueOnce(
            new Error("integrity failed"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];

        await expect(
            schedulerHandler({
                id: "scheduler-err-1",
                name: "data-integrity-check",
                data: { mode: "repeat" },
            }),
        ).rejects.toThrow("integrity failed");
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "Scheduler processor failed (data-integrity-check):",
            expect.any(Error),
        );
    });

    it("logs non-duplicate unavailable-album persistence failures", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const callback =
            mocks.downloadQueueManager.onUnavailableAlbum.mock.calls[0][0];
        const prisma = require("../../utils/db").prisma;
        prisma.unavailableAlbum.create.mockRejectedValueOnce(
            new Error("db write failed"),
        );

        await expect(
            callback({
                userId: "user-2",
                artistName: "Artist X",
                albumTitle: "Album X",
                albumMbid: "rg-x",
                artistMbid: "a-x",
                similarity: 0.4,
                tier: "medium",
            }),
        ).resolves.toBeUndefined();

        expect(mocks.logger.error).toHaveBeenCalledWith(
            " Failed to record unavailable album:",
            "db write failed",
        );
    });

    it("logs successful unavailable-album persistence writes", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const callback =
            mocks.downloadQueueManager.onUnavailableAlbum.mock.calls[0][0];

        await expect(
            callback({
                userId: "user-3",
                artistName: "Artist Success",
                albumTitle: "Album Success",
                albumMbid: "rg-success",
                artistMbid: "artist-success",
                similarity: 0.88,
                tier: "high",
            }),
        ).resolves.toBeUndefined();

        expect(mocks.logger.debug).toHaveBeenCalledWith(
            "   Recorded in database",
        );
    });

    it("applies unavailable-album fallback defaults for similarity and tier", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        const prisma = require("../../utils/db").prisma;

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const callback =
            mocks.downloadQueueManager.onUnavailableAlbum.mock.calls[0][0];
        await callback({
            userId: "user-defaults",
            artistName: "Artist Defaults",
            albumTitle: "Album Defaults",
            albumMbid: "rg-defaults",
            artistMbid: "artist-defaults",
            similarity: undefined,
            tier: undefined,
        });

        expect(prisma.unavailableAlbum.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    similarity: 0,
                    tier: "unknown",
                }),
            }),
        );
    });

    it("logs image queue completion success branch", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const imageCompleted = mocks.imageQueue.on.mock.calls.find(
            (call) => call[0] === "completed",
        )?.[1];
        expect(imageCompleted).toBeTruthy();

        imageCompleted({ id: "img-success", data: {}, name: "image" } as any, {
            success: true,
            error: "n/a",
        });

        expect(mocks.logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("Image job img-success completed: success"),
        );
    });

    it("logs shutdown disconnect failures while still completing shutdown", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.enrichmentStateService.disconnect.mockRejectedValueOnce(
            new Error("enrichment disconnect failed"),
        );
        mocks.shutdownDiscoverProcessor.mockRejectedValueOnce(
            new Error("discover disconnect failed"),
        );
        mocks.schedulerLockRedis.quit.mockRejectedValueOnce(
            new Error("redis quit failed"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const workers = require("../index");
        await flushPromises();

        await expect(workers.shutdownWorkers()).resolves.toBeUndefined();
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "Failed to disconnect enrichment state service:",
            expect.any(Error),
        );
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "Failed to disconnect discover processor Redis:",
            expect.any(Error),
        );
        expect(mocks.logger.error).toHaveBeenCalledWith(
            "Failed to disconnect worker scheduler lock Redis:",
            expect.any(Error),
        );
    });
});
