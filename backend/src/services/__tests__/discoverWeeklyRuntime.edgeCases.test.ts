import { setupDiscoverWeeklyMocks } from "./discoverWeeklyRuntime.helpers";

describe("discover weekly runtime behavior", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.resetModules();
        jest.clearAllMocks();
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
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce(
            null,
        );
        (prisma.track.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "track-name-only",
                filePath: "",
                album: {
                    id: "album-name-only",
                    title: "Name Only Album",
                    rgMbid: "rg-name-only",
                    artist: {
                        name: "Name Only Artist",
                        mbid: "artist-name-only",
                    },
                },
            },
        ]);
        (tx.discoveryTrack.findFirst as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            discoverWeeklyService.reconcileDiscoveryTracks(),
        ).resolves.toEqual({
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
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce(
            null,
        );
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
        await expect(
            discoverWeeklyService.reconcileDiscoveryTracks(),
        ).resolves.toEqual({
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
                "batch-non-stuck",
            ),
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
                "batch-artist-branches",
            ),
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
                "user-1",
            ),
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
                "Wanted Album",
            ),
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
        (lastFmService.getSimilarArtists as jest.Mock).mockResolvedValueOnce(
            [],
        );
        (musicBrainzService.searchAlbum as jest.Mock).mockResolvedValueOnce(
            null,
        );
        (prisma.album.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "anchor-no-mbid",
            title: "Anchor No MBID Album",
            rgMbid: "rg-anchor-no-mbid",
            artist: {
                name: "Anchor No MBID Artist",
                mbid: "artist-anchor-no-mbid",
            },
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
                { id: "batch-replacement-no-mbid", userId: "user-1" },
            ),
        ).resolves.toEqual(
            expect.objectContaining({
                artistName: "Anchor No MBID Artist",
                albumTitle: "Anchor No MBID Album",
                albumMbid: "rg-anchor-no-mbid",
                isLibraryAnchor: true,
            }),
        );
    });

    it("handles null-album recommendation candidates in both primary and fallback recommendation passes", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(
            discoverWeeklyService as any,
            "isArtistInLibrary",
        ).mockImplementation(async (artistName: unknown) => {
            return artistName === "Fallback Existing Artist";
        });
        jest.spyOn(
            discoverWeeklyService as any,
            "findValidAlbumForArtist",
        ).mockImplementation(async (artist: any) => {
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

        const recommendations = await (
            discoverWeeklyService as any
        ).findRecommendedAlbums(
            [{ name: "Seed One", mbid: "seed-1" }],
            new Map([
                [
                    "seed-1",
                    [
                        {
                            name: "PassOne Null Artist",
                            mbid: "pass-one-null",
                            match: 0.7,
                        },
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
            "user-1",
        );

        expect(recommendations).toHaveLength(1);
    });

    it("evaluates multi-strategy branch paths for missing cache entries, low-match artists, and no-op fill/fallback phases", async () => {
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
        ).mockResolvedValue({
            recommendation: null,
            albumsChecked: 0,
            skippedNoMbid: 0,
            skippedOwned: 0,
            skippedExcluded: 0,
            skippedDuplicate: 0,
        });
        jest.spyOn(
            discoverWeeklyService as any,
            "tagExplorationStrategy",
        ).mockResolvedValue([]);

        const recommendations =
            await discoverWeeklyService.findRecommendedAlbumsMultiStrategy(
                [{ name: "Seed Without MBID" }, { name: "Missing Cache Seed" }],
                new Map([
                    [
                        "Seed Without MBID",
                        [
                            {
                                name: "Low Match Artist",
                                mbid: "low-match",
                                match: 0,
                            },
                            {
                                name: "Missing Match Artist",
                                mbid: "missing-match",
                            },
                        ],
                    ],
                ]),
                2,
                "user-1",
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
        await expect(discoverWeeklyService.checkStuckBatches()).resolves.toBe(
            0,
        );
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
                artist: {
                    name: "Artist Normalized",
                    mbid: "artist-normalized",
                },
                tracks: [],
            },
            {
                id: "album-normalized-empty-2",
                title: "Normalized Album",
                rgMbid: "rg-normalized-branches-2",
                artist: {
                    name: "Artist Normalized",
                    mbid: "artist-normalized",
                },
                tracks: [],
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
            discoverWeeklyService.buildFinalPlaylist(
                "batch-normalized-branches",
            ),
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
                "batch-ignore-unrelated-queue",
            ),
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
                "batch-cleanup-continued",
            ),
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
                "user-1",
            ),
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
        (musicBrainzService.searchAlbum as jest.Mock).mockResolvedValueOnce(
            null,
        );
        (prisma.album.findFirst as jest.Mock).mockResolvedValueOnce(null);

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
                { id: "batch-replacement-no-mb", userId: "user-1" },
            ),
        ).resolves.toBeNull();
    });

    it("covers recommendation null paths and multi-strategy duplicate/empty-result paths", async () => {
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
        jest.spyOn(
            discoverWeeklyService as any,
            "tagExplorationStrategy",
        ).mockResolvedValue([]);

        const passRecommendations = await (
            discoverWeeklyService as any
        ).findRecommendedAlbums(
            [{ name: "Seed One", mbid: "seed-1" }],
            new Map([
                [
                    "seed-1",
                    [
                        {
                            name: "Primary Null Artist",
                            mbid: "primary-null",
                            match: 0.8,
                        },
                        {
                            name: "Fallback Null Artist",
                            mbid: "fallback-null",
                            match: 0.79,
                        },
                        {
                            name: "Recovered Artist",
                            mbid: "recovered",
                            match: 0.78,
                        },
                    ],
                ],
            ]),
            1,
            "user-1",
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
                            {
                                name: "Fill Null Artist",
                                mbid: "fill-null",
                                match: 0.6,
                            },
                            {
                                name: "Existing Null Artist",
                                mbid: "existing-null",
                                match: 0.59,
                            },
                        ],
                    ],
                ]),
                4,
                "user-1",
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
        (prisma.discoveryAlbum.findFirst as jest.Mock).mockResolvedValueOnce(
            null,
        );
        (prisma.track.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "track-reconcile-empty-file",
                filePath: "",
                album: {
                    id: "album-reconcile-empty-file",
                    title: "Reconcile Album",
                    rgMbid: "rg-empty-file",
                    artist: {
                        name: "Reconcile Artist",
                        mbid: "artist-reconcile",
                    },
                },
            },
        ]);
        (tx.discoveryTrack.findFirst as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            discoverWeeklyService.reconcileDiscoveryTracks(),
        ).resolves.toEqual({
            batchesChecked: 1,
            tracksAdded: 1,
        });
        expect(tx.discoveryTrack.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    fileName: "",
                }),
            }),
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
                "user-1",
            ),
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
            (discoverWeeklyService as any).getUserTopGenres("user-1"),
        ).resolves.toEqual(
            expect.arrayContaining(["rock", "indie", "ambient", "drone"]),
        );
    });

    it("covers selectFromTier and fill-loop duplicate/empty recommendation branches in multi-strategy discovery", async () => {
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
        jest.spyOn(
            discoverWeeklyService as any,
            "tagExplorationStrategy",
        ).mockResolvedValue([]);

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
                            {
                                name: "MedOther",
                                mbid: "med-other",
                                match: 0.64,
                            },
                            { name: "FillDup", mbid: "fill-dup-1", match: 0.4 },
                            {
                                name: "FillDup",
                                mbid: "fill-dup-2",
                                match: 0.41,
                            },
                            {
                                name: "FillNull",
                                mbid: "fill-null",
                                match: 0.42,
                            },
                            {
                                name: "FillFinal",
                                mbid: "fill-final",
                                match: 0.43,
                            },
                            {
                                name: "FillExtra",
                                mbid: "fill-extra",
                                match: 0.44,
                            },
                        ],
                    ],
                ]),
                5,
                "user-1",
            ),
        ).resolves.toEqual(expect.any(Array));
    });

    it("covers existing-fallback duplicate/empty recommendation branches in multi-strategy discovery", async () => {
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
        jest.spyOn(
            discoverWeeklyService as any,
            "tagExplorationStrategy",
        ).mockResolvedValue([]);

        await expect(
            discoverWeeklyService.findRecommendedAlbumsMultiStrategy(
                [
                    {
                        name: "Seed Existing Branches",
                        mbid: "seed-existing-branches",
                    },
                ],
                new Map([
                    [
                        "seed-existing-branches",
                        [
                            {
                                name: "ExistingDup",
                                mbid: "existing-dup-1",
                                match: 0.61,
                            },
                            {
                                name: "ExistingDup",
                                mbid: "existing-dup-2",
                                match: 0.62,
                            },
                            {
                                name: "ExistingNull",
                                mbid: "existing-null",
                                match: 0.63,
                            },
                            {
                                name: "ExistingFinal",
                                mbid: "existing-final",
                                match: 0.64,
                            },
                            {
                                name: "ExistingAfter",
                                mbid: "existing-after",
                                match: 0.65,
                            },
                            {
                                name: "ExistingPost",
                                mbid: "existing-post",
                                match: 0.66,
                            },
                        ],
                    ],
                ]),
                4,
                "user-1",
            ),
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
                        artist: {
                            name: "Name Hit Artist",
                            mbid: "artist-name-hit",
                        },
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
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupFailedArtists",
        ).mockResolvedValue(undefined);
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupOrphanedLidarrQueue",
        ).mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist(
                "batch-name-hit-before-normalized",
            ),
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
                        artist: {
                            name: "Discovery Artist",
                            mbid: "artist-discovery",
                        },
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
                        artist: {
                            name: "Seed Shared Artist",
                            mbid: "artist-seed-shared",
                        },
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
                        artist: {
                            name: "Seed Shared Artist",
                            mbid: "artist-seed-shared",
                        },
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
                        artist: {
                            name: "Popular Shared Artist",
                            mbid: "artist-pop-shared",
                        },
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
                        artist: {
                            name: "Popular Shared Artist",
                            mbid: "artist-pop-shared",
                        },
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
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupFailedArtists",
        ).mockResolvedValue(undefined);
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupOrphanedLidarrQueue",
        ).mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist(
                "batch-anchor-guard-false",
            ),
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
                        artist: {
                            name: "Duplicate Artist",
                            mbid: "artist-duplicate",
                        },
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
            },
        );
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
            discoverWeeklyService.buildFinalPlaylist(
                "batch-duplicate-selected",
            ),
        ).resolves.toBeUndefined();
    });

    it("executes false-pass fallback branches for successful-artist and existing-artist recommendation guards", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(
            discoverWeeklyService as any,
            "isArtistInLibrary",
        ).mockImplementation(async (artistName: unknown) => {
            return artistName === "Existing Pass Artist";
        });
        jest.spyOn(
            discoverWeeklyService as any,
            "findValidAlbumForArtist",
        ).mockImplementation(async (artist: any) => {
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
                            {
                                name: "Existing Pass Artist",
                                mbid: "existing-pass",
                                match: 0.7,
                            },
                            {
                                name: "Existing Null Recommendation",
                                mbid: "existing-null-recommendation",
                                match: 0.69,
                            },
                            {
                                name: "Existing Recovery",
                                mbid: "existing-recovery",
                                match: 0.68,
                            },
                        ],
                    ],
                ]),
                1,
                "user-1",
            ),
        ).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    albumMbid: "rg-existing-recovery",
                }),
            ]),
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
                "batch-success-set-guard",
            ),
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
        (lidarrService.getDiscoveryArtists as jest.Mock).mockResolvedValueOnce(
            [],
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        await expect(
            (discoverWeeklyService as any).cleanupFailedArtists(
                "batch-success-no-artist-mbid",
            ),
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
                artist: {
                    name: "Normalized Artist",
                    mbid: "artist-normalized",
                },
                tracks: [],
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
            discoverWeeklyService.buildFinalPlaylist(
                "batch-normalized-nonmatch",
            ),
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
            })),
        );
        (prisma.track.findMany as jest.Mock).mockImplementation(
            async (query: any) => {
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

                if (
                    query?.where?.album?.location === "LIBRARY" &&
                    !query?.orderBy
                ) {
                    return [];
                }

                if (
                    query?.where?.album?.location === "LIBRARY" &&
                    query?.orderBy
                ) {
                    return [
                        {
                            id: "track-pop-dup-1",
                            filePath: "/music/pop-dup-1.flac",
                            album: {
                                id: "album-pop-dup",
                                title: "Popular Duplicate Album",
                                rgMbid: "rg-pop-dup",
                                artist: {
                                    name: "Popular Artist",
                                    mbid: "artist-pop-dup",
                                },
                            },
                        },
                        {
                            id: "track-pop-dup-2",
                            filePath: "/music/pop-dup-2.flac",
                            album: {
                                id: "album-pop-dup",
                                title: "Popular Duplicate Album",
                                rgMbid: "rg-pop-dup",
                                artist: {
                                    name: "Popular Artist",
                                    mbid: "artist-pop-dup",
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
            discoverWeeklyService.buildFinalPlaylist(
                "batch-popular-duplicates",
            ),
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
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupFailedArtists",
        ).mockResolvedValue(undefined);
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupOrphanedLidarrQueue",
        ).mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist("batch-job-match"),
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
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupFailedArtists",
        ).mockResolvedValue(undefined);
        jest.spyOn(
            discoverWeeklyService as any,
            "cleanupOrphanedLidarrQueue",
        ).mockResolvedValue(undefined);

        await expect(
            discoverWeeklyService.buildFinalPlaylist(
                "batch-zero-exclusion-months",
            ),
        ).resolves.toBeUndefined();
        expect(tx.discoverExclusion.upsert).not.toHaveBeenCalled();
    });

    it("walks pass-two recommendation paths where album lookups return null and null recommendations before a recovery", async () => {
        setupDiscoverWeeklyMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { discoverWeeklyService } = require("../discoverWeekly");
        jest.spyOn(
            discoverWeeklyService as any,
            "isArtistInLibrary",
        ).mockImplementation(async (artistName: unknown) => {
            return (
                artistName === "PassTwo Null Album" ||
                artistName === "PassTwo Null Recommendation" ||
                artistName === "PassTwo Recovery"
            );
        });
        jest.spyOn(
            discoverWeeklyService as any,
            "findValidAlbumForArtist",
        ).mockImplementation(async (artist: any) => {
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
                            {
                                name: "PassTwo Null Album",
                                mbid: "pass-two-null-album",
                                match: 0.7,
                            },
                            {
                                name: "PassTwo Null Recommendation",
                                mbid: "pass-two-null-recommendation",
                                match: 0.69,
                            },
                            {
                                name: "PassTwo Recovery",
                                mbid: "pass-two-recovery",
                                match: 0.68,
                            },
                        ],
                    ],
                ]),
                1,
                "user-1",
            ),
        ).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    albumMbid: "rg-pass-two-recovery",
                }),
            ]),
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
                "missing-mbid",
            ),
        ).resolves.toBe(false);
    });
});
