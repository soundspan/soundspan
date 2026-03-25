import type { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
    requireAdmin: (_req: Request, _res: Response, next: () => void) => next(),
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
        album: {
            findMany: jest.fn(),
        },
    },
}));

jest.mock("../../services/coverArt", () => ({
    coverArtService: {
        clearNotFoundCache: jest.fn(),
    },
}));

jest.mock("../../services/enrichment", () => ({
    enrichmentService: {
        getSettings: jest.fn(),
        updateSettings: jest.fn(),
        enrichArtist: jest.fn(),
        applyArtistEnrichment: jest.fn(),
        enrichAlbum: jest.fn(),
        applyAlbumEnrichment: jest.fn(),
    },
}));

jest.mock("../../workers/unifiedEnrichment", () => ({
    getEnrichmentProgress: jest.fn(),
    runFullEnrichment: jest.fn(),
    reRunArtistsOnly: jest.fn(),
    reRunMoodTagsOnly: jest.fn(),
    reRunAudioAnalysisOnly: jest.fn(),
    reRunVibeEmbeddingsOnly: jest.fn(),
    triggerEnrichmentNow: jest.fn(),
}));

jest.mock("../../services/enrichmentState", () => ({
    enrichmentStateService: {
        getState: jest.fn(),
        pause: jest.fn(),
        resume: jest.fn(),
        stop: jest.fn(),
    },
}));

jest.mock("../../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {
        getFailures: jest.fn(),
        getFailureCounts: jest.fn(),
        resetRetryCount: jest.fn(),
        getFailure: jest.fn(),
        resolveFailures: jest.fn(),
        skipFailures: jest.fn(),
        clearAllFailures: jest.fn(),
        deleteFailures: jest.fn(),
    },
}));

jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        searchArtist: jest.fn(),
        searchReleaseGroups: jest.fn(),
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
    invalidateSystemSettingsCache: jest.fn(),
}));

jest.mock("../../services/rateLimiter", () => ({
    rateLimiter: {
        updateConcurrencyMultiplier: jest.fn(),
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        del: jest.fn(),
    },
}));

import router from "../enrichment";
import { prisma } from "../../utils/db";
import { coverArtService } from "../../services/coverArt";

const mockFindMany = prisma.album.findMany as jest.Mock;
const mockClearNotFoundCache = coverArtService.clearNotFoundCache as jest.Mock;

type RouteHandler = (req: unknown, res: unknown) => Promise<void>;

function getHandler(path: string, method: "post") {
    const stack = (
        router as unknown as {
            stack: Array<{
                route?: {
                    path?: string;
                    methods?: Record<string, boolean>;
                    stack: Array<{ handle: RouteHandler }>;
                };
            }>;
        }
    ).stack;

    const layer = stack.find(
        (entry) =>
            entry.route?.path === path && Boolean(entry.route?.methods?.[method])
    );
    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }
    return layer.route!.stack[layer.route!.stack.length - 1].handle;
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

describe("enrichment repair covers route", () => {
    const repairCoversHandler = getHandler("/repair-covers", "post");

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("returns album and cache clear counts", async () => {
        mockFindMany.mockResolvedValue([
            { id: "album-1", rgMbid: "rg-1" },
            { id: "album-2", rgMbid: null },
        ]);
        mockClearNotFoundCache.mockResolvedValue(undefined);

        const req = { user: { id: "admin-1" } };
        const res = createRes();

        await repairCoversHandler(req, res);

        expect(mockFindMany).toHaveBeenCalledWith({
            where: {
                OR: [{ coverUrl: null }, { coverUrl: "" }],
            },
            select: { id: true, rgMbid: true },
        });
        expect(mockClearNotFoundCache).toHaveBeenCalledTimes(1);
        expect(mockClearNotFoundCache).toHaveBeenCalledWith("rg-1");
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Cover repair initiated",
            description:
                "Found 2 albums missing covers, cleared 1 stale cache entries. Covers will be re-fetched on next access.",
            albumsMissingCovers: 2,
            cacheEntriesCleared: 1,
        });
    });

    it("returns 500 when album query fails", async () => {
        mockFindMany.mockRejectedValue(new Error("db error"));

        const req = { user: { id: "admin-1" } };
        const res = createRes();

        await repairCoversHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to repair covers" });
    });
});
