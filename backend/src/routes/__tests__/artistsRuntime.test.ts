import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: Request, _res: Response, next: () => void) =>
        next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {},
}));

const deezerService = {
    getTrackPreview: jest.fn(),
    getArtistImage: jest.fn(),
    getAlbumCover: jest.fn(),
};

jest.mock("../../services/deezer", () => ({
    deezerService,
}));

const musicBrainzService = {
    searchArtist: jest.fn(),
    getArtist: jest.fn(),
    getReleaseGroups: jest.fn(),
    getReleaseGroup: jest.fn(),
    getRelease: jest.fn(),
};

jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService,
}));

const lastFmService = {
    getArtistInfo: jest.fn(),
    getArtistTopTracks: jest.fn(),
    getBestImage: jest.fn(),
    getAlbumInfo: jest.fn(),
};

jest.mock("../../services/lastfm", () => ({
    lastFmService,
}));

const fanartService = {
    getArtistImage: jest.fn(),
};

jest.mock("../../services/fanart", () => ({
    fanartService,
}));

const redisClient = {
    get: jest.fn(),
    setEx: jest.fn(),
};

jest.mock("../../utils/redis", () => ({
    redisClient,
}));

import router from "../artists";
import { logger } from "../../utils/logger";

const mockLoggerError = logger.error as jest.Mock;

const mockGetTrackPreview = deezerService.getTrackPreview as jest.Mock;
const mockGetArtistImage = deezerService.getArtistImage as jest.Mock;
const mockGetAlbumCover = deezerService.getAlbumCover as jest.Mock;

const mockSearchArtist = musicBrainzService.searchArtist as jest.Mock;
const mockGetArtist = musicBrainzService.getArtist as jest.Mock;
const mockGetReleaseGroups = musicBrainzService.getReleaseGroups as jest.Mock;
const mockGetReleaseGroup = musicBrainzService.getReleaseGroup as jest.Mock;
const mockGetRelease = musicBrainzService.getRelease as jest.Mock;

const mockGetArtistInfo = lastFmService.getArtistInfo as jest.Mock;
const mockGetArtistTopTracks = lastFmService.getArtistTopTracks as jest.Mock;
const mockGetBestImage = lastFmService.getBestImage as jest.Mock;
const mockGetAlbumInfo = lastFmService.getAlbumInfo as jest.Mock;

const mockFanartArtistImage = fanartService.getArtistImage as jest.Mock;

const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;

const fetchMock = jest.fn();
const originalFetch = (global as any).fetch;

function getGetHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.get
    );

    if (!layer) {
        throw new Error(`GET route not found: ${path}`);
    }

    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
    };

    return res;
}

