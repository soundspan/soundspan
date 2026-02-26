jest.mock("../../middleware/auth", () => ({
    requireAuthOrToken: (_req: any, _res: any, next: () => void) => next(),
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
        play: {
            findMany: jest.fn(),
        },
        similarArtist: {
            findMany: jest.fn(),
        },
        ownedAlbum: {
            findMany: jest.fn(),
        },
        album: {
            groupBy: jest.fn(),
            findMany: jest.fn(),
            findUnique: jest.fn(),
        },
        artist: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
        },
        track: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
        },
    },
}));

jest.mock("../../services/lastfm", () => ({
    lastFmService: {
        getSimilarTracks: jest.fn(),
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        mGet: jest.fn(),
    },
}));

import router from "../recommendations";
import { prisma } from "../../utils/db";
import { lastFmService } from "../../services/lastfm";
import { redisClient } from "../../utils/redis";
import { createMockJsonResponse } from "./helpers/mockJsonResponse";

const mockPlayFindMany = prisma.play.findMany as jest.Mock;
const mockSimilarArtistFindMany = prisma.similarArtist.findMany as jest.Mock;
const mockOwnedAlbumFindMany = prisma.ownedAlbum.findMany as jest.Mock;
const mockAlbumGroupBy = prisma.album.groupBy as jest.Mock;
const mockAlbumFindMany = prisma.album.findMany as jest.Mock;
const mockAlbumFindUnique = prisma.album.findUnique as jest.Mock;
const mockArtistFindUnique = prisma.artist.findUnique as jest.Mock;
const mockArtistFindMany = prisma.artist.findMany as jest.Mock;
const mockTrackFindUnique = prisma.track.findUnique as jest.Mock;
const mockTrackFindMany = prisma.track.findMany as jest.Mock;
const mockLastfmSimilarTracks = lastFmService.getSimilarTracks as jest.Mock;
const mockRedisMGet = redisClient.mGet as jest.Mock;

function getGetHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.get
    );
    if (!layer) throw new Error(`GET route not found: ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

const createRes = createMockJsonResponse;

describe("recommendations routes runtime", () => {
    const getForYou = getGetHandler("/for-you");
    const getRecommendations = getGetHandler("/");
    const getAlbumRecommendations = getGetHandler("/albums");
    const getTrackRecommendations = getGetHandler("/tracks");

    beforeEach(() => {
        jest.clearAllMocks();

        mockPlayFindMany.mockResolvedValue([]);
        mockSimilarArtistFindMany.mockResolvedValue([]);
        mockOwnedAlbumFindMany.mockResolvedValue([]);
        mockAlbumGroupBy.mockResolvedValue([]);
        mockAlbumFindMany.mockResolvedValue([]);
        mockAlbumFindUnique.mockResolvedValue(null);
        mockArtistFindUnique.mockResolvedValue(null);
        mockArtistFindMany.mockResolvedValue([]);
        mockTrackFindUnique.mockResolvedValue(null);
        mockTrackFindMany.mockResolvedValue([]);
        mockLastfmSimilarTracks.mockResolvedValue([]);
        mockRedisMGet.mockResolvedValue([]);
    });

    it("returns empty for-you recommendations when user has no history", async () => {
        mockPlayFindMany.mockResolvedValue([]);

        const req = { user: { id: "u1" }, query: {} } as any;
        const res = createRes();
        await getForYou(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ artists: [] });
        expect(mockSimilarArtistFindMany).not.toHaveBeenCalled();
    });

    it("builds for-you recommendations with dedupe, ownership filtering, and cache fallback", async () => {
        mockPlayFindMany.mockResolvedValue([
            {
                track: { album: { artist: { id: "a1", name: "Seed One" } } },
            },
            {
                track: { album: { artist: { id: "a1", name: "Seed One" } } },
            },
            {
                track: { album: { artist: { id: "a2", name: "Seed Two" } } },
            },
        ]);

        mockSimilarArtistFindMany
            .mockResolvedValueOnce([
                {
                    toArtist: {
                        id: "r1",
                        mbid: "mbid-r1",
                        name: "Rec One",
                        heroUrl: null,
                    },
                },
                {
                    toArtist: {
                        id: "r2",
                        mbid: "mbid-r2",
                        name: "Rec Two",
                        heroUrl: "native:artists/r2.jpg",
                    },
                },
            ])
            .mockResolvedValueOnce([
                {
                    toArtist: {
                        id: "r1",
                        mbid: "mbid-r1",
                        name: "Rec One",
                        heroUrl: null,
                    },
                },
                {
                    toArtist: {
                        id: "r3",
                        mbid: "mbid-r3",
                        name: "Rec Three",
                        heroUrl: null,
                    },
                },
            ]);

        mockOwnedAlbumFindMany.mockResolvedValue([{ artistId: "r2" }]);
        mockAlbumGroupBy.mockResolvedValue([
            { artistId: "r1", _count: { rgMbid: 5 } },
            { artistId: "r3", _count: { rgMbid: 1 } },
        ]);
        mockRedisMGet.mockResolvedValue(["native:artists/r1-cache.jpg", "NOT_FOUND"]);

        const req = { user: { id: "u1" }, query: { limit: "10" } } as any;
        const res = createRes();
        await getForYou(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.artists).toHaveLength(2);
        expect(res.body.artists[0]).toEqual(
            expect.objectContaining({
                id: "r1",
                coverArt: "native:artists/r1-cache.jpg",
                albumCount: 5,
            })
        );
        expect(res.body.artists[1]).toEqual(
            expect.objectContaining({
                id: "r3",
                coverArt: null,
                albumCount: 1,
            })
        );
        expect(mockRedisMGet).toHaveBeenCalledWith(["hero:r1", "hero:r3"]);
    });

    it("returns 500 for for-you query failures", async () => {
        mockPlayFindMany.mockRejectedValue(new Error("db fail"));
        const req = { user: { id: "u1" }, query: {} } as any;
        const res = createRes();

        await getForYou(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get recommendations" });
    });

    it("falls back to DB hero URLs when Redis fails in for-you recommendations", async () => {
        mockPlayFindMany.mockResolvedValue([
            {
                track: { album: { artist: { id: "seed-1", name: "Seed" } } },
            },
        ]);
        mockSimilarArtistFindMany.mockResolvedValue([
            {
                toArtist: {
                    id: "r1",
                    mbid: "mbid-r1",
                    name: "Rec Hero",
                    heroUrl: null,
                },
            },
        ]);
        mockOwnedAlbumFindMany.mockResolvedValue([]);
        mockAlbumGroupBy.mockResolvedValue([{ artistId: "r1", _count: { rgMbid: 2 } }]);
        mockRedisMGet.mockRejectedValue(new Error("redis down"));

        const req = { user: { id: "u1" }, query: { limit: "5" } } as any;
        const res = createRes();

        await getForYou(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.artists).toHaveLength(1);
        expect(res.body.artists[0]).toEqual(
            expect.objectContaining({
                id: "r1",
                coverArt: null,
                albumCount: 2,
            })
        );
        expect(mockRedisMGet).toHaveBeenCalledWith(["hero:r1"]);
    });

    it("validates seedArtistId for /recommendations", async () => {
        const req = { query: {} } as any;
        const res = createRes();

        await getRecommendations(req, res);
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "seedArtistId required" });
    });

    it("returns artist recommendations with owned album metadata", async () => {
        mockArtistFindUnique.mockResolvedValue({ id: "seed-1", name: "Seed Artist" });
        mockSimilarArtistFindMany.mockResolvedValue([
            { toArtistId: "sim-1", weight: 0.9 },
            { toArtistId: "sim-2", weight: 0.7 },
        ]);
        mockArtistFindMany.mockResolvedValue([
            { id: "sim-1", mbid: "mbid-1", name: "Similar One", heroUrl: null },
            { id: "sim-2", mbid: "mbid-2", name: "Similar Two", heroUrl: null },
        ]);
        mockAlbumFindMany.mockResolvedValue([
            { id: "al-1", artistId: "sim-1", rgMbid: "rg-1", year: 2024 },
            { id: "al-2", artistId: "sim-1", rgMbid: "rg-2", year: 2023 },
            { id: "al-3", artistId: "sim-2", rgMbid: "rg-3", year: 2022 },
        ]);
        mockOwnedAlbumFindMany.mockResolvedValue([{ artistId: "sim-1", rgMbid: "rg-1" }]);

        const req = { query: { seedArtistId: "seed-1" } } as any;
        const res = createRes();
        await getRecommendations(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.seedArtist).toEqual({ id: "seed-1", name: "Seed Artist" });
        expect(res.body.recommendations).toHaveLength(2);
        expect(res.body.recommendations[0].topAlbums[0]).toEqual(
            expect.objectContaining({ rgMbid: "rg-1", owned: true })
        );
        expect(res.body.recommendations[1].topAlbums[0]).toEqual(
            expect.objectContaining({ rgMbid: "rg-3", owned: false })
        );
    });

    it("returns 404 when seed artist does not exist", async () => {
        mockArtistFindUnique.mockResolvedValue(null);
        const req = { query: { seedArtistId: "missing" } } as any;
        const res = createRes();

        await getRecommendations(req, res);
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Artist not found" });
    });

    it("returns empty recommendations for seed artists with no similar artists", async () => {
        mockArtistFindUnique.mockResolvedValue({ id: "seed-1", name: "Seed Artist" });
        mockSimilarArtistFindMany.mockResolvedValue([]);
        mockArtistFindMany.mockResolvedValue([]);
        mockAlbumFindMany.mockResolvedValue([]);
        mockOwnedAlbumFindMany.mockResolvedValue([]);

        const req = { query: { seedArtistId: "seed-1" } } as any;
        const res = createRes();
        await getRecommendations(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            seedArtist: {
                id: "seed-1",
                name: "Seed Artist",
            },
            recommendations: [],
        });
    });

    it("validates and resolves album recommendations", async () => {
        const missingReq = { query: {} } as any;
        const missingRes = createRes();
        await getAlbumRecommendations(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(400);

        mockAlbumFindUnique.mockResolvedValue({
            id: "seed-album",
            title: "Seed Album",
            artistId: "artist-seed",
            artist: { name: "Seed Artist" },
            tracks: [
                {
                    trackGenres: [{ genre: { name: "rock" } }],
                },
            ],
        });
        mockSimilarArtistFindMany.mockResolvedValue([
            { toArtistId: "sa-1" },
            { toArtistId: "sa-2" },
        ]);
        mockAlbumFindMany
            .mockResolvedValueOnce([
                {
                    id: "rec-al-1",
                    artistId: "sa-1",
                    rgMbid: "rg-11",
                    title: "Similar Artist Album",
                    artist: { name: "A1" },
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: "rec-al-2",
                    artistId: "sa-2",
                    rgMbid: "rg-22",
                    title: "Genre Match Album",
                    artist: { name: "A2" },
                },
                {
                    id: "rec-al-1",
                    artistId: "sa-1",
                    rgMbid: "rg-11",
                    title: "Similar Artist Album",
                    artist: { name: "A1" },
                },
            ]);
        mockOwnedAlbumFindMany.mockResolvedValue([{ rgMbid: "rg-11" }]);

        const req = { query: { seedAlbumId: "seed-album" } } as any;
        const res = createRes();
        await getAlbumRecommendations(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.seedAlbum).toEqual({
            id: "seed-album",
            title: "Seed Album",
            artist: "Seed Artist",
        });
        expect(res.body.recommendations).toHaveLength(2);
        expect(res.body.recommendations[0]).toEqual(
            expect.objectContaining({ id: "rec-al-1", owned: true })
        );
        expect(res.body.recommendations[1]).toEqual(
            expect.objectContaining({ id: "rec-al-2", owned: false })
        );
    });

    it("skips genre strategy when seed album has no genre tags and deduplicates albums", async () => {
        mockAlbumFindUnique.mockResolvedValue({
            id: "seed-album",
            title: "Seed Album",
            artistId: "artist-seed",
            artist: { name: "Seed Artist" },
            tracks: [{ trackGenres: [] }],
        });
        mockSimilarArtistFindMany.mockResolvedValue([
            { toArtistId: "sa-1" },
            { toArtistId: "sa-1" },
        ]);
        mockAlbumFindMany.mockResolvedValue([
            {
                id: "rec-al-1",
                artistId: "sa-1",
                rgMbid: "rg-11",
                title: "Duplicate Album",
                artist: { id: "sa-1", name: "Artist One" },
            },
            {
                id: "rec-al-1",
                artistId: "sa-1",
                rgMbid: "rg-11",
                title: "Duplicate Album",
                artist: { id: "sa-1", name: "Artist One" },
            },
        ]);
        mockOwnedAlbumFindMany.mockResolvedValue([{ rgMbid: "rg-11" }]);

        const req = { query: { seedAlbumId: "seed-album" } } as any;
        const res = createRes();
        await getAlbumRecommendations(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockAlbumFindMany).toHaveBeenCalledTimes(1);
        expect(res.body.recommendations).toHaveLength(1);
        expect(res.body.recommendations[0]).toEqual(
            expect.objectContaining({
                id: "rec-al-1",
                title: "Duplicate Album",
                owned: true,
            })
        );
    });

    it("returns 404 for missing seed album in /albums", async () => {
        mockAlbumFindUnique.mockResolvedValue(null);
        const req = { query: { seedAlbumId: "none" } } as any;
        const res = createRes();

        await getAlbumRecommendations(req, res);
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Album not found" });
    });

    it("validates seedTrackId and returns track recommendations with in-library matches", async () => {
        const missingReq = { query: {} } as any;
        const missingRes = createRes();
        await getTrackRecommendations(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(400);

        mockTrackFindUnique.mockResolvedValue({
            id: "seed-track",
            title: "Seed Song",
            album: {
                title: "Seed Album",
                artist: { name: "Seed Artist" },
            },
        });
        mockLastfmSimilarTracks.mockResolvedValue([
            {
                name: "Exact Match Song",
                artist: "Exact Match Artist",
                match: "0.91",
                url: "https://last.fm/exact",
            },
            {
                name: "Unknown Song",
                artist: "Unknown Artist",
                match: "0.67",
                url: "https://last.fm/unknown",
            },
        ]);
        mockTrackFindMany.mockResolvedValue([
            {
                id: "track-1",
                title: "Exact Match Song",
                album: {
                    title: "Album One",
                    artist: { name: "Exact Match Artist" },
                },
            },
        ]);

        const req = { query: { seedTrackId: "seed-track" } } as any;
        const res = createRes();
        await getTrackRecommendations(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.seedTrack).toEqual({
            id: "seed-track",
            title: "Seed Song",
            artist: "Seed Artist",
            album: "Seed Album",
        });
        expect(res.body.recommendations).toHaveLength(2);
        expect(res.body.recommendations[0]).toEqual(
            expect.objectContaining({
                id: "track-1",
                inLibrary: true,
                similarity: 0.91,
            })
        );
        expect(res.body.recommendations[1]).toEqual(
            expect.objectContaining({
                title: "Unknown Song",
                artist: "Unknown Artist",
                inLibrary: false,
                lastFmUrl: "https://last.fm/unknown",
            })
        );
    });

    it("falls back to same-artist library tracks when Last.fm similar tracks are empty", async () => {
        mockTrackFindUnique.mockResolvedValue({
            id: "seed-track",
            title: "Seed Song",
            album: {
                title: "Seed Album",
                artist: {
                    id: "seed-artist-id",
                    name: "Seed Artist",
                },
            },
        });
        mockLastfmSimilarTracks.mockResolvedValue([]);
        mockTrackFindMany.mockResolvedValue([
            {
                id: "fallback-track-1",
                title: "Another Seed Artist Song",
                album: {
                    title: "Another Album",
                    artist: {
                        id: "seed-artist-id",
                        name: "Seed Artist",
                    },
                },
            },
        ]);

        const req = { query: { seedTrackId: "seed-track" } } as any;
        const res = createRes();
        await getTrackRecommendations(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockTrackFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: { not: "seed-track" },
                    album: expect.objectContaining({
                        artistId: "seed-artist-id",
                    }),
                }),
                take: 20,
            })
        );
        expect(res.body.recommendations).toEqual([
            expect.objectContaining({
                id: "fallback-track-1",
                inLibrary: true,
                recommendationSource: "same-artist-fallback",
                matchConfidence: 100,
            }),
        ]);
    });

    it("returns 404 for missing seed track in /tracks", async () => {
        mockTrackFindUnique.mockResolvedValue(null);
        const req = { query: { seedTrackId: "missing" } } as any;
        const res = createRes();

        await getTrackRecommendations(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Track not found" });
    });

    it("falls back to title matching when artist-matched candidates are missing", async () => {
        mockTrackFindUnique.mockResolvedValue({
            id: "seed-track",
            title: "Seed Song",
            album: {
                title: "Seed Album",
                artist: { name: "Seed Artist" },
            },
        });
        mockLastfmSimilarTracks.mockResolvedValue([
            {
                name: "Completely Different Title",
                artist: "Totally Different Artist",
                match: "1.2",
                url: "https://last.fm/match",
            },
        ]);
        mockTrackFindMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                {
                    id: "track-1",
                    title: "Unrelated Library Track",
                    album: {
                        title: "Library Album",
                        artist: { name: "Other Library Artist" },
                    },
                },
            ]);

        const req = { query: { seedTrackId: "seed-track" } } as any;
        const res = createRes();
        await getTrackRecommendations(req, res);

        expect(mockTrackFindMany).toHaveBeenCalledTimes(2);
        expect(res.statusCode).toBe(200);
        expect(res.body.recommendations).toHaveLength(1);
        expect(res.body.recommendations[0]).toEqual(
            expect.objectContaining({
                title: "Completely Different Title",
                artist: "Totally Different Artist",
                inLibrary: false,
                similarity: 1,
            })
        );
    });
});
