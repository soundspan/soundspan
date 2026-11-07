jest.mock("../../config", () => ({
    config: { lastfm: { apiKey: "test-lastfm-key" } },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(async () => ({ lastfmApiKey: null })),
}));

jest.mock("../../utils/redis", () => ({
    redisClient: { get: jest.fn(), setEx: jest.fn() },
}));

jest.mock("../rateLimiter", () => ({
    rateLimiter: {
        execute: jest.fn(
            async (_bucket: string, requestFn: () => Promise<unknown>) =>
                requestFn(),
        ),
    },
}));

jest.mock("../fanart", () => ({
    fanartService: { getArtistImage: jest.fn() },
}));

jest.mock("../deezer", () => ({
    deezerService: { getArtistImage: jest.fn() },
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

import { lastFmService } from "../lastfm";
import { redisClient } from "../../utils/redis";
import { fanartService } from "../fanart";
import { deezerService } from "../deezer";

const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;
const mockFanart = fanartService.getArtistImage as jest.Mock;
const mockDeezer = deezerService.getArtistImage as jest.Mock;

describe("lastFmService discovery lists", () => {
    let mockHttpGet: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockHttpGet = jest.fn();
        const service = lastFmService as any;
        service.client = { get: mockHttpGet };
        service.envApiKey = "test-lastfm-key";
        service.apiKey = "test-lastfm-key";
        service.initialized = false;
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue("OK");
    });

    it("fetches and caches global top tracks", async () => {
        const tracks = [
            { name: "Song", artist: { name: "Band" }, listeners: "10" },
        ];
        mockHttpGet.mockResolvedValueOnce({
            data: { tracks: { track: tracks } },
        });

        await expect(lastFmService.getTopChartTracks(5)).resolves.toEqual(
            tracks,
        );

        expect(mockHttpGet).toHaveBeenCalledWith("/", {
            params: expect.objectContaining({
                method: "chart.getTopTracks",
                limit: 5,
                format: "json",
                api_key: "test-lastfm-key",
            }),
        });
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "lastfm:chart:tracks:5",
            21600,
            JSON.stringify(tracks),
        );
    });

    it("serves cached top tags without calling Last.fm", async () => {
        mockRedisGet.mockResolvedValueOnce(JSON.stringify([{ name: "rock" }]));

        await expect(lastFmService.getTopChartTags(3)).resolves.toEqual([
            { name: "rock" },
        ]);
        expect(mockHttpGet).not.toHaveBeenCalled();
    });

    it("normalizes the tag and wraps a single artist into a list", async () => {
        mockHttpGet.mockResolvedValueOnce({
            data: { topartists: { artist: { name: "Solo" } } },
        });

        await expect(
            lastFmService.getTopArtistsByTag("  Shoegaze ", 4),
        ).resolves.toEqual([{ name: "Solo" }]);
        expect(mockHttpGet.mock.calls[0][1].params).toEqual(
            expect.objectContaining({
                method: "tag.getTopArtists",
                tag: "shoegaze",
            }),
        );
        expect(mockRedisSetEx.mock.calls[0][0]).toBe(
            "lastfm:tag:artists:shoegaze:4",
        );
    });

    it("returns an empty list for a blank tag or a failed request", async () => {
        await expect(lastFmService.getTopArtistsByTag("  ")).resolves.toEqual(
            [],
        );
        mockHttpGet.mockRejectedValueOnce(new Error("boom"));
        await expect(lastFmService.getTopChartTags()).resolves.toEqual([]);
    });

    it("returns an empty list without an API key", async () => {
        const service = lastFmService as any;
        service.envApiKey = "";
        service.apiKey = "";
        service.initialized = true;

        await expect(lastFmService.getTopChartTracks()).resolves.toEqual([]);
        expect(mockHttpGet).not.toHaveBeenCalled();
    });

    it("resolves artist images from Fanart, then Deezer, then Last.fm", async () => {
        mockFanart.mockResolvedValueOnce("fanart.jpg");
        await expect(
            lastFmService.resolveArtistImage("A", "mbid-a"),
        ).resolves.toBe("fanart.jpg");

        mockDeezer.mockResolvedValueOnce("deezer.jpg");
        await expect(lastFmService.resolveArtistImage("B")).resolves.toBe(
            "deezer.jpg",
        );
        expect(mockFanart).toHaveBeenCalledTimes(1);

        mockDeezer.mockResolvedValueOnce(null);
        await expect(
            lastFmService.resolveArtistImage("C", undefined, [
                { "#text": "https://lastfm/real.png", size: "extralarge" },
            ]),
        ).resolves.toBe("https://lastfm/real.png");

        mockDeezer.mockRejectedValueOnce(new Error("down"));
        await expect(
            lastFmService.resolveArtistImage("D", undefined, [
                {
                    "#text":
                        "https://lastfm/2a96cbd8b46e442fc41c2b86b821562f.png",
                    size: "extralarge",
                },
            ]),
        ).resolves.toBeNull();
    });
});
