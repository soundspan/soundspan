import {
    makeSpotifyTrack,
    setupSpotifyImportMocks,
} from "./spotifyImportRuntime.helpers";

describe("spotify import runtime behavior", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    it("falls back to database when cached import job JSON is malformed", async () => {
        const { prisma, redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce("{not-json");
        (prisma.spotifyImportJob.findUnique as jest.Mock).mockResolvedValueOnce(
            {
                id: "job-db-fallback",
                userId: "u1",
                spotifyPlaylistId: "sp-db-fallback",
                playlistName: "DB Fallback",
                status: "pending",
                progress: 1,
                albumsTotal: 1,
                albumsCompleted: 0,
                tracksMatched: 0,
                tracksTotal: 3,
                tracksDownloadable: 3,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-09T00:00:00.000Z"),
                updatedAt: new Date("2026-01-09T00:01:00.000Z"),
                pendingTracks: [],
            },
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const job = await spotifyImportService.getJob("job-db-fallback");

        expect(job?.id).toBe("job-db-fallback");
        expect(prisma.spotifyImportJob.findUnique).toHaveBeenCalledWith({
            where: { id: "job-db-fallback" },
        });
    });

    it("clears stale recording cache and rejects generatePreview on invalid Spotify URL", async () => {
        const { spotifyService, musicBrainzService } =
            setupSpotifyImportMocks();
        (spotifyService.getPlaylist as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");

        await expect(
            spotifyImportService.generatePreview(
                "https://open.spotify.com/playlist/missing",
            ),
        ).rejects.toThrow(
            "Could not fetch playlist from Spotify. Make sure it's a valid public playlist URL.",
        );
        expect(
            musicBrainzService.clearStaleRecordingCaches,
        ).toHaveBeenCalledTimes(1);
    });

    it("maps Spotify playlist metadata and delegates preview generation", async () => {
        const { spotifyService } = setupSpotifyImportMocks();
        (spotifyService.getPlaylist as jest.Mock).mockResolvedValueOnce({
            id: "sp-1",
            name: "Spotify One",
            description: "desc",
            owner: "owner-1",
            imageUrl: "https://img.example/sp.jpg",
            trackCount: 2,
            tracks: [
                {
                    spotifyId: "trk-1",
                    title: "Song 1",
                    artist: "Artist 1",
                    artistId: "ar-1",
                    album: "Album 1",
                    albumId: "alb-1",
                    isrc: null,
                    durationMs: 111000,
                    trackNumber: 1,
                    previewUrl: null,
                    coverUrl: null,
                },
            ],
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const delegate = jest
            .spyOn(spotifyImportService as any, "buildPreviewFromTracklist")
            .mockResolvedValue({
                playlist: {
                    id: "sp-1",
                    name: "Spotify One",
                    description: "desc",
                    owner: "owner-1",
                    imageUrl: "https://img.example/sp.jpg",
                    trackCount: 2,
                },
                matchedTracks: [],
                albumsToDownload: [],
                summary: {
                    total: 2,
                    inLibrary: 0,
                    downloadable: 0,
                    notFound: 2,
                },
            });

        const result = await spotifyImportService.generatePreview(
            "https://open.spotify.com/playlist/sp-1",
        );

        expect(delegate).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ spotifyId: "trk-1" }),
            ]),
            expect.objectContaining({
                id: "sp-1",
                name: "Spotify One",
                owner: "owner-1",
                trackCount: 2,
            }),
            "Spotify",
        );
        expect(result.summary.total).toBe(2);
    });

    it("maps Deezer playlist tracks and delegates preview generation", async () => {
        setupSpotifyImportMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const delegate = jest
            .spyOn(spotifyImportService as any, "buildPreviewFromTracklist")
            .mockResolvedValue({
                playlist: {
                    id: "dz-1",
                    name: "Deezer One",
                    description: null,
                    owner: "user",
                    imageUrl: null,
                    trackCount: 1,
                },
                matchedTracks: [],
                albumsToDownload: [],
                summary: {
                    total: 1,
                    inLibrary: 0,
                    downloadable: 0,
                    notFound: 1,
                },
            });

        const deezerPlaylist = {
            id: "dz-1",
            title: "Deezer One",
            creator: "user",
            imageUrl: "https://img.example/cover.jpg",
            trackCount: 1,
            tracks: [
                {
                    deezerId: "d-track-1",
                    title: "Song A",
                    artist: "Artist A",
                    artistId: "a-1",
                    album: "",
                    albumId: "",
                    durationMs: 120000,
                    trackNumber: 1,
                    previewUrl: null,
                    coverUrl: null,
                },
            ],
        };

        const result =
            await spotifyImportService.generatePreviewFromDeezer(
                deezerPlaylist,
            );

        expect(delegate).toHaveBeenCalledWith(
            [
                expect.objectContaining({
                    spotifyId: "d-track-1",
                    album: "Unknown Album",
                    coverUrl: "https://img.example/cover.jpg",
                }),
            ],
            expect.objectContaining({
                id: "dz-1",
                name: "Deezer One",
                owner: "user",
                trackCount: 1,
            }),
            "Deezer",
        );
        expect(result.summary.notFound).toBe(1);
    });

    it("matches tracks with exact artist/album/title strategy", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "track-exact-1",
            title: "Song A",
            albumId: "album-a",
            album: {
                title: "Album A",
                artist: { name: "Artist A" },
            },
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await (spotifyImportService as any).matchTrack(
            makeSpotifyTrack(),
        );

        expect(result).toEqual(
            expect.objectContaining({
                matchType: "exact",
                matchConfidence: 100,
                localTrack: expect.objectContaining({
                    id: "track-exact-1",
                    artistName: "Artist A",
                }),
            }),
        );
        expect(prisma.track.findFirst).toHaveBeenCalledTimes(1);
    });

    it("falls back to full-artist exact matching when primary-artist exact lookup misses", async () => {
        const { prisma } = setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {
            extractPrimaryArtist,
        } = require("../../utils/artistNormalization");
        (extractPrimaryArtist as jest.Mock).mockReturnValueOnce("Artist A");
        (prisma.track.findFirst as jest.Mock)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "track-exact-full-artist",
                title: "Song A",
                albumId: "album-a",
                album: {
                    title: "Album A",
                    artist: { name: "Artist A feat. Guest" },
                },
            });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await (spotifyImportService as any).matchTrack(
            makeSpotifyTrack({ artist: "Artist A feat. Guest" }),
        );

        expect(result.matchType).toBe("exact");
        expect(result.localTrack?.id).toBe("track-exact-full-artist");
        expect(prisma.track.findFirst).toHaveBeenCalledTimes(2);
    });

    it("matches against normalized album variants when direct album title lookup misses", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findFirst as jest.Mock)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        (prisma.album.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "album-variant",
                title: "Album A (Deluxe Edition)",
                artist: { name: "Artist A" },
                tracks: [{ id: "track-variant", title: "Song A" }],
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await (spotifyImportService as any).matchTrack(
            makeSpotifyTrack({ album: "Album A (Super Deluxe Edition)" }),
        );

        expect(prisma.album.findMany).toHaveBeenCalledTimes(1);
        expect(result.matchType).toBe("exact");
        expect(result.matchConfidence).toBe(95);
        expect(result.localTrack?.id).toBe("track-variant");
    });

    it("returns artist+title match for unknown-album tracks with fuzzy confidence", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.track.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "track-unknown-album",
                title: "Song A",
                albumId: "album-b",
                album: {
                    title: "Actual Album",
                    artist: { name: "Artist A" },
                },
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await (spotifyImportService as any).matchTrack(
            makeSpotifyTrack({ album: "Unknown Album" }),
        );

        expect(result.matchType).toBe("fuzzy");
        expect(result.matchConfidence).toBe(85);
        expect(result.localTrack?.id).toBe("track-unknown-album");
    });

    it("uses fuzzy search fallback when exact and artist-title strategies miss", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([]) // strategy 3
            .mockResolvedValueOnce([]) // strategy 4a
            .mockResolvedValueOnce([
                {
                    id: "track-fuzzy",
                    title: "Very Long Song Title",
                    albumId: "album-fz",
                    album: {
                        title: "Album Fuzzy",
                        artist: { name: "Long Artist Name" },
                    },
                },
            ]); // strategy 4b

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await (spotifyImportService as any).matchTrack(
            makeSpotifyTrack({
                artist: "Long Artist Name",
                title: "Very Long Song Title",
                album: "Unknown Album",
            }),
        );

        expect(result.matchType).toBe("fuzzy");
        expect(result.localTrack?.id).toBe("track-fuzzy");
    });

    it("reads pending-track and job summaries from persistence", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.playlistPendingTrack.count as jest.Mock).mockResolvedValue(3);
        (prisma.playlistPendingTrack.findMany as jest.Mock).mockResolvedValue([
            {
                id: "p1",
                spotifyArtist: "Artist A",
                spotifyTitle: "Song A",
                spotifyAlbum: "Album A",
            },
            {
                id: "p2",
                spotifyArtist: "Artist B",
                spotifyTitle: "Song B",
                spotifyAlbum: "Album B",
            },
        ]);
        (prisma.spotifyImportJob.findMany as jest.Mock).mockResolvedValue([
            {
                id: "j-older",
                userId: "u1",
                spotifyPlaylistId: "sp-1",
                playlistName: "Older",
                status: "completed",
                progress: 100,
                albumsTotal: 5,
                albumsCompleted: 5,
                tracksMatched: 20,
                tracksTotal: 20,
                tracksDownloadable: 0,
                createdPlaylistId: "pl-1",
                error: null,
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
                updatedAt: new Date("2026-01-01T00:10:00.000Z"),
                pendingTracks: [],
            },
            {
                id: "j-newer",
                userId: "u1",
                spotifyPlaylistId: "sp-2",
                playlistName: "Newer",
                status: "pending",
                progress: 5,
                albumsTotal: 2,
                albumsCompleted: 0,
                tracksMatched: 0,
                tracksTotal: 12,
                tracksDownloadable: 12,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-02T00:00:00.000Z"),
                updatedAt: new Date("2026-01-02T00:01:00.000Z"),
                pendingTracks: [{ artist: "X", title: "Y", album: "Z" }],
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");

        await expect(
            spotifyImportService.getPendingTracksCount("playlist-1"),
        ).resolves.toBe(3);

        await expect(
            spotifyImportService.getPendingTracks("playlist-1"),
        ).resolves.toEqual([
            {
                id: "p1",
                artist: "Artist A",
                title: "Song A",
                album: "Album A",
            },
            {
                id: "p2",
                artist: "Artist B",
                title: "Song B",
                album: "Album B",
            },
        ]);

        const jobs = await spotifyImportService.getUserJobs("u1");
        expect(jobs.map((job: { id: string }) => job.id)).toEqual([
            "j-newer",
            "j-older",
        ]);
    });

    it("loads job state from database on cache miss and repopulates redis cache", async () => {
        const { prisma, redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(null);
        (prisma.spotifyImportJob.findUnique as jest.Mock).mockResolvedValueOnce(
            {
                id: "job-db",
                userId: "u1",
                spotifyPlaylistId: "sp-db",
                playlistName: "DB Job",
                status: "pending",
                progress: 10,
                albumsTotal: 4,
                albumsCompleted: 1,
                tracksMatched: 2,
                tracksTotal: 12,
                tracksDownloadable: 10,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-03T00:00:00.000Z"),
                updatedAt: new Date("2026-01-03T00:05:00.000Z"),
                pendingTracks: [{ artist: "A", title: "B", album: "C" }],
            },
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const job = await spotifyImportService.getJob("job-db");

        expect(job?.id).toBe("job-db");
        expect(redisClient.setEx).toHaveBeenCalledWith(
            "import:job:job-db",
            24 * 60 * 60,
            expect.any(String),
        );
    });

    it("returns null from getJob when neither redis nor database has the import job", async () => {
        const { prisma, redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(null);
        (prisma.spotifyImportJob.findUnique as jest.Mock).mockResolvedValueOnce(
            null,
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.getJob("missing-job"),
        ).resolves.toBeNull();
    });

    it("recreates redis client and retries when cache read sees a closed connection", async () => {
        const { redisClient, redisRecoveryClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockRejectedValueOnce(
            new Error("Connection is closed"),
        );
        (redisRecoveryClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify({
                id: "job-cache",
                userId: "u1",
                spotifyPlaylistId: "sp-cache",
                playlistName: "Cached Job",
                status: "pending",
                progress: 0,
                albumsTotal: 1,
                albumsCompleted: 0,
                tracksMatched: 0,
                tracksTotal: 1,
                tracksDownloadable: 1,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-04T00:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-01-04T00:01:00.000Z").toISOString(),
                pendingTracks: [],
            }),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const job = await spotifyImportService.getJob("job-cache");

        expect(redisClient.duplicate).toHaveBeenCalledTimes(1);
        expect(redisRecoveryClient.connect).toHaveBeenCalledTimes(1);
        expect(job?.id).toBe("job-cache");
    });

    it("retries prisma-backed reads on retryable errors and reconnects before succeeding", async () => {
        const { prisma } = setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        const retryable = new Prisma.PrismaClientKnownRequestError(
            "temporary outage",
        );
        (prisma.spotifyImportJob.findMany as jest.Mock)
            .mockRejectedValueOnce(retryable)
            .mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.getUserJobs("u-retry"),
        ).resolves.toEqual([]);

        expect(prisma.$connect).toHaveBeenCalledTimes(1);
        expect(prisma.spotifyImportJob.findMany).toHaveBeenCalledTimes(2);
    });

    it("propagates non-retryable prisma errors without reconnect attempts", async () => {
        const { prisma } = setupSpotifyImportMocks();
        const boom = new Error("non-retryable");
        (prisma.spotifyImportJob.findMany as jest.Mock).mockRejectedValueOnce(
            boom,
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.getUserJobs("u-fail"),
        ).rejects.toThrow("non-retryable");

        expect(prisma.$connect).not.toHaveBeenCalled();
        expect(prisma.spotifyImportJob.findMany).toHaveBeenCalledTimes(1);
    });

    it("throws after exhausting prisma retries on repeated retryable failures", async () => {
        const { prisma } = setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        const retryable = new Prisma.PrismaClientKnownRequestError(
            "db still unavailable",
        );
        (prisma.spotifyImportJob.findMany as jest.Mock).mockRejectedValue(
            retryable,
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.getUserJobs("u-retry-exhausted"),
        ).rejects.toThrow("db still unavailable");

        expect(prisma.$connect).toHaveBeenCalledTimes(2);
        expect(prisma.spotifyImportJob.findMany).toHaveBeenCalledTimes(3);
    });

    it("falls back to database when redis read fails with non-retryable error", async () => {
        const { redisClient, prisma } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockRejectedValueOnce(
            new Error("permission denied"),
        );
        (prisma.spotifyImportJob.findUnique as jest.Mock).mockResolvedValueOnce(
            null,
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.getJob("job-redis-fail"),
        ).resolves.toBeNull();
        expect(prisma.spotifyImportJob.findUnique).toHaveBeenCalledWith({
            where: { id: "job-redis-fail" },
        });
    });

    it("retries redis writes during cancelJob when cache connection closes", async () => {
        const { prisma, redisClient, redisRecoveryClient } =
            setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify({
                id: "job-cancel-redis-retry",
                userId: "u1",
                spotifyPlaylistId: "sp-9",
                playlistName: "Retry Cache",
                status: "downloading",
                progress: 30,
                albumsTotal: 1,
                albumsCompleted: 0,
                tracksMatched: 0,
                tracksTotal: 2,
                tracksDownloadable: 2,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-07T00:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-01-07T00:02:00.000Z").toISOString(),
                pendingTracks: [],
            }),
        );
        (redisClient.setEx as jest.Mock).mockRejectedValueOnce(
            new Error("Connection is closed"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.cancelJob("job-cancel-redis-retry"),
        ).resolves.toEqual({
            playlistCreated: false,
            playlistId: null,
            tracksMatched: 0,
        });

        expect(redisClient.duplicate).toHaveBeenCalledTimes(1);
        expect(redisRecoveryClient.connect).toHaveBeenCalledTimes(1);
        expect(redisRecoveryClient.setEx).toHaveBeenCalled();
        expect(prisma.downloadJob.updateMany).toHaveBeenCalledTimes(1);
    });

    it("returns terminal job metadata without mutating download jobs", async () => {
        const { prisma, redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify({
                id: "job-complete",
                userId: "u1",
                spotifyPlaylistId: "sp-1",
                playlistName: "Done",
                status: "completed",
                progress: 100,
                albumsTotal: 2,
                albumsCompleted: 2,
                tracksMatched: 20,
                tracksTotal: 20,
                tracksDownloadable: 0,
                createdPlaylistId: "playlist-123",
                error: null,
                createdAt: new Date("2026-01-04T00:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-01-04T00:01:00.000Z").toISOString(),
                pendingTracks: [],
            }),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await spotifyImportService.cancelJob("job-complete");

        expect(result).toEqual({
            playlistCreated: true,
            playlistId: "playlist-123",
            tracksMatched: 20,
        });
        expect(prisma.downloadJob.updateMany).not.toHaveBeenCalled();
    });

    it("cancels active jobs, marks pending downloads failed, and persists cancelled state", async () => {
        const { prisma, redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify({
                id: "job-active",
                userId: "u1",
                spotifyPlaylistId: "sp-2",
                playlistName: "Active",
                status: "downloading",
                progress: 34,
                albumsTotal: 4,
                albumsCompleted: 1,
                tracksMatched: 3,
                tracksTotal: 12,
                tracksDownloadable: 9,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-04T00:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-01-04T00:02:00.000Z").toISOString(),
                pendingTracks: [],
            }),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await spotifyImportService.cancelJob("job-active");

        expect(prisma.downloadJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    status: { in: ["pending", "processing"] },
                }),
                data: expect.objectContaining({
                    status: "failed",
                    error: "Import cancelled by user",
                }),
            }),
        );
        expect(prisma.spotifyImportJob.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-active" },
                update: expect.objectContaining({
                    status: "cancelled",
                }),
            }),
        );
        expect(result).toEqual({
            playlistCreated: false,
            playlistId: null,
            tracksMatched: 0,
        });
    });

    it("throws when cancelJob is called for an unknown import job id", async () => {
        const { redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");

        await expect(
            spotifyImportService.cancelJob("missing-job"),
        ).rejects.toThrow("Import job not found");
    });

    it("rejects refreshJobMatches when the import job does not exist", async () => {
        const { redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");

        await expect(
            spotifyImportService.refreshJobMatches("missing-job"),
        ).rejects.toThrow("Import job not found");
    });

    it("rejects refreshJobMatches when no playlist was created yet", async () => {
        const { redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify({
                id: "job-no-playlist",
                userId: "u1",
                spotifyPlaylistId: "sp-3",
                playlistName: "No Playlist",
                status: "matching_tracks",
                progress: 75,
                albumsTotal: 3,
                albumsCompleted: 3,
                tracksMatched: 6,
                tracksTotal: 12,
                tracksDownloadable: 6,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-05T00:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-01-05T00:10:00.000Z").toISOString(),
                pendingTracks: [{ artist: "A", title: "B", album: "C" }],
            }),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");

        await expect(
            spotifyImportService.refreshJobMatches("job-no-playlist"),
        ).rejects.toThrow("No playlist created for this job");
    });

    it("refreshes job matches by adding newly available tracks once", async () => {
        const { prisma, redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify({
                id: "job-refresh",
                userId: "u1",
                spotifyPlaylistId: "sp-4",
                playlistName: "Refresh",
                status: "matching_tracks",
                progress: 80,
                albumsTotal: 4,
                albumsCompleted: 4,
                tracksMatched: 1,
                tracksTotal: 3,
                tracksDownloadable: 2,
                createdPlaylistId: "playlist-77",
                error: null,
                createdAt: new Date("2026-01-05T00:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-01-05T00:10:00.000Z").toISOString(),
                pendingTracks: [
                    { artist: "Artist A", title: "Song A", album: "Album A" },
                    { artist: "Artist B", title: "Song B", album: "Album B" },
                    { artist: "Artist C", title: "Song C", album: "Album C" },
                ],
            }),
        );
        (prisma.playlistItem.findMany as jest.Mock).mockResolvedValueOnce([
            { trackId: "existing-1" },
        ]);
        (prisma.track.findFirst as jest.Mock)
            .mockResolvedValueOnce({ id: "track-a" }) // add
            .mockResolvedValueOnce({ id: "existing-1" }) // duplicate, skip
            .mockResolvedValueOnce(null); // no match, skip

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result =
            await spotifyImportService.refreshJobMatches("job-refresh");

        expect(prisma.playlistItem.create).toHaveBeenCalledTimes(1);
        expect(prisma.playlistItem.create).toHaveBeenCalledWith({
            data: {
                playlistId: "playlist-77",
                trackId: "track-a",
                sort: 1,
            },
        });
        expect(prisma.spotifyImportJob.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-refresh" },
                update: expect.objectContaining({
                    tracksMatched: 2,
                }),
            }),
        );
        expect(result).toEqual({ added: 1, total: 2 });
    });

    it("rejects startImport when userId is invalid", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");

        await expect(
            spotifyImportService.startImport(
                "NaN",
                "sp-raw",
                "Bad User Import",
                [],
                {
                    playlist: {
                        id: "sp-raw",
                        name: "Bad User Import",
                        description: null,
                        owner: "owner",
                        imageUrl: null,
                        trackCount: 1,
                    },
                    matchedTracks: [],
                    albumsToDownload: [],
                    summary: {
                        total: 1,
                        inLibrary: 0,
                        downloadable: 0,
                        notFound: 1,
                    },
                },
            ),
        ).rejects.toThrow("Invalid userId provided: NaN");
    });

    it("fails checkImportCompletion when no download jobs exist for a download-backed import", async () => {
        const { prisma, redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify({
                id: "job-empty-downloads",
                userId: "u1",
                spotifyPlaylistId: "sp-6",
                playlistName: "Empty Downloads",
                status: "downloading",
                progress: 30,
                albumsTotal: 2,
                albumsCompleted: 0,
                tracksMatched: 0,
                tracksTotal: 6,
                tracksDownloadable: 6,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-06T00:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-01-06T00:01:00.000Z").toISOString(),
                pendingTracks: [],
            }),
        );
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await spotifyImportService.checkImportCompletion("job-empty-downloads");

        expect(prisma.spotifyImportJob.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-empty-downloads" },
                update: expect.objectContaining({
                    status: "failed",
                    error: expect.stringContaining(
                        "No download jobs were created for this import",
                    ),
                }),
            }),
        );
    });

    it("keeps checkImportCompletion in downloading state while pending jobs are still fresh", async () => {
        const { prisma, redisClient, scanQueue } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify({
                id: "job-pending-wait",
                userId: "u1",
                spotifyPlaylistId: "sp-7",
                playlistName: "Pending Wait",
                status: "downloading",
                progress: 40,
                albumsTotal: 1,
                albumsCompleted: 1,
                tracksMatched: 0,
                tracksTotal: 3,
                tracksDownloadable: 3,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-06T00:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-01-06T00:02:00.000Z").toISOString(),
                pendingTracks: [],
            }),
        );
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "dj-pending-1",
                status: "pending",
                createdAt: new Date(Date.now() - 2 * 60 * 1000),
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await spotifyImportService.checkImportCompletion("job-pending-wait");

        expect(prisma.downloadJob.updateMany).not.toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    error: "Timed out waiting for download",
                }),
            }),
        );
        expect(scanQueue.add).not.toHaveBeenCalled();
        expect(prisma.spotifyImportJob.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-pending-wait" },
                update: expect.objectContaining({
                    status: "downloading",
                }),
            }),
        );
    });

    it("times out stale pending downloads, marks them failed, then enqueues scan", async () => {
        const { prisma, redisClient, scanQueue } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify({
                id: "job-timeout",
                userId: "u1",
                spotifyPlaylistId: "sp-8",
                playlistName: "Timeout Import",
                status: "downloading",
                progress: 55,
                albumsTotal: 2,
                albumsCompleted: 1,
                tracksMatched: 0,
                tracksTotal: 8,
                tracksDownloadable: 8,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-07T00:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-01-07T00:02:00.000Z").toISOString(),
                pendingTracks: [],
            }),
        );
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "dj-pending-old",
                status: "pending",
                createdAt: new Date(Date.now() - 15 * 60 * 1000),
            },
            {
                id: "dj-complete",
                status: "completed",
                createdAt: new Date(Date.now() - 20 * 60 * 1000),
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await spotifyImportService.checkImportCompletion("job-timeout");

        expect(prisma.downloadJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    status: { in: ["pending", "processing"] },
                }),
                data: expect.objectContaining({
                    status: "failed",
                    error: "Timed out waiting for download",
                }),
            }),
        );
        expect(scanQueue.add).toHaveBeenCalledWith(
            "scan",
            expect.objectContaining({
                userId: "u1",
                spotifyImportJobId: "job-timeout",
            }),
        );
        expect(prisma.spotifyImportJob.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-timeout" },
                update: expect.objectContaining({
                    status: "scanning",
                    progress: 75,
                }),
            }),
        );
    });

    it("returns from buildPlaylistAfterScan when import job cannot be found", async () => {
        const { redisClient, prisma } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(null);
        (prisma.spotifyImportJob.findUnique as jest.Mock).mockResolvedValueOnce(
            null,
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.buildPlaylistAfterScan("missing-after-scan"),
        ).resolves.toBeUndefined();

        expect(prisma.playlist.create).not.toHaveBeenCalled();
    });

    it("builds playlist after scan using pre-matched tracks and marks job complete", async () => {
        const { redisClient, prisma, notificationService } =
            setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify({
                id: "job-build-after-scan",
                userId: "u1",
                spotifyPlaylistId: "sp-10",
                playlistName: "After Scan Build",
                status: "scanning",
                progress: 75,
                albumsTotal: 1,
                albumsCompleted: 1,
                tracksMatched: 0,
                tracksTotal: 1,
                tracksDownloadable: 1,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-08T00:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-01-08T00:05:00.000Z").toISOString(),
                pendingTracks: [
                    {
                        artist: "Artist A",
                        title: "Song A",
                        album: "Album A",
                        albumMbid: null,
                        artistMbid: null,
                        preMatchedTrackId: "track-pre-1",
                    },
                ],
            }),
        );
        (prisma.track.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "track-pre-1",
            title: "Song A",
        });
        (prisma.track.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "track-pre-1",
            title: "Song A",
        });
        (prisma.playlist.create as jest.Mock).mockResolvedValueOnce({
            id: "playlist-built",
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.buildPlaylistAfterScan("job-build-after-scan"),
        ).resolves.toBeUndefined();

        expect(prisma.playlist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    spotifyPlaylistId: "sp-10",
                    items: {
                        create: [{ trackId: "track-pre-1", sort: 0 }],
                    },
                }),
            }),
        );
        expect(prisma.spotifyImportJob.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-build-after-scan" },
                update: expect.objectContaining({
                    status: "completed",
                    progress: 100,
                    createdPlaylistId: "playlist-built",
                }),
            }),
        );
        expect(notificationService.notifyImportComplete).toHaveBeenCalledWith(
            "u1",
            "After Scan Build",
            "playlist-built",
            1,
            1,
        );
    });

    it("exercises deep buildPlaylist fallback matching strategies and saves unmatched pending tracks", async () => {
        const { redisClient, prisma, deezerService } =
            setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify({
                id: "job-build-fallbacks",
                userId: "u1",
                spotifyPlaylistId: "sp-11",
                playlistName: "Fallback Build",
                status: "scanning",
                progress: 75,
                albumsTotal: 1,
                albumsCompleted: 1,
                tracksMatched: 0,
                tracksTotal: 1,
                tracksDownloadable: 1,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-08T01:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-01-08T01:05:00.000Z").toISOString(),
                pendingTracks: [
                    {
                        artist: "Long Artist Name",
                        title: "Very Long Song Title - 2011 Remaster",
                        album: "Unknown Album",
                        albumMbid: null,
                        artistMbid: null,
                        preMatchedTrackId: null,
                    },
                ],
            }),
        );
        (prisma.playlist.create as jest.Mock).mockResolvedValueOnce({
            id: "playlist-fallbacks",
        });

        // buildPlaylist strategy calls:
        // 1) strategy 1 findFirst
        // 2) strategy 2 findFirst
        // 3) strategy 4 findFirst
        // 4) matchedTitles normalization findFirst
        (prisma.track.findFirst as jest.Mock)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        // buildPlaylist strategy calls:
        // 1) strategy 3 candidates
        // 2) strategy 3.5 candidates
        // 3) strategy 5 candidates
        // 4) strategy 6 candidates
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        (prisma.artist.findFirst as jest.Mock).mockResolvedValueOnce({
            name: "Long Artist Name",
            normalizedName: "long artist name",
        });
        (deezerService.getTrackPreview as jest.Mock).mockRejectedValueOnce(
            new Error("preview unavailable"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.buildPlaylistAfterScan("job-build-fallbacks"),
        ).resolves.toBeUndefined();

        expect(prisma.playlist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    spotifyPlaylistId: "sp-11",
                    items: undefined,
                }),
            }),
        );
        expect(prisma.playlistPendingTrack.createMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.arrayContaining([
                    expect.objectContaining({
                        playlistId: "playlist-fallbacks",
                        spotifyArtist: "Long Artist Name",
                        spotifyTitle: "Very Long Song Title - 2011 Remaster",
                    }),
                ]),
            }),
        );
    });

    it("returns early from reconcilePendingTracks when there are no pending entries", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (
            prisma.playlistPendingTrack.findMany as jest.Mock
        ).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.reconcilePendingTracks(),
        ).resolves.toEqual({ playlistsUpdated: 0, tracksAdded: 0 });
    });

    it("reconciles matched pending tracks into playlist and emits playlist-updated notification", async () => {
        const { prisma, notificationService } = setupSpotifyImportMocks();
        (
            prisma.playlistPendingTrack.findMany as jest.Mock
        ).mockResolvedValueOnce([
            {
                id: "pending-1",
                playlistId: "playlist-1",
                spotifyArtist: "Artist One",
                spotifyTitle: "Song One",
                spotifyAlbum: "Album One",
                sort: 0,
                playlist: {
                    id: "playlist-1",
                    name: "Playlist One",
                    userId: "u1",
                },
            },
        ]);
        (prisma.playlistItem.aggregate as jest.Mock).mockResolvedValueOnce({
            _max: { sort: 2 },
        });
        (prisma.playlistItem.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findMany as jest.Mock).mockResolvedValueOnce([]); // artist debug lookup
        (prisma.track.findFirst as jest.Mock).mockResolvedValueOnce({
            id: "track-111",
            title: "Song One",
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await spotifyImportService.reconcilePendingTracks();

        expect(prisma.playlistItem.create).toHaveBeenCalledWith({
            data: {
                playlistId: "playlist-1",
                trackId: "track-111",
                sort: 3,
            },
        });
        expect(prisma.playlistPendingTrack.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: ["pending-1"] } },
        });
        expect(notificationService.create).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: "u1",
                type: "playlist_ready",
                title: "Playlist Updated",
                metadata: expect.objectContaining({
                    playlistId: "playlist-1",
                    tracksAdded: 1,
                }),
            }),
        );
        expect(result).toEqual({ playlistsUpdated: 1, tracksAdded: 1 });
    });

    it("reconciles pending tracks through strategy-2/3/4 fallback matching paths", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (
            prisma.playlistPendingTrack.findMany as jest.Mock
        ).mockResolvedValueOnce([
            {
                id: "pending-fallback-1",
                playlistId: "playlist-fallback",
                spotifyArtist: "Fallback Artist",
                spotifyTitle: "Long Pending Song Extended",
                spotifyAlbum: "Unknown Album",
                sort: 1,
                playlist: {
                    id: "playlist-fallback",
                    name: "Fallback Playlist",
                    userId: "u1",
                },
            },
        ]);
        (prisma.playlistItem.aggregate as jest.Mock).mockResolvedValueOnce({
            _max: { sort: 1 },
        });
        (prisma.playlistItem.findMany as jest.Mock).mockResolvedValueOnce([
            { trackId: "existing-track-1" },
        ]);
        (prisma.track.findFirst as jest.Mock).mockImplementation(
            async (query: any) => {
                if (query?.select?.id && query?.where?.title?.equals) {
                    return null;
                }
                return null;
            },
        );
        (prisma.track.findMany as jest.Mock).mockImplementation(
            async (query: any) => {
                if (query?.select?.title && query?.take === 5) {
                    return [
                        {
                            title: "Library Fallback Candidate",
                            album: {
                                artist: {
                                    name: "Fallback Artist",
                                    normalizedName: "fallback artist",
                                },
                            },
                        },
                    ];
                }

                if (
                    query?.where?.title?.contains &&
                    query?.include?.album &&
                    query?.take === 10
                ) {
                    return [];
                }

                if (
                    query?.where?.title?.contains &&
                    query?.include?.album &&
                    query?.take === 20
                ) {
                    return [
                        {
                            id: "track-low-score",
                            title: "Different Song",
                            album: {
                                artist: {
                                    name: "Different Artist",
                                    normalizedName: "different artist",
                                },
                            },
                        },
                    ];
                }

                if (
                    query?.where?.title?.equals &&
                    query?.include?.album &&
                    query?.take === 10
                ) {
                    return [
                        {
                            id: "track-strategy-4",
                            title: "Long Pending Song Extended",
                            album: {
                                artist: {
                                    name: "Fallback Artist",
                                    normalizedName: "fallback artist",
                                },
                            },
                        },
                    ];
                }

                return [];
            },
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await spotifyImportService.reconcilePendingTracks();

        expect(prisma.playlistItem.create).toHaveBeenCalledWith({
            data: {
                playlistId: "playlist-fallback",
                trackId: "track-strategy-4",
                sort: 2,
            },
        });
        expect(prisma.playlistPendingTrack.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: ["pending-fallback-1"] } },
        });
        expect(result).toEqual({ playlistsUpdated: 1, tracksAdded: 1 });
    });

    it("retries spotify-import prisma reads on unknown-request engine-exit errors", async () => {
        const { prisma } = setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        (prisma.spotifyImportJob.findMany as jest.Mock)
            .mockRejectedValueOnce(
                new Prisma.PrismaClientUnknownRequestError(
                    "Engine has already exited",
                ),
            )
            .mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.getUserJobs("u-unknown"),
        ).resolves.toEqual([]);
        expect(prisma.spotifyImportJob.findMany).toHaveBeenCalledTimes(2);
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
    });

    it("builds pending-track payloads in startImport and schedules resolution-only processing", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const processSpy = jest
            .spyOn(spotifyImportService as any, "processImport")
            .mockResolvedValue(undefined);

        const spotifyTrackResolved = makeSpotifyTrack({
            spotifyId: "sp-resolved",
            artist: "Artist Resolved",
            title: "Song Resolved",
            album: "Unknown Album",
            albumId: "mbid:rg-resolved",
        });
        const spotifyTrackDirect = makeSpotifyTrack({
            spotifyId: "sp-direct",
            artist: "Artist Direct",
            title: "Song Direct",
            album: "Album Direct",
            albumId: "sp-alb-direct",
        });
        const preview = {
            playlist: {
                id: "sp-playlist-1",
                name: "Preview Playlist",
                description: null,
                owner: "owner-1",
                imageUrl: null,
                trackCount: 2,
            },
            matchedTracks: [
                {
                    spotifyTrack: spotifyTrackResolved,
                    localTrack: null,
                    matchType: "none",
                    matchConfidence: 0,
                },
                {
                    spotifyTrack: spotifyTrackDirect,
                    localTrack: {
                        id: "local-1",
                        title: "Song Direct",
                        albumId: "alb-1",
                        albumTitle: "Album Direct",
                        artistName: "Artist Direct",
                    },
                    matchType: "exact",
                    matchConfidence: 100,
                },
            ],
            albumsToDownload: [
                {
                    spotifyAlbumId: "sp-alb-direct",
                    albumName: "Album Direct",
                    artistName: "Artist Direct",
                    artistMbid: "artist-direct",
                    albumMbid: "rg-direct",
                    coverUrl: null,
                    trackCount: 1,
                    tracksNeeded: [spotifyTrackDirect],
                },
                {
                    spotifyAlbumId: "sp-alb-resolved",
                    albumName: "Resolved Album",
                    artistName: "Artist Resolved",
                    artistMbid: "artist-resolved",
                    albumMbid: "rg-resolved",
                    coverUrl: null,
                    trackCount: 1,
                    tracksNeeded: [spotifyTrackResolved],
                },
            ],
            summary: {
                total: 2,
                inLibrary: 1,
                downloadable: 1,
                notFound: 0,
            },
        };

        const job = await spotifyImportService.startImport(
            "u-valid",
            "sp-playlist-1",
            "Import Start Playlist",
            ["rg-direct", "rg-resolved"],
            preview as any,
        );

        expect(job.id).toContain("import_");
        expect(job.albumsTotal).toBe(0);
        expect(job.tracksDownloadable).toBe(0);
        expect(job.pendingTracks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    artist: "Artist Resolved",
                    albumMbid: "rg-resolved",
                }),
            ]),
        );
        expect(processSpy).toHaveBeenCalledWith(
            expect.objectContaining({ id: job.id }),
            [],
            preview,
        );
    });

    it("processes unknown-album imports via track acquisition and triggers completion check", async () => {
        const { prisma, acquisitionService } = setupSpotifyImportMocks();
        (acquisitionService.acquireTracks as jest.Mock).mockResolvedValueOnce([
            { success: true },
            { success: false },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const completionSpy = jest
            .spyOn(spotifyImportService, "checkImportCompletion")
            .mockResolvedValue(undefined);

        const job = {
            id: "job-process-unknown",
            userId: "u1",
            spotifyPlaylistId: "sp-unknown",
            playlistName: "Unknown Album Import",
            status: "pending",
            progress: 0,
            albumsTotal: 1,
            albumsCompleted: 0,
            tracksMatched: 0,
            tracksTotal: 2,
            tracksDownloadable: 2,
            createdPlaylistId: null,
            error: null,
            createdAt: new Date("2026-01-09T00:00:00.000Z"),
            updatedAt: new Date("2026-01-09T00:00:00.000Z"),
            pendingTracks: [],
        };
        const unknownTrackA = makeSpotifyTrack({
            spotifyId: "sp-unk-a",
            artist: "Artist U",
            title: "Unknown A",
            album: "Unknown Album",
            albumId: "sp-unk",
        });
        const unknownTrackB = makeSpotifyTrack({
            spotifyId: "sp-unk-b",
            artist: "Artist U",
            title: "Unknown B",
            album: "Unknown Album",
            albumId: "sp-unk",
        });
        const preview = {
            playlist: {
                id: "sp-unknown",
                name: "Unknown Album Import",
                description: null,
                owner: "owner-1",
                imageUrl: null,
                trackCount: 2,
            },
            matchedTracks: [],
            albumsToDownload: [
                {
                    spotifyAlbumId: "sp-unk",
                    albumName: "Unknown Album",
                    artistName: "Artist U",
                    artistMbid: null,
                    albumMbid: null,
                    coverUrl: null,
                    trackCount: 2,
                    tracksNeeded: [unknownTrackA, unknownTrackB],
                },
            ],
            summary: {
                total: 2,
                inLibrary: 0,
                downloadable: 2,
                notFound: 0,
            },
        };

        await expect(
            (spotifyImportService as any).processImport(
                job,
                ["sp-unk"],
                preview,
            ),
        ).resolves.toBeUndefined();

        expect(acquisitionService.acquireTracks).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ trackTitle: "Unknown A" }),
                expect.objectContaining({ trackTitle: "Unknown B" }),
            ]),
            expect.objectContaining({
                userId: "u1",
                spotifyImportJobId: "job-process-unknown",
            }),
        );
        expect(completionSpy).toHaveBeenCalledWith("job-process-unknown");
        expect(prisma.spotifyImportJob.upsert).toHaveBeenCalled();
    });

    it("fails processImport when a download phase receives an invalid user id", async () => {
        const { acquisitionService } = setupSpotifyImportMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const badJob = {
            id: "job-invalid-user",
            userId: "NaN",
            spotifyPlaylistId: "sp-invalid",
            playlistName: "Invalid User",
            status: "pending",
            progress: 0,
            albumsTotal: 1,
            albumsCompleted: 0,
            tracksMatched: 0,
            tracksTotal: 1,
            tracksDownloadable: 1,
            createdPlaylistId: null,
            error: null,
            createdAt: new Date("2026-01-10T00:00:00.000Z"),
            updatedAt: new Date("2026-01-10T00:00:00.000Z"),
            pendingTracks: [],
        };
        const albumPreview = {
            playlist: {
                id: "sp-invalid",
                name: "Invalid User",
                description: null,
                owner: "owner-1",
                imageUrl: null,
                trackCount: 1,
            },
            matchedTracks: [],
            albumsToDownload: [
                {
                    spotifyAlbumId: "sp-a1",
                    albumName: "Album Invalid",
                    artistName: "Artist Invalid",
                    artistMbid: "artist-invalid",
                    albumMbid: "rg-invalid",
                    coverUrl: null,
                    trackCount: 1,
                    tracksNeeded: [makeSpotifyTrack()],
                },
            ],
            summary: {
                total: 1,
                inLibrary: 0,
                downloadable: 1,
                notFound: 0,
            },
        };

        await expect(
            (spotifyImportService as any).processImport(
                badJob,
                ["rg-invalid"],
                albumPreview,
            ),
        ).resolves.toBeUndefined();
        expect(acquisitionService.acquireAlbum).not.toHaveBeenCalled();
    });

    it("resolves unknown albums via MusicBrainz with cache hits and error handling", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchRecording as jest.Mock)
            .mockResolvedValueOnce({
                albumName: "Resolved Album",
                albumMbid: "rg-resolved",
                artistMbid: "artist-resolved",
            })
            .mockRejectedValueOnce(new Error("recording lookup failed"));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const tracks = [
            makeSpotifyTrack({
                spotifyId: "sp-1",
                artist: "Artist One",
                title: "Song One",
                album: "Unknown Album",
            }),
            makeSpotifyTrack({
                spotifyId: "sp-2",
                artist: "Artist One",
                title: "Song One",
                album: "Unknown Album",
            }),
            makeSpotifyTrack({
                spotifyId: "sp-3",
                artist: "Artist Two",
                title: "Song Two",
                album: "Unknown Album",
            }),
        ];

        const stats = await (
            spotifyImportService as any
        ).enrichUnknownAlbumsViaMusicBrainz(tracks, "[Test Import]");

        expect(stats.resolved).toBe(2);
        expect(stats.failed).toBe(1);
        expect(tracks[0].album).toBe("Resolved Album");
        expect(tracks[1].album).toBe("Resolved Album");
        expect(tracks[0].albumId).toBe("mbid:rg-resolved");
    });

    it("returns null MBIDs when MusicBrainz cannot find an artist or throws", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchArtist as jest.Mock)
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error("mb unavailable"));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");

        await expect(
            (spotifyImportService as any).findAlbumMbid(
                "Missing Artist",
                "Missing Album",
            ),
        ).resolves.toEqual({ artistMbid: null, albumMbid: null });
        await expect(
            (spotifyImportService as any).findAlbumMbid(
                "Error Artist",
                "Error Album",
            ),
        ).resolves.toEqual({ artistMbid: null, albumMbid: null });
    });

    it("resolves album MBIDs via artist and release-group matching", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchArtist as jest.Mock).mockResolvedValueOnce([
            { id: "artist-1", name: "Artist One" },
        ]);
        (
            musicBrainzService.getReleaseGroups as jest.Mock
        ).mockResolvedValueOnce([
            { id: "rg-a", title: "Other Album" },
            { id: "rg-b", title: "Target Album" },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            (spotifyImportService as any).findAlbumMbid(
                "Artist One",
                "Target Album",
            ),
        ).resolves.toEqual({ artistMbid: "artist-1", albumMbid: "rg-b" });
    });
});
