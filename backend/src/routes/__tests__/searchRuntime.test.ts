import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
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
    prisma: {
        artist: {
            findMany: jest.fn(),
            findFirst: jest.fn(),
        },
        similarArtist: {
            findMany: jest.fn(),
        },
        genre: {
            findMany: jest.fn(),
        },
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(),
        setEx: jest.fn(),
    },
}));

jest.mock("../../services/lastfm", () => ({
    lastFmService: {
        getArtistCorrection: jest.fn(),
        searchArtists: jest.fn(),
        searchTracks: jest.fn(),
        getSimilarArtists: jest.fn(),
        enrichSimilarArtists: jest.fn(),
    },
}));

jest.mock("axios", () => ({
    __esModule: true,
    default: {
        get: jest.fn(),
    },
}));

jest.mock("../../services/search", () => ({
    searchService: {
        searchAll: jest.fn(),
        searchByType: jest.fn(),
    },
    normalizeCacheQuery: (query: string) => query.trim().toLowerCase(),
}));

import axios from "axios";
import router from "../search";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { lastFmService } from "../../services/lastfm";
import { searchService } from "../../services/search";

const mockArtistFindMany = prisma.artist.findMany as jest.Mock;
const mockArtistFindFirst = prisma.artist.findFirst as jest.Mock;
const mockSimilarArtistFindMany = prisma.similarArtist.findMany as jest.Mock;
const mockGenreFindMany = prisma.genre.findMany as jest.Mock;
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;
const mockGetArtistCorrection = lastFmService.getArtistCorrection as jest.Mock;
const mockSearchArtists = lastFmService.searchArtists as jest.Mock;
const mockSearchTracks = lastFmService.searchTracks as jest.Mock;
const mockGetSimilarArtists = lastFmService.getSimilarArtists as jest.Mock;
const mockEnrichSimilarArtists = lastFmService.enrichSimilarArtists as jest.Mock;
const mockSearchAll = searchService.searchAll as jest.Mock;
const mockSearchByType = searchService.searchByType as jest.Mock;
const mockAxiosGet = (axios as any).get as jest.Mock;

function getGetHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.get
    );
    if (!layer) {
        throw new Error(`Route not found: ${path}`);
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

describe("search route runtime behavior", () => {
    const rootHandler = getGetHandler("/");
    const genresHandler = getGetHandler("/genres");
    const discoverHandler = getGetHandler("/discover");
    const discoverSimilarHandler = getGetHandler("/discover/similar");

    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue("OK");
        mockArtistFindMany.mockResolvedValue([]);
        mockArtistFindFirst.mockResolvedValue(null);
        mockSimilarArtistFindMany.mockResolvedValue([]);
        mockGenreFindMany.mockResolvedValue([]);
        mockGetArtistCorrection.mockResolvedValue(null);
        mockSearchArtists.mockResolvedValue([]);
        mockSearchTracks.mockResolvedValue([]);
        mockGetSimilarArtists.mockResolvedValue([]);
        mockEnrichSimilarArtists.mockResolvedValue([]);
        mockSearchAll.mockResolvedValue({
            artists: [],
            albums: [],
            tracks: [],
            audiobooks: [],
            podcasts: [],
            episodes: [],
        });
        mockSearchByType.mockResolvedValue({
            artists: [],
            albums: [],
            tracks: [],
            audiobooks: [],
            podcasts: [],
            episodes: [],
        });
        mockAxiosGet.mockResolvedValue({ data: { results: [] } });
    });

    it("returns empty payload when query is blank", async () => {
        const req = { query: { q: "   " } } as any;
        const res = createRes();

        await rootHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            artists: [],
            albums: [],
            tracks: [],
            audiobooks: [],
            podcasts: [],
            episodes: [],
        });
        expect(mockSearchAll).not.toHaveBeenCalled();
        expect(mockSearchByType).not.toHaveBeenCalled();
    });

    it("uses searchAll with clamped limit and transforms response shape", async () => {
        mockSearchAll.mockResolvedValueOnce({
            artists: [{ id: "artist-1", name: "Radiohead", mbid: "mbid-1" }],
            albums: [
                {
                    id: "album-1",
                    title: "Kid A",
                    artistId: "artist-1",
                    artistName: "Radiohead",
                    year: 2000,
                    coverUrl: "cover.jpg",
                },
            ],
            tracks: [
                {
                    id: "track-1",
                    title: "Everything In Its Right Place",
                    artistId: "artist-1",
                    artistName: "Radiohead",
                    albumId: "album-1",
                    albumTitle: "Kid A",
                    duration: 250,
                },
            ],
            audiobooks: [{ id: "book-1" }],
            podcasts: [{ id: "pod-1" }],
            episodes: [{ id: "ep-1" }],
        });

        const req = {
            query: { q: "  radiohead ", type: "all", limit: "999", genre: "alt" },
        } as any;
        const res = createRes();

        await rootHandler(req, res);

        expect(mockSearchAll).toHaveBeenCalledWith({
            query: "radiohead",
            limit: 100,
            genre: "alt",
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                artists: [{ id: "artist-1", name: "Radiohead", mbid: "mbid-1" }],
                albums: [
                    expect.objectContaining({
                        id: "album-1",
                        title: "Kid A",
                        artist: expect.objectContaining({
                            id: "artist-1",
                            name: "Radiohead",
                            mbid: "",
                        }),
                    }),
                ],
                tracks: [
                    expect.objectContaining({
                        id: "track-1",
                        title: "Everything In Its Right Place",
                        trackNo: 0,
                        album: expect.objectContaining({
                            id: "album-1",
                            title: "Kid A",
                            artist: expect.objectContaining({
                                id: "artist-1",
                                name: "Radiohead",
                                mbid: "",
                            }),
                        }),
                    }),
                ],
                audiobooks: [{ id: "book-1" }],
                podcasts: [{ id: "pod-1" }],
                episodes: [{ id: "ep-1" }],
            })
        );
    });

    it("uses searchByType with lower bound limit clamp", async () => {
        const req = {
            query: { q: "dj", type: "artists", limit: "0" },
        } as any;
        const res = createRes();

        await rootHandler(req, res);

        expect(mockSearchByType).toHaveBeenCalledWith({
            query: "dj",
            type: "artists",
            limit: 1,
            genre: undefined,
        });
        expect(res.statusCode).toBe(200);
    });

    it("returns 500 when search service throws", async () => {
        mockSearchByType.mockRejectedValueOnce(new Error("search down"));
        const req = {
            query: { q: "jazz", type: "albums", limit: "abc" },
        } as any;
        const res = createRes();

        await rootHandler(req, res);

        expect(mockSearchByType).toHaveBeenCalledWith({
            query: "jazz",
            type: "albums",
            limit: 20,
            genre: undefined,
        });
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Search failed" });
    });

    it("returns genres with track counts", async () => {
        mockGenreFindMany.mockResolvedValueOnce([
            { id: "genre-1", name: "Alternative", _count: { trackGenres: 12 } },
            { id: "genre-2", name: "Ambient", _count: { trackGenres: 5 } },
        ]);

        const req = {} as any;
        const res = createRes();
        await genresHandler(req, res);

        expect(mockGenreFindMany).toHaveBeenCalledWith({
            orderBy: { name: "asc" },
            include: {
                _count: {
                    select: { trackGenres: true },
                },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual([
            { id: "genre-1", name: "Alternative", trackCount: 12 },
            { id: "genre-2", name: "Ambient", trackCount: 5 },
        ]);
    });

    it("returns 500 when genre lookup fails", async () => {
        mockGenreFindMany.mockRejectedValueOnce(new Error("db error"));
        const req = {} as any;
        const res = createRes();

        await genresHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get genres" });
    });

    it("returns empty discover payload for blank query", async () => {
        const req = { query: { q: "   " } } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ results: [], aliasInfo: null });
    });

    it("returns cached discover payload when available", async () => {
        const cached = {
            results: [{ type: "music", id: "artist-1", name: "Cached Artist" }],
            aliasInfo: null,
        };
        mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));

        const req = { query: { q: "cached", type: "music", limit: "5" } } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(cached);
        expect(mockSearchArtists).not.toHaveBeenCalled();
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("builds discover payload with alias correction and podcast mapping", async () => {
        mockGetArtistCorrection.mockResolvedValueOnce({
            corrected: true,
            canonicalName: "Radiohead",
            mbid: "mbid-radiohead",
        });
        mockSearchArtists.mockResolvedValueOnce([
            {
                type: "music",
                id: "artist-1",
                name: "Radiohead",
            },
        ]);
        mockSearchTracks.mockResolvedValueOnce([
            { type: "track", id: "track-1", name: "Paranoid Android" },
        ]);
        mockAxiosGet.mockResolvedValueOnce({
            data: {
                results: [
                    {
                        collectionId: 55,
                        collectionName: "Podcast A",
                        artistName: "Host A",
                        description: "Desc",
                        artworkUrl600: "large.jpg",
                        artworkUrl100: "small.jpg",
                        feedUrl: "https://example.com/feed.xml",
                        genres: ["Music"],
                        trackCount: 42,
                    },
                ],
            },
        });

        const req = {
            query: { q: "  rh ", type: "all", limit: "60" },
        } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(mockSearchArtists).toHaveBeenCalledWith("Radiohead", 50);
        expect(mockSearchTracks).toHaveBeenCalledWith("Radiohead", 50);
        expect(mockAxiosGet).toHaveBeenCalledWith(
            "https://itunes.apple.com/search",
            expect.objectContaining({
                params: {
                    term: "rh",
                    media: "podcast",
                    entity: "podcast",
                    limit: 50,
                },
                timeout: 5000,
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.aliasInfo).toEqual({
            original: "rh",
            canonical: "Radiohead",
            mbid: "mbid-radiohead",
        });
        expect(res.body.results).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ type: "music", name: "Radiohead" }),
                expect.objectContaining({ type: "track", id: "track-1" }),
                expect.objectContaining({
                    type: "podcast",
                    id: 55,
                    name: "Podcast A",
                    coverUrl: "large.jpg",
                }),
            ])
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "search:discover:all:rh:50",
            900,
            expect.any(String)
        );
    });

    it("handles discover partial failures and redis write errors", async () => {
        mockRedisGet.mockRejectedValueOnce(new Error("redis read fail"));
        mockGetArtistCorrection.mockRejectedValueOnce(new Error("lastfm correction fail"));
        mockSearchArtists.mockRejectedValueOnce(new Error("artist search fail"));
        mockSearchTracks.mockResolvedValueOnce([
            { type: "track", id: "track-2", name: "Song B" },
        ]);
        mockRedisSetEx.mockRejectedValueOnce(new Error("redis write fail"));

        const req = { query: { q: "radiohead", type: "music", limit: "2" } } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            results: [{ type: "track", id: "track-2", name: "Song B" }],
            aliasInfo: null,
        });
    });

    it("skips library lookup when discovered artists have no usable names", async () => {
        mockSearchArtists.mockResolvedValueOnce([{ type: "music", id: "x", name: 42 }]);
        const req = { query: { q: "odd", type: "music", limit: "3" } } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(mockArtistFindMany).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body.results).toEqual([{ type: "music", id: "x", name: 42 }]);
    });

    it("falls back to live discover fetch when cached payload is malformed", async () => {
        mockRedisGet.mockResolvedValueOnce("not valid json");
        mockSearchTracks.mockResolvedValueOnce([
            { type: "track", id: "track-live", name: "Live Result" },
        ]);
        const req = { query: { q: "broken", type: "music", limit: "5" } } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            results: [{ type: "track", id: "track-live", name: "Live Result" }],
            aliasInfo: null,
        });
    });

    it("returns 500 when artist filtering lookup throws during discover", async () => {
        mockSearchArtists.mockResolvedValueOnce([
            { type: "music", id: "artist-err", name: "Boom Artist" },
        ]);
        mockArtistFindMany.mockRejectedValueOnce(new Error("db failure"));
        const req = { query: { q: "boom", type: "music", limit: "4" } } as any;
        const res = createRes();

        await discoverHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Discovery search failed" });
    });

    it("returns empty similar artists when no seed artist is supplied", async () => {
        const req = { query: { artist: "   " } } as any;
        const res = createRes();

        await discoverSimilarHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ similarArtists: [] });
        expect(mockGetSimilarArtists).not.toHaveBeenCalled();
    });

    it("returns cached similar artists payload", async () => {
        const cached = { similarArtists: [{ id: "cached-1", name: "Cached Similar" }] };
        mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));

        const req = {
            query: { artist: "Radiohead", mbid: "mbid-r", limit: "9" },
        } as any;
        const res = createRes();

        await discoverSimilarHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(cached);
        expect(mockGetSimilarArtists).not.toHaveBeenCalled();
    });

    it("fetches and enriches similar artists with bounded limits", async () => {
        mockRedisGet.mockRejectedValueOnce(new Error("read fail"));
        mockGetSimilarArtists.mockResolvedValueOnce([
            { name: "Thom Yorke", match: 0.92 },
            { name: "Atoms for Peace", match: 0.74 },
        ]);
        mockEnrichSimilarArtists.mockResolvedValueOnce([
            { id: "sim-1", name: "Thom Yorke" },
            { id: "sim-2", name: "Atoms for Peace" },
        ]);
        mockRedisSetEx.mockRejectedValueOnce(new Error("write fail"));

        const req = {
            query: { artist: "Radiohead", mbid: "mbid-r", limit: "100" },
        } as any;
        const res = createRes();

        await discoverSimilarHandler(req, res);

        expect(mockGetSimilarArtists).toHaveBeenCalledWith("mbid-r", "Radiohead", 100);
        expect(mockEnrichSimilarArtists).toHaveBeenCalledWith(
            [
                { name: "Thom Yorke", match: 0.92 },
                { name: "Atoms for Peace", match: 0.74 },
            ],
            50
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            similarArtists: [
                { id: "sim-1", name: "Thom Yorke" },
                { id: "sim-2", name: "Atoms for Peace" },
            ],
        });
    });

    it("falls back to local similar-artist graph when Last.fm enrichment is empty", async () => {
        mockGetSimilarArtists.mockResolvedValueOnce([
            { name: "Sparse Similar", match: 0.64 },
        ]);
        mockEnrichSimilarArtists.mockResolvedValueOnce([]);
        mockArtistFindFirst.mockResolvedValueOnce({ id: "artist-seed-1" });
        mockSimilarArtistFindMany.mockResolvedValueOnce([
            {
                weight: 0.98,
                toArtist: {
                    id: "artist-2",
                    mbid: "mbid-thom",
                    name: "Thom Yorke",
                    heroUrl: "thom.jpg",
                    summary: "Radiohead side projects and solo work",
                    genres: ["alternative", "electronic"],
                },
            },
            {
                weight: 0.87,
                toArtist: {
                    id: "artist-3",
                    mbid: "mbid-atoms",
                    name: "Atoms for Peace",
                    heroUrl: null,
                    summary: null,
                    genres: null,
                },
            },
        ]);

        const req = {
            query: { artist: "Radiohead", mbid: "mbid-r", limit: "2" },
        } as any;
        const res = createRes();

        await discoverSimilarHandler(req, res);

        expect(mockGetSimilarArtists).toHaveBeenCalledWith("mbid-r", "Radiohead", 10);
        expect(mockEnrichSimilarArtists).toHaveBeenCalledWith(
            [{ name: "Sparse Similar", match: 0.64 }],
            2
        );
        expect(mockArtistFindFirst).toHaveBeenCalledWith({
            where: {
                OR: [
                    { name: { equals: "Radiohead", mode: "insensitive" } },
                    { normalizedName: "radiohead" },
                    { mbid: "mbid-r" },
                ],
            },
            select: { id: true },
        });
        expect(mockSimilarArtistFindMany).toHaveBeenCalledWith({
            where: { fromArtistId: "artist-seed-1" },
            orderBy: { weight: "desc" },
            take: 2,
            include: {
                toArtist: {
                    select: {
                        id: true,
                        mbid: true,
                        name: true,
                        heroUrl: true,
                        summary: true,
                        genres: true,
                    },
                },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            similarArtists: [
                {
                    type: "music",
                    id: "mbid-thom",
                    name: "Thom Yorke",
                    listeners: 0,
                    url: null,
                    image: "thom.jpg",
                    mbid: "mbid-thom",
                    bio: "Radiohead side projects and solo work",
                    tags: ["alternative", "electronic"],
                },
                {
                    type: "music",
                    id: "mbid-atoms",
                    name: "Atoms for Peace",
                    listeners: 0,
                    url: null,
                    image: null,
                    mbid: "mbid-atoms",
                    bio: null,
                    tags: [],
                },
            ],
        });
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "search:discover:similar:radiohead:mbid-r:2",
            3600,
            expect.any(String)
        );
    });

    it("returns empty similar artists when no similar seed results exist", async () => {
        mockGetSimilarArtists.mockResolvedValueOnce([]);
        const req = {
            query: { artist: "NoMatch", mbid: "", limit: "5" },
        } as any;
        const res = createRes();

        await discoverSimilarHandler(req, res);

        expect(mockEnrichSimilarArtists).not.toHaveBeenCalled();
        expect(mockArtistFindFirst).toHaveBeenCalledWith({
            where: {
                OR: [
                    { name: { equals: "NoMatch", mode: "insensitive" } },
                    { normalizedName: "nomatch" },
                ],
            },
            select: { id: true },
        });
        expect(mockSimilarArtistFindMany).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ similarArtists: [] });
    });

    it("returns 500 when similar artist search throws", async () => {
        mockGetSimilarArtists.mockRejectedValueOnce(new Error("lastfm unavailable"));
        const req = {
            query: { artist: "Radiohead", mbid: "mbid", limit: "6" },
        } as any;
        const res = createRes();

        await discoverSimilarHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Similar artists search failed" });
    });
});