describe("artists routes runtime", () => {
    const getPreview = getGetHandler("/preview/:artistName/:trackTitle");
    const getDiscover = getGetHandler("/discover/:nameOrMbid");
    const getAlbum = getGetHandler("/album/:mbid");

    beforeAll(() => {
        (global as any).fetch = fetchMock;
    });

    afterAll(() => {
        (global as any).fetch = originalFetch;
    });

    beforeEach(() => {
        jest.clearAllMocks();

        mockGetTrackPreview.mockResolvedValue(null);
        mockGetArtistImage.mockResolvedValue(null);
        mockGetAlbumCover.mockResolvedValue(null);

        mockSearchArtist.mockResolvedValue([]);
        mockGetArtist.mockResolvedValue(null);
        mockGetReleaseGroups.mockResolvedValue([]);
        mockGetReleaseGroup.mockResolvedValue(null);
        mockGetRelease.mockResolvedValue(null);

        mockGetArtistInfo.mockResolvedValue({
            bio: null,
            image: [],
            stats: { listeners: "0", playcount: "0" },
            tags: { tag: [] },
            similar: { artist: [] },
        });
        mockGetArtistTopTracks.mockResolvedValue([]);
        mockGetBestImage.mockReturnValue(null);
        mockGetAlbumInfo.mockResolvedValue(null);

        mockFanartArtistImage.mockResolvedValue(null);

        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue("OK");

        fetchMock.mockResolvedValue({ ok: true });
    });

    it("returns preview URL for /preview when Deezer has one", async () => {
        mockGetTrackPreview.mockResolvedValueOnce(
            "https://cdn.example/previews/back-in-black.mp3"
        );

        const req = {
            params: {
                artistName: encodeURIComponent("AC/DC"),
                trackTitle: encodeURIComponent("Back In Black"),
            },
        } as any;
        const res = createRes();

        await getPreview(req, res);

        expect(mockGetTrackPreview).toHaveBeenCalledWith(
            "AC/DC",
            "Back In Black"
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            previewUrl: "https://cdn.example/previews/back-in-black.mp3",
        });
    });

    it("returns 404 for /preview when Deezer has no preview", async () => {
        mockGetTrackPreview.mockResolvedValueOnce(null);

        const req = {
            params: {
                artistName: encodeURIComponent("No Artist"),
                trackTitle: encodeURIComponent("No Track"),
            },
        } as any;
        const res = createRes();

        await getPreview(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Preview not found" });
    });

    it("returns 500 for /preview errors", async () => {
        mockGetTrackPreview.mockRejectedValueOnce(new Error("deezer unavailable"));

        const req = {
            params: {
                artistName: encodeURIComponent("Artist"),
                trackTitle: encodeURIComponent("Track"),
            },
        } as any;
        const res = createRes();

        await getPreview(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to fetch preview",
            message: "deezer unavailable",
        });
        expect(mockLoggerError).toHaveBeenCalled();
    });

    it("returns cached payload for /discover cache-hit path", async () => {
        const cachedPayload = {
            mbid: "cached-mbid",
            name: "Cached Artist",
            albums: [],
            topTracks: [],
            similarArtists: [],
        };
        mockRedisGet.mockResolvedValueOnce(JSON.stringify(cachedPayload));

        const req = {
            params: { nameOrMbid: "cached-artist" },
            query: {
                includeDiscography: "false",
                includeTopTracks: "off",
                includeSimilarArtists: "0",
            },
        } as any;
        const res = createRes();

        await getDiscover(req, res);

        expect(mockRedisGet).toHaveBeenCalledWith(
            "discovery:artist:cached-artist:disc:0:top:0:sim:0"
        );
        expect(mockGetArtistInfo).not.toHaveBeenCalled();
        expect(mockSearchArtist).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(cachedPayload);
    });

    it("continues when /discover cache lookup fails", async () => {
        mockRedisGet.mockRejectedValueOnce(new Error("cache unavailable"));
        mockSearchArtist.mockResolvedValueOnce([
            { id: "fallback-mbid", name: "Recovery Artist" },
        ]);

        const req = {
            params: { nameOrMbid: encodeURIComponent("Recovery Artist") },
            query: {
                includeDiscography: "0",
                includeTopTracks: "0",
                includeSimilarArtists: "0",
            },
        } as any;
        const res = createRes();

        await getDiscover(req, res);

        expect(mockSearchArtist).toHaveBeenCalledWith("Recovery Artist", 1);
        expect(mockGetArtist).not.toHaveBeenCalled();
        expect(mockGetArtistInfo).toHaveBeenCalledWith("Recovery Artist", "fallback-mbid");
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                mbid: "fallback-mbid",
                name: "Recovery Artist",
                topTracks: [],
                similarArtists: [],
                albums: [],
            })
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "discovery:artist:Recovery%20Artist:disc:0:top:0:sim:0",
            24 * 60 * 60,
            expect.any(String)
        );
    });

    it("returns 404 when MBID-only discover cannot resolve artist name", async () => {
        const mbid = "11111111-1111-1111-1111-111111111111";
        mockGetArtist.mockRejectedValueOnce(new Error("not found"));

        const req = {
            params: { nameOrMbid: mbid },
            query: {
                includeDiscography: "0",
                includeTopTracks: "0",
                includeSimilarArtists: "0",
            },
        } as any;
        const res = createRes();

        await getDiscover(req, res);

        expect(mockGetArtist).toHaveBeenCalledWith(mbid);
        expect(mockGetArtistInfo).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Artist not found" });
    });

    it("returns empty top tracks when /discover top tracks lookup fails", async () => {
        const mbid = "22222222-2222-2222-2222-222222222222";
        mockGetArtist.mockResolvedValueOnce({ name: "Top Tracks Fail" });
        mockGetArtistTopTracks.mockRejectedValueOnce(new Error("top-tracks timeout"));

        const req = {
            params: { nameOrMbid: mbid },
            query: {
                includeDiscography: "0",
                includeTopTracks: "1",
                includeSimilarArtists: "0",
            },
        } as any;
        const res = createRes();

        await getDiscover(req, res);

        expect(mockGetArtist).toHaveBeenCalledWith(mbid);
        expect(mockGetArtistTopTracks).toHaveBeenCalledWith(mbid, "Top Tracks Fail", 10);
        expect(res.statusCode).toBe(200);
        expect(res.body.topTracks).toEqual([]);
    });

    it("builds /discover payload with query parsing, bio filtering, image fallbacks, and cache write", async () => {
        mockSearchArtist.mockResolvedValueOnce([
            { id: "artist-mbid-1", name: "Resolved Artist" },
        ]);

        mockGetArtistInfo.mockResolvedValueOnce({
            bio: {
                summary: "There are multiple artists with the name Resolved Artist.",
            },
            image: [
                {
                    size: "large",
                    " #text": "https://last.fm/images/resolved-artist.jpg",
                },
            ],
            stats: {
                listeners: "1234",
                playcount: "5678",
            },
            tags: {
                tag: [{ name: "alt-rock" }, { name: "indie" }],
            },
            similar: {
                artist: [
                    {
                        name: "Similar One",
                        mbid: "sim-1",
                        url: "https://last.fm/sim-1",
                        image: [
                            {
                                size: "large",
                                " #text": "https://last.fm/images/sim-1.jpg",
                            },
                        ],
                    },
                    {
                        name: "Similar Two",
                        mbid: "",
                        url: "https://last.fm/sim-2",
                        image: [
                            {
                                size: "large",
                                " #text": "https://last.fm/images/sim-2.jpg",
                            },
                        ],
                    },
                ],
            },
            url: "https://last.fm/resolved-artist",
        });

        mockGetBestImage.mockReturnValueOnce(
            "https://last.fm/images/resolved-artist.jpg"
        );

        mockGetArtistTopTracks.mockResolvedValueOnce([
            {
                name: "Hit Song",
                playcount: "42",
                listeners: "10",
                duration: "250",
                url: "https://last.fm/track/hit-song",
                album: { "#text": "Hit Album" },
            },
        ]);

        mockFanartArtistImage.mockImplementation(async (_mbid: string) => null);

        mockGetArtistImage.mockImplementation(async (artistName: string) => {
            if (artistName === "Similar Two") {
                return "https://deezer/images/sim-2.jpg";
            }
            return null;
        });

        mockGetReleaseGroups.mockResolvedValueOnce([
            {
                id: "rg-older",
                title: "Older Album",
                "primary-type": "Album",
                "secondary-types": [],
                "first-release-date": "2000-03-01",
            },
            {
                id: "rg-live",
                title: "Live Album",
                "primary-type": "Album",
                "secondary-types": ["Live"],
                "first-release-date": "2001-01-01",
            },
            {
                id: "rg-newer",
                title: "Newer EP",
                "primary-type": "EP",
                "secondary-types": [],
                "first-release-date": "2012-10-20",
            },
        ]);

        fetchMock.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });

        mockGetAlbumCover.mockResolvedValueOnce("https://deezer/covers/older.jpg");

        const req = {
            params: { nameOrMbid: encodeURIComponent("The Artist") },
            query: {
                includeDiscography: "yes",
                includeTopTracks: "1",
                includeSimilarArtists: "on",
            },
        } as any;
        const res = createRes();

        await getDiscover(req, res);

        expect(mockSearchArtist).toHaveBeenCalledWith("The Artist", 1);
        expect(mockGetArtistTopTracks).toHaveBeenCalledWith(
            "artist-mbid-1",
            "Resolved Artist",
            10
        );
        expect(mockGetReleaseGroups).toHaveBeenCalledWith("artist-mbid-1");

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                mbid: "artist-mbid-1",
                name: "Resolved Artist",
                bio: null,
                summary: null,
                image: "https://last.fm/images/resolved-artist.jpg",
                tags: ["alt-rock", "indie"],
                genres: ["alt-rock", "indie"],
                listeners: 1234,
                playcount: 5678,
            })
        );

        expect(res.body.topTracks).toEqual([
            expect.objectContaining({
                id: "lastfm-artist-mbid-1-Hit Song",
                title: "Hit Song",
                playCount: 42,
                listeners: 10,
                duration: 250,
            }),
        ]);

        expect(res.body.albums).toHaveLength(2);
        expect(res.body.albums[0]).toEqual(
            expect.objectContaining({
                rgMbid: "rg-newer",
                year: 2012,
                owned: false,
            })
        );

        const olderAlbum = res.body.albums.find(
            (album: any) => album.rgMbid === "rg-older"
        );
        expect(olderAlbum).toEqual(
            expect.objectContaining({
                coverUrl: "https://deezer/covers/older.jpg",
                year: 2000,
            })
        );

        expect(res.body.similarArtists).toEqual([
            expect.objectContaining({
                name: "Similar One",
                image: "https://last.fm/images/sim-1.jpg",
            }),
            expect.objectContaining({
                name: "Similar Two",
                image: "https://deezer/images/sim-2.jpg",
            }),
        ]);

        expect(mockRedisSetEx).toHaveBeenCalledTimes(1);
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "discovery:artist:The%20Artist:disc:1:top:1:sim:1",
            24 * 60 * 60,
            expect.any(String)
        );

        const cachedJson = mockRedisSetEx.mock.calls[0][2] as string;
        expect(JSON.parse(cachedJson)).toEqual(
            expect.objectContaining({
                name: "Resolved Artist",
                bio: null,
            })
        );
    });

    it("parses false-like /discover include flags and skips optional sections", async () => {
        const mbid = "11111111-1111-1111-1111-111111111111";
        mockGetArtist.mockResolvedValueOnce({ name: "MBID Artist" });

        mockGetArtistInfo.mockResolvedValueOnce({
            bio: { summary: "Regular biography." },
            stats: { listeners: "9", playcount: "12" },
            tags: { tag: [{ name: "electronic" }] },
            similar: { artist: [{ name: "Should Not Render" }] },
        });

        const req = {
            params: { nameOrMbid: mbid },
            query: {
                includeDiscography: "0",
                includeTopTracks: "no",
                includeSimilarArtists: "off",
            },
        } as any;
        const res = createRes();

        await getDiscover(req, res);

        expect(mockRedisGet).toHaveBeenCalledWith(
            `discovery:artist:${mbid}:disc:0:top:0:sim:0`
        );
        expect(mockSearchArtist).not.toHaveBeenCalled();
        expect(mockGetArtist).toHaveBeenCalledWith(mbid);
        expect(mockGetArtistTopTracks).not.toHaveBeenCalled();
        expect(mockGetReleaseGroups).not.toHaveBeenCalled();

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                mbid,
                name: "MBID Artist",
                albums: [],
                topTracks: [],
                similarArtists: [],
            })
        );

        expect(mockRedisSetEx).toHaveBeenCalledWith(
            `discovery:artist:${mbid}:disc:0:top:0:sim:0`,
            24 * 60 * 60,
            expect.any(String)
        );
    });

    it("builds /album payload via release-group path with includeTracks=true", async () => {
        mockGetReleaseGroup.mockResolvedValueOnce({
            id: "rg-123",
            title: "Release Group Album",
            "primary-type": "Album",
            "first-release-date": "2015-08-01",
            "artist-credit": [
                {
                    name: "RG Artist",
                    artist: { id: "artist-123" },
                },
            ],
            releases: [{ id: "release-1" }],
        });

        mockGetRelease.mockResolvedValueOnce({
            id: "release-1",
            media: [
                {
                    position: 1,
                    tracks: [
                        {
                            id: "track-1",
                            title: "Song One",
                            position: 1,
                            length: 181000,
                        },
                    ],
                },
                {
                    position: 2,
                    tracks: [
                        {
                            id: "track-2",
                            title: "Song Two",
                            position: 3,
                            length: 202000,
                        },
                    ],
                },
            ],
        });

        mockGetAlbumInfo.mockResolvedValueOnce({
            wiki: { summary: "Album wiki summary" },
            tags: { tag: { name: "electronic" } },
        });

        fetchMock.mockResolvedValueOnce({ ok: false });
        mockGetAlbumCover.mockResolvedValueOnce("https://deezer/covers/rg-123.jpg");

        const req = {
            params: { mbid: "rg-123" },
            query: { includeTracks: "true" },
        } as any;
        const res = createRes();

        await getAlbum(req, res);

        expect(mockGetReleaseGroup).toHaveBeenCalledWith("rg-123");
        expect(mockGetRelease).toHaveBeenCalledWith("release-1");

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "rg-123",
                rgMbid: "rg-123",
                mbid: "rg-123",
                releaseMbid: null,
                title: "Release Group Album",
                year: 2015,
                type: "Album",
                coverUrl: "https://deezer/covers/rg-123.jpg",
                coverArt: "https://deezer/covers/rg-123.jpg",
                bio: "Album wiki summary",
                tags: ["electronic"],
            })
        );

        expect(res.body.tracks).toEqual([
            expect.objectContaining({
                title: "Song One",
                trackNo: 1,
                discNo: 1,
                duration: 181,
            }),
            expect.objectContaining({
                title: "Song Two",
                trackNo: 3,
                discNo: 2,
                duration: 202,
            }),
        ]);

        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "discovery:album:rg-123:tracks:1",
            24 * 60 * 60,
            expect.any(String)
        );
    });

    it("falls back to release lookup for /album and honors includeTracks=false", async () => {
        mockGetReleaseGroup
            .mockRejectedValueOnce({ response: { status: 404 } })
            .mockResolvedValueOnce({
                id: "rg-fallback-9",
                title: "Fallback Album",
                "primary-type": "EP",
                "first-release-date": "2018-04-10",
                "artist-credit": [
                    {
                        name: "Fallback Artist",
                        artist: { id: "artist-fallback" },
                    },
                ],
            });

        mockGetRelease.mockResolvedValueOnce({
            id: "release-mbid-9",
            title: "Fallback Album",
            date: "2019-01-01",
            "release-group": { id: "rg-fallback-9" },
            "artist-credit": [
                {
                    name: "Fallback Artist",
                    artist: { id: "artist-fallback" },
                },
            ],
            media: [
                {
                    position: 1,
                    tracks: [
                        {
                            id: "ignored-track",
                            title: "Should Not Be Included",
                            position: 1,
                            length: 1000,
                        },
                    ],
                },
            ],
        });

        fetchMock.mockResolvedValueOnce({ ok: true });

        const req = {
            params: { mbid: "release-mbid-9" },
            query: { includeTracks: "off" },
        } as any;
        const res = createRes();

        await getAlbum(req, res);

        expect(mockGetReleaseGroup).toHaveBeenCalledTimes(2);
        expect(mockGetRelease).toHaveBeenCalledTimes(1);
        expect(mockGetRelease).toHaveBeenCalledWith("release-mbid-9");

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "rg-fallback-9",
                rgMbid: "rg-fallback-9",
                mbid: "release-mbid-9",
                releaseMbid: "release-mbid-9",
                type: "EP",
                coverUrl:
                    "https://coverartarchive.org/release/release-mbid-9/front-500",
            })
        );
        expect(res.body.tracks).toEqual([]);

        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "discovery:album:release-mbid-9:tracks:0",
            24 * 60 * 60,
            expect.any(String)
        );
    });

    it("returns 500 for /album errors", async () => {
        mockGetReleaseGroup.mockRejectedValueOnce(new Error("musicbrainz timeout"));

        const req = {
            params: { mbid: "bad-mbid" },
            query: {},
        } as any;
        const res = createRes();

        await getAlbum(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to fetch album details",
            message: "musicbrainz timeout",
        });
        expect(mockLoggerError).toHaveBeenCalled();
    });

    it("returns 404 for /album when neither release group nor release exists", async () => {
        mockGetReleaseGroup.mockResolvedValueOnce(null);

        const req = {
            params: { mbid: "unknown-mbid" },
            query: { includeTracks: "1" },
        } as any;
        const res = createRes();

        await getAlbum(req, res);

        expect(mockGetReleaseGroup).toHaveBeenCalledWith("unknown-mbid");
        expect(mockGetRelease).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Album not found" });
    });

    it("continues when selected release lookup fails while building /album tracks", async () => {
        mockGetReleaseGroup.mockResolvedValueOnce({
            id: "rg-album-fail",
            title: "Release Group with Missing Release Tracks",
            "primary-type": "Album",
            "first-release-date": "2010-01-01",
            "artist-credit": [{ name: "Fail Artist", artist: { id: "artist-fail" } }],
            releases: [{ id: "release-bad-tracks" }],
        });
        mockGetRelease.mockRejectedValueOnce(new Error("release tracks failed"));
        fetchMock.mockResolvedValueOnce({ ok: true });

        const req = {
            params: { mbid: "rg-album-fail" },
            query: { includeTracks: "1" },
        } as any;
        const res = createRes();

        await getAlbum(req, res);

        expect(mockGetReleaseGroup).toHaveBeenCalledWith("rg-album-fail");
        expect(mockGetRelease).toHaveBeenCalledWith("release-bad-tracks");
        expect(res.statusCode).toBe(200);
        expect(res.body.tracks).toEqual([]);
        expect(res.body.coverUrl).toBe(
            "https://coverartarchive.org/release-group/rg-album-fail/front-500"
        );
    });

    it("falls back to Cover Art Archive URL when album art HEAD request fails", async () => {
        mockGetReleaseGroup.mockResolvedValueOnce({
            id: "rg-cover-fallback",
            title: "Cover Fallback Album",
            "primary-type": "Album",
            "first-release-date": "2015-05-05",
            "artist-credit": [{ name: "Fallback Artist", artist: { id: "artist-fallback" } }],
        });
        fetchMock.mockRejectedValueOnce(new Error("cover head check failed"));
        mockGetAlbumCover.mockResolvedValueOnce(null);

        const req = {
            params: { mbid: "rg-cover-fallback" },
            query: { includeTracks: "0" },
        } as any;
        const res = createRes();

        await getAlbum(req, res);

        expect(mockGetAlbumCover).toHaveBeenCalledWith(
            "Fallback Artist",
            "Cover Fallback Album"
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.coverUrl).toBe(
            "https://coverartarchive.org/release-group/rg-cover-fallback/front-500"
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "discovery:album:rg-cover-fallback:tracks:0",
            24 * 60 * 60,
            expect.any(String)
        );
    });

    it("still returns /album when discovery cache write fails", async () => {
        mockRedisSetEx.mockRejectedValueOnce(new Error("cache unavailable"));
        mockGetReleaseGroup.mockResolvedValueOnce({
            id: "rg-cache-fail",
            title: "Cached Album",
            "primary-type": "EP",
            "first-release-date": "2020-02-02",
            "artist-credit": [{ name: "Cache Artist", artist: { id: "artist-cache" } }],
        });
        fetchMock.mockResolvedValueOnce({ ok: true });

        const req = {
            params: { mbid: "rg-cache-fail" },
            query: { includeTracks: "0" },
        } as any;
        const res = createRes();

        await getAlbum(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "rg-cache-fail",
                title: "Cached Album",
            })
        );
    });
});
