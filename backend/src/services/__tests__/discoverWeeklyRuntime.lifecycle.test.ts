import { setupDiscoverWeeklyMocks } from "./discoverWeeklyRuntime.helpers";

describe("discover weekly runtime behavior", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.resetModules();
        jest.clearAllMocks();
    });

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
            }),
        );
        expect(prisma.downloadJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    discoveryBatchId: "batch-1",
                }),
            }),
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

        await expect(discoverWeeklyService.checkStuckBatches()).resolves.toBe(
            1,
        );
        expect(prisma.downloadJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    discoveryBatchId: "batch-timeout",
                }),
            }),
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
                {
                    id: "job-1",
                    status: "pending",
                    metadata: {},
                    targetMbid: null,
                },
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
                    metadata: {
                        artistName: "A",
                        albumTitle: "B",
                        similarity: 0.4,
                    },
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
            }),
        );
        expect(discoveryBatchLogger.error).toHaveBeenCalledWith(
            "batch-failed",
            "All downloads failed",
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
                    metadata: {
                        artistName: "Failed",
                        albumTitle: "Album",
                        similarity: 0.5,
                    },
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
            }),
        );
        expect(scanQueue.add).toHaveBeenCalledWith("scan", {
            type: "full",
            source: "discover-weekly-completion",
            discoveryBatchId: "batch-scan",
        });
    });

    it("fails playlist generation when discovery weekly is disabled for the user", async () => {
        const { prisma, discoveryLogger } = setupDiscoverWeeklyMocks();
        (prisma.userDiscoverConfig.findUnique as jest.Mock).mockResolvedValue(
            null,
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");

        await expect(
            discoverWeeklyService.generatePlaylist("user-1"),
        ).rejects.toThrow("Discovery Weekly not enabled");
        expect(discoveryLogger.end).toHaveBeenCalledWith(false, "Not enabled");
    });

    it("rejects non-admin generation before creating a batch or acquiring albums", async () => {
        const { prisma, tx, acquisitionService } = setupDiscoverWeeklyMocks();
        (prisma.user.findUnique as jest.Mock).mockResolvedValueOnce({
            role: "user",
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");

        await expect(
            discoverWeeklyService.generatePlaylist("user-1"),
        ).rejects.toThrow(
            "Discover Weekly downloads are admin-only on this server",
        );

        expect(prisma.user.findUnique).toHaveBeenCalledWith({
            where: { id: "user-1" },
            select: { role: true },
        });
        expect(prisma.userDiscoverConfig.findUnique).not.toHaveBeenCalled();
        expect(tx.discoveryBatch.create).not.toHaveBeenCalled();
        expect(tx.downloadJob.create).not.toHaveBeenCalled();
        expect(acquisitionService.acquireAlbum).not.toHaveBeenCalled();
    });

    it("returns early when buildFinalPlaylist receives a missing batch id", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce(
            null,
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            discoverWeeklyService.buildFinalPlaylist("missing-batch"),
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
            }),
        );
        expect(discoveryBatchLogger.error).toHaveBeenCalledWith(
            "batch-no-tracks",
            "No tracks found after scan",
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
        await expect(
            discoverWeeklyService.reconcileDiscoveryTracks(),
        ).resolves.toEqual({ batchesChecked: 0, tracksAdded: 0 });
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
        await expect(
            discoverWeeklyService.reconcileDiscoveryTracks(),
        ).resolves.toEqual({ batchesChecked: 1, tracksAdded: 0 });
    });

    it("generates a discovery batch and updates acquired jobs on successful generation", async () => {
        const {
            prisma,
            tx,
            discoveryBatchLogger,
            acquisitionService,
            discoveryLogger,
        } = setupDiscoverWeeklyMocks();
        (
            prisma.userDiscoverConfig.findUnique as jest.Mock
        ).mockResolvedValueOnce({
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
        jest.spyOn(
            discoverWeeklyService as any,
            "prefetchSimilarArtists",
        ).mockResolvedValue(new Map([["seed-1", []]]));
        jest.spyOn(
            discoverWeeklyService as any,
            "findRecommendedAlbumsMultiStrategy",
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

        expect(prisma.user.findUnique).toHaveBeenCalledWith({
            where: { id: "user-1" },
            select: { role: true },
        });
        expect(tx.discoveryBatch.create).toHaveBeenCalledTimes(1);
        expect(tx.downloadJob.create).toHaveBeenCalledTimes(2);
        expect(acquisitionService.acquireAlbum).toHaveBeenCalledTimes(2);
        expect(prisma.downloadJob.update).toHaveBeenCalledTimes(2);
        expect(discoveryBatchLogger.info).toHaveBeenCalledWith(
            expect.any(String),
            expect.stringContaining("downloads started"),
        );
        expect(result).toEqual(
            expect.objectContaining({
                success: true,
                songCount: 0,
                batchId: expect.any(String),
            }),
        );
        expect(discoveryLogger.end).toHaveBeenCalledWith(
            true,
            expect.stringContaining("downloads queued"),
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
            "batch-clean",
        );

        expect(axiosMock.delete).toHaveBeenCalledWith(
            "http://lidarr/api/v1/queue/10",
            expect.objectContaining({
                params: expect.objectContaining({
                    removeFromClient: true,
                    blocklist: true,
                }),
            }),
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
            },
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await (discoverWeeklyService as any).cleanupFailedArtists(
            "batch-artists",
        );

        expect(lidarrService.removeDiscoveryTagByMbid).toHaveBeenCalledWith(
            "artist-liked",
        );
        expect(lidarrService.deleteArtistById).toHaveBeenCalledWith(3, true);
        expect(discoveryBatchLogger.info).toHaveBeenCalledWith(
            "batch-artists",
            expect.stringContaining("failed artists removed"),
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
                "mbid-artist-1",
            ),
        ).resolves.toBe(true);
        await expect(
            (discoverWeeklyService as any).isArtistInLibrary(
                "Artist Name",
                undefined,
            ),
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
        ).mockResolvedValueOnce([{ name: "Seed Artist", mbid: "seed-1" }]);
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
        jest.spyOn(
            discoverWeeklyService as any,
            "isArtistInLibrary",
        ).mockResolvedValue(false);
        jest.spyOn(
            discoverWeeklyService as any,
            "isAlbumExcluded",
        ).mockResolvedValue(false);

        const replacement = await discoverWeeklyService.findReplacementAlbum(
            {
                id: "failed-job",
                metadata: {
                    artistName: "Old",
                    albumTitle: "Old Album",
                    artistMbid: "artist-failed",
                },
            },
            { id: "batch-r1", userId: "user-1" },
        );

        expect(replacement).toEqual(
            expect.objectContaining({
                artistName: "New Similar",
                albumTitle: "New Album",
                albumMbid: "rg-new",
            }),
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
        ).mockResolvedValueOnce([{ name: "Seed Artist", mbid: "seed-1" }]);
        (lastFmService.getSimilarArtists as jest.Mock).mockResolvedValueOnce(
            [],
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const replacement = await discoverWeeklyService.findReplacementAlbum(
            {
                id: "failed-job",
                metadata: {
                    artistName: "Old",
                    albumTitle: "Old Album",
                    artistMbid: "artist-failed",
                },
            },
            { id: "batch-r2", userId: "user-1" },
        );

        expect(replacement).toEqual(
            expect.objectContaining({
                artistName: "Seed Artist",
                albumTitle: "Anchor Album",
                albumMbid: "rg-anchor",
                similarity: 1,
                isLibraryAnchor: true,
            }),
        );
    });

    it("retries discover-weekly prisma operations on retryable errors and reconnects", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        const retryable = new Prisma.PrismaClientKnownRequestError(
            "temporary connection loss",
        );
        (prisma.discoveryBatch.findMany as jest.Mock)
            .mockRejectedValueOnce(retryable)
            .mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.checkStuckBatches()).resolves.toBe(
            0,
        );

        expect(prisma.discoveryBatch.findMany).toHaveBeenCalledTimes(2);
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
    });

    it("throws after exhausting discover-weekly prisma retries", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        const retryable = new Prisma.PrismaClientKnownRequestError(
            "persistent db failure",
        );
        (prisma.discoveryBatch.findMany as jest.Mock).mockRejectedValue(
            retryable,
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.checkStuckBatches()).rejects.toThrow(
            "persistent db failure",
        );
        expect(prisma.discoveryBatch.findMany).toHaveBeenCalledTimes(3);
        expect(prisma.$connect).toHaveBeenCalledTimes(2);
    });

    it("swallows reconnect errors while retrying discover-weekly prisma reads", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        const retryable = new Prisma.PrismaClientKnownRequestError(
            "temporary disconnect",
        );
        (prisma.discoveryBatch.findMany as jest.Mock)
            .mockRejectedValueOnce(retryable)
            .mockResolvedValueOnce([]);
        (prisma.$connect as jest.Mock).mockRejectedValueOnce(
            new Error("reconnect failed"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.checkStuckBatches()).resolves.toBe(
            0,
        );
        expect(prisma.discoveryBatch.findMany).toHaveBeenCalledTimes(2);
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
    });

    it("marks failed acquisitions and triggers completion check during playlist generation", async () => {
        const { prisma, tx, acquisitionService, discoveryBatchLogger } =
            setupDiscoverWeeklyMocks();
        (
            prisma.userDiscoverConfig.findUnique as jest.Mock
        ).mockResolvedValueOnce({
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
        jest.spyOn(
            discoverWeeklyService as any,
            "prefetchSimilarArtists",
        ).mockResolvedValue(new Map([["seed-1", []]]));
        jest.spyOn(
            discoverWeeklyService as any,
            "findRecommendedAlbumsMultiStrategy",
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

        await expect(
            discoverWeeklyService.generatePlaylist("user-2"),
        ).resolves.toEqual(expect.objectContaining({ success: true }));

        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-fail-1" },
                data: expect.objectContaining({
                    status: "failed",
                    error: "no sources available",
                }),
            }),
        );
        expect(discoveryBatchLogger.error).toHaveBeenCalledWith(
            tx.discoveryBatch.create.mock.results[0]?.value?.id ||
                expect.any(String),
            expect.stringContaining("Failed to acquire Album X"),
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
        jest.spyOn(
            require("../discoverWeekly").discoverWeeklyService as any,
            "cleanupFailedArtists",
        ).mockResolvedValue(undefined);
        jest.spyOn(
            require("../discoverWeekly").discoverWeeklyService as any,
            "cleanupOrphanedLidarrQueue",
        ).mockResolvedValue(undefined);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const cleanupFailedSpy = jest
            .spyOn(discoverWeeklyService as any, "cleanupFailedArtists")
            .mockResolvedValue(undefined);
        const cleanupQueueSpy = jest
            .spyOn(discoverWeeklyService as any, "cleanupOrphanedLidarrQueue")
            .mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-final"),
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
            }),
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
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce(
            null,
        );
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
        await expect(
            discoverWeeklyService.reconcileDiscoveryTracks(),
        ).resolves.toEqual({
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
                "user-1",
            ),
        ).resolves.toBeUndefined();

        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-extra-1" },
                data: expect.objectContaining({
                    status: "cancelled",
                }),
            }),
        );
        expect(lidarrService.deleteArtist).toHaveBeenCalledWith(
            "artist-extra",
            true,
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
                "The Album Name (Remaster)",
            ),
        ).resolves.toBe(true);
    });

    it("checks exclusion lookup and aggregates user top genres from canonical plus user tags", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoverExclusion.findFirst as jest.Mock).mockResolvedValueOnce(
            {
                id: "ex-1",
            },
        );
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
            (discoverWeeklyService as any).isAlbumExcluded("rg-1", "user-1"),
        ).resolves.toBe(true);
        await expect(
            (discoverWeeklyService as any).getUserTopGenres("user-1"),
        ).resolves.toEqual(
            expect.arrayContaining(["indie", "post-rock", "rock"]),
        );
    });

    it("retries discover-weekly prisma reads on unknown-request engine-empty errors", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        (prisma.discoveryBatch.findMany as jest.Mock)
            .mockRejectedValueOnce(
                new Prisma.PrismaClientUnknownRequestError(
                    "Response from the Engine was empty",
                ),
            )
            .mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.checkStuckBatches()).resolves.toBe(
            0,
        );

        expect(prisma.discoveryBatch.findMany).toHaveBeenCalledTimes(2);
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
    });

    it("returns empty recommendations when similar cache has no artists", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const recommendations = await (
            discoverWeeklyService as any
        ).findRecommendedAlbums(
            [{ name: "Seed Artist", mbid: "seed-1" }],
            new Map([["seed-1", []]]),
            3,
            "user-1",
        );

        expect(recommendations).toEqual([]);
    });

    it("evaluates album candidates for an artist across duplicate/owned/excluded and valid branches", async () => {
        const { lastFmService, musicBrainzService } =
            setupDiscoverWeeklyMocks();
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
        (
            discoveryModule.discoverySeeding.isAlbumOwned as jest.Mock
        ).mockImplementation(async (rgMbid: string) => rgMbid === "rg-owned");

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(
            discoverWeeklyService as any,
            "isAlbumOwnedByName",
        ).mockResolvedValue(false);
        jest.spyOn(
            discoverWeeklyService as any,
            "isAlbumExcluded",
        ).mockImplementation(
            async (rgMbid: unknown) => rgMbid === "rg-excluded",
        );

        const result = await (
            discoverWeeklyService as any
        ).findValidAlbumForArtist(
            { name: "Candidate Artist", mbid: "artist-mbid", match: 0.63 },
            "user-1",
            new Set<string>(["rg-dup"]),
        );

        expect(result.recommendation).toEqual(
            expect.objectContaining({
                artistName: "Candidate Artist",
                albumTitle: "Valid Album",
                albumMbid: "rg-valid",
            }),
        );
        expect(result.skippedDuplicate).toBeGreaterThan(0);
        expect(result.skippedNoMbid).toBeGreaterThan(0);
        expect(result.skippedOwned).toBeGreaterThan(0);
        expect(result.skippedExcluded).toBeGreaterThan(0);
    });

    it("uses fallback genres in tag exploration and returns wildcard recommendations", async () => {
        const { lastFmService, musicBrainzService } =
            setupDiscoverWeeklyMocks();
        (lastFmService.getTopAlbumsByTag as jest.Mock).mockResolvedValue([
            { name: "Live Session", artist: { name: "Skip Artist" } },
            { name: "Studio Cut", artist: { name: "Keep Artist" } },
        ]);
        (musicBrainzService.searchAlbum as jest.Mock).mockResolvedValue({
            id: "rg-studio",
        });

        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.isAlbumOwned as jest.Mock
        ).mockResolvedValue(false);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(
            discoverWeeklyService as any,
            "getUserTopGenres",
        ).mockResolvedValue([]);
        jest.spyOn(
            discoverWeeklyService as any,
            "isAlbumOwnedByName",
        ).mockResolvedValue(false);
        jest.spyOn(
            discoverWeeklyService as any,
            "isAlbumExcluded",
        ).mockResolvedValue(false);
        jest.spyOn(
            discoverWeeklyService as any,
            "isArtistInLibrary",
        ).mockResolvedValue(false);

        const wildcardResults = await (
            discoverWeeklyService as any
        ).tagExplorationStrategy("user-1", 1, new Set<string>());

        expect(wildcardResults).toHaveLength(1);
        expect(wildcardResults[0]).toEqual(
            expect.objectContaining({
                artistName: "Keep Artist",
                albumTitle: "Studio Cut",
                albumMbid: "rg-studio",
                tier: "wildcard",
            }),
        );
    });

    it("builds multi-strategy recommendations using existing-artist fallback and wildcard injection", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(
            discoverWeeklyService as any,
            "isArtistInLibrary",
        ).mockResolvedValue(true);
        jest.spyOn(
            discoverWeeklyService as any,
            "findValidAlbumForArtist",
        ).mockImplementation(async (artist: any) => ({
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
        jest.spyOn(
            discoverWeeklyService as any,
            "tagExplorationStrategy",
        ).mockResolvedValue([
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
                            {
                                name: "High Artist",
                                mbid: "artist-high",
                                match: 0.92,
                            },
                            {
                                name: "Medium Artist",
                                mbid: "artist-medium",
                                match: 0.6,
                            },
                            {
                                name: "Explore Artist",
                                mbid: "artist-explore",
                                match: 0.41,
                            },
                        ],
                    ],
                ]),
                4,
                "user-1",
            );

        expect(recommendations).toHaveLength(4);
        expect(
            recommendations.some(
                (recommendation: any) => recommendation.tier === "wildcard",
            ),
        ).toBe(true);
    });

    it("fills recommendations via pass-1 new artists then pass-2 existing-artist fallback", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(
            discoverWeeklyService as any,
            "isArtistInLibrary",
        ).mockImplementation(async (artistName: unknown) => {
            return artistName === "Existing Artist";
        });
        jest.spyOn(
            discoverWeeklyService as any,
            "findValidAlbumForArtist",
        ).mockImplementation(async (artist: any) => {
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

        const recommendations = await (
            discoverWeeklyService as any
        ).findRecommendedAlbums(
            [{ name: "Seed One", mbid: "seed-1" }],
            new Map([
                [
                    "seed-1",
                    [
                        {
                            name: "Fresh Artist",
                            mbid: "artist-fresh",
                            match: 0.74,
                        },
                        {
                            name: "Existing Artist",
                            mbid: "artist-existing",
                            match: 0.62,
                        },
                    ],
                ],
            ]),
            2,
            "user-1",
        );

        expect(recommendations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ albumMbid: "rg-fresh" }),
                expect.objectContaining({ albumMbid: "rg-existing" }),
            ]),
        );
    });

    it("uses tier selection first and then fill selection for remaining multi-strategy slots", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(
            discoverWeeklyService as any,
            "isArtistInLibrary",
        ).mockResolvedValue(false);
        jest.spyOn(
            discoverWeeklyService as any,
            "findValidAlbumForArtist",
        ).mockImplementation(async (artist: any) => ({
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
        jest.spyOn(
            discoverWeeklyService as any,
            "tagExplorationStrategy",
        ).mockResolvedValue([]);

        const recommendations =
            await discoverWeeklyService.findRecommendedAlbumsMultiStrategy(
                [{ name: "Seed One", mbid: "seed-1" }],
                new Map([
                    [
                        "seed-1",
                        [
                            { name: "High One", mbid: "high-1", match: 0.91 },
                            { name: "High Two", mbid: "high-2", match: 0.82 },
                            {
                                name: "Medium One",
                                mbid: "medium-1",
                                match: 0.6,
                            },
                        ],
                    ],
                ]),
                4,
                "user-1",
            );

        expect(recommendations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ albumMbid: "rg-high-1" }),
                expect.objectContaining({ albumMbid: "rg-high-2" }),
                expect.objectContaining({ albumMbid: "rg-medium-1" }),
            ]),
        );
    });

    it("retries discover-weekly prisma reads on rust panic and generic retryable string failures", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        (prisma.discoveryBatch.findMany as jest.Mock)
            .mockRejectedValueOnce(
                new Prisma.PrismaClientRustPanicError("panic in query engine"),
            )
            .mockRejectedValueOnce("Can't reach database server")
            .mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(discoverWeeklyService.checkStuckBatches()).resolves.toBe(
            0,
        );

        expect(prisma.discoveryBatch.findMany).toHaveBeenCalledTimes(3);
        expect(prisma.$connect).toHaveBeenCalledTimes(2);
    });

    it("fails generation when no seed artists are available", async () => {
        const { prisma, discoveryLogger } = setupDiscoverWeeklyMocks();
        (
            prisma.userDiscoverConfig.findUnique as jest.Mock
        ).mockResolvedValueOnce({
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
            discoverWeeklyService.generatePlaylist("user-no-seeds"),
        ).rejects.toThrow("No seed artists found - need listening history");
        expect(discoveryLogger.end).toHaveBeenCalledWith(
            false,
            "No seed artists",
        );
    });

    it("fails generation when recommendation strategies return no albums", async () => {
        const { prisma, discoveryLogger } = setupDiscoverWeeklyMocks();
        (
            prisma.userDiscoverConfig.findUnique as jest.Mock
        ).mockResolvedValueOnce({
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
        jest.spyOn(
            discoverWeeklyService as any,
            "prefetchSimilarArtists",
        ).mockResolvedValue(
            new Map([
                ["seed-1", [{ name: "Sim Artist", mbid: "sim-1", match: 0.7 }]],
            ]),
        );
        jest.spyOn(
            discoverWeeklyService as any,
            "findRecommendedAlbumsMultiStrategy",
        ).mockResolvedValue([]);

        await expect(
            discoverWeeklyService.generatePlaylist("user-no-recs"),
        ).rejects.toThrow("No recommendations found");
        expect(discoveryLogger.end).toHaveBeenCalledWith(
            false,
            "No recommendations found",
        );
    });

    it("warns on low recommendation threshold and skips duplicate queued download jobs", async () => {
        const { prisma, tx, discoveryBatchLogger } = setupDiscoverWeeklyMocks();
        (
            prisma.userDiscoverConfig.findUnique as jest.Mock
        ).mockResolvedValueOnce({
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
        jest.spyOn(
            discoverWeeklyService as any,
            "prefetchSimilarArtists",
        ).mockResolvedValue(
            new Map([
                [
                    "seed-1",
                    [{ name: "Sim Artist", mbid: "sim-1", match: 0.55 }],
                ],
            ]),
        );
        jest.spyOn(
            discoverWeeklyService as any,
            "findRecommendedAlbumsMultiStrategy",
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
            discoverWeeklyService.generatePlaylist("user-threshold"),
        ).resolves.toEqual(
            expect.objectContaining({
                success: true,
            }),
        );

        expect(discoveryBatchLogger.warn).toHaveBeenCalledWith(
            "threshold-check",
            expect.stringContaining("Low recommendations"),
        );
        expect(tx.downloadJob.create).not.toHaveBeenCalled();
        expect(completionSpy).toHaveBeenCalledWith("batch-created");
    });

    it("counts all-settled acquisition promise rejections as failed downloads", async () => {
        const { prisma, acquisitionService, discoveryBatchLogger } =
            setupDiscoverWeeklyMocks();
        (
            prisma.userDiscoverConfig.findUnique as jest.Mock
        ).mockResolvedValueOnce({
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
        jest.spyOn(
            discoverWeeklyService as any,
            "prefetchSimilarArtists",
        ).mockResolvedValue(new Map([["seed-1", []]]));
        jest.spyOn(
            discoverWeeklyService as any,
            "findRecommendedAlbumsMultiStrategy",
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
            expect.stringContaining("downloads started"),
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
            .mockResolvedValueOnce([
                { name: "Retry Artist", mbid: "retry-1", match: 0.7 },
            ])
            .mockResolvedValueOnce([
                { name: "Artist 2", mbid: "a2", match: 0.6 },
            ])
            .mockResolvedValueOnce([
                { name: "Artist 3", mbid: "a3", match: 0.5 },
            ])
            .mockResolvedValueOnce([
                { name: "Artist 4", mbid: "a4", match: 0.4 },
            ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const prefetchPromise = (
            discoverWeeklyService as any
        ).prefetchSimilarArtists([
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
            expect.arrayContaining([
                expect.objectContaining({ name: "Retry Artist" }),
            ]),
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
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupFailedArtists",
        ).mockResolvedValue(undefined);
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupOrphanedLidarrQueue",
        ).mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-normalized"),
        ).resolves.toBeUndefined();

        expect(prisma.album.findMany).toHaveBeenCalledTimes(1);
        expect(tx.discoveryAlbum.upsert).toHaveBeenCalledTimes(1);
        expect(tx.discoveryTrack.create).toHaveBeenCalledTimes(1);
        expect(tx.discoveryBatch.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "batch-normalized" },
                data: expect.objectContaining({ status: "completed" }),
            }),
        );
    });

    it("exposes discover-weekly proxy helper behavior and wildcard tier mapping", async () => {
        setupDiscoverWeeklyMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { __discoverWeeklyTestables } = require("../discoverWeekly");
        const rootMethod = jest.fn(async (value: string) => `root:${value}`);
        const nestedMethod = jest.fn(
            async (value: string) => `nested:${value}`,
        );

        const proxied = __discoverWeeklyTestables.createPrismaRetryProxy(
            {
                ping: rootMethod,
                discoveryBatch: {
                    findMany: nestedMethod,
                    modelName: "DiscoveryBatch",
                },
                version: "1.0.0",
            } as any,
            "discoverProxy",
        );

        await expect(proxied.ping("ok")).resolves.toBe("root:ok");
        await expect(proxied.discoveryBatch.findMany("query")).resolves.toBe(
            "nested:query",
        );
        expect(proxied.version).toBe("1.0.0");
        expect(proxied.discoveryBatch.modelName).toBe("DiscoveryBatch");
        expect(__discoverWeeklyTestables.getTierFromSimilarity(0.1)).toBe(
            "wildcard",
        );
    });
});
