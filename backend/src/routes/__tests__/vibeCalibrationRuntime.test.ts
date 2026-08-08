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
        trackEmbedding: {
            count: jest.fn(),
            findMany: jest.fn(),
        },
        moodBucket: {
            groupBy: jest.fn(),
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
        get: jest.fn(),
        setEx: jest.fn(),
    },
}));

jest.mock("../../services/hybridSimilarity", () => ({
    findSimilarTracks: jest.fn(),
}));

// Same boundary as the sibling vibe*.test.ts files: the ivfflat-probes ANN
// helper is mocked so these tests assert route BEHAVIOUR on canned rows.
// Calibration itself never touches this helper (its sampling is an id-only
// Prisma scan plus a primary-key fetch, not an ANN `<=>` query), but it's
// mocked here anyway since importing ../vibe pulls it in at module load.
jest.mock("../../utils/annQuery", () => ({
    runAnnQuery: jest.fn(),
}));

jest.mock("../../services/umapProjection", () => ({
    computeMapProjection: jest.fn(),
}));

jest.mock("../../utils/embedding", () => ({
    parseEmbedding: jest.fn((text: string) => {
        const values = text.replace(/[\[\]]/g, "").split(",").map(Number);
        return values;
    }),
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

const mockEmbeddingCount = prisma.trackEmbedding.count as jest.Mock;
const mockEmbeddingFindMany = prisma.trackEmbedding.findMany as jest.Mock;
const mockQueryRaw = prisma.$queryRaw as jest.Mock;
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;

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

// Deterministic, varied unit-ish vectors so pairwise cosine distance spans a
// real range instead of all being identical (a degenerate all-equal set
// would make the monotonic assertion trivially true).
function embeddingRows(count: number) {
    return Array.from({ length: count }, (_, i) => ({
        embedding: `[${Math.cos(i)},${Math.sin(i)},${0.25 * i}]`,
    }));
}

function idRows(count: number) {
    return Array.from({ length: count }, (_, i) => ({ trackId: `track-${i}` }));
}

function isMonotonicNonDecreasing(values: number[]): boolean {
    return values.every((v, i) => i === 0 || v >= values[i - 1]);
}

describe("vibe calibration runtime", () => {
    const calibrationHandler = getGetHandler("/calibration");

    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue("OK");
    });

    it("returns 101 monotonic quantiles from a bounded sample and caches the result", async () => {
        mockEmbeddingCount.mockResolvedValueOnce(50);
        mockEmbeddingFindMany.mockResolvedValueOnce(idRows(12)); // id-only scan
        mockQueryRaw.mockResolvedValueOnce(embeddingRows(12)); // primary-key fetch

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await calibrationHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.sampleSize).toBe(12);
        expect(typeof res.body.updatedAt).toBe("string");
        expect(res.body.quantiles).toHaveLength(101);
        expect(isMonotonicNonDecreasing(res.body.quantiles)).toBe(true);

        // The id scan is bounded and index-ordered — never a full-table
        // random sort touching the vector column.
        expect(mockEmbeddingFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                select: { trackId: true },
                orderBy: { trackId: "asc" },
                take: expect.any(Number),
            })
        );

        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "vibe:calibration:v1:50",
            86400,
            expect.any(String)
        );
        const cachedPayload = JSON.parse(mockRedisSetEx.mock.calls[0][2]);
        expect(cachedPayload.quantiles).toHaveLength(101);
    });

    it("skips recomputation on a cache hit (no id scan, no embedding fetch)", async () => {
        mockEmbeddingCount.mockResolvedValueOnce(50);
        mockEmbeddingFindMany.mockResolvedValueOnce(idRows(12));
        mockQueryRaw.mockResolvedValueOnce(embeddingRows(12));

        const req = { user: { id: "user-1" } } as any;
        const firstRes = createRes();
        await calibrationHandler(req, firstRes);

        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
        const cachedPayload = mockRedisSetEx.mock.calls[0][2];

        mockQueryRaw.mockClear();
        mockEmbeddingFindMany.mockClear();
        mockRedisSetEx.mockClear();
        mockEmbeddingCount.mockResolvedValueOnce(50); // same key
        mockRedisGet.mockResolvedValueOnce(cachedPayload);

        const secondRes = createRes();
        await calibrationHandler(req, secondRes);

        expect(secondRes.statusCode).toBe(200);
        expect(secondRes.body).toEqual(JSON.parse(cachedPayload));
        // The expensive sample + pairwise-distance computation was skipped.
        expect(mockEmbeddingFindMany).not.toHaveBeenCalled();
        expect(mockQueryRaw).not.toHaveBeenCalled();
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("rejects an invalid cached payload and recomputes calibration", async () => {
        mockEmbeddingCount.mockResolvedValueOnce(50);
        mockRedisGet.mockResolvedValueOnce(
            JSON.stringify({
                sampleSize: 12,
                updatedAt: "2026-08-07T00:00:00.000Z",
                quantiles: [null],
            })
        );
        mockEmbeddingFindMany.mockResolvedValueOnce(idRows(12));
        mockQueryRaw.mockResolvedValueOnce(embeddingRows(12));

        const res = createRes();
        await calibrationHandler({ user: { id: "user-1" } } as any, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.quantiles).toHaveLength(101);
        expect(res.body.quantiles.every(Number.isFinite)).toBe(true);
        expect(mockEmbeddingFindMany).toHaveBeenCalledTimes(1);
        expect(mockRedisSetEx).toHaveBeenCalledTimes(1);
    });

    it("returns sampleSize 0 and empty quantiles when fewer than 10 tracks are embedded", async () => {
        mockEmbeddingCount.mockResolvedValueOnce(9);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await calibrationHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ sampleSize: 0, quantiles: [] });
        // The cache/sample path never runs below the floor.
        expect(mockRedisGet).not.toHaveBeenCalled();
        expect(mockEmbeddingFindMany).not.toHaveBeenCalled();
        expect(mockQueryRaw).not.toHaveBeenCalled();
    });

    it("collapses concurrent cold-cache requests into a single compute (single-flight)", async () => {
        // Both requests miss the cache; the embedding fetch is held open until
        // both are in flight, so a second compute would be observable as a
        // second id scan / raw fetch.
        mockEmbeddingCount.mockResolvedValue(50);
        mockRedisGet.mockResolvedValue(null);
        mockEmbeddingFindMany.mockResolvedValue(idRows(12));

        let releaseFetch!: (rows: { embedding: string }[]) => void;
        const heldFetch = new Promise<{ embedding: string }[]>((resolve) => {
            releaseFetch = resolve;
        });
        mockQueryRaw.mockImplementation(() => heldFetch);

        const req = { user: { id: "user-1" } } as any;
        const resA = createRes();
        const resB = createRes();
        const inFlightA = calibrationHandler(req, resA);
        const inFlightB = calibrationHandler(req, resB);

        releaseFetch(embeddingRows(12));
        await Promise.all([inFlightA, inFlightB]);

        // One compute served both callers: one id scan, one embedding fetch,
        // one cache write — and identical payloads.
        expect(mockEmbeddingFindMany).toHaveBeenCalledTimes(1);
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
        expect(mockRedisSetEx).toHaveBeenCalledTimes(1);
        expect(resA.statusCode).toBe(200);
        expect(resB.statusCode).toBe(200);
        expect(resA.body).toEqual(resB.body);
        expect(resA.body.sampleSize).toBe(12);

        // The single-flight slot is released afterwards: a later cold-cache
        // request computes fresh instead of reusing a dead promise.
        mockQueryRaw.mockResolvedValueOnce(embeddingRows(12));
        const resC = createRes();
        await calibrationHandler(req, resC);
        expect(mockEmbeddingFindMany).toHaveBeenCalledTimes(2);
        expect(resC.statusCode).toBe(200);
    });

    it("a failed compute clears the single-flight slot so the next request retries", async () => {
        mockEmbeddingCount.mockResolvedValue(50);
        mockRedisGet.mockResolvedValue(null);
        mockEmbeddingFindMany.mockResolvedValue(idRows(12));
        mockQueryRaw.mockRejectedValueOnce(new Error("pg exploded"));

        const req = { user: { id: "user-1" } } as any;
        const failedRes = createRes();
        await calibrationHandler(req, failedRes);
        expect(failedRes.statusCode).toBe(500);

        mockQueryRaw.mockResolvedValueOnce(embeddingRows(12));
        const retryRes = createRes();
        await calibrationHandler(req, retryRes);
        expect(retryRes.statusCode).toBe(200);
        expect(retryRes.body.sampleSize).toBe(12);
    });

    it("fails explicitly when the sampled embeddings disappear mid-compute", async () => {
        mockEmbeddingCount.mockResolvedValueOnce(50);
        mockEmbeddingFindMany.mockResolvedValueOnce(idRows(12));
        mockQueryRaw.mockResolvedValueOnce(embeddingRows(5));

        const res = createRes();
        await calibrationHandler({ user: { id: "user-1" } } as any, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to compute vibe calibration" });
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });
});
