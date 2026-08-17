import { Request, Response } from "express";
import { invalidateTextEmbeddingProviderSpaceCache } from "../../services/textEmbedding";

const mockGetActiveSpace = jest.fn();
let mockVibeProviderUrl: string | undefined;
const mockProviderEmbedText = jest.fn();

jest.mock("../../config", () => ({
    config: {
        get vibeProviderUrl() {
            return mockVibeProviderUrl;
        },
    },
}));

jest.mock("../../services/vibeProvider", () => {
    class VibeProviderError extends Error {}
    return {
        embedText: (...args: unknown[]) => mockProviderEmbedText(...args),
        fetchProviderSpace: jest.fn(async () => ({
            family: "clap-music-audioset",
            checkpointHash: "checkpoint-hash",
            dim: 512,
            sampleRateHz: 48000,
            preprocessing: {},
            revision: "test",
            textTower: true,
        })),
        assertProviderMatchesActiveSpace: jest.fn(),
        VibeProviderError,
        VibeProviderTimeoutError: class VibeProviderTimeoutError extends VibeProviderError {},
        VibeProviderUnavailableError: class VibeProviderUnavailableError extends VibeProviderError {},
        VibeProviderAuthError: class VibeProviderAuthError extends VibeProviderError {},
        VibeProviderContractError: class VibeProviderContractError extends VibeProviderError {},
        VibeProviderSpaceMismatchError: class VibeProviderSpaceMismatchError extends VibeProviderError {},
    };
});

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

jest.mock("../../services/embeddingSpaces", () => ({
    getActiveSpace: (...args: unknown[]) => mockGetActiveSpace(...args),
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
    const statusHandler = getGetHandler("/status");

    beforeEach(() => {
        invalidateTextEmbeddingProviderSpaceCache();
        jest.clearAllMocks();
        mockVibeProviderUrl = undefined;
        mockRedisXAdd.mockResolvedValue("1712345-0");
        mockRedisDel.mockResolvedValue(1);
        mockGetActiveSpace.mockResolvedValue({ id: "space-active" });
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

    it("keeps the canonical timeout shape in provider mode", async () => {
        const { VibeProviderTimeoutError } = jest.requireMock(
            "../../services/vibeProvider",
        ) as { VibeProviderTimeoutError: new () => Error };
        mockVibeProviderUrl = "http://vibe-provider:8090";
        mockProviderEmbedText.mockRejectedValueOnce(
            new VibeProviderTimeoutError(),
        );
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
        expect(mockRedisXAdd).not.toHaveBeenCalled();
    });

    it("keeps the canonical error shape when no embedding space is active", async () => {
        mockGetActiveSpace.mockRejectedValueOnce(
            new Error("No active embedding space is configured"),
        );
        const res = createRes();

        await statusHandler({ user: { id: "user-1" } } as any, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to get embedding status",
        });
        expect(res.body).not.toHaveProperty("message");
    });
});
