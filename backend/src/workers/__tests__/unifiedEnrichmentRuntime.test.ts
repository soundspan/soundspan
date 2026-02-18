describe("unified enrichment runtime behavior", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.resetModules();
        jest.clearAllMocks();
    });

    function setupUnifiedEnrichmentMocks() {
        const trackCountMock = jest.fn(async (args?: { where?: any }) => {
            const where = args?.where;
            if (!where) return 10;
            if (where.AND) return 6;
            if (where.analysisStatus === "completed") return 4;
            if (where.analysisStatus === "pending") return 3;
            if (where.analysisStatus === "processing") return 2;
            if (where.analysisStatus === "failed") return 1;
            if (where.vibeAnalysisStatus === "processing") return 1;
            return 0;
        });

        const prisma = {
            $connect: jest.fn(async () => undefined),
            $disconnect: jest.fn(async () => undefined),
            $executeRaw: jest.fn(async () => undefined),
            $queryRaw: jest.fn(async () => [{ count: BigInt(2) }]),
            $transaction: jest.fn(async (queries: Array<Promise<unknown>>) => {
                return Promise.all(queries);
            }),
            artist: {
                groupBy: jest.fn(async () => [
                    { enrichmentStatus: "completed", _count: 3 },
                    { enrichmentStatus: "pending", _count: 1 },
                ]),
                updateMany: jest.fn(async () => ({ count: 3 })),
                findMany: jest.fn(async () => []),
            },
            track: {
                count: trackCountMock,
                updateMany: jest.fn(async () => ({ count: 8 })),
                findMany: jest.fn(async () => []),
                update: jest.fn(async () => undefined),
            },
            enrichmentFailure: {
                count: jest.fn(async () => 1),
            },
            podcast: {
                count: jest.fn(async () => 0),
                findMany: jest.fn(async () => []),
            },
            user: {
                findMany: jest.fn(async () => []),
            },
        };

        const queueRedisPrimary = {
            llen: jest.fn(async () => 0),
            rpush: jest.fn(async () => 1),
            keys: jest.fn(async () => []),
            del: jest.fn(async () => 0),
            disconnect: jest.fn(),
        };
        const queueRedisRecovery = {
            llen: jest.fn(async () => 0),
            rpush: jest.fn(async () => 1),
            keys: jest.fn(async () => []),
            del: jest.fn(async () => 0),
            disconnect: jest.fn(),
        };
        const claimRedisPrimary = {
            set: jest.fn(async () => null),
            eval: jest.fn(async () => 1),
            disconnect: jest.fn(),
        };
        const claimRedisRecovery = {
            set: jest.fn(async () => null),
            eval: jest.fn(async () => 1),
            disconnect: jest.fn(),
        };
        const controlSubscriber = {
            subscribe: jest.fn(async () => undefined),
            on: jest.fn(),
            disconnect: jest.fn(),
        };

        let queueClientCreationCount = 0;
        let claimClientCreationCount = 0;
        const createIORedisClient = jest.fn((clientName: string) => {
            if (clientName === "enrichment-queue") {
                const client =
                    queueClientCreationCount === 0
                        ? queueRedisPrimary
                        : queueRedisRecovery;
                queueClientCreationCount += 1;
                return client;
            }

            if (clientName === "enrichment-cycle-claims") {
                const client =
                    claimClientCreationCount === 0
                        ? claimRedisPrimary
                        : claimRedisRecovery;
                claimClientCreationCount += 1;
                return client;
            }

            if (clientName === "enrichment-control-sub") {
                return controlSubscriber;
            }

            return queueRedisPrimary;
        });

        const enrichmentStateService = {
            getState: jest.fn(async () => ({ status: "idle" })),
            clear: jest.fn(async () => undefined),
            initializeState: jest.fn(async () => undefined),
            updateState: jest.fn(async () => undefined),
        };
        const enrichmentFailureService = {
            clearAllFailures: jest.fn(async () => undefined),
            recordFailure: jest.fn(async () => undefined),
        };
        const audioAnalysisCleanupService = {
            cleanupStaleProcessing: jest.fn(async () => ({
                reset: 0,
                permanentlyFailed: 0,
                recovered: 0,
            })),
            recordSuccess: jest.fn(),
            isCircuitOpen: jest.fn(() => false),
        };
        const vibeAnalysisCleanupService = {
            cleanupStaleProcessing: jest.fn(async () => ({ reset: 0 })),
        };
        const lastFmService = {
            getTrackInfo: jest.fn(async () => null),
        };
        const enrichSimilarArtist = jest.fn(async () => undefined);
        const refreshPodcastFeed = jest.fn(async () => ({ newEpisodesCount: 0 }));
        const logger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        const moodBucketService = {
            backfillAllTracks: jest.fn(async () => ({
                processed: 0,
                assigned: 0,
            })),
        };
        const notificationService = {
            create: jest.fn(async () => undefined),
            notifySystem: jest.fn(async () => undefined),
        };

        jest.doMock("../../utils/db", () => ({
            prisma,
            Prisma: {
                PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
                    code = "P1001";
                },
                PrismaClientRustPanicError: class PrismaClientRustPanicError extends Error {},
                PrismaClientUnknownRequestError: class PrismaClientUnknownRequestError extends Error {},
            },
        }));
        jest.doMock("../../utils/logger", () => ({ logger }));
        jest.doMock("../artistEnrichment", () => ({
            enrichSimilarArtist,
        }));
        jest.doMock("../../services/lastfm", () => ({ lastFmService }));
        jest.doMock("../../utils/ioredis", () => ({ createIORedisClient }));
        jest.doMock("../../config", () => ({ config: {} }));
        jest.doMock("../../services/enrichmentState", () => ({
            enrichmentStateService,
        }));
        jest.doMock("../../services/enrichmentFailureService", () => ({
            enrichmentFailureService,
        }));
        jest.doMock("../../services/audioAnalysisCleanup", () => ({
            audioAnalysisCleanupService,
        }));
        jest.doMock("../../services/rateLimiter", () => ({
            rateLimiter: {},
        }));
        jest.doMock("../../services/vibeAnalysisCleanup", () => ({
            vibeAnalysisCleanupService,
        }));
        jest.doMock("../../utils/systemSettings", () => ({
            getSystemSettings: jest.fn(async () => ({})),
        }));
        const getFeatures = jest.fn(async () => ({ vibeEmbeddings: true }));
        jest.doMock("../../services/featureDetection", () => ({
            featureDetection: {
                getFeatures,
            },
        }));
        jest.doMock("../../services/moodBucketService", () => ({
            moodBucketService,
        }));
        jest.doMock("../../services/notificationService", () => ({
            notificationService,
        }));
        jest.doMock("../../routes/podcasts", () => ({
            refreshPodcastFeed,
        }));
        jest.doMock("p-limit", () =>
            jest.fn(() => (fn: () => Promise<unknown>) => fn())
        );
        jest.doMock("ioredis", () => jest.fn());

        return {
            prisma,
            createIORedisClient,
            queueRedisPrimary,
            queueRedisRecovery,
            claimRedisPrimary,
            claimRedisRecovery,
            controlSubscriber,
            enrichmentStateService,
            enrichmentFailureService,
            getFeatures,
            audioAnalysisCleanupService,
            vibeAnalysisCleanupService,
            lastFmService,
            moodBucketService,
            notificationService,
            enrichSimilarArtist,
            refreshPodcastFeed,
            logger,
        };
    }

    it("reports progress and supports targeted reset helpers", async () => {
        const { prisma } = setupUnifiedEnrichmentMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");

        const progress = await enrichment.getEnrichmentProgress();
        expect(progress.artists.total).toBe(4);
        expect(progress.trackTags.total).toBe(10);
        expect(progress.audioAnalysis.completed).toBe(4);
        expect(progress.clapEmbeddings.completed).toBe(2);
        expect(progress.coreComplete).toBe(false);

        await expect(enrichment.resetArtistsOnly()).resolves.toEqual({
            count: 3,
        });
        await expect(enrichment.resetMoodTagsOnly()).resolves.toEqual({
            count: 8,
        });
        expect(prisma.artist.updateMany).toHaveBeenCalled();
        expect(prisma.track.updateMany).toHaveBeenCalled();
    });

    it("disconnects enrichment redis clients during stop", async () => {
        const { queueRedisPrimary } = setupUnifiedEnrichmentMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");

        await enrichment.getEnrichmentProgress();
        await enrichment.stopUnifiedEnrichmentWorker();

        expect(queueRedisPrimary.disconnect).toHaveBeenCalledTimes(1);
    });

    it("recreates queue redis client for progress reads when the queue connection closes", async () => {
        const { queueRedisPrimary, queueRedisRecovery } =
            setupUnifiedEnrichmentMocks();
        (queueRedisPrimary.llen as jest.Mock).mockRejectedValueOnce(
            new Error("Connection is closed")
        );
        (queueRedisRecovery.llen as jest.Mock).mockResolvedValueOnce(0);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");

        const progress = await enrichment.getEnrichmentProgress();
        expect(queueRedisPrimary.disconnect).toHaveBeenCalledTimes(1);
        expect(queueRedisRecovery.llen).toHaveBeenCalledWith("audio:clap:queue");
        expect(progress.audioAnalysis.completed).toBe(4);
    });

    it("supports force full-enrichment flags while safely no-oping when claim is held", async () => {
        const { prisma, claimRedisPrimary, enrichmentStateService, enrichmentFailureService } =
            setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const result = await enrichment.runFullEnrichment({
            forceVibeRebuild: true,
            forceMoodBucketBackfill: true,
        });

        expect(enrichmentStateService.initializeState).toHaveBeenCalledTimes(1);
        expect(enrichmentStateService.updateState).toHaveBeenCalledWith(
            expect.objectContaining({
                pendingMoodBucketBackfill: true,
                moodBucketBackfillInProgress: false,
            })
        );
        expect(prisma.artist.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: { enrichmentStatus: "pending" },
            })
        );
        expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
        expect(enrichmentFailureService.clearAllFailures).toHaveBeenCalledWith(
            "vibe"
        );
        expect(result).toEqual({ artists: 0, tracks: 0, audioQueued: 0 });
    });

    it("recreates claim redis client when immediate trigger hits a closed connection", async () => {
        const { claimRedisPrimary, claimRedisRecovery } =
            setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockRejectedValueOnce(
            new Error("Connection is closed")
        );
        (claimRedisRecovery.set as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const result = await enrichment.triggerEnrichmentNow();

        expect(claimRedisPrimary.disconnect).toHaveBeenCalledTimes(1);
        expect(claimRedisRecovery.set).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ artists: 0, tracks: 0, audioQueued: 0 });
    });

    it("starts worker by clearing stale non-idle state and subscribing control channel", async () => {
        jest.useFakeTimers();
        const { enrichmentStateService, controlSubscriber, claimRedisPrimary } =
            setupUnifiedEnrichmentMocks() as any;
        (enrichmentStateService.getState as jest.Mock).mockResolvedValueOnce({
            status: "running",
        });
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.startUnifiedEnrichmentWorker();

        expect(enrichmentStateService.clear).toHaveBeenCalledTimes(1);
        expect(enrichmentStateService.initializeState).toHaveBeenCalled();
        expect(controlSubscriber.subscribe).toHaveBeenCalledWith(
            "enrichment:control"
        );

        await enrichment.stopUnifiedEnrichmentWorker();
    });

    it("handles state update failures during stop without crashing teardown", async () => {
        const { enrichmentStateService } = setupUnifiedEnrichmentMocks();
        (enrichmentStateService.updateState as jest.Mock).mockRejectedValueOnce(
            new Error("state write failed")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await expect(enrichment.stopUnifiedEnrichmentWorker()).resolves.toBeUndefined();
    });

    it("retries enrichment progress DB reads on transient prisma errors", async () => {
        const { prisma } = setupUnifiedEnrichmentMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("../../utils/db");
        const retryable = new Prisma.PrismaClientKnownRequestError(
            "temporary db issue"
        );
        (prisma.$transaction as jest.Mock)
            .mockRejectedValueOnce(retryable)
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "completed", _count: 3 }],
                10,
                6,
                4,
                3,
                2,
                1,
                [{ count: BigInt(2) }],
                1,
                1,
            ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const progress = await enrichment.getEnrichmentProgress();

        expect(progress.artists.completed).toBe(3);
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
        expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it("disconnects and retries on too-many-connections prisma progress errors", async () => {
        const { prisma } = setupUnifiedEnrichmentMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("../../utils/db");
        const retryable = new Prisma.PrismaClientKnownRequestError(
            "too many clients"
        ) as any;
        retryable.code = "P2037";
        (prisma.$transaction as jest.Mock)
            .mockRejectedValueOnce(retryable)
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "completed", _count: 3 }],
                10,
                6,
                4,
                3,
                2,
                1,
                [{ count: BigInt(2) }],
                1,
                1,
            ]);
        (prisma.$disconnect as jest.Mock).mockResolvedValueOnce(undefined);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const progress = await enrichment.getEnrichmentProgress();

        expect(progress.artists.completed).toBe(3);
        expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
    });

    it("re-runs audio analysis by cleaning stale jobs and queueing pending tracks", async () => {
        const { prisma, queueRedisPrimary } = setupUnifiedEnrichmentMocks();
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([{ id: "track-a" }, { id: "track-b" }]) // pre-check
            .mockResolvedValueOnce([
                { id: "track-a", filePath: "/music/a.flac", title: "A", duration: 120 },
                { id: "track-b", filePath: "/music/b.flac", title: "B", duration: 140 },
            ]); // queueAudioAnalysis

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const queued = await enrichment.reRunAudioAnalysisOnly();

        expect(queueRedisPrimary.rpush).toHaveBeenCalledTimes(2);
        expect(prisma.track.update).toHaveBeenCalledTimes(2);
        expect(queued).toBe(2);
    });

    it("re-runs vibe embeddings when available and queues missing embeddings", async () => {
        const { prisma, queueRedisPrimary, getFeatures } =
            setupUnifiedEnrichmentMocks();
        getFeatures.mockResolvedValueOnce({ vibeEmbeddings: true });
        (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
            { id: "track-v1", filePath: "/music/v1.flac", vibeAnalysisStatus: null },
            { id: "track-v2", filePath: "/music/v2.flac", vibeAnalysisStatus: "pending" },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const queued = await enrichment.reRunVibeEmbeddingsOnly();

        expect(prisma.track.update).toHaveBeenCalledTimes(2);
        expect(queueRedisPrimary.rpush).toHaveBeenCalledWith(
            "audio:clap:queue",
            expect.any(String)
        );
        expect(queued).toBe(2);
    });

    it("skips vibe embedding rerun when feature detection reports unavailable", async () => {
        const { prisma, queueRedisPrimary, getFeatures } =
            setupUnifiedEnrichmentMocks();
        getFeatures.mockResolvedValueOnce({ vibeEmbeddings: false });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const queued = await enrichment.reRunVibeEmbeddingsOnly();

        expect(prisma.$queryRaw).not.toHaveBeenCalled();
        expect(queueRedisPrimary.rpush).not.toHaveBeenCalled();
        expect(queued).toBe(0);
    });

    it("re-runs artists-only flow by resetting artists and invoking a claimed cycle", async () => {
        const { prisma, claimRedisPrimary } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const result = await enrichment.reRunArtistsOnly();

        expect(prisma.artist.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { enrichmentStatus: "completed" },
                data: { enrichmentStatus: "pending", lastEnriched: null },
            })
        );
        expect(claimRedisPrimary.set).toHaveBeenCalledTimes(1);
        expect(claimRedisPrimary.eval).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ count: 3 });
    });

    it("re-runs mood-tags-only flow by resetting tags and invoking a claimed cycle", async () => {
        const { prisma, claimRedisPrimary } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const result = await enrichment.reRunMoodTagsOnly();

        expect(prisma.track.updateMany).toHaveBeenCalledWith({
            data: { lastfmTags: [] },
        });
        expect(claimRedisPrimary.set).toHaveBeenCalledTimes(1);
        expect(claimRedisPrimary.eval).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ count: 8 });
    });

    it("runs a claimed full enrichment cycle without crashing when no pending artist/track rows exist", async () => {
        const {
            claimRedisPrimary,
            audioAnalysisCleanupService,
            vibeAnalysisCleanupService,
            prisma,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const result = await enrichment.runFullEnrichment();

        expect(audioAnalysisCleanupService.cleanupStaleProcessing).toHaveBeenCalled();
        expect(vibeAnalysisCleanupService.cleanupStaleProcessing).not.toHaveBeenCalled();
        expect(claimRedisPrimary.eval).toHaveBeenCalledTimes(1);
        expect(result).toEqual({ artists: 0, tracks: 0, audioQueued: 0 });
    });

    it("requeues audio tracks through redis retry path during claimed full enrichment", async () => {
        const { claimRedisPrimary, queueRedisPrimary, queueRedisRecovery, prisma } =
            setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        (queueRedisPrimary.rpush as jest.Mock).mockRejectedValueOnce(
            new Error("Connection is closed")
        );
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query?: any) => {
            if (query?.where?.analysisStatus === "pending" && query?.select?.filePath) {
                return [
                    {
                        id: "track-enrich-1",
                        filePath: "/music/t1.flac",
                        title: "Track One",
                        duration: 180,
                    },
                ];
            }
            return [];
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const result = await enrichment.runFullEnrichment();

        expect(queueRedisPrimary.disconnect).toHaveBeenCalledTimes(1);
        expect(queueRedisPrimary.rpush).toHaveBeenCalledTimes(2);
        expect(prisma.track.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "track-enrich-1" },
                data: expect.objectContaining({
                    analysisStatus: "processing",
                }),
            })
        );
        expect(result.audioQueued).toBeGreaterThanOrEqual(1);
    });

    it("marks completion notification as sent without notifying when no new work existed", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            enrichmentStateService,
            queueRedisPrimary,
            notificationService,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.track.count as jest.Mock).mockResolvedValue(0);
        (prisma.$transaction as jest.Mock).mockResolvedValue([
            [{ enrichmentStatus: "completed", _count: 0 }],
            0,
            0,
            0,
            0,
            0,
            0,
            [{ count: BigInt(0) }],
            0,
            0,
        ]);
        (queueRedisPrimary.keys as jest.Mock)
            .mockResolvedValueOnce(["mixes:core"])
            .mockResolvedValueOnce(["mixes:full"]);
        (queueRedisPrimary.del as jest.Mock).mockResolvedValue(1);
        (enrichmentStateService.getState as jest.Mock)
            .mockResolvedValueOnce({ status: "idle" })
            .mockResolvedValueOnce({ coreCacheCleared: false })
            .mockResolvedValueOnce({
                pendingMoodBucketBackfill: false,
                moodBucketBackfillInProgress: false,
            })
            .mockResolvedValueOnce({ fullCacheCleared: false })
            .mockResolvedValueOnce({ completionNotificationSent: false });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const result = await enrichment.runFullEnrichment();

        expect(result).toEqual({ artists: 0, tracks: 0, audioQueued: 0 });
        expect(queueRedisPrimary.keys).toHaveBeenCalledTimes(2);
        expect(queueRedisPrimary.del).toHaveBeenCalledTimes(2);
        expect(enrichmentStateService.updateState).toHaveBeenCalledWith(
            expect.objectContaining({ completionNotificationSent: true })
        );
        expect(notificationService.notifySystem).not.toHaveBeenCalled();
        expect(notificationService.create).not.toHaveBeenCalled();
    });

    it("runs pending mood-bucket backfill and sends completion notifications when work was outstanding", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            enrichmentStateService,
            queueRedisPrimary,
            moodBucketService,
            notificationService,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.track.count as jest.Mock).mockResolvedValue(0);
        (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: "user-1" }]);
        (prisma.$transaction as jest.Mock)
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "pending", _count: 1 }],
                1,
                0,
                0,
                1,
                0,
                0,
                [{ count: BigInt(0) }],
                0,
                0,
            ])
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "completed", _count: 1 }],
                1,
                1,
                1,
                0,
                0,
                0,
                [{ count: BigInt(1) }],
                0,
                0,
            ]);
        (queueRedisPrimary.keys as jest.Mock)
            .mockResolvedValueOnce(["mixes:core"])
            .mockResolvedValueOnce(["mixes:full"]);
        (queueRedisPrimary.del as jest.Mock).mockResolvedValue(1);
        (moodBucketService.backfillAllTracks as jest.Mock).mockResolvedValue({
            processed: 3,
            assigned: 3,
        });
        (enrichmentStateService.getState as jest.Mock)
            .mockResolvedValueOnce({ status: "idle" })
            .mockResolvedValueOnce({ coreCacheCleared: false })
            .mockResolvedValueOnce({
                pendingMoodBucketBackfill: true,
                moodBucketBackfillInProgress: false,
            })
            .mockResolvedValueOnce({ fullCacheCleared: false })
            .mockResolvedValueOnce({ completionNotificationSent: false });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const result = await enrichment.runFullEnrichment({
            forceMoodBucketBackfill: true,
        });

        expect(result).toEqual({ artists: 0, tracks: 0, audioQueued: 0 });
        expect(moodBucketService.backfillAllTracks).toHaveBeenCalledTimes(1);
        expect(notificationService.notifySystem).toHaveBeenCalledWith(
            "user-1",
            "Enrichment Complete",
            expect.stringContaining("Enriched")
        );
        expect(enrichmentStateService.updateState).toHaveBeenCalledWith(
            expect.objectContaining({
                pendingMoodBucketBackfill: false,
                moodBucketBackfillInProgress: false,
            })
        );
    });

    it("processes pending artist and track-tag phases with successful enrichment writes", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            lastFmService,
            enrichSimilarArtist,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "artist-1",
                name: "Artist One",
                mbid: "artist-mbid-1",
            },
        ]);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query?: any) => {
            if (query?.include?.album) {
                return [
                    {
                        id: "track-1",
                        title: "Track One",
                        albumId: "album-1",
                        filePath: "/music/track-1.flac",
                        album: { artist: { name: "Artist One" } },
                    },
                ];
            }
            if (query?.where?.analysisStatus === "pending" && query?.select?.filePath) {
                return [];
            }
            return [];
        });
        (lastFmService.getTrackInfo as jest.Mock).mockResolvedValueOnce({
            toptags: { tag: [{ name: "Chill" }, { name: "Alt Rock" }] },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const result = await enrichment.runFullEnrichment();

        expect(result.artists).toBe(1);
        expect(result.tracks).toBe(1);
        expect(enrichSimilarArtist).toHaveBeenCalledWith(
            expect.objectContaining({ id: "artist-1" })
        );
        expect(prisma.track.update).toHaveBeenCalledWith({
            where: { id: "track-1" },
            data: {
                lastfmTags: expect.arrayContaining(["chill"]),
            },
        });
    });

    it("records artist enrichment failures and continues the cycle", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            enrichSimilarArtist,
            enrichmentFailureService,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "artist-fail-1",
                name: "Artist Fail",
                mbid: "mbid-fail",
            },
        ]);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query?: any) => {
            if (query?.include?.album) return [];
            if (query?.where?.analysisStatus === "pending" && query?.select?.filePath) {
                return [];
            }
            return [];
        });
        (enrichSimilarArtist as jest.Mock).mockRejectedValueOnce(
            new Error("Timeout enriching artist: Artist Fail")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const result = await enrichment.runFullEnrichment();

        expect(result.artists).toBe(0);
        expect(enrichmentFailureService.recordFailure).toHaveBeenCalledWith(
            expect.objectContaining({
                entityType: "artist",
                entityId: "artist-fail-1",
                errorCode: "TIMEOUT_ERROR",
            })
        );
    });

    it("records track-tag enrichment failures when Last.fm lookups fail", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            lastFmService,
            enrichmentFailureService,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query?: any) => {
            if (query?.include?.album) {
                return [
                    {
                        id: "track-fail-1",
                        title: "Track Fail",
                        albumId: "album-fail-1",
                        filePath: "/music/fail.flac",
                        album: { artist: { name: "Artist Fail" } },
                    },
                ];
            }
            if (query?.where?.analysisStatus === "pending" && query?.select?.filePath) {
                return [];
            }
            return [];
        });
        (lastFmService.getTrackInfo as jest.Mock).mockRejectedValueOnce(
            new Error("Timeout fetching track tags")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const result = await enrichment.runFullEnrichment();

        expect(result.tracks).toBe(0);
        expect(enrichmentFailureService.recordFailure).toHaveBeenCalledWith(
            expect.objectContaining({
                entityType: "track",
                entityId: "track-fail-1",
                errorCode: "TIMEOUT_ERROR",
            })
        );
    });

    it("times out stalled Last.fm track lookups and records timeout failures", async () => {
        jest.useFakeTimers();
        const {
            prisma,
            lastFmService,
            enrichmentFailureService,
        } = setupUnifiedEnrichmentMocks();
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query?: any) => {
            if (query?.include?.album) {
                return [
                    {
                        id: "track-timeout-1",
                        title: "Track Timeout",
                        albumId: "album-timeout-1",
                        filePath: "/music/timeout.flac",
                        album: { artist: { name: "Artist Timeout" } },
                    },
                ];
            }
            return [];
        });
        (lastFmService.getTrackInfo as jest.Mock).mockImplementation(
            () => new Promise(() => undefined)
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const runPromise = enrichment.__unifiedEnrichmentTestables.enrichTrackTagsBatch();

        await jest.advanceTimersByTimeAsync(30_001);
        await expect(runPromise).resolves.toBe(0);
        expect(enrichmentFailureService.recordFailure).toHaveBeenCalledWith(
            expect.objectContaining({
                entityType: "track",
                entityId: "track-timeout-1",
                errorCode: "TIMEOUT_ERROR",
            })
        );
    });

    it("keeps processing audio queue when one track fails to enqueue", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            queueRedisPrimary,
            logger,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query?: any) => {
            if (query?.include?.album) return [];
            if (query?.where?.analysisStatus === "pending" && query?.select?.filePath) {
                return [
                    {
                        id: "audio-1",
                        filePath: "/music/audio-1.flac",
                        title: "Audio 1",
                        duration: 120,
                    },
                    {
                        id: "audio-2",
                        filePath: "/music/audio-2.flac",
                        title: "Audio 2",
                        duration: 130,
                    },
                ];
            }
            return [];
        });
        (queueRedisPrimary.rpush as jest.Mock)
            .mockRejectedValueOnce(new Error("push failed"))
            .mockResolvedValueOnce(1);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const result = await enrichment.runFullEnrichment();

        expect(queueRedisPrimary.rpush).toHaveBeenCalledTimes(2);
        expect(result.audioQueued).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(
            "   Failed to queue Audio 1:",
            expect.any(Error)
        );
    });

    it("refreshes stale podcast feeds during the podcast phase", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            refreshPodcastFeed,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query?: any) => {
            if (query?.include?.album) return [];
            if (query?.where?.analysisStatus === "pending" && query?.select?.filePath) {
                return [];
            }
            return [];
        });
        (prisma.podcast.count as jest.Mock).mockResolvedValueOnce(1);
        (prisma.podcast.findMany as jest.Mock).mockResolvedValueOnce([
            { id: "podcast-1", title: "Podcast One" },
        ]);
        (refreshPodcastFeed as jest.Mock).mockResolvedValueOnce({
            newEpisodesCount: 2,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(refreshPodcastFeed).toHaveBeenCalledWith("podcast-1");
    });

    it("handles non-retryable claim redis errors by skipping the cycle", async () => {
        const { claimRedisPrimary, logger } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockRejectedValueOnce(
            new Error("permission denied")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const result = await enrichment.triggerEnrichmentNow();

        expect(result).toEqual({ artists: 0, tracks: 0, audioQueued: 0 });
        expect(claimRedisPrimary.disconnect).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining(
                "[Enrichment] Failed to claim immediate enrichment cycle; skipping cycle"
            ),
            expect.any(Error)
        );
    });

    it("reacts to enrichment control channel pause/resume/stop messages", async () => {
        const { controlSubscriber, claimRedisPrimary, logger } =
            setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.startUnifiedEnrichmentWorker();

        const messageHandler = (controlSubscriber.on as jest.Mock).mock.calls.find(
            (call: any[]) => call[0] === "message"
        )?.[1];
        expect(messageHandler).toBeTruthy();

        messageHandler("enrichment:control", "pause");
        messageHandler("enrichment:control", "resume");
        messageHandler("enrichment:control", "stop");

        expect(logger.debug).toHaveBeenCalledWith("[Enrichment] Paused");
        expect(logger.debug).toHaveBeenCalledWith("[Enrichment] Resumed");
        expect(logger.debug).toHaveBeenCalledWith(
            "[Enrichment] Stopping gracefully - completing current item..."
        );

        await enrichment.stopUnifiedEnrichmentWorker();
    });

    it("creates error completion notifications when failures occurred in the session", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            lastFmService,
            queueRedisPrimary,
            enrichmentStateService,
            notificationService,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query?: any) => {
            if (query?.include?.album) {
                return [
                    {
                        id: "track-failure-notify",
                        title: "Track Failure Notify",
                        albumId: "album-1",
                        filePath: "/music/t.flac",
                        album: { artist: { name: "Artist One" } },
                    },
                ];
            }
            if (query?.where?.analysisStatus === "pending" && query?.select?.filePath) {
                return [];
            }
            return [];
        });
        (lastFmService.getTrackInfo as jest.Mock).mockRejectedValueOnce(
            new Error("Timeout while reading Last.fm")
        );
        (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: "user-1" }]);
        (prisma.$transaction as jest.Mock)
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "pending", _count: 1 }],
                1,
                0,
                0,
                1,
                0,
                0,
                [{ count: BigInt(0) }],
                0,
                0,
            ])
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "completed", _count: 1 }],
                1,
                1,
                1,
                0,
                0,
                0,
                [{ count: BigInt(1) }],
                0,
                0,
            ]);
        (queueRedisPrimary.keys as jest.Mock)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        (enrichmentStateService.getState as jest.Mock)
            .mockResolvedValueOnce({ status: "idle" })
            .mockResolvedValueOnce({ coreCacheCleared: true })
            .mockResolvedValueOnce({
                pendingMoodBucketBackfill: false,
                moodBucketBackfillInProgress: false,
            })
            .mockResolvedValueOnce({ fullCacheCleared: true })
            .mockResolvedValueOnce({ completionNotificationSent: false });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(notificationService.create).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "user-1",
                type: "error",
                title: "Enrichment Completed with Errors",
            })
        );
        expect(notificationService.notifySystem).toHaveBeenCalledWith(
            "user-1",
            "Enrichment Complete",
            expect.any(String)
        );
    });

    it("logs completion notification send failures without crashing the cycle", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            queueRedisPrimary,
            enrichmentStateService,
            notificationService,
            logger,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query?: any) => {
            if (query?.include?.album) return [];
            if (query?.where?.analysisStatus === "pending" && query?.select?.filePath) {
                return [];
            }
            return [];
        });
        (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: "user-1" }]);
        (notificationService.notifySystem as jest.Mock).mockRejectedValueOnce(
            new Error("notify failed")
        );
        (prisma.$transaction as jest.Mock)
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "pending", _count: 1 }],
                1,
                0,
                0,
                1,
                0,
                0,
                [{ count: BigInt(0) }],
                0,
                0,
            ])
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "completed", _count: 1 }],
                1,
                1,
                1,
                0,
                0,
                0,
                [{ count: BigInt(1) }],
                0,
                0,
            ]);
        (queueRedisPrimary.keys as jest.Mock)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        (enrichmentStateService.getState as jest.Mock)
            .mockResolvedValueOnce({ status: "idle" })
            .mockResolvedValueOnce({ coreCacheCleared: true })
            .mockResolvedValueOnce({
                pendingMoodBucketBackfill: false,
                moodBucketBackfillInProgress: false,
            })
            .mockResolvedValueOnce({ fullCacheCleared: true })
            .mockResolvedValueOnce({ completionNotificationSent: false });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(logger.error).toHaveBeenCalledWith(
            "[Enrichment] Failed to send completion notification:",
            expect.any(Error)
        );
    });

    it("logs and exits when completion progress snapshot cannot be read", async () => {
        const { claimRedisPrimary, prisma, getFeatures, logger } =
            setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockImplementation(async () => []);
        (prisma.$transaction as jest.Mock)
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "pending", _count: 1 }],
                1,
                0,
                0,
                1,
                0,
                0,
                [{ count: BigInt(0) }],
                0,
                0,
            ])
            .mockRejectedValueOnce(new Error("progress read failed"));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(logger.warn).toHaveBeenCalledWith(
            "[Enrichment] Failed to read completion progress snapshot; skipping completion-specific post-processing for this cycle:",
            expect.any(Error)
        );
    });

    it("skips duplicate completion notifications when already marked sent", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            queueRedisPrimary,
            enrichmentStateService,
            notificationService,
            logger,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockImplementation(async () => []);
        (prisma.$transaction as jest.Mock)
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "pending", _count: 1 }],
                1,
                0,
                0,
                1,
                0,
                0,
                [{ count: BigInt(0) }],
                0,
                0,
            ])
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "completed", _count: 1 }],
                1,
                1,
                1,
                0,
                0,
                0,
                [{ count: BigInt(1) }],
                0,
                0,
            ]);
        (queueRedisPrimary.keys as jest.Mock)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        (enrichmentStateService.getState as jest.Mock)
            .mockResolvedValueOnce({ status: "idle" })
            .mockResolvedValueOnce({ coreCacheCleared: true })
            .mockResolvedValueOnce({
                pendingMoodBucketBackfill: false,
                moodBucketBackfillInProgress: false,
            })
            .mockResolvedValueOnce({ fullCacheCleared: true })
            .mockResolvedValueOnce({ completionNotificationSent: true });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(notificationService.notifySystem).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(
            "[Enrichment] Completion notification already sent, skipping"
        );
    });

    it("records system failures on repeated cycle errors", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            enrichmentStateService,
            enrichmentFailureService,
            logger,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValue("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([]);
        (enrichmentStateService.updateState as jest.Mock).mockImplementation(
            async (payload: any) => {
                if (payload?.status === "running") {
                    throw new Error("state update failed");
                }
                return undefined;
            }
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");

        for (let i = 0; i < 6; i += 1) {
            await enrichment.runFullEnrichment();
        }

        expect(enrichmentFailureService.recordFailure).toHaveBeenCalledTimes(5);
        expect(logger.error).toHaveBeenCalledWith(
            "[Enrichment] Cycle error:",
            expect.any(Error)
        );
    });

    it("returns early when enrichment state indicates paused", async () => {
        const { claimRedisPrimary, enrichmentStateService } =
            setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        (enrichmentStateService.getState as jest.Mock).mockResolvedValueOnce({
            status: "paused",
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const result = await enrichment.triggerEnrichmentNow();

        expect(result).toEqual({ artists: 0, tracks: 0, audioQueued: 0 });
    });

    it("executes the interval callback cycle after startup", async () => {
        jest.useFakeTimers();
        const { claimRedisPrimary } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValue(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.startUnifiedEnrichmentWorker();

        await jest.advanceTimersByTimeAsync(5_000);
        expect((claimRedisPrimary.set as jest.Mock).mock.calls.length).toBeGreaterThan(1);

        await enrichment.stopUnifiedEnrichmentWorker();
    });

    it("warns when post-batch progress read/update fails after work was processed", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            enrichSimilarArtist,
            logger,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([
            { id: "artist-2", name: "Artist Two", mbid: "mbid-2" },
        ]);
        (prisma.track.findMany as jest.Mock).mockImplementation(async () => []);
        (prisma.$transaction as jest.Mock)
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "pending", _count: 1 }],
                1,
                0,
                0,
                1,
                0,
                0,
                [{ count: BigInt(0) }],
                0,
                0,
            ])
            .mockRejectedValueOnce(new Error("post-batch progress failed"))
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "pending", _count: 1 }],
                1,
                0,
                0,
                1,
                0,
                0,
                [{ count: BigInt(0) }],
                0,
                0,
            ]);
        (enrichSimilarArtist as jest.Mock).mockResolvedValueOnce(undefined);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(logger.warn).toHaveBeenCalledWith(
            "[Enrichment] Failed to read/update enrichment progress after processing batch; continuing cycle:",
            expect.any(Error)
        );
    });

    it("logs core cache clear failures without aborting the cycle", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            queueRedisPrimary,
            enrichmentStateService,
            logger,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockImplementation(async () => []);
        (prisma.$transaction as jest.Mock)
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "pending", _count: 1 }],
                1,
                0,
                0,
                1,
                0,
                0,
                [{ count: BigInt(0) }],
                0,
                0,
            ])
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "completed", _count: 1 }],
                1,
                1,
                1,
                0,
                0,
                0,
                [{ count: BigInt(1) }],
                0,
                0,
            ]);
        (queueRedisPrimary.keys as jest.Mock).mockRejectedValueOnce(
            new Error("keys failed")
        );
        (enrichmentStateService.getState as jest.Mock)
            .mockResolvedValueOnce({ status: "idle" })
            .mockResolvedValueOnce({ coreCacheCleared: false })
            .mockResolvedValueOnce({
                pendingMoodBucketBackfill: false,
                moodBucketBackfillInProgress: false,
            });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(logger.error).toHaveBeenCalledWith(
            "[Enrichment] Failed to clear mix cache on core complete:",
            expect.any(Error)
        );
    });

    it("retries progress reads on unknown prisma engine-empty errors", async () => {
        const { prisma } = setupUnifiedEnrichmentMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("../../utils/db");
        (prisma.$transaction as jest.Mock)
            .mockRejectedValueOnce(
                new Prisma.PrismaClientUnknownRequestError(
                    "Response from the Engine was empty"
                )
            )
            .mockImplementation(async (queries: Array<Promise<unknown>>) =>
                Promise.all(queries)
            );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const progress = await enrichment.getEnrichmentProgress();

        expect(progress.trackTags.total).toBe(10);
        expect(prisma.$connect).toHaveBeenCalled();
    });

    it("warns when cycle claim release fails after a successful run", async () => {
        const { claimRedisPrimary, logger } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        (claimRedisPrimary.eval as jest.Mock).mockRejectedValueOnce(
            new Error("release failed")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.triggerEnrichmentNow();

        expect(logger.warn).toHaveBeenCalledWith(
            "[Enrichment] Failed to release cycle claim for immediate enrichment cycle",
            expect.any(Error)
        );
    });

    it("logs when recording a system failure entry also fails", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            enrichmentStateService,
            enrichmentFailureService,
            logger,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(async () => []);
        (enrichmentStateService.updateState as jest.Mock).mockImplementation(
            async (payload: any) => {
                if (payload?.status === "running") {
                    throw new Error("state update failed");
                }
                return undefined;
            }
        );
        (enrichmentFailureService.recordFailure as jest.Mock).mockRejectedValueOnce(
            new Error("record failure insert failed")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(logger.error).toHaveBeenCalledWith(
            "[Enrichment] Failed to record failure:",
            expect.any(Error)
        );
    });

    it("logs podcast refresh failures and continues the cycle", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            refreshPodcastFeed,
            logger,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(async () => []);
        (prisma.podcast.count as jest.Mock).mockResolvedValueOnce(1);
        (prisma.podcast.findMany as jest.Mock).mockResolvedValueOnce([
            { id: "podcast-bad", title: "Broken Podcast" },
        ]);
        (refreshPodcastFeed as jest.Mock).mockRejectedValueOnce(
            new Error("feed timeout")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(logger.error).toHaveBeenCalledWith(
            "   [Podcast] Failed to refresh Broken Podcast:",
            expect.any(Error)
        );
    });

    it("warns and skips vibe phase when audio queue length cannot be read", async () => {
        const {
            claimRedisPrimary,
            prisma,
            queueRedisPrimary,
            logger,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(async () => []);
        (prisma.track.count as jest.Mock).mockImplementation(async (args?: { where?: any }) => {
            const where = args?.where;
            if (!where) return 1;
            if (where.AND) return 1;
            if (where.analysisStatus === "completed") return 1;
            if (where.analysisStatus === "pending") return 0;
            if (where.analysisStatus === "processing") return 0;
            if (where.analysisStatus === "failed") return 0;
            if (where.vibeAnalysisStatus === "processing") return 0;
            return 0;
        });
        (queueRedisPrimary.llen as jest.Mock).mockRejectedValue(
            new Error("queue length unavailable")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(logger.warn).toHaveBeenCalledWith(
            "[Enrichment] Unable to read audio analysis queue length; skipping vibe phase this cycle",
            expect.any(Error)
        );
    });

    it("handles mood backfill failure on full completion by resetting in-progress state", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            queueRedisPrimary,
            enrichmentStateService,
            moodBucketService,
            logger,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(async () => []);
        (prisma.$transaction as jest.Mock)
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "pending", _count: 1 }],
                1,
                0,
                0,
                1,
                0,
                0,
                [{ count: BigInt(0) }],
                0,
                0,
            ])
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "completed", _count: 1 }],
                1,
                1,
                1,
                0,
                0,
                0,
                [{ count: BigInt(1) }],
                0,
                0,
            ]);
        (moodBucketService.backfillAllTracks as jest.Mock).mockRejectedValueOnce(
            new Error("backfill failed")
        );
        (queueRedisPrimary.keys as jest.Mock)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        (enrichmentStateService.getState as jest.Mock)
            .mockResolvedValueOnce({ status: "idle" })
            .mockResolvedValueOnce({ coreCacheCleared: true })
            .mockResolvedValueOnce({
                pendingMoodBucketBackfill: true,
                moodBucketBackfillInProgress: false,
            })
            .mockResolvedValueOnce({ fullCacheCleared: true })
            .mockResolvedValueOnce({ completionNotificationSent: true });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(logger.error).toHaveBeenCalledWith(
            "[Enrichment] Automatic mood bucket backfill failed (will retry on next fully-complete cycle):",
            expect.any(Error)
        );
        expect(enrichmentStateService.updateState).toHaveBeenCalledWith({
            moodBucketBackfillInProgress: false,
        });
    });

    it("logs full-complete mix-cache clear failures without crashing", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            queueRedisPrimary,
            enrichmentStateService,
            logger,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(async () => []);
        (prisma.$transaction as jest.Mock)
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "pending", _count: 1 }],
                1,
                0,
                0,
                1,
                0,
                0,
                [{ count: BigInt(0) }],
                0,
                0,
            ])
            .mockResolvedValueOnce([
                [{ enrichmentStatus: "completed", _count: 1 }],
                1,
                1,
                1,
                0,
                0,
                0,
                [{ count: BigInt(1) }],
                0,
                0,
            ]);
        (queueRedisPrimary.keys as jest.Mock).mockRejectedValueOnce(
            new Error("mix key lookup failed")
        );
        (enrichmentStateService.getState as jest.Mock)
            .mockResolvedValueOnce({ status: "idle" })
            .mockResolvedValueOnce({ coreCacheCleared: true })
            .mockResolvedValueOnce({
                pendingMoodBucketBackfill: false,
                moodBucketBackfillInProgress: false,
            })
            .mockResolvedValueOnce({ fullCacheCleared: false })
            .mockResolvedValueOnce({ completionNotificationSent: true });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(queueRedisPrimary.keys).toHaveBeenCalledWith("mixes:*");
        expect(logger.error).toHaveBeenCalledWith(
            "[Enrichment] Failed to clear mix cache on full complete:",
            expect.any(Error)
        );
    });

    it("marks tracks as _not_found when Last.fm returns no tag payload", async () => {
        const { claimRedisPrimary, prisma, getFeatures } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query?: any) => {
            if (query?.include?.album) {
                return [
                    {
                        id: "track-not-found",
                        title: "Track Not Found",
                        album: { artist: { name: "Artist Not Found" } },
                    },
                ];
            }
            return [];
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(prisma.track.update).toHaveBeenCalledWith({
            where: { id: "track-not-found" },
            data: { lastfmTags: ["_not_found"] },
        });
    });

    it("logs audio cleanup details, records success, and short-circuits on open circuit", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            audioAnalysisCleanupService,
            logger,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(async () => []);
        let completedCount = 0;
        (prisma.track.count as jest.Mock).mockImplementation(async (args?: { where?: any }) => {
            const where = args?.where;
            if (!where) return 1;
            if (where.AND) return 1;
            if (where.analysisStatus === "completed") {
                completedCount += 1;
                return completedCount;
            }
            if (where.analysisStatus === "pending") return 0;
            if (where.analysisStatus === "processing") return 0;
            if (where.analysisStatus === "failed") return 0;
            if (where.vibeAnalysisStatus === "processing") return 0;
            return 0;
        });
        (audioAnalysisCleanupService.cleanupStaleProcessing as jest.Mock).mockResolvedValue({
            reset: 1,
            permanentlyFailed: 1,
            recovered: 0,
        });
        (audioAnalysisCleanupService.isCircuitOpen as jest.Mock).mockReturnValue(true);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const result = await enrichment.runFullEnrichment();

        expect(logger.debug).toHaveBeenCalledWith(
            "[Enrichment] Audio analysis cleanup: 1 reset, 1 permanently failed, 0 recovered"
        );
        expect(audioAnalysisCleanupService.recordSuccess).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(
            "[Enrichment] Audio analysis circuit breaker OPEN - skipping queue"
        );
        expect(result.audioQueued).toBe(0);
    });

    it("logs vibe queue enqueue failures and continues cycle progress", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            queueRedisPrimary,
            logger,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: true });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(async () => []);
        (prisma.track.count as jest.Mock).mockImplementation(async (args?: { where?: any }) => {
            const where = args?.where;
            if (!where) return 1;
            if (where.AND) return 1;
            if (where.analysisStatus === "completed") return 1;
            if (where.analysisStatus === "pending") return 0;
            if (where.analysisStatus === "processing") return 0;
            if (where.analysisStatus === "failed") return 0;
            if (where.vibeAnalysisStatus === "processing") return 0;
            return 0;
        });
        (prisma.$queryRaw as jest.Mock)
            .mockResolvedValueOnce([{ count: BigInt(0) }])
            .mockResolvedValueOnce([
                {
                    id: "track-vibe-fail",
                    filePath: "/music/track-vibe-fail.flac",
                    vibeAnalysisStatus: null,
                },
            ])
            .mockResolvedValueOnce([{ count: BigInt(0) }]);
        (prisma.track.update as jest.Mock).mockRejectedValueOnce(
            new Error("update failed")
        );
        (queueRedisPrimary.llen as jest.Mock).mockResolvedValue(0);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(logger.error).toHaveBeenCalledWith(
            "   Failed to queue vibe embedding for track-vibe-fail:",
            expect.any(Error)
        );
    });

    it("logs vibe cleanup reset counts and queued embeddings", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            vibeAnalysisCleanupService,
            queueRedisPrimary,
            logger,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: true });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(async () => []);
        (prisma.track.count as jest.Mock).mockImplementation(async (args?: { where?: any }) => {
            const where = args?.where;
            if (!where) return 1;
            if (where.AND) return 1;
            if (where.analysisStatus === "completed") return 1;
            if (where.analysisStatus === "pending") return 0;
            if (where.analysisStatus === "processing") return 0;
            if (where.analysisStatus === "failed") return 0;
            if (where.vibeAnalysisStatus === "processing") return 0;
            return 0;
        });
        (vibeAnalysisCleanupService.cleanupStaleProcessing as jest.Mock).mockResolvedValue(
            { reset: 2 }
        );
        (prisma.$queryRaw as jest.Mock)
            .mockResolvedValueOnce([{ count: BigInt(0) }])
            .mockResolvedValueOnce([
                {
                    id: "track-vibe-ok",
                    filePath: "/music/track-vibe-ok.flac",
                    vibeAnalysisStatus: null,
                },
            ])
            .mockResolvedValueOnce([{ count: BigInt(1) }]);
        (queueRedisPrimary.llen as jest.Mock).mockResolvedValue(0);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(logger.debug).toHaveBeenCalledWith(
            "[ENRICHMENT] Cleaned up 2 stale vibe processing entries"
        );
        expect(logger.debug).toHaveBeenCalledWith(
            "[ENRICHMENT] Queued 1 tracks for vibe embedding"
        );
    });

    it("retries enrichment progress reads on rust panic prisma errors", async () => {
        const { prisma } = setupUnifiedEnrichmentMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("../../utils/db");
        (prisma.$transaction as jest.Mock)
            .mockRejectedValueOnce(
                new Prisma.PrismaClientRustPanicError("panic in query engine")
            )
            .mockImplementation(async (queries: Array<Promise<unknown>>) =>
                Promise.all(queries)
            );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const progress = await enrichment.getEnrichmentProgress();

        expect(progress.trackTags.total).toBe(10);
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
    });

    it("warns and continues when cycle start progress snapshot fails", async () => {
        const { claimRedisPrimary, prisma, getFeatures, logger } =
            setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(async () => []);
        (prisma.$transaction as jest.Mock)
            .mockRejectedValueOnce(new Error("starting progress unavailable"))
            .mockImplementation(async (queries: Array<Promise<unknown>>) =>
                Promise.all(queries)
            );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(logger.warn).toHaveBeenCalledWith(
            "[Enrichment] Failed to read starting progress, defaulting to notification-safe mode:",
            expect.any(Error)
        );
    });

    it("halts a cycle after stop+resume when stopping flag is still set", async () => {
        const { controlSubscriber, claimRedisPrimary, enrichmentStateService } =
            setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock)
            .mockResolvedValueOnce(null) // startup cycle claim
            .mockResolvedValueOnce("OK"); // trigger cycle claim

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.startUnifiedEnrichmentWorker();

        const messageHandler = (controlSubscriber.on as jest.Mock).mock.calls.find(
            (call: any[]) => call[0] === "message"
        )?.[1];
        expect(messageHandler).toBeTruthy();

        messageHandler("enrichment:control", "stop");
        messageHandler("enrichment:control", "resume");
        const result = await enrichment.triggerEnrichmentNow();

        expect(result).toEqual({ artists: 0, tracks: 0, audioQueued: 0 });
        expect(enrichmentStateService.updateState).toHaveBeenCalledWith({
            status: "idle",
            currentPhase: null,
        });

        await enrichment.stopUnifiedEnrichmentWorker();
    });

    it("triggers system-failure circuit-breaker suppression after repeated cycle errors", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            enrichmentStateService,
            enrichmentFailureService,
            logger,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValue("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([]);
        (enrichmentStateService.updateState as jest.Mock).mockImplementation(
            async (payload: any) => {
                if (payload?.status === "running") {
                    throw new Error("state update failed");
                }
                return undefined;
            }
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        for (let i = 0; i < 25; i += 1) {
            await enrichment.runFullEnrichment();
        }

        expect(enrichmentFailureService.recordFailure).toHaveBeenCalledTimes(5);
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining(
                "[Enrichment] Circuit breaker triggered -"
            )
        );
    });

    it("returns zero when vibe rerun finds no missing embedding candidates", async () => {
        const { prisma, getFeatures } = setupUnifiedEnrichmentMocks();
        getFeatures.mockResolvedValueOnce({ vibeEmbeddings: true });
        (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const queued = await enrichment.reRunVibeEmbeddingsOnly();

        expect(queued).toBe(0);
    });

    it("waits for active-cycle stop and warns when max wait is exceeded", async () => {
        jest.useFakeTimers();
        const { logger } = setupUnifiedEnrichmentMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
            isRunning: true,
        });

        const waitPromise =
            enrichment.__unifiedEnrichmentTestables.waitForActiveCycleToStop(1);
        await jest.advanceTimersByTimeAsync(200);
        await waitPromise;

        expect(logger.warn).toHaveBeenCalledWith(
            "[Enrichment] Stop wait exceeded 1ms while a cycle was still running; proceeding with teardown"
        );
        enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
            isRunning: false,
        });
    });

    it("short-circuits runEnrichmentCycle when already running or inside min interval", async () => {
        setupUnifiedEnrichmentMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
            isPaused: false,
            isRunning: true,
            immediateEnrichmentRequested: false,
            isStopping: false,
            lastRunTime: 0,
        });

        await expect(
            enrichment.__unifiedEnrichmentTestables.runEnrichmentCycle(false)
        ).resolves.toEqual({
            artists: 0,
            tracks: 0,
            audioQueued: 0,
        });

        enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
            isRunning: false,
            lastRunTime: Date.now(),
            immediateEnrichmentRequested: false,
        });
        await expect(
            enrichment.__unifiedEnrichmentTestables.runEnrichmentCycle(false)
        ).resolves.toEqual({
            artists: 0,
            tracks: 0,
            audioQueued: 0,
        });
    });

    it("returns partial results when runEnrichmentCycle halts after track, audio, and vibe phases", async () => {
        const { prisma } = setupUnifiedEnrichmentMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        (prisma.artist.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (args?: any) => {
            if (args?.where?.OR) {
                enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
                    isPaused: true,
                });
                return [];
            }
            return [];
        });
        enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
            isPaused: false,
            isRunning: false,
            immediateEnrichmentRequested: false,
            isStopping: false,
            lastRunTime: 0,
        });

        await expect(
            enrichment.__unifiedEnrichmentTestables.runEnrichmentCycle(false)
        ).resolves.toEqual({
            artists: 0,
            tracks: 0,
            audioQueued: 0,
        });

        // Halt after audio executor
        (prisma.track.findMany as jest.Mock).mockImplementation(async (args?: any) => {
            if (args?.where?.analysisStatus === "pending") {
                enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
                    isPaused: true,
                });
            }
            return [];
        });
        enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
            isPaused: false,
            isRunning: false,
            immediateEnrichmentRequested: false,
            isStopping: false,
            lastRunTime: 0,
        });

        await expect(
            enrichment.__unifiedEnrichmentTestables.runEnrichmentCycle(false)
        ).resolves.toEqual({
            artists: 0,
            tracks: 0,
            audioQueued: 0,
        });

        // Halt after vibe executor
        (prisma.track.count as jest.Mock).mockImplementation(async (args?: any) => {
            if (args?.where?.analysisStatus === "processing") {
                return 0;
            }
            if (args?.where?.analysisStatus === "completed") {
                return 0;
            }
            return 0;
        });
        (prisma.track.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.$queryRaw as jest.Mock).mockImplementation(async () => {
            enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
                isPaused: true,
            });
            return [];
        });
        enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
            isPaused: false,
            isRunning: false,
            immediateEnrichmentRequested: false,
            isStopping: false,
            lastRunTime: 0,
        });

        await expect(
            enrichment.__unifiedEnrichmentTestables.runEnrichmentCycle(false)
        ).resolves.toEqual({
            artists: 0,
            tracks: 0,
            audioQueued: 0,
        });
    });

    it("guards paused artist and track batch workers before processing loop bodies", async () => {
        const { prisma } = setupUnifiedEnrichmentMocks();
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([
            { id: "artist-paused", name: "Paused Artist", mbid: "artist-paused-mbid" },
        ]);
        (prisma.track.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "track-paused",
                title: "Paused Track",
                albumId: "album-paused",
                filePath: "/music/paused.flac",
                album: {
                    artist: { name: "Paused Artist" },
                },
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
            isPaused: true,
        });

        await expect(
            enrichment.__unifiedEnrichmentTestables.enrichArtistsBatch()
        ).resolves.toBe(0);
        await expect(
            enrichment.__unifiedEnrichmentTestables.enrichTrackTagsBatch()
        ).resolves.toBe(0);
    });

    it("halts after vibe phase and exposes runtime-state getter/setter helpers", async () => {
        const { prisma, vibeAnalysisCleanupService } = setupUnifiedEnrichmentMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        (prisma.artist.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.track.count as jest.Mock).mockImplementation(async (args?: any) => {
            if (args?.where?.analysisStatus === "processing") return 0;
            if (args?.where?.analysisStatus === "completed") return 0;
            return 0;
        });
        (vibeAnalysisCleanupService.cleanupStaleProcessing as jest.Mock).mockImplementation(
            async () => {
                enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
                    isPaused: true,
                });
                return { reset: 0 };
            }
        );

        enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
            isPaused: false,
            isRunning: false,
            isStopping: false,
            immediateEnrichmentRequested: false,
            consecutiveSystemFailures: 3,
            lastRunTime: 0,
        });

        await expect(
            enrichment.__unifiedEnrichmentTestables.runEnrichmentCycle(false)
        ).resolves.toEqual({
            artists: 0,
            tracks: 0,
            audioQueued: 0,
        });

        const runtimeState =
            enrichment.__unifiedEnrichmentTestables.__getRuntimeStateForTests();
        expect(runtimeState).toEqual(
            expect.objectContaining({
                isPaused: true,
                isRunning: false,
                isStopping: false,
                immediateEnrichmentRequested: false,
                lastRunTime: expect.any(Number),
            })
        );
    });

    it("falls back to default claim ttl when ENRICHMENT_CLAIM_TTL_MS is invalid", async () => {
        const priorClaimTtl = process.env.ENRICHMENT_CLAIM_TTL_MS;
        process.env.ENRICHMENT_CLAIM_TTL_MS = "0";
        try {
            const { claimRedisPrimary } = setupUnifiedEnrichmentMocks();
            (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce(null);

            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const enrichment = require("../unifiedEnrichment");
            await enrichment.triggerEnrichmentNow();

            expect(claimRedisPrimary.set).toHaveBeenCalledWith(
                "enrichment:cycle:claim",
                expect.any(String),
                "EX",
                900,
                "NX"
            );
        } finally {
            if (priorClaimTtl === undefined) {
                delete process.env.ENRICHMENT_CLAIM_TTL_MS;
            } else {
                process.env.ENRICHMENT_CLAIM_TTL_MS = priorClaimTtl;
            }
        }
    });

    it("avoids re-subscribing control channel and ignores unknown control messages", async () => {
        jest.useFakeTimers();
        const { controlSubscriber, claimRedisPrimary, logger } =
            setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValue(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.startUnifiedEnrichmentWorker();
        await enrichment.startUnifiedEnrichmentWorker();

        expect(controlSubscriber.subscribe).toHaveBeenCalledTimes(1);
        const messageHandler = (controlSubscriber.on as jest.Mock).mock.calls.find(
            (call: any[]) => call[0] === "message"
        )?.[1];
        expect(messageHandler).toBeTruthy();

        messageHandler("other:channel", "pause");
        messageHandler("enrichment:control", "unknown-command");

        expect(logger.debug).not.toHaveBeenCalledWith("[Enrichment] Paused");
        expect(logger.debug).not.toHaveBeenCalledWith("[Enrichment] Resumed");
        expect(logger.debug).not.toHaveBeenCalledWith(
            "[Enrichment] Stopping gracefully - completing current item..."
        );

        await enrichment.stopUnifiedEnrichmentWorker();
    });

    it("records system cycle failures with string error payloads", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            enrichmentStateService,
            enrichmentFailureService,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([]);
        (enrichmentStateService.updateState as jest.Mock).mockImplementation(
            async (payload: any) => {
                if (payload?.status === "running") {
                    throw "state update string failure";
                }
                return undefined;
            }
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(enrichmentFailureService.recordFailure).toHaveBeenCalledWith(
            expect.objectContaining({
                entityId: "system",
                errorMessage: "state update string failure",
            })
        );
    });

    it("records non-timeout artist failures as ENRICHMENT_ERROR for non-Error throws", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            enrichSimilarArtist,
            enrichmentFailureService,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([
            { id: "artist-string-fail", name: "Artist String Fail", mbid: "mbid-string-fail" },
        ]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([]);
        (enrichSimilarArtist as jest.Mock).mockRejectedValueOnce(
            "artist plain failure"
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(enrichmentFailureService.recordFailure).toHaveBeenCalledWith(
            expect.objectContaining({
                entityType: "artist",
                entityId: "artist-string-fail",
                errorMessage: "artist plain failure",
                errorCode: "ENRICHMENT_ERROR",
            })
        );
    });

    it("covers mood-tag include matching, _no_mood_tags fallback, and object-error track failure mapping", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            lastFmService,
            enrichmentFailureService,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query?: any) => {
            if (query?.include?.album) {
                return [
                    {
                        id: "track-mood-include",
                        title: "Mood Include",
                        albumId: "album-1",
                        filePath: "/music/mood-include.flac",
                        album: { artist: { name: "Artist One" } },
                    },
                    {
                        id: "track-mood-none",
                        title: "Mood None",
                        albumId: "album-2",
                        filePath: "/music/mood-none.flac",
                        album: { artist: { name: "Artist Two" } },
                    },
                    {
                        id: "track-mood-error",
                        title: "Mood Error",
                        albumId: "album-3",
                        filePath: "/music/mood-error.flac",
                        album: { artist: { name: "Artist Three" } },
                    },
                ];
            }
            return [];
        });
        (lastFmService.getTrackInfo as jest.Mock)
            .mockResolvedValueOnce({
                toptags: { tag: [{ name: "Ultra Chillwave Vibes" }] },
            })
            .mockResolvedValueOnce({
                toptags: { tag: [{ name: "Symphonic" }] },
            })
            .mockRejectedValueOnce({});

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(prisma.track.update).toHaveBeenCalledWith({
            where: { id: "track-mood-include" },
            data: {
                lastfmTags: expect.arrayContaining(["ultra chillwave vibes"]),
            },
        });
        expect(prisma.track.update).toHaveBeenCalledWith({
            where: { id: "track-mood-none" },
            data: { lastfmTags: ["_no_mood_tags"] },
        });
        expect(enrichmentFailureService.recordFailure).toHaveBeenCalledWith(
            expect.objectContaining({
                entityType: "track",
                entityId: "track-mood-error",
                errorMessage: "[object Object]",
                errorCode: "LASTFM_ERROR",
            })
        );
    });

    it("retries queue redis operations when retryable errors are thrown as strings", async () => {
        const { claimRedisPrimary, prisma, getFeatures, queueRedisPrimary } =
            setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query?: any) => {
            if (query?.include?.album) return [];
            if (query?.where?.analysisStatus === "pending" && query?.select?.filePath) {
                return [
                    {
                        id: "audio-string-retry",
                        filePath: "/music/audio-string-retry.flac",
                        title: "Audio String Retry",
                        duration: 180,
                    },
                ];
            }
            return [];
        });
        (queueRedisPrimary.rpush as jest.Mock).mockRejectedValueOnce(
            "Connection is closed"
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(queueRedisPrimary.disconnect).toHaveBeenCalledTimes(1);
        expect(queueRedisPrimary.rpush).toHaveBeenCalledTimes(2);
    });

    it("keeps queued-audio summary silent when all queue pushes fail", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            queueRedisPrimary,
            logger,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query?: any) => {
            if (query?.include?.album) return [];
            if (query?.where?.analysisStatus === "pending" && query?.select?.filePath) {
                return [
                    {
                        id: "audio-none-queued",
                        filePath: "/music/audio-none.flac",
                        title: "Audio None",
                        duration: 120,
                    },
                ];
            }
            return [];
        });
        (queueRedisPrimary.rpush as jest.Mock).mockRejectedValue(
            new Error("push failed hard")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const result = await enrichment.runFullEnrichment();

        expect(result.audioQueued).toBe(0);
        expect(logger.debug).not.toHaveBeenCalledWith(
            expect.stringContaining("Queued 0 tracks for audio analysis")
        );
    });

    it("retries prisma helper for engine-exited and string retryable connection-reset errors", async () => {
        setupUnifiedEnrichmentMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("../../utils/db");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");

        const engineExitedOperation = jest
            .fn()
            .mockRejectedValueOnce(
                new Prisma.PrismaClientUnknownRequestError(
                    "Engine has already exited"
                )
            )
            .mockResolvedValueOnce("engine-exited-recovered");
        const stringResetOperation = jest
            .fn()
            .mockRejectedValueOnce("Connection reset by peer")
            .mockResolvedValueOnce("string-reset-recovered");

        await expect(
            enrichment.__unifiedEnrichmentTestables.withEnrichmentPrismaRetry(
                "engine-exited-op",
                engineExitedOperation
            )
        ).resolves.toBe("engine-exited-recovered");
        await expect(
            enrichment.__unifiedEnrichmentTestables.withEnrichmentPrismaRetry(
                "string-reset-op",
                stringResetOperation
            )
        ).resolves.toBe("string-reset-recovered");
    });

    it("swallows reconnect failures during P2037 retry and succeeds on the next prisma attempt", async () => {
        jest.useFakeTimers();
        const { prisma } = setupUnifiedEnrichmentMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("../../utils/db");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");

        const tooManyConnectionsError = new Prisma.PrismaClientKnownRequestError(
            "too many clients"
        ) as any;
        tooManyConnectionsError.code = "P2037";

        const operation = jest
            .fn()
            .mockRejectedValueOnce(tooManyConnectionsError)
            .mockResolvedValueOnce("recovered-after-reconnect");

        (prisma.$disconnect as jest.Mock).mockRejectedValueOnce(
            new Error("disconnect failed")
        );
        (prisma.$connect as jest.Mock).mockRejectedValueOnce(
            new Error("connect failed")
        );

        const retryPromise =
            enrichment.__unifiedEnrichmentTestables.withEnrichmentPrismaRetry(
                "p2037-retry-swallow",
                operation
            );

        await jest.advanceTimersByTimeAsync(1_000);
        await expect(retryPromise).resolves.toBe("recovered-after-reconnect");
        expect(prisma.$disconnect).toHaveBeenCalledTimes(1);
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
    });

    it("short-circuits podcast phase when no stale feeds exist", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            refreshPodcastFeed,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(async () => []);
        (prisma.podcast.count as jest.Mock).mockResolvedValueOnce(1);
        (prisma.podcast.findMany as jest.Mock).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(refreshPodcastFeed).not.toHaveBeenCalled();
    });

    it("breaks podcast refresh loop when paused during iteration and handles zero new-episode refreshes", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            refreshPodcastFeed,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(async () => []);
        (prisma.podcast.count as jest.Mock).mockResolvedValueOnce(1);
        (prisma.podcast.findMany as jest.Mock).mockResolvedValueOnce([
            { id: "podcast-1", title: "Podcast One" },
            { id: "podcast-2", title: "Podcast Two" },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        (refreshPodcastFeed as jest.Mock).mockImplementationOnce(async () => {
            enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
                isPaused: true,
            });
            return { newEpisodesCount: 0 };
        });

        await enrichment.runFullEnrichment();

        expect(refreshPodcastFeed).toHaveBeenCalledTimes(1);
    });

    it("returns immediately from runEnrichmentCycle when already paused without syncing state first", async () => {
        const { enrichmentStateService } = setupUnifiedEnrichmentMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
            isPaused: true,
            isRunning: false,
            isStopping: false,
            immediateEnrichmentRequested: false,
            lastRunTime: 0,
        });

        await expect(
            enrichment.__unifiedEnrichmentTestables.runEnrichmentCycle(false)
        ).resolves.toEqual({
            artists: 0,
            tracks: 0,
            audioQueued: 0,
        });
        expect(enrichmentStateService.getState).not.toHaveBeenCalled();
    });

    it("handles core-complete cache checks when no mix keys exist", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            queueRedisPrimary,
            enrichmentStateService,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(async () => []);
        (prisma.$transaction as jest.Mock).mockResolvedValue([
            [{ enrichmentStatus: "completed", _count: 1 }],
            1,
            1,
            1,
            0,
            0,
            0,
            [{ count: BigInt(1) }],
            0,
            0,
        ]);
        (queueRedisPrimary.keys as jest.Mock).mockResolvedValue([]);
        (enrichmentStateService.getState as jest.Mock)
            .mockResolvedValueOnce({ status: "idle" })
            .mockResolvedValueOnce({ coreCacheCleared: false })
            .mockResolvedValueOnce({
                pendingMoodBucketBackfill: false,
                moodBucketBackfillInProgress: false,
            })
            .mockResolvedValueOnce({ fullCacheCleared: true })
            .mockResolvedValueOnce({ completionNotificationSent: true });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        await enrichment.runFullEnrichment();

        expect(queueRedisPrimary.keys).toHaveBeenCalledWith("mixes:*");
        expect(queueRedisPrimary.del).not.toHaveBeenCalled();
    });

    it("includes artist, track, and audio failure components in completion error notifications", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            enrichmentStateService,
            notificationService,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(async () => []);
        (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: "user-1" }]);
        (prisma.$transaction as jest.Mock).mockResolvedValue([
            [{ enrichmentStatus: "completed", _count: 1 }],
            1,
            1,
            1,
            0,
            0,
            0,
            [{ count: BigInt(1) }],
            0,
            0,
        ]);
        (enrichmentStateService.getState as jest.Mock)
            .mockResolvedValueOnce({ status: "idle" })
            .mockResolvedValueOnce({ coreCacheCleared: true })
            .mockResolvedValueOnce({
                pendingMoodBucketBackfill: false,
                moodBucketBackfillInProgress: false,
            })
            .mockResolvedValueOnce({ fullCacheCleared: true })
            .mockResolvedValueOnce({ completionNotificationSent: false });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
            sessionFailureCount: {
                artists: 1,
                tracks: 2,
                audio: 3,
            },
        });

        await enrichment.runFullEnrichment();

        expect(notificationService.create).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "user-1",
                title: "Enrichment Completed with Errors",
                message: expect.stringContaining(
                    "artist(s), 2 track(s), 3 audio analysis"
                ),
            })
        );
    });

    it("omits track failure component in completion error notifications when track failures are zero", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            enrichmentStateService,
            notificationService,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(async () => []);
        (prisma.user.findMany as jest.Mock).mockResolvedValue([{ id: "user-1" }]);
        (prisma.$transaction as jest.Mock).mockResolvedValue([
            [{ enrichmentStatus: "completed", _count: 1 }],
            1,
            1,
            1,
            0,
            0,
            0,
            [{ count: BigInt(1) }],
            0,
            0,
        ]);
        (enrichmentStateService.getState as jest.Mock)
            .mockResolvedValueOnce({ status: "idle" })
            .mockResolvedValueOnce({ coreCacheCleared: true })
            .mockResolvedValueOnce({
                pendingMoodBucketBackfill: false,
                moodBucketBackfillInProgress: false,
            })
            .mockResolvedValueOnce({ fullCacheCleared: true })
            .mockResolvedValueOnce({ completionNotificationSent: false });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
            sessionFailureCount: {
                artists: 1,
                tracks: 0,
                audio: 2,
            },
        });

        await enrichment.runFullEnrichment();

        const createCallPayload = (notificationService.create as jest.Mock).mock
            .calls[0]?.[0];
        expect(createCallPayload).toEqual(
            expect.objectContaining({
                userId: "user-1",
                title: "Enrichment Completed with Errors",
            })
        );
        expect(createCallPayload?.message).toContain("1 artist(s)");
        expect(createCallPayload?.message).toContain("2 audio analysis");
        expect(createCallPayload?.message).not.toContain("track(s)");
    });

    it("marks completion notifications sent even when no users are returned", async () => {
        const {
            claimRedisPrimary,
            prisma,
            getFeatures,
            enrichmentStateService,
            notificationService,
        } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockResolvedValueOnce("OK");
        getFeatures.mockResolvedValue({ vibeEmbeddings: false });
        (prisma.artist.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue(async () => []);
        (prisma.user.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.$transaction as jest.Mock).mockResolvedValue([
            [{ enrichmentStatus: "completed", _count: 1 }],
            1,
            1,
            1,
            0,
            0,
            0,
            [{ count: BigInt(1) }],
            0,
            0,
        ]);
        (enrichmentStateService.getState as jest.Mock)
            .mockResolvedValueOnce({ status: "idle" })
            .mockResolvedValueOnce({ coreCacheCleared: true })
            .mockResolvedValueOnce({
                pendingMoodBucketBackfill: false,
                moodBucketBackfillInProgress: false,
            })
            .mockResolvedValueOnce({ fullCacheCleared: true })
            .mockResolvedValueOnce({ completionNotificationSent: false });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        enrichment.__unifiedEnrichmentTestables.__setRuntimeStateForTests({
            sessionFailureCount: { artists: 1, tracks: 0, audio: 0 },
        });

        await enrichment.runFullEnrichment();

        expect(notificationService.create).not.toHaveBeenCalled();
        expect(notificationService.notifySystem).not.toHaveBeenCalled();
        expect(enrichmentStateService.updateState).toHaveBeenCalledWith(
            expect.objectContaining({ completionNotificationSent: true })
        );
    });

    it("skips claim retry path when redis claim errors are undefined and not retryable", async () => {
        const { claimRedisPrimary, logger } = setupUnifiedEnrichmentMocks();
        (claimRedisPrimary.set as jest.Mock).mockRejectedValueOnce(undefined);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");
        const result = await enrichment.triggerEnrichmentNow();

        expect(result).toEqual({ artists: 0, tracks: 0, audioQueued: 0 });
        expect(claimRedisPrimary.disconnect).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining(
                "[Enrichment] Failed to claim immediate enrichment cycle; skipping cycle"
            ),
            undefined
        );
    });

    it("covers unknown-request empty-message and undefined-error paths in prisma retry helper", async () => {
        setupUnifiedEnrichmentMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("../../utils/db");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enrichment = require("../unifiedEnrichment");

        const unknownEmptyOperation = jest.fn().mockRejectedValueOnce(
            new Prisma.PrismaClientUnknownRequestError("")
        );
        const undefinedErrorOperation = jest.fn().mockRejectedValueOnce(
            undefined
        );

        await expect(
            enrichment.__unifiedEnrichmentTestables.withEnrichmentPrismaRetry(
                "unknown-empty-op",
                unknownEmptyOperation
            )
        ).rejects.toBeInstanceOf(Error);
        await expect(
            enrichment.__unifiedEnrichmentTestables.withEnrichmentPrismaRetry(
                "undefined-error-op",
                undefinedErrorOperation
            )
        ).rejects.toBeUndefined();
    });
});
