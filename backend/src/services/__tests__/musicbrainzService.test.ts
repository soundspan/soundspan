import axios from "axios";
import { musicBrainzService } from "../musicbrainz";
import { logger } from "../../utils/logger";
import { redisClient } from "../../utils/redis";
import { rateLimiter } from "../rateLimiter";

jest.mock("axios");

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(),
        setEx: jest.fn(),
        del: jest.fn(),
        keys: jest.fn(),
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

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const mockAxiosCreate = axios.create as jest.Mock;
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;
const mockRedisDel = redisClient.del as jest.Mock;
const mockRedisKeys = redisClient.keys as jest.Mock;
const mockRateLimiterExecute = rateLimiter.execute as jest.Mock;
const mockLoggerWarn = logger.warn as jest.Mock;
const mockLoggerError = logger.error as jest.Mock;

describe("musicBrainzService", () => {
    let mockHttpGet: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();

        mockHttpGet = jest.fn(() => {
            throw new Error("Unexpected HTTP call");
        });

        mockAxiosCreate.mockReturnValue({ get: mockHttpGet });
        (musicBrainzService as any).client = { get: mockHttpGet };

        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue("OK");
        mockRedisDel.mockResolvedValue(1);
        mockRedisKeys.mockResolvedValue([]);
        mockRateLimiterExecute.mockImplementation(
            async (_bucket: string, requestFn: () => Promise<unknown>) =>
                requestFn()
        );
    });

    it("returns cached artist search results without touching HTTP/rate limiter", async () => {
        const cached = [{ id: "artist-1", name: "Cached Artist" }];
        mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));

        const result = await musicBrainzService.searchArtist("Cached Artist", 3);

        expect(result).toEqual(cached);
        expect(mockRateLimiterExecute).not.toHaveBeenCalled();
        expect(mockHttpGet).not.toHaveBeenCalled();
    });

    it("executes uncached artist search and stores it in Redis", async () => {
        const artists = [{ id: "artist-2", name: "Radiohead" }];
        mockHttpGet.mockResolvedValueOnce({ data: { artists } });

        const result = await musicBrainzService.searchArtist("Radiohead", 5);

        expect(result).toEqual(artists);
        expect(mockRateLimiterExecute).toHaveBeenCalledWith(
            "musicbrainz",
            expect.any(Function)
        );
        expect(mockHttpGet).toHaveBeenCalledWith("/artist", {
            params: {
                query: "Radiohead",
                limit: 5,
                fmt: "json",
            },
        });
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "mb:search:artist:Radiohead:5",
            2592000,
            JSON.stringify(artists)
        );
    });

    it("returns fallback [] on non-404 artist lookup failures and short-caches fallback", async () => {
        mockRateLimiterExecute.mockRejectedValueOnce(new Error("upstream timeout"));

        const result = await musicBrainzService.searchArtist("Broken Artist", 8);

        expect(result).toEqual([]);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            '[MusicBrainz] Request failed for key "mb:search:artist:Broken Artist:8": upstream timeout'
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "mb:search:artist:Broken Artist:8",
            120,
            JSON.stringify([])
        );
    });

    it("rethrows 404 artist lookup failures instead of using fallback", async () => {
        const notFoundError = Object.assign(new Error("not found"), {
            response: { status: 404 },
        });
        mockRateLimiterExecute.mockRejectedValueOnce(notFoundError);

        await expect(
            musicBrainzService.searchArtist("Missing Artist", 5)
        ).rejects.toBe(notFoundError);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            '[MusicBrainz] Request failed for key "mb:search:artist:Missing Artist:5": not found'
        );
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("continues when Redis get fails and still serves fresh data", async () => {
        mockRedisGet.mockRejectedValueOnce(new Error("redis read failed"));
        mockHttpGet.mockResolvedValueOnce({
            data: { artists: [{ id: "artist-3", name: "Fresh Artist" }] },
        });

        const result = await musicBrainzService.searchArtist("Fresh Artist");

        expect(result).toEqual([{ id: "artist-3", name: "Fresh Artist" }]);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Redis get error:",
            expect.any(Error)
        );
    });

    it("trims/escapes release-group search inputs and caches results", async () => {
        const releaseGroups = [{ id: "rg-1", title: "Album Name" }];
        mockHttpGet.mockResolvedValueOnce({
            data: { "release-groups": releaseGroups },
        });

        const result = await musicBrainzService.searchReleaseGroups(
            "  A+B  ",
            "  AC/DC  ",
            5
        );

        expect(result).toEqual(releaseGroups);
        expect(mockHttpGet).toHaveBeenCalledWith("/release-group", {
            params: {
                query: 'releasegroup:"A\\+B" AND artist:"AC\\/DC"',
                limit: 5,
                fmt: "json",
            },
        });
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "mb:search:release-group:A+B:AC/DC:5",
            2592000,
            JSON.stringify(releaseGroups)
        );
    });

    it("caches successful null responses with 1-hour TTL", async () => {
        mockHttpGet.mockResolvedValueOnce({ data: null });

        const result = await musicBrainzService.getArtist("artist-null");

        expect(result).toBeNull();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "mb:artist:artist-null:url-rels,tags",
            3600,
            "null"
        );
    });

    it("returns fallback null for non-404 getArtist errors and short-caches fallback", async () => {
        mockRateLimiterExecute.mockRejectedValueOnce(new Error("network down"));

        const result = await musicBrainzService.getArtist("artist-broken");

        expect(result).toBeNull();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "mb:artist:artist-broken:url-rels,tags",
            120,
            "null"
        );
    });

    it("rethrows 404 getArtist errors even when fallback null exists", async () => {
        const notFoundError = Object.assign(new Error("not found"), {
            response: { status: 404 },
        });
        mockRateLimiterExecute.mockRejectedValueOnce(notFoundError);

        await expect(musicBrainzService.getArtist("artist-404")).rejects.toBe(
            notFoundError
        );
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("returns fallback [] when Redis fallback cache write fails", async () => {
        const upstreamError = new Error("upstream timeout");
        const fallbackWriteError = new Error("redis set failure");

        mockRateLimiterExecute.mockRejectedValueOnce(upstreamError);
        mockRedisSetEx.mockRejectedValueOnce(fallbackWriteError);

        const result = await musicBrainzService.searchArtist(
            "Erroring Artist",
            4
        );

        expect(result).toEqual([]);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            '[MusicBrainz] Request failed for key "mb:search:artist:Erroring Artist:4": upstream timeout'
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "mb:search:artist:Erroring Artist:4",
            120,
            JSON.stringify([])
        );
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Redis set fallback error:",
            expect.any(Error)
        );
    });

    it("rethrows from cachedRequest when no fallback value is configured", async () => {
        const upstreamError = new Error("search request failed");
        mockRateLimiterExecute.mockRejectedValueOnce(upstreamError);

        await expect(
            musicBrainzService.searchAlbum("Uncached Album", "Some Artist")
        ).rejects.toBe(upstreamError);
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("maps release-group/release wrapper methods to expected API params", async () => {
        mockHttpGet
            .mockResolvedValueOnce({ data: { "release-groups": [{ id: "rg-a" }] } })
            .mockResolvedValueOnce({ data: { id: "rg-detail" } })
            .mockResolvedValueOnce({ data: { id: "rg-details" } })
            .mockResolvedValueOnce({ data: { id: "release-detail" } });

        const groups = await musicBrainzService.getReleaseGroups(
            "artist-mbid",
            ["album", "single"],
            25
        );
        const group = await musicBrainzService.getReleaseGroup("rg-1");
        const details = await musicBrainzService.getReleaseGroupDetails("rg-1");
        const release = await musicBrainzService.getRelease("rel-1");

        expect(groups).toEqual([{ id: "rg-a" }]);
        expect(group).toEqual({ id: "rg-detail" });
        expect(details).toEqual({ id: "rg-details" });
        expect(release).toEqual({ id: "release-detail" });
        expect(mockHttpGet).toHaveBeenNthCalledWith(1, "/release-group", {
            params: {
                artist: "artist-mbid",
                type: "album|single",
                limit: 25,
                fmt: "json",
            },
        });
        expect(mockHttpGet).toHaveBeenNthCalledWith(2, "/release-group/rg-1", {
            params: {
                inc: "artist-credits+releases",
                fmt: "json",
            },
        });
        expect(mockHttpGet).toHaveBeenNthCalledWith(3, "/release-group/rg-1", {
            params: {
                inc: "artist-credits+releases+labels",
                fmt: "json",
            },
        });
        expect(mockHttpGet).toHaveBeenNthCalledWith(4, "/release/rel-1", {
            params: {
                inc: "recordings+artist-credits+labels",
                fmt: "json",
            },
        });
    });

    it("returns first-hit result from searchAlbum strategy 1", async () => {
        mockHttpGet.mockResolvedValueOnce({
            data: {
                "release-groups": [{ id: "rg-first", title: "Kid A" }],
            },
        });

        const result = await musicBrainzService.searchAlbum("Kid A", "Radiohead");

        expect(result).toEqual({ id: "rg-first", title: "Kid A" });
        expect(mockHttpGet).toHaveBeenCalledTimes(1);
        expect(mockHttpGet).toHaveBeenCalledWith("/release-group", {
            params: {
                query: 'releasegroup:"Kid A" AND artist:"Radiohead"',
                limit: 5,
                fmt: "json",
            },
        });
    });

    it("falls through searchAlbum strategy 1 error and succeeds with normalized strategy 2", async () => {
        mockHttpGet
            .mockRejectedValueOnce(new Error("strategy-1 failed"))
            .mockResolvedValueOnce({
                data: {
                    "release-groups": [{ id: "rg-norm", title: "Album" }],
                },
            });

        const result = await musicBrainzService.searchAlbum(
            "Album - 2011 Remaster",
            "The Artist"
        );

        expect(result).toEqual({ id: "rg-norm", title: "Album" });
        expect(mockHttpGet).toHaveBeenNthCalledWith(1, "/release-group", {
            params: {
                query: 'releasegroup:"Album \\- 2011 Remaster" AND artist:"The Artist"',
                limit: 5,
                fmt: "json",
            },
        });
        expect(mockHttpGet).toHaveBeenNthCalledWith(2, "/release-group", {
            params: {
                query: 'releasegroup:"Album" AND artist:"The Artist"',
                limit: 5,
                fmt: "json",
            },
        });
    });

    it("returns null from searchAlbum when all strategies miss and caches null with short TTL", async () => {
        mockHttpGet
            .mockResolvedValueOnce({ data: { "release-groups": [] } })
            .mockResolvedValueOnce({ data: { "release-groups": [] } })
            .mockResolvedValueOnce({
                data: {
                    "release-groups": [
                        {
                            id: "rg-nope",
                            title: "Wrong Album",
                            "artist-credit": [{ name: "Unrelated Artist" }],
                        },
                    ],
                },
            });

        const result = await musicBrainzService.searchAlbum(
            "Album - 2011 Remaster",
            "Some Artist"
        );

        expect(result).toBeNull();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "mb:search:album:Some Artist:Album - 2011 Remaster",
            3600,
            "null"
        );
    });

    it("returns best studio-album match from searchRecording", async () => {
        mockHttpGet.mockResolvedValueOnce({
            data: {
                recordings: [
                    {
                        id: "track-1",
                        title: "Song A",
                        "artist-credit": [
                            {
                                name: "Artist One",
                                artist: { id: "artist-1", name: "Artist One" },
                            },
                        ],
                        releases: [
                            {
                                status: "Official",
                                "release-group": {
                                    id: "rg-live",
                                    title: "Live at 2018",
                                    "primary-type": "Album",
                                    "secondary-types": ["Live"],
                                },
                            },
                            {
                                status: "Official",
                                "release-group": {
                                    id: "rg-main",
                                    title: "Main Album",
                                    "primary-type": "Album",
                                    "secondary-types": [],
                                },
                            },
                        ],
                    },
                ],
            },
        });

        const result = await musicBrainzService.searchRecording(
            "Song A",
            "Artist One"
        );

        expect(result).toEqual({
            albumName: "Main Album",
            albumMbid: "rg-main",
            artistMbid: "artist-1",
            trackMbid: "track-1",
        });
    });

    it("uses fuzzy recording search when all initial results are filtered out", async () => {
        mockHttpGet
            .mockResolvedValueOnce({
                data: {
                    recordings: [
                        {
                            id: "live-1",
                            disambiguation: "live, 2001-01-01",
                        },
                    ],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    recordings: [
                        {
                            id: "track-fuzzy",
                            "artist-credit": [
                                {
                                    name: "Alpha",
                                    artist: { id: "artist-2", name: "Alpha Beta" },
                                },
                            ],
                            releases: [
                                {
                                    status: "Official",
                                    "release-group": {
                                        id: "rg-fuzzy",
                                        title: "Fuzzy Album",
                                        "primary-type": "Album",
                                        "secondary-types": [],
                                    },
                                },
                            ],
                        },
                    ],
                },
            });

        const result = await musicBrainzService.searchRecording(
            "Rare Song",
            "Alpha Beta"
        );

        expect(result).toEqual({
            albumName: "Fuzzy Album",
            albumMbid: "rg-fuzzy",
            artistMbid: "artist-2",
            trackMbid: "track-fuzzy",
        });
        expect(mockHttpGet).toHaveBeenCalledTimes(2);
    });

    it("uses punctuation-stripped fallback for recordings like title??", async () => {
        mockHttpGet
            .mockResolvedValueOnce({ data: { recordings: [] } })
            .mockResolvedValueOnce({
                data: {
                    recordings: [
                        {
                            id: "track-no-match",
                            "artist-credit": [{ name: "Not The Artist" }],
                            releases: [],
                        },
                    ],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    recordings: [
                        {
                            id: "track-strip",
                            "artist-credit": [
                                {
                                    name: "The Flaming Lips",
                                    artist: {
                                        id: "artist-strip",
                                        name: "The Flaming Lips",
                                    },
                                },
                            ],
                            releases: [
                                {
                                    status: "Official",
                                    "release-group": {
                                        id: "rg-strip",
                                        title: "Yoshimi Battles the Pink Robots",
                                        "primary-type": "Album",
                                        "secondary-types": [],
                                    },
                                },
                            ],
                        },
                    ],
                },
            });

        const result = await musicBrainzService.searchRecording(
            "Do You Realize??",
            "The Flaming Lips"
        );

        expect(result).toEqual({
            albumName: "Yoshimi Battles the Pink Robots",
            albumMbid: "rg-strip",
            artistMbid: "artist-strip",
            trackMbid: "track-strip",
        });
        expect(mockHttpGet).toHaveBeenNthCalledWith(3, "/recording", {
            params: {
                query: "Do You Realize AND artist:The Flaming Lips",
                limit: 10,
                fmt: "json",
                inc: "releases+release-groups+artists",
            },
        });
    });

    it("falls back to singles/EPs when no album passes strict scoring", async () => {
        mockHttpGet.mockResolvedValueOnce({
            data: {
                recordings: [
                    {
                        id: "track-single",
                        "artist-credit": [
                            {
                                name: "Solo Artist",
                                artist: { id: "solo-1", name: "Solo Artist" },
                            },
                        ],
                        releases: [
                            {
                                status: "Official",
                                "release-group": {
                                    id: "rg-single",
                                    title: "Single Release",
                                    "primary-type": "Single",
                                    "secondary-types": [],
                                },
                            },
                        ],
                    },
                ],
            },
        });

        const result = await musicBrainzService.searchRecording(
            "Single Song",
            "Solo Artist"
        );

        expect(result).toEqual({
            albumName: "Single Release",
            albumMbid: "rg-single",
            artistMbid: "solo-1",
            trackMbid: "track-single",
        });
    });

    it("returns null when recording search throws, without throwing to callers", async () => {
        mockHttpGet.mockRejectedValueOnce(new Error("recording lookup failed"));

        const result = await musicBrainzService.searchRecording(
            "Broken Song",
            "Broken Artist"
        );

        expect(result).toBeNull();
        expect(mockLoggerError).toHaveBeenCalledWith(
            "MusicBrainz recording search error:",
            "recording lookup failed"
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "mb:search:recording:Broken Artist:Broken Song",
            3600,
            "null"
        );
    });

    it("extractPrimaryArtist handles missing, name, and nested artist name paths", () => {
        expect(musicBrainzService.extractPrimaryArtist([])).toBe(
            "Unknown Artist"
        );
        expect(
            musicBrainzService.extractPrimaryArtist([{ name: "Top Name" }])
        ).toBe("Top Name");
        expect(
            musicBrainzService.extractPrimaryArtist([
                { artist: { name: "Nested Name" } },
            ])
        ).toBe("Nested Name");
    });

    it("returns null from extractAlbumFromRecording when the highest scoring release has no release-group id", () => {
        const service = musicBrainzService as any;

        const result = service.extractAlbumFromRecording({
            id: "track-missing-id",
            "artist-credit": [
                { artist: { id: "artist-1", name: "Artist Name" } },
            ],
            releases: [
                {
                    status: "Official",
                    "release-group": {
                        title: "Missing MBID Album",
                        "primary-type": "Album",
                        "secondary-types": [],
                    },
                },
            ],
        });

        expect(result).toBeNull();
    });

    it("returns null from extractAlbumFromRecording when release primary type is unknown", () => {
        const service = musicBrainzService as any;

        const result = service.extractAlbumFromRecording({
            id: "track-unknown-primary",
            "artist-credit": [
                { artist: { id: "artist-1", name: "Artist Name" } },
            ],
            releases: [
                {
                    status: "Official",
                    "release-group": {
                        id: "rg-unknown",
                        title: "Unknown Primary Type",
                        "primary-type": "Broadcast",
                        "secondary-types": [],
                    },
                },
            ],
        });

        expect(result).toBeNull();
    });

    it("returns null from extractAlbumFromRecording when secondary-type penalties drop score below threshold", () => {
        const service = musicBrainzService as any;

        const result = service.extractAlbumFromRecording({
            id: "track-secondary-penalty",
            "artist-credit": [{ artist: { id: "artist-2", name: "Artist Name" } }],
            releases: [
                {
                    status: "Official",
                    "release-group": {
                        id: "rg-live",
                        title: "Live Sessions",
                        "primary-type": "Album",
                        "secondary-types": ["Live"],
                    },
                },
            ],
        });

        expect(result).toBeNull();
    });

    it("returns null from extractAlbumFromRecording when title penalties dominate album scoring", () => {
        const service = musicBrainzService as any;

        const result = service.extractAlbumFromRecording({
            id: "track-title-penalty",
            "artist-credit": [{ artist: { id: "artist-3", name: "Artist Name" } }],
            releases: [
                {
                    status: "Official",
                    "release-group": {
                        id: "rg-best-of",
                        title: "Greatest Hits",
                        "primary-type": "Album",
                        "secondary-types": [],
                    },
                },
            ],
        });

        expect(result).toBeNull();
    });

    it("requires strict album threshold and allows singles only when allowSingles is true", () => {
        const service = musicBrainzService as any;

        const recording = {
            id: "track-single",
            "artist-credit": [
                { artist: { id: "artist-2", name: "Artist Name" } },
            ],
            releases: [
                {
                    status: "Official",
                    "release-group": {
                        id: "rg-single",
                        title: "Single Hit",
                        "primary-type": "Single",
                        "secondary-types": [],
                    },
                },
            ],
        };

        expect(service.extractAlbumFromRecording(recording)).toBeNull();
        expect(service.extractAlbumFromRecording(recording, true)).toEqual({
            albumName: "Single Hit",
            albumMbid: "rg-single",
            artistMbid: "artist-2",
            trackMbid: "track-single",
        });
    });

    it("returns null from searchRecording when best-scoring candidate has no release-group MBID and no candidate passes thresholds", async () => {
        mockHttpGet.mockResolvedValueOnce({
            data: {
                recordings: [
                    {
                        id: "track-missing-id",
                        "artist-credit": [
                            {
                                artist: {
                                    id: "artist-4",
                                    name: "Artist Name",
                                },
                            },
                        ],
                        releases: [
                            {
                                status: "Official",
                                "release-group": {
                                    title: "Official Album Without MBID",
                                    "primary-type": "Album",
                                    "secondary-types": [],
                                },
                            },
                            {
                                status: "Official",
                                "release-group": {
                                    id: "rg-weak",
                                    title: "Unknown Release Type",
                                    "primary-type": "Broadcast",
                                    "secondary-types": ["Compilation"],
                                },
                            },
                        ],
                    },
                ],
            },
        });

        const result = await musicBrainzService.searchRecording(
            "Some Track",
            "Artist Name"
        );

        expect(result).toBeNull();
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "mb:search:recording:Artist Name:Some Track",
            3600,
            "null"
        );
    });

    it("clears single recording cache entries and handles Redis failures", async () => {
        const success = await musicBrainzService.clearRecordingCache(
            "Track",
            "Artist"
        );
        expect(success).toBe(true);
        expect(mockRedisDel).toHaveBeenCalledWith("mb:search:recording:Artist:Track");

        mockRedisDel.mockRejectedValueOnce(new Error("redis del failed"));
        const failed = await musicBrainzService.clearRecordingCache(
            "Track 2",
            "Artist 2"
        );
        expect(failed).toBe(false);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Redis del error:",
            expect.any(Error)
        );
    });

    it("clears stale null recording caches and counts removed keys", async () => {
        mockRedisKeys.mockResolvedValueOnce([
            "mb:search:recording:a",
            "mb:search:recording:b",
            "mb:search:recording:c",
        ]);
        mockRedisGet
            .mockResolvedValueOnce("null")
            .mockResolvedValueOnce('{"ok":true}')
            .mockResolvedValueOnce("null");

        const cleared = await musicBrainzService.clearStaleRecordingCaches();

        expect(cleared).toBe(2);
        expect(mockRedisDel).toHaveBeenCalledTimes(2);
        expect(mockRedisDel).toHaveBeenNthCalledWith(1, "mb:search:recording:a");
        expect(mockRedisDel).toHaveBeenNthCalledWith(2, "mb:search:recording:c");
    });

    it("returns 0 when clearing stale recording caches fails", async () => {
        mockRedisKeys.mockRejectedValueOnce(new Error("scan failed"));

        const cleared = await musicBrainzService.clearStaleRecordingCaches();

        expect(cleared).toBe(0);
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Error clearing stale caches:",
            expect.any(Error)
        );
    });

    it("collects album tracks from the first official release", async () => {
        mockHttpGet
            .mockResolvedValueOnce({
                data: {
                    releases: [
                        { id: "bootleg-1", status: "Bootleg" },
                        { id: "official-1", status: "Official" },
                    ],
                },
            })
            .mockResolvedValueOnce({
                data: {
                    media: [
                        {
                            tracks: [
                                {
                                    title: "Track 1",
                                    position: 1,
                                    length: 180000,
                                },
                                {
                                    recording: {
                                        title: "Track 2",
                                        length: 200000,
                                    },
                                    position: 2,
                                },
                            ],
                        },
                    ],
                },
            });

        const result = await musicBrainzService.getAlbumTracks("rg-tracks");

        expect(result).toEqual([
            { title: "Track 1", position: 1, duration: 180000 },
            { title: "Track 2", position: 2, duration: 200000 },
        ]);
        expect(mockHttpGet).toHaveBeenNthCalledWith(
            1,
            "/release-group/rg-tracks",
            {
                params: {
                    inc: "releases",
                    fmt: "json",
                },
            }
        );
        expect(mockHttpGet).toHaveBeenNthCalledWith(2, "/release/official-1", {
            params: {
                inc: "recordings",
                fmt: "json",
            },
        });
    });

    it("returns [] for albums with no releases and on getAlbumTracks errors", async () => {
        mockHttpGet.mockResolvedValueOnce({ data: { releases: [] } });

        const noReleaseTracks = await musicBrainzService.getAlbumTracks(
            "rg-empty"
        );
        expect(noReleaseTracks).toEqual([]);

        mockHttpGet.mockRejectedValueOnce(new Error("album tracks failed"));
        const errorTracks = await musicBrainzService.getAlbumTracks("rg-error");
        expect(errorTracks).toEqual([]);
        expect(mockLoggerError).toHaveBeenCalledWith(
            "MusicBrainz getAlbumTracks error: album tracks failed"
        );
    });

    it("retries request when cached JSON is malformed and still returns fresh data", async () => {
        mockRedisGet.mockResolvedValueOnce("{bad-json");
        mockHttpGet.mockResolvedValueOnce({
            data: { artists: [{ id: "artist-4", name: "Sanitized Artist" }] },
        });

        const result = await musicBrainzService.searchArtist("Malformed Cache");

        expect(result).toEqual([{ id: "artist-4", name: "Sanitized Artist" }]);
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "Redis get error:",
            expect.any(Error)
        );
        expect(mockRateLimiterExecute).toHaveBeenCalledWith(
            "musicbrainz",
            expect.any(Function)
        );
    });

    it("rethrows errors when no fallback value exists in cachedRequest", async () => {
        const noFallbackError = new Error("no fallback path");

        await expect(
            (musicBrainzService as any).cachedRequest(
                "mb:no-fallback:unit",
                async () => {
                    throw noFallbackError;
                }
            )
        ).rejects.toBe(noFallbackError);

        expect(mockLoggerWarn).toHaveBeenCalledWith(
            `[MusicBrainz] Request failed for key "mb:no-fallback:unit": ${noFallbackError.message}`
        );
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("skips normalized strategy when album search inputs are already normalized", async () => {
        mockHttpGet
            .mockResolvedValueOnce({ data: { "release-groups": [] } })
            .mockResolvedValueOnce({
                data: {
                    "release-groups": [
                        {
                            id: "rg-fallback",
                            title: "Fuzzy Album",
                            "artist-credit": [{ name: "Artist" }],
                        },
                    ],
                },
            });

        const result = await musicBrainzService.searchAlbum("Album", "Artist");

        expect(result).toEqual({ id: "rg-fallback", title: "Fuzzy Album" });
        expect(mockHttpGet).toHaveBeenCalledTimes(2);
        expect(mockHttpGet).toHaveBeenNthCalledWith(2, "/release-group", {
            params: {
                query: "Album AND artist:Artist",
                limit: 10,
                fmt: "json",
            },
        });
    });

    it("ignores non-null stale recording caches when clearing stale entries", async () => {
        mockRedisKeys.mockResolvedValueOnce(["mb:search:recording:new"]);
        mockRedisGet.mockResolvedValueOnce(JSON.stringify({ not: "null" }));

        const cleared = await musicBrainzService.clearStaleRecordingCaches();

        expect(cleared).toBe(0);
        expect(mockRedisDel).not.toHaveBeenCalled();
        expect(mockLoggerError).not.toHaveBeenCalled();
    });
});
