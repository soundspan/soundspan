import {
    makeSpotifyTrack,
    setupSpotifyImportMocks,
} from "./spotifyImportRuntime.helpers";

describe("spotify import runtime behavior", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
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

        await spotifyImportService.generatePreviewFromDeezer(
            deezerPlaylist as any,
        );

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
            "Deezer",
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
                preview,
            ),
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
            }),
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
                },
            ),
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
            }),
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
        await spotifyImportService.checkImportCompletion(
            "job-scan-id-fallback",
        );

        expect(scanQueue.add).toHaveBeenCalledTimes(1);
        expect(prisma.spotifyImportJob.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "job-scan-id-fallback" },
                update: expect.objectContaining({
                    status: "scanning",
                }),
            }),
        );
    });

    it("reconcile strategy 4 scores multiple title-only candidates and keeps unmatched tracks pending", async () => {
        const { prisma, notificationService } = setupSpotifyImportMocks();
        (
            prisma.playlistPendingTrack.findMany as jest.Mock
        ).mockResolvedValueOnce([
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
        (prisma.track.findMany as jest.Mock).mockImplementation(
            async (query: any) => {
                if (query?.select?.title && query?.take === 5) return [];
                if (query?.where?.title?.contains && query?.take === 10)
                    return [];
                if (query?.where?.title?.contains && query?.take === 20)
                    return [];
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
            },
        );

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
        (
            prisma.playlistPendingTrack.findMany as jest.Mock
        ).mockResolvedValueOnce([
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
        (prisma.track.findMany as jest.Mock).mockImplementation(
            async (query: any) => {
                if (query?.select?.title && query?.take === 5) return [];
                if (query?.where?.title?.contains && query?.take === 10)
                    return [];
                if (query?.where?.title?.contains && query?.take === 20)
                    return [];
                if (query?.where?.title?.equals && query?.take === 10) {
                    return [
                        {
                            id: "existing-dup-track",
                            title: "Single Candidate Song",
                            album: {
                                artist: { name: "Only Candidate Artist" },
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

        expect(result).toEqual({ playlistsUpdated: 0, tracksAdded: 0 });
        expect(prisma.playlistItem.create).not.toHaveBeenCalled();
        expect(prisma.playlistPendingTrack.deleteMany).not.toHaveBeenCalled();
        expect(notificationService.create).not.toHaveBeenCalled();
    });

    it("reconcile strategy 2 can match via title containment and tolerates missing playlist records for notifications", async () => {
        const { prisma, notificationService } = setupSpotifyImportMocks();
        (
            prisma.playlistPendingTrack.findMany as jest.Mock
        ).mockResolvedValueOnce([
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
        (prisma.track.findMany as jest.Mock).mockImplementation(
            async (query: any) => {
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
                if (query?.where?.title?.contains && query?.take === 20)
                    return [];
                if (query?.where?.title?.equals && query?.take === 10)
                    return [];
                return [];
            },
        );
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
        (prisma.track.findMany as jest.Mock).mockImplementation(
            async (query: any) => {
                if (
                    query?.where?.album?.artist?.normalizedName?.contains &&
                    query?.take === 50
                ) {
                    return [];
                }
                if (query?.where?.title?.contains && query?.take === 20) {
                    return [];
                }
                if (
                    query?.where?.title?.contains &&
                    query?.take === 50 &&
                    query?.include?.album
                ) {
                    return [];
                }
                return [];
            },
        );
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
            }),
        ).resolves.toBeUndefined();

        expect(prisma.playlist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    spotifyPlaylistId: "sp-short-unmatched",
                    items: undefined,
                }),
            }),
        );
        expect(prisma.playlistPendingTrack.createMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.arrayContaining([
                    expect.objectContaining({
                        spotifyTitle: "Hey",
                        spotifyArtist: "No Match Artist",
                    }),
                ]),
            }),
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
                new Prisma.PrismaClientUnknownRequestError(""),
            ),
        ).toBe(false);
        expect(
            __spotifyImportTestables.isRetryableSpotifyImportPrismaError(
                "Connection reset by peer",
            ),
        ).toBe(true);
        expect(
            __spotifyImportTestables.isRetryableSpotifyImportPrismaError(
                undefined,
            ),
        ).toBe(false);
        expect(
            __spotifyImportTestables.isRetryableSpotifyImportRedisError(
                "Connection is closed",
            ),
        ).toBe(true);
        expect(
            __spotifyImportTestables.isRetryableSpotifyImportRedisError(
                undefined,
            ),
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
            }),
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
                tracks: [
                    { id: "track-other", title: "Completely Different Song" },
                ],
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
            }),
        );

        expect(result).toEqual(
            expect.objectContaining({
                matchType: "none",
                matchConfidence: 0,
                localTrack: null,
            }),
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
        const containmentResult = await (
            spotifyImportService as any
        ).matchTrack(
            makeSpotifyTrack({
                artist: "Artist A",
                title: "Song A",
                album: "Album Deluxe",
            }),
        );
        const fallbackResult = await (spotifyImportService as any).matchTrack(
            makeSpotifyTrack({
                artist: "Artist A",
                title: "Song A",
                album: "Unrelated Album",
            }),
        );

        expect(containmentResult.localTrack?.id).toBe(
            "track-album-containment",
        );
        expect(containmentResult.matchType).toBe("exact");
        expect(fallbackResult.localTrack?.id).toBe(
            "track-artist-title-fallback",
        );
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
            }),
        );

        expect(result.matchType).toBe("none");
        expect(result.localTrack).toBeNull();
    });

    it("matchTrack fuzzy full-artist fallback can short-circuit when full-artist first token is too short", async () => {
        const { prisma } = setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {
            extractPrimaryArtist,
        } = require("../../utils/artistNormalization");
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
            }),
        );

        expect(result.matchType).toBe("none");
    });

    it("findAlbumMbid can keep first artist when none exactly match and handle undefined release groups", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchArtist as jest.Mock).mockResolvedValueOnce([
            { id: "artist-keep-first", name: "Artist Alias" },
            { id: "artist-second", name: "Other Alias" },
        ]);
        (
            musicBrainzService.getReleaseGroups as jest.Mock
        ).mockResolvedValueOnce(undefined);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            (spotifyImportService as any).findAlbumMbid(
                "Different Artist Name",
                "Album Target",
            ),
        ).resolves.toEqual({
            artistMbid: "artist-keep-first",
            albumMbid: null,
        });
    });

    it("buildPreviewFromTracklist handles string-error unknown-album enrichment failures for Deezer source and tracks already in library", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        jest.spyOn(
            spotifyImportService as any,
            "enrichUnknownAlbumsViaMusicBrainz",
        ).mockRejectedValueOnce("mb enrichment string failure");
        jest.spyOn(spotifyImportService as any, "matchTrack").mockResolvedValue(
            {
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
            },
        );

        const preview = await (
            spotifyImportService as any
        ).buildPreviewFromTracklist(
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
            "Deezer",
        );

        expect(preview.summary.inLibrary).toBe(1);
        expect(preview.albumsToDownload).toHaveLength(0);
    });

    it("buildPreviewFromTracklist covers pre-resolved and unresolved album metadata fallbacks", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchArtist as jest.Mock).mockResolvedValueOnce(
            [],
        );
        (musicBrainzService.searchRecording as jest.Mock).mockResolvedValue(
            null,
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        jest.spyOn(spotifyImportService as any, "matchTrack").mockResolvedValue(
            {
                spotifyTrack: makeSpotifyTrack(),
                localTrack: null,
                matchType: "none",
                matchConfidence: 0,
            },
        );
        jest.spyOn(spotifyImportService as any, "findAlbumMbid")
            .mockResolvedValueOnce({
                artistMbid: null,
                albumMbid: "rg-known-without-artist",
            })
            .mockResolvedValueOnce({
                artistMbid: null,
                albumMbid: null,
            });

        const preview = await (
            spotifyImportService as any
        ).buildPreviewFromTracklist(
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
            "Spotify",
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
            ]),
        );
    });

    it("startImport maps pending tracks via tracksNeeded title+artist fallback when spotify ids differ", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        jest.spyOn(
            spotifyImportService as any,
            "processImport",
        ).mockResolvedValue(undefined);

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
            } as any,
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
            }),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.cancelJob("job-terminal-null-playlist"),
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
                    createdAt: new Date(
                        "2026-01-16T05:00:00.000Z",
                    ).toISOString(),
                    updatedAt: new Date(
                        "2026-01-16T05:01:00.000Z",
                    ).toISOString(),
                    pendingTracks: [],
                }),
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
                    createdAt: new Date(
                        "2026-01-16T05:00:00.000Z",
                    ).toISOString(),
                    updatedAt: new Date(
                        "2026-01-16T05:01:00.000Z",
                    ).toISOString(),
                    pendingTracks: [],
                }),
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
            spotifyImportService.checkImportCompletion("job-zero-downloads"),
        ).resolves.toBeUndefined();
        await expect(
            spotifyImportService.checkImportCompletion(
                "job-pending-unknown-status",
            ),
        ).resolves.toBeUndefined();
    });

    it("reconcile can leave strategy-2/strategy-4 candidates unmatched when containment and title-only candidate checks fail", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (
            prisma.playlistPendingTrack.findMany as jest.Mock
        ).mockResolvedValueOnce([
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
        (prisma.track.findMany as jest.Mock).mockImplementation(
            async (query: any) => {
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
                if (query?.where?.title?.contains && query?.take === 20)
                    return [];
                if (query?.where?.title?.equals && query?.take === 10)
                    return [];
                return [];
            },
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.reconcilePendingTracks(),
        ).resolves.toEqual({ playlistsUpdated: 0, tracksAdded: 0 });
        expect(prisma.playlistItem.create).not.toHaveBeenCalled();
        expect(prisma.playlistPendingTrack.deleteMany).not.toHaveBeenCalled();
    });

    it("enrichUnknownAlbumsViaMusicBrainz logs non-Error string failures from recording lookups", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchRecording as jest.Mock).mockRejectedValueOnce(
            "recording string failure",
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const stats = await (
            spotifyImportService as any
        ).enrichUnknownAlbumsViaMusicBrainz(
            [
                makeSpotifyTrack({
                    spotifyId: "sp-recording-string-fail",
                    artist: "Artist Fail",
                    title: "Song Fail",
                    album: "Unknown Album",
                }),
            ],
            "[UnknownAlbumStringError]",
        );

        expect(stats).toEqual(
            expect.objectContaining({
                resolved: 0,
                failed: 1,
            }),
        );
    });

    it("buildPreviewFromTracklist keeps non-unknown albums downloadable when MBIDs cannot be resolved", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchRecording as jest.Mock).mockResolvedValue(
            null,
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        jest.spyOn(spotifyImportService as any, "matchTrack").mockResolvedValue(
            {
                spotifyTrack: makeSpotifyTrack(),
                localTrack: null,
                matchType: "none",
                matchConfidence: 0,
            },
        );
        jest.spyOn(
            spotifyImportService as any,
            "findAlbumMbid",
        ).mockResolvedValue({
            artistMbid: null,
            albumMbid: null,
        });

        const preview = await (
            spotifyImportService as any
        ).buildPreviewFromTracklist(
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
            "Spotify",
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
            "Deezer",
        );
    });

    it("startImport can keep unknown-album display names when no album metadata fallback is available", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        jest.spyOn(
            spotifyImportService as any,
            "processImport",
        ).mockResolvedValue(undefined);

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
            } as any,
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
            } as any,
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
            makePreview("sp-scan-id-present"),
        );
        const jobWithoutId = await spotifyImportService.startImport(
            "u1",
            "sp-scan-id-missing",
            "Scan ID Missing",
            ["album-id"],
            makePreview("sp-scan-id-missing"),
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
                    createdAt: new Date(
                        "2026-01-17T01:00:00.000Z",
                    ).toISOString(),
                    updatedAt: new Date(
                        "2026-01-17T01:01:00.000Z",
                    ).toISOString(),
                    pendingTracks: [],
                }),
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
                    createdAt: new Date(
                        "2026-01-17T01:00:00.000Z",
                    ).toISOString(),
                    updatedAt: new Date(
                        "2026-01-17T01:01:00.000Z",
                    ).toISOString(),
                    pendingTracks: [],
                }),
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
        (prisma.track.findMany as jest.Mock).mockImplementation(
            async (query: any) => {
                if (query?.where?.title?.contains && query?.take === 10) {
                    return [];
                }
                if (
                    query?.where?.album?.artist?.normalizedName?.contains &&
                    query?.take === 50
                ) {
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
            },
        );
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
            }),
        ).resolves.toBeUndefined();
    });
});
