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
// Calibration itself never touches this helper (it uses a plain
// `ORDER BY random()` prisma.$queryRaw, not an ANN `<=>` query), but it's
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

    it("returns 101 monotonic quantiles and caches the computed sample", async () => {
        mockQueryRaw
            .mockResolvedValueOnce([{ count: 50 }]) // embeddedCount
            .mockResolvedValueOnce(embeddingRows(12)); // random sample

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await calibrationHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.sampleSize).toBe(12);
        expect(typeof res.body.updatedAt).toBe("string");
        expect(res.body.quantiles).toHaveLength(101);
        expect(isMonotonicNonDecreasing(res.body.quantiles)).toBe(true);

        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "vibe:calibration:v1:50",
            86400,
            expect.any(String)
        );
        const cachedPayload = JSON.parse(mockRedisSetEx.mock.calls[0][2]);
        expect(cachedPayload.quantiles).toHaveLength(101);
    });

    it("skips recomputation on a cache hit (query count doesn't grow)", async () => {
        mockQueryRaw
            .mockResolvedValueOnce([{ count: 50 }])
            .mockResolvedValueOnce(embeddingRows(12));

        const req = { user: { id: "user-1" } } as any;
        const firstRes = createRes();
        await calibrationHandler(req, firstRes);

        expect(mockQueryRaw).toHaveBeenCalledTimes(2); // count + random sample
        const cachedPayload = mockRedisSetEx.mock.calls[0][2];

        mockQueryRaw.mockClear();
        mockRedisSetEx.mockClear();
        mockQueryRaw.mockResolvedValueOnce([{ count: 50 }]); // count only, same key
        mockRedisGet.mockResolvedValueOnce(cachedPayload);

        const secondRes = createRes();
        await calibrationHandler(req, secondRes);

        expect(secondRes.statusCode).toBe(200);
        expect(secondRes.body).toEqual(JSON.parse(cachedPayload));
        // Only the embeddedCount lookup ran; the expensive random sample +
        // pairwise-distance computation was skipped on the cache hit.
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
        expect(mockRedisSetEx).not.toHaveBeenCalled();
    });

    it("returns sampleSize 0 and empty quantiles when fewer than 10 tracks are embedded", async () => {
        mockQueryRaw.mockResolvedValueOnce([{ count: 9 }]);

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await calibrationHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ sampleSize: 0, quantiles: [] });
        // The cache/sample path never runs below the floor.
        expect(mockRedisGet).not.toHaveBeenCalled();
        expect(mockQueryRaw).toHaveBeenCalledTimes(1);
    });
});
