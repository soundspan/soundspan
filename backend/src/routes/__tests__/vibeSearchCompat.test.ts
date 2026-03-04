import { Request, Response } from "express";

jest.mock("crypto", () => ({
    randomUUID: jest.fn(() => "req-123"),
}));

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
        track: {
            count: jest.fn(),
            findUnique: jest.fn(),
        },
        likedTrack: {
            findMany: jest.fn(),
        },
        dislikedEntity: {
            findMany: jest.fn(),
        },
        $queryRaw: jest.fn(),
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        xAdd: jest.fn(),
        blPop: jest.fn(),
        del: jest.fn(),
    },
}));

jest.mock("../../services/hybridSimilarity", () => ({
    findSimilarTracks: jest.fn(),
}));

jest.mock("../../services/vibeVocabulary", () => ({
    loadVocabulary: jest.fn(),
    getVocabulary: jest.fn(() => null),
    expandQueryWithVocabulary: jest.fn((embedding: number[]) => ({
        embedding,
        genreConfidence: 0,
        matchedTerms: [],
    })),
    rerankWithFeatures: jest.fn((tracks: unknown[]) => tracks),
}));

import router from "../vibe";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { findSimilarTracks } from "../../services/hybridSimilarity";
import {
    getVocabulary,
    expandQueryWithVocabulary,
    rerankWithFeatures,
} from "../../services/vibeVocabulary";

const mockTrackCount = prisma.track.count as jest.Mock;
const mockTrackFindUnique = prisma.track.findUnique as jest.Mock;
const mockLikedTrackFindMany = prisma.likedTrack.findMany as jest.Mock;
const mockDislikedEntityFindMany = prisma.dislikedEntity.findMany as jest.Mock;
const mockQueryRaw = prisma.$queryRaw as jest.Mock;
const mockRedisXAdd = redisClient.xAdd as jest.Mock;
const mockRedisBlPop = redisClient.blPop as jest.Mock;
const mockRedisDel = redisClient.del as jest.Mock;
const mockFindSimilarTracks = findSimilarTracks as jest.Mock;
const mockGetVocabulary = getVocabulary as jest.Mock;
const mockExpandQueryWithVocabulary = expandQueryWithVocabulary as jest.Mock;
const mockRerankWithFeatures = rerankWithFeatures as jest.Mock;

function getGetHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.get
    );
    if (!layer) {
        throw new Error(`Route not found: ${path}`);
    }
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getPostHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.post
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

