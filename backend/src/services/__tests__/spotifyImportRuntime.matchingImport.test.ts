import {
    makeSpotifyTrack,
    setupSpotifyImportMocks,
} from "./spotifyImportRuntime.helpers";

describe("spotify import runtime behavior", () => {
    afterEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    it("builds preview albums using pre-resolved MBIDs and track-based MusicBrainz fallback", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchArtist as jest.Mock).mockResolvedValue([
            { id: "artist-u", name: "Artist Unknown" },
        ]);
        (musicBrainzService.searchRecording as jest.Mock).mockResolvedValueOnce(
            {
                albumName: "Recovered Album",
                albumMbid: "rg-recovered",
                artistMbid: "artist-k",
            },
        );

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

        jest.spyOn(
            spotifyImportService as any,
            "enrichUnknownAlbumsViaMusicBrainz",
        ).mockImplementation(async (tracks: unknown) => {
            const mutableTracks = tracks as any[];
            mutableTracks[0].albumId = "mbid:rg-pre-resolved";
            mutableTracks[0].album = "Recovered Unknown";
            return { resolved: 1, failed: 0, cached: new Map() };
        });
        jest.spyOn(
            spotifyImportService as any,
            "matchTrack",
        ).mockImplementation(async (spotifyTrack: any) => ({
            spotifyTrack,
            localTrack: null,
            matchType: "none",
            matchConfidence: 0,
        }));
        jest.spyOn(
            spotifyImportService as any,
            "findAlbumMbid",
        ).mockResolvedValue({ artistMbid: "artist-k", albumMbid: null });

        const preview = await (
            spotifyImportService as any
        ).buildPreviewFromTracklist(
            [unknownTrack, knownTrack],
            {
                id: "playlist-preview",
                name: "Preview",
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
                    albumMbid: "rg-pre-resolved",
                    artistName: "Artist Unknown",
                }),
                expect.objectContaining({
                    albumMbid: "rg-recovered",
                    artistName: "Artist Known",
                    albumName: "Recovered Album",
                }),
            ]),
        );
        expect(preview.summary.downloadable).toBe(2);
    });

    it("runs buildPlaylist through deep matching strategies with dedupe and unmatched carry-over", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValueOnce({
            id: "track-strategy",
            title: "Epic Song One",
        });
        (prisma.track.findFirst as jest.Mock).mockImplementation(
            async (query: any) => {
                if (query?.where?.id?.in) {
                    const contains = String(
                        query?.where?.title?.contains || "",
                    ).toLowerCase();
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
                    const startsWith = String(
                        query.where.title.startsWith,
                    ).toLowerCase();
                    if (startsWith.includes("lost ballad")) {
                        return { id: "track-low", title: "Not Similar Song" };
                    }
                    return null;
                }

                return null;
            },
        );
        (prisma.track.findMany as jest.Mock).mockImplementation(
            async (query: any) => {
                if (
                    query?.take === 10 &&
                    query?.where?.title?.contains &&
                    !query?.include
                ) {
                    const search = String(
                        query.where.title.contains,
                    ).toLowerCase();
                    if (search.includes("epic")) {
                        return [
                            {
                                id: "track-candidate",
                                title: "Different Epic Demo",
                            },
                        ];
                    }
                    return [];
                }

                if (
                    query?.take === 50 &&
                    query?.include?.album &&
                    query?.where?.album?.artist?.normalizedName?.contains
                ) {
                    const artistNeedle = String(
                        query.where.album.artist.normalizedName.contains,
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
                    const firstWord = String(
                        query.where.title.contains,
                    ).toLowerCase();
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
                    const titleNeedle = String(
                        query.where.title.contains,
                    ).toLowerCase();
                    if (titleNeedle.includes("lost ballad")) {
                        return [
                            {
                                id: "track-title-only",
                                title: "Lost Ballad of Shadows Extended Version",
                                album: {
                                    artist: { name: "Compilation Artist" },
                                },
                            },
                        ];
                    }
                    return [];
                }

                return [];
            },
        );
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
            (spotifyImportService as any).buildPlaylist(deepJob),
        ).resolves.toBeUndefined();

        expect(prisma.playlist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    spotifyPlaylistId: "sp-deep",
                    items: {
                        create: expect.arrayContaining([
                            expect.objectContaining({
                                trackId: "track-strategy",
                            }),
                        ]),
                    },
                }),
            }),
        );
        expect(prisma.playlistPendingTrack.createMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.arrayContaining([
                    expect.objectContaining({
                        spotifyArtist: "No Library Artist",
                        spotifyTitle: "Completely Unmatched Song",
                    }),
                ]),
            }),
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
            }),
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
                preview,
            ),
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
            }),
        );
        expect(completionSpy).toHaveBeenCalledWith("job-regular-download");
    });

    it("retries spotify-import prisma reads on rust panic and generic retryable string errors", async () => {
        const { prisma } = setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Prisma } = require("@prisma/client");
        (prisma.spotifyImportJob.findMany as jest.Mock)
            .mockRejectedValueOnce(
                new Prisma.PrismaClientRustPanicError("panic in query engine"),
            )
            .mockRejectedValueOnce("Can't reach database server")
            .mockResolvedValueOnce([]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.getUserJobs("u-rust-generic"),
        ).resolves.toEqual([]);

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
            preview as any,
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
            ]),
        );
        expect(processSpy).toHaveBeenCalled();
    });

    it("persists failed status when background processImport rejects from startImport", async () => {
        const { prisma } = setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        jest.spyOn(
            spotifyImportService as any,
            "processImport",
        ).mockRejectedValue(new Error("process import exploded"));

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
            preview as any,
        );

        await new Promise((resolve) => setImmediate(resolve));

        const upsertCalls = (prisma.spotifyImportJob.upsert as jest.Mock).mock
            .calls;
        expect(
            upsertCalls.some(
                (call: any[]) =>
                    call?.[0]?.update?.status === "failed" &&
                    call?.[0]?.update?.error === "process import exploded",
            ),
        ).toBe(true);
    });

    it("marks processImport failed when no-download playlist build throws", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        jest.spyOn(
            spotifyImportService as any,
            "buildPlaylist",
        ).mockRejectedValueOnce(new Error("playlist build failed"));

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
            }),
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

        (prisma.track.findFirst as jest.Mock).mockImplementation(
            async (query: any) => {
                if (
                    query?.where?.title?.equals &&
                    query?.where?.album?.artist?.normalizedName
                ) {
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
            },
        );

        (prisma.track.findMany as jest.Mock).mockImplementation(
            async (query: any) => {
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
                        query.where.album.artist.normalizedName.contains || "",
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
                    const firstWord = String(
                        query.where.title.contains,
                    ).toLowerCase();
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
            },
        );
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
            (spotifyImportService as any).buildPlaylist(deepJob),
        ).resolves.toBeUndefined();

        expect(prisma.playlist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    spotifyPlaylistId: "sp-branches",
                    items: {
                        create: expect.arrayContaining([
                            expect.objectContaining({
                                trackId: "track-startswith-hit",
                            }),
                            expect.objectContaining({
                                trackId: "track-fuzzy-best",
                            }),
                            expect.objectContaining({
                                trackId: "track-title-only",
                            }),
                        ]),
                    },
                }),
            }),
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
        (
            notificationService.notifyImportComplete as jest.Mock
        ).mockRejectedValueOnce(new Error("notification down"));

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
            }),
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
            }),
        );

        expect(result.matchType).toBe("exact");
        expect(result.matchConfidence).toBe(95);
        expect(result.localTrack?.id).toBe("track-normalized-album-hit");
    });

    it("uses full-artist strategy-3 fallback when primary-artist title matching returns no results", async () => {
        const { prisma } = setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {
            extractPrimaryArtist,
        } = require("../../utils/artistNormalization");
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
            }),
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
            }),
        );

        expect(result.matchType).toBe("exact");
        expect(result.matchConfidence).toBe(90);
        expect(result.localTrack?.id).toBe("track-album-match");
    });

    it("falls back to full-artist fuzzy search strategy when earlier fuzzy passes find nothing", async () => {
        const { prisma } = setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {
            extractPrimaryArtist,
        } = require("../../utils/artistNormalization");
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
            }),
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

    it("returns artist MBID with null album MBID when no release groups satisfy similarity threshold", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchArtist as jest.Mock).mockResolvedValueOnce([
            { id: "artist-no-rg", name: "Artist No RG" },
        ]);
        (
            musicBrainzService.getReleaseGroups as jest.Mock
        ).mockResolvedValueOnce([
            { id: "rg-low-1", title: "Completely Different Album" },
            { id: "rg-low-2", title: "Another Different Album" },
        ]);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            (spotifyImportService as any).findAlbumMbid(
                "Artist No RG",
                "Target Album Name",
            ),
        ).resolves.toEqual({ artistMbid: "artist-no-rg", albumMbid: null });
    });

    it("skips MusicBrainz unknown-album enrichment when there are no unknown tracks", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        const stats = await (
            spotifyImportService as any
        ).enrichUnknownAlbumsViaMusicBrainz(
            [
                makeSpotifyTrack({
                    spotifyId: "sp-known-1",
                    album: "Known Album",
                }),
            ],
            "[Known Tracks]",
        );

        expect(stats).toEqual({
            resolved: 0,
            failed: 0,
            cached: new Map(),
        });
    });

    it("caches unresolved unknown-album lookups and increments failed counters for duplicates", async () => {
        const { musicBrainzService } = setupSpotifyImportMocks();
        (musicBrainzService.searchRecording as jest.Mock).mockResolvedValueOnce(
            null,
        );

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

        const stats = await (
            spotifyImportService as any
        ).enrichUnknownAlbumsViaMusicBrainz(
            duplicateUnknownTracks,
            "[Unknown Duplicate]",
        );

        expect(stats.resolved).toBe(0);
        expect(stats.failed).toBe(2);
        expect(musicBrainzService.searchRecording).toHaveBeenCalledTimes(1);
    });

    it("continues preview generation when unknown-album enrichment throws and tracks remain unknown", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        jest.spyOn(
            spotifyImportService as any,
            "enrichUnknownAlbumsViaMusicBrainz",
        ).mockRejectedValueOnce(new Error("enrichment failed"));
        jest.spyOn(spotifyImportService as any, "matchTrack").mockResolvedValue(
            {
                spotifyTrack: makeSpotifyTrack({
                    spotifyId: "sp-preview-unknown",
                    artist: "Preview Artist",
                    title: "Preview Song",
                    album: "Unknown Album",
                }),
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
            "Spotify",
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
            JSON.stringify(activeJob),
        );
        (redisClient.setEx as jest.Mock).mockRejectedValueOnce(
            new Error("cache write failed"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { logger } = require("../../utils/logger");
        await expect(
            spotifyImportService.cancelJob("job-cancel-cache-warn"),
        ).resolves.toEqual({
            playlistCreated: false,
            playlistId: null,
            tracksMatched: 0,
        });

        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                "Failed to cache import job job-cancel-cache-warn in Redis:",
            ),
            expect.any(Error),
        );
    });

    it("returns DB-backed import jobs when redis repopulation fails", async () => {
        const { prisma, redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(null);
        (prisma.spotifyImportJob.findUnique as jest.Mock).mockResolvedValueOnce(
            {
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
            },
        );
        (redisClient.setEx as jest.Mock).mockRejectedValueOnce(
            new Error("repopulate failed"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { logger } = require("../../utils/logger");
        const job = await spotifyImportService.getJob("job-db-cache-warn");

        expect(job?.id).toBe("job-db-cache-warn");
        expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining(
                "Failed to cache import job job-db-cache-warn in Redis:",
            ),
            expect.any(Error),
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
            }),
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
            spotifyImportService.checkImportCompletion("job-pending-order"),
        ).resolves.toBeUndefined();

        expect(scanQueue.add).not.toHaveBeenCalled();
        expect(redisClient.setEx).toHaveBeenCalled();
    });

    it("matches buildPlaylist tracks via strategy-3 contains+similarity branch", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(null);
        (prisma.track.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.track.findMany as jest.Mock).mockImplementation(
            async (query: any) => {
                if (query?.take === 10 && query?.where?.title?.contains) {
                    return [
                        {
                            id: "track-build-s3-direct",
                            title: "Direct Similarity Anthem",
                        },
                    ];
                }
                return [];
            },
        );

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
            }),
        ).resolves.toBeUndefined();

        expect(prisma.playlist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    items: {
                        create: [
                            expect.objectContaining({
                                trackId: "track-build-s3-direct",
                            }),
                        ],
                    },
                }),
            }),
        );
    });

    it("matches buildPlaylist tracks via strategy-3 containment branch", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(null);
        (prisma.track.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.track.findMany as jest.Mock).mockImplementation(
            async (query: any) => {
                if (query?.take === 10 && query?.where?.title?.contains) {
                    return [
                        {
                            id: "track-build-s3-containment",
                            title: "Containment Match Song and a very long extended alternate live studio take",
                        },
                    ];
                }
                return [];
            },
        );

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
            }),
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
            }),
        );
    });

    it("matches buildPlaylist tracks via strategy-5 best fuzzy candidate selection", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.track.findUnique as jest.Mock).mockResolvedValue(null);
        (prisma.track.findFirst as jest.Mock).mockResolvedValue(null);
        (prisma.track.findMany as jest.Mock).mockImplementation(
            async (query: any) => {
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
            },
        );

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
            }),
        ).resolves.toBeUndefined();

        expect(prisma.playlist.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    items: {
                        create: [
                            expect.objectContaining({
                                trackId: "track-build-s5-best",
                            }),
                        ],
                    },
                }),
            }),
        );
    });

    it("reconciles pending tracks through strategy-2 similarity/containment and strategy-3 score thresholds", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (
            prisma.playlistPendingTrack.findMany as jest.Mock
        ).mockResolvedValueOnce([
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
        (prisma.track.findMany as jest.Mock).mockImplementation(
            async (query: any) => {
                if (query?.select?.title && query?.take === 5) {
                    return [];
                }

                if (query?.take === 10 && query?.include?.album) {
                    const containsTerm = String(
                        query?.where?.title?.contains || "",
                    );
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
                                title: "Containment Seed Song with a very long extended alternate mix version",
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
            },
        );

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
        (musicBrainzService.searchRecording as jest.Mock).mockResolvedValueOnce(
            {
                albumName: "Fallback Recovered Album",
                albumMbid: "rg-fallback",
                artistMbid: "artist-fallback",
            },
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
                artistMbid: "artist-direct",
                albumMbid: "rg-direct",
            })
            .mockResolvedValueOnce({
                artistMbid: "artist-fallback",
                albumMbid: null,
            });

        const preview = await (
            spotifyImportService as any
        ).buildPreviewFromTracklist(
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
            "Spotify",
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
            ]),
        );
        expect(musicBrainzService.searchRecording).toHaveBeenCalledWith(
            "Fallback Song",
            "Fallback Artist",
        );
    });

    it("wraps root and nested client functions while preserving non-function proxy values", async () => {
        setupSpotifyImportMocks();
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { __spotifyImportTestables } = require("../spotifyImport");
        const rootMethod = jest.fn(async (value: string) => `root:${value}`);
        const nestedMethod = jest.fn(
            async (value: string) => `nested:${value}`,
        );
        const proxied = __spotifyImportTestables.createPrismaRetryProxy(
            {
                ping: rootMethod,
                track: {
                    findMany: nestedMethod,
                    modelName: "Track",
                },
                version: "1.0.0",
            } as any,
            "proxyTest",
        );

        await expect(proxied.ping("ok")).resolves.toBe("root:ok");
        await expect(proxied.track.findMany("query")).resolves.toBe(
            "nested:query",
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
            preview as any,
        );
        await new Promise((resolve) => setImmediate(resolve));

        const createdLogger = (createPlaylistLogger as jest.Mock).mock
            .results[0].value;
        expect(buildPlaylistSpy).toHaveBeenCalledTimes(1);
        expect(createdLogger.info).toHaveBeenCalledWith(
            expect.stringContaining("ignored in resolution-only mode"),
        );
        expect(createdLogger.logAlbumFailed).not.toHaveBeenCalled();
    });

    it("retries prisma operation when retryable string errors occur and reconnect fails once", async () => {
        const { prisma } = setupSpotifyImportMocks();
        (prisma.spotifyImportJob.findMany as jest.Mock)
            .mockRejectedValueOnce("Connection reset by peer")
            .mockResolvedValueOnce([]);
        (prisma.$connect as jest.Mock).mockRejectedValueOnce(
            new Error("connect failed"),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.getUserJobs("u-prisma-retry-connect-fail"),
        ).resolves.toEqual([]);
        expect(prisma.spotifyImportJob.findMany).toHaveBeenCalledTimes(2);
        expect(prisma.$connect).toHaveBeenCalledTimes(1);
    });

    it("retries redis operations when retryable redis errors are thrown as strings", async () => {
        const { redisClient, redisRecoveryClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockRejectedValueOnce(
            "Connection is closed",
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
            }),
        );

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { spotifyImportService } = require("../spotifyImport");
        await expect(
            spotifyImportService.getJob("job-redis-string-retry"),
        ).resolves.toEqual(
            expect.objectContaining({
                id: "job-redis-string-retry",
            }),
        );

        expect(redisClient.duplicate).toHaveBeenCalledTimes(1);
        expect(redisRecoveryClient.connect).toHaveBeenCalledTimes(1);
    });

    it("defaults pendingTracks to empty arrays when DB records contain null", async () => {
        const { prisma, redisClient } = setupSpotifyImportMocks();
        (redisClient.get as jest.Mock).mockResolvedValueOnce(null);
        (prisma.spotifyImportJob.findUnique as jest.Mock).mockResolvedValueOnce(
            {
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
            },
        );
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
});
