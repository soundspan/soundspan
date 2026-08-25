import { setupDiscoverWeeklyMocks } from "./discoverWeeklyRuntime.helpers";

describe("discover weekly runtime behavior", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.resetModules();
        jest.clearAllMocks();
    });

    it("returns early when batch completion check is invoked for a missing batch id", async () => {
        const { prisma } = setupDiscoverWeeklyMocks();
        (prisma.discoveryBatch.findUnique as jest.Mock).mockResolvedValueOnce(
            null,
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            discoverWeeklyService.checkBatchCompletion("batch-missing"),
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
        const cache = await (
            discoverWeeklyService as any
        ).prefetchSimilarArtists([{ name: "Seed One", mbid: "seed-1" }]);

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
                        artist: {
                            name: "Discovery Artist",
                            mbid: "artist-discovery",
                        },
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
                        artist: {
                            name: "Seed Anchor Artist",
                            mbid: "artist-seed-anchor",
                        },
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
                        artist: {
                            name: "Popular Anchor Artist",
                            mbid: "artist-pop-anchor",
                        },
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
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupFailedArtists",
        ).mockResolvedValue(undefined);
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupOrphanedLidarrQueue",
        ).mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-anchor-fill"),
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
        (prisma.track.findMany as jest.Mock).mockResolvedValueOnce([
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
            new Error("transaction exploded"),
        );

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

        await discoverWeeklyService.buildFinalPlaylist("batch-tx-fail");

        expect(discoveryBatchLogger.error).toHaveBeenCalledWith(
            "batch-tx-fail",
            expect.stringContaining("Transaction failed"),
        );
        expect(discoveryBatchLogger.error).toHaveBeenCalledWith(
            "batch-tx-fail",
            "Transaction failed - no records created",
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
                metadata: {
                    artistName: "No MBID",
                    albumTitle: "No MBID Album",
                },
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
        await expect(
            discoverWeeklyService.reconcileDiscoveryTracks(),
        ).resolves.toEqual({
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
                "Direct Album",
            ),
        ).resolves.toBe(true);
        await expect(
            (discoverWeeklyService as any).isAlbumOwnedByName(
                "Missing Artist",
                "Missing Album",
            ),
        ).resolves.toBe(false);
    });

    it("covers findValidAlbumForArtist early return and catch branches for ownership/exclusion checks", async () => {
        const { lastFmService, musicBrainzService } =
            setupDiscoverWeeklyMocks();
        const discoveryModule = require("../discovery");

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const ownedSpy = discoveryModule.discoverySeeding
            .isAlbumOwned as jest.Mock;
        const ownedByNameSpy = jest.spyOn(
            discoverWeeklyService as any,
            "isAlbumOwnedByName",
        );
        const excludedSpy = jest.spyOn(
            discoverWeeklyService as any,
            "isAlbumExcluded",
        );

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
                new Set<string>(),
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                recommendation: null,
                albumsChecked: 0,
            }),
        );
        await expect(
            (discoverWeeklyService as any).findValidAlbumForArtist(
                { name: "Owned Throw Artist", mbid: "artist-owned-throw" },
                "user-1",
                new Set<string>(),
            ),
        ).resolves.toEqual(expect.objectContaining({ recommendation: null }));
        await expect(
            (discoverWeeklyService as any).findValidAlbumForArtist(
                {
                    name: "Owned Name Throw Artist",
                    mbid: "artist-owned-name-throw",
                },
                "user-1",
                new Set<string>(),
            ),
        ).resolves.toEqual(expect.objectContaining({ recommendation: null }));
        await expect(
            (discoverWeeklyService as any).findValidAlbumForArtist(
                {
                    name: "Excluded Throw Artist",
                    mbid: "artist-excluded-throw",
                },
                "user-1",
                new Set<string>(),
            ),
        ).resolves.toEqual(expect.objectContaining({ recommendation: null }));
        await expect(
            (discoverWeeklyService as any).findValidAlbumForArtist(
                { name: "TopAlbums Throw Artist", mbid: "artist-lastfm-throw" },
                "user-1",
                new Set<string>(),
            ),
        ).resolves.toEqual(expect.objectContaining({ recommendation: null }));
    });

    it("returns empty genres when play-history lookup throws and swallows tag-exploration fetch errors", async () => {
        const { prisma, lastFmService } = setupDiscoverWeeklyMocks();
        (prisma.play.findMany as jest.Mock).mockRejectedValueOnce(
            new Error("play query failed"),
        );
        (lastFmService.getTopAlbumsByTag as jest.Mock).mockRejectedValueOnce(
            new Error("tag lookup failed"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).getUserTopGenres("user-1"),
        ).resolves.toEqual([]);
        jest.spyOn(
            discoverWeeklyService as any,
            "getUserTopGenres",
        ).mockResolvedValue(["ambient"]);
        await expect(
            (discoverWeeklyService as any).tagExplorationStrategy(
                "user-1",
                1,
                new Set<string>(),
            ),
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
                        artist: {
                            name: "Name Artist",
                            mbid: "artist-name-fallback",
                        },
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
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupFailedArtists",
        ).mockResolvedValue(undefined);
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupOrphanedLidarrQueue",
        ).mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-name-fallback"),
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
            })),
        );
        (prisma.track.findMany as jest.Mock).mockImplementation(
            async (query: any) => {
                if (query?.where?.album?.rgMbid) {
                    const rgMbid = query.where.album.rgMbid;
                    return [
                        {
                            id: `track-${rgMbid}`,
                            title: `Track ${rgMbid}`,
                            filePath:
                                rgMbid === "rg-popular-0"
                                    ? null
                                    : `/music/${rgMbid}.flac`,
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

                if (
                    query?.where?.album?.location?.in?.includes("FEDERATED") &&
                    !query?.orderBy
                ) {
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

                if (
                    query?.where?.album?.location === "LIBRARY" &&
                    query?.orderBy
                ) {
                    return [
                        {
                            id: "track-popular-anchor-only",
                            filePath: null,
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
            },
        );
        const discoveryModule = require("../discovery");
        (
            discoveryModule.discoverySeeding.getSeedArtists as jest.Mock
        ).mockResolvedValue([{ name: "Seed One", mbid: "seed-1" }]);

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
            discoverWeeklyService.buildFinalPlaylist("batch-popular-anchor"),
        ).resolves.toBeUndefined();

        expect(tx.discoveryTrack.create).toHaveBeenCalled();
        expect(tx.discoveryTrack.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    trackId: "track-rg-popular-0",
                    fileName: "Track rg-popular-0",
                    filePath: "",
                }),
            }),
        );
        expect(prisma.track.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    album: expect.objectContaining({
                        location: { in: ["LIBRARY", "FEDERATED"] },
                    }),
                }),
                orderBy: expect.any(Object),
            }),
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
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupFailedArtists",
        ).mockResolvedValue(undefined);
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupOrphanedLidarrQueue",
        ).mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-no-tracks"),
        ).resolves.toBeUndefined();

        expect(discoveryBatchLogger.error).toHaveBeenCalledWith(
            "batch-no-tracks",
            "No tracks found after scan",
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
                "batch-settings-missing",
            ),
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
                "batch-no-lidarr-refs",
            ),
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
                "batch-queue-safe",
            ),
        ).resolves.toBeUndefined();
        await expect(
            (discoverWeeklyService as any).cleanupOrphanedLidarrQueue(
                "batch-queue-error",
            ),
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
            },
        );
        (lidarrService.deleteArtistById as jest.Mock).mockRejectedValueOnce(
            new Error("delete failed"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupFailedArtists(
                "batch-cleanup-edges",
            ),
        ).resolves.toBeUndefined();

        expect(lidarrService.deleteArtistById).toHaveBeenCalledWith(22, true);
        expect(discoveryBatchLogger.info).toHaveBeenCalledWith(
            "batch-cleanup-edges",
            expect.stringContaining("failed artists removed"),
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
                "user-1",
            ),
        ).resolves.toBeUndefined();

        expect(prisma.downloadJob.update).toHaveBeenCalledTimes(2);
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: "job-skip" } }),
        );
        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: "job-no-lidarr-id" } }),
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
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce(
            null,
        );
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
            new Error("transaction create failed"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            discoverWeeklyService.reconcileDiscoveryTracks(),
        ).resolves.toEqual({
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
            new Error("anchor lookup failed"),
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
                { id: "batch-replace-dup", userId: "user-1" },
            ),
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
        jest.spyOn(
            discoverWeeklyService as any,
            "isArtistInLibrary",
        ).mockResolvedValue(true);
        jest.spyOn(
            discoverWeeklyService as any,
            "isAlbumExcluded",
        ).mockResolvedValue(false);

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
                { id: "batch-replace-library", userId: "user-1" },
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                artistName: "Anchor Artist",
                albumTitle: "Anchor Album",
                albumMbid: "rg-anchor",
                isLibraryAnchor: true,
            }),
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
        (discoveryModule.discoverySeeding.isAlbumOwned as jest.Mock)
            .mockRejectedValueOnce(new Error("owned check failed"))
            .mockResolvedValueOnce(false);
        (prisma.album.findFirst as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(
            discoverWeeklyService as any,
            "isArtistInLibrary",
        ).mockRejectedValue(new Error("library check failed"));
        jest.spyOn(
            discoverWeeklyService as any,
            "isAlbumExcluded",
        ).mockRejectedValueOnce(new Error("excluded check failed"));

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
                { id: "batch-replace-error", userId: "user-1" },
            ),
        ).resolves.toBeNull();
    });

    it("continues recommendation discovery when artist-library lookups throw", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(
            discoverWeeklyService as any,
            "isArtistInLibrary",
        ).mockRejectedValue(new Error("library lookup failed"));
        jest.spyOn(
            discoverWeeklyService as any,
            "findValidAlbumForArtist",
        ).mockResolvedValue({
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

        const recommendations = await (
            discoverWeeklyService as any
        ).findRecommendedAlbums(
            [{ name: "Seed One", mbid: "seed-1" }],
            new Map([
                [
                    "seed-1",
                    [
                        {
                            name: "Recovered Artist",
                            mbid: "artist-recovered",
                            match: 0.7,
                        },
                    ],
                ],
            ]),
            1,
            "user-1",
        );

        expect(recommendations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ albumMbid: "rg-recovered" }),
            ]),
        );
    });

    it("logs no-albums-returned warning when similar artists produce zero album checks", async () => {
        setupDiscoverWeeklyMocks();
        const loggerModule = require("../../utils/logger");
        const logger = loggerModule.logger as { debug: jest.Mock };

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(
            discoverWeeklyService as any,
            "isArtistInLibrary",
        ).mockResolvedValue(false);
        jest.spyOn(
            discoverWeeklyService as any,
            "findValidAlbumForArtist",
        ).mockResolvedValue({
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
                        [
                            {
                                name: "No Albums Artist",
                                mbid: "artist-no-albums",
                                match: 0.6,
                            },
                        ],
                    ],
                ]),
                1,
                "user-1",
            ),
        ).resolves.toEqual([]);

        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("No albums returned from Last.fm"),
        );
    });

    it("logs all-musicbrainz-failed warning when every checked album lacks a resolvable MBID", async () => {
        setupDiscoverWeeklyMocks();
        const loggerModule = require("../../utils/logger");
        const logger = loggerModule.logger as { debug: jest.Mock };

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(
            discoverWeeklyService as any,
            "isArtistInLibrary",
        ).mockResolvedValue(false);
        jest.spyOn(
            discoverWeeklyService as any,
            "findValidAlbumForArtist",
        ).mockResolvedValue({
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
                        [
                            {
                                name: "No MBID Artist",
                                mbid: "artist-no-mbid",
                                match: 0.6,
                            },
                        ],
                    ],
                ]),
                1,
                "user-1",
            ),
        ).resolves.toEqual([]);

        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("All albums failed MusicBrainz lookup"),
        );
    });

    it("logs all-owned warning when every checked album is already owned", async () => {
        setupDiscoverWeeklyMocks();
        const loggerModule = require("../../utils/logger");
        const logger = loggerModule.logger as { debug: jest.Mock };

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(
            discoverWeeklyService as any,
            "isArtistInLibrary",
        ).mockResolvedValue(false);
        jest.spyOn(
            discoverWeeklyService as any,
            "findValidAlbumForArtist",
        ).mockResolvedValue({
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
                        [
                            {
                                name: "Owned Artist",
                                mbid: "artist-owned",
                                match: 0.6,
                            },
                        ],
                    ],
                ]),
                1,
                "user-1",
            ),
        ).resolves.toEqual([]);

        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("All albums already owned"),
        );
    });

    it("counts owned-by-name matches as owned skips in findValidAlbumForArtist", async () => {
        const { lastFmService, musicBrainzService } =
            setupDiscoverWeeklyMocks();
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
        jest.spyOn(
            discoverWeeklyService as any,
            "isAlbumOwnedByName",
        ).mockResolvedValue(true);
        jest.spyOn(
            discoverWeeklyService as any,
            "isAlbumExcluded",
        ).mockResolvedValue(false);

        await expect(
            (discoverWeeklyService as any).findValidAlbumForArtist(
                { name: "Owned By Name Artist", mbid: "artist-owned-by-name" },
                "user-1",
                new Set<string>(),
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                recommendation: null,
                skippedOwned: 1,
            }),
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
                    "Engine has already exited",
                ),
            ),
        ).toBe(true);
        expect(
            __discoverWeeklyTestables.isRetryableDiscoverWeeklyPrismaError(
                new Prisma.PrismaClientUnknownRequestError(""),
            ),
        ).toBe(false);
        expect(
            __discoverWeeklyTestables.isRetryableDiscoverWeeklyPrismaError(
                undefined,
            ),
        ).toBe(false);
    });

    it("uses default generation fallbacks for ratios, missing seed mbids, NaN similarities, and non-soulseek acquisitions", async () => {
        const { prisma, acquisitionService } = setupDiscoverWeeklyMocks();
        (
            prisma.userDiscoverConfig.findUnique as jest.Mock
        ).mockResolvedValueOnce({
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
        jest.spyOn(
            discoverWeeklyService as any,
            "prefetchSimilarArtists",
        ).mockResolvedValue(new Map([["external-key", []]]));
        jest.spyOn(
            discoverWeeklyService as any,
            "findRecommendedAlbumsMultiStrategy",
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
            discoverWeeklyService.generatePlaylist("user-fallbacks"),
        ).resolves.toEqual(expect.objectContaining({ success: true }));

        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-fallback-1" },
                data: expect.objectContaining({
                    status: "processing",
                    lidarrRef: null,
                    completedAt: null,
                }),
            }),
        );
    });

    it("uses empty-string mbid fallback for similar-artist prefetch cache keys", async () => {
        const { lastFmService } = setupDiscoverWeeklyMocks();
        (lastFmService.getSimilarArtists as jest.Mock).mockResolvedValueOnce(
            [],
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        const cache = await (
            discoverWeeklyService as any
        ).prefetchSimilarArtists([{ name: "Seed Name Only" }]);

        expect(lastFmService.getSimilarArtists).toHaveBeenCalledWith(
            "",
            "Seed Name Only",
            20,
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

        await expect(discoverWeeklyService.checkStuckBatches()).resolves.toBe(
            1,
        );
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
            }),
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
                        artist: {
                            name: "Name Artist",
                            mbid: "artist-name-only",
                        },
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
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupFailedArtists",
        ).mockResolvedValue(undefined);
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupOrphanedLidarrQueue",
        ).mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-name-only"),
        ).resolves.toBeUndefined();

        expect(tx.discoveryTrack.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    fileName: "",
                }),
            }),
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
                "batch-missing",
            ),
        ).resolves.toBeUndefined();
        await expect(
            (discoverWeeklyService as any).cleanupOrphanedLidarrQueue(
                "batch-empty-queue",
            ),
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
            (discoverWeeklyService as any).cleanupFailedArtists(
                "batch-missing",
            ),
        ).resolves.toBeUndefined();
        await expect(
            (discoverWeeklyService as any).cleanupFailedArtists(
                "batch-no-mbid-artists",
            ),
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
                "user-1",
            ),
        ).resolves.toBeUndefined();

        expect(prisma.downloadJob.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-unknown-meta" },
                data: expect.objectContaining({
                    status: "cancelled",
                }),
            }),
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
                "Short Title Deluxe Edition",
            ),
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
            {
                name: "Failed Artist Duplicate",
                mbid: "artist-failed",
                match: 0.8,
            },
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
        ).mockImplementation(
            async (rgMbid: string) => rgMbid === "rg-owned-candidate",
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(
            discoverWeeklyService as any,
            "isArtistInLibrary",
        ).mockResolvedValue(false);
        jest.spyOn(
            discoverWeeklyService as any,
            "isAlbumExcluded",
        ).mockImplementation(async (...args: unknown[]) => {
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
                { id: "batch-replacement", userId: "user-1" },
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                artistName: "Candidate Artist",
                albumTitle: "Valid Candidate Album",
                albumMbid: "rg-valid-candidate",
                similarity: 0.5,
            }),
        );
    });

    it("uses seed-name cache fallback and exercises recommendation loop break/continue branches", async () => {
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
        ).mockImplementation(async (artist: any) => {
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

        const recommendations = await (
            discoverWeeklyService as any
        ).findRecommendedAlbums(
            [{ name: "Seed Name Only" }, { name: "Seed Missing" }],
            new Map([
                [
                    "Seed Name Only",
                    [
                        { name: "Artist One", mbid: "artist-one", match: 0.8 },
                        {
                            name: "Artist One",
                            mbid: "artist-one-dup",
                            match: 0.8,
                        },
                        { name: "Artist Two", mbid: "artist-two", match: 0.75 },
                        {
                            name: "Artist Three",
                            mbid: "artist-three",
                            match: 0.74,
                        },
                    ],
                ],
            ]),
            2,
            "user-1",
        );

        expect(recommendations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ albumMbid: "rg-artist-one" }),
                expect.objectContaining({ albumMbid: "rg-artist-two" }),
            ]),
        );
    });

    it("uses pass-two fallback break behavior once target recommendations are reached", async () => {
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
        ).mockImplementation(async (artist: any) => {
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

        const recommendations = await (
            discoverWeeklyService as any
        ).findRecommendedAlbums(
            [{ name: "Seed One", mbid: "seed-1" }],
            new Map([
                [
                    "seed-1",
                    [
                        {
                            name: "Existing One",
                            mbid: "existing-one",
                            match: 0.7,
                        },
                        {
                            name: "Existing Two",
                            mbid: "existing-two",
                            match: 0.68,
                        },
                    ],
                ],
            ]),
            1,
            "user-1",
        );

        expect(recommendations).toHaveLength(1);
        expect(recommendations[0]).toEqual(
            expect.objectContaining({ albumMbid: "rg-existing-one" }),
        );
    });

    it("uses blank artist mbids and default recommendation similarity in valid-album discovery", async () => {
        const { lastFmService, musicBrainzService } =
            setupDiscoverWeeklyMocks();
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
        jest.spyOn(
            discoverWeeklyService as any,
            "isAlbumOwnedByName",
        ).mockResolvedValue(false);
        jest.spyOn(
            discoverWeeklyService as any,
            "isAlbumExcluded",
        ).mockResolvedValue(false);

        await expect(
            (discoverWeeklyService as any).findValidAlbumForArtist(
                { name: "No MBID Artist" },
                "user-1",
                new Set<string>(),
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                recommendation: expect.objectContaining({
                    albumMbid: "rg-fresh-album",
                    similarity: 0.5,
                }),
            }),
        );
        expect(lastFmService.getArtistTopAlbums).toHaveBeenCalledWith(
            "",
            "No MBID Artist",
            10,
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
            (discoverWeeklyService as any).getUserTopGenres("user-1"),
        ).resolves.toEqual(expect.arrayContaining(["rock"]));
    });

    it("skips invalid tag-exploration candidates before returning the first eligible wildcard", async () => {
        const { lastFmService, musicBrainzService } =
            setupDiscoverWeeklyMocks();
        (lastFmService.getTopAlbumsByTag as jest.Mock).mockResolvedValueOnce([
            { name: "Seen Album", artist: "String Artist" },
            { name: null, artist: { name: "Missing Name Artist" } },
            { name: "Owned Album", artist: { name: "Owned Artist" } },
            {
                name: "Owned By Name Album",
                artist: { name: "Owned Name Artist" },
            },
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
        jest.spyOn(
            discoverWeeklyService as any,
            "getUserTopGenres",
        ).mockResolvedValue(["rock"]);
        jest.spyOn(
            discoverWeeklyService as any,
            "isAlbumOwnedByName",
        ).mockImplementation(async (...args: unknown[]) => {
            const album = args[1] as string;
            return album === "Owned By Name Album";
        });
        jest.spyOn(
            discoverWeeklyService as any,
            "isAlbumExcluded",
        ).mockImplementation(async (...args: unknown[]) => {
            const rgMbid = args[0] as string;
            return rgMbid === "rg-excluded";
        });
        jest.spyOn(
            discoverWeeklyService as any,
            "isArtistInLibrary",
        ).mockImplementation(async (...args: unknown[]) => {
            const artistName = args[0] as string;
            return artistName === "Library Artist";
        });

        const recommendations = await (
            discoverWeeklyService as any
        ).tagExplorationStrategy("user-1", 1, new Set<string>(["rg-seen"]));

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
                        artist: {
                            name: "Direct Artist",
                            mbid: "artist-direct",
                        },
                    },
                },
                {
                    id: "track-mbid-b",
                    filePath: "/music/direct-b.flac",
                    album: {
                        id: "album-direct",
                        title: "Direct Album",
                        rgMbid: "rg-mbid-direct",
                        artist: {
                            name: "Direct Artist",
                            mbid: "artist-direct",
                        },
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
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupFailedArtists",
        ).mockResolvedValue(undefined);
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupOrphanedLidarrQueue",
        ).mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-mbid-direct"),
        ).resolves.toBeUndefined();

        expect(prisma.album.findMany).not.toHaveBeenCalled();
    });
});
