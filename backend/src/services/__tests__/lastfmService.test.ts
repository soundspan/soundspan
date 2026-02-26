jest.mock("../../config", () => ({
    config: {
        lastfm: {
            apiKey: "test-lastfm-key",
        },
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(),
        setEx: jest.fn(),
    },
}));

jest.mock("../rateLimiter", () => ({
    rateLimiter: {
        execute: jest.fn(
            async (_bucket: string, requestFn: () => Promise<unknown>) =>
                requestFn()
        ),
    },
}));

jest.mock("../fanart", () => ({
    fanartService: {
        getArtistImage: jest.fn(),
    },
}));

jest.mock("../deezer", () => ({
    deezerService: {
        getArtistImage: jest.fn(),
        getArtistImageStrict: jest.fn(),
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

import { lastFmService } from "../lastfm";
import { redisClient } from "../../utils/redis";
import { rateLimiter } from "../rateLimiter";
import { getSystemSettings } from "../../utils/systemSettings";
import { fanartService } from "../fanart";
import { deezerService } from "../deezer";
import { logger } from "../../utils/logger";

const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;
const mockRateLimiterExecute = rateLimiter.execute as jest.Mock;
const mockGetSystemSettings = getSystemSettings as jest.Mock;
const mockFanartGetArtistImage = fanartService.getArtistImage as jest.Mock;
const mockDeezerGetArtistImage = deezerService.getArtistImage as jest.Mock;
const mockDeezerGetArtistImageStrict =
    deezerService.getArtistImageStrict as jest.Mock;
const mockLoggerDebug = logger.debug as jest.Mock;
const mockLoggerWarn = logger.warn as jest.Mock;
const mockLoggerError = logger.error as jest.Mock;

describe("lastFmService", () => {
    let mockHttpGet: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();

        mockHttpGet = jest.fn();

        const service = lastFmService as any;
        service.client = { get: mockHttpGet };
        service.apiKey = "test-lastfm-key";
        service.initialized = false;

        mockGetSystemSettings.mockResolvedValue({
            lastfmApiKey: null,
        });
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue("OK");
        mockRateLimiterExecute.mockImplementation(
            async (_bucket: string, requestFn: () => Promise<unknown>) =>
                requestFn()
        );
        mockFanartGetArtistImage.mockResolvedValue(null);
        mockDeezerGetArtistImage.mockResolvedValue(null);
        mockDeezerGetArtistImageStrict.mockResolvedValue(null);
    });

    it("returns cached similar artists without calling Last.fm", async () => {
        const cached = [
            {
                name: "Cached Artist",
                mbid: "cached-mbid",
                match: 0.77,
                url: "https://last.fm/music/cached",
            },
        ];

        mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));

        const result = await lastFmService.getSimilarArtists(
            "artist-mbid-1",
            "Artist One",
            10
        );

        expect(result).toEqual(cached);
        expect(mockHttpGet).not.toHaveBeenCalled();
        expect(mockRateLimiterExecute).not.toHaveBeenCalled();
    });

    it("falls back to name lookup when MBID lookup is not found", async () => {
        mockRedisGet.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

        mockHttpGet
            .mockRejectedValueOnce({
                response: {
                    status: 404,
                    data: { error: 6 },
                },
            })
            .mockResolvedValueOnce({
                data: {
                    similarartists: {
                        artist: [
                            {
                                name: "Fallback Artist",
                                mbid: "fallback-mbid",
                                match: "0.92",
                                url: "https://last.fm/music/fallback",
                            },
                        ],
                    },
                },
            });

        const result = await lastFmService.getSimilarArtists(
            "missing-mbid",
            "Fallback Name",
            5
        );

        expect(result).toEqual([
            {
                name: "Fallback Artist",
                mbid: "fallback-mbid",
                match: 0.92,
                url: "https://last.fm/music/fallback",
            },
        ]);
        expect(mockHttpGet).toHaveBeenNthCalledWith(1, "/", {
            params: expect.objectContaining({
                method: "artist.getSimilar",
                mbid: "missing-mbid",
                limit: 5,
                api_key: "test-lastfm-key",
            }),
        });
        expect(mockHttpGet).toHaveBeenNthCalledWith(2, "/", {
            params: expect.objectContaining({
                method: "artist.getSimilar",
                artist: "Fallback Name",
                limit: 5,
                api_key: "test-lastfm-key",
            }),
        });
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "lastfm:similar:name:fallback name:limit:5",
            604800,
            JSON.stringify(result)
        );
    });

    it("uses name lookup and cache keys when MBID is missing", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockResolvedValueOnce({
            data: {
                similarartists: {
                    artist: [
                        {
                            name: "Name Only Similar",
                            mbid: "name-only-mbid",
                            match: "0.73",
                            url: "https://last.fm/music/name-only-similar",
                        },
                    ],
                },
            },
        });

        const result = await lastFmService.getSimilarArtists(
            "",
            "Name Only Artist",
            7
        );

        expect(result).toEqual([
            {
                name: "Name Only Similar",
                mbid: "name-only-mbid",
                match: 0.73,
                url: "https://last.fm/music/name-only-similar",
            },
        ]);
        expect(mockHttpGet).toHaveBeenCalledTimes(1);
        expect(mockHttpGet).toHaveBeenCalledWith("/", {
            params: expect.objectContaining({
                method: "artist.getSimilar",
                artist: "Name Only Artist",
                limit: 7,
            }),
        });
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "lastfm:similar:name:name only artist:limit:7",
            604800,
            JSON.stringify(result)
        );
    });

    it("returns an empty array when similar artist lookup fails unexpectedly", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockRejectedValueOnce(new Error("network unavailable"));

        const result = await lastFmService.getSimilarArtists(
            "artist-mbid-2",
            "Broken Artist",
            4
        );

        expect(result).toEqual([]);
        expect(mockHttpGet).toHaveBeenCalledTimes(1);
    });

    it("retries album info with stripped edition title and normalizes array fields", async () => {
        mockRedisGet.mockResolvedValueOnce(null);

        const notFoundError = Object.assign(new Error("not found"), {
            response: {
                data: { error: 6 },
            },
        });

        mockHttpGet
            .mockRejectedValueOnce(notFoundError)
            .mockResolvedValueOnce({
                data: {
                    album: {
                        name: "In A Time Lapse",
                        image: {
                            "#text": "https://images.example/album.jpg",
                            size: "large",
                        },
                        tags: { tag: { name: "post-rock" } },
                        tracks: { track: { name: "Song A" } },
                    },
                },
            });

        const album = await lastFmService.getAlbumInfo(
            "Ludovico Einaudi",
            "In A Time Lapse (Deluxe Edition)"
        );

        expect(album).toMatchObject({
            name: "In A Time Lapse",
            image: [
                {
                    "#text": "https://images.example/album.jpg",
                    size: "large",
                },
            ],
            tags: { tag: [{ name: "post-rock" }] },
            tracks: { track: [{ name: "Song A" }] },
        });
        expect(mockHttpGet).toHaveBeenNthCalledWith(2, "/", {
            params: expect.objectContaining({
                method: "album.getInfo",
                artist: "Ludovico Einaudi",
                album: "In A Time Lapse",
                api_key: "test-lastfm-key",
            }),
        });
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "lastfm:album:Ludovico Einaudi:In A Time Lapse (Deluxe Edition)",
            2592000,
            expect.any(String)
        );
    });

    it("returns null for album info on non-not-found errors", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockRejectedValueOnce(new Error("timeout"));

        const album = await lastFmService.getAlbumInfo(
            "Artist",
            "Album (Deluxe Edition)"
        );

        expect(album).toBeNull();
        expect(mockHttpGet).toHaveBeenCalledTimes(1);
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("does not retry album lookup when stripped title cannot be shortened", async () => {
        mockRedisGet.mockResolvedValueOnce(null);

        const notFoundError = Object.assign(new Error("not found"), {
            response: {
                data: { error: 6 },
            },
        });
        mockHttpGet.mockRejectedValueOnce(notFoundError);

        const album = await lastFmService.getAlbumInfo("Artist", "X");

        expect(album).toBeNull();
        expect(mockHttpGet).toHaveBeenCalledTimes(1);
    });

    it("falls back to stripped album title and returns null when fallback payload is empty", async () => {
        mockRedisGet.mockResolvedValueOnce(null);

        const notFoundError = Object.assign(new Error("not found"), {
            response: {
                data: { error: 6 },
            },
        });
        mockHttpGet
            .mockRejectedValueOnce(notFoundError)
            .mockResolvedValueOnce({
                data: {},
            });

        const album = await lastFmService.getAlbumInfo(
            "Ludovico Einaudi",
            "In A Time Lapse (Deluxe Edition)"
        );

        expect(album).toBeNull();
        expect(mockHttpGet).toHaveBeenCalledTimes(2);
        expect(mockHttpGet).toHaveBeenNthCalledWith(2, "/", {
            params: expect.objectContaining({
                method: "album.getInfo",
                artist: "Ludovico Einaudi",
                album: "In A Time Lapse",
                api_key: "test-lastfm-key",
                format: "json",
            }),
        });
    });

    it("returns null when fallback album request also errors", async () => {
        mockRedisGet.mockResolvedValueOnce(null);

        const notFoundError = Object.assign(new Error("not found"), {
            response: {
                data: { error: 6 },
            },
        });
        mockHttpGet
            .mockRejectedValueOnce(notFoundError)
            .mockRejectedValueOnce(new Error("fallback failed"));

        const album = await lastFmService.getAlbumInfo(
            "Ludovico Einaudi",
            "In A Time Lapse (Deluxe Edition)"
        );

        expect(album).toBeNull();
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            expect.stringContaining("also not found")
        );
    });

    it("falls back to default API key when system settings lookup fails", async () => {
        mockGetSystemSettings.mockRejectedValueOnce(new Error("db unavailable"));
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockResolvedValueOnce({
            data: {
                similarartists: {
                    artist: [
                        {
                            name: "Recovered Artist",
                            mbid: "recovered-mbid",
                            match: "0.76",
                            url: "https://last.fm/music/recovered",
                        },
                    ],
                },
            },
        });

        const similar = await lastFmService.getSimilarArtists(
            "artist-mbid-fallback",
            "Recovered",
            3
        );

        expect(similar).toEqual([
            {
                name: "Recovered Artist",
                mbid: "recovered-mbid",
                match: 0.76,
                url: "https://last.fm/music/recovered",
            },
        ]);
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "Last.fm configured (default app key)"
        );
    });

    it("uses system-settings API key after explicit initialization", async () => {
        mockGetSystemSettings.mockResolvedValue({
            lastfmApiKey: "settings-key",
        });
        await (lastFmService as any).ensureInitialized();
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockResolvedValueOnce({
            data: {
                similarartists: {
                    artist: [
                        {
                            name: "Settings Artist",
                            mbid: "settings-artist",
                            match: "0.88",
                            url: "https://last.fm/music/settings",
                        },
                    ],
                },
            },
        });

        const similar = await lastFmService.getSimilarArtists("artist-settings", "Settings");

        expect(similar).toEqual([
            {
                name: "Settings Artist",
                mbid: "settings-artist",
                match: 0.88,
                url: "https://last.fm/music/settings",
            },
        ]);
        expect(mockHttpGet).toHaveBeenCalledWith(
            "/",
            expect.objectContaining({
                params: expect.objectContaining({
                    api_key: "settings-key",
                }),
            })
        );
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "Last.fm configured from user settings"
        );
    });

    it("returns null best image for invalid payloads and Last.fm placeholders", () => {
        expect((lastFmService as any).getBestImage(undefined)).toBeNull();
        expect(
            (lastFmService as any).getBestImage([
                {
                    size: "small",
                    "#text":
                        "https://userserve-ak.last.fm/serve/34s/2a96cbd8b46e442fc41c2b86b821562f.png",
                },
            ])
        ).toBeNull();
    });

    it("filters invalid artists and standalone singles during track search", async () => {
        mockHttpGet
            .mockResolvedValueOnce({
                data: {
                    results: {
                        trackmatches: {
                            track: [
                                {
                                    name: "Invalid Track",
                                    artist: "Unknown",
                                    listeners: "20",
                                    image: [],
                                    url: "https://last.fm/music/invalid",
                                },
                                {
                                    name: "Song One",
                                    artist: "Artist One",
                                    listeners: "100",
                                    image: [],
                                    url: "https://last.fm/music/song-one",
                                },
                                {
                                    name: "Single Song",
                                    artist: "Artist Two",
                                    listeners: "90",
                                    image: [],
                                    url: "https://last.fm/music/single-song",
                                },
                            ],
                        },
                    },
                },
            })
            .mockResolvedValueOnce({
                data: {
                    track: {
                        album: {
                            title: "Album One",
                            image: [],
                        },
                    },
                },
            })
            .mockResolvedValueOnce({
                data: {
                    track: {
                        album: {
                            title: "Single Song - Single",
                            image: [],
                        },
                    },
                },
            });

        mockDeezerGetArtistImage.mockResolvedValueOnce(
            "https://images.example/artist-one.jpg"
        );

        const tracks = await lastFmService.searchTracks("song", 20);

        expect(tracks).toEqual([
            expect.objectContaining({
                type: "track",
                name: "Song One",
                artist: "Artist One",
                album: "Album One",
                image: "https://images.example/artist-one.jpg",
            }),
        ]);
        expect(mockDeezerGetArtistImage).toHaveBeenCalledTimes(1);
        expect(mockDeezerGetArtistImage).toHaveBeenCalledWith("Artist One");
    });

    it("deduplicates artist results and only enriches the first five", async () => {
        mockHttpGet.mockResolvedValueOnce({
            data: {
                results: {
                    artistmatches: {
                        artist: [
                            {
                                name: "Muse",
                                mbid: "mbid-1",
                                listeners: "1000",
                                url: "https://last.fm/music/muse",
                                image: [],
                            },
                            {
                                name: "muse",
                                mbid: "",
                                listeners: "999",
                                url: "https://last.fm/music/muse-alt",
                                image: [],
                            },
                            {
                                name: "Muse UK",
                                mbid: "mbid-2",
                                listeners: "800",
                                url: "https://last.fm/music/muse-uk",
                                image: [],
                            },
                            {
                                name: "Muse Tribute",
                                mbid: "mbid-3",
                                listeners: "700",
                                url: "https://last.fm/music/muse-tribute",
                                image: [],
                            },
                            {
                                name: "Muse Live",
                                mbid: "mbid-4",
                                listeners: "600",
                                url: "https://last.fm/music/muse-live",
                                image: [],
                            },
                            {
                                name: "The Muse Experience",
                                mbid: "mbid-5",
                                listeners: "500",
                                url: "https://last.fm/music/the-muse-experience",
                                image: [],
                            },
                            {
                                name: "Muse Cover Band",
                                mbid: "mbid-6",
                                listeners: "400",
                                url: "https://last.fm/music/muse-cover-band",
                                image: [],
                            },
                            {
                                name: "Completely Different Artist",
                                mbid: "mbid-7",
                                listeners: "10000",
                                url: "https://last.fm/music/other",
                                image: [],
                            },
                        ],
                    },
                },
            },
        });

        const buildArtistSearchResultSpy = jest
            .spyOn(lastFmService as any, "buildArtistSearchResult")
            .mockImplementation(async (...args: unknown[]) => {
                const artist = args[0] as { name: string };
                const enrich = args[1] as boolean;
                return {
                    id: artist.name,
                    name: artist.name,
                    enrich,
                };
            });

        const artists = await lastFmService.searchArtists("Muse", 6);
        const enrichFlags = buildArtistSearchResultSpy.mock.calls.map(
            (call) => call[1]
        );

        expect(artists).toHaveLength(6);
        expect(enrichFlags).toEqual([true, true, true, true, true, false]);
        expect(buildArtistSearchResultSpy).toHaveBeenCalledTimes(6);
    });

    it("returns cached null sentinel for artist correction", async () => {
        mockRedisGet.mockResolvedValueOnce("null");

        const correction = await lastFmService.getArtistCorrection("no-match");

        expect(correction).toBeNull();
        expect(mockHttpGet).not.toHaveBeenCalled();
    });

    it("stores corrected artist names in cache", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockResolvedValueOnce({
            data: {
                corrections: {
                    correction: {
                        artist: {
                            name: "Björk",
                            mbid: "bjork-mbid",
                        },
                    },
                },
            },
        });

        const correction = await lastFmService.getArtistCorrection("bjork");

        expect(correction).toEqual({
            corrected: true,
            canonicalName: "Björk",
            mbid: "bjork-mbid",
        });
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "lastfm:correction:bjork",
            2592000,
            JSON.stringify(correction)
        );
    });

    it("caches null correction when Last.fm reports artist not found", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockRejectedValueOnce({
            response: {
                data: { error: 6 },
            },
        });

        const correction = await lastFmService.getArtistCorrection(
            "missing artist"
        );

        expect(correction).toBeNull();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "lastfm:correction:missing artist",
            2592000,
            "null"
        );
    });

    it("returns empty chart artists when no API key is configured", async () => {
        const service = lastFmService as any;
        service.initialized = true;
        service.apiKey = "";

        const artists = await lastFmService.getTopChartArtists(10);

        expect(artists).toEqual([]);
        expect(mockHttpGet).not.toHaveBeenCalled();
        expect(mockRedisGet).not.toHaveBeenCalled();
    });

    it("uses fanart, deezer, and Last.fm image fallbacks for top chart artists", async () => {
        mockRedisGet.mockResolvedValueOnce(null);

        mockHttpGet.mockResolvedValueOnce({
            data: {
                artists: {
                    artist: [
                        {
                            name: "Artist One",
                            mbid: "artist-one-mbid",
                            listeners: "100",
                            playcount: "200",
                            url: "https://last.fm/music/artist-one",
                            image: [],
                        },
                        {
                            name: "Artist Two",
                            mbid: "",
                            listeners: "50",
                            playcount: "80",
                            url: "https://last.fm/music/artist-two",
                            image: [
                                {
                                    size: "extralarge",
                                    "#text": "https://images.example/from-lastfm.jpg",
                                },
                            ],
                        },
                        {
                            name: "Artist Three",
                            mbid: "",
                            listeners: "20",
                            playcount: "30",
                            url: "https://last.fm/music/artist-three",
                            image: [
                                {
                                    size: "large",
                                    "#text": "https://lastfm-cdn/2a96cbd8b46e442fc41c2b86b821562f.png",
                                },
                            ],
                        },
                    ],
                },
            },
        });

        mockFanartGetArtistImage.mockRejectedValueOnce(new Error("fanart down"));
        mockDeezerGetArtistImage.mockImplementation(async (artistName: string) =>
            artistName === "Artist One"
                ? "https://images.example/from-deezer.jpg"
                : null
        );

        const artists = await lastFmService.getTopChartArtists(3);

        expect(artists).toEqual([
            expect.objectContaining({
                name: "Artist One",
                image: "https://images.example/from-deezer.jpg",
            }),
            expect.objectContaining({
                name: "Artist Two",
                image: "https://images.example/from-lastfm.jpg",
            }),
            expect.objectContaining({
                name: "Artist Three",
                image: null,
            }),
        ]);
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "lastfm:chart:artists:3",
            21600,
            JSON.stringify(artists)
        );
    });

    it("uses fanart image for top chart artists when available", async () => {
        mockRedisGet.mockResolvedValueOnce(null);

        mockHttpGet.mockResolvedValueOnce({
            data: {
                artists: {
                    artist: [
                        {
                            name: "Artist Fan",
                            mbid: "fan-artist-mbid",
                            listeners: "100",
                            playcount: "200",
                            url: "https://last.fm/music/fan-artist",
                            image: [],
                        },
                    ],
                },
            },
        });

        mockFanartGetArtistImage.mockResolvedValueOnce(
            "https://images.example/from-fanart.jpg"
        );

        const artists = await lastFmService.getTopChartArtists(1);

        expect(artists).toEqual([
            expect.objectContaining({
                name: "Artist Fan",
                image: "https://images.example/from-fanart.jpg",
            }),
        ]);
        expect(mockFanartGetArtistImage).toHaveBeenCalledWith("fan-artist-mbid");
        expect(mockDeezerGetArtistImage).not.toHaveBeenCalledWith("Artist Fan");
    });

    it("refreshes API key from system settings", async () => {
        const service = lastFmService as any;
        service.apiKey = "old-key";
        service.initialized = true;
        mockGetSystemSettings.mockResolvedValueOnce({
            lastfmApiKey: "fresh-key",
        });

        await lastFmService.refreshApiKey();

        expect(service.apiKey).toBe("fresh-key");
        expect(service.initialized).toBe(true);
    });

    it("warns when initialized without any API key", async () => {
        const service = lastFmService as any;
        service.apiKey = "";
        service.initialized = false;
        mockGetSystemSettings.mockResolvedValueOnce({
            lastfmApiKey: null,
        });

        await service.ensureInitialized();

        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Last.fm API key not available"
        );
    });

    it("returns cached top albums by tag", async () => {
        const cachedAlbums = [{ name: "Cached Album" }];
        mockRedisGet.mockResolvedValueOnce(JSON.stringify(cachedAlbums));

        const albums = await lastFmService.getTopAlbumsByTag("rock", 4);

        expect(albums).toEqual(cachedAlbums);
        expect(mockHttpGet).not.toHaveBeenCalled();
    });

    it("returns fetched top albums by tag even when redis set fails", async () => {
        const fetchedAlbums = [{ name: "Live Album" }];
        mockRedisGet.mockResolvedValueOnce(null);
        mockRedisSetEx.mockRejectedValueOnce(new Error("redis unavailable"));
        mockHttpGet.mockResolvedValueOnce({
            data: {
                albums: {
                    album: fetchedAlbums,
                },
            },
        });

        const albums = await lastFmService.getTopAlbumsByTag("post-rock", 6);

        expect(albums).toEqual(fetchedAlbums);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Redis set error:",
            expect.any(Error)
        );
    });

    it("returns empty array when similar tracks request fails", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockRejectedValueOnce(new Error("similar tracks down"));

        const tracks = await lastFmService.getSimilarTracks(
            "Artist",
            "Track",
            8
        );

        expect(tracks).toEqual([]);
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Last.fm similar tracks error for Track:",
            expect.any(Error)
        );
    });

    it("requests artist top tracks by MBID when available", async () => {
        const topTracks = [{ name: "Track One" }];
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockResolvedValueOnce({
            data: {
                toptracks: {
                    track: topTracks,
                },
            },
        });

        const tracks = await lastFmService.getArtistTopTracks(
            "mbid-artist",
            "Artist Name",
            3
        );

        expect(tracks).toEqual(topTracks);
        expect(mockHttpGet).toHaveBeenCalledWith("/", {
            params: expect.objectContaining({
                method: "artist.getTopTracks",
                mbid: "mbid-artist",
                limit: 3,
            }),
        });
    });

    it("requests artist top albums by name when MBID is missing", async () => {
        const topAlbums = [{ name: "Album One" }];
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockResolvedValueOnce({
            data: {
                topalbums: {
                    album: topAlbums,
                },
            },
        });

        const albums = await lastFmService.getArtistTopAlbums("", "Name Only", 2);

        expect(albums).toEqual(topAlbums);
        expect(mockHttpGet).toHaveBeenCalledWith("/", {
            params: expect.objectContaining({
                method: "artist.getTopAlbums",
                artist: "Name Only",
                limit: 2,
            }),
        });
    });

    it("normalizes artist info arrays from object payloads", async () => {
        mockHttpGet.mockResolvedValueOnce({
            data: {
                artist: {
                    name: "Artist",
                    image: { "#text": "https://img/artist.jpg", size: "large" },
                    tags: { tag: { name: "ambient" } },
                    similar: { artist: { name: "Similar Artist" } },
                },
            },
        });

        const info = await lastFmService.getArtistInfo("Artist");

        expect(info).toEqual(
            expect.objectContaining({
                image: [{ "#text": "https://img/artist.jpg", size: "large" }],
                tags: { tag: [{ name: "ambient" }] },
                similar: { artist: [{ name: "Similar Artist" }] },
            })
        );
    });

    it("returns null from getArtistInfo on request error", async () => {
        mockHttpGet.mockRejectedValueOnce(new Error("artist info down"));

        const info = await lastFmService.getArtistInfo("Broken Artist");

        expect(info).toBeNull();
    });

    it("returns undefined when artist info payload has no artist object", async () => {
        mockHttpGet.mockResolvedValueOnce({
            data: {},
        });

        const info = await lastFmService.getArtistInfo("Unknown Artist");

        expect(info).toBeUndefined();
    });

    it("extracts best image and rejects placeholders", () => {
        expect(lastFmService.getBestImage(null as unknown as any[])).toBeNull();
        expect(
            lastFmService.getBestImage([
                { size: "medium", "#text": "https://img/medium.jpg" },
            ])
        ).toBe("https://img/medium.jpg");
        expect(
            lastFmService.getBestImage([
                {
                    size: "small",
                    "#text": "https://lastfm-cdn/2a96cbd8b46e442fc41c2b86b821562f.png",
                },
            ])
        ).toBeNull();
    });

    it("caps and enriches only first three similar artists", async () => {
        const buildArtistSearchResultSpy = jest
            .spyOn(lastFmService as any, "buildArtistSearchResult")
            .mockImplementation(async (...args: unknown[]) => {
                const artist = args[0] as any;
                const enrich = args[1] as boolean;
                if (artist.name === "Drop") {
                    return null;
                }
                return { id: artist.name, enrich };
            });

        const results = await lastFmService.enrichSimilarArtists(
            [
                { name: "A", mbid: "a", match: 1, url: "u-a" },
                { name: "B", mbid: "b", match: 1, url: "u-b" },
                { name: "C", mbid: "c", match: 1, url: "u-c" },
                { name: "Drop", mbid: "d", match: 1, url: "u-d" },
                { name: "E", mbid: "e", match: 1, url: "u-e" },
            ],
            5
        );

        expect(buildArtistSearchResultSpy).toHaveBeenCalledTimes(5);
        expect(
            buildArtistSearchResultSpy.mock.calls.map((call) => call[1])
        ).toEqual([true, true, true, false, false]);
        expect(results).toEqual([
            { id: "A", enrich: true },
            { id: "B", enrich: true },
            { id: "C", enrich: true },
            { id: "E", enrich: false },
        ]);
    });

    it("returns null from track builder for invalid artists and standalone singles", async () => {
        const invalidTrack = await (lastFmService as any).buildTrackSearchResult(
            {
                name: "Song",
                artist: "Unknown",
                listeners: "5",
                image: [],
                url: "https://last.fm/music/unknown-song",
            },
            true
        );

        jest.spyOn(lastFmService, "getTrackInfo").mockResolvedValueOnce({
            album: {
                title: "Song - Single",
                image: [],
            },
        } as any);

        const standaloneTrack = await (lastFmService as any).buildTrackSearchResult(
            {
                name: "Song",
                artist: "Known Artist",
                listeners: "5",
                image: [],
                url: "https://last.fm/music/known-song",
            },
            true
        );

        expect(invalidTrack).toBeNull();
        expect(standaloneTrack).toBeNull();
    });

    it("handles short-word artist queries and maps results", async () => {
        mockHttpGet.mockResolvedValueOnce({
            data: {
                results: {
                    artistmatches: {
                        artist: [
                            {
                                name: "Ed",
                                mbid: "ed-mbid",
                                listeners: "900",
                                url: "https://last.fm/music/ed",
                                image: [],
                            },
                        ],
                    },
                },
            },
        });

        const buildArtistSearchResultSpy = jest
            .spyOn(lastFmService as any, "buildArtistSearchResult")
            .mockResolvedValue({ id: "Ed", name: "Ed" });

        const artists = await lastFmService.searchArtists("ed", 1);

        expect(artists).toEqual([{ id: "Ed", name: "Ed" }]);
        expect(buildArtistSearchResultSpy).toHaveBeenCalledWith(
            expect.objectContaining({ name: "Ed" }),
            true
        );
    });

    it("returns empty arrays for artist and track search request failures", async () => {
        mockHttpGet
            .mockRejectedValueOnce(new Error("artist search down"))
            .mockRejectedValueOnce(new Error("track search down"));

        await expect(lastFmService.searchArtists("failure case", 3)).resolves.toEqual(
            []
        );
        await expect(lastFmService.searchTracks("failure case", 3)).resolves.toEqual(
            []
        );
    });

    it("returns a base track result when enrichment is disabled", async () => {
        const getTrackInfoSpy = jest
            .spyOn(lastFmService as any, "getTrackInfo")
            .mockResolvedValue({} as any);

        const track = await (lastFmService as any).buildTrackSearchResult(
            {
                name: "Base Track",
                artist: "Base Artist",
                listeners: "12",
                mbid: "base-mbid",
                url: "https://last.fm/music/base-track",
                image: [
                    {
                        size: "large",
                        "#text": "https://images.example/base-track.jpg",
                    },
                ],
                album: "Album Name",
            },
            false
        );

        expect(track).toEqual({
            type: "track",
            id: "base-mbid",
            name: "Base Track",
            artist: "Base Artist",
            album: "Album Name",
            listeners: 12,
            url: "https://last.fm/music/base-track",
            image: "https://images.example/base-track.jpg",
            mbid: "base-mbid",
        });
        expect(getTrackInfoSpy).not.toHaveBeenCalled();
        getTrackInfoSpy.mockRestore();
    });

    it("returns top albums by tag and caches the response", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockResolvedValueOnce({
            data: {
                albums: {
                    album: [
                        {
                            name: "Top Jazz Album",
                            playcount: "42",
                        },
                    ],
                },
            },
        });

        const albums = await lastFmService.getTopAlbumsByTag("jazz", 5);

        expect(albums).toEqual([
            {
                name: "Top Jazz Album",
                playcount: "42",
            },
        ]);
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "lastfm:tag:albums:jazz",
            604800,
            JSON.stringify(albums)
        );
    });

    it("returns similar tracks and caches the response", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockResolvedValueOnce({
            data: {
                similartracks: {
                    track: [
                        {
                            name: "Related One",
                            artist: {
                                name: "Related Artist",
                            },
                            url: "https://last.fm/music/related",
                        },
                    ],
                },
            },
        });

        const tracks = await lastFmService.getSimilarTracks(
            "Artist",
            "Track",
            2
        );

        expect(tracks).toEqual([
            {
                name: "Related One",
                artist: {
                    name: "Related Artist",
                },
                url: "https://last.fm/music/related",
            },
        ]);
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "lastfm:similar:track:Artist:Track",
            604800,
            JSON.stringify(tracks)
        );
    });

    it("uses artist name parameters for top artists lookups when MBID is missing", async () => {
        mockRedisGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        mockHttpGet
            .mockResolvedValueOnce({
                data: {
                    toptracks: {
                        track: [{ name: "Top Track 1" }],
                    },
                },
            })
            .mockResolvedValueOnce({
                data: {
                    topalbums: {
                        album: [{ name: "Top Album 1" }],
                    },
                },
            });

        const topTracks = await lastFmService.getArtistTopTracks(
            "",
            "Unknown Artist",
            4
        );
        const topAlbums = await lastFmService.getArtistTopAlbums(
            "",
            "Unknown Artist",
            4
        );

        expect(topTracks).toEqual([{ name: "Top Track 1" }]);
        expect(topAlbums).toEqual([{ name: "Top Album 1" }]);
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "lastfm:toptracks:Unknown Artist",
            604800,
            JSON.stringify(topTracks)
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "lastfm:topalbums:Unknown Artist",
            604800,
            JSON.stringify(topAlbums)
        );
    });

    it("returns undefined when track info payload has no track object", async () => {
        mockHttpGet.mockResolvedValueOnce({
            data: {},
        });

        const info = await lastFmService.getTrackInfo("Artist", "Track");

        expect(info).toBeUndefined();
    });

    it("normalizes array fields in track info payloads", async () => {
        mockHttpGet.mockResolvedValueOnce({
            data: {
                track: {
                    name: "Test Track",
                    album: {
                        title: "Test Album",
                        image: { "#text": "https://img/album.jpg", size: "large" },
                    },
                    toptags: {
                        tag: { name: "ambient", count: "42" },
                    },
                },
            },
        });

        const info = await lastFmService.getTrackInfo("Artist", "Track");

        expect(info).toMatchObject({
            name: "Test Track",
            album: {
                title: "Test Album",
                image: [{ "#text": "https://img/album.jpg", size: "large" }],
            },
            toptags: {
                tag: [{ name: "ambient", count: "42" }],
            },
        });
    });

    it("returns null from getAlbumInfo when fallback album name is too short", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockRejectedValueOnce(
            Object.assign(new Error("not found"), {
                response: {
                    data: { error: 6 },
                },
            })
        );

        const album = await lastFmService.getAlbumInfo("Artist", "A");

        expect(album).toBeNull();
        expect(mockHttpGet).toHaveBeenCalledTimes(1);
    });

    it("returns null for track info request errors", async () => {
        mockHttpGet.mockRejectedValueOnce(new Error("track info down"));

        const info = await lastFmService.getTrackInfo("Artist", "Track");

        expect(info).toBeNull();
    });

    it("returns cached correction object without calling Last.fm", async () => {
        const cachedCorrection = {
            corrected: false,
            canonicalName: "Muse",
        };
        mockRedisGet.mockResolvedValueOnce(JSON.stringify(cachedCorrection));

        const correction = await lastFmService.getArtistCorrection("Muse");

        expect(correction).toEqual(cachedCorrection);
        expect(mockHttpGet).not.toHaveBeenCalled();
    });

    it("caches null correction when Last.fm returns no correction record", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockResolvedValueOnce({
            data: {
                corrections: {
                    correction: {
                        artist: null,
                    },
                },
            },
        });

        const correction = await lastFmService.getArtistCorrection("Unknown Name");

        expect(correction).toBeNull();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "lastfm:correction:unknown name",
            2592000,
            "null"
        );
    });

    it("caches null when correction request returns not-found error code", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockRejectedValueOnce({
            response: {
                data: { error: 6 },
            },
        });

        const correction = await lastFmService.getArtistCorrection("No Artist");

        expect(correction).toBeNull();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "lastfm:correction:no artist",
            2592000,
            "null"
        );
    });

    it("logs and returns null for non-404 correction errors", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockRejectedValueOnce({
            response: {
                data: {
                    error: 16,
                },
            },
        });

        const correction = await lastFmService.getArtistCorrection("Bad Artist");

        expect(correction).toBeNull();
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Last.fm correction error for Bad Artist:",
            expect.anything()
        );
    });

    it("returns cached top chart artists without network request", async () => {
        const service = lastFmService as any;
        service.initialized = true;
        service.apiKey = "present-key";
        const cachedArtists = [{ name: "Cached Chart Artist" }];
        mockRedisGet.mockResolvedValueOnce(JSON.stringify(cachedArtists));

        const artists = await lastFmService.getTopChartArtists(7);

        expect(artists).toEqual(cachedArtists);
        expect(mockHttpGet).not.toHaveBeenCalled();
    });

    it("returns empty top chart list on request failures after cache errors", async () => {
        const service = lastFmService as any;
        service.initialized = true;
        service.apiKey = "present-key";
        mockRedisGet.mockRejectedValueOnce(new Error("redis read failed"));
        mockHttpGet.mockRejectedValueOnce(new Error("lastfm chart failed"));

        const artists = await lastFmService.getTopChartArtists(5);

        expect(artists).toEqual([]);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Redis get error:",
            expect.any(Error)
        );
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Last.fm chart artists error:",
            expect.any(Error)
        );
    });

    it("falls back to deezer image when enriched track result lacks album art", async () => {
        mockDeezerGetArtistImage.mockResolvedValueOnce(
            "https://images.example/from-deezer.jpg"
        );
        const getTrackInfoSpy = jest
            .spyOn(lastFmService as any, "getTrackInfo")
            .mockResolvedValue({
                album: {
                    title: "Single Song",
                    image: [{ size: "small", "#text": "" }],
                },
            });

        const track = await (lastFmService as any).buildTrackSearchResult(
            {
                name: "Lost Track",
                artist: "Artist One",
                listeners: "10",
                image: [{ size: "small", "#text": "" }],
                url: "https://last.fm/music/lost-track",
            },
            true
        );

        expect(track).toEqual(
            expect.objectContaining({
                type: "track",
                name: "Lost Track",
                artist: "Artist One",
                image: "https://images.example/from-deezer.jpg",
            })
        );
        expect(mockDeezerGetArtistImage).toHaveBeenCalledWith("Artist One");
        getTrackInfoSpy.mockRestore();
    });

    it("returns tracks and warns when similar track cache write fails", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockRedisSetEx.mockRejectedValueOnce(new Error("cache set failed"));
        mockHttpGet.mockResolvedValueOnce({
            data: {
                similartracks: {
                    track: [{ name: "Related Track" }],
                },
            },
        });

        const tracks = await lastFmService.getSimilarTracks("Artist", "Track", 4);

        expect(tracks).toEqual([{ name: "Related Track" }]);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Redis set error:",
            expect.any(Error)
        );
    });

    it("handles top track cache read/write errors and still returns data", async () => {
        mockRedisGet.mockRejectedValueOnce(new Error("cache get failed"));
        mockRedisSetEx.mockRejectedValueOnce(new Error("cache set failed"));
        mockHttpGet.mockResolvedValueOnce({
            data: {
                toptracks: {
                    track: [{ name: "Top Track" }],
                },
            },
        });

        const tracks = await lastFmService.getArtistTopTracks(
            "mbid-artist",
            "Artist Name",
            3
        );

        expect(tracks).toEqual([{ name: "Top Track" }]);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Redis get error:",
            expect.any(Error)
        );
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Redis set error:",
            expect.any(Error)
        );
    });

    it("returns an empty list when top track lookup fails", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockRejectedValueOnce(new Error("top tracks failed"));

        const tracks = await lastFmService.getArtistTopTracks(
            "mbid-artist",
            "Artist Name",
            3
        );

        expect(tracks).toEqual([]);
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Last.fm top tracks error for Artist Name:",
            expect.any(Error)
        );
    });

    it("returns an empty list for artist top albums request failures", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockHttpGet.mockRejectedValueOnce(new Error("top albums failed"));

        const albums = await lastFmService.getArtistTopAlbums("", "Artist Name", 3);

        expect(albums).toEqual([]);
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Last.fm top albums error for Artist Name:",
            expect.any(Error)
        );
    });

    it("handles artist enrichment fallbacks and maps tag names", async () => {
        (lastFmService as any).buildArtistSearchResult?.mockRestore?.();
        mockFanartGetArtistImage.mockRejectedValueOnce(
            new Error("fanart failed")
        );
        const getArtistInfoSpy = jest
            .spyOn(lastFmService as any, "getArtistInfo")
            .mockResolvedValue({
                image: [],
                tags: { tag: [{ name: "ambient" }, { name: "instrumental" }] },
            } as any);
        mockDeezerGetArtistImageStrict.mockRejectedValueOnce(
            new Error("deezer strict failed")
        );

        const enriched = await (lastFmService as any).buildArtistSearchResult(
            {
                name: "Test Artist",
                mbid: "artist-mbid",
                listeners: "10",
                url: "https://last.fm/music/test",
                image: [],
            },
            true
        );

        expect(enriched).toEqual(
            expect.objectContaining({
                name: "Test Artist",
                image: null,
                tags: ["ambient", "instrumental"],
            })
        );
        expect(mockFanartGetArtistImage).toHaveBeenCalledWith("artist-mbid");
        expect(mockDeezerGetArtistImageStrict).toHaveBeenCalledWith("Test Artist");
        getArtistInfoSpy.mockRestore();
    });

    it("returns non-enriched track results after enrichment cutoff", async () => {
        mockHttpGet.mockResolvedValueOnce({
            data: {
                results: {
                    trackmatches: {
                        track: Array.from({ length: 9 }, (_, index) => ({
                            name: `Track ${index + 1}`,
                            artist: `Artist ${index + 1}`,
                            listeners: `${10 + index}`,
                            image: [],
                            url: `https://last.fm/music/track-${index + 1}`,
                        })),
                    },
                },
            },
        });
        const getTrackInfoSpy = jest
            .spyOn(lastFmService as any, "getTrackInfo")
            .mockResolvedValue({
                album: {
                    title: "Album",
                    image: [],
                },
            } as any);

        const tracks = await lastFmService.searchTracks("query", 20);

        expect(tracks).toHaveLength(9);
        expect(getTrackInfoSpy).toHaveBeenCalledTimes(8);
        expect(tracks[8]).toEqual(
            expect.objectContaining({
                name: "Track 9",
                artist: "Artist 9",
                album: null,
                image: null,
            })
        );
        getTrackInfoSpy.mockRestore();
    });

    it("recovers from cache misses for correction, chart writes, and duplicate checks", async () => {
        mockRedisGet.mockRejectedValueOnce(new Error("redis read failed"));
        const service = lastFmService as any;
        service.initialized = true;
        service.apiKey = "present-key";
        mockRedisSetEx
            .mockResolvedValueOnce("OK")
            .mockRejectedValueOnce(new Error("chart cache write failed"));
        mockHttpGet
            .mockResolvedValueOnce({
                data: {
                    corrections: {
                        correction: {
                            artist: {
                                name: "Canonical Artist",
                                mbid: "corr-mbid",
                            },
                        },
                    },
                },
            })
            .mockResolvedValueOnce({
                data: {
                    artists: {
                        artist: [],
                    },
                },
            })
            .mockResolvedValueOnce({
                data: {},
            });

        const correction = await lastFmService.getArtistCorrection("canon");
        const charts = await lastFmService.getTopChartArtists(3);
        const artistInfo = await lastFmService.getArtistInfo("Unknown", "missing-mbid");

        expect(correction).toEqual({
            corrected: true,
            canonicalName: "Canonical Artist",
            mbid: "corr-mbid",
        });
        expect(charts).toEqual([]);
        expect(artistInfo).toBeUndefined();
        expect((lastFmService as any).isDuplicateArtist([], { name: "" })).toBe(true);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Redis get error:",
            expect.any(Error)
        );
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Redis set error:",
            expect.any(Error)
        );
    });
    it("falls back to the default app key when system settings have no Last.fm key during initialization", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            lastfmApiKey: null,
        });
        mockRedisGet.mockResolvedValue(null);
        mockHttpGet.mockResolvedValueOnce({
            data: {
                similarartists: {
                    artist: [
                        {
                            name: "Env Artist",
                            mbid: "env-mbid",
                            match: "0.91",
                            url: "https://last.fm/music/env",
                        },
                    ],
                },
            },
        });

        const artists = await lastFmService.getSimilarArtists(
            "env-artist-mbid",
            "Env Artist",
            1
        );

        expect(artists).toEqual([
            {
                name: "Env Artist",
                mbid: "env-mbid",
                match: 0.91,
                url: "https://last.fm/music/env",
            },
        ]);
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "Last.fm configured (default app key)"
        );
    });

    it("re-reads API key settings on refresh and stays on default app key when settings are empty", async () => {
        mockGetSystemSettings
            .mockResolvedValueOnce({ lastfmApiKey: null })
            .mockResolvedValueOnce({ lastfmApiKey: null });

        const service = lastFmService as any;
        service.apiKey = "test-lastfm-key";
        service.initialized = false;

        await (lastFmService as any).ensureInitialized();
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "Last.fm configured (default app key)"
        );

        await (lastFmService as any).refreshApiKey();
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "Last.fm configured (default app key)"
        );

        mockRedisGet.mockResolvedValue(null);
        mockHttpGet.mockResolvedValue({
            data: {
                similarartists: {
                    artist: [
                        {
                            name: "Post-Refresh Artist",
                            mbid: "post-refresh-mbid",
                            match: "0.95",
                            url: "https://last.fm/music/post-refresh",
                        },
                    ],
                },
            },
        });

        const artists = await lastFmService.getSimilarArtists(
            "artist-mbid-refresh",
            "Post-Refresh Artist",
            1
        );

        expect(artists[0]?.name).toEqual("Post-Refresh Artist");
        expect(mockHttpGet).toHaveBeenCalledWith(
            "/",
            expect.objectContaining({
                params: expect.objectContaining({
                    api_key: "test-lastfm-key",
                }),
            })
        );
        expect(mockGetSystemSettings).toHaveBeenCalledTimes(2);
    });

    it("continues returning results when redis get and set both fail", async () => {
        mockRedisGet.mockRejectedValueOnce(new Error("redis get failed"));
        mockRedisSetEx.mockRejectedValueOnce(new Error("redis set failed"));
        mockHttpGet.mockResolvedValueOnce({
            data: {
                similarartists: {
                    artist: [
                        {
                            name: "Cache Resilient Artist",
                            mbid: "cache-mbid",
                            match: "0.84",
                            url: "https://last.fm/music/cache",
                        },
                    ],
                },
            },
        });

        const artists = await lastFmService.getSimilarArtists(
            "cache-resilient-mbid",
            "Cache Artist",
            1
        );

        expect(artists).toEqual([
            {
                name: "Cache Resilient Artist",
                mbid: "cache-mbid",
                match: 0.84,
                url: "https://last.fm/music/cache",
            },
        ]);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Redis get error:",
            expect.any(Error)
        );
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Redis set error:",
            expect.any(Error)
        );
    });

    it("filters and orders search artist candidates before enrichment", async () => {
        mockHttpGet.mockResolvedValueOnce({
            data: {
                results: {
                    artistmatches: {
                        artist: [
                            {
                                name: "The Something",
                                mbid: "",
                                listeners: "10",
                                url: "https://last.fm/music/the-something",
                            },
                            {
                                name: "Daft Punk",
                                mbid: "mbid-daft",
                                listeners: "12",
                                url: "https://last.fm/music/daft-punk",
                            },
                            {
                                name: "Daft Punk Tribute",
                                mbid: "",
                                listeners: "10",
                                url: "https://last.fm/music/daft-punk-tribute",
                            },
                            {
                                name: "Radiohead",
                                mbid: "mbid-radiohead",
                                listeners: "4",
                                url: "https://last.fm/music/radiohead",
                            },
                        ],
                    },
                },
            },
        });

        const buildArtistSearchResultSpy = jest
            .spyOn(lastFmService as any, "buildArtistSearchResult")
            .mockImplementation(async (artist: any) => ({
                name: artist.name,
                mbid: artist.mbid === undefined ? null : artist.mbid,
            }));

        const artists = await lastFmService.searchArtists("Daft Punk", 10);

        expect(buildArtistSearchResultSpy).toHaveBeenCalledTimes(2);
        expect(artists).toEqual([
            { name: "Daft Punk", mbid: "mbid-daft" },
            { name: "Daft Punk Tribute", mbid: "" },
        ]);
        expect(buildArtistSearchResultSpy).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ name: "Daft Punk" }),
            true
        );
        buildArtistSearchResultSpy.mockRestore();
    });

    it("falls back to Last.fm when similar artist cache payload is malformed", async () => {
        mockRedisGet.mockResolvedValueOnce("not-json");

        mockHttpGet.mockResolvedValueOnce({
            data: {
                similarartists: {
                    artist: [
                        {
                            name: "Recovered Similar",
                            mbid: "recovered-mbid",
                            match: "0.93",
                            url: "https://last.fm/music/recovered-similar",
                        },
                    ],
                },
            },
        });

        const similar = await lastFmService.getSimilarArtists(
            "artist-mbid-malformed",
            "Malformed Artist",
            3
        );

        expect(similar).toEqual([
            {
                name: "Recovered Similar",
                mbid: "recovered-mbid",
                match: 0.93,
                url: "https://last.fm/music/recovered-similar",
            },
        ]);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Redis get error:",
            expect.any(Error)
        );
    });

    it("continues to return name-based similar artists when name cache write fails", async () => {
        mockRedisGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);

        mockRedisSetEx.mockRejectedValueOnce(
            new Error("similar by name cache set failed")
        );

        mockHttpGet
            .mockRejectedValueOnce({
                response: {
                    status: 404,
                    data: { error: 6 },
                },
            })
            .mockResolvedValueOnce({
                data: {
                    similarartists: {
                        artist: [
                            {
                                name: "Recovered by Name",
                                mbid: "name-mbid",
                                match: "0.88",
                                url: "https://last.fm/music/recovered-by-name",
                            },
                        ],
                    },
                },
            });

        const similar = await lastFmService.getSimilarArtists(
            "artist-mbid-fallback-fail",
            "Fallback Fail",
            4
        );

        expect(similar).toEqual([
            {
                name: "Recovered by Name",
                mbid: "name-mbid",
                match: 0.88,
                url: "https://last.fm/music/recovered-by-name",
            },
        ]);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Redis set error:",
            expect.any(Error)
        );
    });

    it("falls back to Last.fm data when chart cache JSON is malformed", async () => {
        const service = lastFmService as any;
        service.initialized = true;
        service.apiKey = "present-key";

        mockRedisGet.mockResolvedValueOnce("not-json");
        mockFanartGetArtistImage.mockRejectedValueOnce(
            new Error("fanart unavailable")
        );

        mockHttpGet.mockResolvedValueOnce({
            data: {
                artists: {
                    artist: [
                        {
                            name: "Fallback Chart",
                            mbid: "fallback-chart-mbid",
                            listeners: "200",
                            playcount: "400",
                            url: "https://last.fm/music/fallback-chart",
                            image: [
                                {
                                    size: "large",
                                    "#text":
                                        "https://lastfm-cdn/2a96cbd8b46e442fc41c2b86b821562f.png",
                                },
                            ],
                        },
                    ],
                },
            },
        });

        const artists = await lastFmService.getTopChartArtists(4);

        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Redis get error:",
            expect.any(Error)
        );
        expect(artists).toEqual([
            {
                type: "music",
                id: "fallback-chart-mbid",
                name: "Fallback Chart",
                listeners: 200,
                playCount: 400,
                url: "https://last.fm/music/fallback-chart",
                image: null,
                mbid: "fallback-chart-mbid",
            },
        ]);
    });

    it("normalizes nullable album payload fields and still returns data when cache write fails", async () => {
        mockRedisGet.mockResolvedValueOnce(null);
        mockRedisSetEx.mockRejectedValueOnce(new Error("cache set failed"));

        mockHttpGet.mockResolvedValueOnce({
            data: {
                album: {
                    name: "Ambient Space",
                    image: null,
                    tags: null,
                    tracks: {
                        track: null,
                    },
                },
            },
        });

        const album = await lastFmService.getAlbumInfo("Artist", "Album");

        expect(album).toMatchObject({
            name: "Ambient Space",
            image: [],
            tags: null,
            tracks: {
                track: [],
            },
        });
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Redis set error:",
            expect.any(Error)
        );
    });

    it("returns all artist matches when query is blank by skipping string filters", async () => {
        mockHttpGet.mockResolvedValueOnce({
            data: {
                results: {
                    artistmatches: {
                        artist: [
                            {
                                name: "Alpha",
                                listeners: "10",
                                url: "https://last.fm/music/alpha",
                                image: [],
                            },
                            {
                                name: "Beta",
                                listeners: "30",
                                url: "https://last.fm/music/beta",
                                image: [],
                            },
                            {
                                name: "Gamma",
                                listeners: "20",
                                url: "https://last.fm/music/gamma",
                                image: [],
                            },
                        ],
                    },
                },
            },
        });

        const buildArtistSearchResultSpy = jest
            .spyOn(lastFmService as any, "buildArtistSearchResult")
            .mockImplementation(async (artist: any) => ({
                id: artist.name,
                name: artist.name,
            }));

        const artists = await lastFmService.searchArtists("   ", 10);

        expect(artists).toEqual([
            { id: "Beta", name: "Beta" },
            { id: "Gamma", name: "Gamma" },
            { id: "Alpha", name: "Alpha" },
        ]);
        expect(buildArtistSearchResultSpy).toHaveBeenCalledTimes(3);
        buildArtistSearchResultSpy.mockRestore();
    });

    it("returns a base track result when track info upstream lookup fails", async () => {
        mockHttpGet
            .mockResolvedValueOnce({
                data: {
                    results: {
                        trackmatches: {
                            track: [
                                {
                                    name: "Info Fail Track",
                                    artist: "Artist",
                                    listeners: "18",
                                    image: [
                                        {
                                            size: "medium",
                                            "#text":
                                                "https://images.example/info-fail-track.jpg",
                                        },
                                    ],
                                    url: "https://last.fm/music/info-fail-track",
                                },
                            ],
                        },
                    },
                },
            })
            .mockRejectedValueOnce(new Error("track info failed"));

        const tracks = await lastFmService.searchTracks("info fail", 5);

        expect(tracks).toEqual([
            {
                type: "track",
                id: "Artist-Info Fail Track",
                name: "Info Fail Track",
                artist: "Artist",
                album: null,
                listeners: 18,
                url: "https://last.fm/music/info-fail-track",
                image: "https://images.example/info-fail-track.jpg",
                mbid: undefined,
            },
        ]);
    });

    it("returns a safe track result when track image enrichment throws", async () => {
        mockHttpGet
            .mockResolvedValueOnce({
                data: {
                    results: {
                        trackmatches: {
                            track: [
                                {
                                    name: "Image Fail Track",
                                    artist: "Artist",
                                    listeners: "7",
                                    image: [],
                                    url: "https://last.fm/music/image-fail-track",
                                },
                            ],
                        },
                    },
                },
            })
            .mockResolvedValueOnce({
                data: {
                    track: {
                        album: {
                            title: "Enriched Album",
                            image: [],
                        },
                    },
                },
            });

        mockDeezerGetArtistImage.mockRejectedValueOnce(
            new Error("artist image lookup failed")
        );

        const tracks = await lastFmService.searchTracks("image fail", 5);

        expect(tracks).toEqual([
            {
                type: "track",
                id: "Artist-Image Fail Track",
                name: "Image Fail Track",
                artist: "Artist",
                album: "Enriched Album",
                listeners: 7,
                url: "https://last.fm/music/image-fail-track",
                image: null,
                mbid: undefined,
            },
        ]);
    });
});
