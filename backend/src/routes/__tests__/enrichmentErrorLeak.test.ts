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

jest.mock("../../config", () => ({
    config: {
        features: {
            audioAnalysis: true,
            discovery: true,
            autoPlaylists: true,
        },
    },
}));

const prisma = {
    artist: {
        findUnique: jest.fn(),
        update: jest.fn(),
        findFirst: jest.fn(),
    },
    album: {
        findUnique: jest.fn(),
        update: jest.fn(),
        findFirst: jest.fn(),
    },
    track: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
    systemSettings: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
    },
    ownedAlbum: {
        deleteMany: jest.fn(),
        upsert: jest.fn(),
    },
    user: {
        findMany: jest.fn(async () => []),
    },
};

jest.mock("../../utils/db", () => ({ prisma }));

import router from "../enrichment";
import { triggerEnrichmentNow } from "../../workers/unifiedEnrichment";
import { enrichmentStateService } from "../../services/enrichmentState";

const mockTriggerEnrichmentNow = triggerEnrichmentNow as jest.Mock;
const mockPause = enrichmentStateService.pause as jest.Mock;

function getRouteHandler(
    path: string,
    method: "get" | "post" | "put" | "delete",
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
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

const SECRET_ERROR = new Error("postgres://user:pw@db SECRET_LEAK_MARKER");
const req = {
    user: { id: "user-1" },
    params: {},
    query: {},
    body: {},
};

describe("enrichment route errors do not disclose caught values", () => {
    it("returns a curated sync error", async () => {
        mockTriggerEnrichmentNow.mockRejectedValueOnce(SECRET_ERROR);
        const res = createRes();

        await getRouteHandler("/sync", "post")(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body.error).toBe("Failed to start sync");
        expect(JSON.stringify(res.body)).not.toContain("SECRET_LEAK_MARKER");
        expect(res.body).not.toHaveProperty("details");
    });

    it("returns a curated pause error", async () => {
        mockPause.mockRejectedValueOnce(SECRET_ERROR);
        const res = createRes();

        await getRouteHandler("/pause", "post")(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBe("Failed to pause enrichment");
        expect(JSON.stringify(res.body)).not.toContain("SECRET_LEAK_MARKER");
        expect(res.body).not.toHaveProperty("details");
    });

    it("responds safely when pause rejects with null", async () => {
        mockPause.mockRejectedValueOnce(null);
        const res = createRes();

        await getRouteHandler("/pause", "post")(req, res);

        expect(res.json).toHaveBeenCalledWith({
            error: "Failed to pause enrichment",
        });
        expect(JSON.stringify(res.body)).not.toContain("SECRET_LEAK_MARKER");
    });
});
