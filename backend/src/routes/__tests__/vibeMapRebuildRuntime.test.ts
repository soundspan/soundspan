import type { Request, Response } from "express";

const mockRebuildMapProjection = jest.fn();
const mockLoggerError = jest.fn();

const requireAuth = jest.fn((_req: Request, _res: Response, next: () => void) =>
    next(),
);
const requireAdmin = jest.fn(
    (req: Request, res: Response, next: () => void) => {
        if (req.user?.role !== "admin") {
            return res.status(403).json({ error: "Admin access required" });
        }
        next();
    },
);

jest.mock("../../middleware/auth", () => ({ requireAuth, requireAdmin }));
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
    rebuildMapProjection: (...args: unknown[]) =>
        mockRebuildMapProjection(...args),
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
jest.mock("../../services/trackEmbeddings", () => ({
    countEmbeddedBrowsableTracks: jest.fn(),
    fetchEmbeddingsByTrackIds: jest.fn(),
    fetchTrackEmbedding: jest.fn(),
    findNearestToEmbedding: jest.fn(),
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

const MAX_ROUTE_HANDLERS = 4;

function routeLayer() {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === "/map/rebuild" && entry.route?.methods?.post,
    );
    if (!layer) throw new Error("POST route not found: /map/rebuild");
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

describe("vibe map rebuild runtime", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("starts a rebuild for an administrator", async () => {
        mockRebuildMapProjection.mockResolvedValue({ outcome: "started" });
        const res = createRes();

        await invokeRoute({ user: { role: "admin" } }, res);

        expect(res.statusCode).toBe(202);
        expect(res.body).toEqual({ building: true, outcome: "started" });
        expect(mockRebuildMapProjection).toHaveBeenCalledTimes(1);
    });

    it("passes through the already-building outcome", async () => {
        mockRebuildMapProjection.mockResolvedValue({
            outcome: "already_building",
        });
        const res = createRes();

        await invokeRoute({ user: { role: "admin" } }, res);

        expect(res.statusCode).toBe(202);
        expect(res.body).toEqual({
            building: true,
            outcome: "already_building",
        });
    });

    it("returns the canonical error response when rebuilding fails", async () => {
        const error = new Error("redis unavailable");
        mockRebuildMapProjection.mockRejectedValue(error);
        const res = createRes();

        await invokeRoute({ user: { role: "admin" } }, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to rebuild map projection" });
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Vibe map rebuild error:",
            error,
        );
    });

    it("rejects a non-admin before reaching the rebuild handler", async () => {
        mockRebuildMapProjection.mockResolvedValue({ outcome: "started" });
        const res = createRes();

        await invokeRoute({ user: { role: "user" } }, res);

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ error: "Admin access required" });
        expect(requireAdmin).toHaveBeenCalledTimes(1);
        expect(mockRebuildMapProjection).not.toHaveBeenCalled();
    });
});
