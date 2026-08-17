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
        moodBucket: {
            groupBy: jest.fn(),
            findMany: jest.fn(),
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
    blockingBlPop: jest.fn(),
    redisClient: {
        xAdd: jest.fn(),
        del: jest.fn(),
    },
}));

jest.mock("../../services/hybridSimilarity", () => ({
    findSimilarTracks: jest.fn(),
}));

// Same boundary as vibeSearchCompat.test.ts: the track-embedding service routes
// ANN queries through the F14 helper, which applies ivfflat.probes in a
// transaction. Plain embedding lookups use the mocked prisma.$queryRaw boundary.
jest.mock("../../utils/annQuery", () => ({
    runAnnQuery: jest.fn(),
}));

jest.mock("../../services/umapProjection", () => ({
    computeMapProjection: jest.fn(),
}));

jest.mock("../../services/embeddingSpaces", () => ({
    getActiveSpace: jest.fn(async () => ({ id: "space-active" })),
}));

jest.mock("../../utils/embedding", () => {
    const actual = jest.requireActual("../../utils/embedding");
    return {
        ...actual,
        parseEmbedding: jest.fn((text: string) => {
            const values = text
                .replace(/[\[\]]/g, "")
                .split(",")
                .map(Number);
            return values;
        }),
    };
});

jest.mock("../../services/vibeVocabulary", () => ({
    loadVocabulary: jest.fn(),
    getVocabulary: jest.fn(() => null),
    getVocabularyForSpace: jest.fn(() => null),
    expandQueryWithVocabulary: jest.fn((embedding: number[]) => ({
        embedding,
        genreConfidence: 0,
        matchedTerms: [],
    })),
    rerankWithFeatures: jest.fn((tracks: unknown[]) => tracks),
}));

jest.mock("../../services/textEmbedding", () => ({
    resolveTextEmbedding: jest.fn(),
    TextEmbeddingProviderError: class TextEmbeddingProviderError extends Error {},
    TextEmbeddingTimeoutError: class TextEmbeddingTimeoutError extends Error {},
    TextEmbeddingUnavailableError: class TextEmbeddingUnavailableError extends Error {},
}));

import router from "../vibe";
import { prisma } from "../../utils/db";
import { runAnnQuery } from "../../utils/annQuery";

const mockTrackFindUnique = prisma.track.findUnique as jest.Mock;
const mockMoodBucketGroupBy = prisma.moodBucket.groupBy as jest.Mock;
const mockMoodBucketFindMany = prisma.moodBucket.findMany as jest.Mock;
const mockQueryRaw = prisma.$queryRaw as jest.Mock;
const mockRunAnnQuery = runAnnQuery as jest.Mock;

function getGetHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.get,
    );
    if (!layer) {
        throw new Error(`Route not found: ${path}`);
    }
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getPostHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.post,
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

function nearestRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        id: "row-id",
        title: "Row Title",
        distance: 0.1,
        albumId: "album-id",
        albumTitle: "Album",
        albumCoverUrl: null,
        artistId: "artist-id",
        artistName: "Artist",
        energy: null,
        valence: null,
        danceability: null,
        arousal: null,
        ...overrides,
    };
}

