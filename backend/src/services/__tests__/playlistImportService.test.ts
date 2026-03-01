const mockPrisma = {
    $transaction: jest.fn(),
    track: {
        findMany: jest.fn(),
    },
    userSettings: {
        findUnique: jest.fn(),
    },
    playlist: {
        create: jest.fn(),
    },
    playlistItem: {
        createMany: jest.fn(),
    },
    trackTidal: {
        upsert: jest.fn(),
    },
    trackYtMusic: {
        upsert: jest.fn(),
    },
    trackMapping: {
        create: jest.fn(),
    },
};

const mockLogger: Record<string, jest.Mock> = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
mockLogger.child.mockReturnValue(mockLogger);

const mockSpotifyService = {
    parseUrl: jest.fn(),
    getPlaylist: jest.fn(),
};

const mockDeezerService = {
    getPlaylist: jest.fn(),
};

const mockYtMusicService = {
    findMatchesForAlbum: jest.fn(),
};

const mockTidalStreamingService = {
    findMatchesForAlbum: jest.fn(),
};

const mockTrackMappingService = {
    upsertTrackYtMusic: jest.fn(),
    upsertTrackTidal: jest.fn(),
    createMapping: jest.fn(),
};

jest.mock("../../utils/db", () => ({ prisma: mockPrisma }));
jest.mock("../../utils/logger", () => ({ logger: mockLogger }));
jest.mock("../spotify", () => ({ spotifyService: mockSpotifyService }));
jest.mock("../deezer", () => ({ deezerService: mockDeezerService }));
jest.mock("../youtubeMusic", () => ({ ytMusicService: mockYtMusicService }));
jest.mock("../tidalStreaming", () => ({
    tidalStreamingService: mockTidalStreamingService,
}));
jest.mock("../trackMappingService", () => ({
    trackMappingService: mockTrackMappingService,
}));

import { playlistImportService } from "../playlistImportService";

