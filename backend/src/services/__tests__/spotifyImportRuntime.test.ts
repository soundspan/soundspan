describe("spotify import runtime behavior", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    function setupSpotifyImportMocks() {
        const spotifyService = {
            getPlaylist: jest.fn(async () => null),
        };
        const musicBrainzService = {
            clearStaleRecordingCaches: jest.fn(async () => undefined),
            searchArtist: jest.fn(async () => []),
            getReleaseGroups: jest.fn(async () => []),
            searchRecording: jest.fn(async () => null),
        };
        const scanQueue = {
            add: jest.fn(async () => ({ id: "scan-1" })),
        };
        const notificationService = {
            create: jest.fn(async () => undefined),
            notifyImportComplete: jest.fn(async () => undefined),
        };
        const redisRecoveryClient = {
            get: jest.fn(async () => null),
            setEx: jest.fn(async () => "OK"),
            connect: jest.fn(async () => undefined),
        };
        const redisClient = {
            get: jest.fn(async () => null),
            setEx: jest.fn(async () => "OK"),
            duplicate: jest.fn(() => redisRecoveryClient),
        };

        const prisma = {
            $connect: jest.fn(async () => undefined),
            spotifyImportJob: {
                findMany: jest.fn(async () => []),
                findUnique: jest.fn(async () => null),
                upsert: jest.fn(async () => undefined),
            },
            playlistPendingTrack: {
                count: jest.fn(async () => 0),
                findMany: jest.fn(async () => []),
                createMany: jest.fn(async () => ({ count: 0 })),
                deleteMany: jest.fn(async () => ({ count: 0 })),
            },
            playlistItem: {
                findMany: jest.fn(async () => []),
                create: jest.fn(async () => undefined),
                aggregate: jest.fn(async () => ({ _max: { sort: null } })),
            },
            track: {
                findFirst: jest.fn(async () => null),
                findMany: jest.fn(async () => []),
                findUnique: jest.fn(async () => null),
            },
            album: {
                findMany: jest.fn(async () => []),
            },
            artist: {
                findFirst: jest.fn(async () => null),
            },
            downloadJob: {
                findMany: jest.fn(async () => []),
                updateMany: jest.fn(async () => ({ count: 0 })),
            },
            playlist: {
                create: jest.fn(async () => ({ id: "playlist-new" })),
                findUnique: jest.fn(async () => ({
                    id: "playlist-1",
                    name: "Playlist One",
                    userId: "u1",
                })),
            },
        };

        jest.doMock("../../utils/db", () => ({ prisma }));
        jest.doMock("../../utils/redis", () => ({
            redisClient,
        }));
        jest.doMock("../../utils/logger", () => ({
            logger: {
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
            },
        }));
        jest.doMock("../spotify", () => ({
            spotifyService,
        }));
        jest.doMock("../musicbrainz", () => ({ musicBrainzService }));
        const deezerService = {
            getTrackPreview: jest.fn(async () => null),
        };
        jest.doMock("../deezer", () => ({ deezerService }));
        jest.doMock("../../utils/playlistLogger", () => ({
            createPlaylistLogger: jest.fn(() => ({
                debug: jest.fn(),
                info: jest.fn(),
                warn: jest.fn(),
                error: jest.fn(),
                log: jest.fn(),
                logJobStart: jest.fn(),
                logJobFailed: jest.fn(),
                logAlbumDownloadStart: jest.fn(),
                logAlbumFailed: jest.fn(),
                logDownloadProgress: jest.fn(),
                logPlaylistCreationStart: jest.fn(),
                logTrackMatchingStart: jest.fn(),
                logTrackMatch: jest.fn(),
                logPlaylistCreated: jest.fn(),
                logJobComplete: jest.fn(),
            })),
            logPlaylistEvent: jest.fn(),
        }));
        jest.doMock("../notificationService", () => ({
            notificationService,
        }));
        jest.doMock("../../utils/systemSettings", () => ({
            getSystemSettings: jest.fn(async () => ({})),
        }));
        jest.doMock("p-queue", () => {
            return jest.fn().mockImplementation(() => ({
                add: jest.fn(async (fn: () => Promise<unknown>) => fn()),
                onIdle: jest.fn(async () => undefined),
            }));
        });
        const acquisitionService = {
            acquireAlbum: jest.fn(async () => ({
                success: true,
                source: "soulseek",
            })),
            acquireTracks: jest.fn(async () => []),
        };
        jest.doMock("../acquisitionService", () => ({
            acquisitionService,
        }));
        jest.doMock("../../workers/queues", () => ({ scanQueue }));
        jest.doMock("../../utils/artistNormalization", () => ({
            extractPrimaryArtist: jest.fn((name: string) => name),
        }));
        jest.doMock("../../utils/stringNormalization", () => ({
            normalizeFullwidth: jest.fn((value: string) => value),
            normalizeQuotes: jest.fn((value: string) => value),
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
            redisClient,
            redisRecoveryClient,
            spotifyService,
            musicBrainzService,
            scanQueue,
            notificationService,
            deezerService,
            acquisitionService,
        };
    }

    function makeSpotifyTrack(overrides: Partial<Record<string, unknown>> = {}) {
        return {
            spotifyId: "sp-track-1",
            title: "Song A",
            artist: "Artist A",
            artistId: "artist-a",
            album: "Album A",
            albumId: "album-a",
            isrc: null,
            durationMs: 180000,
            trackNumber: 1,
            previewUrl: null,
            coverUrl: null,
            ...overrides,
        };
    }

    it("falls back to database when cached import job JSON is malformed", async () => {
        const { prisma, redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce("{not-json");
        (prisma.spotifyImportJob.findUnique as jest.Mock).mockResolvedValueOnce({
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
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const job = await spotifyImportService.getJob("job-db-fallback");

        expect(job?.id).toBe("job-db-fallback");
        expect(prisma.spotifyImportJob.findUnique).toHaveBeenCalledWith({
            where: { id: "job-db-fallback" },
        });
    });

    it("clears stale recording cache and rejects generatePreview on invalid Spotify URL", async () => {
        const { spotifyService, musicBrainzService } = setupSpotifyImportMocks();
        (spotifyService.getPlaylist as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");

        await expect(
            spotifyImportService.generatePreview(
                "https://open.spotify.com/playlist/missing"
            )
        ).rejects.toThrow(
            "Could not fetch playlist from Spotify. Make sure it's a valid public playlist URL."
        );
        expect(musicBrainzService.clearStaleRecordingCaches).toHaveBeenCalledTimes(1);
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
            "https://open.spotify.com/playlist/sp-1"
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
            "Spotify"
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

        const result = await spotifyImportService.generatePreviewFromDeezer(
            deezerPlaylist
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
            "Deezer"
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
            makeSpotifyTrack()
        );

        expect(result).toEqual(
            expect.objectContaining({
                matchType: "exact",
                matchConfidence: 100,
                localTrack: expect.objectContaining({
                    id: "track-exact-1",
                    artistName: "Artist A",
                }),
            })
        );
        expect(prisma.track.findFirst).toHaveBeenCalledTimes(1);
    });

    it("falls back to full-artist exact matching when primary-artist exact lookup misses", async () => {
        const { prisma } = setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { extractPrimaryArtist } = require("../../utils/artistNormalization");
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
            makeSpotifyTrack({ artist: "Artist A feat. Guest" })
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
            makeSpotifyTrack({ album: "Album A (Super Deluxe Edition)" })
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
            makeSpotifyTrack({ album: "Unknown Album" })
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
            })
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
            spotifyImportService.getPendingTracksCount("playlist-1")
        ).resolves.toBe(3);

        await expect(
            spotifyImportService.getPendingTracks("playlist-1")
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
        (prisma.spotifyImportJob.findUnique as jest.Mock).mockResolvedValueOnce({
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
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const job = await spotifyImportService.getJob("job-db");

        expect(job?.id).toBe("job-db");
        expect(redisClient.setEx).toHaveBeenCalledWith(
            "import:job:job-db",
            24 * 60 * 60,
            expect.any(String)
        );
    });

    it("returns null from getJob when neither redis nor database has the import job", async () => {
        const { prisma, redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(null);
        (prisma.spotifyImportJob.findUnique as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(spotifyImportService.getJob("missing-job")).resolves.toBeNull();
    });

    it("recreates redis client and retries when cache read sees a closed connection", async () => {
        const { redisClient, redisRecoveryClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockRejectedValueOnce(
            new Error("Connection is closed")
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
            })
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
            "temporary outage"
        );
        (prisma.spotifyImportJob.findMany as jest.Mock)
            .mockRejectedValueOnce(retryable)
            .mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(spotifyImportService.getUserJobs("u-retry")).resolves.toEqual([]);

        expect(prisma.$connect).toHaveBeenCalledTimes(1);
        expect(prisma.spotifyImportJob.findMany).toHaveBeenCalledTimes(2);
    });

    it("propagates non-retryable prisma errors without reconnect attempts", async () => {
        const { prisma } = setupSpotifyImportMocks();
        const boom = new Error("non-retryable");
        (prisma.spotifyImportJob.findMany as jest.Mock).mockRejectedValueOnce(boom);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(spotifyImportService.getUserJobs("u-fail")).rejects.toThrow(
            "non-retryable"
        );

        expect(prisma.$connect).not.toHaveBeenCalled();
        expect(prisma.spotifyImportJob.findMany).toHaveBeenCalledTimes(1);
    });

    it("throws after exhausting prisma retries on repeated retryable failures", async () => {
        const { prisma } = setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        const retryable = new Prisma.PrismaClientKnownRequestError(
            "db still unavailable"
        );
        (prisma.spotifyImportJob.findMany as jest.Mock).mockRejectedValue(retryable);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.getUserJobs("u-retry-exhausted")
        ).rejects.toThrow("db still unavailable");

        expect(prisma.$connect).toHaveBeenCalledTimes(2);
        expect(prisma.spotifyImportJob.findMany).toHaveBeenCalledTimes(3);
    });

    it("falls back to database when redis read fails with non-retryable error", async () => {
        const { redisClient, prisma } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockRejectedValueOnce(
            new Error("permission denied")
        );
        (prisma.spotifyImportJob.findUnique as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(spotifyImportService.getJob("job-redis-fail")).resolves.toBeNull();
        expect(prisma.spotifyImportJob.findUnique).toHaveBeenCalledWith({
            where: { id: "job-redis-fail" },
        });
    });

    it("retries redis writes during cancelJob when cache connection closes", async () => {
        const { prisma, redisClient, redisRecoveryClient } = setupSpotifyImportMocks();
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
            })
        );
        (redisClient.setEx as jest.Mock).mockRejectedValueOnce(
            new Error("Connection is closed")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.cancelJob("job-cancel-redis-retry")
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
            })
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
            })
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
            })
        );
        expect(prisma.spotifyImportJob.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-active" },
                update: expect.objectContaining({
                    status: "cancelled",
                }),
            })
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

        await expect(spotifyImportService.cancelJob("missing-job")).rejects.toThrow(
            "Import job not found"
        );
    });

    it("rejects refreshJobMatches when the import job does not exist", async () => {
        const { redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");

        await expect(
            spotifyImportService.refreshJobMatches("missing-job")
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
            })
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");

        await expect(
            spotifyImportService.refreshJobMatches("job-no-playlist")
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
            })
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
        const result = await spotifyImportService.refreshJobMatches(
            "job-refresh"
        );

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
            })
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
                }
            )
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
            })
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
                        "No download jobs were created for this import"
                    ),
                }),
            })
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
            })
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
            })
        );
        expect(scanQueue.add).not.toHaveBeenCalled();
        expect(prisma.spotifyImportJob.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-pending-wait" },
                update: expect.objectContaining({
                    status: "downloading",
                }),
            })
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
            })
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
            })
        );
        expect(scanQueue.add).toHaveBeenCalledWith(
            "scan",
            expect.objectContaining({
                userId: "u1",
                spotifyImportJobId: "job-timeout",
            })
        );
        expect(prisma.spotifyImportJob.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-timeout" },
                update: expect.objectContaining({
                    status: "scanning",
                    progress: 75,
                }),
            })
        );
    });

    it("returns from buildPlaylistAfterScan when import job cannot be found", async () => {
        const { redisClient, prisma } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(null);
        (prisma.spotifyImportJob.findUnique as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.buildPlaylistAfterScan("missing-after-scan")
        ).resolves.toBeUndefined();

        expect(prisma.playlist.create).not.toHaveBeenCalled();
    });

    it("builds playlist after scan using pre-matched tracks and marks job complete", async () => {
        const { redisClient, prisma, notificationService } = setupSpotifyImportMocks();
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
            })
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
            spotifyImportService.buildPlaylistAfterScan("job-build-after-scan")
        ).resolves.toBeUndefined();

        expect(prisma.playlist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    spotifyPlaylistId: "sp-10",
                    items: {
                        create: [{ trackId: "track-pre-1", sort: 0 }],
                    },
                }),
            })
        );
        expect(prisma.spotifyImportJob.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-build-after-scan" },
                update: expect.objectContaining({
                    status: "completed",
                    progress: 100,
                    createdPlaylistId: "playlist-built",
                }),
            })
        );
        expect(notificationService.notifyImportComplete).toHaveBeenCalledWith(
            "u1",
            "After Scan Build",
            "playlist-built",
            1,
            1
        );
    });

    it("exercises deep buildPlaylist fallback matching strategies and saves unmatched pending tracks", async () => {
        const { redisClient, prisma, deezerService } = setupSpotifyImportMocks();
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
            })
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
            new Error("preview unavailable")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.buildPlaylistAfterScan("job-build-fallbacks")
        ).resolves.toBeUndefined();

        expect(prisma.playlist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    spotifyPlaylistId: "sp-11",
                    items: undefined,
                }),
            })
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
            })
        );
    });

    it("returns early from reconcilePendingTracks when there are no pending entries", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.playlistPendingTrack.findMany as jest.Mock).mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(spotifyImportService.reconcilePendingTracks()).resolves.toEqual(
            { playlistsUpdated: 0, tracksAdded: 0 }
        );
    });

    it("reconciles matched pending tracks into playlist and emits playlist-updated notification", async () => {
        const { prisma, notificationService } = setupSpotifyImportMocks();
        (prisma.playlistPendingTrack.findMany as jest.Mock).mockResolvedValueOnce([
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
            })
        );
        expect(result).toEqual({ playlistsUpdated: 1, tracksAdded: 1 });
    });

    it("reconciles pending tracks through strategy-2/3/4 fallback matching paths", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.playlistPendingTrack.findMany as jest.Mock).mockResolvedValueOnce([
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
        (prisma.track.findFirst as jest.Mock).mockImplementation(async (query: any) => {
            if (query?.select?.id && query?.where?.title?.equals) {
                return null;
            }
            return null;
        });
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query: any) => {
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
                            artist: { name: "Different Artist", normalizedName: "different artist" },
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
                            artist: { name: "Fallback Artist", normalizedName: "fallback artist" },
                        },
                    },
                ];
            }

            return [];
        });

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
                    "Engine has already exited"
                )
            )
            .mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(spotifyImportService.getUserJobs("u-unknown")).resolves.toEqual(
            []
        );
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
            preview as any
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
            ])
        );
        expect(processSpy).toHaveBeenCalledWith(
            expect.objectContaining({ id: job.id }),
            [],
            preview
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
            (spotifyImportService as any).processImport(job, ["sp-unk"], preview)
        ).resolves.toBeUndefined();

        expect(acquisitionService.acquireTracks).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ trackTitle: "Unknown A" }),
                expect.objectContaining({ trackTitle: "Unknown B" }),
            ]),
            expect.objectContaining({
                userId: "u1",
                spotifyImportJobId: "job-process-unknown",
            })
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
                albumPreview
            )
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

        const stats = await (spotifyImportService as any).enrichUnknownAlbumsViaMusicBrainz(
            tracks,
            "[Test Import]"
        );

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
                "Missing Album"
            )
        ).resolves.toEqual({ artistMbid: null, albumMbid: null });
        await expect(
            (spotifyImportService as any).findAlbumMbid(
                "Error Artist",
                "Error Album"
            )
        ).resolves.toEqual({ artistMbid: null, albumMbid: null });
    });

    it("resolves album MBIDs via artist and release-group matching", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchArtist as jest.Mock).mockResolvedValueOnce([
            { id: "artist-1", name: "Artist One" },
        ]);
        (musicBrainzService.getReleaseGroups as jest.Mock).mockResolvedValueOnce([
            { id: "rg-a", title: "Other Album" },
            { id: "rg-b", title: "Target Album" },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            (spotifyImportService as any).findAlbumMbid(
                "Artist One",
                "Target Album"
            )
        ).resolves.toEqual({ artistMbid: "artist-1", albumMbid: "rg-b" });
    });

    it("builds preview albums using pre-resolved MBIDs and track-based MusicBrainz fallback", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchArtist as jest.Mock).mockResolvedValue([
            { id: "artist-u", name: "Artist Unknown" },
        ]);
        (musicBrainzService.searchRecording as jest.Mock).mockResolvedValueOnce({
            albumName: "Recovered Album",
            albumMbid: "rg-recovered",
            artistMbid: "artist-k",
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const unknownTrack = makeSpotifyTrack({
            spotifyId: "sp-u",
            title: "Unknown Song",
            artist: "Artist Unknown",
            album: "Unknown Album",
            albumId: "sp-u-album",
        });
        const knownTrack = makeSpotifyTrack({
            spotifyId: "sp-k",
            title: "Known Song",
            artist: "Artist Known",
            album: "Known Album",
            albumId: "sp-k-album",
        });

        jest
            .spyOn(spotifyImportService as any, "enrichUnknownAlbumsViaMusicBrainz")
            .mockImplementation(async (tracks: unknown) => {
                const mutableTracks = tracks as any[];
                mutableTracks[0].albumId = "mbid:rg-pre-resolved";
                mutableTracks[0].album = "Recovered Unknown";
                return { resolved: 1, failed: 0, cached: new Map() };
            });
        jest
            .spyOn(spotifyImportService as any, "matchTrack")
            .mockImplementation(async (spotifyTrack: any) => ({
                spotifyTrack,
                localTrack: null,
                matchType: "none",
                matchConfidence: 0,
            }));
        jest
            .spyOn(spotifyImportService as any, "findAlbumMbid")
            .mockResolvedValue({ artistMbid: "artist-k", albumMbid: null });

        const preview = await (spotifyImportService as any).buildPreviewFromTracklist(
            [unknownTrack, knownTrack],
            {
                id: "playlist-preview",
                name: "Preview",
                description: null,
                owner: "owner-1",
                imageUrl: null,
                trackCount: 2,
            },
            "Spotify"
        );

        expect(preview.albumsToDownload).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    albumMbid: "rg-pre-resolved",
                    artistName: "Artist Unknown",
                }),
                expect.objectContaining({
                    albumMbid: "rg-recovered",
                    artistName: "Artist Known",
                    albumName: "Recovered Album",
                }),
            ])
        );
        expect(preview.summary.downloadable).toBe(2);
    });

    it("runs buildPlaylist through deep matching strategies with dedupe and unmatched carry-over", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "track-strategy",
            title: "Epic Song One",
        });
        (prisma.track.findFirst as jest.Mock).mockImplementation(async (query: any) => {
            if (query?.where?.id?.in) {
                const contains = String(query?.where?.title?.contains || "").toLowerCase();
                if (contains.includes("epic")) {
                    return { id: "track-strategy", title: "Epic Song One" };
                }
                if (contains.includes("lost")) {
                    return {
                        id: "track-title-only",
                        title: "Lost Ballad of Shadows Extended Version",
                    };
                }
                return null;
            }

            if (query?.where?.title?.startsWith) {
                const startsWith = String(query.where.title.startsWith).toLowerCase();
                if (startsWith.includes("lost ballad")) {
                    return { id: "track-low", title: "Not Similar Song" };
                }
                return null;
            }

            return null;
        });
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query: any) => {
            if (
                query?.take === 10 &&
                query?.where?.title?.contains &&
                !query?.include
            ) {
                const search = String(query.where.title.contains).toLowerCase();
                if (search.includes("epic")) {
                    return [{ id: "track-candidate", title: "Different Epic Demo" }];
                }
                return [];
            }

            if (
                query?.take === 50 &&
                query?.include?.album &&
                query?.where?.album?.artist?.normalizedName?.contains
            ) {
                const artistNeedle = String(
                    query.where.album.artist.normalizedName.contains
                ).toLowerCase();
                if (artistNeedle.includes("artist")) {
                    return [
                        {
                            id: "track-strategy",
                            title: "Epic Song One",
                            album: { artist: { name: "Artist One" } },
                        },
                    ];
                }
                return [];
            }

            if (
                query?.take === 20 &&
                query?.where?.title?.contains &&
                query?.include?.album
            ) {
                const firstWord = String(query.where.title.contains).toLowerCase();
                if (firstWord.includes("lost")) {
                    return [
                        {
                            id: "track-fuzzy-low",
                            title: "Lost Shadows (Alt)",
                            album: { artist: { name: "Other Artist" } },
                        },
                    ];
                }
                return [];
            }

            if (
                query?.take === 50 &&
                query?.where?.title?.contains &&
                query?.include?.album &&
                !query?.where?.album
            ) {
                const titleNeedle = String(query.where.title.contains).toLowerCase();
                if (titleNeedle.includes("lost ballad")) {
                    return [
                        {
                            id: "track-title-only",
                            title: "Lost Ballad of Shadows Extended Version",
                            album: { artist: { name: "Compilation Artist" } },
                        },
                    ];
                }
                return [];
            }

            return [];
        });
        (prisma.artist.findFirst as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const deepJob = {
            id: "job-deep-strategies",
            userId: "u1",
            spotifyPlaylistId: "sp-deep",
            playlistName: "Deep Strategy Playlist",
            status: "scanning",
            progress: 75,
            albumsTotal: 1,
            albumsCompleted: 1,
            tracksMatched: 0,
            tracksTotal: 4,
            tracksDownloadable: 4,
            createdPlaylistId: null,
            error: null,
            createdAt: new Date("2026-01-11T00:00:00.000Z"),
            updatedAt: new Date("2026-01-11T00:00:00.000Z"),
            pendingTracks: [
                {
                    artist: "Artist One",
                    title: "Epic Song One - 2011 Remaster",
                    album: "Album One",
                    albumMbid: null,
                    artistMbid: null,
                    preMatchedTrackId: null,
                },
                {
                    artist: "Artist One",
                    title: "Epic Song One",
                    album: "Album One",
                    albumMbid: null,
                    artistMbid: null,
                    preMatchedTrackId: "track-strategy",
                },
                {
                    artist: "Ghost Artist",
                    title: "Lost Ballad of Shadows Extended Mix",
                    album: "Unknown Album",
                    albumMbid: null,
                    artistMbid: null,
                    preMatchedTrackId: null,
                },
                {
                    artist: "No Library Artist",
                    title: "Completely Unmatched Song",
                    album: "Unknown Album",
                    albumMbid: null,
                    artistMbid: null,
                    preMatchedTrackId: null,
                },
            ],
        };

        await expect(
            (spotifyImportService as any).buildPlaylist(deepJob)
        ).resolves.toBeUndefined();

        expect(prisma.playlist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    spotifyPlaylistId: "sp-deep",
                    items: {
                        create: expect.arrayContaining([
                            expect.objectContaining({ trackId: "track-strategy" }),
                        ]),
                    },
                }),
            })
        );
        expect(prisma.playlistPendingTrack.createMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.arrayContaining([
                    expect.objectContaining({
                        spotifyArtist: "No Library Artist",
                        spotifyTitle: "Completely Unmatched Song",
                    }),
                ]),
            })
        );
    });

    it("processes regular album imports via acquireAlbum and handles waiting state after completion check", async () => {
        const { redisClient, acquisitionService } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify({
                id: "job-regular-download",
                userId: "u1",
                spotifyPlaylistId: "sp-regular",
                playlistName: "Regular Album Import",
                status: "downloading",
                progress: 30,
                albumsTotal: 1,
                albumsCompleted: 1,
                tracksMatched: 0,
                tracksTotal: 2,
                tracksDownloadable: 2,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-12T00:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-01-12T00:01:00.000Z").toISOString(),
                pendingTracks: [],
            })
        );
        (acquisitionService.acquireAlbum as jest.Mock).mockResolvedValueOnce({
            success: true,
            source: "soulseek",
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const completionSpy = jest
            .spyOn(spotifyImportService, "checkImportCompletion")
            .mockResolvedValue(undefined);

        const job = {
            id: "job-regular-download",
            userId: "u1",
            spotifyPlaylistId: "sp-regular",
            playlistName: "Regular Album Import",
            status: "pending",
            progress: 0,
            albumsTotal: 1,
            albumsCompleted: 0,
            tracksMatched: 0,
            tracksTotal: 2,
            tracksDownloadable: 2,
            createdPlaylistId: null,
            error: null,
            createdAt: new Date("2026-01-12T00:00:00.000Z"),
            updatedAt: new Date("2026-01-12T00:00:00.000Z"),
            pendingTracks: [],
        };
        const track = makeSpotifyTrack({
            spotifyId: "sp-r1",
            artist: "Artist Regular",
            title: "Track Regular",
            album: "Album Regular",
            albumId: "sp-regular-alb",
        });
        const preview = {
            playlist: {
                id: "sp-regular",
                name: "Regular Album Import",
                description: null,
                owner: "owner-1",
                imageUrl: null,
                trackCount: 2,
            },
            matchedTracks: [],
            albumsToDownload: [
                {
                    spotifyAlbumId: "sp-regular-alb",
                    albumName: "Album Regular",
                    artistName: "Artist Regular",
                    artistMbid: "artist-regular",
                    albumMbid: "rg-regular",
                    coverUrl: null,
                    trackCount: 1,
                    tracksNeeded: [track],
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
                ["rg-regular"],
                preview
            )
        ).resolves.toBeUndefined();

        expect(acquisitionService.acquireAlbum).toHaveBeenCalledWith(
            expect.objectContaining({
                albumTitle: "Album Regular",
                artistName: "Artist Regular",
                mbid: "rg-regular",
            }),
            expect.objectContaining({
                userId: "u1",
                spotifyImportJobId: "job-regular-download",
            })
        );
        expect(completionSpy).toHaveBeenCalledWith("job-regular-download");
    });

    it("retries spotify-import prisma reads on rust panic and generic retryable string errors", async () => {
        const { prisma } = setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        (prisma.spotifyImportJob.findMany as jest.Mock)
            .mockRejectedValueOnce(
                new Prisma.PrismaClientRustPanicError("panic in query engine")
            )
            .mockRejectedValueOnce("Can't reach database server")
            .mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(spotifyImportService.getUserJobs("u-rust-generic")).resolves.toEqual(
            []
        );

        expect(prisma.spotifyImportJob.findMany).toHaveBeenCalledTimes(3);
        expect(prisma.$connect).toHaveBeenCalledTimes(2);
    });

    it("resolves pending tracks in startImport via tracksNeeded and artist+album fallback strategies", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const processSpy = jest
            .spyOn(spotifyImportService as any, "processImport")
            .mockResolvedValue(undefined);

        const strategy3Track = makeSpotifyTrack({
            spotifyId: "sp-strategy-3",
            artist: "Strategy Artist",
            title: "Strategy Song",
            album: "Unknown Album",
            albumId: "sp-album-unmatched",
        });
        const strategy4Track = makeSpotifyTrack({
            spotifyId: "sp-strategy-4",
            artist: "Similar Artist",
            title: "Similar Song",
            album: "My Similar",
            albumId: "sp-unmatched-2",
        });

        const preview = {
            playlist: {
                id: "sp-strategy",
                name: "Strategy Mapping Playlist",
                description: null,
                owner: "owner-1",
                imageUrl: null,
                trackCount: 2,
            },
            matchedTracks: [
                {
                    spotifyTrack: strategy3Track,
                    localTrack: null,
                    matchType: "none",
                    matchConfidence: 0,
                },
                {
                    spotifyTrack: strategy4Track,
                    localTrack: null,
                    matchType: "none",
                    matchConfidence: 0,
                },
            ],
            albumsToDownload: [
                {
                    spotifyAlbumId: "sp-album-different",
                    albumName: "Unknown Bundle",
                    artistName: "Strategy Artist",
                    artistMbid: "artist-s3",
                    albumMbid: "rg-s3",
                    coverUrl: null,
                    trackCount: 1,
                    tracksNeeded: [
                        makeSpotifyTrack({
                            spotifyId: "sp-strategy-3",
                            artist: "Strategy Artist",
                            title: "Strategy Song",
                            album: "Unknown Album",
                        }),
                    ],
                },
                {
                    spotifyAlbumId: "sp-album-sim",
                    albumName: "My Similar Album Extended",
                    artistName: "Similar Artist",
                    artistMbid: "artist-s4",
                    albumMbid: "rg-s4",
                    coverUrl: null,
                    trackCount: 1,
                    tracksNeeded: [],
                },
            ],
            summary: {
                total: 2,
                inLibrary: 0,
                downloadable: 2,
                notFound: 0,
            },
        };

        const job = await spotifyImportService.startImport(
            "u-strategy",
            "sp-strategy",
            "Strategy Mapping Playlist",
            ["rg-s3", "rg-s4"],
            preview as any
        );

        expect(job.pendingTracks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    title: "Strategy Song",
                    albumMbid: "rg-s3",
                }),
                expect.objectContaining({
                    title: "Similar Song",
                    albumMbid: "rg-s4",
                }),
            ])
        );
        expect(processSpy).toHaveBeenCalled();
    });

    it("persists failed status when background processImport rejects from startImport", async () => {
        const { prisma } = setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        jest.spyOn(spotifyImportService as any, "processImport").mockRejectedValue(
            new Error("process import exploded")
        );

        const preview = {
            playlist: {
                id: "sp-process-fail",
                name: "Process Fail Playlist",
                description: null,
                owner: "owner-1",
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
        };

        await spotifyImportService.startImport(
            "u-process-fail",
            "sp-process-fail",
            "Process Fail Playlist",
            [],
            preview as any
        );

        await new Promise((resolve) => setImmediate(resolve));

        const upsertCalls = (prisma.spotifyImportJob.upsert as jest.Mock).mock.calls;
        expect(
            upsertCalls.some(
                (call: any[]) =>
                    call?.[0]?.update?.status === "failed" &&
                    call?.[0]?.update?.error === "process import exploded"
            )
        ).toBe(true);
    });

    it("marks processImport failed when no-download playlist build throws", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        jest
            .spyOn(spotifyImportService as any, "buildPlaylist")
            .mockRejectedValueOnce(new Error("playlist build failed"));

        const job = {
            id: "job-no-download-build-fail",
            userId: "u1",
            spotifyPlaylistId: "sp-no-download",
            playlistName: "No Download Build Fail",
            status: "pending",
            progress: 0,
            albumsTotal: 0,
            albumsCompleted: 0,
            tracksMatched: 0,
            tracksTotal: 1,
            tracksDownloadable: 0,
            createdPlaylistId: null,
            error: null,
            createdAt: new Date("2026-01-13T00:00:00.000Z"),
            updatedAt: new Date("2026-01-13T00:00:00.000Z"),
            pendingTracks: [],
        };

        await expect(
            (spotifyImportService as any).processImport(job, [], {
                playlist: {
                    id: "sp-no-download",
                    name: "No Download Build Fail",
                    description: null,
                    owner: "owner-1",
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
            })
        ).rejects.toThrow("playlist build failed");

        expect(job.status).toBe("failed");
        expect(job.error).toBe("playlist build failed");
    });

    it("matches buildPlaylist tracks via startsWith, fuzzy-best, and title-only fallback strategies", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.playlist.create as jest.Mock).mockResolvedValueOnce({
            id: "playlist-strategies",
        });

        (prisma.track.findUnique as jest.Mock)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        (prisma.track.findFirst as jest.Mock).mockImplementation(async (query: any) => {
            if (query?.where?.title?.equals && query?.where?.album?.artist?.normalizedName) {
                return null;
            }
            if (
                query?.where?.title?.startsWith &&
                query?.where?.album?.artist?.normalizedName
            ) {
                return {
                    id: "track-startswith-hit",
                    title: "Long StartsWith Match Title",
                };
            }
            if (query?.where?.id?.in && query?.where?.title?.contains) {
                return {
                    id: query.where.id.in[0],
                    title: "Matched Title",
                };
            }
            return null;
        });

        (prisma.track.findMany as jest.Mock).mockImplementation(async (query: any) => {
            if (
                query?.where?.title?.contains &&
                query?.where?.album?.artist?.normalizedName &&
                query?.take === 10
            ) {
                return [];
            }
            if (
                query?.where?.album?.artist?.normalizedName &&
                query?.include?.album &&
                query?.take === 50
            ) {
                const artistNeedle = String(
                    query.where.album.artist.normalizedName.contains || ""
                ).toLowerCase();
                if (artistNeedle.includes("fuzzy")) {
                    return [
                        {
                            id: "track-fuzzy-best",
                            title: "Fuzzy Winner Song",
                            album: { artist: { name: "Fuzzy Artist" } },
                        },
                    ];
                }
                return [];
            }
            if (
                query?.where?.title?.contains &&
                query?.where?.album?.artist?.normalizedName &&
                query?.include?.album &&
                query?.take === 20
            ) {
                const firstWord = String(query.where.title.contains).toLowerCase();
                if (firstWord.includes("fuzzy")) {
                    return [
                        {
                            id: "track-fuzzy-best",
                            title: "Fuzzy Winner Song",
                            album: { artist: { name: "Fuzzy Artist" } },
                        },
                    ];
                }
                return [];
            }
            if (
                query?.where?.title?.contains &&
                !query?.where?.album &&
                query?.include?.album &&
                query?.take === 50
            ) {
                return [
                    {
                        id: "track-title-only",
                        title: "Very Long Title Only Match Anthem",
                        album: { artist: { name: "Compilation Artist" } },
                    },
                ];
            }
            return [];
        });
        (prisma.artist.findFirst as jest.Mock).mockResolvedValue(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const deepJob = {
            id: "job-build-strategy-branches",
            userId: "u1",
            spotifyPlaylistId: "sp-branches",
            playlistName: "Branch Coverage Playlist",
            status: "scanning",
            progress: 75,
            albumsTotal: 1,
            albumsCompleted: 1,
            tracksMatched: 0,
            tracksTotal: 3,
            tracksDownloadable: 3,
            createdPlaylistId: null,
            error: null,
            createdAt: new Date("2026-01-13T00:00:00.000Z"),
            updatedAt: new Date("2026-01-13T00:00:00.000Z"),
            pendingTracks: [
                {
                    artist: "Starts Artist",
                    title: "Long StartsWith Match Title Remastered",
                    album: "Album Starts",
                    albumMbid: null,
                    artistMbid: null,
                    preMatchedTrackId: null,
                },
                {
                    artist: "Fuzzy Artist",
                    title: "Fuzzy Winner Song 2011 Remaster",
                    album: "Album Fuzzy",
                    albumMbid: null,
                    artistMbid: null,
                    preMatchedTrackId: null,
                },
                {
                    artist: "Different Artist",
                    title: "Very Long Title Only Match Anthem - Live",
                    album: "Unknown Album",
                    albumMbid: null,
                    artistMbid: null,
                    preMatchedTrackId: null,
                },
            ],
        };

        await expect(
            (spotifyImportService as any).buildPlaylist(deepJob)
        ).resolves.toBeUndefined();

        expect(prisma.playlist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    spotifyPlaylistId: "sp-branches",
                    items: {
                        create: expect.arrayContaining([
                            expect.objectContaining({ trackId: "track-startswith-hit" }),
                            expect.objectContaining({ trackId: "track-fuzzy-best" }),
                            expect.objectContaining({ trackId: "track-title-only" }),
                        ]),
                    },
                }),
            })
        );
    });

    it("continues buildPlaylist when completion notification fails", async () => {
        const { prisma, notificationService } = setupSpotifyImportMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "track-notif-1",
            title: "Song Notify",
        });
        (prisma.track.findFirst as jest.Mock).mockResolvedValue({
            id: "track-notif-1",
            title: "Song Notify",
        });
        (prisma.playlist.create as jest.Mock).mockResolvedValueOnce({
            id: "playlist-notif-fail",
        });
        (notificationService.notifyImportComplete as jest.Mock).mockRejectedValueOnce(
            new Error("notification down")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            (spotifyImportService as any).buildPlaylist({
                id: "job-notif-fail",
                userId: "u1",
                spotifyPlaylistId: "sp-notif-fail",
                playlistName: "Notification Fail Playlist",
                status: "scanning",
                progress: 75,
                albumsTotal: 1,
                albumsCompleted: 1,
                tracksMatched: 0,
                tracksTotal: 1,
                tracksDownloadable: 1,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-13T01:00:00.000Z"),
                updatedAt: new Date("2026-01-13T01:00:00.000Z"),
                pendingTracks: [
                    {
                        artist: "Artist Notify",
                        title: "Song Notify",
                        album: "Album Notify",
                        albumMbid: null,
                        artistMbid: null,
                        preMatchedTrackId: "track-notif-1",
                    },
                ],
            })
        ).resolves.toBeUndefined();
    });

    it("returns strategy-2 normalized album match when startsWith album lookup hits", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findFirst as jest.Mock)
            .mockResolvedValueOnce(null) // strategy 1
            .mockResolvedValueOnce({
                id: "track-normalized-album-hit",
                title: "Song A",
                albumId: "album-norm",
                album: {
                    title: "Album A (Deluxe Edition)",
                    artist: { name: "Artist A" },
                },
            }); // strategy 2 direct startsWith match

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await (spotifyImportService as any).matchTrack(
            makeSpotifyTrack({
                artist: "Artist A",
                album: "Album A (Super Deluxe Edition)",
            })
        );

        expect(result.matchType).toBe("exact");
        expect(result.matchConfidence).toBe(95);
        expect(result.localTrack?.id).toBe("track-normalized-album-hit");
    });

    it("uses full-artist strategy-3 fallback when primary-artist title matching returns no results", async () => {
        const { prisma } = setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { extractPrimaryArtist } = require("../../utils/artistNormalization");
        (extractPrimaryArtist as jest.Mock).mockReturnValueOnce("Artist A");
        (prisma.track.findFirst as jest.Mock).mockResolvedValueOnce(null); // strategy 1
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([]) // strategy 3 with primary artist
            .mockResolvedValueOnce([
                {
                    id: "track-full-artist-fallback",
                    title: "Song A",
                    albumId: "album-full",
                    album: {
                        title: "Album A",
                        artist: { name: "Artist A feat. Guest" },
                    },
                },
            ]); // strategy 3 with full artist

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await (spotifyImportService as any).matchTrack(
            makeSpotifyTrack({
                artist: "Artist A feat. Guest",
                album: "Unknown Album",
            })
        );

        expect(prisma.track.findMany).toHaveBeenCalledTimes(2);
        expect(result.localTrack?.id).toBe("track-full-artist-fallback");
    });

    it("prefers album-matched artist-title candidates when album metadata is available", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findFirst as jest.Mock).mockResolvedValueOnce(null); // strategy 1
        (prisma.track.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "track-album-match",
                title: "Song A",
                albumId: "album-match",
                album: {
                    title: "My Album Deluxe",
                    artist: { name: "Artist A" },
                },
            },
            {
                id: "track-non-match",
                title: "Song A",
                albumId: "album-other",
                album: {
                    title: "Other Album",
                    artist: { name: "Artist A" },
                },
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await (spotifyImportService as any).matchTrack(
            makeSpotifyTrack({
                artist: "Artist A",
                album: "My Album",
            })
        );

        expect(result.matchType).toBe("exact");
        expect(result.matchConfidence).toBe(90);
        expect(result.localTrack?.id).toBe("track-album-match");
    });

    it("falls back to full-artist fuzzy search strategy when earlier fuzzy passes find nothing", async () => {
        const { prisma } = setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { extractPrimaryArtist } = require("../../utils/artistNormalization");
        (extractPrimaryArtist as jest.Mock).mockReturnValueOnce("Artist");
        (prisma.track.findFirst as jest.Mock).mockResolvedValueOnce(null); // strategy 1
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([]) // strategy 3 (primary)
            .mockResolvedValueOnce([]) // strategy 3 (full artist)
            .mockResolvedValueOnce([]) // strategy 4a
            .mockResolvedValueOnce([]) // strategy 4b
            .mockResolvedValueOnce([
                // strategy 4c (full artist fuzzy)
                {
                    id: "track-fuzzy-full-artist",
                    title: "Long Song Title",
                    albumId: "album-fuzzy",
                    album: {
                        title: "Album Fuzzy",
                        artist: { name: "Artist Feat Guest" },
                    },
                },
            ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await (spotifyImportService as any).matchTrack(
            makeSpotifyTrack({
                artist: "Artist Feat Guest",
                title: "Long Song Title",
                album: "Unknown Album",
            })
        );

        expect(result.matchType).toBe("fuzzy");
        expect(result.localTrack?.id).toBe("track-fuzzy-full-artist");
    });

    it("returns an explicit none match when all track-matching strategies fail", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await (spotifyImportService as any).matchTrack(
            makeSpotifyTrack({
                artist: "No Match Artist",
                title: "No Match Song",
                album: "Unknown Album",
            })
        );

        expect(result).toEqual(
            expect.objectContaining({
                matchType: "none",
                matchConfidence: 0,
                localTrack: null,
            })
        );
    });

    it("returns artist MBID with null album MBID when no release groups satisfy similarity threshold", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchArtist as jest.Mock).mockResolvedValueOnce([
            { id: "artist-no-rg", name: "Artist No RG" },
        ]);
        (musicBrainzService.getReleaseGroups as jest.Mock).mockResolvedValueOnce([
            { id: "rg-low-1", title: "Completely Different Album" },
            { id: "rg-low-2", title: "Another Different Album" },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            (spotifyImportService as any).findAlbumMbid(
                "Artist No RG",
                "Target Album Name"
            )
        ).resolves.toEqual({ artistMbid: "artist-no-rg", albumMbid: null });
    });

    it("skips MusicBrainz unknown-album enrichment when there are no unknown tracks", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const stats = await (spotifyImportService as any).enrichUnknownAlbumsViaMusicBrainz(
            [
                makeSpotifyTrack({
                    spotifyId: "sp-known-1",
                    album: "Known Album",
                }),
            ],
            "[Known Tracks]"
        );

        expect(stats).toEqual({
            resolved: 0,
            failed: 0,
            cached: new Map(),
        });
    });

    it("caches unresolved unknown-album lookups and increments failed counters for duplicates", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchRecording as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const duplicateUnknownTracks = [
            makeSpotifyTrack({
                spotifyId: "sp-unknown-1",
                artist: "Artist Unknown",
                title: "Unknown Song",
                album: "Unknown Album",
            }),
            makeSpotifyTrack({
                spotifyId: "sp-unknown-2",
                artist: "Artist Unknown",
                title: "Unknown Song",
                album: "Unknown Album",
            }),
        ];

        const stats = await (spotifyImportService as any).enrichUnknownAlbumsViaMusicBrainz(
            duplicateUnknownTracks,
            "[Unknown Duplicate]"
        );

        expect(stats.resolved).toBe(0);
        expect(stats.failed).toBe(2);
        expect(musicBrainzService.searchRecording).toHaveBeenCalledTimes(1);
    });

    it("continues preview generation when unknown-album enrichment throws and tracks remain unknown", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        jest
            .spyOn(spotifyImportService as any, "enrichUnknownAlbumsViaMusicBrainz")
            .mockRejectedValueOnce(new Error("enrichment failed"));
        jest
            .spyOn(spotifyImportService as any, "matchTrack")
            .mockResolvedValue({
                spotifyTrack: makeSpotifyTrack({
                    spotifyId: "sp-preview-unknown",
                    artist: "Preview Artist",
                    title: "Preview Song",
                    album: "Unknown Album",
                }),
                localTrack: null,
                matchType: "none",
                matchConfidence: 0,
            });
        jest.spyOn(spotifyImportService as any, "findAlbumMbid").mockResolvedValue({
            artistMbid: null,
            albumMbid: null,
        });

        const preview = await (spotifyImportService as any).buildPreviewFromTracklist(
            [
                makeSpotifyTrack({
                    spotifyId: "sp-preview-unknown",
                    artist: "Preview Artist",
                    title: "Preview Song",
                    album: "Unknown Album",
                }),
            ],
            {
                id: "playlist-preview-error",
                name: "Preview Error Playlist",
                description: null,
                owner: "owner-1",
                imageUrl: null,
                trackCount: 1,
            },
            "Spotify"
        );

        expect(preview.summary.total).toBe(1);
        expect(preview.albumsToDownload).toHaveLength(1);
    });

    it("continues cancelJob when redis cache write fails during job persistence", async () => {
        const { redisClient } = setupSpotifyImportMocks();
        const activeJob = {
            id: "job-cancel-cache-warn",
            userId: "u1",
            spotifyPlaylistId: "sp-cancel",
            playlistName: "Cancel Cache Warn",
            status: "downloading",
            progress: 42,
            albumsTotal: 2,
            albumsCompleted: 1,
            tracksMatched: 3,
            tracksTotal: 8,
            tracksDownloadable: 5,
            createdPlaylistId: null,
            error: null,
            createdAt: new Date("2026-01-14T00:00:00.000Z"),
            updatedAt: new Date("2026-01-14T00:01:00.000Z"),
            pendingTracks: [],
        };
        (redisClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify(activeJob)
        );
        (redisClient.setEx as jest.Mock).mockRejectedValueOnce(
            new Error("cache write failed")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { logger } = require("../../utils/logger");
        await expect(
            spotifyImportService.cancelJob("job-cancel-cache-warn")
        ).resolves.toEqual({
            playlistCreated: false,
            playlistId: null,
            tracksMatched: 0,
        });

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                "Failed to cache import job job-cancel-cache-warn in Redis:"
            ),
            expect.any(Error)
        );
    });

    it("returns DB-backed import jobs when redis repopulation fails", async () => {
        const { prisma, redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(null);
        (prisma.spotifyImportJob.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "job-db-cache-warn",
            userId: "u1",
            spotifyPlaylistId: "sp-db-cache-warn",
            playlistName: "DB Cache Warn",
            status: "pending",
            progress: 5,
            albumsTotal: 1,
            albumsCompleted: 0,
            tracksMatched: 0,
            tracksTotal: 2,
            tracksDownloadable: 2,
            createdPlaylistId: null,
            error: null,
            createdAt: new Date("2026-01-14T00:00:00.000Z"),
            updatedAt: new Date("2026-01-14T00:01:00.000Z"),
            pendingTracks: [],
        });
        (redisClient.setEx as jest.Mock).mockRejectedValueOnce(
            new Error("repopulate failed")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { logger } = require("../../utils/logger");
        const job = await spotifyImportService.getJob("job-db-cache-warn");

        expect(job?.id).toBe("job-db-cache-warn");
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                "Failed to cache import job job-db-cache-warn in Redis:"
            ),
            expect.any(Error)
        );
    });

    it("checks pending download completion using oldest pending job ordering", async () => {
        const { prisma, redisClient, scanQueue } = setupSpotifyImportMocks();
        const now = Date.now();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify({
                id: "job-pending-order",
                userId: "u1",
                spotifyPlaylistId: "sp-pending-order",
                playlistName: "Pending Ordering",
                status: "downloading",
                progress: 30,
                albumsTotal: 1,
                albumsCompleted: 1,
                tracksMatched: 0,
                tracksTotal: 2,
                tracksDownloadable: 2,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-14T00:00:00.000Z"),
                updatedAt: new Date("2026-01-14T00:01:00.000Z"),
                pendingTracks: [],
            })
        );
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "dj-younger",
                status: "processing",
                createdAt: new Date(now - 60_000),
            },
            {
                id: "dj-older",
                status: "pending",
                createdAt: new Date(now - 120_000),
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.checkImportCompletion("job-pending-order")
        ).resolves.toBeUndefined();

        expect(scanQueue.add).not.toHaveBeenCalled();
        expect(redisClient.setEx).toHaveBeenCalled();
    });

    it("matches buildPlaylist tracks via strategy-3 contains+similarity branch", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(null);
        (prisma.track.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query: any) => {
            if (query?.take === 10 && query?.where?.title?.contains) {
                return [
                    {
                        id: "track-build-s3-direct",
                        title: "Direct Similarity Anthem",
                    },
                ];
            }
            return [];
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            (spotifyImportService as any).buildPlaylist({
                id: "job-build-s3-direct",
                userId: "u1",
                spotifyPlaylistId: "sp-build-s3-direct",
                playlistName: "Build S3 Direct",
                status: "scanning",
                progress: 75,
                albumsTotal: 1,
                albumsCompleted: 1,
                tracksMatched: 0,
                tracksTotal: 1,
                tracksDownloadable: 1,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-14T00:00:00.000Z"),
                updatedAt: new Date("2026-01-14T00:00:00.000Z"),
                pendingTracks: [
                    {
                        artist: "Similarity Artist",
                        title: "Direct Similarity Anthem - 2020 Remaster",
                        album: "Unknown Album",
                        albumMbid: null,
                        artistMbid: null,
                        preMatchedTrackId: null,
                    },
                ],
            })
        ).resolves.toBeUndefined();

        expect(prisma.playlist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    items: {
                        create: [expect.objectContaining({ trackId: "track-build-s3-direct" })],
                    },
                }),
            })
        );
    });

    it("matches buildPlaylist tracks via strategy-3 containment branch", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(null);
        (prisma.track.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query: any) => {
            if (query?.take === 10 && query?.where?.title?.contains) {
                return [
                    {
                        id: "track-build-s3-containment",
                        title:
                            "Containment Match Song and a very long extended alternate live studio take",
                    },
                ];
            }
            return [];
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            (spotifyImportService as any).buildPlaylist({
                id: "job-build-s3-containment",
                userId: "u1",
                spotifyPlaylistId: "sp-build-s3-containment",
                playlistName: "Build S3 Containment",
                status: "scanning",
                progress: 75,
                albumsTotal: 1,
                albumsCompleted: 1,
                tracksMatched: 0,
                tracksTotal: 1,
                tracksDownloadable: 1,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-14T00:00:00.000Z"),
                updatedAt: new Date("2026-01-14T00:00:00.000Z"),
                pendingTracks: [
                    {
                        artist: "Containment Artist",
                        title: "Containment Match Song",
                        album: "Unknown Album",
                        albumMbid: null,
                        artistMbid: null,
                        preMatchedTrackId: null,
                    },
                ],
            })
        ).resolves.toBeUndefined();

        expect(prisma.playlist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    items: {
                        create: [
                            expect.objectContaining({
                                trackId: "track-build-s3-containment",
                            }),
                        ],
                    },
                }),
            })
        );
    });

    it("matches buildPlaylist tracks via strategy-5 best fuzzy candidate selection", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(null);
        (prisma.track.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query: any) => {
            if (query?.take === 10 && query?.where?.title?.contains) {
                return []; // strategy 3
            }
            if (query?.take === 50 && query?.include?.album) {
                return []; // strategy 3.5
            }
            if (query?.take === 20 && query?.include?.album) {
                return [
                    {
                        id: "track-build-s5-best",
                        title: "Fuzzy Last Resort Anthem",
                        album: { artist: { name: "Fuzzy Final Artist" } },
                    },
                ];
            }
            return [];
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            (spotifyImportService as any).buildPlaylist({
                id: "job-build-s5-best",
                userId: "u1",
                spotifyPlaylistId: "sp-build-s5-best",
                playlistName: "Build S5 Best",
                status: "scanning",
                progress: 75,
                albumsTotal: 1,
                albumsCompleted: 1,
                tracksMatched: 0,
                tracksTotal: 1,
                tracksDownloadable: 1,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-14T00:00:00.000Z"),
                updatedAt: new Date("2026-01-14T00:00:00.000Z"),
                pendingTracks: [
                    {
                        artist: "Fuzzy Final Artist",
                        title: "Fuzzy Last Resort Anthem",
                        album: "Unknown Album",
                        albumMbid: null,
                        artistMbid: null,
                        preMatchedTrackId: null,
                    },
                ],
            })
        ).resolves.toBeUndefined();

        expect(prisma.playlist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    items: {
                        create: [expect.objectContaining({ trackId: "track-build-s5-best" })],
                    },
                }),
            })
        );
    });

    it("reconciles pending tracks through strategy-2 similarity/containment and strategy-3 score thresholds", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.playlistPendingTrack.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "pending-direct",
                playlistId: "playlist-advanced",
                spotifyArtist: "Artist One",
                spotifyTitle: "Direct Similarity Song - 2020 Remaster",
                spotifyAlbum: "Unknown Album",
                sort: 0,
                playlist: {
                    id: "playlist-advanced",
                    name: "Advanced Reconcile",
                    userId: "u1",
                },
            },
            {
                id: "pending-containment",
                playlistId: "playlist-advanced",
                spotifyArtist: "Artist Two",
                spotifyTitle: "Containment Seed Song",
                spotifyAlbum: "Unknown Album",
                sort: 1,
                playlist: {
                    id: "playlist-advanced",
                    name: "Advanced Reconcile",
                    userId: "u1",
                },
            },
            {
                id: "pending-fuzzy",
                playlistId: "playlist-advanced",
                spotifyArtist: "Artist Three",
                spotifyTitle: "Fuzzy Third Song (Live)",
                spotifyAlbum: "Unknown Album",
                sort: 2,
                playlist: {
                    id: "playlist-advanced",
                    name: "Advanced Reconcile",
                    userId: "u1",
                },
            },
        ]);
        (prisma.playlistItem.aggregate as jest.Mock).mockResolvedValueOnce({
            _max: { sort: 0 },
        });
        (prisma.playlistItem.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query: any) => {
            if (query?.select?.title && query?.take === 5) {
                return [];
            }

            if (query?.take === 10 && query?.include?.album) {
                const containsTerm = String(query?.where?.title?.contains || "");
                if (containsTerm.includes("Direct Similarity")) {
                    return [
                        {
                            id: "track-reconcile-direct",
                            title: "Direct Similarity Song",
                            album: { artist: { name: "Artist One" } },
                        },
                    ];
                }
                if (containsTerm.includes("Containment Seed")) {
                    return [
                        {
                            id: "track-reconcile-containment",
                            title:
                                "Containment Seed Song with a very long extended alternate mix version",
                            album: { artist: { name: "Artist Two" } },
                        },
                    ];
                }
                return [];
            }

            if (query?.take === 20 && query?.include?.album) {
                return [
                    {
                        id: "track-reconcile-strategy3",
                        title: "Fuzzy Third Song",
                        album: { artist: { name: "Artist Three" } },
                    },
                ];
            }

            return [];
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await spotifyImportService.reconcilePendingTracks();

        expect(prisma.playlistItem.create).toHaveBeenCalledTimes(3);
        expect(prisma.playlistItem.create).toHaveBeenCalledWith({
            data: {
                playlistId: "playlist-advanced",
                trackId: "track-reconcile-direct",
                sort: 1,
            },
        });
        expect(prisma.playlistItem.create).toHaveBeenCalledWith({
            data: {
                playlistId: "playlist-advanced",
                trackId: "track-reconcile-containment",
                sort: 2,
            },
        });
        expect(prisma.playlistItem.create).toHaveBeenCalledWith({
            data: {
                playlistId: "playlist-advanced",
                trackId: "track-reconcile-strategy3",
                sort: 3,
            },
        });
        expect(result).toEqual({ playlistsUpdated: 1, tracksAdded: 3 });
    });

    it("normalizes album and track names during preview MBID resolution and fallback recording lookup", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchRecording as jest.Mock).mockResolvedValueOnce({
            albumName: "Fallback Recovered Album",
            albumMbid: "rg-fallback",
            artistMbid: "artist-fallback",
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        jest
            .spyOn(spotifyImportService as any, "matchTrack")
            .mockResolvedValue({
                spotifyTrack: makeSpotifyTrack(),
                localTrack: null,
                matchType: "none",
                matchConfidence: 0,
            });
        jest
            .spyOn(spotifyImportService as any, "findAlbumMbid")
            .mockResolvedValueOnce({
                artistMbid: "artist-direct",
                albumMbid: "rg-direct",
            })
            .mockResolvedValueOnce({
                artistMbid: "artist-fallback",
                albumMbid: null,
            });

        const preview = await (spotifyImportService as any).buildPreviewFromTracklist(
            [
                makeSpotifyTrack({
                    spotifyId: "sp-direct",
                    artist: "Direct Artist",
                    title: "Direct Song",
                    album: "Direct Album (Super Deluxe Edition)",
                    albumId: "sp-direct-album",
                }),
                makeSpotifyTrack({
                    spotifyId: "sp-fallback",
                    artist: "Fallback Artist",
                    title: "Fallback Song - 2011 Remaster",
                    album: "Fallback Album",
                    albumId: "sp-fallback-album",
                }),
            ],
            {
                id: "playlist-preview-normalized",
                name: "Preview Normalized",
                description: null,
                owner: "owner-1",
                imageUrl: null,
                trackCount: 2,
            },
            "Spotify"
        );

        expect(preview.albumsToDownload).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    albumName: "Direct Album (Super Deluxe Edition)",
                    albumMbid: "rg-direct",
                }),
                expect.objectContaining({
                    albumName: "Fallback Recovered Album",
                    albumMbid: "rg-fallback",
                }),
            ])
        );
        expect(musicBrainzService.searchRecording).toHaveBeenCalledWith(
            "Fallback Song",
            "Fallback Artist"
        );
    });

    it("wraps root and nested client functions while preserving non-function proxy values", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { __spotifyImportTestables } = require("../spotifyImport");
        const rootMethod = jest.fn(async (value: string) => `root:${value}`);
        const nestedMethod = jest.fn(async (value: string) => `nested:${value}`);
        const proxied = __spotifyImportTestables.createPrismaRetryProxy(
            {
                ping: rootMethod,
                track: {
                    findMany: nestedMethod,
                    modelName: "Track",
                },
                version: "1.0.0",
            } as any,
            "proxyTest"
        );

        await expect(proxied.ping("ok")).resolves.toBe("root:ok");
        await expect(proxied.track.findMany("query")).resolves.toBe(
            "nested:query"
        );
        expect(proxied.version).toBe("1.0.0");
        expect(proxied.track.modelName).toBe("Track");
    });

    it("ignores selected download albums and keeps startImport resolution-only", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const buildPlaylistSpy = jest
            .spyOn(spotifyImportService as any, "buildPlaylist")
            .mockResolvedValue(undefined);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { createPlaylistLogger } = require("../../utils/playlistLogger");

        const preview = {
            playlist: {
                id: "sp-acquire-default-error",
                name: "Acquire Default Error",
                description: null,
                owner: "owner-1",
                imageUrl: null,
                trackCount: 1,
            },
            matchedTracks: [],
            albumsToDownload: [
                {
                    artistName: "Missing Source Artist",
                    artistMbid: "artist-missing-source",
                    albumName: "Missing Source Album",
                    albumMbid: "rg-missing-source",
                    spotifyAlbumId: "sp-album-missing-source",
                    tracksNeeded: [
                        {
                            spotifyTrackId: "sp-track-missing-source",
                            title: "Missing Source Song",
                            artist: "Missing Source Artist",
                        },
                    ],
                },
            ],
            summary: {
                total: 1,
                inLibrary: 0,
                downloadable: 1,
                notFound: 0,
            },
        };

        await spotifyImportService.startImport(
            "u1",
            "sp-acquire-default-error",
            "Acquire Default Error",
            ["rg-missing-source"],
            preview as any
        );
        await new Promise((resolve) => setImmediate(resolve));

        const createdLogger = (createPlaylistLogger as jest.Mock).mock.results[0]
            .value;
        expect(buildPlaylistSpy).toHaveBeenCalledTimes(1);
        expect(createdLogger.info).toHaveBeenCalledWith(
            expect.stringContaining("ignored in resolution-only mode")
        );
        expect(createdLogger.logAlbumFailed).not.toHaveBeenCalled();
    });

    it("retries prisma operation when retryable string errors occur and reconnect fails once", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.spotifyImportJob.findMany as jest.Mock)
            .mockRejectedValueOnce("Connection reset by peer")
            .mockResolvedValueOnce([]);
        (prisma.$connect as jest.Mock).mockRejectedValueOnce(
            new Error("connect failed")
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.getUserJobs("u-prisma-retry-connect-fail")
        ).resolves.toEqual([]);
        expect(prisma.spotifyImportJob.findMany).toHaveBeenCalledTimes(2);
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
    });

    it("retries redis operations when retryable redis errors are thrown as strings", async () => {
        const { redisClient, redisRecoveryClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockRejectedValueOnce(
            "Connection is closed"
        );
        (redisRecoveryClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify({
                id: "job-redis-string-retry",
                userId: "u1",
                spotifyPlaylistId: "sp-redis-string-retry",
                playlistName: "Redis String Retry",
                status: "pending",
                progress: 0,
                albumsTotal: 1,
                albumsCompleted: 0,
                tracksMatched: 0,
                tracksTotal: 1,
                tracksDownloadable: 1,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-15T00:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-01-15T00:01:00.000Z").toISOString(),
                pendingTracks: [],
            })
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.getJob("job-redis-string-retry")
        ).resolves.toEqual(
            expect.objectContaining({
                id: "job-redis-string-retry",
            })
        );

        expect(redisClient.duplicate).toHaveBeenCalledTimes(1);
        expect(redisRecoveryClient.connect).toHaveBeenCalledTimes(1);
    });

    it("defaults pendingTracks to empty arrays when DB records contain null", async () => {
        const { prisma, redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(null);
        (prisma.spotifyImportJob.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "job-null-pending",
            userId: "u1",
            spotifyPlaylistId: "sp-null-pending",
            playlistName: "Null Pending",
            status: "pending",
            progress: 1,
            albumsTotal: 1,
            albumsCompleted: 0,
            tracksMatched: 0,
            tracksTotal: 1,
            tracksDownloadable: 1,
            createdPlaylistId: null,
            error: null,
            createdAt: new Date("2026-01-15T00:00:00.000Z"),
            updatedAt: new Date("2026-01-15T00:01:00.000Z"),
            pendingTracks: null,
        });
        (prisma.spotifyImportJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "job-null-pending-many",
                userId: "u1",
                spotifyPlaylistId: "sp-null-pending-many",
                playlistName: "Null Pending Many",
                status: "pending",
                progress: 5,
                albumsTotal: 1,
                albumsCompleted: 0,
                tracksMatched: 0,
                tracksTotal: 2,
                tracksDownloadable: 2,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-15T01:00:00.000Z"),
                updatedAt: new Date("2026-01-15T01:01:00.000Z"),
                pendingTracks: null,
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const job = await spotifyImportService.getJob("job-null-pending");
        const jobs = await spotifyImportService.getUserJobs("u1");

        expect(job?.pendingTracks).toEqual([]);
        expect(jobs[0]?.pendingTracks).toEqual([]);
    });

    it("maps Deezer preview defaults for missing optional track and playlist fields", async () => {
        setupSpotifyImportMocks();
        const deezerPlaylist = {
            id: "dz-defaults",
            title: "Deezer Defaults",
            description: null,
            creator: "",
            imageUrl: "https://img.example/default-cover.jpg",
            trackCount: 0,
            tracks: [
                {
                    deezerId: "d-default-1",
                    title: "Default Song",
                    artist: "Default Artist",
                    album: "",
                    albumId: "",
                    durationMs: 100000,
                    trackNumber: 0,
                    previewUrl: null,
                    coverUrl: null,
                },
                {
                    deezerId: "d-default-2",
                    title: "Default Song 2",
                    artist: "Default Artist 2",
                    album: "Known Album",
                    albumId: "known-album",
                    durationMs: 110000,
                    trackNumber: 0,
                    previewUrl: null,
                    coverUrl: null,
                },
            ],
        };

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const delegate = jest
            .spyOn(spotifyImportService as any, "buildPreviewFromTracklist")
            .mockResolvedValue({
                playlist: {
                    id: "dz-defaults",
                    name: "Deezer Defaults",
                    description: null,
                    owner: "Deezer",
                    imageUrl: "https://img.example/default-cover.jpg",
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

        await spotifyImportService.generatePreviewFromDeezer(deezerPlaylist as any);

        expect(delegate).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({
                    spotifyId: "d-default-1",
                    artistId: "",
                    album: "Unknown Album",
                    trackNumber: 1,
                    coverUrl: "https://img.example/default-cover.jpg",
                }),
                expect.objectContaining({
                    spotifyId: "d-default-2",
                    artistId: "",
                    trackNumber: 2,
                }),
            ]),
            expect.objectContaining({
                owner: "Deezer",
                imageUrl: "https://img.example/default-cover.jpg",
                trackCount: 2,
            }),
            "Deezer"
        );
    });

    it("handles unknown-album processImport failures when track acquisition does not meet success threshold", async () => {
        const { acquisitionService } = setupSpotifyImportMocks();
        (acquisitionService.acquireTracks as jest.Mock).mockResolvedValueOnce([
            { success: false },
            { success: false },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const completionSpy = jest
            .spyOn(spotifyImportService, "checkImportCompletion")
            .mockResolvedValue(undefined);

        const job = {
            id: "job-unknown-all-fail",
            userId: "u1",
            spotifyPlaylistId: "sp-unknown-all-fail",
            playlistName: "Unknown All Fail",
            status: "pending",
            progress: 0,
            albumsTotal: 1,
            albumsCompleted: 0,
            tracksMatched: 0,
            tracksTotal: 2,
            tracksDownloadable: 2,
            createdPlaylistId: null,
            error: null,
            createdAt: new Date("2026-01-16T00:00:00.000Z"),
            updatedAt: new Date("2026-01-16T00:00:00.000Z"),
            pendingTracks: [],
        };
        const preview = {
            playlist: {
                id: "sp-unknown-all-fail",
                name: "Unknown All Fail",
                description: null,
                owner: "owner-1",
                imageUrl: null,
                trackCount: 2,
            },
            matchedTracks: [],
            albumsToDownload: [
                {
                    spotifyAlbumId: "sp-unknown-alb",
                    albumName: "Unknown Album",
                    artistName: "Artist Unknown",
                    artistMbid: null,
                    albumMbid: null,
                    coverUrl: null,
                    trackCount: 2,
                    tracksNeeded: [
                        makeSpotifyTrack({
                            spotifyId: "sp-unknown-a",
                            artist: "Artist Unknown",
                            title: "Unknown Song A",
                            album: "Unknown Album",
                        }),
                        makeSpotifyTrack({
                            spotifyId: "sp-unknown-b",
                            artist: "Artist Unknown",
                            title: "Unknown Song B",
                            album: "Unknown Album",
                        }),
                    ],
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
                ["sp-unknown-alb"],
                preview
            )
        ).resolves.toBeUndefined();
        expect(completionSpy).toHaveBeenCalledWith("job-unknown-all-fail");
    });

    it("skips unmatched album identifiers and does not wait when post-check job is no longer downloading", async () => {
        const { redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify({
                id: "job-no-wait-after-check",
                userId: "u1",
                spotifyPlaylistId: "sp-no-wait-after-check",
                playlistName: "No Wait After Check",
                status: "scanning",
                progress: 75,
                albumsTotal: 1,
                albumsCompleted: 1,
                tracksMatched: 0,
                tracksTotal: 1,
                tracksDownloadable: 1,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-16T01:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-01-16T01:01:00.000Z").toISOString(),
                pendingTracks: [],
            })
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const completionSpy = jest
            .spyOn(spotifyImportService, "checkImportCompletion")
            .mockResolvedValue(undefined);

        const job = {
            id: "job-no-wait-after-check",
            userId: "u1",
            spotifyPlaylistId: "sp-no-wait-after-check",
            playlistName: "No Wait After Check",
            status: "pending",
            progress: 0,
            albumsTotal: 1,
            albumsCompleted: 0,
            tracksMatched: 0,
            tracksTotal: 1,
            tracksDownloadable: 1,
            createdPlaylistId: null,
            error: null,
            createdAt: new Date("2026-01-16T01:00:00.000Z"),
            updatedAt: new Date("2026-01-16T01:00:00.000Z"),
            pendingTracks: [],
        };

        await expect(
            (spotifyImportService as any).processImport(
                job,
                ["sp-missing-album-id"],
                {
                    playlist: {
                        id: "sp-no-wait-after-check",
                        name: "No Wait After Check",
                        description: null,
                        owner: "owner-1",
                        imageUrl: null,
                        trackCount: 1,
                    },
                    matchedTracks: [],
                    albumsToDownload: [],
                    summary: {
                        total: 1,
                        inLibrary: 0,
                        downloadable: 1,
                        notFound: 0,
                    },
                }
            )
        ).resolves.toBeUndefined();

        expect(completionSpy).toHaveBeenCalledWith("job-no-wait-after-check");
    });

    it("uses unknown scan id fallback when scan queue returns no id", async () => {
        const { prisma, redisClient, scanQueue } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify({
                id: "job-scan-id-fallback",
                userId: "u1",
                spotifyPlaylistId: "sp-scan-id-fallback",
                playlistName: "Scan ID Fallback",
                status: "downloading",
                progress: 60,
                albumsTotal: 1,
                albumsCompleted: 1,
                tracksMatched: 0,
                tracksTotal: 2,
                tracksDownloadable: 2,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-16T02:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-01-16T02:01:00.000Z").toISOString(),
                pendingTracks: [],
            })
        );
        (prisma.downloadJob.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "dj-complete-1",
                status: "completed",
                createdAt: new Date(Date.now() - 60_000),
            },
        ]);
        (scanQueue.add as jest.Mock).mockResolvedValueOnce({});
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { createPlaylistLogger } = require("../../utils/playlistLogger");

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await spotifyImportService.checkImportCompletion("job-scan-id-fallback");

        expect(scanQueue.add).toHaveBeenCalledTimes(1);
        expect(prisma.spotifyImportJob.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-scan-id-fallback" },
                update: expect.objectContaining({
                    status: "scanning",
                }),
            })
        );
    });

    it("reconcile strategy 4 scores multiple title-only candidates and keeps unmatched tracks pending", async () => {
        const { prisma, notificationService } = setupSpotifyImportMocks();
        (prisma.playlistPendingTrack.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "pending-s4-unmatched",
                playlistId: "playlist-s4",
                spotifyArtist: "Very Different Artist",
                spotifyTitle: "Exact Song Name",
                spotifyAlbum: "Unknown Album",
                sort: 0,
                playlist: {
                    id: "playlist-s4",
                    name: "S4 Unmatched",
                    userId: "u1",
                },
            },
        ]);
        (prisma.playlistItem.aggregate as jest.Mock).mockResolvedValueOnce({
            _max: { sort: 5 },
        });
        (prisma.playlistItem.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query: any) => {
            if (query?.select?.title && query?.take === 5) return [];
            if (query?.where?.title?.contains && query?.take === 10) return [];
            if (query?.where?.title?.contains && query?.take === 20) return [];
            if (query?.where?.title?.equals && query?.take === 10) {
                return [
                    {
                        id: "candidate-artist-a",
                        title: "Exact Song Name",
                        album: { artist: { name: "AAA Artist" } },
                    },
                    {
                        id: "candidate-artist-b",
                        title: "Exact Song Name",
                        album: { artist: { name: "BBB Artist" } },
                    },
                ];
            }
            return [];
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await spotifyImportService.reconcilePendingTracks();

        expect(result).toEqual({ playlistsUpdated: 0, tracksAdded: 0 });
        expect(prisma.playlistItem.create).not.toHaveBeenCalled();
        expect(prisma.playlistPendingTrack.deleteMany).not.toHaveBeenCalled();
        expect(notificationService.create).not.toHaveBeenCalled();
    });

    it("reconcile strategy 4 accepts single candidate but skips adding duplicates already in playlist", async () => {
        const { prisma, notificationService } = setupSpotifyImportMocks();
        (prisma.playlistPendingTrack.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "pending-s4-duplicate",
                playlistId: "playlist-s4-dup",
                spotifyArtist: "Different Artist",
                spotifyTitle: "Single Candidate Song",
                spotifyAlbum: "Unknown Album",
                sort: 0,
                playlist: {
                    id: "playlist-s4-dup",
                    name: "S4 Duplicate",
                    userId: "u1",
                },
            },
        ]);
        (prisma.playlistItem.aggregate as jest.Mock).mockResolvedValueOnce({
            _max: { sort: 0 },
        });
        (prisma.playlistItem.findMany as jest.Mock).mockResolvedValueOnce([
            { trackId: "existing-dup-track" },
        ]);
        (prisma.track.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query: any) => {
            if (query?.select?.title && query?.take === 5) return [];
            if (query?.where?.title?.contains && query?.take === 10) return [];
            if (query?.where?.title?.contains && query?.take === 20) return [];
            if (query?.where?.title?.equals && query?.take === 10) {
                return [
                    {
                        id: "existing-dup-track",
                        title: "Single Candidate Song",
                        album: { artist: { name: "Only Candidate Artist" } },
                    },
                ];
            }
            return [];
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await spotifyImportService.reconcilePendingTracks();

        expect(result).toEqual({ playlistsUpdated: 0, tracksAdded: 0 });
        expect(prisma.playlistItem.create).not.toHaveBeenCalled();
        expect(prisma.playlistPendingTrack.deleteMany).not.toHaveBeenCalled();
        expect(notificationService.create).not.toHaveBeenCalled();
    });

    it("reconcile strategy 2 can match via title containment and tolerates missing playlist records for notifications", async () => {
        const { prisma, notificationService } = setupSpotifyImportMocks();
        (prisma.playlistPendingTrack.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "pending-containment-match",
                playlistId: "playlist-containment",
                spotifyArtist: "Contain Artist",
                spotifyTitle: "Containment Song Long Mix",
                spotifyAlbum: "Unknown Album",
                sort: 0,
                playlist: {
                    id: "playlist-containment",
                    name: "Containment Playlist",
                    userId: "u1",
                },
            },
        ]);
        (prisma.playlistItem.aggregate as jest.Mock).mockResolvedValueOnce({
            _max: { sort: 2 },
        });
        (prisma.playlistItem.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query: any) => {
            if (query?.select?.title && query?.take === 5) return [];
            if (query?.where?.title?.contains && query?.take === 10) {
                return [
                    {
                        id: "containment-track",
                        title: "Containment Song",
                        album: { artist: { name: "Contain Artist" } },
                    },
                ];
            }
            if (query?.where?.title?.contains && query?.take === 20) return [];
            if (query?.where?.title?.equals && query?.take === 10) return [];
            return [];
        });
        (prisma.playlist.findUnique as jest.Mock).mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await spotifyImportService.reconcilePendingTracks();

        expect(result).toEqual({ playlistsUpdated: 1, tracksAdded: 1 });
        expect(prisma.playlistItem.create).toHaveBeenCalledWith({
            data: {
                playlistId: "playlist-containment",
                trackId: "containment-track",
                sort: 3,
            },
        });
        expect(prisma.playlistPendingTrack.deleteMany).toHaveBeenCalledWith({
            where: { id: { in: ["pending-containment-match"] } },
        });
        expect(notificationService.create).not.toHaveBeenCalled();
    });

    it("buildPlaylist falls through pre-matched IDs that no longer exist and preserves unmatched short-title tracks", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValueOnce(null);
        (prisma.track.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query: any) => {
            if (query?.where?.album?.artist?.normalizedName?.contains && query?.take === 50) {
                return [];
            }
            if (query?.where?.title?.contains && query?.take === 20) {
                return [];
            }
            if (query?.where?.title?.contains && query?.take === 50 && query?.include?.album) {
                return [];
            }
            return [];
        });
        (prisma.playlist.create as jest.Mock).mockResolvedValueOnce({
            id: "playlist-short-unmatched",
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            (spotifyImportService as any).buildPlaylist({
                id: "job-short-unmatched",
                userId: "u1",
                spotifyPlaylistId: "sp-short-unmatched",
                playlistName: "Short Unmatched",
                status: "scanning",
                progress: 75,
                albumsTotal: 1,
                albumsCompleted: 1,
                tracksMatched: 0,
                tracksTotal: 1,
                tracksDownloadable: 1,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-16T03:00:00.000Z"),
                updatedAt: new Date("2026-01-16T03:00:00.000Z"),
                pendingTracks: [
                    {
                        artist: "No Match Artist",
                        title: "Hey",
                        album: "Unknown Album",
                        albumMbid: null,
                        artistMbid: null,
                        preMatchedTrackId: "missing-track-id",
                    },
                ],
            })
        ).resolves.toBeUndefined();

        expect(prisma.playlist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    spotifyPlaylistId: "sp-short-unmatched",
                    items: undefined,
                }),
            })
        );
        expect(prisma.playlistPendingTrack.createMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.arrayContaining([
                    expect.objectContaining({
                        spotifyTitle: "Hey",
                        spotifyArtist: "No Match Artist",
                    }),
                ]),
            })
        );
    });

    it("exercises retryability helpers for empty Prisma unknown messages and non-Error redis/prisma payloads", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { __spotifyImportTestables } = require("../spotifyImport");

        expect(
            __spotifyImportTestables.isRetryableSpotifyImportPrismaError(
                new Prisma.PrismaClientUnknownRequestError("")
            )
        ).toBe(false);
        expect(
            __spotifyImportTestables.isRetryableSpotifyImportPrismaError(
                "Connection reset by peer"
            )
        ).toBe(true);
        expect(
            __spotifyImportTestables.isRetryableSpotifyImportPrismaError(undefined)
        ).toBe(false);
        expect(
            __spotifyImportTestables.isRetryableSpotifyImportRedisError(
                "Connection is closed"
            )
        ).toBe(true);
        expect(
            __spotifyImportTestables.isRetryableSpotifyImportRedisError(undefined)
        ).toBe(false);
    });

    it("matchTrack strategy 2 can match by normalized title when artist album starts with cleaned album", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findFirst as jest.Mock)
            .mockResolvedValueOnce(null) // strategy 1
            .mockResolvedValueOnce(null); // normalizedAlbumMatch
        (prisma.album.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "album-normalized-startswith",
                title: "Album Core Deluxe",
                artist: { name: "Artist A" },
                tracks: [
                    {
                        id: "track-normalized-title",
                        title: "Song A - 2011 Remaster",
                    },
                ],
            },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await (spotifyImportService as any).matchTrack(
            makeSpotifyTrack({
                artist: "Artist A",
                title: "Song A",
                album: "Album Core (Super Deluxe Edition)",
            })
        );

        expect(result.matchType).toBe("exact");
        expect(result.matchConfidence).toBe(95);
        expect(result.localTrack?.id).toBe("track-normalized-title");
    });

    it("matchTrack strategy 2 falls through when normalized album relationships exist but track titles do not match", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findFirst as jest.Mock)
            .mockResolvedValueOnce(null) // strategy 1
            .mockResolvedValueOnce(null); // normalizedAlbumMatch
        (prisma.album.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "album-no-normalized-relation",
                title: "Completely Unrelated Collection",
                artist: { name: "Artist A" },
                tracks: [{ id: "track-unrelated", title: "Different Song 1" }],
            },
            {
                id: "album-fallthrough",
                title: "Album",
                artist: { name: "Artist A" },
                tracks: [{ id: "track-other", title: "Completely Different Song" }],
            },
        ]);
        (prisma.track.findMany as jest.Mock).mockResolvedValue([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await (spotifyImportService as any).matchTrack(
            makeSpotifyTrack({
                artist: "Artist A",
                title: "Song A",
                album: "Album Core (Deluxe Edition)",
            })
        );

        expect(result).toEqual(
            expect.objectContaining({
                matchType: "none",
                matchConfidence: 0,
                localTrack: null,
            })
        );
    });

    it("matchTrack strategy 3 can accept album containment in either direction and fall back to first artist-title match", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([
                {
                    id: "track-album-containment",
                    title: "Song A",
                    albumId: "album-containment",
                    album: {
                        title: "Album",
                        artist: { name: "Artist A" },
                    },
                },
            ]) // case where spotify album contains DB album (3rd OR branch)
            .mockResolvedValueOnce([
                {
                    id: "track-artist-title-fallback",
                    title: "Song A",
                    albumId: "album-fallback",
                    album: {
                        title: "Different Release",
                        artist: { name: "Artist A" },
                    },
                },
            ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const containmentResult = await (spotifyImportService as any).matchTrack(
            makeSpotifyTrack({
                artist: "Artist A",
                title: "Song A",
                album: "Album Deluxe",
            })
        );
        const fallbackResult = await (spotifyImportService as any).matchTrack(
            makeSpotifyTrack({
                artist: "Artist A",
                title: "Song A",
                album: "Unrelated Album",
            })
        );

        expect(containmentResult.localTrack?.id).toBe("track-album-containment");
        expect(containmentResult.matchType).toBe("exact");
        expect(fallbackResult.localTrack?.id).toBe("track-artist-title-fallback");
        expect(fallbackResult.matchType).toBe("exact");
        expect(fallbackResult.matchConfidence).toBe(90);
    });

    it("matchTrack fuzzy path can skip 4b and reject low-score 4a candidates", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([]) // strategy 3
            .mockResolvedValueOnce([
                {
                    id: "fuzzy-low-score",
                    title: "Completely Different Song",
                    albumId: "album-low",
                    album: {
                        title: "Album Low",
                        artist: { name: "Completely Different Artist" },
                    },
                },
            ]); // 4a non-empty (line 789 false), low score (line 855 false)

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await (spotifyImportService as any).matchTrack(
            makeSpotifyTrack({
                artist: "Artist A",
                title: "Song A",
                album: "Unknown Album",
            })
        );

        expect(result.matchType).toBe("none");
        expect(result.localTrack).toBeNull();
    });

    it("matchTrack fuzzy full-artist fallback can short-circuit when full-artist first token is too short", async () => {
        const { prisma } = setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { extractPrimaryArtist } = require("../../utils/artistNormalization");
        (extractPrimaryArtist as jest.Mock).mockReturnValueOnce("Primary");
        (prisma.track.findFirst as jest.Mock).mockResolvedValueOnce(null);
        (prisma.track.findMany as jest.Mock)
            .mockResolvedValueOnce([]) // strategy 3
            .mockResolvedValueOnce([]) // strategy 4a
            .mockResolvedValueOnce([]); // strategy 4b

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const result = await (spotifyImportService as any).matchTrack(
            makeSpotifyTrack({
                artist: "ab feat guest",
                title: "Short Token Song",
                album: "Unknown Album",
            })
        );

        expect(result.matchType).toBe("none");
    });

    it("findAlbumMbid can keep first artist when none exactly match and handle undefined release groups", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchArtist as jest.Mock).mockResolvedValueOnce([
            { id: "artist-keep-first", name: "Artist Alias" },
            { id: "artist-second", name: "Other Alias" },
        ]);
        (musicBrainzService.getReleaseGroups as jest.Mock).mockResolvedValueOnce(
            undefined
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            (spotifyImportService as any).findAlbumMbid(
                "Different Artist Name",
                "Album Target"
            )
        ).resolves.toEqual({
            artistMbid: "artist-keep-first",
            albumMbid: null,
        });
    });

    it("buildPreviewFromTracklist handles string-error unknown-album enrichment failures for Deezer source and tracks already in library", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        jest
            .spyOn(spotifyImportService as any, "enrichUnknownAlbumsViaMusicBrainz")
            .mockRejectedValueOnce("mb enrichment string failure");
        jest
            .spyOn(spotifyImportService as any, "matchTrack")
            .mockResolvedValue({
                spotifyTrack: makeSpotifyTrack({
                    spotifyId: "sp-in-library",
                    artist: "Artist In Library",
                    title: "Song In Library",
                    album: "Unknown Album",
                }),
                localTrack: {
                    id: "local-in-library",
                    title: "Song In Library",
                    albumId: "alb-in-library",
                    albumTitle: "Known Album",
                    artistName: "Artist In Library",
                },
                matchType: "exact",
                matchConfidence: 100,
            });

        const preview = await (spotifyImportService as any).buildPreviewFromTracklist(
            [
                makeSpotifyTrack({
                    spotifyId: "sp-in-library",
                    artist: "Artist In Library",
                    title: "Song In Library",
                    album: "Unknown Album",
                }),
            ],
            {
                id: "playlist-deezer-source-branch",
                name: "Deezer Source Branch",
                description: null,
                owner: "owner-1",
                imageUrl: null,
                trackCount: 1,
            },
            "Deezer"
        );

        expect(preview.summary.inLibrary).toBe(1);
        expect(preview.albumsToDownload).toHaveLength(0);
    });

    it("buildPreviewFromTracklist covers pre-resolved and unresolved album metadata fallbacks", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchArtist as jest.Mock).mockResolvedValueOnce([]);
        (musicBrainzService.searchRecording as jest.Mock).mockResolvedValue(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        jest
            .spyOn(spotifyImportService as any, "matchTrack")
            .mockResolvedValue({
                spotifyTrack: makeSpotifyTrack(),
                localTrack: null,
                matchType: "none",
                matchConfidence: 0,
            });
        jest
            .spyOn(spotifyImportService as any, "findAlbumMbid")
            .mockResolvedValueOnce({
                artistMbid: null,
                albumMbid: "rg-known-without-artist",
            })
            .mockResolvedValueOnce({
                artistMbid: null,
                albumMbid: null,
            });

        const preview = await (spotifyImportService as any).buildPreviewFromTracklist(
            [
                makeSpotifyTrack({
                    spotifyId: "sp-pre-resolved",
                    artist: "Artist Pre",
                    title: "Song Pre",
                    album: "Recovered Album",
                    albumId: "mbid:rg-pre-resolved",
                }),
                makeSpotifyTrack({
                    spotifyId: "sp-no-album-id",
                    artist: "Artist Fallback",
                    title: "Song Fallback",
                    album: "Album Without MBID",
                    albumId: "",
                }),
            ],
            {
                id: "playlist-preview-fallbacks",
                name: "Preview Fallbacks",
                description: null,
                owner: "owner-1",
                imageUrl: null,
                trackCount: 2,
            },
            "Spotify"
        );

        expect(preview.albumsToDownload).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    albumName: "Recovered Album",
                    albumMbid: "rg-pre-resolved",
                }),
                expect.objectContaining({
                    albumName: "Album Without MBID",
                    albumMbid: "rg-known-without-artist",
                    artistMbid: null,
                    spotifyAlbumId: "",
                }),
            ])
        );
    });

    it("startImport maps pending tracks via tracksNeeded title+artist fallback when spotify ids differ", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        jest.spyOn(spotifyImportService as any, "processImport").mockResolvedValue(
            undefined
        );

        const pendingSourceTrack = makeSpotifyTrack({
            spotifyId: "sp-original-id",
            artist: "Mapped Artist",
            title: "Mapped Song",
            album: "Unknown Album",
            albumId: "",
        });

        const job = await spotifyImportService.startImport(
            "u-pending-map",
            "sp-pending-map",
            "Pending Mapping",
            ["sp-album-map"],
            {
                playlist: {
                    id: "sp-pending-map",
                    name: "Pending Mapping",
                    description: null,
                    owner: "owner-1",
                    imageUrl: null,
                    trackCount: 1,
                },
                matchedTracks: [
                    {
                        spotifyTrack: pendingSourceTrack,
                        localTrack: null,
                        matchType: "none",
                        matchConfidence: 0,
                    },
                ],
                albumsToDownload: [
                    {
                        spotifyAlbumId: "sp-album-map",
                        albumName: "Resolved Album Name",
                        artistName: "Mapped Artist",
                        artistMbid: null,
                        albumMbid: null,
                        coverUrl: null,
                        trackCount: 1,
                        tracksNeeded: [
                            makeSpotifyTrack({
                                spotifyId: "different-track-id",
                                artist: "Mapped Artist",
                                title: "Mapped Song",
                                album: "Unknown Album",
                            }),
                        ],
                    },
                ],
                summary: {
                    total: 1,
                    inLibrary: 0,
                    downloadable: 1,
                    notFound: 0,
                },
            } as any
        );

        expect(job.pendingTracks).toEqual([
            expect.objectContaining({
                artist: "Mapped Artist",
                title: "Mapped Song",
                album: "Resolved Album Name",
                albumMbid: null,
                artistMbid: null,
            }),
        ]);
    });

    it("cancelJob terminal responses preserve null playlist ids", async () => {
        const { redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(
            JSON.stringify({
                id: "job-terminal-null-playlist",
                userId: "u1",
                spotifyPlaylistId: "sp-terminal-null-playlist",
                playlistName: "Terminal Null Playlist",
                status: "failed",
                progress: 100,
                albumsTotal: 1,
                albumsCompleted: 1,
                tracksMatched: 0,
                tracksTotal: 1,
                tracksDownloadable: 0,
                createdPlaylistId: null,
                error: "failed",
                createdAt: new Date("2026-01-16T04:00:00.000Z").toISOString(),
                updatedAt: new Date("2026-01-16T04:01:00.000Z").toISOString(),
                pendingTracks: [],
            })
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.cancelJob("job-terminal-null-playlist")
        ).resolves.toEqual({
            playlistCreated: false,
            playlistId: null,
            tracksMatched: 0,
        });
    });

    it("checkImportCompletion supports zero-download jobs and pending status rows without oldest pending timestamps", async () => {
        const { prisma, redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock)
            .mockResolvedValueOnce(
                JSON.stringify({
                    id: "job-zero-downloads",
                    userId: "u1",
                    spotifyPlaylistId: "sp-zero-downloads",
                    playlistName: "Zero Downloads",
                    status: "downloading",
                    progress: 35,
                    albumsTotal: 0,
                    albumsCompleted: 0,
                    tracksMatched: 0,
                    tracksTotal: 0,
                    tracksDownloadable: 0,
                    createdPlaylistId: null,
                    error: null,
                    createdAt: new Date("2026-01-16T05:00:00.000Z").toISOString(),
                    updatedAt: new Date("2026-01-16T05:01:00.000Z").toISOString(),
                    pendingTracks: [],
                })
            )
            .mockResolvedValueOnce(
                JSON.stringify({
                    id: "job-pending-unknown-status",
                    userId: "u1",
                    spotifyPlaylistId: "sp-pending-unknown-status",
                    playlistName: "Pending Unknown Status",
                    status: "downloading",
                    progress: 35,
                    albumsTotal: 1,
                    albumsCompleted: 0,
                    tracksMatched: 0,
                    tracksTotal: 1,
                    tracksDownloadable: 1,
                    createdPlaylistId: null,
                    error: null,
                    createdAt: new Date("2026-01-16T05:00:00.000Z").toISOString(),
                    updatedAt: new Date("2026-01-16T05:01:00.000Z").toISOString(),
                    pendingTracks: [],
                })
            );
        (prisma.downloadJob.findMany as jest.Mock)
            .mockResolvedValueOnce([]) // total=0, albumsTotal=0 -> progress ternary false branch
            .mockResolvedValueOnce([
                {
                    id: "dj-queued-only",
                    status: "queued",
                    createdAt: new Date(Date.now() - 60_000),
                },
            ]); // pending>0 but no pending/processing row => oldestPending undefined

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.checkImportCompletion("job-zero-downloads")
        ).resolves.toBeUndefined();
        await expect(
            spotifyImportService.checkImportCompletion(
                "job-pending-unknown-status"
            )
        ).resolves.toBeUndefined();
    });

    it("reconcile can leave strategy-2/strategy-4 candidates unmatched when containment and title-only candidate checks fail", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.playlistPendingTrack.findMany as jest.Mock).mockResolvedValueOnce([
            {
                id: "pending-unmatched-containment-false",
                playlistId: "playlist-containment-false",
                spotifyArtist: "Artist X",
                spotifyTitle: "Containment Target Song",
                spotifyAlbum: "Unknown Album",
                sort: 0,
                playlist: {
                    id: "playlist-containment-false",
                    name: "Containment False",
                    userId: "u1",
                },
            },
        ]);
        (prisma.playlistItem.aggregate as jest.Mock).mockResolvedValueOnce({
            _max: { sort: null },
        });
        (prisma.playlistItem.findMany as jest.Mock).mockResolvedValueOnce([]);
        (prisma.track.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query: any) => {
            if (query?.select?.title && query?.take === 5) return [];
            if (query?.where?.title?.contains && query?.take === 10) {
                return [
                    {
                        id: "candidate-no-containment",
                        title: "Different Phrase",
                        album: { artist: { name: "Artist Y" } },
                    },
                ];
            }
            if (query?.where?.title?.contains && query?.take === 20) return [];
            if (query?.where?.title?.equals && query?.take === 10) return [];
            return [];
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(spotifyImportService.reconcilePendingTracks()).resolves.toEqual(
            { playlistsUpdated: 0, tracksAdded: 0 }
        );
        expect(prisma.playlistItem.create).not.toHaveBeenCalled();
        expect(prisma.playlistPendingTrack.deleteMany).not.toHaveBeenCalled();
    });

    it("enrichUnknownAlbumsViaMusicBrainz logs non-Error string failures from recording lookups", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchRecording as jest.Mock).mockRejectedValueOnce(
            "recording string failure"
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const stats = await (spotifyImportService as any).enrichUnknownAlbumsViaMusicBrainz(
            [
                makeSpotifyTrack({
                    spotifyId: "sp-recording-string-fail",
                    artist: "Artist Fail",
                    title: "Song Fail",
                    album: "Unknown Album",
                }),
            ],
            "[UnknownAlbumStringError]"
        );

        expect(stats).toEqual(
            expect.objectContaining({
                resolved: 0,
                failed: 1,
            })
        );
    });

    it("buildPreviewFromTracklist keeps non-unknown albums downloadable when MBIDs cannot be resolved", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchRecording as jest.Mock).mockResolvedValue(null);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        jest
            .spyOn(spotifyImportService as any, "matchTrack")
            .mockResolvedValue({
                spotifyTrack: makeSpotifyTrack(),
                localTrack: null,
                matchType: "none",
                matchConfidence: 0,
            });
        jest
            .spyOn(spotifyImportService as any, "findAlbumMbid")
            .mockResolvedValue({
                artistMbid: null,
                albumMbid: null,
            });

        const preview = await (spotifyImportService as any).buildPreviewFromTracklist(
            [
                makeSpotifyTrack({
                    spotifyId: "sp-non-unknown-no-mbid",
                    artist: "Artist Missing MBID",
                    title: "Song Missing MBID",
                    album: "Known But Unresolved Album",
                    albumId: "",
                }),
            ],
            {
                id: "playlist-non-unknown-no-mbid",
                name: "Known But Unresolved Album",
                description: null,
                owner: "owner-1",
                imageUrl: null,
                trackCount: 1,
            },
            "Spotify"
        );

        expect(preview.albumsToDownload).toEqual([
            expect.objectContaining({
                albumName: "Known But Unresolved Album",
                albumMbid: null,
            }),
        ]);
    });

    it("maps Deezer cover and playlist image fallbacks to null when no image values are present", async () => {
        setupSpotifyImportMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const delegate = jest
            .spyOn(spotifyImportService as any, "buildPreviewFromTracklist")
            .mockResolvedValue({
                playlist: {
                    id: "dz-null-images",
                    name: "Deezer Null Images",
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
            });

        await spotifyImportService.generatePreviewFromDeezer({
            id: "dz-null-images",
            title: "Deezer Null Images",
            creator: "owner",
            description: null,
            imageUrl: null,
            trackCount: 1,
            tracks: [
                {
                    deezerId: "d-null-cover",
                    title: "Null Cover Song",
                    artist: "Null Cover Artist",
                    album: "",
                    albumId: "",
                    durationMs: 100000,
                    trackNumber: 1,
                    previewUrl: null,
                    coverUrl: null,
                },
            ],
        });

        expect(delegate).toHaveBeenCalledWith(
            [
                expect.objectContaining({
                    coverUrl: null,
                }),
            ],
            expect.objectContaining({
                imageUrl: null,
            }),
            "Deezer"
        );
    });

    it("startImport can keep unknown-album display names when no album metadata fallback is available", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        jest.spyOn(spotifyImportService as any, "processImport").mockResolvedValue(
            undefined
        );

        const job = await spotifyImportService.startImport(
            "u-unknown-display-fallback",
            "sp-unknown-display-fallback",
            "Unknown Display Fallback",
            ["sp-no-fallback-album"],
            {
                playlist: {
                    id: "sp-unknown-display-fallback",
                    name: "Unknown Display Fallback",
                    description: null,
                    owner: "owner-1",
                    imageUrl: null,
                    trackCount: 1,
                },
                matchedTracks: [
                    {
                        spotifyTrack: makeSpotifyTrack({
                            spotifyId: "sp-no-fallback-track",
                            artist: "No Fallback Artist",
                            title: "No Fallback Song",
                            album: "Unknown Album",
                            albumId: "",
                        }),
                        localTrack: null,
                        matchType: "none",
                        matchConfidence: 0,
                    },
                ],
                albumsToDownload: [],
                summary: {
                    total: 1,
                    inLibrary: 0,
                    downloadable: 1,
                    notFound: 0,
                },
            } as any
        );

        expect(job.pendingTracks).toEqual([
            expect.objectContaining({
                album: "Unknown Album",
            }),
        ]);
    });

    it("startImport unknown-album path skips acquisition and completion-check phases", async () => {
        const { acquisitionService } = setupSpotifyImportMocks();

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const completionSpy = jest
            .spyOn(spotifyImportService, "checkImportCompletion")
            .mockResolvedValue(undefined);
        const buildPlaylistSpy = jest
            .spyOn(spotifyImportService as any, "buildPlaylist")
            .mockResolvedValue(undefined);

        await spotifyImportService.startImport(
            "u1",
            "sp-unknown-success",
            "Unknown Success",
            ["sp-unknown-success-album"],
            {
                playlist: {
                    id: "sp-unknown-success",
                    name: "Unknown Success",
                    description: null,
                    owner: "owner-1",
                    imageUrl: null,
                    trackCount: 2,
                },
                matchedTracks: [],
                albumsToDownload: [
                    {
                        spotifyAlbumId: "sp-unknown-success-album",
                        albumName: "Unknown Album",
                        artistName: "Artist Success",
                        artistMbid: null,
                        albumMbid: null,
                        coverUrl: null,
                        trackCount: 2,
                        tracksNeeded: [
                            makeSpotifyTrack({
                                spotifyId: "sp-success-a",
                                artist: "Artist Success",
                                title: "Success A",
                                album: "Unknown Album",
                            }),
                            makeSpotifyTrack({
                                spotifyId: "sp-success-b",
                                artist: "Artist Success",
                                title: "Success B",
                                album: "Unknown Album",
                            }),
                        ],
                    },
                ],
                summary: {
                    total: 2,
                    inLibrary: 0,
                    downloadable: 2,
                    notFound: 0,
                },
            } as any
        );
        await new Promise((resolve) => setImmediate(resolve));

        expect(buildPlaylistSpy).toHaveBeenCalledTimes(1);
        expect(completionSpy).not.toHaveBeenCalled();
        expect(acquisitionService.acquireTracks).not.toHaveBeenCalled();
    });

    it("checkImportCompletion evaluates scan logging branches when a job logger exists and scan ids are present/missing", async () => {
        const { prisma, redisClient, scanQueue } = setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const processSpy = jest
            .spyOn(spotifyImportService as any, "processImport")
            .mockResolvedValue(undefined);

        const makePreview = (id: string) =>
            ({
                playlist: {
                    id,
                    name: id,
                    description: null,
                    owner: "owner-1",
                    imageUrl: null,
                    trackCount: 1,
                },
                matchedTracks: [],
                albumsToDownload: [
                    {
                        spotifyAlbumId: `${id}-album`,
                        albumName: "Album",
                        artistName: "Artist",
                        artistMbid: "artist-id",
                        albumMbid: "album-id",
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
            }) as any;

        const jobWithId = await spotifyImportService.startImport(
            "u1",
            "sp-scan-id-present",
            "Scan ID Present",
            ["album-id"],
            makePreview("sp-scan-id-present")
        );
        const jobWithoutId = await spotifyImportService.startImport(
            "u1",
            "sp-scan-id-missing",
            "Scan ID Missing",
            ["album-id"],
            makePreview("sp-scan-id-missing")
        );
        expect(processSpy).toHaveBeenCalledTimes(2);

        (redisClient.get as jest.Mock)
            .mockResolvedValueOnce(
                JSON.stringify({
                    id: jobWithId.id,
                    userId: "u1",
                    spotifyPlaylistId: "sp-scan-id-present",
                    playlistName: "Scan ID Present",
                    status: "downloading",
                    progress: 60,
                    albumsTotal: 1,
                    albumsCompleted: 1,
                    tracksMatched: 0,
                    tracksTotal: 1,
                    tracksDownloadable: 1,
                    createdPlaylistId: null,
                    error: null,
                    createdAt: new Date("2026-01-17T01:00:00.000Z").toISOString(),
                    updatedAt: new Date("2026-01-17T01:01:00.000Z").toISOString(),
                    pendingTracks: [],
                })
            )
            .mockResolvedValueOnce(
                JSON.stringify({
                    id: jobWithoutId.id,
                    userId: "u1",
                    spotifyPlaylistId: "sp-scan-id-missing",
                    playlistName: "Scan ID Missing",
                    status: "downloading",
                    progress: 60,
                    albumsTotal: 1,
                    albumsCompleted: 1,
                    tracksMatched: 0,
                    tracksTotal: 1,
                    tracksDownloadable: 1,
                    createdPlaylistId: null,
                    error: null,
                    createdAt: new Date("2026-01-17T01:00:00.000Z").toISOString(),
                    updatedAt: new Date("2026-01-17T01:01:00.000Z").toISOString(),
                    pendingTracks: [],
                })
            );
        (prisma.downloadJob.findMany as jest.Mock)
            .mockResolvedValueOnce([
                {
                    id: "dj-scan-id-present",
                    status: "completed",
                    createdAt: new Date(Date.now() - 60_000),
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: "dj-scan-id-missing",
                    status: "completed",
                    createdAt: new Date(Date.now() - 60_000),
                },
            ]);
        (scanQueue.add as jest.Mock)
            .mockResolvedValueOnce({ id: "scan-job-id-present" })
            .mockResolvedValueOnce({});

        await spotifyImportService.checkImportCompletion(jobWithId.id);
        await spotifyImportService.checkImportCompletion(jobWithoutId.id);

        expect(scanQueue.add).toHaveBeenCalledTimes(2);
    });

    it("buildPlaylist strategy-3.5 can reject low-score candidates before downstream fallbacks", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(null);
        (prisma.track.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.track.findMany as jest.Mock).mockImplementation(async (query: any) => {
            if (query?.where?.title?.contains && query?.take === 10) {
                return [];
            }
            if (query?.where?.album?.artist?.normalizedName?.contains && query?.take === 50) {
                return [
                    {
                        id: "track-low-score-35",
                        title: "Totally Different Candidate",
                        album: { artist: { name: "Unrelated Artist" } },
                    },
                ];
            }
            if (query?.where?.title?.contains && query?.take === 20) {
                return [];
            }
            return [];
        });
        (prisma.playlist.create as jest.Mock).mockResolvedValueOnce({
            id: "playlist-low-score-35",
        });

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            (spotifyImportService as any).buildPlaylist({
                id: "job-low-score-35",
                userId: "u1",
                spotifyPlaylistId: "sp-low-score-35",
                playlistName: "Low Score 35",
                status: "scanning",
                progress: 75,
                albumsTotal: 1,
                albumsCompleted: 1,
                tracksMatched: 0,
                tracksTotal: 1,
                tracksDownloadable: 1,
                createdPlaylistId: null,
                error: null,
                createdAt: new Date("2026-01-17T02:00:00.000Z"),
                updatedAt: new Date("2026-01-17T02:00:00.000Z"),
                pendingTracks: [
                    {
                        artist: "Candidate Artist",
                        title: "Candidate Song",
                        album: "Unknown Album",
                        albumMbid: null,
                        artistMbid: null,
                        preMatchedTrackId: null,
                    },
                ],
            })
        ).resolves.toBeUndefined();
    });
});
