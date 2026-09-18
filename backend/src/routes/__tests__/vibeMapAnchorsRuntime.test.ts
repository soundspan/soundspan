import type { Request, Response } from "express";

const mockReadMapTrackIds = jest.fn();
const mockFetchTrackEmbedding = jest.fn();
const mockFindNearestAmongTracks = jest.fn();
const mockLoggerError = jest.fn();

const requireAuth = jest.fn((_req: Request, _res: Response, next: () => void) =>
    next(),
);

jest.mock("../../middleware/auth", () => ({
    requireAuth,
    requireAdmin: jest.fn((_req: Request, _res: Response, next: () => void) =>
        next(),
    ),
}));
jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: (...args: unknown[]) => mockLoggerError(...args),
    },
}));
jest.mock("../../services/umapProjection", () => ({
    computeMapProjection: jest.fn(),
    rebuildMapProjection: jest.fn(),
    readMapTrackIds: (...args: unknown[]) => mockReadMapTrackIds(...args),
}));
jest.mock("../../services/trackEmbeddings", () => ({
    countEmbeddedBrowsableTracks: jest.fn(),
    fetchEmbeddingsByTrackIds: jest.fn(),
    fetchTrackEmbedding: (...args: unknown[]) =>
        mockFetchTrackEmbedding(...args),
    findNearestAmongTracks: (...args: unknown[]) =>
        mockFindNearestAmongTracks(...args),
    findNearestToEmbedding: jest.fn(),
}));
jest.mock("../../utils/db", () => ({
    prisma: {
        track: { count: jest.fn(), findUnique: jest.fn() },
        trackEmbedding: { count: jest.fn(), findMany: jest.fn() },
        moodBucket: { groupBy: jest.fn(), findMany: jest.fn() },
        likedTrack: { findMany: jest.fn() },
        dislikedEntity: { findMany: jest.fn() },
        $queryRaw: jest.fn(),
    },
}));
jest.mock("../../utils/redis", () => ({
    redisClient: { get: jest.fn(), setEx: jest.fn() },
}));
jest.mock("../../services/hybridSimilarity", () => ({
    findSimilarTracks: jest.fn(),
}));
jest.mock("../../utils/annQuery", () => ({ runAnnQuery: jest.fn() }));
jest.mock("../../utils/embedding", () => ({
    blendEmbeddings: jest.fn(),
    lerpEmbedding: jest.fn(),
}));
jest.mock("../../services/embeddingSpaces", () => ({
    getActiveSpace: jest.fn(async () => ({ id: "space-active" })),
}));
jest.mock("../../services/moodBucketService", () => ({
    MOOD_CONFIG: {},
    VALID_MOODS: [],
    MOOD_BUCKET_MIN_SCORE: 0.5,
}));
jest.mock("../../services/textEmbedding", () => ({
    TextEmbeddingBadGatewayError: class TextEmbeddingBadGatewayError extends Error {},
    TextEmbeddingProviderError: class TextEmbeddingProviderError extends Error {},
    TextEmbeddingTimeoutError: class TextEmbeddingTimeoutError extends Error {},
    TextEmbeddingUnavailableError: class TextEmbeddingUnavailableError extends Error {},
}));
jest.mock("../../services/trackPreference", () => ({
    applyTrackPreferenceOrderBias: jest.fn(),
    applyTrackPreferenceSimilarityBias: jest.fn(),
    resolveTrackPreference: jest.fn(),
    TRACK_DISLIKE_ENTITY_TYPE: "track",
}));
jest.mock("../../services/vibeCalibration", () => ({
    CALIBRATION_MIN_EMBEDDED_TRACKS: 10,
    computeCalibration: jest.fn(),
    countEmbeddedTracks: jest.fn(),
    parseCachedCalibration: jest.fn(),
}));
jest.mock("../../services/vibeVocabulary", () => ({
    loadVocabulary: jest.fn(),
}));
jest.mock("../../services/vibeSearch", () => ({
    executeVibeSearch: jest.fn(),
    parseVibeSearchRequest: jest.fn(),
}));