describe("PlaylistImportService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Default: empty local library, no tidal auth
        mockPrisma.$transaction.mockImplementation(async (callback: any) =>
            callback(mockPrisma)
        );
        mockPrisma.track.findMany.mockResolvedValue([]);
        mockPrisma.userSettings.findUnique.mockResolvedValue(null);
        mockPrisma.playlist.create.mockResolvedValue({ id: "playlist_1" });
        mockPrisma.playlistItem.createMany.mockResolvedValue({ count: 0 });
        mockTrackMappingService.createMapping.mockResolvedValue({
            id: "mapping_1",
        });
    });

    describe("parseSourceUrl", () => {
        it("parses Spotify playlist URL", () => {
            mockSpotifyService.parseUrl.mockReturnValueOnce({
                type: "playlist",
                id: "abc123",
            });

            const result = playlistImportService.parseSourceUrl(
                "https://open.spotify.com/playlist/abc123"
            );

            expect(result).toEqual({ source: "spotify", id: "abc123" });
        });

        it("parses Deezer playlist URL", () => {
            mockSpotifyService.parseUrl.mockReturnValueOnce(null);

            const result = playlistImportService.parseSourceUrl(
                "https://www.deezer.com/en/playlist/12345"
            );

            expect(result).toEqual({ source: "deezer", id: "12345" });
        });

        it("returns null for unsupported URL", () => {
            mockSpotifyService.parseUrl.mockReturnValueOnce(null);

            const result = playlistImportService.parseSourceUrl(
                "https://example.com/not-a-playlist"
            );

            expect(result).toBeNull();
        });
    });

    describe("resolveTrack", () => {
        const localCandidates = [
            {
                id: "track_local_1",
                title: "Test Song",
                duration: 240,
                albumTitle: "Test Album",
                artistName: "Test Artist",
                filePath: "/music/test.flac",
            },
        ];

        it("local match returns trackId with source=local", async () => {
            const result = await playlistImportService.resolveTrack(
                {
                    artist: "Test Artist",
                    title: "Test Song",
                    album: "Test Album",
                    duration: 240,
                },
                localCandidates,
                "user_1",
                false
            );

            expect(result.source).toBe("local");
            expect(result.trackId).toBe("track_local_1");
            expect(result.confidence).toBe(100);
        });

        it("no local match but YT match returns trackYtMusicId", async () => {
            mockYtMusicService.findMatchesForAlbum.mockResolvedValueOnce([
                { videoId: "yt123", title: "Unknown Song", duration: 200 },
            ]);
            mockTrackMappingService.upsertTrackYtMusic.mockResolvedValueOnce({
                id: "cy_1",
            });

            const result = await playlistImportService.resolveTrack(
                {
                    artist: "Unknown Artist",
                    title: "Unknown Song",
                    album: "Unknown Album",
                },
                localCandidates,
                "user_1",
                false
            );

            expect(result.source).toBe("youtube");
            expect(result.trackYtMusicId).toBe("cy_1");
            expect(result.confidence).toBe(85);
        });

        it("both YT and Tidal fail returns unresolved", async () => {
            mockYtMusicService.findMatchesForAlbum.mockResolvedValueOnce([
                null,
            ]);

            const result = await playlistImportService.resolveTrack(
                {
                    artist: "Obscure Artist",
                    title: "Rare Track",
                },
                [],
                "user_1",
                false
            );

            expect(result.source).toBe("unresolved");
            expect(result.confidence).toBe(0);
        });

        it("Tidal match when user has auth", async () => {
            mockYtMusicService.findMatchesForAlbum.mockResolvedValueOnce([
                null,
            ]);
            mockTidalStreamingService.findMatchesForAlbum.mockResolvedValueOnce(
                [
                    {
                        id: 99999,
                        title: "Tidal Song",
                        artist: "Tidal Artist",
                        duration: 300,
                        isrc: "USRC17607839",
                    },
                ]
            );
            mockTrackMappingService.upsertTrackTidal.mockResolvedValueOnce({
                id: "ct_1",
            });

            const result = await playlistImportService.resolveTrack(
                {
                    artist: "Tidal Artist",
                    title: "Tidal Song",
                },
                [],
                "user_1",
                true // has Tidal auth
            );

            expect(result.source).toBe("tidal");
            expect(result.trackTidalId).toBe("ct_1");
        });

        it("upsert reuses existing TrackYtMusic", async () => {
            mockYtMusicService.findMatchesForAlbum.mockResolvedValueOnce([
                { videoId: "yt_existing", title: "Existing", duration: 200 },
            ]);
            mockTrackMappingService.upsertTrackYtMusic.mockResolvedValueOnce({
                id: "cy_existing",
            });

            const result = await playlistImportService.resolveTrack(
                { artist: "A", title: "Existing" },
                [],
                "user_1",
                false
            );

            expect(result.trackYtMusicId).toBe("cy_existing");
            expect(
                mockTrackMappingService.upsertTrackYtMusic
            ).toHaveBeenCalledWith(
                expect.objectContaining({ videoId: "yt_existing" })
            );
        });
    });

    describe("previewImport", () => {
        it("returns resolution summary for Spotify playlist", async () => {
            mockSpotifyService.parseUrl.mockReturnValue({
                type: "playlist",
                id: "sp_123",
            });
            mockSpotifyService.getPlaylist.mockResolvedValueOnce({
                name: "My Playlist",
                tracks: [
                    {
                        title: "Song 1",
                        artist: "Artist 1",
                        album: "Album 1",
                        durationMs: 240000,
                        isrc: null,
                    },
                    {
                        title: "Song 2",
                        artist: "Artist 2",
                        album: "Album 2",
                        durationMs: 180000,
                        isrc: null,
                    },
                ],
            });

            // Song 1: local match
            mockPrisma.track.findMany.mockResolvedValueOnce([
                {
                    id: "t1",
                    title: "Song 1",
                    duration: 240,
                    filePath: "/music/s1.flac",
                    album: {
                        title: "Album 1",
                        artist: { name: "Artist 1" },
                    },
                },
            ]);

            // Song 2: YT Music match
            mockYtMusicService.findMatchesForAlbum.mockResolvedValue([
                { videoId: "yt1", title: "Song 2", duration: 180 },
            ]);
            mockTrackMappingService.upsertTrackYtMusic.mockResolvedValue({
                id: "cy_1",
            });

            const result = await playlistImportService.previewImport(
                "user_1",
                "https://open.spotify.com/playlist/sp_123"
            );

            expect(result.playlistName).toBe("My Playlist");
            expect(result.resolved).toHaveLength(2);
            expect(result.summary.total).toBe(2);
        });

        it("batch-resolves provider matches in a single YT call when tracks are unmatched locally", async () => {
            mockSpotifyService.parseUrl.mockReturnValue({
                type: "playlist",
                id: "sp_batch",
            });
            mockSpotifyService.getPlaylist.mockResolvedValueOnce({
                name: "Batch Playlist",
                tracks: [
                    {
                        title: "Song A",
                        artist: "Artist A",
                        album: "Album A",
                        durationMs: 210000,
                        isrc: null,
                    },
                    {
                        title: "Song B",
                        artist: "Artist B",
                        album: "Album B",
                        durationMs: 220000,
                        isrc: null,
                    },
                    {
                        title: "Song C",
                        artist: "Artist C",
                        album: "Album C",
                        durationMs: 230000,
                        isrc: null,
                    },
                ],
            });

            mockYtMusicService.findMatchesForAlbum.mockResolvedValueOnce([
                { videoId: "yt_a", title: "Song A", duration: 210 },
                null,
                { videoId: "yt_c", title: "Song C", duration: 230 },
            ]);
            mockTrackMappingService.upsertTrackYtMusic
                .mockResolvedValueOnce({ id: "cy_a" })
                .mockResolvedValueOnce({ id: "cy_c" });

            const result = await playlistImportService.previewImport(
                "user_1",
                "https://open.spotify.com/playlist/sp_batch"
            );

            expect(mockYtMusicService.findMatchesForAlbum).toHaveBeenCalledTimes(
                1
            );
            expect(mockYtMusicService.findMatchesForAlbum).toHaveBeenCalledWith(
                "__public__",
                [
                    expect.objectContaining({
                        artist: "Artist A",
                        title: "Song A",
                        albumTitle: "Album A",
                        duration: 210,
                    }),
                    expect.objectContaining({
                        artist: "Artist B",
                        title: "Song B",
                        albumTitle: "Album B",
                        duration: 220,
                    }),
                    expect.objectContaining({
                        artist: "Artist C",
                        title: "Song C",
                        albumTitle: "Album C",
                        duration: 230,
                    }),
                ]
            );
            expect(result.summary.youtube).toBe(2);
            expect(result.summary.unresolved).toBe(1);
        });

        it("batch-resolves unresolved tracks through Tidal after YT misses", async () => {
            mockSpotifyService.parseUrl.mockReturnValue({
                type: "playlist",
                id: "sp_tidal",
            });
            mockSpotifyService.getPlaylist.mockResolvedValueOnce({
                name: "Tidal Playlist",
                tracks: [
                    {
                        title: "Tidal 1",
                        artist: "Tidal Artist 1",
                        album: "Tidal Album 1",
                        durationMs: 200000,
                        isrc: null,
                    },
                    {
                        title: "Tidal 2",
                        artist: "Tidal Artist 2",
                        album: "Tidal Album 2",
                        durationMs: 205000,
                        isrc: null,
                    },
                ],
            });
            mockPrisma.userSettings.findUnique.mockResolvedValueOnce({
                tidalOAuthJson: "encrypted",
            });
            mockYtMusicService.findMatchesForAlbum.mockResolvedValueOnce([
                null,
                null,
            ]);
            mockTidalStreamingService.findMatchesForAlbum.mockResolvedValueOnce(
                [
                    {
                        id: 123,
                        title: "Tidal 1",
                        artist: "Tidal Artist 1",
                        duration: 200,
                        isrc: "ISRC123",
                    },
                    null,
                ]
            );
            mockTrackMappingService.upsertTrackTidal.mockResolvedValueOnce({
                id: "ct_123",
            });

            const result = await playlistImportService.previewImport(
                "user_1",
                "https://open.spotify.com/playlist/sp_tidal"
            );

            expect(mockYtMusicService.findMatchesForAlbum).toHaveBeenCalledTimes(
                1
            );
            expect(
                mockTidalStreamingService.findMatchesForAlbum
            ).toHaveBeenCalledTimes(1);
            expect(mockTidalStreamingService.findMatchesForAlbum).toHaveBeenCalledWith(
                "user_1",
                [
                    expect.objectContaining({
                        artist: "Tidal Artist 1",
                        title: "Tidal 1",
                        albumTitle: "Tidal Album 1",
                    }),
                    expect.objectContaining({
                        artist: "Tidal Artist 2",
                        title: "Tidal 2",
                        albumTitle: "Tidal Album 2",
                    }),
                ]
            );
            expect(result.summary.tidal).toBe(1);
            expect(result.summary.unresolved).toBe(1);
        });
    });

    describe("importPlaylist", () => {
        it("writes playlist + items atomically and skips duplicate local trackIds", async () => {
            const previewSpy = jest
                .spyOn(playlistImportService, "previewImport")
                .mockResolvedValue({
                    playlistName: "Imported",
                    resolved: [
                        {
                            index: 0,
                            artist: "A1",
                            title: "T1",
                            source: "local",
                            confidence: 100,
                            trackId: "track_local_1",
                        },
                        {
                            index: 1,
                            artist: "A2",
                            title: "T2",
                            source: "local",
                            confidence: 95,
                            trackId: "track_local_1",
                        },
                        {
                            index: 2,
                            artist: "A3",
                            title: "T3",
                            source: "youtube",
                            confidence: 85,
                            trackYtMusicId: "cy_3",
                        },
                    ],
                    summary: {
                        total: 3,
                        local: 2,
                        youtube: 1,
                        tidal: 0,
                        unresolved: 0,
                    },
                });

            await playlistImportService.importPlaylist(
                "user_1",
                "https://open.spotify.com/playlist/sp_123",
                "Imported"
            );

            expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
            expect(mockPrisma.playlistItem.createMany).toHaveBeenCalledWith({
                data: [
                    {
                        playlistId: "playlist_1",
                        trackId: "track_local_1",
                        trackTidalId: null,
                        trackYtMusicId: null,
                        sort: 0,
                    },
                    {
                        playlistId: "playlist_1",
                        trackId: null,
                        trackTidalId: null,
                        trackYtMusicId: "cy_3",
                        sort: 1,
                    },
                ],
                skipDuplicates: true,
            });
            expect(mockTrackMappingService.createMapping).toHaveBeenCalledTimes(
                2
            );

            previewSpy.mockRestore();
        });

        it("fails without partial writes when transactional item creation errors", async () => {
            const previewSpy = jest
                .spyOn(playlistImportService, "previewImport")
                .mockResolvedValue({
                    playlistName: "Imported",
                    resolved: [
                        {
                            index: 0,
                            artist: "A1",
                            title: "T1",
                            source: "local",
                            confidence: 100,
                            trackId: "track_local_1",
                        },
                    ],
                    summary: {
                        total: 1,
                        local: 1,
                        youtube: 0,
                        tidal: 0,
                        unresolved: 0,
                    },
                });
            mockPrisma.playlistItem.createMany.mockRejectedValueOnce(
                new Error("createMany failed")
            );

            await expect(
                playlistImportService.importPlaylist(
                    "user_1",
                    "https://open.spotify.com/playlist/sp_123",
                    "Imported"
                )
            ).rejects.toThrow("createMany failed");

            expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
            expect(mockTrackMappingService.createMapping).not.toHaveBeenCalled();

            previewSpy.mockRestore();
        });
    });
});