describe("vibe journey + moods runtime", () => {
    const journeyHandler = getPostHandler("/journey");
    const moodsHandler = getGetHandler("/moods");

    beforeEach(() => {
        jest.clearAllMocks();
        mockQueryRaw.mockResolvedValue([]);
        mockRunAnnQuery.mockResolvedValue([]);
        mockTrackFindUnique.mockResolvedValue(null);
        mockMoodBucketGroupBy.mockResolvedValue([]);
        mockMoodBucketFindMany.mockResolvedValue([]);
    });

    describe("POST /journey", () => {
        it("returns 400 when both toTrackId and mood are given, and when neither is given", async () => {
            const bothReq = {
                body: {
                    fromTrackId: "from-1",
                    toTrackId: "dest-1",
                    mood: "happy",
                },
                user: { id: "user-1" },
            } as any;
            const bothRes = createRes();
            await journeyHandler(bothReq, bothRes);
            expect(bothRes.statusCode).toBe(400);

            const neitherReq = {
                body: { fromTrackId: "from-1" },
                user: { id: "user-1" },
            } as any;
            const neitherRes = createRes();
            await journeyHandler(neitherReq, neitherRes);
            expect(neitherRes.statusCode).toBe(400);

            expect(mockQueryRaw).not.toHaveBeenCalled();
        });

        it("returns 404 when fromTrackId has no embedding", async () => {
            mockQueryRaw.mockResolvedValueOnce([]); // fromTrackId embedding lookup

            const req = {
                body: { fromTrackId: "missing-track", toTrackId: "dest-1" },
                user: { id: "user-1" },
            } as any;
            const res = createRes();
            await journeyHandler(req, res);

            expect(res.statusCode).toBe(404);
            expect(res.body.error).toBe("Starting track has no embedding");
        });

        it("returns 404 when the destination mood has fewer than 5 embedded tracks", async () => {
            mockQueryRaw.mockResolvedValueOnce([{ embedding: "[1,0,0]" }]); // fromTrackId embedding
            mockMoodBucketFindMany.mockResolvedValueOnce([
                { trackId: "sad-1" },
                { trackId: "sad-2" },
            ]); // only 2 qualifying mood-bucket tracks

            const req = {
                body: { fromTrackId: "from-1", mood: "sad" },
                user: { id: "user-1" },
            } as any;
            const res = createRes();
            await journeyHandler(req, res);

            expect(res.statusCode).toBe(404);
            expect(mockMoodBucketFindMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        track: expect.objectContaining({
                            embeddings: {
                                some: { spaceId: "space-active" },
                            },
                        }),
                    }),
                }),
            );
            // The pool short-circuits below the floor: only the fromTrackId
            // embedding lookup ever hits the raw-query boundary.
            expect(mockQueryRaw).toHaveBeenCalledTimes(1);
        });

        it("returns 404 when pool tracks lose their embeddings between the pool query and the embedding fetch", async () => {
            mockQueryRaw
                .mockResolvedValueOnce([{ embedding: "[1,0,0]" }]) // fromTrackId embedding
                .mockResolvedValueOnce([
                    // 5 pool entries qualified, but only 4 embedding rows
                    // still exist by the time they're fetched (cascade delete
                    // race) — not enough vectors for an honest centroid.
                    { trackId: "sad-1", embedding: "[0,1,0]" },
                    { trackId: "sad-2", embedding: "[0,1,0]" },
                    { trackId: "sad-3", embedding: "[0,1,0]" },
                    { trackId: "sad-4", embedding: "[0,1,0]" },
                ]);
            mockMoodBucketFindMany.mockResolvedValueOnce([
                { trackId: "sad-1" },
                { trackId: "sad-2" },
                { trackId: "sad-3" },
                { trackId: "sad-4" },
                { trackId: "sad-5" },
            ]);

            const req = {
                body: { fromTrackId: "from-1", mood: "sad" },
                user: { id: "user-1" },
            } as any;
            const res = createRes();
            await journeyHandler(req, res);

            expect(res.statusCode).toBe(404);
            expect(mockRunAnnQuery).not.toHaveBeenCalled();
        });

        it("track mode: returns waypoints ending at the destination track", async () => {
            mockQueryRaw
                .mockResolvedValueOnce([{ embedding: "[1,0,0]" }]) // fromTrackId
                .mockResolvedValueOnce([{ embedding: "[0,0,1]" }]); // toTrackId
            mockTrackFindUnique.mockResolvedValueOnce({
                id: "dest-1",
                title: "Destination Song",
                album: {
                    id: "album-dest",
                    title: "Album Dest",
                    coverUrl: null,
                    artist: { id: "artist-dest", name: "Artist Dest" },
                },
            });
            mockRunAnnQuery
                .mockResolvedValueOnce([
                    nearestRow({ id: "mid-1", title: "Mid One" }),
                ])
                .mockResolvedValueOnce([
                    nearestRow({ id: "mid-2", title: "Mid Two" }),
                ]);

            const req = {
                body: { fromTrackId: "from-1", toTrackId: "dest-1", steps: 3 },
                user: { id: "user-1" },
            } as any;
            const res = createRes();
            await journeyHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body.mode).toBe("track");
            expect(res.body.target).toEqual({
                trackId: "dest-1",
                title: "Destination Song",
            });
            expect(res.body.waypoints).toHaveLength(3);
            expect(res.body.waypoints[res.body.waypoints.length - 1].id).toBe(
                "dest-1",
            );
        });

        it("track mode: every waypoint (intermediate and destination) carries nullable audioFeatures", async () => {
            mockQueryRaw
                .mockResolvedValueOnce([{ embedding: "[1,0,0]" }]) // fromTrackId
                .mockResolvedValueOnce([{ embedding: "[0,0,1]" }]); // toTrackId
            mockTrackFindUnique.mockResolvedValueOnce({
                id: "dest-1",
                title: "Destination Song",
                energy: 0.9,
                valence: 0.4,
                danceability: 0.6,
                arousal: 0.5,
                album: {
                    id: "album-dest",
                    title: "Album Dest",
                    coverUrl: null,
                    artist: { id: "artist-dest", name: "Artist Dest" },
                },
            });
            mockRunAnnQuery.mockResolvedValueOnce([
                nearestRow({
                    id: "mid-1",
                    title: "Mid One",
                    energy: 0.2,
                    valence: null,
                    danceability: 0.7,
                    arousal: null,
                }),
            ]);

            const req = {
                body: { fromTrackId: "from-1", toTrackId: "dest-1", steps: 2 },
                user: { id: "user-1" },
            } as any;
            const res = createRes();
            await journeyHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body.waypoints[0].audioFeatures).toEqual({
                energy: 0.2,
                valence: null,
                danceability: 0.7,
                arousal: null,
            });
            // The literal destination waypoint (built from prisma.track.findUnique,
            // not the ANN row) carries the destination track's own columns.
            expect(res.body.waypoints[1].audioFeatures).toEqual({
                energy: 0.9,
                valence: 0.4,
                danceability: 0.6,
                arousal: 0.5,
            });
        });

        it("returns 404 when the destination track is deleted between the embedding lookup and the track fetch (TOCTOU)", async () => {
            mockQueryRaw
                .mockResolvedValueOnce([{ embedding: "[1,0,0]" }]) // fromTrackId embedding
                .mockResolvedValueOnce([{ embedding: "[0,0,1]" }]); // toTrackId embedding still resolves
            mockTrackFindUnique.mockResolvedValueOnce(null); // but the Track row is gone by the time we look it up

            const req = {
                body: { fromTrackId: "from-1", toTrackId: "dest-1" },
                user: { id: "user-1" },
            } as any;
            const res = createRes();
            await journeyHandler(req, res);

            expect(res.statusCode).toBe(404);
            expect(res.body.error).toBe("Destination track not found");
            // Must not fall through and silently compute a route with a dropped
            // destination waypoint.
            expect(mockRunAnnQuery).not.toHaveBeenCalled();
        });

        it("returns 400 when fromTrackId equals toTrackId", async () => {
            const req = {
                body: { fromTrackId: "same-1", toTrackId: "same-1" },
                user: { id: "user-1" },
            } as any;
            const res = createRes();
            await journeyHandler(req, res);

            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe(
                "Origin and destination are the same track",
            );
            expect(mockQueryRaw).not.toHaveBeenCalled();
        });

        it("returns 400 when steps is not an integer", async () => {
            const req = {
                body: {
                    fromTrackId: "from-1",
                    toTrackId: "dest-1",
                    steps: "abc",
                },
                user: { id: "user-1" },
            } as any;
            const res = createRes();
            await journeyHandler(req, res);

            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe("steps must be an integer");
            expect(mockQueryRaw).not.toHaveBeenCalled();
        });

        it("returns 400 when excludeTrackIds contains an empty identifier", async () => {
            const req = {
                body: {
                    fromTrackId: "from-1",
                    toTrackId: "dest-1",
                    excludeTrackIds: ["valid-id", ""],
                },
                user: { id: "user-1" },
            } as any;
            const res = createRes();

            await journeyHandler(req, res);

            expect(res.statusCode).toBe(400);
            expect(res.body.error).toBe(
                "excludeTrackIds must contain non-empty strings",
            );
            expect(mockQueryRaw).not.toHaveBeenCalled();
        });

        it("clamps steps below the minimum up to 2", async () => {
            mockQueryRaw
                .mockResolvedValueOnce([{ embedding: "[1,0,0]" }])
                .mockResolvedValueOnce([{ embedding: "[0,0,1]" }]);
            mockTrackFindUnique.mockResolvedValueOnce({
                id: "dest-1",
                title: "Destination Song",
                album: {
                    id: "album-dest",
                    title: "Album Dest",
                    coverUrl: null,
                    artist: { id: "artist-dest", name: "Artist Dest" },
                },
            });
            mockRunAnnQuery.mockResolvedValueOnce([
                nearestRow({ id: "mid-1" }),
            ]);

            const req = {
                body: { fromTrackId: "from-1", toTrackId: "dest-1", steps: 1 },
                user: { id: "user-1" },
            } as any;
            const res = createRes();
            await journeyHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body.waypoints).toHaveLength(2);
            expect(res.body.waypoints[1].id).toBe("dest-1");
        });

        it("clamps steps above the maximum down to 20", async () => {
            mockQueryRaw
                .mockResolvedValueOnce([{ embedding: "[1,0,0]" }])
                .mockResolvedValueOnce([{ embedding: "[0,0,1]" }]);
            mockTrackFindUnique.mockResolvedValueOnce({
                id: "dest-1",
                title: "Destination Song",
                album: {
                    id: "album-dest",
                    title: "Album Dest",
                    coverUrl: null,
                    artist: { id: "artist-dest", name: "Artist Dest" },
                },
            });

            let call = 0;
            mockRunAnnQuery.mockImplementation(() => {
                call += 1;
                return Promise.resolve([
                    nearestRow({ id: `step-${call}`, title: `Step ${call}` }),
                ]);
            });

            const req = {
                body: { fromTrackId: "from-1", toTrackId: "dest-1", steps: 50 },
                user: { id: "user-1" },
            } as any;
            const res = createRes();
            await journeyHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body.waypoints).toHaveLength(20);
            expect(res.body.waypoints[19].id).toBe("dest-1");
        });

        it("mood mode: returns waypoints toward the mood centroid", async () => {
            mockQueryRaw
                .mockResolvedValueOnce([{ embedding: "[1,0,0]" }]) // fromTrackId embedding
                .mockResolvedValueOnce([
                    { trackId: "happy-1", embedding: "[0,1,0]" },
                    { trackId: "happy-2", embedding: "[0,1,0]" },
                    { trackId: "happy-3", embedding: "[0,1,0]" },
                    { trackId: "happy-4", embedding: "[0,1,0]" },
                    { trackId: "happy-5", embedding: "[0,1,0]" },
                ]); // service-layer embedding fetch for the pool ids
            mockMoodBucketFindMany.mockResolvedValueOnce([
                { trackId: "happy-1" },
                { trackId: "happy-2" },
                { trackId: "happy-3" },
                { trackId: "happy-4" },
                { trackId: "happy-5" },
            ]); // Prisma mood-bucket pool, >=5 qualifying tracks
            mockRunAnnQuery
                .mockResolvedValueOnce([
                    nearestRow({ id: "way-1", title: "Way One" }),
                ])
                .mockResolvedValueOnce([
                    nearestRow({ id: "way-2", title: "Way Two" }),
                ]);

            const req = {
                body: { fromTrackId: "from-1", mood: "happy", steps: 2 },
                user: { id: "user-1" },
            } as any;
            const res = createRes();
            await journeyHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body.mode).toBe("mood");
            expect(res.body.target).toEqual({
                mood: "happy",
                label: "Happy & Upbeat",
            });
            expect(res.body.waypoints).toHaveLength(2);
            expect(res.body.waypoints[0]).toEqual(
                expect.objectContaining({ id: "way-1" }),
            );
        });

        it("never returns an excluded track id as a waypoint", async () => {
            mockQueryRaw
                .mockResolvedValueOnce([{ embedding: "[1,0,0]" }]) // fromTrackId
                .mockResolvedValueOnce([{ embedding: "[0,0,1]" }]); // toTrackId
            mockTrackFindUnique.mockResolvedValueOnce({
                id: "dest-1",
                title: "Destination Song",
                album: {
                    id: "album-dest",
                    title: "Album Dest",
                    coverUrl: null,
                    artist: { id: "artist-dest", name: "Artist Dest" },
                },
            });

            const candidatePool = [
                nearestRow({
                    id: "blocked-1",
                    title: "Blocked",
                    distance: 0.05,
                }),
                nearestRow({ id: "cand-1", title: "Cand One", distance: 0.1 }),
                nearestRow({ id: "cand-2", title: "Cand Two", distance: 0.12 }),
                nearestRow({
                    id: "cand-3",
                    title: "Cand Three",
                    distance: 0.14,
                }),
            ];

            // Simulate the real ANN query's `WHERE te.track_id != ALL(excludeIds)`
            // at the boundary: honor whichever exclude-id array the route actually
            // threads through the Prisma.sql template, so a bug that drops
            // excludeTrackIds surfaces as a blocked id in the response body.
            mockRunAnnQuery.mockImplementation((sqlObj: any) => {
                const excluded = new Set(
                    (sqlObj.values as unknown[])
                        .filter(
                            (v): v is string[] =>
                                Array.isArray(v) &&
                                (v.length === 0 || typeof v[0] === "string"),
                        )
                        .flat(),
                );
                const remaining = candidatePool.filter(
                    (c) => !excluded.has(c.id as string),
                );
                return Promise.resolve(
                    remaining.length > 0 ? [remaining[0]] : [],
                );
            });

            const req = {
                body: {
                    fromTrackId: "from-1",
                    toTrackId: "dest-1",
                    steps: 3,
                    excludeTrackIds: ["blocked-1"],
                },
                user: { id: "user-1" },
            } as any;
            const res = createRes();
            await journeyHandler(req, res);

            expect(res.statusCode).toBe(200);
            const ids = res.body.waypoints.map((w: any) => w.id);
            expect(ids).not.toContain("blocked-1");
            // steps: 3 => 2 intermediate ANN-walked waypoints, then the literal
            // destination appended as the final waypoint (never re-derived via ANN).
            expect(ids).toEqual(["cand-1", "cand-2", "dest-1"]);
        });
    });

    describe("GET /moods", () => {
        it("returns trackCount for every canonical mood, defaulting missing moods to 0", async () => {
            mockMoodBucketGroupBy.mockResolvedValueOnce([
                { mood: "happy", _count: { _all: 42 } },
                { mood: "chill", _count: { _all: 7 } },
            ]);

            const req = { user: { id: "user-1" } } as any;
            const res = createRes();
            await moodsHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body).toHaveLength(9);
            expect(res.body).toEqual(
                expect.arrayContaining([
                    { mood: "happy", trackCount: 42 },
                    { mood: "chill", trackCount: 7 },
                    { mood: "sad", trackCount: 0 },
                    { mood: "energetic", trackCount: 0 },
                    { mood: "party", trackCount: 0 },
                    { mood: "focus", trackCount: 0 },
                    { mood: "melancholy", trackCount: 0 },
                    { mood: "aggressive", trackCount: 0 },
                    { mood: "acoustic", trackCount: 0 },
                ]),
            );
            expect(mockMoodBucketGroupBy).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        track: expect.objectContaining({
                            embeddings: {
                                some: { spaceId: "space-active" },
                            },
                        }),
                    }),
                }),
            );
        });
    });
});
