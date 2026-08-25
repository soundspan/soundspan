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
            removeRepeatable: jest.fn(async () => undefined),
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
        federation?: boolean;
        requests?: boolean;
        vibeProviderUrl?: string;
    }) {
        const { vibeProviderUrl, ...featureFlags } = featureOverrides ?? {};
        const scanQueue = createQueueMock();
        const discoverQueue = createQueueMock();
        const imageQueue = createQueueMock();
        const validationQueue = createQueueMock();
        const schedulerQueue = createQueueMock();
        const schedulerMaintenanceQueue = createQueueMock();
        const genericImportQueue = createQueueMock();
        const federationQueue = createQueueMock();
        const albumDownloadQueue = createQueueMock();

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
        const startVibeEmbedWorker = jest.fn(async () =>
            Boolean(vibeProviderUrl && featureFlags.audioAnalysis !== false),
        );
        const stopVibeEmbedWorker = jest.fn(async () => undefined);
        const startDiscoverWeeklyCron = jest.fn();
        const stopDiscoverWeeklyCron = jest.fn();
        const processDiscoverCronTick = jest.fn(async () => ({ ok: true }));
        const processGenericImport = jest.fn(async () => undefined);
        const processTrackRemovalPurge = jest.fn(async () => ({
            deleted: 0,
            continued: false,
        }));
        const processLoudnessBackfill = jest.fn(async () => ({
            processed: 0,
            queued: 0,
            duplicates: 0,
            skipped: 0,
            continued: false,
            capacityLimited: false,
        }));
        const processRequestFulfillmentBatch = jest.fn(async () => ({
            selected: 0,
            fulfilled: 0,
            failed: 0,
        }));
        const processCatalogRetention = jest.fn(async () => ({
            skipped: false,
            scanned: 0,
            protected: 0,
            reaped: 0,
            remaining: 0,
        }));
        const finalizeGenericImportQueueFailure = jest.fn(
            async () => undefined,
        );
        const processAlbumDownload = jest.fn(async () => undefined);
        const processArtistDownloadExpansion = jest.fn(async () => undefined);
        const finalizeAlbumDownloadQueueFailure = jest.fn(
            async () => undefined,
        );
        const recoverUnqueuedAlbumDownloads = jest.fn(async () => 0);
        const recoverUnqueuedArtistDownloadExpansions = jest.fn(async () => 0);
        const recordAlbumDownloadOutcome = jest.fn();
        const recordSchedulerJobDuration = jest.fn();
        const recordSchedulerJobSuccess = jest.fn();
        const recordSchedulerTimeout = jest.fn();
        const registerRecoveryJobs = jest.fn(async () => undefined);
        const registerFederationProcessors = jest.fn();
        const registerFederationSchedules = jest.fn(async () => undefined);
        const runDataIntegrityCheck = jest.fn(async () => undefined);
        const shutdownDiscoverProcessor = jest.fn(async () => undefined);
        const cleanupExpiredCache = jest.fn(async () => undefined);
        const getSystemSettings = jest.fn(async () => ({
            audiobookshelfEnabled: false,
            audiobookshelfUrl: null,
        }));
        const audiobookCacheService = {
            syncAll: jest.fn(async () => ({ synced: 0 })),
            syncMissing: jest.fn(async () => ({
                synced: 0,
                failed: 0,
                skipped: 0,
                errors: [] as string[],
            })),
        };
        const isBackfillNeeded = jest.fn(async () => false);
        const backfillAllArtistCounts = jest.fn(async () => ({
            processed: 0,
            errors: 0,
        }));
        const consumeCoalescedScanFollowUp = jest.fn(async () => undefined);
        const closeCoalescedLibraryScanRedis = jest.fn(async () => undefined);
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
            expire: jest.fn(async () => 1),
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
            schedulerMaintenanceQueue,
            genericImportQueue,
            federationQueue,
            albumDownloadQueue,
        }));
        jest.doMock("../federationJobs", () => ({
            registerFederationProcessors,
            registerFederationSchedules,
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
        jest.doMock("../processors/albumDownloadProcessor", () => ({
            ALBUM_DOWNLOAD_JOB_NAME: "album-download",
            ALBUM_DOWNLOAD_WORKER_CONCURRENCY: 1,
            processAlbumDownload,
            finalizeAlbumDownloadQueueFailure,
        }));
        jest.doMock("../processors/artistDownloadExpansionProcessor", () => ({
            processArtistDownloadExpansion,
        }));
        jest.doMock("../../services/albumDownloadQueueService", () => ({
            ARTIST_DOWNLOAD_EXPANSION_JOB_NAME: "artist-download-expand",
            recoverUnqueuedAlbumDownloads,
            recoverUnqueuedArtistDownloadExpansions,
        }));
        jest.doMock("../../metrics", () => ({
            recordAlbumDownloadOutcome,
            recordSchedulerJobDuration,
            recordSchedulerJobSuccess,
            recordSchedulerTimeout,
        }));
        jest.doMock("../processors/trackRemovalPurgeProcessor", () => ({
            TRACK_REMOVAL_PURGE_JOB_NAME: "track-removal-purge",
            processTrackRemovalPurge,
        }));
        jest.doMock("../processors/loudnessBackfillProcessor", () => ({
            LOUDNESS_BACKFILL_JOB_NAME: "track-loudness-backfill",
            processLoudnessBackfill,
        }));
        jest.doMock("../processors/requestFulfillmentProcessor", () => ({
            processRequestFulfillmentBatch,
        }));
        jest.doMock("../processors/catalogRetentionProcessor", () => ({
            processCatalogRetention,
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
        jest.doMock("../vibeEmbedWorker", () => ({
            startVibeEmbedWorker,
            stopVibeEmbedWorker,
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
                vibeProviderUrl,
                vibeEmbedConcurrency: 1,
                underJest: true,
                workers: { schedulerClaimSkipWarnThreshold: 3 },
                features: {
                    audioAnalysis: true,
                    discovery: true,
                    autoPlaylists: true,
                    federation: false,
                    requests: true,
                    ...featureFlags,
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
        jest.doMock("../../services/coalescedLibraryScan", () => ({
            COALESCED_SCAN_JOB_ID: "coalesced-library-scan",
            consumeCoalescedScanFollowUp,
            closeCoalescedLibraryScanRedis,
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
            schedulerMaintenanceQueue,
            genericImportQueue,
            federationQueue,
            albumDownloadQueue,
            logger,
            startUnifiedEnrichmentWorker,
            stopUnifiedEnrichmentWorker,
            startMoodBucketWorker,
            stopMoodBucketWorker,
            startVibeEmbedWorker,
            stopVibeEmbedWorker,
            startDiscoverWeeklyCron,
            stopDiscoverWeeklyCron,
            processGenericImport,
            processTrackRemovalPurge,
            processLoudnessBackfill,
            processRequestFulfillmentBatch,
            processCatalogRetention,
            finalizeGenericImportQueueFailure,
            processAlbumDownload,
            processArtistDownloadExpansion,
            finalizeAlbumDownloadQueueFailure,
            recoverUnqueuedAlbumDownloads,
            recoverUnqueuedArtistDownloadExpansions,
            recordAlbumDownloadOutcome,
            recordSchedulerJobDuration,
            recordSchedulerJobSuccess,
            recordSchedulerTimeout,
            registerRecoveryJobs,
            registerFederationProcessors,
            registerFederationSchedules,
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
            consumeCoalescedScanFollowUp,
            closeCoalescedLibraryScanRedis,
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
        expect(mocks.schedulerQueue.process).toHaveBeenCalledWith(
            "download-reconciliation-cycle",
            1,
            expect.any(Function),
        );
        expect(mocks.schedulerMaintenanceQueue.process).toHaveBeenCalledWith(
            "data-integrity-check",
            1,
            expect.any(Function),
        );
        expect(mocks.schedulerQueue.process).not.toHaveBeenCalledWith(
            "data-integrity-check",
            1,
            expect.any(Function),
        );
        expect(
            mocks.schedulerMaintenanceQueue.process,
        ).not.toHaveBeenCalledWith(
            "download-reconciliation-cycle",
            1,
            expect.any(Function),
        );
        expect(mocks.genericImportQueue.process).toHaveBeenCalledWith(
            "*",
            2,
            mocks.processGenericImport,
        );
        expect(mocks.albumDownloadQueue.process).toHaveBeenCalledWith(
            "album-download",
            1,
            mocks.processAlbumDownload,
        );
        expect(mocks.albumDownloadQueue.process).toHaveBeenCalledWith(
            "artist-download-expand",
            1,
            mocks.processArtistDownloadExpansion,
        );
        expect(mocks.registerRecoveryJobs).toHaveBeenCalledTimes(1);
        expect(mocks.registerFederationProcessors).not.toHaveBeenCalled();
        expect(mocks.registerFederationSchedules).not.toHaveBeenCalled();
        expect(mocks.startUnifiedEnrichmentWorker).toHaveBeenCalledTimes(1);
        expect(mocks.startMoodBucketWorker).toHaveBeenCalledTimes(1);
        expect(mocks.startVibeEmbedWorker).toHaveBeenCalledTimes(1);
        expect(mocks.startDiscoverWeeklyCron).toHaveBeenCalledTimes(1);
        expect(mocks.stopDiscoverWeeklyCron).not.toHaveBeenCalled();
        expect(mocks.schedulerQueue.isReady).toHaveBeenCalledTimes(1);
        expect(mocks.schedulerMaintenanceQueue.isReady).toHaveBeenCalledTimes(
            1,
        );
        const namedSchedulerRegistrationIndex =
            mocks.schedulerQueue.process.mock.calls.findIndex(
                (call) => call[0] === "download-reconciliation-cycle",
            );
        expect(
            mocks.schedulerQueue.isReady.mock.invocationCallOrder[0],
        ).toBeLessThan(
            mocks.schedulerQueue.process.mock.invocationCallOrder[
                namedSchedulerRegistrationIndex
            ],
        );
        expect(mocks.schedulerQueue.add).toHaveBeenCalled();
        expect(mocks.schedulerQueue.add).toHaveBeenCalledWith(
            "album-download-recovery-cycle",
            { mode: "startup" },
            {
                jobId: "scheduler:album-download-recovery:startup",
                delay: 60_000,
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
        expect(mocks.schedulerMaintenanceQueue.add).toHaveBeenCalledWith(
            "catalog-retention-sweep",
            { mode: "startup" },
            {
                jobId: "scheduler:catalog-retention:startup",
                delay: 2 * 60_000,
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
        expect(mocks.schedulerMaintenanceQueue.add).toHaveBeenCalledWith(
            "catalog-retention-sweep",
            { mode: "repeat" },
            {
                jobId: "scheduler:catalog-retention:repeat",
                repeat: { every: 60 * 60_000 },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
        expect(mocks.schedulerQueue.add).toHaveBeenCalledWith(
            "album-download-recovery-cycle",
            { mode: "repeat" },
            {
                jobId: "scheduler:album-download-recovery:repeat",
                repeat: { cron: "30 */5 * * * *" },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
        expect(mocks.schedulerMaintenanceQueue.add).toHaveBeenCalledWith(
            "audiobook-auto-sync-startup",
            { mode: "repeat" },
            {
                jobId: "scheduler:audiobook-auto-sync:repeat",
                repeat: { cron: "9 */5 * * * *" },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
        expect(mocks.schedulerMaintenanceQueue.add).toHaveBeenCalledWith(
            "track-audio-hash-backfill",
            {
                mode: "startup",
                sweepStartedAt: expect.any(String),
            },
            expect.objectContaining({
                jobId: "scheduler:audio-hash-backfill:startup",
            }),
        );
        expect(mocks.schedulerMaintenanceQueue.add).toHaveBeenCalledWith(
            "track-loudness-backfill",
            {
                mode: "startup",
                sweepStartedAt: expect.any(String),
            },
            expect.objectContaining({
                jobId: "scheduler:loudness-backfill:startup",
                delay: 55_000,
            }),
        );
        expect(mocks.schedulerMaintenanceQueue.add).toHaveBeenCalledWith(
            "track-loudness-backfill",
            { mode: "repeat" },
            {
                jobId: "scheduler:loudness-backfill:repeat",
                repeat: { every: 6 * 60 * 60 * 1000 },
                attempts: 3,
                backoff: { type: "exponential", delay: 5_000 },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
        expect(mocks.schedulerMaintenanceQueue.add).toHaveBeenCalledWith(
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
        expect(mocks.schedulerMaintenanceQueue.add).toHaveBeenCalledWith(
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
        expect(mocks.schedulerMaintenanceQueue.add).toHaveBeenCalledWith(
            "request-fulfillment-reconcile",
            { mode: "repeat" },
            {
                jobId: "scheduler:request-fulfillment:repeat",
                repeat: { cron: "33 */5 * * * *" },
                removeOnComplete: true,
                removeOnFail: 10,
            },
        );
        expect(mocks.schedulerQueue.removeRepeatable).toHaveBeenCalledWith(
            "album-download-recovery-cycle",
            {
                every: 5 * 60_000,
                jobId: "scheduler:album-download-recovery:repeat",
            },
        );
        expect(mocks.schedulerQueue.removeRepeatable).toHaveBeenCalledWith(
            "catalog-retention-sweep",
            {
                every: 60 * 60_000,
                jobId: "scheduler:catalog-retention:repeat",
            },
        );
    });

    it("registers slow and fast jobs on structurally isolated queues", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const fastNames = mocks.schedulerQueue.process.mock.calls.map(
            (call) => call[0],
        );
        const slowNames =
            mocks.schedulerMaintenanceQueue.process.mock.calls.map(
                (call) => call[0],
            );
        expect(fastNames).toEqual(
            expect.arrayContaining([
                "download-reconciliation-cycle",
                "album-download-recovery-cycle",
                "lidarr-cleanup-cycle",
                "*",
            ]),
        );
        expect(fastNames).not.toContain("data-integrity-check");
        expect(slowNames).toContain("data-integrity-check");
        expect(slowNames).not.toContain("download-reconciliation-cycle");
        expect(mocks.schedulerQueue.add).toHaveBeenCalledWith(
            "download-reconciliation-cycle",
            expect.anything(),
            expect.anything(),
        );
        expect(mocks.schedulerMaintenanceQueue.add).toHaveBeenCalledWith(
            "data-integrity-check",
            expect.anything(),
            expect.anything(),
        );
    });

    it("continues scheduler registration after one legacy removal fails", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.schedulerQueue.removeRepeatable.mockRejectedValueOnce(
            new Error("transient repeat removal failure"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        expect(mocks.schedulerMaintenanceQueue.add).toHaveBeenCalledWith(
            "data-integrity-check",
            { mode: "repeat" },
            expect.objectContaining({
                jobId: "scheduler:data-integrity:repeat",
            }),
        );
        expect(mocks.schedulerQueue.add).toHaveBeenCalledWith(
            "download-reconciliation-cycle",
            expect.anything(),
            expect.anything(),
        );
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Failed scheduler registration step"),
            expect.objectContaining({ error: expect.any(Error) }),
        );
    });

    it("opens the reconciliation circuit after three failures and skips the next tick", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.lidarrService.getReconciliationSnapshot.mockRejectedValue(
            new Error("lidarr unavailable"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();
        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];
        const job = {
            id: "reconciliation-failure",
            name: "download-reconciliation-cycle",
            data: { mode: "repeat" },
        };

        for (let attempt = 0; attempt < 3; attempt += 1) {
            await expect(schedulerHandler(job)).rejects.toThrow(
                "lidarr unavailable",
            );
        }
        await expect(schedulerHandler(job)).resolves.toBeUndefined();

        expect(
            mocks.lidarrService.getReconciliationSnapshot,
        ).toHaveBeenCalledTimes(3);
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            "Skipping reconciliation while circuit breaker is open",
            expect.objectContaining({
                circuit: { state: "open", consecutiveFailures: 3 },
            }),
        );
    });

    it("finishes never-settling reconciliation timeouts and records breaker failures", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.lidarrService.getReconciliationSnapshot.mockImplementation(
            () => new Promise(() => undefined),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();
        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];
        const job = {
            id: "never-settling-reconciliation",
            name: "download-reconciliation-cycle",
            data: { mode: "repeat" },
        };
        jest.useFakeTimers();

        for (let attempt = 0; attempt < 3; attempt += 1) {
            const tick = schedulerHandler(job);
            const rejected = expect(tick).rejects.toThrow(
                "Scheduler operation timed out: getReconciliationSnapshot",
            );
            await jest.advanceTimersByTimeAsync(30_000);
            await jest.advanceTimersByTimeAsync(30_000);
            await rejected;
        }
        await expect(schedulerHandler(job)).resolves.toBeUndefined();

        expect(mocks.recordSchedulerTimeout).toHaveBeenCalledTimes(3);
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            "Reconciliation failure recorded by circuit breaker",
            expect.objectContaining({
                circuit: { state: "open", consecutiveFailures: 3 },
                error: expect.any(Error),
            }),
        );
        expect(
            mocks.lidarrService.getReconciliationSnapshot,
        ).toHaveBeenCalledTimes(3);
    });

    it("removes the persisted request schedule when the feature is disabled", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks({ requests: false });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        expect(mocks.schedulerQueue.add).not.toHaveBeenCalledWith(
            "request-fulfillment-reconcile",
            expect.anything(),
            expect.anything(),
        );
        expect(mocks.schedulerQueue.removeRepeatable).toHaveBeenCalledWith(
            "request-fulfillment-reconcile",
            {
                every: 5 * 60 * 1000,
                jobId: "scheduler:request-fulfillment:repeat",
            },
        );
    });

    it("registers federation processors and schedules only when enabled", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks({ federation: true });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        expect(mocks.registerFederationProcessors).toHaveBeenCalledTimes(1);
        expect(mocks.registerFederationSchedules).toHaveBeenCalledTimes(1);
    });

    it("runs incremental audiobook sync for scheduled repeat jobs", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        (mocks.getSystemSettings as jest.Mock).mockResolvedValue({
            audiobookshelfEnabled: true,
            audiobookshelfUrl: "http://abs.local",
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {
            AUDIOBOOK_SYNC_CLAIM_TTL_MS,
            AUDIOBOOK_SYNC_WORK_TIMEOUT_MS,
        } = require("../../utils/schedulerClaim");

        expect(AUDIOBOOK_SYNC_WORK_TIMEOUT_MS).toBe(
            AUDIOBOOK_SYNC_CLAIM_TTL_MS - 10 * 60_000,
        );

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];

        await schedulerHandler({
            id: "audiobook-sync-1",
            name: "audiobook-auto-sync-startup",
            data: { mode: "repeat" },
        });

        expect(mocks.audiobookCacheService.syncMissing).toHaveBeenCalledTimes(
            1,
        );
        expect(mocks.audiobookCacheService.syncAll).not.toHaveBeenCalled();
    });

    it("resolves repeat audiobook sync failures and warns", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        (mocks.getSystemSettings as jest.Mock).mockResolvedValue({
            audiobookshelfEnabled: true,
            audiobookshelfUrl: "http://abs.local",
        });
        mocks.audiobookCacheService.syncMissing.mockRejectedValueOnce(
            new Error("abs down"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];

        await expect(
            schedulerHandler({
                id: "audiobook-sync-failure",
                name: "audiobook-auto-sync-startup",
                data: { mode: "repeat" },
            }),
        ).resolves.toBeUndefined();
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            "Repeat audiobook auto-sync failed; will retry on the next cycle",
            expect.objectContaining({ message: "abs down" }),
        );
    });

    it("debounces repeat audiobook sync failure warnings without rejecting", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        (mocks.getSystemSettings as jest.Mock).mockResolvedValue({
            audiobookshelfEnabled: true,
            audiobookshelfUrl: "http://abs.local",
        });
        mocks.audiobookCacheService.syncMissing
            .mockRejectedValueOnce(new Error("abs down"))
            .mockRejectedValueOnce(new Error("abs down"));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];
        const repeatJob = {
            id: "audiobook-sync-failure",
            name: "audiobook-auto-sync-startup",
            data: { mode: "repeat" },
        };

        await expect(schedulerHandler(repeatJob)).resolves.toBeUndefined();
        await expect(schedulerHandler(repeatJob)).resolves.toBeUndefined();

        expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            "Repeat audiobook auto-sync failed; will retry on the next cycle",
            expect.objectContaining({ message: "abs down" }),
        );
        expect(mocks.logger.debug).toHaveBeenCalledWith(
            "Repeat audiobook auto-sync failed; will retry on the next cycle",
            expect.objectContaining({ message: "abs down" }),
        );
    });

    it("propagates startup audiobook sync failures", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        (mocks.getSystemSettings as jest.Mock).mockResolvedValue({
            audiobookshelfEnabled: true,
            audiobookshelfUrl: "http://abs.local",
        });
        mocks.audiobookCacheService.syncMissing.mockRejectedValueOnce(
            new Error("abs down"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];

        await expect(
            schedulerHandler({
                id: "audiobook-startup-failure",
                name: "audiobook-auto-sync-startup",
                data: { mode: "startup" },
            }),
        ).rejects.toThrow("abs down");
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

    it("dispatches loudness backfill jobs through the scheduler", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];
        const job = {
            id: "loudness-backfill-1",
            name: "track-loudness-backfill",
            data: {
                mode: "startup",
                sweepStartedAt: "2026-08-18T12:00:00.000Z",
            },
        };

        await schedulerHandler(job);

        expect(mocks.processLoudnessBackfill).toHaveBeenCalledWith(job);
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
        expect(workers.schedulerMaintenanceQueue).toBe(
            mocks.schedulerMaintenanceQueue,
        );
        expect(workers.genericImportQueue).toBe(mocks.genericImportQueue);
        expect(workers.albumDownloadQueue).toBe(mocks.albumDownloadQueue);
    });

    it("shuts down workers and queue resources cleanly", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        const shutdownEvents: string[] = [];
        mocks.scanQueue.close.mockImplementation(async () => {
            shutdownEvents.push("scan-close");
        });
        mocks.scanQueue.removeAllListeners.mockImplementation(() => {
            shutdownEvents.push("scan-listeners-removed");
        });
        mocks.enrichmentStateService.disconnect.mockImplementation(async () => {
            shutdownEvents.push("enrichment-disconnect");
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const workers = require("../index");
        await flushPromises();

        await workers.shutdownWorkers();

        expect(mocks.stopUnifiedEnrichmentWorker).toHaveBeenCalledTimes(1);
        expect(mocks.stopMoodBucketWorker).toHaveBeenCalledTimes(1);
        expect(mocks.stopVibeEmbedWorker).toHaveBeenCalledTimes(1);
        expect(mocks.downloadQueueManager.shutdown).toHaveBeenCalledTimes(1);
        expect(mocks.scanQueue.removeAllListeners).toHaveBeenCalledTimes(1);
        expect(
            mocks.genericImportQueue.removeAllListeners,
        ).toHaveBeenCalledTimes(1);
        expect(
            mocks.albumDownloadQueue.removeAllListeners,
        ).toHaveBeenCalledTimes(1);
        expect(mocks.schedulerQueue.close).toHaveBeenCalledTimes(1);
        expect(mocks.schedulerMaintenanceQueue.close).toHaveBeenCalledTimes(1);
        expect(mocks.genericImportQueue.close).toHaveBeenCalledTimes(1);
        expect(mocks.albumDownloadQueue.close).toHaveBeenCalledTimes(1);
        expect(mocks.scanQueue.close.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.scanQueue.removeAllListeners.mock.invocationCallOrder[0],
        );
        expect(
            mocks.albumDownloadQueue.close.mock.invocationCallOrder[0],
        ).toBeLessThan(
            mocks.albumDownloadQueue.removeAllListeners.mock
                .invocationCallOrder[0],
        );
        expect(mocks.enrichmentStateService.disconnect).toHaveBeenCalledTimes(
            1,
        );
        expect(mocks.closeCoalescedLibraryScanRedis).toHaveBeenCalledTimes(1);
        expect(shutdownEvents).toEqual([
            "scan-close",
            "scan-listeners-removed",
            "enrichment-disconnect",
        ]);
        expect(mocks.shutdownDiscoverProcessor).toHaveBeenCalledTimes(1);
        expect(mocks.schedulerLockRedis.quit).toHaveBeenCalledTimes(1);
        expect(
            mocks.schedulerLockRedis.quit.mock.invocationCallOrder[0],
        ).toBeGreaterThan(
            mocks.schedulerQueue.close.mock.invocationCallOrder[0],
        );
    });

    it("awaits unified enrichment shutdown before closing queues", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        let resolveEnrichmentStop!: () => void;
        const enrichmentStop = new Promise<undefined>((resolve) => {
            resolveEnrichmentStop = () => resolve(undefined);
        });
        mocks.stopUnifiedEnrichmentWorker.mockImplementationOnce(
            () => enrichmentStop,
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const workers = require("../index");
        await flushPromises();

        const shutdown = workers.shutdownWorkers();
        await flushPromises();

        expect(mocks.stopUnifiedEnrichmentWorker).toHaveBeenCalledTimes(1);
        expect(mocks.scanQueue.close).not.toHaveBeenCalled();

        resolveEnrichmentStop();
        await shutdown;

        expect(mocks.scanQueue.close).toHaveBeenCalledTimes(1);
    });

    it("drains in-flight coalesced follow-up consumption before shutdown returns", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        let resolveConsumption!: () => void;
        const consumption = new Promise<undefined>((resolve) => {
            resolveConsumption = () => resolve(undefined);
        });
        mocks.consumeCoalescedScanFollowUp.mockImplementationOnce(
            () => consumption,
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const workers = require("../index");
        await flushPromises();
        const completedHandler = mocks.scanQueue.on.mock.calls.find(
            (call) => call[0] === "completed",
        )?.[1];
        completedHandler(
            { id: "coalesced-library-scan", data: {}, name: "scan" },
            { tracksAdded: 0, tracksUpdated: 0, tracksRemoved: 0 },
        );

        let shutdownReturned = false;
        const shutdown = workers.shutdownWorkers().then(() => {
            shutdownReturned = true;
        });
        await flushPromises();

        expect(mocks.scanQueue.close).toHaveBeenCalledTimes(1);
        expect(shutdownReturned).toBe(false);
        resolveConsumption();
        await shutdown;
        expect(shutdownReturned).toBe(true);
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
        expect(mocks.recordSchedulerJobSuccess).toHaveBeenCalledWith(
            "data-integrity-check",
            expect.any(Number),
        );
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
        expect(mocks.recordSchedulerJobSuccess).not.toHaveBeenCalled();
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
        mocks.audiobookCacheService.syncMissing.mockResolvedValue({
            synced: 4,
            failed: 0,
            skipped: 0,
            errors: [],
        });
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
        expect(mocks.audiobookCacheService.syncMissing).toHaveBeenCalled();
        expect(
            mocks.downloadQueueManager.reconcileOnStartup,
        ).toHaveBeenCalled();
        expect(mocks.backfillAllArtistCounts).toHaveBeenCalled();
        expect(mocks.backfillAllImages).toHaveBeenCalled();
    });

    it("runs the album-download recovery scheduler cycle under its claim", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.recoverUnqueuedAlbumDownloads.mockResolvedValueOnce(3);
        mocks.recoverUnqueuedArtistDownloadExpansions.mockResolvedValueOnce(2);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];
        await schedulerHandler({
            id: "album-recovery-1",
            name: "album-download-recovery-cycle",
            data: { mode: "repeat" },
        });

        expect(mocks.schedulerLockRedis.set).toHaveBeenCalledWith(
            "scheduler-claim:album-download-recovery",
            expect.any(String),
            "EX",
            300,
            "NX",
        );
        expect(mocks.recoverUnqueuedAlbumDownloads).toHaveBeenCalledTimes(1);
        expect(
            mocks.recoverUnqueuedArtistDownloadExpansions,
        ).toHaveBeenCalledTimes(1);
        expect(mocks.logger.info).toHaveBeenCalledWith(
            "Recovered 3 unqueued album downloads",
        );
        expect(mocks.logger.info).toHaveBeenCalledWith(
            "Recovered 2 unqueued artist expansions",
        );
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
            data: { mode: "startup" },
        });

        expect(mocks.logger.debug).toHaveBeenCalledWith(
            "Audiobookshelf is disabled or unconfigured - skipping auto-sync",
        );
        expect(mocks.audiobookCacheService.syncMissing).not.toHaveBeenCalled();
    });

    it("checks for missing audiobooks even when the cache is already populated", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        (mocks.getSystemSettings as jest.Mock).mockResolvedValue({
            audiobookshelfEnabled: true,
            audiobookshelfUrl: "http://audiobookshelf",
        });
        mocks.audiobookCacheService.syncMissing.mockResolvedValueOnce({
            synced: 1,
            failed: 0,
            skipped: 3,
            errors: [],
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];
        expect(schedulerHandler).toBeTruthy();

        await schedulerHandler({
            id: "audiobook-check-cached",
            name: "audiobook-auto-sync-startup",
            data: { mode: "startup" },
        });

        expect(mocks.audiobookCacheService.syncMissing).toHaveBeenCalledTimes(
            1,
        );
        expect(mocks.logger.debug).toHaveBeenCalledWith(
            "Audiobook auto-sync complete: 1 new, 3 already cached, 0 failed",
        );
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

    it("atomically extends a scheduler claim only while its token still owns the key", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.schedulerLockRedis.eval
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(0)
            .mockResolvedValue(1);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { extendSchedulerClaim } = require("../../utils/schedulerClaim");

        await expect(
            extendSchedulerClaim(
                "scheduler-claim:test",
                "claim-token",
                900_000,
            ),
        ).resolves.toBe(true);

        expect(mocks.schedulerLockRedis.eval).toHaveBeenNthCalledWith(
            1,
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
            1,
            "scheduler-claim:test",
            "claim-token",
            900_000,
        );

        await expect(
            extendSchedulerClaim(
                "scheduler-claim:test",
                "claim-token",
                900_000,
            ),
        ).resolves.toBe(false);
        expect(mocks.schedulerLockRedis.eval).toHaveBeenNthCalledWith(
            2,
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
            1,
            "scheduler-claim:test",
            "claim-token",
            900_000,
        );
        expect(mocks.schedulerLockRedis.get).not.toHaveBeenCalled();
        expect(mocks.schedulerLockRedis.expire).not.toHaveBeenCalled();

        await Promise.all(
            Array.from({ length: 23 }, () =>
                extendSchedulerClaim(
                    "scheduler-claim:test",
                    "claim-token",
                    900_000,
                ),
            ),
        );
        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.stringContaining("extended=24 failedExtend=1"),
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
        getHandler(mocks.albumDownloadQueue, "active")(job);
        getHandler(mocks.albumDownloadQueue, "completed")(job);
        getHandler(mocks.albumDownloadQueue, "stalled")(job);
        const albumDownloadError = new Error("album-download-failed");
        const finalAlbumJob = {
            ...job,
            attemptsMade: 0,
            opts: { attempts: 2 },
            getState: jest.fn().mockResolvedValue("failed"),
        };
        const retriedAlbumJob = {
            ...job,
            attemptsMade: 2,
            opts: { attempts: 2 },
            getState: jest.fn().mockResolvedValue("delayed"),
        };
        getHandler(mocks.albumDownloadQueue, "failed")(
            finalAlbumJob,
            albumDownloadError,
        );
        getHandler(mocks.albumDownloadQueue, "failed")(
            retriedAlbumJob,
            new Error("album-download-retrying"),
        );
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
        expect(mocks.logger.info).toHaveBeenCalledWith(
            expect.stringContaining(
                "job-start queue=album-download jobId=job-1 jobName=n1",
            ),
        );
        expect(mocks.finalizeGenericImportQueueFailure).toHaveBeenCalledWith(
            job,
            genericImportError,
        );
        expect(mocks.finalizeAlbumDownloadQueueFailure).toHaveBeenCalledWith(
            finalAlbumJob,
            albumDownloadError,
            "failed",
        );
        expect(mocks.finalizeAlbumDownloadQueueFailure).toHaveBeenCalledTimes(
            1,
        );
        expect(finalAlbumJob.getState).toHaveBeenCalledTimes(1);
        expect(retriedAlbumJob.getState).toHaveBeenCalledTimes(1);
        expect(mocks.recordAlbumDownloadOutcome).toHaveBeenCalledWith(
            "completed",
        );
        expect(mocks.recordAlbumDownloadOutcome).toHaveBeenCalledWith("failed");
        expect(mocks.recordAlbumDownloadOutcome).toHaveBeenCalledWith(
            "retried",
        );
        expect(
            mocks.recordAlbumDownloadOutcome.mock.calls.filter(
                ([outcome]) => outcome === "retried",
            ),
        ).toHaveLength(2);
    });

    it("consumes coalesced follow-ups from settled scan queue events", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const getHandler = (event: string) =>
            mocks.scanQueue.on.mock.calls.find(
                (call) => call[0] === event,
            )?.[1];
        const coalescedJob = {
            id: "coalesced-library-scan",
            data: {},
            name: "scan",
        };
        const otherJob = { id: "other-scan", data: {}, name: "scan" };

        getHandler("completed")(coalescedJob, {
            tracksAdded: 0,
            tracksUpdated: 0,
            tracksRemoved: 0,
        });
        getHandler("failed")(coalescedJob, new Error("scan failed"));
        getHandler("completed")(otherJob, {
            tracksAdded: 0,
            tracksUpdated: 0,
            tracksRemoved: 0,
        });
        getHandler("failed")(otherJob, new Error("other scan failed"));
        await flushPromises();

        expect(mocks.consumeCoalescedScanFollowUp).toHaveBeenCalledTimes(2);
    });

    it("warns without throwing when settled-event follow-up consumption rejects", async () => {
        process.env = { ...originalEnv };
        const mocks = setupWorkerModuleMocks();
        mocks.consumeCoalescedScanFollowUp.mockRejectedValueOnce(
            new Error("follow-up unavailable"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const completedHandler = mocks.scanQueue.on.mock.calls.find(
            (call) => call[0] === "completed",
        )?.[1];
        expect(() =>
            completedHandler(
                {
                    id: "coalesced-library-scan",
                    data: {},
                    name: "scan",
                },
                { tracksAdded: 0, tracksUpdated: 0, tracksRemoved: 0 },
            ),
        ).not.toThrow();
        await flushPromises();

        expect(mocks.logger.warn).toHaveBeenCalledWith(
            "Failed to consume coalesced scan follow-up after queue settlement",
            { error: expect.any(Error) },
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
        const settleAfterTimeoutSyncMissing = () =>
            new Promise<{
                synced: number;
                failed: number;
                skipped: number;
                errors: string[];
            }>((_resolve, reject) =>
                queueMicrotask(() =>
                    reject(new Error("settled after timeout")),
                ),
            );
        const settleAfterTimeoutReconcile = () =>
            new Promise<{ loaded: number; failed: number }>(
                (_resolve, reject) =>
                    queueMicrotask(() =>
                        reject(new Error("settled after timeout")),
                    ),
            );
        const settleAfterTimeoutArtistCounts = () =>
            new Promise<{ processed: number; errors: number }>(
                (_resolve, reject) =>
                    queueMicrotask(() =>
                        reject(new Error("settled after timeout")),
                    ),
            );
        const settleAfterTimeoutImages = () =>
            new Promise<undefined>((_resolve, reject) =>
                queueMicrotask(() =>
                    reject(new Error("settled after timeout")),
                ),
            );
        const setTimeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((cb: (...args: any[]) => void) => {
                queueMicrotask(cb);
                return 0 as unknown as NodeJS.Timeout;
            }) as any);

        (mocks.getSystemSettings as jest.Mock).mockResolvedValue({
            audiobookshelfEnabled: true,
            audiobookshelfUrl: "http://audiobookshelf",
        });
        mocks.audiobookCacheService.syncMissing.mockImplementationOnce(
            settleAfterTimeoutSyncMissing,
        );
        mocks.downloadQueueManager.reconcileOnStartup.mockImplementationOnce(
            settleAfterTimeoutReconcile,
        );
        mocks.isBackfillNeeded.mockResolvedValueOnce(true);
        mocks.backfillAllArtistCounts.mockImplementationOnce(
            settleAfterTimeoutArtistCounts,
        );
        mocks.isImageBackfillNeeded.mockResolvedValueOnce({
            needed: true,
            artistsWithExternalUrls: 1,
            albumsWithExternalUrls: 1,
        });
        mocks.backfillAllImages.mockImplementationOnce(
            settleAfterTimeoutImages,
        );

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

        expect(setTimeoutSpy).toHaveBeenCalledWith(
            expect.any(Function),
            2 * 60 * 60 * 1000 - 10 * 60_000,
        );
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

        for (let i = 0; i < 35; i += 1) {
            await schedulerHandler({
                id: `skip-${i}`,
                name: "data-integrity-check",
                data: { mode: "repeat" },
            });
        }

        const skipWarnings = mocks.logger.warn.mock.calls.filter(
            ([message]) =>
                typeof message === "string" &&
                message.includes("data integrity check skipped"),
        );
        expect(skipWarnings).toHaveLength(2);
        expect(skipWarnings[0][0]).toEqual(
            expect.stringContaining("skipped 3 consecutive time(s)"),
        );
        expect(skipWarnings[1][0]).toEqual(
            expect.stringContaining("skipped 30 consecutive time(s)"),
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
        let rejectWork!: (error: Error) => void;
        mocks.simpleDownloadManager.clearLidarrQueue.mockImplementation(
            () =>
                new Promise((_resolve, reject) => {
                    rejectWork = reject;
                }),
        );
        let timeoutCallback!: () => void;
        const setTimeoutSpy = jest
            .spyOn(global, "setTimeout")
            .mockImplementation(((cb: (...args: any[]) => void) => {
                timeoutCallback = cb;
                return 0 as unknown as NodeJS.Timeout;
            }) as any);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require("../index");
        await flushPromises();

        const schedulerHandler = mocks.schedulerQueue.process.mock.calls.find(
            (call) => call[0] === "*",
        )?.[1];

        const handled = schedulerHandler({
            id: "cleanup-timeout",
            name: "lidarr-cleanup-cycle",
            data: { mode: "startup" },
        });
        await flushPromises();
        timeoutCallback();
        rejectWork(new Error("cancelled work settled"));
        await handled;
        setTimeoutSpy.mockRestore();

        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining("Operation timed out after 180000ms"),
        );
        expect(mocks.recordSchedulerTimeout).toHaveBeenCalledWith(
            "clearLidarrQueue",
        );
        expect(mocks.recordSchedulerJobSuccess).not.toHaveBeenCalled();
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
