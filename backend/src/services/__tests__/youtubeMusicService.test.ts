const mockClient = {
    get: jest.fn(),
    post: jest.fn(),
};

const mockAxiosCreate = jest.fn((_config?: any) => mockClient);
jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: (config: any) => mockAxiosCreate(config),
    },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

import { ytMusicService } from "../youtubeMusic";
import { logger } from "../../utils/logger";

describe("youtubeMusic service", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
    });

    it("checks sidecar availability and handles auth/oath method payloads", async () => {
        mockClient.get.mockResolvedValueOnce({ status: 200 });
        await expect(ytMusicService.isAvailable()).resolves.toBe(true);
        expect(mockClient.get).toHaveBeenCalledWith("/health", { timeout: 5000 });

        mockClient.get.mockRejectedValueOnce(new Error("down"));
        await expect(ytMusicService.isAvailable()).resolves.toBe(false);

        mockClient.get.mockResolvedValueOnce({
            data: { authenticated: true, reason: "ok" },
        });
        await expect(ytMusicService.getAuthStatus("u1")).resolves.toEqual({
            authenticated: true,
            reason: "ok",
        });
        expect(mockClient.get).toHaveBeenLastCalledWith("/auth/status", {
            params: { user_id: "u1" },
        });

        await ytMusicService.restoreOAuth("u1", "{\"access\":\"a\"}");
        expect(mockClient.post).toHaveBeenLastCalledWith(
            "/auth/restore",
            { oauth_json: "{\"access\":\"a\"}" },
            { params: { user_id: "u1" } }
        );

        await ytMusicService.clearAuth("u1");
        expect(mockClient.post).toHaveBeenLastCalledWith(
            "/auth/clear",
            null,
            { params: { user_id: "u1" } }
        );

        mockClient.post.mockResolvedValueOnce({
            data: {
                device_code: "dc",
                user_code: "uc",
                verification_url: "https://verify",
                expires_in: 600,
                interval: 5,
            },
        });
        await expect(
            ytMusicService.initiateDeviceAuth("client-id", "client-secret")
        ).resolves.toEqual(
            expect.objectContaining({
                device_code: "dc",
                user_code: "uc",
            })
        );

        mockClient.post.mockResolvedValueOnce({
            data: { status: "pending", error: undefined },
        });
        await expect(
            ytMusicService.pollDeviceAuth("u1", "client-id", "client-secret", "dc")
        ).resolves.toEqual({ status: "pending", error: undefined });
        expect(mockClient.post).toHaveBeenLastCalledWith(
            "/auth/device-code/poll",
            {
                client_id: "client-id",
                client_secret: "client-secret",
                device_code: "dc",
            },
            { params: { user_id: "u1" } }
        );

        await ytMusicService.restoreOAuthWithCredentials(
            "u1",
            "{\"token\":\"x\"}",
            "client-id",
            "client-secret"
        );
        expect(mockClient.post).toHaveBeenLastCalledWith(
            "/auth/restore",
            {
                oauth_json: "{\"token\":\"x\"}",
                client_id: "client-id",
                client_secret: "client-secret",
            },
            { params: { user_id: "u1" } }
        );

        await ytMusicService.restoreOAuthWithCredentials("u2", "{\"token\":\"y\"}");
        expect(mockClient.post).toHaveBeenLastCalledWith(
            "/auth/restore",
            { oauth_json: "{\"token\":\"y\"}" },
            { params: { user_id: "u2" } }
        );
    });

    it("retries search for retryable failures and throws non-retryable failures", async () => {
        jest.useFakeTimers();

        mockClient.post
            .mockRejectedValueOnce({
                response: { status: 429, headers: { "retry-after": "1" } },
            })
            .mockResolvedValueOnce({
                data: { results: [{ videoId: "v1" }], total: 1 },
            });

        const searchPromise = ytMusicService.search("u1", "test query", "songs");
        await jest.advanceTimersByTimeAsync(1000);
        await expect(searchPromise).resolves.toEqual({
            results: [{ videoId: "v1" }],
            total: 1,
        });
        expect(mockClient.post).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalled();

        mockClient.post.mockRejectedValueOnce({ response: { status: 400 } });
        await expect(
            ytMusicService.search("u1", "bad query", "songs")
        ).rejects.toEqual({ response: { status: 400 } });
    });

    it("handles browse, stream, and library request shapes", async () => {
        mockClient.get
            .mockResolvedValueOnce({ data: { browseId: "album-1" } })
            .mockResolvedValueOnce({ data: { channelId: "artist-1" } })
            .mockResolvedValueOnce({ data: { videoId: "song-1" } });

        await expect(ytMusicService.getAlbum("u1", "album-1")).resolves.toEqual({
            browseId: "album-1",
        });
        await expect(ytMusicService.getArtist("u1", "artist-1")).resolves.toEqual({
            channelId: "artist-1",
        });
        await expect(ytMusicService.getSong("u1", "song-1")).resolves.toEqual({
            videoId: "song-1",
        });

        jest.useFakeTimers();
        mockClient.get
            .mockRejectedValueOnce({
                response: { status: 429, headers: { "retry-after": "1" } },
            })
            .mockResolvedValueOnce({
                data: {
                    videoId: "vid-1",
                    url: "https://stream",
                    content_type: "audio/webm",
                    duration: 100,
                    abr: 160,
                    acodec: "opus",
                    expires_at: 123,
                },
            });
        const streamInfoPromise = ytMusicService.getStreamInfo(
            "u1",
            "vid-1",
            "high"
        );
        await jest.advanceTimersByTimeAsync(1000);
        await expect(streamInfoPromise).resolves.toEqual(
            expect.objectContaining({ videoId: "vid-1", abr: 160 })
        );
        expect(mockClient.get).toHaveBeenLastCalledWith("/stream/vid-1", {
            params: { user_id: "u1", quality: "high" },
        });

        mockClient.get.mockResolvedValueOnce({ data: { pipe: jest.fn() } });
        await ytMusicService.getStreamProxy("u1", "vid-2", "low", "bytes=0-512");
        expect(mockClient.get).toHaveBeenLastCalledWith("/proxy/vid-2", {
            params: { user_id: "u1", quality: "low" },
            headers: { Range: "bytes=0-512" },
            responseType: "stream",
            timeout: 120000,
        });

        mockClient.get
            .mockResolvedValueOnce({ data: { songs: [{ id: "s1" }] } })
            .mockResolvedValueOnce({ data: { albums: [{ id: "a1" }] } });
        await expect(ytMusicService.getLibrarySongs("u1", 30)).resolves.toEqual([
            { id: "s1" },
        ]);
        await expect(ytMusicService.getLibraryAlbums("u1", 30)).resolves.toEqual([
            { id: "a1" },
        ]);
    });

    it("runs batch search and album matching with second-pass fallback", async () => {
        const searchBatchSpy = jest.spyOn(ytMusicService, "searchBatch");
        searchBatchSpy
            .mockResolvedValueOnce([
                {
                    results: [
                        {
                            videoId: "first-match",
                            title: "Track One",
                            artist: "Artist One",
                            type: "song",
                            duration_seconds: 199,
                        },
                    ],
                    total: 1,
                    error: null,
                },
                {
                    results: [],
                    total: 0,
                    error: null,
                },
            ])
            .mockResolvedValueOnce([
                {
                    results: [
                        {
                            videoId: "second-match",
                            title: "Track Two",
                            artists: ["Artist Two"],
                            album: { name: "Album Two" },
                            type: "song",
                            duration: "03:20",
                        },
                    ],
                    total: 1,
                    error: null,
                },
            ]);

        const matches = await ytMusicService.findMatchesForAlbum("u1", [
            {
                artist: "Artist One (feat. X)",
                title: "Track One [Live]",
                albumTitle: "Album One",
                duration: 200,
            },
            {
                artist: "Artist Two",
                title: "Track Two",
                albumTitle: "Album Two",
                duration: 200,
            },
        ]);

        expect(matches).toEqual([
            { videoId: "first-match", title: "Track One", duration: 199 },
            { videoId: "second-match", title: "Track Two", duration: 200 },
        ]);

        expect(searchBatchSpy).toHaveBeenCalledTimes(2);
        const firstBatchQueries = searchBatchSpy.mock.calls[0]?.[1];
        expect(firstBatchQueries).toEqual([
            { query: "Artist One Track One", filter: "songs", limit: 6 },
            { query: "Artist Two Track Two", filter: "songs", limit: 6 },
        ]);
        const fallbackQueries = searchBatchSpy.mock.calls[1]?.[1];
        expect(fallbackQueries).toEqual([
            { query: "Artist Two Track Two Album Two", limit: 8 },
        ]);
    });

    it("falls back to individual matching when batch search fails", async () => {
        jest.spyOn(ytMusicService, "searchBatch").mockRejectedValueOnce(
            new Error("batch failed")
        );
        const findMatchSpy = jest
            .spyOn(ytMusicService, "findMatchForTrack")
            .mockResolvedValueOnce({
                videoId: "m1",
                title: "Song One",
                duration: 210,
            })
            .mockResolvedValueOnce(null);

        const result = await ytMusicService.findMatchesForAlbum("u1", [
            { artist: "A1", title: "Song One", albumTitle: "ALB1" },
            { artist: "A2", title: "Song Two", albumTitle: "ALB2" },
        ]);

        expect(result).toEqual([
            { videoId: "m1", title: "Song One", duration: 210 },
            null,
        ]);
        expect(findMatchSpy).toHaveBeenCalledTimes(2);
    });

    it("uses tiered matching logic for single-track fallback searches", async () => {
        const searchSpy = jest.spyOn(ytMusicService, "search");
        searchSpy.mockResolvedValueOnce({
            results: [
                {
                    videoId: "good",
                    title: "Song Title",
                    artist: "Exact Artist",
                    duration_seconds: 201,
                    type: "song",
                },
                {
                    videoId: "bad-karaoke",
                    title: "Song Title Karaoke",
                    artist: "Exact Artist",
                    duration_seconds: 201,
                    type: "song",
                },
            ],
            total: 2,
        });

        await expect(
            ytMusicService.findMatchForTrack(
                "u1",
                "Exact Artist",
                "Song Title",
                "Album X",
                200
            )
        ).resolves.toEqual({
            videoId: "good",
            title: "Song Title",
            duration: 201,
        });

        searchSpy
            .mockRejectedValueOnce(new Error("filtered failed"))
            .mockResolvedValueOnce({
                results: [{ videoId: "wrong", title: "Not It", artist: "Other" }],
                total: 1,
            })
            .mockResolvedValueOnce({
                results: [
                    {
                        videoId: "third-try",
                        title: "Final Song",
                        artists: ["Right Artist"],
                        duration: "03:45",
                        type: "song",
                        album: "Final Album",
                    },
                ],
                total: 1,
            });

        await expect(
            ytMusicService.findMatchForTrack(
                "u1",
                "Right Artist",
                "Final Song",
                "Final Album",
                225
            )
        ).resolves.toEqual({
            videoId: "third-try",
            title: "Final Song",
            duration: 225,
        });

        searchSpy
            .mockResolvedValueOnce({
                results: [
                    {
                        videoId: "unrelated-1",
                        title: "Completely Different",
                        artist: "Another Artist",
                        type: "song",
                        duration_seconds: 400,
                    },
                    {
                        videoId: "unrelated-2",
                        title: "Also Different",
                        artist: "Not Artist",
                        type: "song",
                        duration_seconds: 420,
                    },
                ],
                total: 2,
            })
            .mockResolvedValueOnce({
                results: [
                    {
                        videoId: "unrelated-3",
                        title: "Wrong Song",
                        artist: "Someone Else",
                        type: "song",
                        duration_seconds: 500,
                    },
                ],
                total: 1,
            });

        await expect(
            ytMusicService.findMatchForTrack("u1", "Artist", "Love Song", undefined, 200)
        ).resolves.toBeNull();
    });

    it("parses numeric candidate duration values when duration_seconds is absent", async () => {
        const searchSpy = jest.spyOn(ytMusicService, "search");
        searchSpy.mockResolvedValueOnce({
            results: [
                {
                    videoId: "dur-num",
                    title: "Exact Track",
                    artist: "Exact Artist",
                    duration: 212,
                    type: "song",
                },
            ],
            total: 1,
        });

        await expect(
            ytMusicService.findMatchForTrack(
                "u1",
                "Exact Artist",
                "Exact Track",
                undefined,
                210
            )
        ).resolves.toEqual({
            videoId: "dur-num",
            title: "Exact Track",
            duration: 212,
        });
    });

    it("applies jittered exponential backoff when Retry-After header is missing", async () => {
        jest.useFakeTimers();
        const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0);
        mockClient.post
            .mockRejectedValueOnce({ response: { status: 500 } })
            .mockResolvedValueOnce({
                data: { results: [{ videoId: "v1" }], total: 1 },
            });

        const searchPromise = ytMusicService.search("u1", "timeoutless");

        await jest.advanceTimersByTimeAsync(750);
        await expect(searchPromise).resolves.toEqual({
            results: [{ videoId: "v1" }],
            total: 1,
        });
        expect(mockClient.post).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalled();
        expect(logger.warn).toHaveBeenLastCalledWith(
            "[YTMusic] search(timeoutless) failed (status=500, attempt=1/3), retrying in 750ms"
        );
        randomSpy.mockRestore();
    });

    it("retries on retryable network errors such as ECONNRESET", async () => {
        jest.useFakeTimers();
        const randomSpy = jest.spyOn(Math, "random").mockReturnValue(0.5);
        mockClient.post
            .mockRejectedValueOnce({ code: "ECONNRESET" })
            .mockResolvedValueOnce({
                data: { results: [{ videoId: "v2" }], total: 1 },
            });

        const searchPromise = ytMusicService.search("u1", "network-flaky");
        await jest.advanceTimersByTimeAsync(1000);
        await expect(searchPromise).resolves.toEqual({
            results: [{ videoId: "v2" }],
            total: 1,
        });
        expect(mockClient.post).toHaveBeenCalledTimes(2);
        randomSpy.mockRestore();
    });

    it("keeps unmatched tracks as null when fallback batch search fails", async () => {
        const searchBatchSpy = jest
            .spyOn(ytMusicService, "searchBatch")
            .mockResolvedValueOnce([
                {
                    results: [
                        {
                            videoId: "first",
                            title: "Track One",
                            artist: "Artist One",
                            type: "song",
                            duration_seconds: 190,
                        },
                    ],
                    total: 1,
                    error: null,
                },
                {
                    results: [],
                    total: 0,
                    error: null,
                },
            ])
            .mockRejectedValueOnce(new Error("fallback failed"));

        const tracks = [
            { artist: "Artist One", title: "Track One" },
            { artist: "Artist Two", title: "Track Two" },
        ];

        const result = await ytMusicService.findMatchesForAlbum("u1", tracks);
        expect(result).toEqual([
            { videoId: "first", title: "Track One", duration: 190 },
            null,
        ]);
        expect(searchBatchSpy).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith(
            "[YTMusic] Batch fallback search failed:",
            expect.any(Error)
        );
    });

    it("rejects ambiguous best candidates when top score confidence spread is too small", () => {
        const scoreSpy = jest
            .spyOn(ytMusicService as any, "scoreCandidate")
            .mockReturnValueOnce(0.63)
            .mockReturnValueOnce(0.6);

        const winner = (ytMusicService as any).selectBestCandidate(
            {
                artist: "Artist",
                title: "Ambiguous Title",
            },
            [
                { videoId: "first", title: "Ambiguous Title", artist: "Artist" },
                { videoId: "second", title: "Ambiguous Title", artist: "Artist" },
            ]
        );

        expect(winner).toBeNull();
        expect(scoreSpy).toHaveBeenCalledTimes(2);
    });

    it("logs a warning when third-track matching attempt fails and returns null", async () => {
        const searchSpy = jest.spyOn(ytMusicService, "search");
        searchSpy
            .mockResolvedValueOnce({ results: [], total: 0 })
            .mockResolvedValueOnce({ results: [], total: 0 })
            .mockRejectedValueOnce(new Error("all failed"));

        await expect(
            ytMusicService.findMatchForTrack(
                "u1",
                "Artist",
                "Song",
                "Album"
            )
        ).resolves.toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(
            "[YTMusic] All search attempts failed for \"Artist - Song\":",
            expect.any(Error)
        );
    });
});
