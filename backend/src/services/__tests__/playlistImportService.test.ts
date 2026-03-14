process.env.SETTINGS_ENCRYPTION_KEY =
    process.env.SETTINGS_ENCRYPTION_KEY ||
    "12345678901234567890123456789012";

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
        findMany: jest.fn(),
    },
    trackYtMusic: {
        upsert: jest.fn(),
        findMany: jest.fn(),
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
    getBrowsePlaylist: jest.fn(),
    restoreOAuthWithCredentials: jest.fn(),
};

const mockTidalStreamingService = {
    restoreOAuth: jest.fn(),
    findMatchesForAlbum: jest.fn(),
    getBrowsePlaylist: jest.fn(),
    getPublicBrowsePlaylist: jest.fn(),
};

const mockGetSystemSettings = jest.fn();

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
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: mockGetSystemSettings,
}));

import { playlistImportService } from "../playlistImportService";

describe("PlaylistImportService", () => {
    beforeEach(() => {
        jest.resetAllMocks();
        mockLogger.child.mockReturnValue(mockLogger);
        // Default: empty local library, no tidal auth
        mockPrisma.$transaction.mockImplementation(async (callback: any) =>
            callback(mockPrisma)
        );
        // track.findMany serves two roles:
        // 1. Local library candidates (select includes filePath/album) → returns []
        // 2. ID validation (where.id.in pattern) → returns matching stubs
        mockPrisma.track.findMany.mockImplementation(async (args: any) => {
            if (args?.where?.id?.in) {
                return (args.where.id.in as string[]).map((id: string) => ({ id }));
            }
            return []; // local library candidates: empty by default
        });
        mockPrisma.userSettings.findUnique.mockResolvedValue(null);
        mockGetSystemSettings.mockResolvedValue({
            ytMusicClientId: null,
            ytMusicClientSecret: null,
        });
        mockPrisma.playlist.create.mockResolvedValue({ id: "playlist_1" });
        mockPrisma.playlistItem.createMany.mockResolvedValue({ count: 0 });
        mockTidalStreamingService.restoreOAuth.mockResolvedValue(true);
        mockTrackMappingService.createMapping.mockResolvedValue({
            id: "mapping_1",
        });
        // Default: ID validation returns all referenced IDs as existing
        // track.findMany is also used for local library candidates (returns [])
        // so only return stubs when the where.id.in pattern is used
        mockPrisma.trackYtMusic.findMany.mockImplementation(async (args: any) => {
            const ids = args?.where?.id?.in || [];
            return ids.map((id: string) => ({ id }));
        });
        mockPrisma.trackTidal.findMany.mockImplementation(async (args: any) => {
            const ids = args?.where?.id?.in || [];
            return ids.map((id: string) => ({ id }));
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

        it("parses Spotify playlist URI", () => {
            mockSpotifyService.parseUrl.mockReturnValueOnce({
                type: "playlist",
                id: "abc123",
            });

            const result = playlistImportService.parseSourceUrl(
                "spotify:playlist:abc123"
            );

            expect(result).toEqual({ source: "spotify", id: "abc123" });
        });

        it("parses scheme-less Spotify playlist URL", () => {
            mockSpotifyService.parseUrl.mockReturnValueOnce({
                type: "playlist",
                id: "abc123",
            });

            const result = playlistImportService.parseSourceUrl(
                "open.spotify.com/playlist/abc123"
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

        it("parses YouTube Music playlist URL", () => {
            mockSpotifyService.parseUrl.mockReturnValueOnce(null);

            const result = playlistImportService.parseSourceUrl(
                "https://music.youtube.com/playlist?list=PLtest123"
            );

            expect(result).toEqual({ source: "youtube", id: "PLtest123" });
        });

        it("parses regular YouTube playlist URL", () => {
            mockSpotifyService.parseUrl.mockReturnValueOnce(null);

            const result = playlistImportService.parseSourceUrl(
                "https://www.youtube.com/playlist?list=PLtest456"
            );

            expect(result).toEqual({ source: "youtube", id: "PLtest456" });
        });

        it("parses mobile YouTube playlist URL", () => {
            mockSpotifyService.parseUrl.mockReturnValueOnce(null);

            const result = playlistImportService.parseSourceUrl(
                "https://m.youtube.com/playlist?list=PLmobile456"
            );

            expect(result).toEqual({ source: "youtube", id: "PLmobile456" });
        });

        it("parses Tidal playlist URL", () => {
            mockSpotifyService.parseUrl.mockReturnValueOnce(null);

            const result = playlistImportService.parseSourceUrl(
                "https://tidal.com/playlist/abc-123-def"
            );

            expect(result).toEqual({ source: "tidal", id: "abc-123-def" });
        });

        it("parses Tidal browse playlist URL", () => {
            mockSpotifyService.parseUrl.mockReturnValueOnce(null);

            const result = playlistImportService.parseSourceUrl(
                "https://listen.tidal.com/browse/playlist/abc-123-def"
            );

            expect(result).toEqual({ source: "tidal", id: "abc-123-def" });
        });

        it("parses YouTube URL with list param not first", () => {
            mockSpotifyService.parseUrl.mockReturnValueOnce(null);

            const result = playlistImportService.parseSourceUrl(
                "https://www.youtube.com/playlist?si=abc123&list=PLparamOrder"
            );

            expect(result).toEqual({ source: "youtube", id: "PLparamOrder" });
        });

        it("parses YouTube Music URL with trailing path slash", () => {
            mockSpotifyService.parseUrl.mockReturnValueOnce(null);

            const result = playlistImportService.parseSourceUrl(
                "https://music.youtube.com/playlist?list=PLtrailing"
            );

            expect(result).toEqual({ source: "youtube", id: "PLtrailing" });
        });

        it("parses YouTube URL with extra query params after list", () => {
            mockSpotifyService.parseUrl.mockReturnValueOnce(null);

            const result = playlistImportService.parseSourceUrl(
                "https://youtube.com/playlist?list=PLextra&feature=share"
            );

            expect(result).toEqual({ source: "youtube", id: "PLextra" });
        });

        it("returns null for unsupported URL", () => {
            mockSpotifyService.parseUrl.mockReturnValueOnce(null);

            const result = playlistImportService.parseSourceUrl(
                "https://example.com/not-a-playlist"
            );

            expect(result).toBeNull();
        });

        it("rejects provider URLs embedded in unrelated query strings", () => {
            mockSpotifyService.parseUrl.mockReturnValueOnce(null);

            const result = playlistImportService.parseSourceUrl(
                "https://evil.example/?u=https://listen.tidal.com/playlist/abc-123-def"
            );

            expect(result).toBeNull();
        });

        it("rejects Deezer playlist paths embedded in unrelated query strings", () => {
            mockSpotifyService.parseUrl.mockReturnValueOnce(null);

            const result = playlistImportService.parseSourceUrl(
                "https://evil.example/?next=https://www.deezer.com/playlist/12345"
            );

            expect(result).toBeNull();
        });

        it("rejects Spotify playlist URLs embedded in unrelated query strings", () => {
            const result = playlistImportService.parseSourceUrl(
                "https://evil.example/?next=https://open.spotify.com/playlist/37i9dQZF1DX4JAvHpjipBk"
            );

            expect(result).toBeNull();
            expect(mockSpotifyService.parseUrl).not.toHaveBeenCalled();
        });
    });

    describe("fetchSourceTracks", () => {
        it("fetches YouTube playlist tracks with videoId preserved", async () => {
            mockYtMusicService.getBrowsePlaylist.mockResolvedValueOnce({
                id: "PLtest123",
                title: "YT Playlist",
                description: "",
                trackCount: 2,
                thumbnailUrl: null,
                tracks: [
                    {
                        videoId: "vid1",
                        title: "Song A",
                        artist: "Artist A",
                        artists: ["Artist A"],
                        album: "Album A",
                        duration: 210,
                        thumbnailUrl: null,
                    },
                    {
                        videoId: "vid2",
                        title: "Song B",
                        artist: "Artist B",
                        artists: ["Artist B"],
                        album: "Album B",
                        duration: 220,
                        thumbnailUrl: null,
                    },
                ],
            });

            const result = await (playlistImportService as any).fetchSourceTracks(
                "youtube",
                "PLtest123"
            );

            expect(result.name).toBe("YT Playlist");
            expect(result.tracks).toHaveLength(2);
            expect(result.tracks[0].videoId).toBe("vid1");
            expect(result.tracks[1].videoId).toBe("vid2");
            expect(result.tracks[0].artist).toBe("Artist A");
        });

        it("uses authenticated user context for YouTube playlist fetch when userId is provided", async () => {
            mockPrisma.userSettings.findUnique.mockResolvedValueOnce({
                ytMusicOAuthJson: "yt-oauth-json",
            });
            mockYtMusicService.getBrowsePlaylist.mockResolvedValueOnce({
                id: "PLowned123",
                title: "Owned YT Playlist",
                description: "",
                trackCount: 1,
                thumbnailUrl: null,
                tracks: [
                    {
                        videoId: "owned_vid_1",
                        title: "Owned Song",
                        artist: "Owner Artist",
                        artists: ["Owner Artist"],
                        album: "Owner Album",
                        duration: 201,
                        thumbnailUrl: null,
                    },
                ],
            });

            const result = await (playlistImportService as any).fetchSourceTracks(
                "youtube",
                "PLowned123",
                "user_1"
            );

            expect(result.name).toBe("Owned YT Playlist");
            expect(
                mockYtMusicService.restoreOAuthWithCredentials
            ).toHaveBeenCalledWith(
                "user_1",
                "yt-oauth-json",
                undefined,
                undefined
            );
            expect(mockYtMusicService.getBrowsePlaylist).toHaveBeenCalledWith(
                "PLowned123",
                100,
                "user_1"
            );
        });

        it("falls back to public context for YouTube playlist fetch when user OAuth is unavailable", async () => {
            mockYtMusicService.getBrowsePlaylist.mockResolvedValueOnce({
                id: "PLpublicFallback",
                title: "Public Fallback Playlist",
                description: "",
                trackCount: 1,
                thumbnailUrl: null,
                tracks: [
                    {
                        videoId: "public_vid_1",
                        title: "Public Song",
                        artist: "Public Artist",
                        artists: ["Public Artist"],
                        album: "Public Album",
                        duration: 215,
                        thumbnailUrl: null,
                    },
                ],
            });

            const result = await (playlistImportService as any).fetchSourceTracks(
                "youtube",
                "PLpublicFallback",
                "user_1"
            );

            expect(result.name).toBe("Public Fallback Playlist");
            expect(
                mockYtMusicService.restoreOAuthWithCredentials
            ).not.toHaveBeenCalled();
            expect(mockYtMusicService.getBrowsePlaylist).toHaveBeenCalledWith(
                "PLpublicFallback",
                100,
                "__public__"
            );
        });

        it("fetches Tidal playlist tracks with tidalId preserved", async () => {
            mockPrisma.userSettings.findUnique.mockResolvedValueOnce({
                tidalOAuthJson: "encrypted",
            });
            mockTidalStreamingService.getBrowsePlaylist.mockResolvedValueOnce({
                id: "a1b2c3d4-e5f6-0000-0000-000000000099",
                title: "Tidal Playlist",
                trackCount: 1,
                thumbnailUrl: null,
                tracks: [
                    {
                        trackId: 12345,
                        title: "Tidal Song",
                        artist: "Tidal Artist",
                        artists: ["Tidal Artist"],
                        album: "Tidal Album",
                        duration: 300,
                        isrc: "USRC17607839",
                        thumbnailUrl: null,
                    },
                ],
            });

            const result = await (playlistImportService as any).fetchSourceTracks(
                "tidal",
                "a1b2c3d4-e5f6-0000-0000-000000000099",
                "user_1"
            );

            expect(result.name).toBe("Tidal Playlist");
            expect(result.tracks).toHaveLength(1);
            expect(result.tracks[0].tidalId).toBe(12345);
            expect(result.tracks[0].isrc).toBe("USRC17607839");
        });

        it("uses public Tidal browse when no userId is provided", async () => {
            mockTidalStreamingService.getPublicBrowsePlaylist.mockResolvedValueOnce({
                id: "a1b2c3d4-e5f6-0000-0000-000000000099",
                title: "Tidal Public Playlist",
                trackCount: 1,
                thumbnailUrl: null,
                tracks: [
                    {
                        trackId: 12345,
                        title: "Tidal Song",
                        artist: "Tidal Artist",
                        artists: ["Tidal Artist"],
                        album: "Tidal Album",
                        duration: 300,
                        isrc: "USRC17607839",
                        thumbnailUrl: null,
                    },
                ],
            });

            const result = await (playlistImportService as any).fetchSourceTracks(
                "tidal",
                "a1b2c3d4-e5f6-0000-0000-000000000099"
            );

            expect(result.name).toBe("Tidal Public Playlist");
            expect(
                mockTidalStreamingService.getPublicBrowsePlaylist
            ).toHaveBeenCalledWith(
                "a1b2c3d4-e5f6-0000-0000-000000000099",
                "HIGH"
            );
        });

        it("uses public Tidal browse when userId exists but Tidal auth is unavailable", async () => {
            mockTidalStreamingService.getPublicBrowsePlaylist.mockResolvedValueOnce({
                id: "a1b2c3d4-e5f6-0000-0000-000000000099",
                title: "Tidal Public Playlist",
                trackCount: 1,
                thumbnailUrl: null,
                tracks: [
                    {
                        trackId: 12345,
                        title: "Tidal Song",
                        artist: "Tidal Artist",
                        artists: ["Tidal Artist"],
                        album: "Tidal Album",
                        duration: 300,
                        isrc: "USRC17607839",
                        thumbnailUrl: null,
                    },
                ],
            });

            const result = await (playlistImportService as any).fetchSourceTracks(
                "tidal",
                "a1b2c3d4-e5f6-0000-0000-000000000099",
                "user_1"
            );

            expect(result.name).toBe("Tidal Public Playlist");
            expect(
                mockTidalStreamingService.getBrowsePlaylist
            ).not.toHaveBeenCalled();
            expect(
                mockTidalStreamingService.getPublicBrowsePlaylist
            ).toHaveBeenCalledWith(
                "a1b2c3d4-e5f6-0000-0000-000000000099",
                "HIGH"
            );
        });

        it("falls back to public Tidal browse when authenticated browse returns 401", async () => {
            mockPrisma.userSettings.findUnique.mockResolvedValueOnce({
                tidalOAuthJson: "encrypted",
            });
            mockTidalStreamingService.restoreOAuth.mockResolvedValueOnce(true);
            const unauthorizedError = new Error("Request failed with status code 401") as Error & {
                response?: { status?: number };
            };
            unauthorizedError.response = { status: 401 };
            mockTidalStreamingService.getBrowsePlaylist.mockRejectedValueOnce(
                unauthorizedError
            );
            mockTidalStreamingService.getPublicBrowsePlaylist.mockResolvedValueOnce({
                id: "a1b2c3d4-e5f6-0000-0000-000000000099",
                title: "Tidal Public Playlist",
                trackCount: 1,
                thumbnailUrl: null,
                tracks: [
                    {
                        trackId: 12345,
                        title: "Tidal Song",
                        artist: "Tidal Artist",
                        artists: ["Tidal Artist"],
                        album: "Tidal Album",
                        duration: 300,
                        isrc: "USRC17607839",
                        thumbnailUrl: null,
                    },
                ],
            });

            const result = await (playlistImportService as any).fetchSourceTracks(
                "tidal",
                "a1b2c3d4-e5f6-0000-0000-000000000099",
                "user_1"
            );

            expect(result.name).toBe("Tidal Public Playlist");
            expect(
                mockTidalStreamingService.getPublicBrowsePlaylist
            ).toHaveBeenCalledWith(
                "a1b2c3d4-e5f6-0000-0000-000000000099",
                "HIGH"
            );
        });

        it("maps public Tidal browse 404 responses to not-found errors", async () => {
            const notFoundError = new Error("Request failed with status code 404") as Error & {
                response?: { status?: number };
            };
            notFoundError.response = { status: 404 };
            mockTidalStreamingService.getPublicBrowsePlaylist.mockRejectedValueOnce(
                notFoundError
            );

            await expect(
                (playlistImportService as any).fetchSourceTracks(
                    "tidal",
                    "a1b2c3d4-e5f6-0000-0000-000000000099",
                )
            ).rejects.toThrow("Tidal playlist not found");
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

        it("prefers Tidal over YouTube when both matches exist and user has Tidal auth", async () => {
            mockTidalStreamingService.findMatchesForAlbum.mockResolvedValueOnce(
                [
                    {
                        id: 77777,
                        title: "Dual Match Song",
                        artist: "Dual Match Artist",
                        duration: 210,
                        isrc: "DUALMATCH1",
                    },
                ]
            );
            mockTrackMappingService.upsertTrackTidal.mockResolvedValueOnce({
                id: "ct_dual",
            });

            const result = await playlistImportService.resolveTrack(
                {
                    artist: "Dual Match Artist",
                    title: "Dual Match Song",
                    album: "Dual Match Album",
                },
                [],
                "user_1",
                true
            );

            expect(result.source).toBe("tidal");
            expect(result.trackTidalId).toBe("ct_dual");
            expect(mockYtMusicService.findMatchesForAlbum).not.toHaveBeenCalled();
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

    describe("native provider resolution", () => {
        it("YouTube playlist: creates TrackYtMusic directly from videoId without search", async () => {
            mockSpotifyService.parseUrl.mockReturnValue(null);

            mockYtMusicService.getBrowsePlaylist.mockResolvedValueOnce({
                id: "PLnative1",
                title: "YT Native Playlist",
                description: "",
                trackCount: 1,
                thumbnailUrl: null,
                tracks: [
                    {
                        videoId: "native_vid1",
                        title: "Native Song",
                        artist: "Native Artist",
                        artists: ["Native Artist"],
                        album: "Native Album",
                        duration: 200,
                        thumbnailUrl: null,
                    },
                ],
            });

            mockTrackMappingService.upsertTrackYtMusic.mockResolvedValueOnce({
                id: "cy_native1",
            });

            const result = await playlistImportService.previewImport(
                "user_1",
                "https://music.youtube.com/playlist?list=PLnative1"
            );

            expect(result.resolved[0].source).toBe("youtube");
            expect(result.resolved[0].trackYtMusicId).toBe("cy_native1");
            expect(result.resolved[0].confidence).toBe(100);
            // Should NOT call findMatchesForAlbum for native tracks
            expect(mockYtMusicService.findMatchesForAlbum).not.toHaveBeenCalled();
        });

        it("YouTube playlist: local match takes priority over direct videoId", async () => {
            mockSpotifyService.parseUrl.mockReturnValue(null);

            mockYtMusicService.getBrowsePlaylist.mockResolvedValueOnce({
                id: "PLpriority",
                title: "Priority Playlist",
                description: "",
                trackCount: 1,
                thumbnailUrl: null,
                tracks: [
                    {
                        videoId: "native_vid_local",
                        title: "Song 1",
                        artist: "Artist 1",
                        artists: ["Artist 1"],
                        album: "Album 1",
                        duration: 240,
                        thumbnailUrl: null,
                    },
                ],
            });

            // Local library has this track
            mockPrisma.track.findMany.mockResolvedValueOnce([
                {
                    id: "t1_local",
                    title: "Song 1",
                    duration: 240,
                    filePath: "/music/s1.flac",
                    album: {
                        title: "Album 1",
                        artist: { name: "Artist 1" },
                    },
                },
            ]);

            const result = await playlistImportService.previewImport(
                "user_1",
                "https://music.youtube.com/playlist?list=PLpriority"
            );

            expect(result.resolved[0].source).toBe("local");
            expect(result.resolved[0].trackId).toBe("t1_local");
        });

        it("Tidal playlist: creates TrackTidal directly from tidalId without search", async () => {
            mockSpotifyService.parseUrl.mockReturnValue(null);

            mockPrisma.userSettings.findUnique.mockResolvedValueOnce({
                tidalOAuthJson: "encrypted",
            });

            mockTidalStreamingService.getBrowsePlaylist.mockResolvedValueOnce({
                id: "a1b2c3d4-e5f6-0000-0000-000000000001",
                title: "Tidal Native Playlist",
                trackCount: 1,
                thumbnailUrl: null,
                tracks: [
                    {
                        trackId: 99999,
                        title: "Tidal Native Song",
                        artist: "Tidal Native Artist",
                        artists: ["Tidal Native Artist"],
                        album: "Tidal Native Album",
                        duration: 250,
                        isrc: "USRC17607839",
                        thumbnailUrl: null,
                    },
                ],
            });

            mockTrackMappingService.upsertTrackTidal.mockResolvedValueOnce({
                id: "ct_native1",
            });

            const result = await playlistImportService.previewImport(
                "user_1",
                "https://tidal.com/playlist/a1b2c3d4-e5f6-0000-0000-000000000001"
            );

            expect(result.resolved[0].source).toBe("tidal");
            expect(result.resolved[0].trackTidalId).toBe("ct_native1");
            expect(result.resolved[0].confidence).toBe(100);
            expect(
                mockTidalStreamingService.findMatchesForAlbum
            ).not.toHaveBeenCalled();
        });

        it("Tidal playlist: local match takes priority over direct tidalId", async () => {
            mockSpotifyService.parseUrl.mockReturnValue(null);

            mockPrisma.userSettings.findUnique.mockResolvedValueOnce({
                tidalOAuthJson: "encrypted",
            });

            mockTidalStreamingService.getBrowsePlaylist.mockResolvedValueOnce({
                id: "a1b2c3d4-e5f6-0000-0000-000000000002",
                title: "Priority Tidal",
                trackCount: 1,
                thumbnailUrl: null,
                tracks: [
                    {
                        trackId: 88888,
                        title: "Song 1",
                        artist: "Artist 1",
                        artists: ["Artist 1"],
                        album: "Album 1",
                        duration: 240,
                        isrc: null,
                        thumbnailUrl: null,
                    },
                ],
            });

            mockPrisma.track.findMany.mockResolvedValueOnce([
                {
                    id: "t1_local",
                    title: "Song 1",
                    duration: 240,
                    filePath: "/music/s1.flac",
                    album: {
                        title: "Album 1",
                        artist: { name: "Artist 1" },
                    },
                },
            ]);

            const result = await playlistImportService.previewImport(
                "user_1",
                "https://tidal.com/playlist/a1b2c3d4-e5f6-0000-0000-000000000002"
            );

            expect(result.resolved[0].source).toBe("local");
            expect(result.resolved[0].trackId).toBe("t1_local");
        });

        it("YouTube import: remaining unresolved tracks still search YT Music", async () => {
            mockSpotifyService.parseUrl.mockReturnValue(null);

            mockYtMusicService.getBrowsePlaylist.mockResolvedValueOnce({
                id: "PLmixed",
                title: "Mixed Playlist",
                description: "",
                trackCount: 2,
                thumbnailUrl: null,
                tracks: [
                    {
                        videoId: "native_vid1",
                        title: "Native Song",
                        artist: "Native Artist",
                        artists: ["Native Artist"],
                        album: "Native Album",
                        duration: 200,
                        thumbnailUrl: null,
                    },
                    {
                        videoId: "",
                        title: "Search Song",
                        artist: "Search Artist",
                        artists: ["Search Artist"],
                        album: "Search Album",
                        duration: 180,
                        thumbnailUrl: null,
                    },
                ],
            });

            // Native track upsert
            mockTrackMappingService.upsertTrackYtMusic
                .mockResolvedValueOnce({ id: "cy_native" })
                .mockResolvedValueOnce({ id: "cy_search" });

            // Search for the non-native track (empty videoId)
            mockYtMusicService.findMatchesForAlbum.mockResolvedValueOnce([
                { videoId: "yt_searched", title: "Search Song", duration: 180 },
            ]);

            const result = await playlistImportService.previewImport(
                "user_1",
                "https://music.youtube.com/playlist?list=PLmixed"
            );

            expect(result.summary.youtube).toBe(2);
            expect(result.resolved[0].confidence).toBe(100);
            expect(result.resolved[1].confidence).toBe(85);
        });

        it("Tidal import: remaining unresolved tracks still search YouTube as fallback", async () => {
            mockSpotifyService.parseUrl.mockReturnValue(null);

            mockPrisma.userSettings.findUnique.mockResolvedValueOnce({
                tidalOAuthJson: "encrypted",
            });

            mockTidalStreamingService.getBrowsePlaylist.mockResolvedValueOnce({
                id: "a1b2c3d4-e5f6-0000-0000-000000000003",
                title: "Tidal Mixed",
                trackCount: 2,
                thumbnailUrl: null,
                tracks: [
                    {
                        trackId: 11111,
                        title: "Tidal Native",
                        artist: "Tidal Artist",
                        artists: ["Tidal Artist"],
                        album: "Tidal Album",
                        duration: 200,
                        isrc: "ISRC1",
                        thumbnailUrl: null,
                    },
                    {
                        trackId: 0,
                        title: "Fallback Song",
                        artist: "Fallback Artist",
                        artists: ["Fallback Artist"],
                        album: "Fallback Album",
                        duration: 190,
                        isrc: null,
                        thumbnailUrl: null,
                    },
                ],
            });

            // Native upsert
            mockTrackMappingService.upsertTrackTidal.mockResolvedValueOnce({
                id: "ct_native",
            });

            // YT search fallback for second track
            mockYtMusicService.findMatchesForAlbum.mockResolvedValueOnce([
                { videoId: "yt_fallback", title: "Fallback Song", duration: 190 },
            ]);
            mockTrackMappingService.upsertTrackYtMusic.mockResolvedValueOnce({
                id: "cy_fallback",
            });

            const result = await playlistImportService.previewImport(
                "user_1",
                "https://tidal.com/playlist/a1b2c3d4-e5f6-0000-0000-000000000003"
            );

            expect(result.summary.tidal).toBe(1);
            expect(result.summary.youtube).toBe(1);
            expect(result.resolved[0].confidence).toBe(100);
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

        it("skips Tidal matching when session restore fails and falls back to YouTube", async () => {
            mockSpotifyService.parseUrl.mockReturnValue({
                type: "playlist",
                id: "sp_tidal_restore_fail",
            });
            mockSpotifyService.getPlaylist.mockResolvedValueOnce({
                name: "Restore Fail Playlist",
                tracks: [
                    {
                        title: "Fallback Only",
                        artist: "Fallback Artist",
                        album: "Fallback Album",
                        durationMs: 190000,
                        isrc: null,
                    },
                ],
            });
            mockPrisma.userSettings.findUnique.mockResolvedValueOnce({
                tidalOAuthJson: "encrypted",
            });
            mockTidalStreamingService.restoreOAuth.mockResolvedValueOnce(false);
            mockYtMusicService.findMatchesForAlbum.mockResolvedValueOnce([
                { videoId: "yt_fallback_only", title: "Fallback Only", duration: 190 },
            ]);
            mockTrackMappingService.upsertTrackYtMusic.mockResolvedValueOnce({
                id: "cy_restore_fail",
            });

            const result = await playlistImportService.previewImport(
                "user_1",
                "https://open.spotify.com/playlist/sp_tidal_restore_fail"
            );

            expect(mockTidalStreamingService.restoreOAuth).toHaveBeenCalledWith(
                "user_1",
                "encrypted"
            );
            expect(
                mockTidalStreamingService.findMatchesForAlbum
            ).not.toHaveBeenCalled();
            expect(result.summary.tidal).toBe(0);
            expect(result.summary.youtube).toBe(1);
            expect(result.summary.unresolved).toBe(0);
        });
    });

    describe("previewM3UImport", () => {
        it("resolves M3U entries through path, filename, exact metadata, and fuzzy metadata tiers", async () => {
            mockPrisma.track.findMany.mockResolvedValueOnce([
                {
                    id: "track-path",
                    title: "Actual Title",
                    duration: 240,
                    filePath: "Artist/Album/01 - Direct Hit.flac",
                    album: {
                        title: "Actual Album",
                        artist: { name: "Actual Artist" },
                    },
                },
                {
                    id: "track-filename",
                    title: "Filename Winner",
                    duration: 200,
                    filePath: "Library/Folder/Filename Winner.mp3",
                    album: {
                        title: "Filename Album",
                        artist: { name: "Filename Artist" },
                    },
                },
                {
                    id: "track-exact",
                    title: "Exact Match",
                    duration: 213,
                    filePath: "Library/Folder/not-the-same-file.mp3",
                    album: {
                        title: "Exact Album",
                        artist: { name: "Exact Artist" },
                    },
                },
                {
                    id: "track-fuzzy",
                    title: "Neon Light",
                    duration: 180,
                    filePath: "Library/Folder/other-file.mp3",
                    album: {
                        title: "Singles",
                        artist: { name: "Echoes" },
                    },
                },
            ]);

            const result = await playlistImportService.previewM3UImport(
                "Imported Playlist",
                `#EXTM3U
C:\\Music\\Artist\\Album\\01 - Direct Hit.flac
D:\\Exports\\Mixes\\Filename Winner.mp3
#EXTINF:213,Exact Artist - Exact Match
/playlists/exact-match.m3u8
#EXTINF:180,The Echoes - Neon Lights
/playlists/fuzzy-match.m3u8
#EXTINF:200,Missing Artist - Missing Song
/playlists/missing-song.m3u8`
            );

            expect(result.playlistName).toBe("Imported Playlist");
            expect(result.resolved).toEqual([
                expect.objectContaining({
                    index: 0,
                    source: "local",
                    trackId: "track-path",
                    confidence: 100,
                }),
                expect.objectContaining({
                    index: 1,
                    source: "local",
                    trackId: "track-filename",
                    confidence: 98,
                }),
                expect.objectContaining({
                    index: 2,
                    source: "local",
                    trackId: "track-exact",
                    confidence: 100,
                }),
                expect.objectContaining({
                    index: 3,
                    source: "local",
                    trackId: "track-fuzzy",
                    confidence: 79,
                }),
                expect.objectContaining({
                    index: 4,
                    source: "unresolved",
                    confidence: 0,
                }),
            ]);
            expect(result.summary).toEqual({
                total: 5,
                local: 4,
                youtube: 0,
                tidal: 0,
                unresolved: 1,
            });
            expect(mockYtMusicService.findMatchesForAlbum).not.toHaveBeenCalled();
            expect(mockTidalStreamingService.findMatchesForAlbum).not.toHaveBeenCalled();
        });

        it("rejects malformed M3U content safely", async () => {
            await expect(
                playlistImportService.previewM3UImport(
                    "Broken Playlist",
                    "/music/track\x00.mp3"
                )
            ).rejects.toThrow("null bytes");
        });
    });

    describe("importPlaylist", () => {
        const previewData = {
            playlistName: "Imported",
            resolved: [
                {
                    index: 0,
                    artist: "A1",
                    title: "T1",
                    source: "local" as const,
                    confidence: 100,
                    trackId: "track_local_1",
                },
                {
                    index: 1,
                    artist: "A2",
                    title: "T2",
                    source: "local" as const,
                    confidence: 95,
                    trackId: "track_local_1",
                },
                {
                    index: 2,
                    artist: "A3",
                    title: "T3",
                    source: "youtube" as const,
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
        };

        it("creates playlist from provided preview data without re-fetching", async () => {
            await playlistImportService.importPlaylist(
                "user_1",
                previewData
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
        });

        it("uses overrideName when provided", async () => {
            await playlistImportService.importPlaylist(
                "user_1",
                previewData,
                "Custom Name"
            );

            expect(mockPrisma.playlist.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    data: expect.objectContaining({
                        name: "Custom Name",
                    }),
                })
            );
        });

        it("rejects when previewData contains non-existent trackId", async () => {
            // Override: ID validation returns empty — the referenced trackId doesn't exist
            mockPrisma.track.findMany.mockImplementationOnce(async () => []);

            const badPreviewData = {
                playlistName: "Bad Refs",
                resolved: [
                    {
                        index: 0,
                        artist: "A1",
                        title: "T1",
                        source: "local" as const,
                        confidence: 100,
                        trackId: "nonexistent_track_id",
                    },
                ],
                summary: { total: 1, local: 1, youtube: 0, tidal: 0, unresolved: 0 },
            };

            await expect(
                playlistImportService.importPlaylist("user_1", badPreviewData)
            ).rejects.toThrow(/invalid track reference/i);

            expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        });

        it("rejects when previewData contains non-existent trackYtMusicId", async () => {
            // No YT music rows exist for the given ID
            mockPrisma.trackYtMusic.findMany.mockResolvedValueOnce([]);

            const badPreviewData = {
                playlistName: "Bad YT Refs",
                resolved: [
                    {
                        index: 0,
                        artist: "A1",
                        title: "T1",
                        source: "youtube" as const,
                        confidence: 85,
                        trackYtMusicId: "nonexistent_yt_id",
                    },
                ],
                summary: { total: 1, local: 0, youtube: 1, tidal: 0, unresolved: 0 },
            };

            await expect(
                playlistImportService.importPlaylist("user_1", badPreviewData)
            ).rejects.toThrow(/invalid track reference/i);

            expect(mockPrisma.$transaction).not.toHaveBeenCalled();
        });

        it("fails without partial writes when transactional item creation errors", async () => {
            mockPrisma.playlistItem.createMany.mockRejectedValueOnce(
                new Error("createMany failed")
            );

            await expect(
                playlistImportService.importPlaylist(
                    "user_1",
                    previewData
                )
            ).rejects.toThrow("createMany failed");

            expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
            expect(mockTrackMappingService.createMapping).not.toHaveBeenCalled();
        });
    });
});