import router from "../vibe";

const MAX_ROUTE_HANDLERS = 3;

function routeLayer() {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === "/map/anchors/:trackId" &&
            entry.route?.methods?.get,
    );
    if (!layer) throw new Error("GET route not found: /map/anchors/:trackId");
    return layer;
}

async function invokeRoute(req: any, res: any): Promise<void> {
    const stack = routeLayer().route.stack;
    if (stack.length > MAX_ROUTE_HANDLERS) {
        throw new Error(`Too many route handlers: ${stack.length}`);
    }
    for (let index = 0; index < MAX_ROUTE_HANDLERS; index += 1) {
        const entry = stack[index];
        if (!entry) return;
        let nextCalled = false;
        await entry.handle(req, res, () => {
            nextCalled = true;
        });
        if (!nextCalled) return;
    }
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status: jest.fn((code: number) => {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn((body: unknown) => {
            res.body = body;
            return res;
        }),
    };
    return res;
}

describe("vibe map anchors runtime", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockReadMapTrackIds.mockResolvedValue(
            new Set(["map-track-1", "map-track-2"]),
        );
    });

    it("short-circuits when the requested track is already on the map", async () => {
        const res = createRes();

        await invokeRoute(
            { params: { trackId: "map-track-1" }, query: {} },
            res,
        );

        expect(res.body).toEqual({
            trackId: "map-track-1",
            onMap: true,
            anchors: [],
        });
        expect(mockFetchTrackEmbedding).not.toHaveBeenCalled();
        expect(mockFindNearestAmongTracks).not.toHaveBeenCalled();
    });

    it("returns nearest map anchors for an off-map track", async () => {
        const embedding = [0.25, 0.75];
        const anchors = [{ id: "map-track-2", distance: 0.125 }];
        mockFetchTrackEmbedding.mockResolvedValue(embedding);
        mockFindNearestAmongTracks.mockResolvedValue(anchors);
        const res = createRes();

        await invokeRoute(
            { params: { trackId: "off-map-track" }, query: {} },
            res,
        );

        expect(res.body).toEqual({
            trackId: "off-map-track",
            onMap: false,
            anchors,
        });
        expect(mockFindNearestAmongTracks).toHaveBeenCalledWith(
            embedding,
            ["map-track-1", "map-track-2"],
            8,
        );
    });

    it("returns 404 when no map is cached", async () => {
        mockReadMapTrackIds.mockResolvedValue(new Set());
        const res = createRes();

        await invokeRoute(
            { params: { trackId: "off-map-track" }, query: {} },
            res,
        );

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "No vibe map is built yet" });
    });

    it("returns 404 when the track has no embedding", async () => {
        mockFetchTrackEmbedding.mockResolvedValue(null);
        const res = createRes();

        await invokeRoute(
            { params: { trackId: "off-map-track" }, query: {} },
            res,
        );

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Track has no embedding" });
        expect(mockFindNearestAmongTracks).not.toHaveBeenCalled();
    });

    it("returns 400 for an invalid track ID", async () => {
        const res = createRes();

        await invokeRoute(
            { params: { trackId: "invalid/id" }, query: {} },
            res,
        );

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Invalid trackId" });
        expect(mockReadMapTrackIds).not.toHaveBeenCalled();
    });

    it("returns 400 for an invalid limit", async () => {
        const res = createRes();

        await invokeRoute(
            { params: { trackId: "off-map-track" }, query: { limit: "17" } },
            res,
        );

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "limit must be an integer between 1 and 16",
        });
        expect(mockReadMapTrackIds).not.toHaveBeenCalled();
    });

    it("returns a canonical 500 and logs an unexpected service error", async () => {
        const error = new Error("redis unavailable");
        mockReadMapTrackIds.mockRejectedValue(error);
        const res = createRes();

        await invokeRoute(
            { params: { trackId: "off-map-track" }, query: {} },
            res,
        );

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to locate track on the map",
        });
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Vibe map anchor lookup error:",
            error,
        );
    });
});
