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
    blockingBlPop: jest.fn(),
    redisClient: {
        xAdd: jest.fn(),
        del: jest.fn(),
    },
}));

jest.mock("../../services/hybridSimilarity", () => ({
    findSimilarTracks: jest.fn(),
}));

jest.mock("../../utils/annQuery", () => ({
    runAnnQuery: jest.fn(),
}));

jest.mock("../../services/umapProjection", () => ({
    computeMapProjection: jest.fn(),
}));

jest.mock("../../utils/embedding", () => ({
    parseEmbedding: jest.fn((text: string) => {
        const values = text
            .replace(/[\[\]]/g, "")
            .split(",")
            .map(Number);
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
import { blockingBlPop, redisClient } from "../../utils/redis";
import { findSimilarTracks } from "../../services/hybridSimilarity";

const mockRedisXAdd = redisClient.xAdd as jest.Mock;
const mockBlockingBlPop = blockingBlPop as jest.Mock;
const mockRedisDel = redisClient.del as jest.Mock;
const mockFindSimilarTracks = findSimilarTracks as jest.Mock;

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

describe("vibe canonical error response shape", () => {
    const similarHandler = getGetHandler("/similar/:trackId");
    const searchHandler = getPostHandler("/search");

    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisXAdd.mockResolvedValue("1712345-0");
        mockRedisDel.mockResolvedValue(1);
    });

    it("returns only the canonical error field when no similar tracks exist", async () => {
        mockFindSimilarTracks.mockResolvedValue([]);
        const req = {
            params: { trackId: "track-1" },
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await similarHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "No similar tracks found" });
        expect(res.body).not.toHaveProperty("message");
    });

    it("returns only the canonical error field when text embedding times out", async () => {
        mockBlockingBlPop.mockResolvedValue(null);
        const req = {
            body: { query: "quiet focus" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await searchHandler(req, res);

        expect(res.statusCode).toBe(504);
        expect(res.body).toEqual({
            error: "Text embedding service unavailable",
        });
        expect(res.body).not.toHaveProperty("message");
    });
});