describe("vibe search transport compatibility", () => {
    const similarHandler = getGetHandler("/similar/:trackId");
    const statusHandler = getGetHandler("/status");
    const searchHandler = getPostHandler("/search");

    beforeEach(() => {
        jest.clearAllMocks();
        mockTrackCount.mockResolvedValue(0);
        mockTrackFindUnique.mockResolvedValue(null);
        mockRedisXAdd.mockResolvedValue("1712345-0");
        mockRedisDel.mockResolvedValue(1);
        mockQueryRaw.mockResolvedValue([]);
        mockLikedTrackFindMany.mockResolvedValue([]);
        mockDislikedEntityFindMany.mockResolvedValue([]);
        mockFindSimilarTracks.mockResolvedValue([]);
        mockGetVocabulary.mockReturnValue(null);
        mockExpandQueryWithVocabulary.mockImplementation((embedding: number[]) => ({
            embedding,
            genreConfidence: 0,
            matchedTerms: [],
        }));
        mockRerankWithFeatures.mockImplementation((tracks: unknown[]) => tracks);
    });

    it("handles similar-track route success, empty, and error branches", async () => {
        mockFindSimilarTracks.mockResolvedValueOnce([]);
        const missingReq = {
            params: { trackId: "t-1" },
            query: {},
            user: { id: "user-1" },
        } as any;
        const missingRes = createRes();
        await similarHandler(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);
        expect(missingRes.body.error).toBe("No similar tracks found");

        mockFindSimilarTracks.mockResolvedValueOnce([
            {
                id: "t-2",
                title: "Related",
                distance: 0.2,
                similarity: 0.9,
                albumId: "a-1",
                albumTitle: "Album 1",
                albumCoverUrl: null,
                artistId: "ar-1",
                artistName: "Artist 1",
            },
        ]);
        const okReq = {
            params: { trackId: "t-1" },
            query: { limit: "10" },
            user: { id: "user-1" },
        } as any;
        const okRes = createRes();
        await similarHandler(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual(
            expect.objectContaining({
                sourceTrackId: "t-1",
                tracks: [
                    expect.objectContaining({
                        id: "t-2",
                        title: "Related",
                        distance: 0.2,
                        similarity: 0.9,
                        album: expect.objectContaining({
                            id: "a-1",
                            title: "Album 1",
                        }),
                        artist: expect.objectContaining({
                            id: "ar-1",
                            name: "Artist 1",
                        }),
                    }),
                ],
            })
        );

        mockFindSimilarTracks.mockRejectedValueOnce(new Error("similar failed"));
        const errReq = {
            params: { trackId: "t-1" },
            query: {},
            user: { id: "user-1" },
        } as any;
        const errRes = createRes();
        await similarHandler(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to find similar tracks" });
    });

    it("applies light thumbs weighting to vibe similar-track ordering", async () => {
        mockFindSimilarTracks.mockResolvedValueOnce([
            {
                id: "track-disliked",
                title: "Disliked",
                distance: 0.18,
                similarity: 0.86,
                albumId: "a-1",
                albumTitle: "Album 1",
                albumCoverUrl: null,
                artistId: "ar-1",
                artistName: "Artist 1",
            },
            {
                id: "track-liked",
                title: "Liked",
                distance: 0.2,
                similarity: 0.85,
                albumId: "a-2",
                albumTitle: "Album 2",
                albumCoverUrl: null,
                artistId: "ar-2",
                artistName: "Artist 2",
            },
        ]);
        mockLikedTrackFindMany.mockResolvedValueOnce([
            {
                trackId: "track-liked",
                likedAt: new Date("2026-02-19T12:00:00.000Z"),
            },
        ]);
        mockDislikedEntityFindMany.mockResolvedValueOnce([
            {
                entityId: "track-disliked",
                dislikedAt: new Date("2026-02-19T12:00:00.000Z"),
            },
        ]);

        const req = {
            params: { trackId: "source-track" },
            query: { limit: "20" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();
        await similarHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.tracks[0]).toEqual(
            expect.objectContaining({
                id: "track-liked",
                similarity: expect.any(Number),
            })
        );
        expect(res.body.tracks[1]).toEqual(
            expect.objectContaining({
                id: "track-disliked",
            })
        );
    });

    it("handles vibe status route success and error branches", async () => {
        mockTrackCount.mockResolvedValueOnce(10);
        mockQueryRaw.mockResolvedValueOnce([{ count: BigInt(4) }]);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await statusHandler(req, res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            totalTracks: 10,
            embeddedTracks: 4,
            progress: 40,
            isComplete: false,
        });

        mockTrackCount.mockRejectedValueOnce(new Error("status failed"));
        const errRes = createRes();
        await statusHandler(req, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to get embedding status" });
    });

    it("uses stream request + response list and returns search results", async () => {
        mockRedisBlPop.mockResolvedValue({
            key: "audio:text:embed:response:req-123",
            element: JSON.stringify({
                requestId: "req-123",
                success: true,
                embedding: [0.25, 0.75],
                modelVersion: "laion-clap-music-v1",
            }),
        });
        mockQueryRaw.mockResolvedValue([
            {
                id: "track-1",
                title: "Track One",
                duration: 180,
                trackNo: 1,
                distance: 0.4,
                albumId: "album-1",
                albumTitle: "Album One",
                albumCoverUrl: null,
                artistId: "artist-1",
                artistName: "Artist One",
                energy: 0.8,
                valence: 0.7,
                danceability: 0.6,
                acousticness: 0.1,
                instrumentalness: 0.05,
                arousal: 0.7,
                speechiness: 0.12,
            },
        ]);

        const req = {
            body: {
                query: "  upbeat synthwave  ",
                limit: 20,
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await searchHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                query: "upbeat synthwave",
                totalAboveThreshold: 1,
                tracks: [
                    expect.objectContaining({
                        id: "track-1",
                        title: "Track One",
                    }),
                ],
            })
        );
        expect(mockRedisXAdd).toHaveBeenCalledWith(
            "audio:text:embed:requests",
            "*",
            expect.objectContaining({
                requestId: "req-123",
                text: "upbeat synthwave",
                responseKey: "audio:text:embed:response:req-123",
            })
        );
        expect(mockRedisBlPop).toHaveBeenCalledWith(
            "audio:text:embed:response:req-123",
            30
        );
        expect(mockRedisDel).toHaveBeenCalledWith("audio:text:embed:response:req-123");
    });

    it("returns 504 when no embedding response arrives before timeout", async () => {
        mockRedisBlPop.mockResolvedValue(null);

        const req = {
            body: {
                query: "melancholic piano",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await searchHandler(req, res);

        expect(res.statusCode).toBe(504);
        expect(res.body).toEqual({
            error: "Text embedding service unavailable",
            message: "The CLAP analyzer service did not respond in time",
        });
        expect(mockRedisXAdd).toHaveBeenCalledWith(
            "audio:text:embed:requests",
            "*",
            expect.objectContaining({
                requestId: "req-123",
                text: "melancholic piano",
                responseKey: "audio:text:embed:response:req-123",
            })
        );
        expect(mockRedisDel).toHaveBeenCalledWith("audio:text:embed:response:req-123");
        expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it("validates query length and handles analyzer payload errors", async () => {
        const badReq = { body: { query: "a" }, user: { id: "user-1" } } as any;
        const badRes = createRes();
        await searchHandler(badReq, badRes);
        expect(badRes.statusCode).toBe(400);
        expect(badRes.body).toEqual({
            error: "Query must be at least 2 characters",
        });

        mockRedisBlPop.mockResolvedValueOnce({
            key: "audio:text:embed:response:req-123",
            element: "not-json",
        });
        const parseReq = {
            body: { query: "valid query" },
            user: { id: "user-1" },
        } as any;
        const parseRes = createRes();
        await searchHandler(parseReq, parseRes);
        expect(parseRes.statusCode).toBe(500);
        expect(parseRes.body).toEqual({ error: "Failed to search tracks by vibe" });

        mockRedisBlPop.mockResolvedValueOnce({
            key: "audio:text:embed:response:req-123",
            element: JSON.stringify({
                requestId: "req-123",
                success: false,
                embedding: null,
                modelVersion: "v1",
                error: "analyzer rejected query",
            }),
        });
        const payloadErrReq = {
            body: { query: "valid query" },
            user: { id: "user-1" },
        } as any;
        const payloadErrRes = createRes();
        await searchHandler(payloadErrReq, payloadErrRes);
        expect(payloadErrRes.statusCode).toBe(500);
        expect(payloadErrRes.body).toEqual({ error: "Failed to search tracks by vibe" });

        mockRedisBlPop.mockResolvedValueOnce({
            key: "audio:text:embed:response:req-123",
            element: JSON.stringify({
                requestId: "req-123",
                success: true,
                embedding: "invalid-shape",
                modelVersion: "v1",
            }),
        });
        const invalidEmbedReq = {
            body: { query: "valid query" },
            user: { id: "user-1" },
        } as any;
        const invalidEmbedRes = createRes();
        await searchHandler(invalidEmbedReq, invalidEmbedRes);
        expect(invalidEmbedRes.statusCode).toBe(500);
        expect(invalidEmbedRes.body).toEqual({
            error: "Failed to search tracks by vibe",
        });
    });

    it("expands and reranks vibe search results when vocabulary matches exist", async () => {
        mockRedisBlPop.mockResolvedValueOnce({
            key: "audio:text:embed:response:req-123",
            element: JSON.stringify({
                requestId: "req-123",
                success: true,
                embedding: [0.5, 0.25],
                modelVersion: "laion-clap-music-v1",
            }),
        });
        mockGetVocabulary.mockReturnValueOnce({ id: "mock-vocab" });
        mockExpandQueryWithVocabulary.mockReturnValueOnce({
            embedding: [0.6, 0.3],
            genreConfidence: 0.8,
            matchedTerms: [{ name: "energetic" }],
        });
        mockQueryRaw.mockResolvedValueOnce([
            {
                id: "track-2",
                title: "Track Two",
                duration: 200,
                trackNo: 2,
                distance: 0.5,
                albumId: "album-2",
                albumTitle: "Album Two",
                albumCoverUrl: null,
                artistId: "artist-2",
                artistName: "Artist Two",
                energy: 0.9,
                valence: 0.7,
                danceability: 0.8,
                acousticness: 0.1,
                instrumentalness: 0.05,
                arousal: 0.8,
                speechiness: 0.09,
            },
        ]);
        mockRerankWithFeatures.mockReturnValueOnce([
            {
                id: "track-2",
                title: "Track Two",
                duration: 200,
                trackNo: 2,
                distance: 0.5,
                finalScore: 0.91,
                albumId: "album-2",
                albumTitle: "Album Two",
                albumCoverUrl: null,
                artistId: "artist-2",
                artistName: "Artist Two",
                energy: 0.9,
                valence: 0.7,
                danceability: 0.8,
                acousticness: 0.1,
                instrumentalness: 0.05,
                arousal: 0.8,
                speechiness: 0.09,
            },
        ]);

        const req = {
            body: { query: "energetic workout", minSimilarity: 0.7, limit: 5 },
            user: { id: "user-1" },
        } as any;
        const res = createRes();
        await searchHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                query: "energetic workout",
                tracks: [
                    expect.objectContaining({
                        id: "track-2",
                        similarity: 0.91,
                    }),
                ],
                debug: expect.objectContaining({
                    matchedTerms: ["energetic"],
                    genreConfidence: 0.8,
                }),
            })
        );
        expect(mockExpandQueryWithVocabulary).toHaveBeenCalled();
        expect(mockRerankWithFeatures).toHaveBeenCalled();
    });
});
