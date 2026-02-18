describe("discover weekly runtime behavior", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.resetModules();
        jest.clearAllMocks();
    });

    function setupDiscoverWeeklyMocks() {
        const axiosMock = {
            get: jest.fn(async () => ({ data: {} })),
            delete: jest.fn(async () => ({ data: {} })),
        };
        const lidarrService = {
            getDiscoveryArtists: jest.fn(async () => []),
            removeDiscoveryTagByMbid: jest.fn(async () => ({ success: true })),
            deleteArtistById: jest.fn(async () => ({ success: true })),
            deleteAlbum: jest.fn(async () => ({ success: true })),
            getArtistAlbums: jest.fn(async () => []),
            deleteArtist: jest.fn(async () => ({ success: true })),
        };
        const lastFmService = {
            getSimilarArtists: jest.fn(async () => []),
            getArtistTopAlbums: jest.fn(async () => []),
            getTopAlbumsByTag: jest.fn(async () => []),
        };
        const musicBrainzService = {
            searchAlbum: jest.fn(async () => null),
        };
        const tx = {
            unavailableAlbum: {
                upsert: jest.fn(async () => undefined),
            },
            discoveryBatch: {
                create: jest.fn(async () => ({ id: "batch-created" })),
                update: jest.fn(async () => undefined),
            },
            discoveryAlbum: {
                upsert: jest.fn(async () => ({ id: "disc-album-1" })),
                create: jest.fn(async () => ({ id: "disc-album-1" })),
            },
            discoveryTrack: {
                create: jest.fn(async () => undefined),
                findFirst: jest.fn(async () => null),
            },
            userDiscoverConfig: {
                findUnique: jest.fn(async () => null),
            },
            discoverExclusion: {
                upsert: jest.fn(async () => undefined),
            },
            downloadJob: {
                findFirst: jest.fn(async () => null),
                create: jest.fn(async () => undefined),
            },
        };

        const prisma = {
            $connect: jest.fn(async () => undefined),
            $transaction: jest.fn(async (arg: unknown) => {
                if (typeof arg === "function") {
                    return (arg as (client: typeof tx) => Promise<unknown>)(tx);
                }
                return arg;
            }),
            discoveryBatch: {
                findMany: jest.fn(async () => []),
                findUnique: jest.fn(async () => null),
                update: jest.fn(async () => undefined),
            },
            downloadJob: {
                findMany: jest.fn(async () => []),
                update: jest.fn(async () => undefined),
                updateMany: jest.fn(async () => ({ count: 0 })),
            },
            track: {
                findMany: jest.fn(async () => []),
                createMany: jest.fn(async () => ({ count: 0 })),
            },
            album: {
                findMany: jest.fn(async () => []),
                findFirst: jest.fn(async () => null),
            },
            unavailableAlbum: {
                upsert: jest.fn(async () => undefined),
            },
            userDiscoverConfig: {
                findUnique: jest.fn(async () => null),
            },
            discoveryAlbum: {
                findFirst: jest.fn(async () => null),
            },
            ownedAlbum: {
                findFirst: jest.fn(async () => null),
                findMany: jest.fn(async () => []),
            },
            artist: {
                findFirst: jest.fn(async () => null),
            },
            discoverExclusion: {
                findFirst: jest.fn(async () => null),
            },
            play: {
                findMany: jest.fn(async () => []),
            },
        };

        const scanQueue = {
            add: jest.fn(async () => undefined),
        };
        const discoveryBatchLogger = {
            warn: jest.fn(async () => undefined),
            error: jest.fn(async () => undefined),
            info: jest.fn(async () => undefined),
        };
        const acquisitionService = {
            acquireAlbum: jest.fn(async () => ({
                success: true,
                source: "soulseek",
                correlationId: "corr-1",
            })),
        };
        const discoveryLogger = {
            start: jest.fn(() => "/tmp/discovery.log"),
            info: jest.fn(),
            section: jest.fn(),
            table: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            success: jest.fn(),
            list: jest.fn(),
            write: jest.fn(),
            end: jest.fn(),
        };

        jest.doMock("../../utils/db", () => ({ prisma }));
        jest.doMock("../../utils/logger", () => ({
            logger: {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            },
        }));
        jest.doMock("../../utils/artistNormalization", () => ({
            normalizeArtistName: jest.fn((name: string) => name),
        }));
        jest.doMock("axios", () => ({
            __esModule: true,
            default: axiosMock,
        }));
        jest.doMock("../lastfm", () => ({ lastFmService }));
        jest.doMock("../musicbrainz", () => ({ musicBrainzService }));
        jest.doMock("../lidarr", () => ({ lidarrService }));
        jest.doMock("../../workers/queues", () => ({ scanQueue }));
        jest.doMock("date-fns", () => ({
            startOfWeek: jest.fn(() => new Date("2026-02-16T00:00:00.000Z")),
            subWeeks: jest.fn((date: Date) => date),
        }));
        jest.doMock("../../utils/systemSettings", () => ({
            getSystemSettings: jest.fn(async () => ({})),
        }));
        jest.doMock("../discoveryLogger", () => ({
            discoveryLogger,
        }));
        jest.doMock("../acquisitionService", () => ({ acquisitionService }));
        jest.doMock("../discovery", () => ({
            discoveryBatchLogger,
            discoveryAlbumLifecycle: {
                processBeforeGeneration: jest.fn(async () => undefined),
            },
            discoverySeeding: {
                getSeedArtists: jest.fn(async () => []),
                isAlbumOwned: jest.fn(async () => false),
            },
        }));
        jest.doMock("../../utils/shuffle", () => ({
            shuffleArray: jest.fn((arr: unknown[]) => arr),
        }));
        jest.doMock("../artistCountsService", () => ({
            updateArtistCounts: jest.fn(async () => undefined),
        }));
        jest.doMock("../../config", () => ({
            config: { music: { musicPath: "/music" } },
        }));
        jest.doMock("@prisma/client", () => ({
            Prisma: {
                PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
                    code = "P1001";
                },
                PrismaClientRustPanicError: class PrismaClientRustPanicError extends Error {},
                PrismaClientUnknownRequestError: class PrismaClientUnknownRequestError extends Error {},
            },
        }));

        return {
            prisma,
            tx,
            scanQueue,
            discoveryBatchLogger,
            discoveryLogger,
            acquisitionService,
            lidarrService,
            lastFmService,
            musicBrainzService,
            axiosMock,
        };
    }

    it("force-fails stale batches that exceed absolute timeout", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findMany as jest.Mock).mockResolvedValue([
            {
                id: "batch-1",
                status: "downloading",
                createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
                jobs: [{ id: "job-1", status: "pending" }],
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");

        const forcedCount = await discoverWeeklyService.checkStuckBatches();

        expect(forcedCount).toBe(1);
        expect(prisma.discoveryBatch.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "batch-1" },
                data: expect.objectContaining({
                    status: "failed",
                }),
            })
        );
        expect(prisma.downloadJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    discoveryBatchId: "batch-1",
                }),
            })
        );
    });

    it("marks long-running partially-completed batches for completion checks", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findMany as jest.Mock).mockResolvedValue([
            {
                id: "batch-timeout",
                status: "downloading",
                createdAt: new Date(Date.now() - 35 * 60 * 1000),
                jobs: [
                    { id: "job-complete", status: "completed" },
                    { id: "job-pending", status: "pending" },
                ],
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const completionSpy = jest
            .spyOn(discoverWeeklyService, "checkBatchCompletion")
            .mockResolvedValue(undefined);

        await expect(discoverWeeklyService.checkStuckBatches()).resolves.toBe(1);
        expect(prisma.downloadJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    discoveryBatchId: "batch-timeout",
                }),
            })
        );
        expect(completionSpy).toHaveBeenCalledWith("batch-timeout");
    });

    it("skips batch completion when pending jobs still exist", async () => {
        const { prisma, scanQueue } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue({
            id: "batch-pending",
            userId: "user-1",
            status: "downloading",
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
            jobs: [
                { id: "job-1", status: "pending", metadata: {}, targetMbid: null },
            ],
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");

        await discoverWeeklyService.checkBatchCompletion("batch-pending");
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(scanQueue.add).not.toHaveBeenCalled();
    });

    it("marks a batch failed when all jobs fail and triggers failed-artist cleanup", async () => {
        jest.useFakeTimers();
        const { prisma, tx, discoveryBatchLogger } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue({
            id: "batch-failed",
            userId: "user-1",
            status: "downloading",
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
            jobs: [
                {
                    id: "job-failed",
                    status: "failed",
                    metadata: { artistName: "A", albumTitle: "B", similarity: 0.4 },
                    targetMbid: "mbid-1",
                },
            ],
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const cleanupSpy = jest
            .spyOn(discoverWeeklyService as any, "cleanupFailedArtists")
            .mockResolvedValue(undefined);

        const completionPromise =
            discoverWeeklyService.checkBatchCompletion("batch-failed");
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(60_000);
        await completionPromise;

        expect(tx.discoveryBatch.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "batch-failed" },
                data: expect.objectContaining({
                    status: "failed",
                }),
            })
        );
        expect(discoveryBatchLogger.error).toHaveBeenCalledWith(
            "batch-failed",
            "All downloads failed"
        );
        expect(cleanupSpy).toHaveBeenCalledWith("batch-failed");
    });

    it("transitions completed batches to scanning and enqueues one scan job", async () => {
        jest.useFakeTimers();
        const { prisma, tx, scanQueue } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValue({
            id: "batch-scan",
            userId: "user-1",
            status: "downloading",
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
            jobs: [
                {
                    id: "job-completed",
                    status: "completed",
                    metadata: {},
                    targetMbid: "mbid-ok",
                },
                {
                    id: "job-failed",
                    status: "failed",
                    metadata: { artistName: "Failed", albumTitle: "Album", similarity: 0.5 },
                    targetMbid: "mbid-fail",
                },
            ],
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");

        const completionPromise =
            discoverWeeklyService.checkBatchCompletion("batch-scan");
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(60_000);
        await completionPromise;

        expect(tx.unavailableAlbum.upsert).toHaveBeenCalledTimes(1);
        expect(tx.discoveryBatch.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "batch-scan" },
                data: expect.objectContaining({
                    status: "scanning",
                }),
            })
        );
        expect(scanQueue.add).toHaveBeenCalledWith("scan", {
            type: "full",
            source: "discover-weekly-completion",
            discoveryBatchId: "batch-scan",
        });
    });

    it("fails playlist generation when discovery weekly is disabled for the user", async () => {
        const { prisma, discoveryLogger } = setupDiscoverWeeklyMocks();
        (prisma.userDiscoverConfig.findUnique as jest.Mock).mockResolvedValue(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");

        await expect(discoverWeeklyService.generatePlaylist("user-1")).rejects.toThrow(
            "Discovery Weekly not enabled"
        );
        expect(discoveryLogger.end).toHaveBeenCalledWith(false, "Not enabled");
    });

    it("returns early when buildFinalPlaylist receives a missing batch id", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            discoverWeeklyService.buildFinalPlaylist("missing-batch")
        ).resolves.toBeUndefined();

        expect(prisma.downloadJob.findMany).not.toHaveBeenCalled();
    });

    it("marks batch failed when buildFinalPlaylist cannot resolve imported tracks after scan", async () => {
        const { prisma, discoveryBatchLogger } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-no-tracks",
            userId: "user-1",
            targetSongCount: 10,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-1",
                status: "completed",
                targetMbid: "rg-1",
                metadata: {
                    artistName: "Artist 1",
                    albumTitle: "Album 1",
                    albumMbid: "rg-1",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([]);
        (prisma.album.findMany as jest.Mock).mockResolvedValue([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await discoverWeeklyService.buildFinalPlaylist("batch-no-tracks");

        expect(prisma.discoveryBatch.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "batch-no-tracks" },
                data: expect.objectContaining({
                    status: "failed",
                    errorMessage: "No tracks found after scan",
                }),
            })
        );
        expect(discoveryBatchLogger.error).toHaveBeenCalledWith(
            "batch-no-tracks",
            "No tracks found after scan"
        );
    });

    it("skips batch completion when batch is already in terminal or scanning state", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-complete",
            userId: "user-1",
            status: "completed",
            jobs: [],
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await discoverWeeklyService.checkBatchCompletion("batch-complete");

        expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("returns no-op reconciliation when there are no recent completed discovery batches", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findMany as jest.Mock).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.reconcileDiscoveryTracks()).resolves.toEqual(
            { batchesChecked: 0, tracksAdded: 0 }
        );
    });

    it("checks completed batches but skips ones without completed download jobs", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "batch-1",
                status: "completed",
                completedAt: new Date("2026-02-16T00:00:00.000Z"),
            },
        ]);
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.reconcileDiscoveryTracks()).resolves.toEqual(
            { batchesChecked: 1, tracksAdded: 0 }
        );
    });

    it("generates a discovery batch and updates acquired jobs on successful generation", async () => {
        const {
            prisma,
            tx,
            discoveryBatchLogger,
            acquisitionService,
            discoveryLogger,
        } = setupDiscoverWeeklyMocks();
        (prisma.userDiscoverConfig.findUnique as jest.Mock).mockResolvedValueOnce({
            userId: "user-1",
            enabled: true,
            downloadRatio: 1.3,
            playlistSize: 2,
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-1",
                metadata: {
                    artistName: "Artist 1",
                    albumTitle: "Album 1",
                    albumMbid: "rg-1",
                },
            },
            {
                id: "job-2",
                metadata: {
                    artistName: "Artist 2",
                    albumTitle: "Album 2",
                    albumMbid: "rg-2",
                },
            },
        ]);
        (acquisitionService.acquireAlbum as jest.Mock)
            .mockResolvedValueOnce({
                success: true,
                source: "soulseek",
                correlationId: "corr-1",
            })
            .mockResolvedValueOnce({
                success: true,
                source: "soulseek",
                correlationId: "corr-2",
            });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "prefetchSimilarArtists").mockResolvedValue(
            new Map([["seed-1", []]])
        );
        jest.spyOn(
            discoverWeeklyService as any,
            "findRecommendedAlbumsMultiStrategy"
        ).mockResolvedValue([
            {
                artistName: "Artist 1",
                artistMbid: "seed-1",
                albumTitle: "Album 1",
                albumMbid: "rg-1",
                similarity: 0.7,
                tier: "high",
            },
            {
                artistName: "Artist 2",
                artistMbid: "seed-2",
                albumTitle: "Album 2",
                albumMbid: "rg-2",
                similarity: 0.6,
                tier: "high",
            },
        ]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValue([{ name: "Seed Artist", mbid: "seed-1" }]);

        const result = await discoverWeeklyService.generatePlaylist("user-1");

        expect(tx.discoveryBatch.create).toHaveBeenCalledTimes(1);
        expect(tx.downloadJob.create).toHaveBeenCalledTimes(2);
        expect(prisma.downloadJob.update).toHaveBeenCalledTimes(2);
        expect(discoveryBatchLogger.info).toHaveBeenCalledWith(
            expect.any(String),
            expect.stringContaining("downloads started")
        );
        expect(result).toEqual(
            expect.objectContaining({
                success: true,
                songCount: 0,
                batchId: expect.any(String),
            })
        );
        expect(discoveryLogger.end).toHaveBeenCalledWith(
            true,
            expect.stringContaining("downloads queued")
        );
    });

    it("cleans orphaned Lidarr queue entries tied to failed discovery downloads", async () => {
        const { prisma, axiosMock } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-clean",
            jobs: [{ id: "job-1", lidarrRef: "dl-1" }],
        });
        const settingsModule = require("../../utils/systemSettings");
        (settingsModule.getSystemSettings as jest.Mock).mockResolvedValueOnce({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr",
            lidarrApiKey: "abc123",
        });
        (axiosMock.get as jest.Mock).mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 10,
                        title: "Album One",
                        downloadId: "dl-1",
                        status: "warning",
                        trackedDownloadState: "importFailed",
                    },
                ],
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await (discoverWeeklyService as any).cleanupOrphanedLidarrQueue(
            "batch-clean"
        );

        expect(axiosMock.delete).toHaveBeenCalledWith(
            "http://lidarr/api/v1/queue/10",
            expect.objectContaining({
                params: expect.objectContaining({
                    removeFromClient: true,
                    blocklist: true,
                }),
            })
        );
    });

    it("cleans failed discovery artists while preserving successful and liked artists", async () => {
        const { prisma, lidarrService, discoveryBatchLogger } =
            setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-artists",
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
            jobs: [
                {
                    id: "job-success",
                    status: "completed",
                    metadata: { artistMbid: "artist-success" },
                },
                {
                    id: "job-failed",
                    status: "failed",
                    metadata: { artistMbid: "artist-failed" },
                },
            ],
        });
        (lidarrService.getDiscoveryArtists as jest.Mock).mockResolvedValueOnce([
            {
                id: 1,
                artistName: "Successful Artist",
                foreignArtistId: "artist-success",
            },
            {
                id: 2,
                artistName: "Liked Artist",
                foreignArtistId: "artist-liked",
            },
            {
                id: 3,
                artistName: "Failed Artist",
                foreignArtistId: "artist-failed",
            },
        ]);
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockImplementation(
            async (query: any) => {
                if (
                    query?.where?.artistMbid === "artist-liked" &&
                    query?.where?.status?.in
                ) {
                    return { id: "liked-1" };
                }
                return null;
            }
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await (discoverWeeklyService as any).cleanupFailedArtists(
            "batch-artists"
        );

        expect(lidarrService.removeDiscoveryTagByMbid).toHaveBeenCalledWith(
            "artist-liked"
        );
        expect(lidarrService.deleteArtistById).toHaveBeenCalledWith(3, true);
        expect(discoveryBatchLogger.info).toHaveBeenCalledWith(
            "batch-artists",
            expect.stringContaining("failed artists removed")
        );
    });

    it("checks artist presence in library by mbid and by name", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.artist.findFirst as jest.Mock)
            .mockResolvedValueOnce({
                id: "artist-1",
                albums: [{ id: "album-1" }],
            })
            .mockResolvedValueOnce({
                id: "artist-2",
                albums: [{ id: "album-2" }],
            });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).isArtistInLibrary(
                "Artist MBID",
                "mbid-artist-1"
            )
        ).resolves.toBe(true);
        await expect(
            (discoverWeeklyService as any).isArtistInLibrary(
                "Artist Name",
                undefined
            )
        ).resolves.toBe(true);
    });

    it("finds a tier-2 replacement album from a new similar artist", async () => {
        const { prisma, lastFmService, musicBrainzService } =
            setupDiscoverWeeklyMocks();
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-existing",
                targetMbid: "rg-existing",
                metadata: { artistMbid: "artist-existing" },
            },
        ]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([
            { name: "Seed Artist", mbid: "seed-1" },
        ]);
        (
            discoveryModule.discoverySeeding.isAlbumOwned as jest.Mock
        ).mockResolvedValue(false);
        (lastFmService.getSimilarArtists as jest.Mock).mockResolvedValueOnce([
            { name: "New Similar", mbid: "artist-new", match: 0.72 },
        ]);
        (lastFmService.getArtistTopAlbums as jest.Mock).mockResolvedValueOnce([
            { name: "New Album" },
        ]);
        (musicBrainzService.searchAlbum as jest.Mock).mockResolvedValueOnce({
            id: "rg-new",
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "isArtistInLibrary").mockResolvedValue(false);
        jest.spyOn(discoverWeeklyService as any, "isAlbumExcluded").mockResolvedValue(false);

        const replacement = await discoverWeeklyService.findReplacementAlbum(
            {
                id: "failed-job",
                metadata: { artistName: "Old", albumTitle: "Old Album", artistMbid: "artist-failed" },
            },
            { id: "batch-r1", userId: "user-1" }
        );

        expect(replacement).toEqual(
            expect.objectContaining({
                artistName: "New Similar",
                albumTitle: "New Album",
                albumMbid: "rg-new",
            })
        );
    });

    it("falls back to a library anchor replacement when no new artists qualify", async () => {
        const { prisma, lastFmService } = setupDiscoverWeeklyMocks();
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.album.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "album-anchor",
            title: "Anchor Album",
            rgMbid: "rg-anchor",
            artist: { name: "Seed Artist", mbid: "seed-artist-mbid" },
        });
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([
            { name: "Seed Artist", mbid: "seed-1" },
        ]);
        (lastFmService.getSimilarArtists as jest.Mock).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const replacement = await discoverWeeklyService.findReplacementAlbum(
            {
                id: "failed-job",
                metadata: { artistName: "Old", albumTitle: "Old Album", artistMbid: "artist-failed" },
            },
            { id: "batch-r2", userId: "user-1" }
        );

        expect(replacement).toEqual(
            expect.objectContaining({
                artistName: "Seed Artist",
                albumTitle: "Anchor Album",
                albumMbid: "rg-anchor",
                similarity: 1,
                isLibraryAnchor: true,
            })
        );
    });

    it("retries discover-weekly prisma operations on retryable errors and reconnects", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        const retryable = new Prisma.PrismaClientKnownRequestError(
            "temporary connection loss"
        );
        (prisma.discoveryBatch.findMany as jest.Mock)
            .mockRejectedValueOnce(retryable)
            .mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.checkStuckBatches()).resolves.toBe(0);

        expect(prisma.discoveryBatch.findMany).toHaveBeenCalledTimes(2);
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
    });

    it("throws after exhausting discover-weekly prisma retries", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        const retryable = new Prisma.PrismaClientKnownRequestError(
            "persistent db failure"
        );
        (prisma.discoveryBatch.findMany as jest.Mock).mockRejectedValue(retryable);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.checkStuckBatches()).rejects.toThrow(
            "persistent db failure"
        );
        expect(prisma.discoveryBatch.findMany).toHaveBeenCalledTimes(3);
        expect(prisma.$connect).toHaveBeenCalledTimes(2);
    });

    it("swallows reconnect errors while retrying discover-weekly prisma reads", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        const retryable = new Prisma.PrismaClientKnownRequestError(
            "temporary disconnect"
        );
        (prisma.discoveryBatch.findMany as jest.Mock)
            .mockRejectedValueOnce(retryable)
            .mockResolvedValueOnce([]);
        (prisma.$connect as jest.Mock).mockRejectedValueOnce(
            new Error("reconnect failed")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.checkStuckBatches()).resolves.toBe(0);
        expect(prisma.discoveryBatch.findMany).toHaveBeenCalledTimes(2);
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
    });

    it("marks failed acquisitions and triggers completion check during playlist generation", async () => {
        const { prisma, tx, acquisitionService, discoveryBatchLogger } =
            setupDiscoverWeeklyMocks();
        (prisma.userDiscoverConfig.findUnique as jest.Mock).mockResolvedValueOnce({
            userId: "user-2",
            enabled: true,
            downloadRatio: 1.3,
            playlistSize: 1,
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-fail-1",
                metadata: {
                    artistName: "Artist X",
                    albumTitle: "Album X",
                    albumMbid: "rg-x",
                },
            },
        ]);
        (acquisitionService.acquireAlbum as jest.Mock).mockResolvedValueOnce({
            success: false,
            error: "no sources available",
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "prefetchSimilarArtists").mockResolvedValue(
            new Map([["seed-1", []]])
        );
        jest.spyOn(
            discoverWeeklyService as any,
            "findRecommendedAlbumsMultiStrategy"
        ).mockResolvedValue([
            {
                artistName: "Artist X",
                artistMbid: "seed-1",
                albumTitle: "Album X",
                albumMbid: "rg-x",
                similarity: 0.55,
                tier: "medium",
            },
        ]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValue([{ name: "Seed Artist", mbid: "seed-1" }]);
        const completionSpy = jest
            .spyOn(discoverWeeklyService, "checkBatchCompletion")
            .mockResolvedValue(undefined);

        await expect(discoverWeeklyService.generatePlaylist("user-2")).resolves.toEqual(
            expect.objectContaining({ success: true })
        );

        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-fail-1" },
                data: expect.objectContaining({
                    status: "failed",
                    error: "no sources available",
                }),
            })
        );
        expect(discoveryBatchLogger.error).toHaveBeenCalledWith(
            tx.discoveryBatch.create.mock.results[0]?.value?.id || expect.any(String),
            expect.stringContaining("Failed to acquire Album X")
        );
        expect(completionSpy).toHaveBeenCalled();
    });

    it("builds final playlist with discovery tracks and library-anchor fallback in one transaction", async () => {
        const { prisma, tx } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-final",
            userId: "user-1",
            targetSongCount: 5,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-1",
                status: "completed",
                lidarrAlbumId: 99,
                targetMbid: "rg-1",
                metadata: {
                    artistName: "Artist One",
                    albumTitle: "Album One",
                    albumMbid: "rg-1",
                    similarity: 0.8,
                    tier: "high",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([
                {
                    id: "track-1",
                    filePath: "/music/Artist One/Album One/01.mp3",
                    album: {
                        id: "album-1",
                        title: "Album One",
                        rgMbid: "rg-1",
                        artist: { name: "Artist One", mbid: "artist-1" },
                    },
                },
            ])
            .mockResolvedValueOnce([]) // seed-artist library anchors
            .mockResolvedValueOnce([]); // popular library fallback
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([{ name: "Seed One", mbid: "seed-1" }]);
        jest.spyOn(require("../discoverWeekly").discoverWeeklyService as any, "cleanupFailedArtists").mockResolvedValue(undefined);
        jest.spyOn(require("../discoverWeekly").discoverWeeklyService as any, "cleanupOrphanedLidarrQueue").mockResolvedValue(undefined);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const cleanupFailedSpy = jest
            .spyOn(discoverWeeklyService as any, "cleanupFailedArtists")
            .mockResolvedValue(undefined);
        const cleanupQueueSpy = jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-final")
        ).resolves.toBeUndefined();

        expect(prisma.track.findMany).toHaveBeenCalledTimes(3);
        expect(tx.discoveryAlbum.upsert).toHaveBeenCalledTimes(1);
        expect(tx.discoveryTrack.create).toHaveBeenCalledTimes(1);
        expect(tx.discoveryBatch.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "batch-final" },
                data: expect.objectContaining({
                    status: "completed",
                    finalSongCount: 1,
                }),
            })
        );
        expect(cleanupFailedSpy).toHaveBeenCalledWith("batch-final");
        expect(cleanupQueueSpy).toHaveBeenCalledWith("batch-final");
    });

    it("reconciles missing discovery records by falling back from mbid to name search", async () => {
        const { prisma, tx } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "batch-rec",
                userId: "user-1",
                weekStart: new Date("2026-02-16T00:00:00.000Z"),
                status: "completed",
                completedAt: new Date("2026-02-16T02:00:00.000Z"),
            },
        ]);
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-rec-1",
                status: "completed",
                lidarrAlbumId: 10,
                targetMbid: "rg-miss",
                metadata: {
                    artistName: "Artist Recon",
                    albumTitle: "Album Recon",
                    albumMbid: "rg-miss",
                    similarity: 0.6,
                    tier: "medium",
                },
            },
        ]);
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([]) // mbid miss
            .mockResolvedValueOnce([
                {
                    id: "track-rec-1",
                    filePath: "/music/Artist Recon/Album Recon/01.mp3",
                    album: {
                        id: "alb-rec",
                        title: "Album Recon",
                        rgMbid: "rg-miss",
                        artist: { name: "Artist Recon", mbid: "artist-rec" },
                    },
                },
            ]); // name fallback hit
        (tx.discoveryTrack.findFirst as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.reconcileDiscoveryTracks()).resolves.toEqual({
            batchesChecked: 1,
            tracksAdded: 1,
        });

        expect(prisma.track.findMany).toHaveBeenCalledTimes(2);
        expect(tx.discoveryAlbum.create).toHaveBeenCalledTimes(1);
        expect(tx.discoveryTrack.create).toHaveBeenCalledTimes(1);
    });

    it("cleans up extra albums by cancelling jobs and removing empty artists", async () => {
        const { prisma, lidarrService } = setupDiscoverWeeklyMocks();
        (lidarrService.deleteAlbum as jest.Mock).mockResolvedValueOnce({
            success: true,
            message: "deleted",
        });
        (lidarrService.getArtistAlbums as jest.Mock).mockResolvedValueOnce([]);
        (prisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (lidarrService.deleteArtist as jest.Mock).mockResolvedValueOnce({
            success: true,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupExtraAlbums(
                [
                    {
                        id: "job-extra-1",
                        targetMbid: "rg-extra",
                        lidarrAlbumId: 123,
                        metadata: {
                            artistMbid: "artist-extra",
                            artistName: "Artist Extra",
                            albumTitle: "Album Extra",
                        },
                    },
                ],
                "user-1"
            )
        ).resolves.toBeUndefined();

        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-extra-1" },
                data: expect.objectContaining({
                    status: "cancelled",
                }),
            })
        );
        expect(lidarrService.deleteArtist).toHaveBeenCalledWith(
            "artist-extra",
            true
        );
    });

    it("resolves owned albums by normalized name through owned-album rgMbid references", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.album.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.ownedAlbum.findMany as jest.Mock).mockResolvedValueOnce([
            { rgMbid: "rg-owned-1" },
        ]);
        (prisma.album.findMany as jest.Mock).mockResolvedValueOnce([
            { title: "The Album Name [Deluxe]" },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).isAlbumOwnedByName(
                "The Artist",
                "The Album Name (Remaster)"
            )
        ).resolves.toBe(true);
    });

    it("checks exclusion lookup and aggregates user top genres from canonical plus user tags", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoverExclusion.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "ex-1",
        });
        (prisma.play.findMany as jest.Mock).mockResolvedValueOnce([
            {
                track: {
                    album: {
                        artist: {
                            genres: ["Rock", "Indie"],
                            userGenres: ["Post-Rock"],
                        },
                    },
                },
            },
            {
                track: {
                    album: {
                        artist: {
                            genres: "Indie, Dream Pop",
                            userGenres: ["Post-Rock", "Ambient"],
                        },
                    },
                },
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).isAlbumExcluded("rg-1", "user-1")
        ).resolves.toBe(true);
        await expect(
            (discoverWeeklyService as any).getUserTopGenres("user-1")
        ).resolves.toEqual(
            expect.arrayContaining(["indie", "post-rock", "rock"])
        );
    });

    it("retries discover-weekly prisma reads on unknown-request engine-empty errors", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        (prisma.discoveryBatch.findMany as jest.Mock)
            .mockRejectedValueOnce(
                new Prisma.PrismaClientUnknownRequestError(
                    "Response from the Engine was empty"
                )
            )
            .mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.checkStuckBatches()).resolves.toBe(0);

        expect(prisma.discoveryBatch.findMany).toHaveBeenCalledTimes(2);
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
    });

    it("returns empty recommendations when similar cache has no artists", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const recommendations = await (discoverWeeklyService as any).findRecommendedAlbums(
            [{ name: "Seed Artist", mbid: "seed-1" }],
            new Map([["seed-1", []]]),
            3,
            "user-1"
        );

        expect(recommendations).toEqual([]);
    });

    it("evaluates album candidates for an artist across duplicate/owned/excluded and valid branches", async () => {
        const { lastFmService, musicBrainzService } = setupDiscoverWeeklyMocks();
        (lastFmService.getArtistTopAlbums as jest.Mock).mockResolvedValueOnce([
            { name: "Live at Venue" },
            { name: "Duplicate Album" },
            { name: "No MBID Album" },
            { name: "Owned Album" },
            { name: "Excluded Album" },
            { name: "Valid Album" },
        ]);
        (musicBrainzService.searchAlbum as jest.Mock)
            .mockResolvedValueOnce({ id: "rg-dup" })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "rg-owned" })
            .mockResolvedValueOnce({ id: "rg-excluded" })
            .mockResolvedValueOnce({ id: "rg-valid" });

        const discoveryModule = require("../discovery");
        (discoveryModule.discoverySeeding.isAlbumOwned as jest.Mock).mockImplementation(
            async (rgMbid: string) => rgMbid === "rg-owned"
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "isAlbumOwnedByName").mockResolvedValue(
            false
        );
        jest.spyOn(discoverWeeklyService as any, "isAlbumExcluded").mockImplementation(
            async (rgMbid: unknown) => rgMbid === "rg-excluded"
        );

        const result = await (discoverWeeklyService as any).findValidAlbumForArtist(
            { name: "Candidate Artist", mbid: "artist-mbid", match: 0.63 },
            "user-1",
            new Set<string>(["rg-dup"])
        );

        expect(result.recommendation).toEqual(
            expect.objectContaining({
                artistName: "Candidate Artist",
                albumTitle: "Valid Album",
                albumMbid: "rg-valid",
            })
        );
        expect(result.skippedDuplicate).toBeGreaterThan(0);
        expect(result.skippedNoMbid).toBeGreaterThan(0);
        expect(result.skippedOwned).toBeGreaterThan(0);
        expect(result.skippedExcluded).toBeGreaterThan(0);
    });

    it("uses fallback genres in tag exploration and returns wildcard recommendations", async () => {
        const { lastFmService, musicBrainzService } = setupDiscoverWeeklyMocks();
        (lastFmService.getTopAlbumsByTag as jest.Mock).mockResolvedValue([
            { name: "Live Session", artist: { name: "Skip Artist" } },
            { name: "Studio Cut", artist: { name: "Keep Artist" } },
        ]);
        (musicBrainzService.searchAlbum as jest.Mock).mockResolvedValue({
            id: "rg-studio",
        });

        const discoveryModule = require("../discovery");
        (discoveryModule.discoverySeeding.isAlbumOwned as jest.Mock).mockResolvedValue(
            false
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "getUserTopGenres").mockResolvedValue(
            []
        );
        jest.spyOn(discoverWeeklyService as any, "isAlbumOwnedByName").mockResolvedValue(
            false
        );
        jest.spyOn(discoverWeeklyService as any, "isAlbumExcluded").mockResolvedValue(
            false
        );
        jest.spyOn(discoverWeeklyService as any, "isArtistInLibrary").mockResolvedValue(
            false
        );

        const wildcardResults = await (discoverWeeklyService as any).tagExplorationStrategy(
            "user-1",
            1,
            new Set<string>()
        );

        expect(wildcardResults).toHaveLength(1);
        expect(wildcardResults[0]).toEqual(
            expect.objectContaining({
                artistName: "Keep Artist",
                albumTitle: "Studio Cut",
                albumMbid: "rg-studio",
                tier: "wildcard",
            })
        );
    });

    it("builds multi-strategy recommendations using existing-artist fallback and wildcard injection", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "isArtistInLibrary").mockResolvedValue(
            true
        );
        jest
            .spyOn(discoverWeeklyService as any, "findValidAlbumForArtist")
            .mockImplementation(async (artist: any) => ({
                recommendation: {
                    artistName: artist.name,
                    artistMbid: artist.mbid,
                    albumTitle: `${artist.name} Album`,
                    albumMbid: `rg-${artist.name.toLowerCase().replace(/\s+/g, "-")}`,
                    similarity: artist.match || 0.5,
                },
                albumsChecked: 1,
                skippedNoMbid: 0,
                skippedOwned: 0,
                skippedExcluded: 0,
                skippedDuplicate: 0,
            }));
        jest
            .spyOn(discoverWeeklyService as any, "tagExplorationStrategy")
            .mockResolvedValue([
                {
                    artistName: "Wildcard Artist",
                    albumTitle: "Wildcard Album",
                    albumMbid: "rg-wildcard",
                    similarity: 0.7,
                    tier: "wildcard",
                },
            ]);

        const recommendations =
            await discoverWeeklyService.findRecommendedAlbumsMultiStrategy(
                [{ name: "Seed One", mbid: "seed-1" }],
                new Map([
                    [
                        "seed-1",
                        [
                            { name: "High Artist", mbid: "artist-high", match: 0.92 },
                            { name: "Medium Artist", mbid: "artist-medium", match: 0.6 },
                            { name: "Explore Artist", mbid: "artist-explore", match: 0.41 },
                        ],
                    ],
                ]),
                4,
                "user-1"
            );

        expect(recommendations).toHaveLength(4);
        expect(
            recommendations.some(
                (recommendation: any) => recommendation.tier === "wildcard"
            )
        ).toBe(true);
    });

    it("fills recommendations via pass-1 new artists then pass-2 existing-artist fallback", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest
            .spyOn(discoverWeeklyService as any, "isArtistInLibrary")
            .mockImplementation(async (artistName: unknown) => {
                return artistName === "Existing Artist";
            });
        jest
            .spyOn(discoverWeeklyService as any, "findValidAlbumForArtist")
            .mockImplementation(async (artist: any) => {
                if (artist.name === "Fresh Artist") {
                    return {
                        recommendation: {
                            artistName: "Fresh Artist",
                            artistMbid: "artist-fresh",
                            albumTitle: "Fresh Album",
                            albumMbid: "rg-fresh",
                            similarity: 0.74,
                        },
                        albumsChecked: 2,
                        skippedNoMbid: 0,
                        skippedOwned: 0,
                        skippedExcluded: 0,
                        skippedDuplicate: 0,
                    };
                }

                if (artist.name === "Existing Artist") {
                    return {
                        recommendation: {
                            artistName: "Existing Artist",
                            artistMbid: "artist-existing",
                            albumTitle: "Existing Album",
                            albumMbid: "rg-existing",
                            similarity: 0.62,
                        },
                        albumsChecked: 3,
                        skippedNoMbid: 0,
                        skippedOwned: 0,
                        skippedExcluded: 0,
                        skippedDuplicate: 0,
                    };
                }

                return {
                    recommendation: null,
                    albumsChecked: 0,
                    skippedNoMbid: 0,
                    skippedOwned: 0,
                    skippedExcluded: 0,
                    skippedDuplicate: 0,
                };
            });

        const recommendations = await (discoverWeeklyService as any).findRecommendedAlbums(
            [{ name: "Seed One", mbid: "seed-1" }],
            new Map([
                [
                    "seed-1",
                    [
                        { name: "Fresh Artist", mbid: "artist-fresh", match: 0.74 },
                        { name: "Existing Artist", mbid: "artist-existing", match: 0.62 },
                    ],
                ],
            ]),
            2,
            "user-1"
        );

        expect(recommendations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ albumMbid: "rg-fresh" }),
                expect.objectContaining({ albumMbid: "rg-existing" }),
            ])
        );
    });

    it("uses tier selection first and then fill selection for remaining multi-strategy slots", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "isArtistInLibrary").mockResolvedValue(
            false
        );
        jest
            .spyOn(discoverWeeklyService as any, "findValidAlbumForArtist")
            .mockImplementation(async (artist: any) => ({
                recommendation: {
                    artistName: artist.name,
                    artistMbid: artist.mbid,
                    albumTitle: `${artist.name} Album`,
                    albumMbid: `rg-${artist.mbid}`,
                    similarity: artist.match || 0.5,
                },
                albumsChecked: 1,
                skippedNoMbid: 0,
                skippedOwned: 0,
                skippedExcluded: 0,
                skippedDuplicate: 0,
            }));
        jest
            .spyOn(discoverWeeklyService as any, "tagExplorationStrategy")
            .mockResolvedValue([]);

        const recommendations =
            await discoverWeeklyService.findRecommendedAlbumsMultiStrategy(
                [{ name: "Seed One", mbid: "seed-1" }],
                new Map([
                    [
                        "seed-1",
                        [
                            { name: "High One", mbid: "high-1", match: 0.91 },
                            { name: "High Two", mbid: "high-2", match: 0.82 },
                            { name: "Medium One", mbid: "medium-1", match: 0.6 },
                        ],
                    ],
                ]),
                4,
                "user-1"
            );

        expect(recommendations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ albumMbid: "rg-high-1" }),
                expect.objectContaining({ albumMbid: "rg-high-2" }),
                expect.objectContaining({ albumMbid: "rg-medium-1" }),
            ])
        );
    });

    it("retries discover-weekly prisma reads on rust panic and generic retryable string failures", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        (prisma.discoveryBatch.findMany as jest.Mock)
            .mockRejectedValueOnce(
                new Prisma.PrismaClientRustPanicError("panic in query engine")
            )
            .mockRejectedValueOnce("Can't reach database server")
            .mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.checkStuckBatches()).resolves.toBe(0);

        expect(prisma.discoveryBatch.findMany).toHaveBeenCalledTimes(3);
        expect(prisma.$connect).toHaveBeenCalledTimes(2);
    });

    it("fails generation when no seed artists are available", async () => {
        const { prisma, discoveryLogger } = setupDiscoverWeeklyMocks();
        (prisma.userDiscoverConfig.findUnique as jest.Mock).mockResolvedValueOnce({
            userId: "user-no-seeds",
            enabled: true,
            downloadRatio: 1.3,
            playlistSize: 3,
        });
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            discoverWeeklyService.generatePlaylist("user-no-seeds")
        ).rejects.toThrow("No seed artists found - need listening history");
        expect(discoveryLogger.end).toHaveBeenCalledWith(false, "No seed artists");
    });

    it("fails generation when recommendation strategies return no albums", async () => {
        const { prisma, discoveryLogger } = setupDiscoverWeeklyMocks();
        (prisma.userDiscoverConfig.findUnique as jest.Mock).mockResolvedValueOnce({
            userId: "user-no-recs",
            enabled: true,
            downloadRatio: 1.3,
            playlistSize: 3,
        });
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([{ name: "Seed Artist", mbid: "seed-1" }]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "prefetchSimilarArtists").mockResolvedValue(
            new Map([["seed-1", [{ name: "Sim Artist", mbid: "sim-1", match: 0.7 }]]])
        );
        jest.spyOn(
            discoverWeeklyService as any,
            "findRecommendedAlbumsMultiStrategy"
        ).mockResolvedValue([]);

        await expect(discoverWeeklyService.generatePlaylist("user-no-recs")).rejects.toThrow(
            "No recommendations found"
        );
        expect(discoveryLogger.end).toHaveBeenCalledWith(
            false,
            "No recommendations found"
        );
    });

    it("warns on low recommendation threshold and skips duplicate queued download jobs", async () => {
        const { prisma, tx, discoveryBatchLogger } = setupDiscoverWeeklyMocks();
        (prisma.userDiscoverConfig.findUnique as jest.Mock).mockResolvedValueOnce({
            userId: "user-threshold",
            enabled: true,
            downloadRatio: 1.1,
            playlistSize: 3,
        });
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValue([{ name: "Seed Artist", mbid: "seed-1" }]);
        (tx.downloadJob.findFirst as jest.Mock).mockResolvedValue({
            id: "existing-pending-job",
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValue([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const completionSpy = jest
            .spyOn(discoverWeeklyService, "checkBatchCompletion")
            .mockResolvedValue(undefined);
        jest.spyOn(discoverWeeklyService as any, "prefetchSimilarArtists").mockResolvedValue(
            new Map([["seed-1", [{ name: "Sim Artist", mbid: "sim-1", match: 0.55 }]]])
        );
        jest.spyOn(
            discoverWeeklyService as any,
            "findRecommendedAlbumsMultiStrategy"
        ).mockResolvedValue([
            {
                artistName: "Artist Duplicate",
                artistMbid: "artist-dup",
                albumTitle: "Album Duplicate",
                albumMbid: "rg-duplicate",
                similarity: 0.55,
                tier: "medium",
            },
        ]);

        await expect(
            discoverWeeklyService.generatePlaylist("user-threshold")
        ).resolves.toEqual(
            expect.objectContaining({
                success: true,
            })
        );

        expect(discoveryBatchLogger.warn).toHaveBeenCalledWith(
            "threshold-check",
            expect.stringContaining("Low recommendations")
        );
        expect(tx.downloadJob.create).not.toHaveBeenCalled();
        expect(completionSpy).toHaveBeenCalledWith("batch-created");
    });

    it("counts all-settled acquisition promise rejections as failed downloads", async () => {
        const { prisma, acquisitionService, discoveryBatchLogger } =
            setupDiscoverWeeklyMocks();
        (prisma.userDiscoverConfig.findUnique as jest.Mock).mockResolvedValueOnce({
            userId: "user-settled-failure",
            enabled: true,
            downloadRatio: 1.3,
            playlistSize: 2,
        });
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValue([{ name: "Seed Artist", mbid: "seed-1" }]);
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-reject",
                metadata: {
                    artistName: "Reject Artist",
                    albumTitle: "Reject Album",
                    albumMbid: "rg-reject",
                },
            },
            {
                id: "job-success",
                metadata: {
                    artistName: "Success Artist",
                    albumTitle: "Success Album",
                    albumMbid: "rg-success",
                },
            },
        ]);
        (acquisitionService.acquireAlbum as jest.Mock)
            .mockRejectedValueOnce(new Error("acquisition crashed"))
            .mockResolvedValueOnce({
                success: true,
                source: "soulseek",
                correlationId: "corr-ok",
            });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const completionSpy = jest
            .spyOn(discoverWeeklyService, "checkBatchCompletion")
            .mockResolvedValue(undefined);
        jest.spyOn(discoverWeeklyService as any, "prefetchSimilarArtists").mockResolvedValue(
            new Map([["seed-1", []]])
        );
        jest.spyOn(
            discoverWeeklyService as any,
            "findRecommendedAlbumsMultiStrategy"
        ).mockResolvedValue([
            {
                artistName: "Reject Artist",
                artistMbid: "artist-reject",
                albumTitle: "Reject Album",
                albumMbid: "rg-reject",
                similarity: 0.8,
                tier: "high",
            },
            {
                artistName: "Success Artist",
                artistMbid: "artist-success",
                albumTitle: "Success Album",
                albumMbid: "rg-success",
                similarity: 0.75,
                tier: "high",
            },
        ]);

        await discoverWeeklyService.generatePlaylist("user-settled-failure");

        expect(discoveryBatchLogger.info).toHaveBeenCalledWith(
            "batch-created",
            expect.stringContaining("downloads started")
        );
        expect(completionSpy).toHaveBeenCalledWith("batch-created");
    });

    it("retries similar-artist prefetch calls with backoff and batches seed requests", async () => {
        jest.useFakeTimers();
        const { lastFmService } = setupDiscoverWeeklyMocks();
        (lastFmService.getSimilarArtists as jest.Mock)
            .mockRejectedValueOnce({
                response: { status: 429 },
                message: "rate limited",
            })
            .mockResolvedValueOnce([{ name: "Retry Artist", mbid: "retry-1", match: 0.7 }])
            .mockResolvedValueOnce([{ name: "Artist 2", mbid: "a2", match: 0.6 }])
            .mockResolvedValueOnce([{ name: "Artist 3", mbid: "a3", match: 0.5 }])
            .mockResolvedValueOnce([{ name: "Artist 4", mbid: "a4", match: 0.4 }]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const prefetchPromise = (discoverWeeklyService as any).prefetchSimilarArtists([
            { name: "Seed 1", mbid: "seed-1" },
            { name: "Seed 2", mbid: "seed-2" },
            { name: "Seed 3", mbid: "seed-3" },
            { name: "Seed 4", mbid: "seed-4" },
        ]);

        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(5_000);
        const cache = await prefetchPromise;

        expect(lastFmService.getSimilarArtists).toHaveBeenCalledTimes(5);
        expect(cache.size).toBe(4);
        expect(Array.from(cache.values()).flat()).toEqual(
            expect.arrayContaining([expect.objectContaining({ name: "Retry Artist" })])
        );
    });

    it("builds playlist tracks via normalized artist+album fallback when direct lookups miss", async () => {
        const { prisma, tx } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-normalized",
            userId: "user-1",
            targetSongCount: 1,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-normalized",
                status: "completed",
                targetMbid: "rg-normalized",
                metadata: {
                    artistName: "Beyonce",
                    albumTitle: "Renaissance Deluxe",
                    albumMbid: "rg-normalized",
                    similarity: 0.82,
                    tier: "high",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([]) // MBID lookup miss
            .mockResolvedValueOnce([]) // Name lookup miss
            .mockResolvedValueOnce([]) // Library anchor seed lookup
            .mockResolvedValueOnce([]); // Popular anchor lookup
        (prisma.album.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "album-normalized",
                title: "Renaissancé (Deluxe)",
                rgMbid: "rg-normalized",
                artist: { name: "Beyoncé", mbid: "artist-beyonce" },
                tracks: [
                    {
                        id: "track-normalized-1",
                        title: "Alien Superstar",
                        filePath:
                            "/music/Beyonce/Renaissance Deluxe/01 - Alien Superstar.flac",
                    },
                ],
            },
        ]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "cleanupFailedArtists").mockResolvedValue(
            undefined
        );
        jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-normalized")
        ).resolves.toBeUndefined();

        expect(prisma.album.findMany).toHaveBeenCalledTimes(1);
        expect(tx.discoveryAlbum.upsert).toHaveBeenCalledTimes(1);
        expect(tx.discoveryTrack.create).toHaveBeenCalledTimes(1);
        expect(tx.discoveryBatch.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "batch-normalized" },
                data: expect.objectContaining({ status: "completed" }),
            })
        );
    });

    it("exposes discover-weekly proxy helper behavior and wildcard tier mapping", async () => {
        setupDiscoverWeeklyMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { __discoverWeeklyTestables } = require("../discoverWeekly");
        const rootMethod = jest.fn(async (value: string) => `root:${value}`);
        const nestedMethod = jest.fn(async (value: string) => `nested:${value}`);

        const proxied = __discoverWeeklyTestables.createPrismaRetryProxy(
            {
                ping: rootMethod,
                discoveryBatch: {
                    findMany: nestedMethod,
                    modelName: "DiscoveryBatch",
                },
                version: "1.0.0",
            } as any,
            "discoverProxy"
        );

        await expect(proxied.ping("ok")).resolves.toBe("root:ok");
        await expect(proxied.discoveryBatch.findMany("query")).resolves.toBe(
            "nested:query"
        );
        expect(proxied.version).toBe("1.0.0");
        expect(proxied.discoveryBatch.modelName).toBe("DiscoveryBatch");
        expect(__discoverWeeklyTestables.getTierFromSimilarity(0.1)).toBe(
            "wildcard"
        );
    });

    it("returns early when batch completion check is invoked for a missing batch id", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            discoverWeeklyService.checkBatchCompletion("batch-missing")
        ).resolves.toBeUndefined();
    });

    it("handles non-retryable similar-artist prefetch failures without retry loops", async () => {
        const { lastFmService } = setupDiscoverWeeklyMocks();
        (lastFmService.getSimilarArtists as jest.Mock).mockRejectedValueOnce({
            message: "forbidden",
            response: { status: 403 },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const cache = await (discoverWeeklyService as any).prefetchSimilarArtists([
            { name: "Seed One", mbid: "seed-1" },
        ]);

        expect(lastFmService.getSimilarArtists).toHaveBeenCalledTimes(1);
        expect(cache.get("seed-1")).toEqual([]);
    });

    it("builds final playlist with seed-library anchors and popular-library fallback anchors", async () => {
        const { prisma, tx } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-anchor-fill",
            userId: "user-1",
            targetSongCount: 4,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-anchor-fill",
                status: "completed",
                targetMbid: "rg-discovery",
                metadata: {
                    artistName: "Discovery Artist",
                    albumTitle: "Discovery Album",
                    albumMbid: "rg-discovery",
                    similarity: 0.8,
                    tier: "high",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([
                {
                    id: "track-discovery",
                    filePath: "/music/discovery.flac",
                    album: {
                        id: "album-discovery",
                        title: "Discovery Album",
                        rgMbid: "rg-discovery",
                        artist: { name: "Discovery Artist", mbid: "artist-discovery" },
                    },
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: "track-seed-anchor",
                    filePath: "/music/seed-anchor.flac",
                    album: {
                        id: "album-seed-anchor",
                        title: "Seed Anchor Album",
                        rgMbid: "rg-seed-anchor",
                        artist: { name: "Seed Anchor Artist", mbid: "artist-seed-anchor" },
                        location: "LIBRARY",
                    },
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: "track-pop-anchor",
                    filePath: "/music/pop-anchor.flac",
                    album: {
                        id: "album-pop-anchor",
                        title: "Popular Anchor Album",
                        rgMbid: "rg-pop-anchor",
                        artist: { name: "Popular Anchor Artist", mbid: "artist-pop-anchor" },
                        location: "LIBRARY",
                    },
                },
            ]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([{ name: "Seed One", mbid: "seed-1" }]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "cleanupFailedArtists").mockResolvedValue(
            undefined
        );
        jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-anchor-fill")
        ).resolves.toBeUndefined();

        expect(prisma.track.findMany).toHaveBeenCalledTimes(2);
        expect(tx.discoveryTrack.create).toHaveBeenCalledTimes(2);
    });

    it("logs playlist build failure paths when playlist transaction fails after track selection", async () => {
        const { prisma, tx, discoveryBatchLogger } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-tx-fail",
            userId: "user-1",
            targetSongCount: 1,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-tx-fail",
                status: "completed",
                targetMbid: "rg-tx-fail",
                metadata: {
                    artistName: "Artist Fail",
                    albumTitle: "Album Fail",
                    albumMbid: "rg-tx-fail",
                    similarity: 0.8,
                    tier: "high",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([
                {
                    id: "track-tx-fail",
                    filePath: "/music/tx-fail.flac",
                    album: {
                        id: "album-tx-fail",
                        title: "Album Fail",
                        rgMbid: "rg-tx-fail",
                        artist: { name: "Artist Fail", mbid: "artist-fail" },
                    },
                },
            ]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValue([]);
        (prisma.$transaction as jest.Mock).mockRejectedValueOnce(
            new Error("transaction exploded")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "cleanupFailedArtists").mockResolvedValue(
            undefined
        );
        jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await discoverWeeklyService.buildFinalPlaylist("batch-tx-fail");

        expect(discoveryBatchLogger.error).toHaveBeenCalledWith(
            "batch-tx-fail",
            expect.stringContaining("Transaction failed")
        );
        expect(discoveryBatchLogger.error).toHaveBeenCalledWith(
            "batch-tx-fail",
            "Transaction failed - no records created"
        );
    });

    it("reconciles discovery-track edge paths for missing MBID, existing discovery rows, MBID hits, and no-library matches", async () => {
        const { prisma, tx } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "batch-reconcile-edges",
                userId: "user-1",
                weekStart: new Date("2026-02-16T00:00:00.000Z"),
                status: "completed",
                completedAt: new Date("2026-02-16T02:00:00.000Z"),
            },
        ]);
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-no-mbid",
                status: "completed",
                targetMbid: null,
                metadata: { artistName: "No MBID", albumTitle: "No MBID Album" },
            },
            {
                id: "job-existing-discovery",
                status: "completed",
                targetMbid: "rg-existing",
                metadata: {
                    artistName: "Existing Artist",
                    albumTitle: "Existing Album",
                    albumMbid: "rg-existing",
                },
            },
            {
                id: "job-found-by-mbid",
                status: "completed",
                targetMbid: "rg-found",
                metadata: {
                    artistName: "Found Artist",
                    albumTitle: "Found Album",
                    albumMbid: "rg-found",
                },
            },
            {
                id: "job-no-library-match",
                status: "completed",
                targetMbid: "rg-missing",
                metadata: {
                    artistName: "Missing Artist",
                    albumTitle: "Missing Album",
                    albumMbid: "rg-missing",
                },
            },
        ]);
        (prisma.discoveryAlbum.findFirst as jest.Mock)
            .mockResolvedValueOnce({ id: "existing-discovery-row" })
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([
                {
                    id: "track-found",
                    filePath: "/music/found.flac",
                    album: {
                        id: "album-found",
                        title: "Found Album",
                        rgMbid: "rg-found",
                        artist: { name: "Found Artist", mbid: "artist-found" },
                    },
                },
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        (tx.discoveryTrack.findFirst as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.reconcileDiscoveryTracks()).resolves.toEqual({
            batchesChecked: 1,
            tracksAdded: 1,
        });
    });

    it("checks owned-album-by-name through direct album hits and empty fallback sets", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.album.findFirst as jest.Mock)
            .mockResolvedValueOnce({ id: "album-hit" })
            .mockResolvedValueOnce(null);
        (prisma.ownedAlbum.findMany as jest.Mock).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).isAlbumOwnedByName(
                "Direct Artist",
                "Direct Album"
            )
        ).resolves.toBe(true);
        await expect(
            (discoverWeeklyService as any).isAlbumOwnedByName(
                "Missing Artist",
                "Missing Album"
            )
        ).resolves.toBe(false);
    });

    it("covers findValidAlbumForArtist early return and catch branches for ownership/exclusion checks", async () => {
        const { lastFmService, musicBrainzService } = setupDiscoverWeeklyMocks();
        const discoveryModule = require("../discovery");

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const ownedSpy = discoveryModule.discoverySeeding.isAlbumOwned as jest.Mock;
        const ownedByNameSpy = jest.spyOn(
            discoverWeeklyService as any,
            "isAlbumOwnedByName"
        );
        const excludedSpy = jest.spyOn(discoverWeeklyService as any, "isAlbumExcluded");

        (lastFmService.getArtistTopAlbums as jest.Mock)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ name: "Owned Throw Album" }])
            .mockResolvedValueOnce([{ name: "OwnedByName Throw Album" }])
            .mockResolvedValueOnce([{ name: "Excluded Throw Album" }])
            .mockRejectedValueOnce(new Error("lastfm unavailable"));
        (musicBrainzService.searchAlbum as jest.Mock)
            .mockResolvedValueOnce({ id: "rg-owned-throw" })
            .mockResolvedValueOnce({ id: "rg-owned-name-throw" })
            .mockResolvedValueOnce({ id: "rg-excluded-throw" });
        ownedSpy
            .mockRejectedValueOnce(new Error("owned lookup failed"))
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(false);
        ownedByNameSpy
            .mockResolvedValueOnce(false)
            .mockRejectedValueOnce(new Error("owned by name failed"))
            .mockResolvedValueOnce(false);
        excludedSpy.mockRejectedValueOnce(new Error("excluded lookup failed"));

        await expect(
            (discoverWeeklyService as any).findValidAlbumForArtist(
                { name: "No Albums Artist", mbid: "artist-empty" },
                "user-1",
                new Set<string>()
            )
        ).resolves.toEqual(
            expect.objectContaining({
                recommendation: null,
                albumsChecked: 0,
            })
        );
        await expect(
            (discoverWeeklyService as any).findValidAlbumForArtist(
                { name: "Owned Throw Artist", mbid: "artist-owned-throw" },
                "user-1",
                new Set<string>()
            )
        ).resolves.toEqual(expect.objectContaining({ recommendation: null }));
        await expect(
            (discoverWeeklyService as any).findValidAlbumForArtist(
                { name: "Owned Name Throw Artist", mbid: "artist-owned-name-throw" },
                "user-1",
                new Set<string>()
            )
        ).resolves.toEqual(expect.objectContaining({ recommendation: null }));
        await expect(
            (discoverWeeklyService as any).findValidAlbumForArtist(
                { name: "Excluded Throw Artist", mbid: "artist-excluded-throw" },
                "user-1",
                new Set<string>()
            )
        ).resolves.toEqual(expect.objectContaining({ recommendation: null }));
        await expect(
            (discoverWeeklyService as any).findValidAlbumForArtist(
                { name: "TopAlbums Throw Artist", mbid: "artist-lastfm-throw" },
                "user-1",
                new Set<string>()
            )
        ).resolves.toEqual(expect.objectContaining({ recommendation: null }));
    });

    it("returns empty genres when play-history lookup throws and swallows tag-exploration fetch errors", async () => {
        const { prisma, lastFmService } = setupDiscoverWeeklyMocks();
        (prisma.play.findMany as jest.Mock).mockRejectedValueOnce(
            new Error("play query failed")
        );
        (lastFmService.getTopAlbumsByTag as jest.Mock).mockRejectedValueOnce(
            new Error("tag lookup failed")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).getUserTopGenres("user-1")
        ).resolves.toEqual([]);
        jest.spyOn(discoverWeeklyService as any, "getUserTopGenres").mockResolvedValue([
            "ambient",
        ]);
        await expect(
            (discoverWeeklyService as any).tagExplorationStrategy(
                "user-1",
                1,
                new Set<string>()
            )
        ).resolves.toEqual([]);
    });

    it("uses name-based fallback track resolution during playlist build when MBID lookup misses", async () => {
        const { prisma, tx } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-name-fallback",
            userId: "user-1",
            targetSongCount: 1,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-name-fallback",
                status: "completed",
                targetMbid: "rg-name-fallback",
                metadata: {
                    artistName: "Name Artist",
                    albumTitle: "Name Album",
                    albumMbid: "rg-name-fallback",
                    similarity: 0.7,
                    tier: "medium",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([]) // MBID miss
            .mockResolvedValueOnce([
                {
                    id: "track-name-fallback",
                    filePath: "/music/name-fallback.flac",
                    album: {
                        id: "album-name-fallback",
                        title: "Name Album",
                        rgMbid: "rg-name-fallback",
                        artist: { name: "Name Artist", mbid: "artist-name-fallback" },
                    },
                },
            ])
            .mockResolvedValueOnce([]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValue([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "cleanupFailedArtists").mockResolvedValue(
            undefined
        );
        jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-name-fallback")
        ).resolves.toBeUndefined();

        expect(tx.discoveryTrack.create).toHaveBeenCalledTimes(1);
    });

    it("adds popular-library anchors when seed-artist anchors are insufficient", async () => {
        const { prisma, tx } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-popular-anchor",
            userId: "user-1",
            targetSongCount: 10,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce(
            Array.from({ length: 6 }, (_, index) => ({
                id: `job-popular-${index}`,
                status: "completed",
                targetMbid: `rg-popular-${index}`,
                metadata: {
                    artistName: `Discovery Artist ${index}`,
                    albumTitle: `Discovery Album ${index}`,
                    albumMbid: `rg-popular-${index}`,
                    similarity: 0.8,
                    tier: "high",
                },
            }))
        );
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query: any) => {
            if (query?.where?.album?.rgMbid) {
                const rgMbid = query.where.album.rgMbid;
                return [
                    {
                        id: `track-${rgMbid}`,
                        filePath: `/music/${rgMbid}.flac`,
                        album: {
                            id: `album-${rgMbid}`,
                            title: `Album ${rgMbid}`,
                            rgMbid,
                            artist: {
                                name: `Artist ${rgMbid}`,
                                mbid: `artist-${rgMbid}`,
                            },
                        },
                    },
                ];
            }

            if (query?.where?.album?.location === "LIBRARY" && !query?.orderBy) {
                return [
                    {
                        id: "track-seed-anchor-only",
                        filePath: "/music/seed-anchor-only.flac",
                        album: {
                            id: "album-seed-anchor-only",
                            title: "Seed Anchor Only",
                            rgMbid: "rg-seed-anchor-only",
                            artist: {
                                name: "Seed Anchor Artist",
                                mbid: "artist-seed-anchor-only",
                            },
                        },
                    },
                ];
            }

            if (query?.where?.album?.location === "LIBRARY" && query?.orderBy) {
                return [
                    {
                        id: "track-popular-anchor-only",
                        filePath: "/music/popular-anchor-only.flac",
                        album: {
                            id: "album-popular-anchor-only",
                            title: "Popular Anchor Only",
                            rgMbid: "rg-popular-anchor-only",
                            artist: {
                                name: "Popular Anchor Artist",
                                mbid: "artist-popular-anchor-only",
                            },
                        },
                    },
                ];
            }

            return [];
        });
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValue([{ name: "Seed One", mbid: "seed-1" }]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "cleanupFailedArtists").mockResolvedValue(
            undefined
        );
        jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-popular-anchor")
        ).resolves.toBeUndefined();

        expect(tx.discoveryTrack.create).toHaveBeenCalled();
        expect(prisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    album: expect.objectContaining({ location: "LIBRARY" }),
                }),
                orderBy: expect.any(Object),
            })
        );
    });

    it("logs zero-track playlist outcomes when no discovery or anchor tracks are available", async () => {
        const { prisma, discoveryBatchLogger } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-no-tracks",
            userId: "user-1",
            targetSongCount: 2,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValue([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "cleanupFailedArtists").mockResolvedValue(
            undefined
        );
        jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-no-tracks")
        ).resolves.toBeUndefined();

        expect(discoveryBatchLogger.error).toHaveBeenCalledWith(
            "batch-no-tracks",
            "No tracks found after scan"
        );
    });

    it("skips orphaned queue cleanup when Lidarr settings are incomplete", async () => {
        const { prisma, axiosMock } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-settings-missing",
            jobs: [{ id: "job-1", lidarrRef: "dl-1" }],
        });
        const settingsModule = require("../../utils/systemSettings");
        (settingsModule.getSystemSettings as jest.Mock).mockResolvedValueOnce({
            lidarrEnabled: false,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupOrphanedLidarrQueue(
                "batch-settings-missing"
            )
        ).resolves.toBeUndefined();

        expect(axiosMock.get).not.toHaveBeenCalled();
    });

    it("skips orphaned queue cleanup when no jobs have Lidarr download ids", async () => {
        const { prisma, axiosMock } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-no-lidarr-refs",
            jobs: [{ id: "job-1", lidarrRef: null }],
        });
        const settingsModule = require("../../utils/systemSettings");
        (settingsModule.getSystemSettings as jest.Mock).mockResolvedValueOnce({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr",
            lidarrApiKey: "token",
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupOrphanedLidarrQueue(
                "batch-no-lidarr-refs"
            )
        ).resolves.toBeUndefined();

        expect(axiosMock.get).not.toHaveBeenCalled();
    });

    it("handles orphaned queue cleanup when queue fetch fails or contains no removable entries", async () => {
        const { prisma, axiosMock } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock)
            .mockResolvedValueOnce({
                id: "batch-queue-safe",
                jobs: [{ id: "job-1", lidarrRef: "dl-safe" }],
            })
            .mockResolvedValueOnce({
                id: "batch-queue-error",
                jobs: [{ id: "job-2", lidarrRef: "dl-error" }],
            });
        const settingsModule = require("../../utils/systemSettings");
        (settingsModule.getSystemSettings as jest.Mock)
            .mockResolvedValueOnce({
                lidarrEnabled: true,
                lidarrUrl: "http://lidarr",
                lidarrApiKey: "token",
            })
            .mockResolvedValueOnce({
                lidarrEnabled: true,
                lidarrUrl: "http://lidarr",
                lidarrApiKey: "token",
            });
        (axiosMock.get as jest.Mock)
            .mockResolvedValueOnce({
                data: {
                    records: [
                        {
                            id: 11,
                            title: "Safe Item",
                            downloadId: "dl-safe",
                            status: "queued",
                            trackedDownloadState: "importPending",
                        },
                    ],
                },
            })
            .mockRejectedValueOnce(new Error("queue request failed"));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupOrphanedLidarrQueue(
                "batch-queue-safe"
            )
        ).resolves.toBeUndefined();
        await expect(
            (discoverWeeklyService as any).cleanupOrphanedLidarrQueue(
                "batch-queue-error"
            )
        ).resolves.toBeUndefined();

        expect(axiosMock.delete).not.toHaveBeenCalled();
    });

    it("keeps artists with active albums from other weeks and logs delete failures during failed-artist cleanup", async () => {
        const { prisma, lidarrService, discoveryBatchLogger } =
            setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-cleanup-edges",
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
            jobs: [
                {
                    id: "job-failed",
                    status: "failed",
                    metadata: { artistMbid: "artist-active-other" },
                },
            ],
        });
        (lidarrService.getDiscoveryArtists as jest.Mock).mockResolvedValueOnce([
            {
                id: 21,
                artistName: "Active Other Artist",
                foreignArtistId: "artist-active-other",
            },
            {
                id: 22,
                artistName: "Delete Error Artist",
                foreignArtistId: "artist-delete-error",
            },
        ]);
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockImplementation(
            async (query: any) => {
                const where = query?.where || {};
                if (
                    where.artistMbid === "artist-active-other" &&
                    where.status === "ACTIVE"
                ) {
                    return { id: "active-other" };
                }
                return null;
            }
        );
        (lidarrService.deleteArtistById as jest.Mock).mockRejectedValueOnce(
            new Error("delete failed")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupFailedArtists(
                "batch-cleanup-edges"
            )
        ).resolves.toBeUndefined();

        expect(lidarrService.deleteArtistById).toHaveBeenCalledWith(22, true);
        expect(discoveryBatchLogger.info).toHaveBeenCalledWith(
            "batch-cleanup-edges",
            expect.stringContaining("failed artists removed")
        );
    });

    it("covers extra-album cleanup skip and error branches for Lidarr album removal", async () => {
        const { prisma, lidarrService } = setupDiscoverWeeklyMocks();
        (lidarrService.deleteAlbum as jest.Mock)
            .mockResolvedValueOnce({
                success: false,
                message: "still importing",
            })
            .mockRejectedValueOnce(new Error("delete album failed"));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupExtraAlbums(
                [
                    {
                        id: "job-skip",
                        targetMbid: "rg-skip",
                        lidarrAlbumId: 501,
                        metadata: {
                            artistMbid: "artist-skip",
                            artistName: "Skip Artist",
                            albumTitle: "Skip Album",
                        },
                    },
                    {
                        id: "job-no-lidarr-id",
                        targetMbid: "rg-no-id",
                        metadata: {
                            artistMbid: "artist-no-id",
                            artistName: "No Id Artist",
                            albumTitle: "No Id Album",
                        },
                    },
                    {
                        id: "job-error",
                        targetMbid: "rg-error",
                        lidarrAlbumId: 502,
                        metadata: {
                            artistMbid: "artist-error",
                            artistName: "Error Artist",
                            albumTitle: "Error Album",
                        },
                    },
                ],
                "user-1"
            )
        ).resolves.toBeUndefined();

        expect(prisma.downloadJob.update).toHaveBeenCalledTimes(2);
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: "job-skip" } })
        );
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: "job-no-lidarr-id" } })
        );
    });

    it("logs reconciliation errors when discovery record transactions fail", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "batch-reconcile-error",
                userId: "user-1",
                weekStart: new Date("2026-02-16T00:00:00.000Z"),
                status: "completed",
                completedAt: new Date("2026-02-16T02:00:00.000Z"),
            },
        ]);
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-reconcile-error",
                status: "completed",
                targetMbid: "rg-reconcile-error",
                metadata: {
                    artistName: "Error Artist",
                    albumTitle: "Error Album",
                    albumMbid: "rg-reconcile-error",
                    similarity: 0.6,
                    tier: "medium",
                },
            },
        ]);
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.track.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "track-reconcile-error",
                filePath: "/music/error.flac",
                album: {
                    id: "album-reconcile-error",
                    title: "Error Album",
                    rgMbid: "rg-reconcile-error",
                    artist: { name: "Error Artist", mbid: "artist-error" },
                },
            },
        ]);
        (prisma.$transaction as jest.Mock).mockRejectedValueOnce(
            new Error("transaction create failed")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.reconcileDiscoveryTracks()).resolves.toEqual({
            batchesChecked: 1,
            tracksAdded: 0,
        });
    });

    it("skips duplicate attempted artists in replacement search and handles tier-3 anchor lookup errors", async () => {
        const { prisma, lastFmService } = setupDiscoverWeeklyMocks();
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-existing-artist",
                targetMbid: "rg-existing",
                metadata: { artistMbid: "artist-duplicate" },
            },
        ]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([
            { name: "Seed Fail", mbid: "seed-fail" },
            { name: "Seed Skip", mbid: "seed-skip" },
        ]);
        (lastFmService.getSimilarArtists as jest.Mock)
            .mockRejectedValueOnce(new Error("similar fetch failed"))
            .mockResolvedValueOnce([
                {
                    name: "Duplicate Similar Artist",
                    mbid: "artist-duplicate",
                    match: 0.72,
                },
            ]);
        (prisma.album.findFirst as jest.Mock).mockRejectedValueOnce(
            new Error("anchor lookup failed")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            discoverWeeklyService.findReplacementAlbum(
                {
                    id: "failed-job",
                    metadata: {
                        artistName: "Failed Artist",
                        albumTitle: "Failed Album",
                        artistMbid: "artist-failed",
                    },
                },
                { id: "batch-replace-dup", userId: "user-1" }
            )
        ).resolves.toBeNull();
    });

    it("skips replacement candidates already in library and falls back to a seed-library anchor", async () => {
        const { prisma, lastFmService, musicBrainzService } =
            setupDiscoverWeeklyMocks();
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([{ name: "Seed Anchor", mbid: "seed-1" }]);
        (lastFmService.getSimilarArtists as jest.Mock).mockResolvedValueOnce([
            { name: "Library Artist", mbid: "artist-library", match: 0.81 },
        ]);
        (lastFmService.getArtistTopAlbums as jest.Mock).mockResolvedValueOnce([
            { name: "Library Album" },
        ]);
        (musicBrainzService.searchAlbum as jest.Mock).mockResolvedValueOnce({
            id: "rg-library",
        });
        (prisma.album.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "album-anchor",
            title: "Anchor Album",
            rgMbid: "rg-anchor",
            artist: { name: "Anchor Artist", mbid: "artist-anchor" },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "isArtistInLibrary").mockResolvedValue(
            true
        );
        jest.spyOn(discoverWeeklyService as any, "isAlbumExcluded").mockResolvedValue(
            false
        );

        await expect(
            discoverWeeklyService.findReplacementAlbum(
                {
                    id: "failed-job",
                    metadata: {
                        artistName: "Failed Artist",
                        albumTitle: "Failed Album",
                        artistMbid: "artist-failed",
                    },
                },
                { id: "batch-replace-library", userId: "user-1" }
            )
        ).resolves.toEqual(
            expect.objectContaining({
                artistName: "Anchor Artist",
                albumTitle: "Anchor Album",
                albumMbid: "rg-anchor",
                isLibraryAnchor: true,
            })
        );
    });

    it("continues replacement search when library, ownership, and exclusion checks throw", async () => {
        const { prisma, lastFmService, musicBrainzService } =
            setupDiscoverWeeklyMocks();
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([{ name: "Seed Error", mbid: "seed-1" }]);
        (lastFmService.getSimilarArtists as jest.Mock).mockResolvedValueOnce([
            { name: "Error Candidate", mbid: "artist-error", match: 0.67 },
        ]);
        (lastFmService.getArtistTopAlbums as jest.Mock).mockResolvedValueOnce([
            { name: "Error Album 1" },
            { name: "Error Album 2" },
        ]);
        (musicBrainzService.searchAlbum as jest.Mock)
            .mockResolvedValueOnce({ id: "rg-error-1" })
            .mockResolvedValueOnce({ id: "rg-error-2" });
        (
            discoveryModule.discoverySeeding.isAlbumOwned as jest.Mock
        )
            .mockRejectedValueOnce(new Error("owned check failed"))
            .mockResolvedValueOnce(false);
        (prisma.album.findFirst as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "isArtistInLibrary").mockRejectedValue(
            new Error("library check failed")
        );
        jest.spyOn(discoverWeeklyService as any, "isAlbumExcluded").mockRejectedValueOnce(
            new Error("excluded check failed")
        );

        await expect(
            discoverWeeklyService.findReplacementAlbum(
                {
                    id: "failed-job",
                    metadata: {
                        artistName: "Failed Artist",
                        albumTitle: "Failed Album",
                        artistMbid: "artist-failed",
                    },
                },
                { id: "batch-replace-error", userId: "user-1" }
            )
        ).resolves.toBeNull();
    });

    it("continues recommendation discovery when artist-library lookups throw", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "isArtistInLibrary").mockRejectedValue(
            new Error("library lookup failed")
        );
        jest
            .spyOn(discoverWeeklyService as any, "findValidAlbumForArtist")
            .mockResolvedValue({
                recommendation: {
                    artistName: "Recovered Artist",
                    artistMbid: "artist-recovered",
                    albumTitle: "Recovered Album",
                    albumMbid: "rg-recovered",
                    similarity: 0.7,
                },
                albumsChecked: 1,
                skippedNoMbid: 0,
                skippedOwned: 0,
                skippedExcluded: 0,
                skippedDuplicate: 0,
            });

        const recommendations = await (discoverWeeklyService as any).findRecommendedAlbums(
            [{ name: "Seed One", mbid: "seed-1" }],
            new Map([
                [
                    "seed-1",
                    [{ name: "Recovered Artist", mbid: "artist-recovered", match: 0.7 }],
                ],
            ]),
            1,
            "user-1"
        );

        expect(recommendations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ albumMbid: "rg-recovered" }),
            ])
        );
    });

    it("logs no-albums-returned warning when similar artists produce zero album checks", async () => {
        setupDiscoverWeeklyMocks();
        const loggerModule = require("../../utils/logger");
        const logger = loggerModule.logger as { debug: jest.Mock };

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "isArtistInLibrary").mockResolvedValue(
            false
        );
        jest
            .spyOn(discoverWeeklyService as any, "findValidAlbumForArtist")
            .mockResolvedValue({
                recommendation: null,
                albumsChecked: 0,
                skippedNoMbid: 0,
                skippedOwned: 0,
                skippedExcluded: 0,
                skippedDuplicate: 0,
            });

        await expect(
            (discoverWeeklyService as any).findRecommendedAlbums(
                [{ name: "Seed One", mbid: "seed-1" }],
                new Map([
                    [
                        "seed-1",
                        [{ name: "No Albums Artist", mbid: "artist-no-albums", match: 0.6 }],
                    ],
                ]),
                1,
                "user-1"
            )
        ).resolves.toEqual([]);

        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("No albums returned from Last.fm")
        );
    });

    it("logs all-musicbrainz-failed warning when every checked album lacks a resolvable MBID", async () => {
        setupDiscoverWeeklyMocks();
        const loggerModule = require("../../utils/logger");
        const logger = loggerModule.logger as { debug: jest.Mock };

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "isArtistInLibrary").mockResolvedValue(
            false
        );
        jest
            .spyOn(discoverWeeklyService as any, "findValidAlbumForArtist")
            .mockResolvedValue({
                recommendation: null,
                albumsChecked: 2,
                skippedNoMbid: 2,
                skippedOwned: 0,
                skippedExcluded: 0,
                skippedDuplicate: 0,
            });

        await expect(
            (discoverWeeklyService as any).findRecommendedAlbums(
                [{ name: "Seed One", mbid: "seed-1" }],
                new Map([
                    [
                        "seed-1",
                        [{ name: "No MBID Artist", mbid: "artist-no-mbid", match: 0.6 }],
                    ],
                ]),
                1,
                "user-1"
            )
        ).resolves.toEqual([]);

        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("All albums failed MusicBrainz lookup")
        );
    });

    it("logs all-owned warning when every checked album is already owned", async () => {
        setupDiscoverWeeklyMocks();
        const loggerModule = require("../../utils/logger");
        const logger = loggerModule.logger as { debug: jest.Mock };

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "isArtistInLibrary").mockResolvedValue(
            false
        );
        jest
            .spyOn(discoverWeeklyService as any, "findValidAlbumForArtist")
            .mockResolvedValue({
                recommendation: null,
                albumsChecked: 2,
                skippedNoMbid: 0,
                skippedOwned: 2,
                skippedExcluded: 0,
                skippedDuplicate: 0,
            });

        await expect(
            (discoverWeeklyService as any).findRecommendedAlbums(
                [{ name: "Seed One", mbid: "seed-1" }],
                new Map([
                    [
                        "seed-1",
                        [{ name: "Owned Artist", mbid: "artist-owned", match: 0.6 }],
                    ],
                ]),
                1,
                "user-1"
            )
        ).resolves.toEqual([]);

        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("All albums already owned")
        );
    });

    it("counts owned-by-name matches as owned skips in findValidAlbumForArtist", async () => {
        const { lastFmService, musicBrainzService } = setupDiscoverWeeklyMocks();
        (lastFmService.getArtistTopAlbums as jest.Mock).mockResolvedValueOnce([
            { name: "Owned By Name Album" },
        ]);
        (musicBrainzService.searchAlbum as jest.Mock).mockResolvedValueOnce({
            id: "rg-owned-by-name",
        });
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.isAlbumOwned as jest.Mock
        ).mockResolvedValueOnce(false);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "isAlbumOwnedByName").mockResolvedValue(
            true
        );
        jest.spyOn(discoverWeeklyService as any, "isAlbumExcluded").mockResolvedValue(
            false
        );

        await expect(
            (discoverWeeklyService as any).findValidAlbumForArtist(
                { name: "Owned By Name Artist", mbid: "artist-owned-by-name" },
                "user-1",
                new Set<string>()
            )
        ).resolves.toEqual(
            expect.objectContaining({
                recommendation: null,
                skippedOwned: 1,
            })
        );
    });

    it("evaluates retryable prisma classifier edges for empty unknown errors and non-error inputs", () => {
        setupDiscoverWeeklyMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { __discoverWeeklyTestables } = require("../discoverWeekly");

        expect(
            __discoverWeeklyTestables.isRetryableDiscoverWeeklyPrismaError(
                new Prisma.PrismaClientUnknownRequestError(
                    "Engine has already exited"
                )
            )
        ).toBe(true);
        expect(
            __discoverWeeklyTestables.isRetryableDiscoverWeeklyPrismaError(
                new Prisma.PrismaClientUnknownRequestError("")
            )
        ).toBe(false);
        expect(
            __discoverWeeklyTestables.isRetryableDiscoverWeeklyPrismaError(
                undefined
            )
        ).toBe(false);
    });

    it("uses default generation fallbacks for ratios, missing seed mbids, NaN similarities, and non-soulseek acquisitions", async () => {
        const { prisma, acquisitionService } = setupDiscoverWeeklyMocks();
        (prisma.userDiscoverConfig.findUnique as jest.Mock).mockResolvedValueOnce({
            userId: "user-fallbacks",
            enabled: true,
            playlistSize: 1,
            downloadRatio: null,
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-fallback-1",
                metadata: {
                    artistName: "Fallback Artist",
                    albumTitle: "Fallback Album",
                    albumMbid: "rg-fallback",
                },
            },
        ]);
        (acquisitionService.acquireAlbum as jest.Mock).mockResolvedValueOnce({
            success: true,
            source: "lidarr",
            correlationId: undefined,
        });
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([{ name: "Seed Without MBID" }]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "prefetchSimilarArtists").mockResolvedValue(
            new Map([["external-key", []]])
        );
        jest.spyOn(
            discoverWeeklyService as any,
            "findRecommendedAlbumsMultiStrategy"
        ).mockResolvedValue([
            {
                artistName: "Fallback Artist",
                artistMbid: "artist-fallback",
                albumTitle: "Fallback Album",
                albumMbid: "rg-fallback",
                similarity: Number.NaN,
            },
        ]);

        await expect(
            discoverWeeklyService.generatePlaylist("user-fallbacks")
        ).resolves.toEqual(expect.objectContaining({ success: true }));

        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-fallback-1" },
                data: expect.objectContaining({
                    status: "processing",
                    lidarrRef: null,
                    completedAt: null,
                }),
            })
        );
    });

    it("uses empty-string mbid fallback for similar-artist prefetch cache keys", async () => {
        const { lastFmService } = setupDiscoverWeeklyMocks();
        (lastFmService.getSimilarArtists as jest.Mock).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const cache = await (discoverWeeklyService as any).prefetchSimilarArtists([
            { name: "Seed Name Only" },
        ]);

        expect(lastFmService.getSimilarArtists).toHaveBeenCalledWith(
            "",
            "Seed Name Only",
            20
        );
        expect(cache.has("Seed Name Only")).toBe(true);
    });

    it("forces timeout completion checks for batches with no completed jobs", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "batch-no-completions",
                status: "downloading",
                createdAt: new Date(Date.now() - 61 * 60 * 1000),
                jobs: [{ id: "job-1", status: "pending" }],
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const completionSpy = jest
            .spyOn(discoverWeeklyService, "checkBatchCompletion")
            .mockResolvedValue(undefined);

        await expect(discoverWeeklyService.checkStuckBatches()).resolves.toBe(1);
        expect(completionSpy).toHaveBeenCalledWith("batch-no-completions");
    });

    it("writes unknown fallbacks for failed-job metadata during completion checks", async () => {
        jest.useFakeTimers();
        const { prisma, tx } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-unknown-meta",
            userId: "user-1",
            status: "downloading",
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
            jobs: [
                {
                    id: "job-unknown",
                    status: "failed",
                    metadata: {},
                    targetMbid: "rg-unknown",
                },
            ],
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const completionPromise =
            discoverWeeklyService.checkBatchCompletion("batch-unknown-meta");
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(60_000);
        await completionPromise;

        expect(tx.unavailableAlbum.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                create: expect.objectContaining({
                    artistName: "Unknown",
                    albumTitle: "Unknown",
                    similarity: 0.5,
                    tier: "medium",
                }),
            })
        );
    });

    it("uses name-only search criteria fallbacks and empty file-name fallback in final playlist assembly", async () => {
        const { prisma, tx } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-name-only",
            userId: "user-1",
            targetSongCount: 1,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-missing-meta",
                status: "completed",
                metadata: {},
                targetMbid: "rg-unused",
            },
            {
                id: "job-name-only",
                status: "completed",
                metadata: {
                    artistName: "Name Artist",
                    albumTitle: "Name Album",
                },
                targetMbid: null,
            },
        ]);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([
                {
                    id: "track-name-only",
                    filePath: "",
                    album: {
                        id: "album-name-only",
                        title: "Name Album",
                        rgMbid: "rg-name-only",
                        artist: { name: "Name Artist", mbid: "artist-name-only" },
                    },
                },
            ])
            .mockResolvedValueOnce([]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([{ name: "Seed No MBID" }]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "cleanupFailedArtists").mockResolvedValue(
            undefined
        );
        jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-name-only")
        ).resolves.toBeUndefined();

        expect(tx.discoveryTrack.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    fileName: "",
                }),
            })
        );
    });

    it("handles missing batches and empty queue payloads in orphaned Lidarr queue cleanup", async () => {
        const { prisma, axiosMock } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "batch-empty-queue",
                jobs: [{ id: "job-1", lidarrRef: "dl-1" }],
            });
        const settingsModule = require("../../utils/systemSettings");
        (settingsModule.getSystemSettings as jest.Mock).mockResolvedValueOnce({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr",
            lidarrApiKey: "token",
        });
        (axiosMock.get as jest.Mock).mockResolvedValueOnce({ data: {} });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupOrphanedLidarrQueue(
                "batch-missing"
            )
        ).resolves.toBeUndefined();
        await expect(
            (discoverWeeklyService as any).cleanupOrphanedLidarrQueue(
                "batch-empty-queue"
            )
        ).resolves.toBeUndefined();

        expect(axiosMock.delete).not.toHaveBeenCalled();
    });

    it("handles missing batches and missing Lidarr artist MBIDs in failed-artist cleanup", async () => {
        const { prisma, lidarrService } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "batch-no-mbid-artists",
                weekStart: new Date("2026-02-16T00:00:00.000Z"),
                jobs: [],
            });
        (lidarrService.getDiscoveryArtists as jest.Mock).mockResolvedValueOnce([
            {
                id: 1,
                artistName: "No MBID Artist",
                foreignArtistId: null,
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupFailedArtists("batch-missing")
        ).resolves.toBeUndefined();
        await expect(
            (discoverWeeklyService as any).cleanupFailedArtists(
                "batch-no-mbid-artists"
            )
        ).resolves.toBeUndefined();

        expect(lidarrService.deleteArtistById).not.toHaveBeenCalled();
    });

    it("uses unknown title and artist fallbacks when extra-album metadata is absent", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");

        await expect(
            (discoverWeeklyService as any).cleanupExtraAlbums(
                [{ id: "job-unknown-meta", targetMbid: "rg-unknown" }],
                "user-1"
            )
        ).resolves.toBeUndefined();

        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-unknown-meta" },
                data: expect.objectContaining({
                    status: "cancelled",
                }),
            })
        );
    });

    it("matches owned albums when normalized requested titles include normalized owned titles", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.album.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.ownedAlbum.findMany as jest.Mock).mockResolvedValueOnce([
            { rgMbid: "rg-owned-short" },
        ]);
        (prisma.album.findMany as jest.Mock).mockResolvedValueOnce([
            { title: "Short Title" },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).isAlbumOwnedByName(
                "Artist",
                "Short Title Deluxe Edition"
            )
        ).resolves.toBe(true);
    });

    it("skips invalid replacement candidates and falls back to default replacement similarity when match is absent", async () => {
        const { prisma, lastFmService, musicBrainzService } =
            setupDiscoverWeeklyMocks();
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([
            { name: "Seed Without MBID" },
            { name: "Seed With MBID", mbid: "seed-1" },
        ]);
        (lastFmService.getSimilarArtists as jest.Mock).mockResolvedValueOnce([
            { name: "No MBID Candidate", mbid: null, match: 0.8 },
            { name: "Failed Artist Duplicate", mbid: "artist-failed", match: 0.8 },
            { name: "Candidate Artist", mbid: "artist-candidate" },
        ]);
        (lastFmService.getArtistTopAlbums as jest.Mock).mockResolvedValueOnce([
            { name: "Owned Candidate Album" },
            { name: "Excluded Candidate Album" },
            { name: "Valid Candidate Album" },
        ]);
        (musicBrainzService.searchAlbum as jest.Mock)
            .mockResolvedValueOnce({ id: "rg-owned-candidate" })
            .mockResolvedValueOnce({ id: "rg-excluded-candidate" })
            .mockResolvedValueOnce({ id: "rg-valid-candidate" });
        (
            discoveryModule.discoverySeeding.isAlbumOwned as jest.Mock
        ).mockImplementation(async (rgMbid: string) => rgMbid === "rg-owned-candidate");

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "isArtistInLibrary").mockResolvedValue(
            false
        );
        jest.spyOn(discoverWeeklyService as any, "isAlbumExcluded").mockImplementation(async (...args: unknown[]) => {
            const rgMbid = args[0] as string;
            return rgMbid === "rg-excluded-candidate";
        });

        await expect(
            discoverWeeklyService.findReplacementAlbum(
                {
                    id: "failed-job",
                    metadata: {
                        artistName: "Failed Artist",
                        albumTitle: "Failed Album",
                        artistMbid: "artist-failed",
                    },
                },
                { id: "batch-replacement", userId: "user-1" }
            )
        ).resolves.toEqual(
            expect.objectContaining({
                artistName: "Candidate Artist",
                albumTitle: "Valid Candidate Album",
                albumMbid: "rg-valid-candidate",
                similarity: 0.5,
            })
        );
    });

    it("uses seed-name cache fallback and exercises recommendation loop break/continue branches", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "isArtistInLibrary").mockResolvedValue(
            false
        );
        jest
            .spyOn(discoverWeeklyService as any, "findValidAlbumForArtist")
            .mockImplementation(async (artist: any) => {
                if (artist.name === "Artist One") {
                    return {
                        recommendation: {
                            artistName: "Artist One",
                            artistMbid: "artist-one",
                            albumTitle: "Artist One Album",
                            albumMbid: "rg-artist-one",
                            similarity: 0.75,
                        },
                        albumsChecked: 1,
                        skippedNoMbid: 0,
                        skippedOwned: 0,
                        skippedExcluded: 0,
                        skippedDuplicate: 0,
                    };
                }

                if (artist.name === "Artist Two") {
                    return {
                        recommendation: {
                            artistName: "Artist Two",
                            artistMbid: "artist-two",
                            albumTitle: "Artist Two Album",
                            albumMbid: "rg-artist-two",
                            similarity: 0.7,
                        },
                        albumsChecked: 1,
                        skippedNoMbid: 0,
                        skippedOwned: 0,
                        skippedExcluded: 0,
                        skippedDuplicate: 0,
                    };
                }

                return {
                    recommendation: null,
                    albumsChecked: 0,
                    skippedNoMbid: 0,
                    skippedOwned: 0,
                    skippedExcluded: 0,
                    skippedDuplicate: 0,
                };
            });

        const recommendations = await (discoverWeeklyService as any).findRecommendedAlbums(
            [{ name: "Seed Name Only" }, { name: "Seed Missing" }],
            new Map([
                [
                    "Seed Name Only",
                    [
                        { name: "Artist One", mbid: "artist-one", match: 0.8 },
                        { name: "Artist One", mbid: "artist-one-dup", match: 0.8 },
                        { name: "Artist Two", mbid: "artist-two", match: 0.75 },
                        { name: "Artist Three", mbid: "artist-three", match: 0.74 },
                    ],
                ],
            ]),
            2,
            "user-1"
        );

        expect(recommendations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ albumMbid: "rg-artist-one" }),
                expect.objectContaining({ albumMbid: "rg-artist-two" }),
            ])
        );
    });

    it("uses pass-two fallback break behavior once target recommendations are reached", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest
            .spyOn(discoverWeeklyService as any, "isArtistInLibrary")
            .mockResolvedValue(true);
        jest
            .spyOn(discoverWeeklyService as any, "findValidAlbumForArtist")
            .mockImplementation(async (artist: any) => {
                if (artist.name === "Existing One") {
                    return {
                        recommendation: {
                            artistName: "Existing One",
                            artistMbid: "existing-one",
                            albumTitle: "Existing One Album",
                            albumMbid: "rg-existing-one",
                            similarity: 0.65,
                        },
                        albumsChecked: 1,
                        skippedNoMbid: 0,
                        skippedOwned: 0,
                        skippedExcluded: 0,
                        skippedDuplicate: 0,
                    };
                }
                return {
                    recommendation: null,
                    albumsChecked: 0,
                    skippedNoMbid: 0,
                    skippedOwned: 0,
                    skippedExcluded: 0,
                    skippedDuplicate: 0,
                };
            });

        const recommendations = await (discoverWeeklyService as any).findRecommendedAlbums(
            [{ name: "Seed One", mbid: "seed-1" }],
            new Map([
                [
                    "seed-1",
                    [
                        { name: "Existing One", mbid: "existing-one", match: 0.7 },
                        { name: "Existing Two", mbid: "existing-two", match: 0.68 },
                    ],
                ],
            ]),
            1,
            "user-1"
        );

        expect(recommendations).toHaveLength(1);
        expect(recommendations[0]).toEqual(
            expect.objectContaining({ albumMbid: "rg-existing-one" })
        );
    });

    it("uses blank artist mbids and default recommendation similarity in valid-album discovery", async () => {
        const { lastFmService, musicBrainzService } = setupDiscoverWeeklyMocks();
        (lastFmService.getArtistTopAlbums as jest.Mock).mockResolvedValueOnce([
            { name: "Fresh Album" },
        ]);
        (musicBrainzService.searchAlbum as jest.Mock).mockResolvedValueOnce({
            id: "rg-fresh-album",
        });
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.isAlbumOwned as jest.Mock
        ).mockResolvedValueOnce(false);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "isAlbumOwnedByName").mockResolvedValue(
            false
        );
        jest.spyOn(discoverWeeklyService as any, "isAlbumExcluded").mockResolvedValue(
            false
        );

        await expect(
            (discoverWeeklyService as any).findValidAlbumForArtist(
                { name: "No MBID Artist" },
                "user-1",
                new Set<string>()
            )
        ).resolves.toEqual(
            expect.objectContaining({
                recommendation: expect.objectContaining({
                    albumMbid: "rg-fresh-album",
                    similarity: 0.5,
                }),
            })
        );
        expect(lastFmService.getArtistTopAlbums).toHaveBeenCalledWith(
            "",
            "No MBID Artist",
            10
        );
    });

    it("handles missing artist nodes and non-array user genres in top-genre aggregation", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.play.findMany as jest.Mock).mockResolvedValueOnce([
            {
                track: null,
            },
            {
                track: {
                    album: {
                        artist: {
                            genres: undefined,
                            userGenres: "not-an-array",
                        },
                    },
                },
            },
            {
                track: {
                    album: {
                        artist: {
                            genres: ["Rock"],
                            userGenres: [],
                        },
                    },
                },
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).getUserTopGenres("user-1")
        ).resolves.toEqual(expect.arrayContaining(["rock"]));
    });

    it("skips invalid tag-exploration candidates before returning the first eligible wildcard", async () => {
        const { lastFmService, musicBrainzService } = setupDiscoverWeeklyMocks();
        (lastFmService.getTopAlbumsByTag as jest.Mock).mockResolvedValueOnce([
            { name: "Seen Album", artist: "String Artist" },
            { name: null, artist: { name: "Missing Name Artist" } },
            { name: "Owned Album", artist: { name: "Owned Artist" } },
            { name: "Owned By Name Album", artist: { name: "Owned Name Artist" } },
            { name: "Excluded Album", artist: { name: "Excluded Artist" } },
            { name: "Library Album", artist: { name: "Library Artist" } },
            { name: "Keep Album", artist: { name: "Keep Artist" } },
            { name: "Post Keep Album", artist: { name: "Post Keep Artist" } },
        ]);
        (musicBrainzService.searchAlbum as jest.Mock)
            .mockResolvedValueOnce({ id: "rg-seen" })
            .mockResolvedValueOnce({ id: "rg-owned" })
            .mockResolvedValueOnce({ id: "rg-owned-name" })
            .mockResolvedValueOnce({ id: "rg-excluded" })
            .mockResolvedValueOnce({ id: "rg-library" })
            .mockResolvedValueOnce({ id: "rg-keep" });
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.isAlbumOwned as jest.Mock
        ).mockImplementation(async (rgMbid: string) => rgMbid === "rg-owned");

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "getUserTopGenres").mockResolvedValue(
            ["rock"]
        );
        jest.spyOn(discoverWeeklyService as any, "isAlbumOwnedByName").mockImplementation(async (...args: unknown[]) => {
            const album = args[1] as string;
            return album === "Owned By Name Album";
        });
        jest.spyOn(discoverWeeklyService as any, "isAlbumExcluded").mockImplementation(async (...args: unknown[]) => {
            const rgMbid = args[0] as string;
            return rgMbid === "rg-excluded";
        });
        jest.spyOn(discoverWeeklyService as any, "isArtistInLibrary").mockImplementation(async (...args: unknown[]) => {
            const artistName = args[0] as string;
            return artistName === "Library Artist";
        });

        const recommendations = await (discoverWeeklyService as any).tagExplorationStrategy(
            "user-1",
            1,
            new Set<string>(["rg-seen"])
        );

        expect(recommendations).toEqual([
            expect.objectContaining({
                artistName: "Keep Artist",
                albumTitle: "Keep Album",
                albumMbid: "rg-keep",
            }),
        ]);
    });

    it("skips normalized fallback album matching when MBID track lookups already return tracks", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-mbid-direct",
            userId: "user-1",
            targetSongCount: 1,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-mbid-direct",
                status: "completed",
                targetMbid: "rg-mbid-direct",
                metadata: {
                    artistName: "Direct Artist",
                    albumTitle: "Direct Album",
                    albumMbid: "rg-mbid-direct",
                    similarity: 0.8,
                    tier: "high",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([
                {
                    id: "track-mbid-a",
                    filePath: "/music/direct-a.flac",
                    album: {
                        id: "album-direct",
                        title: "Direct Album",
                        rgMbid: "rg-mbid-direct",
                        artist: { name: "Direct Artist", mbid: "artist-direct" },
                    },
                },
                {
                    id: "track-mbid-b",
                    filePath: "/music/direct-b.flac",
                    album: {
                        id: "album-direct",
                        title: "Direct Album",
                        rgMbid: "rg-mbid-direct",
                        artist: { name: "Direct Artist", mbid: "artist-direct" },
                    },
                },
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([{ name: "Seed One", mbid: "seed-1" }]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "cleanupFailedArtists").mockResolvedValue(
            undefined
        );
        jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-mbid-direct")
        ).resolves.toBeUndefined();

        expect(prisma.album.findMany).not.toHaveBeenCalled();
    });

    it("reconciles without mbid lookups when completed jobs only provide album names", async () => {
        const { prisma, tx } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "batch-reconcile-name-only",
                userId: "user-1",
                weekStart: new Date("2026-02-16T00:00:00.000Z"),
                status: "completed",
                completedAt: new Date("2026-02-16T02:00:00.000Z"),
            },
        ]);
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-name-only",
                status: "completed",
                targetMbid: null,
                metadata: {
                    artistName: "Name Only Artist",
                    albumTitle: "Name Only Album",
                },
            },
        ]);
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.track.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "track-name-only",
                filePath: "",
                album: {
                    id: "album-name-only",
                    title: "Name Only Album",
                    rgMbid: "rg-name-only",
                    artist: { name: "Name Only Artist", mbid: "artist-name-only" },
                },
            },
        ]);
        (tx.discoveryTrack.findFirst as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.reconcileDiscoveryTracks()).resolves.toEqual({
            batchesChecked: 1,
            tracksAdded: 0,
        });
    });

    it("skips creating duplicate discovery tracks during reconciliation when track links already exist", async () => {
        const { prisma, tx } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "batch-existing-track-link",
                userId: "user-1",
                weekStart: new Date("2026-02-16T00:00:00.000Z"),
                status: "completed",
                completedAt: new Date("2026-02-16T02:00:00.000Z"),
            },
        ]);
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-existing-track-link",
                status: "completed",
                targetMbid: "rg-existing-track-link",
                metadata: {
                    artistName: "Existing Track Artist",
                    albumTitle: "Existing Track Album",
                    albumMbid: "rg-existing-track-link",
                },
            },
        ]);
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.track.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "track-existing-link",
                filePath: "/music/existing-link.flac",
                album: {
                    id: "album-existing-link",
                    title: "Existing Track Album",
                    rgMbid: "rg-existing-track-link",
                    artist: {
                        name: "Existing Track Artist",
                        mbid: "artist-existing-track-link",
                    },
                },
            },
        ]);
        (tx.discoveryTrack.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "existing-link",
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.reconcileDiscoveryTracks()).resolves.toEqual({
            batchesChecked: 1,
            tracksAdded: 0,
        });
        expect(tx.discoveryTrack.create).not.toHaveBeenCalled();
    });

    it("keeps non-stuck Lidarr queue items during orphaned queue cleanup", async () => {
        const { prisma, axiosMock } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-non-stuck",
            jobs: [{ id: "job-1", lidarrRef: "dl-safe" }],
        });
        const settingsModule = require("../../utils/systemSettings");
        (settingsModule.getSystemSettings as jest.Mock).mockResolvedValueOnce({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr",
            lidarrApiKey: "token",
        });
        (axiosMock.get as jest.Mock).mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 33,
                        title: "Safe Queue Item",
                        downloadId: "dl-safe",
                        status: "queued",
                        trackedDownloadState: "importPending",
                    },
                ],
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupOrphanedLidarrQueue(
                "batch-non-stuck"
            )
        ).resolves.toBeUndefined();

        expect(axiosMock.delete).not.toHaveBeenCalled();
    });

    it("keeps artists outside successful batches and handles non-removal artist cleanup outcomes", async () => {
        const { prisma, lidarrService } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-artist-branches",
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
            jobs: [
                {
                    id: "job-success",
                    status: "completed",
                    metadata: { artistMbid: "artist-success" },
                },
            ],
        });
        (lidarrService.getDiscoveryArtists as jest.Mock).mockResolvedValueOnce([
            {
                id: 41,
                artistName: "Success Artist",
                foreignArtistId: "artist-success",
            },
            {
                id: 42,
                artistName: "Failed Removal Artist",
                foreignArtistId: "artist-failed-removal",
            },
        ]);
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValue(null);
        (lidarrService.deleteArtistById as jest.Mock).mockResolvedValueOnce({
            success: false,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupFailedArtists(
                "batch-artist-branches"
            )
        ).resolves.toBeUndefined();
    });

    it("handles extra-album cleanup paths where artist cleanup is skipped or non-destructive", async () => {
        const { prisma, lidarrService } = setupDiscoverWeeklyMocks();
        (lidarrService.deleteAlbum as jest.Mock).mockResolvedValueOnce({
            success: true,
        });
        (lidarrService.getArtistAlbums as jest.Mock).mockResolvedValueOnce([
            { id: "still-present" },
        ]);
        (lidarrService.deleteArtist as jest.Mock).mockResolvedValueOnce({
            success: false,
        });
        (prisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "native-owned",
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupExtraAlbums(
                [
                    {
                        id: "job-no-artist-mbid",
                        targetMbid: "rg-no-artist-mbid",
                    },
                    {
                        id: "job-has-albums",
                        targetMbid: "rg-has-albums",
                        lidarrAlbumId: 55,
                        metadata: {
                            artistMbid: "artist-has-albums",
                            artistName: "Has Albums Artist",
                            albumTitle: "Has Albums Album",
                        },
                    },
                ],
                "user-1"
            )
        ).resolves.toBeUndefined();
    });

    it("skips empty owned-album titles during normalized ownership checks", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.album.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.ownedAlbum.findMany as jest.Mock).mockResolvedValueOnce([
            { rgMbid: "rg-empty-owned" },
        ]);
        (prisma.album.findMany as jest.Mock).mockResolvedValueOnce([
            { title: "" },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).isAlbumOwnedByName(
                "Artist",
                "Wanted Album"
            )
        ).resolves.toBe(false);
    });

    it("continues replacement searches when MusicBrainz lookups fail before falling back to a no-mbid seed anchor", async () => {
        const { prisma, lastFmService, musicBrainzService } =
            setupDiscoverWeeklyMocks();
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "attempted-job",
                targetMbid: "rg-attempted",
                metadata: {},
            },
        ]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([{ name: "Anchor Seed Without MBID" }]);
        (lastFmService.getSimilarArtists as jest.Mock).mockResolvedValueOnce([]);
        (musicBrainzService.searchAlbum as jest.Mock).mockResolvedValueOnce(null);
        (prisma.album.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "anchor-no-mbid",
            title: "Anchor No MBID Album",
            rgMbid: "rg-anchor-no-mbid",
            artist: { name: "Anchor No MBID Artist", mbid: "artist-anchor-no-mbid" },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            discoverWeeklyService.findReplacementAlbum(
                {
                    id: "failed-job",
                    metadata: {
                        artistName: "Failed Artist",
                        albumTitle: "Failed Album",
                        artistMbid: "artist-failed",
                    },
                },
                { id: "batch-replacement-no-mbid", userId: "user-1" }
            )
        ).resolves.toEqual(
            expect.objectContaining({
                artistName: "Anchor No MBID Artist",
                albumTitle: "Anchor No MBID Album",
                albumMbid: "rg-anchor-no-mbid",
                isLibraryAnchor: true,
            })
        );
    });

    it("handles null-album recommendation candidates in both primary and fallback recommendation passes", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest
            .spyOn(discoverWeeklyService as any, "isArtistInLibrary")
            .mockImplementation(async (artistName: unknown) => {
                return artistName === "Fallback Existing Artist";
            });
        jest
            .spyOn(discoverWeeklyService as any, "findValidAlbumForArtist")
            .mockImplementation(async (artist: any) => {
                if (artist.name === "PassOne Null Artist") {
                    return {
                        recommendation: null,
                        albumsChecked: 1,
                        skippedNoMbid: 0,
                        skippedOwned: 0,
                        skippedExcluded: 0,
                        skippedDuplicate: 0,
                    };
                }

                if (artist.name === "Fallback Existing Artist") {
                    return {
                        recommendation: null,
                        albumsChecked: 1,
                        skippedNoMbid: 0,
                        skippedOwned: 0,
                        skippedExcluded: 0,
                        skippedDuplicate: 0,
                    };
                }

                if (artist.name === "Fallback Existing Artist 2") {
                    return {
                        recommendation: {
                            artistName: "Fallback Existing Artist 2",
                            artistMbid: "fallback-existing-2",
                            albumTitle: "Fallback Existing Album 2",
                            albumMbid: "rg-fallback-existing-2",
                            similarity: 0.66,
                        },
                        albumsChecked: 1,
                        skippedNoMbid: 0,
                        skippedOwned: 0,
                        skippedExcluded: 0,
                        skippedDuplicate: 0,
                    };
                }

                return {
                    recommendation: null,
                    albumsChecked: 0,
                    skippedNoMbid: 0,
                    skippedOwned: 0,
                    skippedExcluded: 0,
                    skippedDuplicate: 0,
                };
            });

        const recommendations = await (discoverWeeklyService as any).findRecommendedAlbums(
            [{ name: "Seed One", mbid: "seed-1" }],
            new Map([
                [
                    "seed-1",
                    [
                        { name: "PassOne Null Artist", mbid: "pass-one-null", match: 0.7 },
                        {
                            name: "Fallback Existing Artist",
                            mbid: "fallback-existing",
                            match: 0.68,
                        },
                        {
                            name: "Fallback Existing Artist 2",
                            mbid: "fallback-existing-2",
                            match: 0.67,
                        },
                    ],
                ],
            ]),
            1,
            "user-1"
        );

        expect(recommendations).toHaveLength(1);
    });

    it("evaluates multi-strategy branch paths for missing cache entries, low-match artists, and no-op fill/fallback phases", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "isArtistInLibrary").mockResolvedValue(
            false
        );
        jest
            .spyOn(discoverWeeklyService as any, "findValidAlbumForArtist")
            .mockResolvedValue({
                recommendation: null,
                albumsChecked: 0,
                skippedNoMbid: 0,
                skippedOwned: 0,
                skippedExcluded: 0,
                skippedDuplicate: 0,
            });
        jest
            .spyOn(discoverWeeklyService as any, "tagExplorationStrategy")
            .mockResolvedValue([]);

        const recommendations =
            await discoverWeeklyService.findRecommendedAlbumsMultiStrategy(
                [{ name: "Seed Without MBID" }, { name: "Missing Cache Seed" }],
                new Map([
                    [
                        "Seed Without MBID",
                        [
                            { name: "Low Match Artist", mbid: "low-match", match: 0 },
                            { name: "Missing Match Artist", mbid: "missing-match" },
                        ],
                    ],
                ]),
                2,
                "user-1"
            );

        expect(recommendations).toEqual([]);
    });

    it("leaves non-expired stuck batches untouched when timeout conditions are not met", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "batch-not-timeout",
                status: "downloading",
                createdAt: new Date(Date.now() - 5 * 60 * 1000),
                jobs: [{ id: "job-1", status: "pending" }],
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.checkStuckBatches()).resolves.toBe(0);
        expect(prisma.downloadJob.updateMany).not.toHaveBeenCalled();
    });

    it("covers normalized album-title include branches and empty normalized-track results during playlist build", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-normalized-branches",
            userId: "user-1",
            targetSongCount: 1,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-normalized-branches",
                status: "completed",
                targetMbid: "rg-normalized-branches",
                metadata: {
                    artistName: "Artist Normalized",
                    albumTitle: "Normalized Album Deluxe",
                    albumMbid: "rg-normalized-branches",
                    similarity: 0.7,
                    tier: "medium",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([]) // MBID miss
            .mockResolvedValueOnce([]) // Name miss
            .mockResolvedValueOnce([]) // seed anchors
            .mockResolvedValueOnce([]); // popular anchors
        (prisma.album.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "album-normalized-empty-1",
                title: "Normalized Album Deluxe Edition",
                rgMbid: "rg-normalized-branches",
                artist: { name: "Artist Normalized", mbid: "artist-normalized" },
                tracks: [],
            },
            {
                id: "album-normalized-empty-2",
                title: "Normalized Album",
                rgMbid: "rg-normalized-branches-2",
                artist: { name: "Artist Normalized", mbid: "artist-normalized" },
                tracks: [],
            },
        ]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "cleanupFailedArtists").mockResolvedValue(
            undefined
        );
        jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-normalized-branches")
        ).resolves.toBeUndefined();
    });

    it("ignores queue records that are not part of the current batch download id set", async () => {
        const { prisma, axiosMock } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-ignore-unrelated-queue",
            jobs: [{ id: "job-1", lidarrRef: "dl-owned" }],
        });
        const settingsModule = require("../../utils/systemSettings");
        (settingsModule.getSystemSettings as jest.Mock).mockResolvedValueOnce({
            lidarrEnabled: true,
            lidarrUrl: "http://lidarr",
            lidarrApiKey: "token",
        });
        (axiosMock.get as jest.Mock).mockResolvedValueOnce({
            data: {
                records: [
                    {
                        id: 77,
                        title: "Unrelated Queue Item",
                        downloadId: "dl-unrelated",
                        status: "warning",
                        trackedDownloadState: "importFailed",
                    },
                ],
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupOrphanedLidarrQueue(
                "batch-ignore-unrelated-queue"
            )
        ).resolves.toBeUndefined();

        expect(axiosMock.delete).not.toHaveBeenCalled();
    });

    it("continues failed-artist cleanup for non-success artists and handles missing artist-mbid metadata in extra cleanup", async () => {
        const { prisma, lidarrService } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-cleanup-continued",
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
            jobs: [
                {
                    id: "job-success",
                    status: "completed",
                    metadata: { artistMbid: "artist-success" },
                },
            ],
        });
        (lidarrService.getDiscoveryArtists as jest.Mock).mockResolvedValueOnce([
            {
                id: 81,
                artistName: "Success Artist",
                foreignArtistId: "artist-success",
            },
            {
                id: 82,
                artistName: "Non Success Artist",
                foreignArtistId: "artist-non-success",
            },
        ]);
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValue(null);
        (lidarrService.deleteArtistById as jest.Mock).mockResolvedValueOnce({
            success: true,
        });
        (lidarrService.deleteAlbum as jest.Mock).mockResolvedValueOnce({
            success: true,
        });
        (lidarrService.getArtistAlbums as jest.Mock).mockResolvedValueOnce([]);
        (prisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (lidarrService.deleteArtist as jest.Mock).mockResolvedValueOnce({
            success: false,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupFailedArtists(
                "batch-cleanup-continued"
            )
        ).resolves.toBeUndefined();

        await expect(
            (discoverWeeklyService as any).cleanupExtraAlbums(
                [
                    {
                        id: "job-no-artist-mbid-but-lidarr-id",
                        targetMbid: "rg-no-artist-mbid",
                        lidarrAlbumId: 101,
                        metadata: {
                            artistName: "Unknown Artist",
                            albumTitle: "Unknown Album",
                        },
                    },
                ],
                "user-1"
            )
        ).resolves.toBeUndefined();
    });

    it("skips replacement candidates when MusicBrainz lookup does not return an MBID", async () => {
        const { prisma, lastFmService, musicBrainzService } =
            setupDiscoverWeeklyMocks();
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([{ name: "Seed One", mbid: "seed-1" }]);
        (lastFmService.getSimilarArtists as jest.Mock).mockResolvedValueOnce([
            { name: "No MB Candidate", mbid: "artist-no-mb", match: 0.8 },
        ]);
        (lastFmService.getArtistTopAlbums as jest.Mock).mockResolvedValueOnce([
            { name: "No MB Album" },
        ]);
        (musicBrainzService.searchAlbum as jest.Mock).mockResolvedValueOnce(null);
        (prisma.album.findFirst as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "isArtistInLibrary").mockResolvedValue(
            false
        );
        jest.spyOn(discoverWeeklyService as any, "isAlbumExcluded").mockResolvedValue(
            false
        );

        await expect(
            discoverWeeklyService.findReplacementAlbum(
                {
                    id: "failed-job",
                    metadata: {
                        artistName: "Failed Artist",
                        albumTitle: "Failed Album",
                        artistMbid: "artist-failed",
                    },
                },
                { id: "batch-replacement-no-mb", userId: "user-1" }
            )
        ).resolves.toBeNull();
    });

    it("covers recommendation null paths and multi-strategy duplicate/empty-result paths", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest
            .spyOn(discoverWeeklyService as any, "isArtistInLibrary")
            .mockResolvedValue(false);
        jest
            .spyOn(discoverWeeklyService as any, "findValidAlbumForArtist")
            .mockImplementation(async (artist: any) => {
                if (artist.name === "Primary Null Artist") {
                    return null;
                }
                if (artist.name === "Fallback Null Artist") {
                    return {
                        recommendation: null,
                        albumsChecked: 1,
                        skippedNoMbid: 0,
                        skippedOwned: 0,
                        skippedExcluded: 0,
                        skippedDuplicate: 0,
                    };
                }
                return {
                    recommendation: {
                        artistName: artist.name,
                        artistMbid: artist.mbid,
                        albumTitle: `${artist.name} Album`,
                        albumMbid: `rg-${artist.mbid}`,
                        similarity: artist.match || 0.5,
                    },
                    albumsChecked: 1,
                    skippedNoMbid: 0,
                    skippedOwned: 0,
                    skippedExcluded: 0,
                    skippedDuplicate: 0,
                };
            });
        jest
            .spyOn(discoverWeeklyService as any, "tagExplorationStrategy")
            .mockResolvedValue([]);

        const passRecommendations = await (discoverWeeklyService as any).findRecommendedAlbums(
            [{ name: "Seed One", mbid: "seed-1" }],
            new Map([
                [
                    "seed-1",
                    [
                        { name: "Primary Null Artist", mbid: "primary-null", match: 0.8 },
                        { name: "Fallback Null Artist", mbid: "fallback-null", match: 0.79 },
                        { name: "Recovered Artist", mbid: "recovered", match: 0.78 },
                    ],
                ],
            ]),
            1,
            "user-1"
        );
        expect(passRecommendations).toHaveLength(1);

        const multiRecommendations =
            await discoverWeeklyService.findRecommendedAlbumsMultiStrategy(
                [{ name: "Seed Multi", mbid: "seed-multi" }],
                new Map([
                    [
                        "seed-multi",
                        [
                            { name: "Dup Artist", mbid: "dup-1", match: 0.81 },
                            { name: "Dup Artist", mbid: "dup-2", match: 0.8 },
                            { name: "Fill Null Artist", mbid: "fill-null", match: 0.6 },
                            { name: "Existing Null Artist", mbid: "existing-null", match: 0.59 },
                        ],
                    ],
                ]),
                4,
                "user-1"
            );

        expect(Array.isArray(multiRecommendations)).toBe(true);
    });

    it("creates empty discovery-track filenames during reconciliation when file paths are blank", async () => {
        const { prisma, tx } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "batch-reconcile-empty-file",
                userId: "user-1",
                weekStart: new Date("2026-02-16T00:00:00.000Z"),
                status: "completed",
                completedAt: new Date("2026-02-16T02:00:00.000Z"),
            },
        ]);
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-reconcile-empty-file",
                status: "completed",
                targetMbid: "rg-empty-file",
                metadata: {
                    artistName: "Reconcile Artist",
                    albumTitle: "Reconcile Album",
                    albumMbid: "rg-empty-file",
                },
            },
        ]);
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.track.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "track-reconcile-empty-file",
                filePath: "",
                album: {
                    id: "album-reconcile-empty-file",
                    title: "Reconcile Album",
                    rgMbid: "rg-empty-file",
                    artist: { name: "Reconcile Artist", mbid: "artist-reconcile" },
                },
            },
        ]);
        (tx.discoveryTrack.findFirst as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.reconcileDiscoveryTracks()).resolves.toEqual({
            batchesChecked: 1,
            tracksAdded: 1,
        });
        expect(tx.discoveryTrack.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    fileName: "",
                }),
            })
        );
    });

    it("records non-success deleteArtist outcomes during extra-album cleanup when artist mbid is present", async () => {
        const { prisma, lidarrService } = setupDiscoverWeeklyMocks();
        (lidarrService.deleteAlbum as jest.Mock).mockResolvedValueOnce({
            success: true,
        });
        (lidarrService.getArtistAlbums as jest.Mock).mockResolvedValueOnce([]);
        (prisma.ownedAlbum.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (lidarrService.deleteArtist as jest.Mock).mockResolvedValueOnce({
            success: false,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupExtraAlbums(
                [
                    {
                        id: "job-delete-artist-false",
                        targetMbid: "rg-delete-artist-false",
                        lidarrAlbumId: 202,
                        metadata: {
                            artistMbid: "artist-delete-artist-false",
                            artistName: "Cleanup Artist",
                            albumTitle: "Cleanup Album",
                        },
                    },
                ],
                "user-1"
            )
        ).resolves.toBeUndefined();
    });

    it("handles genre parsing branches for falsy genre entries, missing userGenres, and invalid userGenre entries", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.play.findMany as jest.Mock).mockResolvedValueOnce([
            {
                track: {
                    album: {
                        artist: {
                            genres: "rock,,indie",
                            userGenres: undefined,
                        },
                    },
                },
            },
            {
                track: {
                    album: {
                        artist: {
                            genres: ["ambient", ""],
                            userGenres: ["", 123 as any, "drone"],
                        },
                    },
                },
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).getUserTopGenres("user-1")
        ).resolves.toEqual(expect.arrayContaining(["rock", "indie", "ambient", "drone"]));
    });

    it("covers selectFromTier and fill-loop duplicate/empty recommendation branches in multi-strategy discovery", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest
            .spyOn(discoverWeeklyService as any, "isArtistInLibrary")
            .mockResolvedValue(false);
        jest
            .spyOn(discoverWeeklyService as any, "findValidAlbumForArtist")
            .mockImplementation(async (artist: any) => {
                if (artist.name === "DupMed") {
                    return {
                        recommendation: {
                            artistName: "DupMed",
                            artistMbid: artist.mbid,
                            albumTitle: "DupMed Album",
                            albumMbid: `rg-${artist.mbid}`,
                            similarity: artist.match,
                        },
                        albumsChecked: 1,
                        skippedNoMbid: 0,
                        skippedOwned: 0,
                        skippedExcluded: 0,
                        skippedDuplicate: 0,
                    };
                }
                if (artist.name === "MedNull" || artist.name === "FillNull") {
                    return {
                        recommendation: null,
                        albumsChecked: 1,
                        skippedNoMbid: 0,
                        skippedOwned: 0,
                        skippedExcluded: 0,
                        skippedDuplicate: 0,
                    };
                }
                return {
                    recommendation: {
                        artistName: artist.name,
                        artistMbid: artist.mbid,
                        albumTitle: `${artist.name} Album`,
                        albumMbid: `rg-${artist.mbid}`,
                        similarity: artist.match,
                    },
                    albumsChecked: 1,
                    skippedNoMbid: 0,
                    skippedOwned: 0,
                    skippedExcluded: 0,
                    skippedDuplicate: 0,
                };
            });
        jest
            .spyOn(discoverWeeklyService as any, "tagExplorationStrategy")
            .mockResolvedValue([]);

        await expect(
            discoverWeeklyService.findRecommendedAlbumsMultiStrategy(
                [{ name: "Seed Branches", mbid: "seed-branches" }],
                new Map([
                    [
                        "seed-branches",
                        [
                            { name: "DupMed", mbid: "dup-med-1", match: 0.61 },
                            { name: "DupMed", mbid: "dup-med-2", match: 0.62 },
                            { name: "MedNull", mbid: "med-null", match: 0.63 },
                            { name: "MedOther", mbid: "med-other", match: 0.64 },
                            { name: "FillDup", mbid: "fill-dup-1", match: 0.4 },
                            { name: "FillDup", mbid: "fill-dup-2", match: 0.41 },
                            { name: "FillNull", mbid: "fill-null", match: 0.42 },
                            { name: "FillFinal", mbid: "fill-final", match: 0.43 },
                            { name: "FillExtra", mbid: "fill-extra", match: 0.44 },
                        ],
                    ],
                ]),
                5,
                "user-1"
            )
        ).resolves.toEqual(expect.any(Array));
    });

    it("covers existing-fallback duplicate/empty recommendation branches in multi-strategy discovery", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest
            .spyOn(discoverWeeklyService as any, "isArtistInLibrary")
            .mockResolvedValue(true);
        jest
            .spyOn(discoverWeeklyService as any, "findValidAlbumForArtist")
            .mockImplementation(async (artist: any) => {
                if (artist.name === "ExistingNull") {
                    return {
                        recommendation: null,
                        albumsChecked: 1,
                        skippedNoMbid: 0,
                        skippedOwned: 0,
                        skippedExcluded: 0,
                        skippedDuplicate: 0,
                    };
                }
                return {
                    recommendation: {
                        artistName: artist.name,
                        artistMbid: artist.mbid,
                        albumTitle: `${artist.name} Album`,
                        albumMbid: `rg-${artist.mbid}`,
                        similarity: artist.match,
                    },
                    albumsChecked: 1,
                    skippedNoMbid: 0,
                    skippedOwned: 0,
                    skippedExcluded: 0,
                    skippedDuplicate: 0,
                };
            });
        jest
            .spyOn(discoverWeeklyService as any, "tagExplorationStrategy")
            .mockResolvedValue([]);

        await expect(
            discoverWeeklyService.findRecommendedAlbumsMultiStrategy(
                [{ name: "Seed Existing Branches", mbid: "seed-existing-branches" }],
                new Map([
                    [
                        "seed-existing-branches",
                        [
                            { name: "ExistingDup", mbid: "existing-dup-1", match: 0.61 },
                            { name: "ExistingDup", mbid: "existing-dup-2", match: 0.62 },
                            { name: "ExistingNull", mbid: "existing-null", match: 0.63 },
                            { name: "ExistingFinal", mbid: "existing-final", match: 0.64 },
                            { name: "ExistingAfter", mbid: "existing-after", match: 0.65 },
                            { name: "ExistingPost", mbid: "existing-post", match: 0.66 },
                        ],
                    ],
                ]),
                4,
                "user-1"
            )
        ).resolves.toEqual(expect.any(Array));
    });

    it("skips normalized album fallback when name-based album lookups already found tracks", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-name-hit-before-normalized",
            userId: "user-1",
            targetSongCount: 1,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-name-hit-before-normalized",
                status: "completed",
                targetMbid: "rg-name-hit-before-normalized",
                metadata: {
                    artistName: "Name Hit Artist",
                    albumTitle: "Name Hit Album",
                    albumMbid: "rg-name-hit-before-normalized",
                    similarity: 0.72,
                    tier: "medium",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([]) // MBID miss
            .mockResolvedValueOnce([
                {
                    id: "track-name-hit-before-normalized",
                    filePath: "/music/name-hit.flac",
                    album: {
                        id: "album-name-hit",
                        title: "Name Hit Album",
                        rgMbid: "rg-name-hit-before-normalized",
                        artist: { name: "Name Hit Artist", mbid: "artist-name-hit" },
                    },
                },
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "cleanupFailedArtists").mockResolvedValue(
            undefined
        );
        jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-name-hit-before-normalized")
        ).resolves.toBeUndefined();
        expect(prisma.album.findMany).not.toHaveBeenCalled();
    });

    it("hits false-branch guards in anchor grouping by returning duplicate library albums", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-anchor-guard-false",
            userId: "user-1",
            targetSongCount: 3,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-anchor-guard-false",
                status: "completed",
                targetMbid: "rg-anchor-guard-false",
                metadata: {
                    artistName: "Discovery Artist",
                    albumTitle: "Discovery Album",
                    albumMbid: "rg-anchor-guard-false",
                    similarity: 0.8,
                    tier: "high",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([
                {
                    id: "track-discovery-anchor-false",
                    filePath: "/music/discovery-anchor-false.flac",
                    album: {
                        id: "album-discovery-anchor-false",
                        title: "Discovery Album",
                        rgMbid: "rg-anchor-guard-false",
                        artist: { name: "Discovery Artist", mbid: "artist-discovery" },
                    },
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: "track-seed-a",
                    filePath: "/music/seed-a.flac",
                    album: {
                        id: "album-seed-shared",
                        title: "Seed Shared Album",
                        rgMbid: "rg-seed-shared",
                        artist: { name: "Seed Shared Artist", mbid: "artist-seed-shared" },
                        location: "LIBRARY",
                    },
                },
                {
                    id: "track-seed-b",
                    filePath: "/music/seed-b.flac",
                    album: {
                        id: "album-seed-shared",
                        title: "Seed Shared Album",
                        rgMbid: "rg-seed-shared",
                        artist: { name: "Seed Shared Artist", mbid: "artist-seed-shared" },
                        location: "LIBRARY",
                    },
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: "track-pop-a",
                    filePath: "/music/pop-a.flac",
                    album: {
                        id: "album-pop-shared",
                        title: "Popular Shared Album",
                        rgMbid: "rg-pop-shared",
                        artist: { name: "Popular Shared Artist", mbid: "artist-pop-shared" },
                        location: "LIBRARY",
                    },
                },
                {
                    id: "track-pop-b",
                    filePath: "/music/pop-b.flac",
                    album: {
                        id: "album-pop-shared",
                        title: "Popular Shared Album",
                        rgMbid: "rg-pop-shared",
                        artist: { name: "Popular Shared Artist", mbid: "artist-pop-shared" },
                        location: "LIBRARY",
                    },
                },
            ]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([{ name: "Seed Artist", mbid: "seed-1" }]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "cleanupFailedArtists").mockResolvedValue(
            undefined
        );
        jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-anchor-guard-false")
        ).resolves.toBeUndefined();
    });

    it("forces duplicate selected tracks to exercise existing discoveryAlbum/job match branches", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-duplicate-selected",
            userId: "user-1",
            targetSongCount: 1,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-duplicate-selected",
                status: "completed",
                targetMbid: "rg-duplicate-selected",
                metadata: {
                    artistName: "Duplicate Artist",
                    albumTitle: "Duplicate Album",
                    albumMbid: "rg-duplicate-selected",
                    similarity: 0.7,
                    tier: "medium",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([
                {
                    id: "track-duplicate-source",
                    filePath: "/music/duplicate-source.flac",
                    album: {
                        id: "album-duplicate-source",
                        title: "Duplicate Album",
                        rgMbid: "rg-duplicate-selected",
                        artist: { name: "Duplicate Artist", mbid: "artist-duplicate" },
                    },
                },
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        const shuffleModule = require("../../utils/shuffle");
        (shuffleModule.shuffleArray as jest.Mock).mockImplementation(
            (arr: unknown[]) => {
                if (
                    Array.isArray(arr) &&
                    arr.length === 1 &&
                    (arr[0] as any)?.id === "track-duplicate-source"
                ) {
                    return [arr[0], arr[0]];
                }
                return arr;
            }
        );
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "cleanupFailedArtists").mockResolvedValue(
            undefined
        );
        jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-duplicate-selected")
        ).resolves.toBeUndefined();
    });

    it("executes false-pass fallback branches for successful-artist and existing-artist recommendation guards", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest
            .spyOn(discoverWeeklyService as any, "isArtistInLibrary")
            .mockImplementation(async (artistName: unknown) => {
                return artistName === "Existing Pass Artist";
            });
        jest
            .spyOn(discoverWeeklyService as any, "findValidAlbumForArtist")
            .mockImplementation(async (artist: any) => {
                if (artist.name === "Existing Pass Artist") {
                    return null;
                }
                if (artist.name === "Existing Null Recommendation") {
                    return {
                        recommendation: null,
                        albumsChecked: 1,
                        skippedNoMbid: 0,
                        skippedOwned: 0,
                        skippedExcluded: 0,
                        skippedDuplicate: 0,
                    };
                }
                return {
                    recommendation: {
                        artistName: artist.name,
                        artistMbid: artist.mbid,
                        albumTitle: `${artist.name} Album`,
                        albumMbid: `rg-${artist.mbid}`,
                        similarity: artist.match || 0.5,
                    },
                    albumsChecked: 1,
                    skippedNoMbid: 0,
                    skippedOwned: 0,
                    skippedExcluded: 0,
                    skippedDuplicate: 0,
                };
            });

        await expect(
            (discoverWeeklyService as any).findRecommendedAlbums(
                [{ name: "Seed Existing", mbid: "seed-existing" }],
                new Map([
                    [
                        "seed-existing",
                        [
                            { name: "Existing Pass Artist", mbid: "existing-pass", match: 0.7 },
                            {
                                name: "Existing Null Recommendation",
                                mbid: "existing-null-recommendation",
                                match: 0.69,
                            },
                            { name: "Existing Recovery", mbid: "existing-recovery", match: 0.68 },
                        ],
                    ],
                ]),
                1,
                "user-1"
            )
        ).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    albumMbid: "rg-existing-recovery",
                }),
            ])
        );
    });

    it("records user-genre false-guard paths by deleting artists not present in successful sets", async () => {
        const { prisma, lidarrService } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-success-set-guard",
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
            jobs: [
                {
                    id: "job-success",
                    status: "completed",
                    metadata: { artistMbid: "artist-success" },
                },
            ],
        });
        (lidarrService.getDiscoveryArtists as jest.Mock).mockResolvedValueOnce([
            {
                id: 301,
                artistName: "Artist Success",
                foreignArtistId: "artist-success",
            },
            {
                id: 302,
                artistName: "Artist Not Successful",
                foreignArtistId: "artist-not-successful",
            },
        ]);
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValue(null);
        (lidarrService.deleteArtistById as jest.Mock).mockResolvedValueOnce({
            success: true,
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupFailedArtists(
                "batch-success-set-guard"
            )
        ).resolves.toBeUndefined();
    });

    it("handles completed jobs that omit artist mbids when building successful-artist sets", async () => {
        const { prisma, lidarrService } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-success-no-artist-mbid",
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
            jobs: [
                {
                    id: "job-success-no-artist-mbid",
                    status: "completed",
                    metadata: {},
                },
            ],
        });
        (lidarrService.getDiscoveryArtists as jest.Mock).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupFailedArtists(
                "batch-success-no-artist-mbid"
            )
        ).resolves.toBeUndefined();
    });

    it("evaluates non-matching normalized-album candidates during fallback scanning", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-normalized-nonmatch",
            userId: "user-1",
            targetSongCount: 1,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-normalized-nonmatch",
                status: "completed",
                targetMbid: "rg-normalized-nonmatch",
                metadata: {
                    artistName: "Normalized Artist",
                    albumTitle: "Wanted Album",
                    albumMbid: "rg-normalized-nonmatch",
                    similarity: 0.7,
                    tier: "medium",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([]) // MBID miss
            .mockResolvedValueOnce([]) // Name miss
            .mockResolvedValueOnce([]) // seed anchors
            .mockResolvedValueOnce([]); // popular anchors
        (prisma.album.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "album-non-match",
                title: "Completely Different Album",
                rgMbid: "rg-other",
                artist: { name: "Normalized Artist", mbid: "artist-normalized" },
                tracks: [],
            },
        ]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "cleanupFailedArtists").mockResolvedValue(
            undefined
        );
        jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-normalized-nonmatch")
        ).resolves.toBeUndefined();
    });

    it("handles duplicate popular-library album candidates during anchor fallback selection", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-popular-duplicates",
            userId: "user-1",
            targetSongCount: 8,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce(
            Array.from({ length: 6 }, (_, index) => ({
                id: `job-pop-${index}`,
                status: "completed",
                targetMbid: `rg-pop-${index}`,
                metadata: {
                    artistName: `Artist ${index}`,
                    albumTitle: `Album ${index}`,
                    albumMbid: `rg-pop-${index}`,
                    similarity: 0.7,
                    tier: "medium",
                },
            }))
        );
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query: any) => {
            if (query?.where?.album?.rgMbid) {
                const rgMbid = query.where.album.rgMbid;
                return [
                    {
                        id: `track-${rgMbid}`,
                        filePath: `/music/${rgMbid}.flac`,
                        album: {
                            id: `album-${rgMbid}`,
                            title: `Album ${rgMbid}`,
                            rgMbid,
                            artist: { name: `Artist ${rgMbid}`, mbid: `artist-${rgMbid}` },
                        },
                    },
                ];
            }

            if (query?.where?.album?.location === "LIBRARY" && !query?.orderBy) {
                return [];
            }

            if (query?.where?.album?.location === "LIBRARY" && query?.orderBy) {
                return [
                    {
                        id: "track-pop-dup-1",
                        filePath: "/music/pop-dup-1.flac",
                        album: {
                            id: "album-pop-dup",
                            title: "Popular Duplicate Album",
                            rgMbid: "rg-pop-dup",
                            artist: { name: "Popular Artist", mbid: "artist-pop-dup" },
                        },
                    },
                    {
                        id: "track-pop-dup-2",
                        filePath: "/music/pop-dup-2.flac",
                        album: {
                            id: "album-pop-dup",
                            title: "Popular Duplicate Album",
                            rgMbid: "rg-pop-dup",
                            artist: { name: "Popular Artist", mbid: "artist-pop-dup" },
                        },
                    },
                ];
            }

            return [];
        });
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "cleanupFailedArtists").mockResolvedValue(
            undefined
        );
        jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-popular-duplicates")
        ).resolves.toBeUndefined();
    });

    it("matches completed download metadata to selected tracks without entering unmatched-job diagnostics", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-job-match",
            userId: "user-1",
            targetSongCount: 1,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-job-match",
                status: "completed",
                targetMbid: "rg-job-match",
                metadata: {
                    artistName: "Match Artist",
                    albumTitle: "Match Album",
                    albumMbid: "rg-job-match",
                    similarity: 0.75,
                    tier: "high",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([
                {
                    id: "track-job-match",
                    filePath: "/music/job-match.flac",
                    album: {
                        id: "album-job-match",
                        title: "Match Album",
                        rgMbid: "rg-job-match",
                        artist: { name: "Match Artist", mbid: "artist-match" },
                    },
                },
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "cleanupFailedArtists").mockResolvedValue(
            undefined
        );
        jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-job-match")
        ).resolves.toBeUndefined();
    });

    it("skips exclusion upserts when exclusionMonths is zero", async () => {
        const { prisma, tx } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "batch-zero-exclusion-months",
            userId: "user-1",
            targetSongCount: 1,
            weekStart: new Date("2026-02-16T00:00:00.000Z"),
        });
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-zero-exclusion-months",
                status: "completed",
                targetMbid: "rg-zero-exclusion-months",
                metadata: {
                    artistName: "Zero Exclusion Artist",
                    albumTitle: "Zero Exclusion Album",
                    albumMbid: "rg-zero-exclusion-months",
                    similarity: 0.7,
                    tier: "medium",
                },
            },
        ]);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([
                {
                    id: "track-zero-exclusion-months",
                    filePath: "/music/zero-exclusion.flac",
                    album: {
                        id: "album-zero-exclusion-months",
                        title: "Zero Exclusion Album",
                        rgMbid: "rg-zero-exclusion-months",
                        artist: {
                            name: "Zero Exclusion Artist",
                            mbid: "artist-zero-exclusion",
                        },
                    },
                },
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        (tx.userDiscoverConfig.findUnique as jest.Mock).mockResolvedValueOnce({
            exclusionMonths: 0,
        });
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(discoverWeeklyService as any, "cleanupFailedArtists").mockResolvedValue(
            undefined
        );
        jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-zero-exclusion-months")
        ).resolves.toBeUndefined();
        expect(tx.discoverExclusion.upsert).not.toHaveBeenCalled();
    });

    it("walks pass-two recommendation paths where album lookups return null and null recommendations before a recovery", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest
            .spyOn(discoverWeeklyService as any, "isArtistInLibrary")
            .mockImplementation(async (artistName: unknown) => {
                return artistName === "PassTwo Null Album" || artistName === "PassTwo Null Recommendation" || artistName === "PassTwo Recovery";
            });
        jest
            .spyOn(discoverWeeklyService as any, "findValidAlbumForArtist")
            .mockImplementation(async (artist: any) => {
                if (artist.name === "PassTwo Null Album") {
                    return null;
                }
                if (artist.name === "PassTwo Null Recommendation") {
                    return {
                        recommendation: null,
                        albumsChecked: 1,
                        skippedNoMbid: 0,
                        skippedOwned: 0,
                        skippedExcluded: 0,
                        skippedDuplicate: 0,
                    };
                }
                if (artist.name === "PassTwo Recovery") {
                    return {
                        recommendation: {
                            artistName: "PassTwo Recovery",
                            artistMbid: "pass-two-recovery",
                            albumTitle: "PassTwo Recovery Album",
                            albumMbid: "rg-pass-two-recovery",
                            similarity: 0.65,
                        },
                        albumsChecked: 1,
                        skippedNoMbid: 0,
                        skippedOwned: 0,
                        skippedExcluded: 0,
                        skippedDuplicate: 0,
                    };
                }
                return {
                    recommendation: null,
                    albumsChecked: 0,
                    skippedNoMbid: 0,
                    skippedOwned: 0,
                    skippedExcluded: 0,
                    skippedDuplicate: 0,
                };
            });

        await expect(
            (discoverWeeklyService as any).findRecommendedAlbums(
                [{ name: "Seed PassTwo", mbid: "seed-pass-two" }],
                new Map([
                    [
                        "seed-pass-two",
                        [
                            { name: "PassTwo Null Album", mbid: "pass-two-null-album", match: 0.7 },
                            {
                                name: "PassTwo Null Recommendation",
                                mbid: "pass-two-null-recommendation",
                                match: 0.69,
                            },
                            { name: "PassTwo Recovery", mbid: "pass-two-recovery", match: 0.68 },
                        ],
                    ],
                ]),
                1,
                "user-1"
            )
        ).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    albumMbid: "rg-pass-two-recovery",
                }),
            ])
        );
    });

    it("returns false when artist is absent by both MBID and name lookups", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.artist.findFirst as jest.Mock).mockResolvedValue(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).isArtistInLibrary(
                "Missing Artist",
                "missing-mbid"
            )
        ).resolves.toBe(false);
    });
});
