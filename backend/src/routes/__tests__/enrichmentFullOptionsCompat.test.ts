import { Request, Response } from "express";

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
    runFullEnrichment: jest.fn().mockResolvedValue({
        artists: 0,
        tracks: 0,
        audioQueued: 0,
    }),
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

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
    invalidateSystemSettingsCache: jest.fn(),
}));

jest.mock("../../services/rateLimiter", () => ({
    rateLimiter: {
        updateConcurrencyMultiplier: jest.fn(),
    },
}));

jest.mock("../../utils/db", () => ({
    prisma: {
        artist: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            update: jest.fn(),
        },
        album: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            update: jest.fn(),
        },
        track: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        systemSettings: {
            upsert: jest.fn(),
            findUnique: jest.fn(),
        },
        ownedAlbum: {
            deleteMany: jest.fn(),
            upsert: jest.fn(),
        },
        user: {
            findMany: jest.fn().mockResolvedValue([]),
        },
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        del: jest.fn(),
    },
}));

import router from "../enrichment";
import { runFullEnrichment } from "../../workers/unifiedEnrichment";

const mockRunFullEnrichment = runFullEnrichment as jest.Mock;

function getPostHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.post
    );

    if (!layer) {
        throw new Error(`Route not found: POST ${path}`);
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

describe("enrichment full options compatibility", () => {
    const fullEnrichmentHandler = getPostHandler("/full");

    beforeEach(() => {
        jest.clearAllMocks();
        mockRunFullEnrichment.mockResolvedValue({
            artists: 0,
            tracks: 0,
            audioQueued: 0,
        });
    });

    it("forwards forceVibeRebuild and forceMoodBucketBackfill flags to the worker", async () => {
        const req = {
            body: {
                forceVibeRebuild: true,
                forceMoodBucketBackfill: true,
            },
            user: { id: "admin-user", role: "admin" },
        } as any;
        const res = createRes();

        await fullEnrichmentHandler(req, res);

        expect(mockRunFullEnrichment).toHaveBeenCalledWith({
            forceVibeRebuild: true,
            forceMoodBucketBackfill: true,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                forceVibeRebuild: true,
                forceMoodBucketBackfill: true,
            })
        );
    });

    it("defaults both flags to false when omitted", async () => {
        const req = {
            body: {},
            user: { id: "admin-user", role: "admin" },
        } as any;
        const res = createRes();

        await fullEnrichmentHandler(req, res);

        expect(mockRunFullEnrichment).toHaveBeenCalledWith({
            forceVibeRebuild: false,
            forceMoodBucketBackfill: false,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                forceVibeRebuild: false,
                forceMoodBucketBackfill: false,
            })
        );
    });

    it("keeps non-boolean inputs as disabled flags", async () => {
        const req = {
            body: { forceVibeRebuild: "true", forceMoodBucketBackfill: 1 },
            user: { id: "admin-user", role: "admin" },
        } as any;
        const res = createRes();

        await fullEnrichmentHandler(req, res);

        expect(mockRunFullEnrichment).toHaveBeenCalledWith({
            forceVibeRebuild: false,
            forceMoodBucketBackfill: false,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                forceVibeRebuild: false,
                forceMoodBucketBackfill: false,
            })
        );
    });
});
