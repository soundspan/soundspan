const mockClient = {
    get: jest.fn(),
    post: jest.fn(),
};

const mockAxiosCreate = jest.fn((_config?: unknown) => mockClient);

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        create: (config: unknown) => mockAxiosCreate(config),
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

import { logger } from "../../utils/logger";
import { ytMusicService } from "../youtubeMusic";

type MutableServiceState = {
    availabilityCache: unknown;
    availabilityInFlight: unknown;
};

describe("youtubeMusic service branch coverage", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useRealTimers();
        const mutableService = ytMusicService as unknown as MutableServiceState;
        mutableService.availabilityCache = null;
        mutableService.availabilityInFlight = null;
    });

    it("reuses in-flight availability request and then cached value", async () => {
        let resolveHealth!: (value: unknown) => void;
        const healthPromise = new Promise((resolve) => {
            resolveHealth = resolve;
        });

        mockClient.get.mockReturnValueOnce(healthPromise);

        const first = ytMusicService.isAvailable();
        const second = ytMusicService.isAvailable();
        expect(mockClient.get).toHaveBeenCalledTimes(1);

        resolveHealth({ status: 200 });
        await expect(first).resolves.toBe(true);
        await expect(second).resolves.toBe(true);

        mockClient.get.mockClear();
        await expect(ytMusicService.isAvailable()).resolves.toBe(true);
        expect(mockClient.get).not.toHaveBeenCalled();
    });

    it("builds restore payload only when both credentials are present", async () => {
        await ytMusicService.restoreOAuthWithCredentials(
            "u1",
            '{"token":"x"}',
            "client-id"
        );

        expect(mockClient.post).toHaveBeenCalledWith(
            "/auth/restore",
            { oauth_json: '{"token":"x"}' },
            { params: { user_id: "u1" } }
        );
    });

    it("maps canonical search items through fallback parsers", async () => {
        mockClient.post.mockResolvedValueOnce({
            data: {
                results: [
                    {
                        videoId: "v-hhmmss",
                        title: "Track One",
                        artists: [{ name: "Artist Via Object" }],
                        album: { name: "Album Via Name" },
                        duration: "1:02:03",
                        thumbnails: [{ url: "" }, { url: "https://img/a.jpg" }],
                    },
                    {
                        videoId: "v-mmss",
                        title: "Track Two",
                        artists: ["Artist Via String"],
                        album: "Album Via String",
                        duration: "03:45",
                    },
                    {
                        videoId: "v-unknown-artist",
                        title: "Track Three",
                        artists: [],
                        duration_seconds: 0,
                    },
                    null,
                ],
                total: Number.NaN,
            },
        });

        const result = await ytMusicService.searchCanonical("u1", "q");
        expect(result.total).toBe(3);
        expect(result.filter).toBeNull();

        expect(result.results[0]).toEqual(
            expect.objectContaining({
                providerTrackId: "v-hhmmss",
                artistName: "Artist Via Object",
                albumTitle: "Album Via Name",
                durationSec: 3723,
                thumbnailUrl: "https://img/a.jpg",
            })
        );
        expect(result.results[1]).toEqual(
            expect.objectContaining({
                providerTrackId: "v-mmss",
                artistName: "Artist Via String",
                albumTitle: "Album Via String",
                durationSec: 225,
            })
        );
        expect(result.results[2]).toEqual(
            expect.objectContaining({
                providerTrackId: "v-unknown-artist",
                artistName: "Unknown Artist",
                durationSec: null,
            })
        );
    });

    it("passes empty params/headers branches in stream and playlists calls", async () => {
        mockClient.get
            .mockResolvedValueOnce({ data: { ok: true } })
            .mockResolvedValueOnce({ data: { pipe: jest.fn() } })
            .mockResolvedValueOnce({ data: {} });

        await ytMusicService.getStreamInfo("u1", "video-id");
        expect(mockClient.get).toHaveBeenNthCalledWith(1, "/stream/video-id", {
            params: { user_id: "u1" },
        });

        await ytMusicService.getStreamProxy("u1", "video-id");
        expect(mockClient.get).toHaveBeenNthCalledWith(2, "/proxy/video-id", {
            params: { user_id: "u1" },
            headers: {},
            responseType: "stream",
            timeout: 120000,
        });

        await expect(ytMusicService.getLibraryPlaylists("u1")).resolves.toEqual([]);
        expect(mockClient.get).toHaveBeenNthCalledWith(3, "/library/playlists", {
            params: { user_id: "u1", limit: 25, mixes_only: false },
        });
    });

    it("retries batch search on ETIMEDOUT and then succeeds", async () => {
        jest.useFakeTimers();
        mockClient.post
            .mockRejectedValueOnce({ code: "ETIMEDOUT" })
            .mockResolvedValueOnce({
                data: {
                    results: [{ results: [{ videoId: "v1" }], total: 1, error: null }],
                },
            });

        const promise = ytMusicService.searchBatch("u1", [
            { query: "a", filter: "songs", limit: 3 },
        ]);

        await jest.advanceTimersByTimeAsync(2000);
        await expect(promise).resolves.toEqual([
            { results: [{ videoId: "v1" }], total: 1, error: null },
        ]);
        expect(logger.warn).toHaveBeenCalled();
    });

    it("uses fallback batch when first-pass rows are errors or empty", async () => {
        const tracks = [
            {
                artist: "Artist A",
                title: "Song A",
                albumTitle: "Album A",
                duration: 180,
            },
            {
                artist: "Artist B",
                title: "Song B",
                albumTitle: "Album B",
                duration: 200,
            },
        ];

        jest.spyOn(ytMusicService, "searchBatch")
            .mockResolvedValueOnce([
                { results: [{ videoId: "ignored" }], total: 1, error: "failed" },
                { results: [], total: 0, error: null },
            ])
            .mockResolvedValueOnce([
                {
                    results: [
                        {
                            videoId: "v-a",
                            title: "Song A",
                            artist: "Artist A",
                            duration_seconds: 181,
                            type: "song",
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
            ]);

        const matches = await ytMusicService.findMatchesForAlbum("u1", tracks);
        expect(matches).toEqual([
            { videoId: "v-a", title: "Song A", duration: 181 },
            null,
        ]);
    });
});
