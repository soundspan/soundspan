import express, { Request, Response } from "express";
import request from "supertest";

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
        child: jest.fn(() => ({
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        })),
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
        fanart: { apiKey: undefined },
        lastfm: { apiKey: "test-lastfm-key" },
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
import { enrichmentFailureService } from "../../services/enrichmentFailureService";

const mockGetFailures = enrichmentFailureService.getFailures as jest.Mock;
const app = express();
app.use("/api/enrichment", router);

describe("GET /api/enrichment/failures bounded query parameters", () => {
    beforeEach(() => {
        mockGetFailures.mockResolvedValue({ failures: [], total: 0 });
    });

    it("uses the default limit for a non-numeric value", async () => {
        const response = await request(app).get(
            "/api/enrichment/failures?limit=abc",
        );

        expect(response.status).toBe(200);
        expect(mockGetFailures).toHaveBeenCalledWith({
            limit: 100,
            offset: 0,
        });
    });

    it("clamps an oversized limit", async () => {
        await request(app).get("/api/enrichment/failures?limit=100000000");

        expect(mockGetFailures).toHaveBeenCalledWith({
            limit: 100,
            offset: 0,
        });
    });

    it("preserves valid limit and offset values", async () => {
        await request(app).get("/api/enrichment/failures?limit=25&offset=50");

        expect(mockGetFailures).toHaveBeenCalledWith({
            limit: 25,
            offset: 50,
        });
    });

    it("uses service-compatible defaults when parameters are omitted", async () => {
        await request(app).get("/api/enrichment/failures");

        expect(mockGetFailures).toHaveBeenCalledWith({
            limit: 100,
            offset: 0,
        });
    });

    it("clamps a negative offset to zero", async () => {
        await request(app).get("/api/enrichment/failures?offset=-5");

        expect(mockGetFailures).toHaveBeenCalledWith({
            limit: 100,
            offset: 0,
        });
    });

    it("returns sanitized failure details without filesystem metadata", async () => {
        mockGetFailures.mockResolvedValueOnce({
            failures: [
                {
                    id: "failure-1",
                    entityType: "audio",
                    entityId: "track-1",
                    entityName: "Example Track",
                    errorMessage:
                        "decoder crashed at /srv/music/private/track.flac using https://worker:secret@example.test/jobs/1",
                    errorCode: "AUDIO_DECODER_FAILED",
                    retryCount: 2,
                    maxRetries: 3,
                    firstFailedAt: new Date("2026-08-10T12:00:00.000Z"),
                    lastFailedAt: new Date("2026-08-11T12:00:00.000Z"),
                    skipped: false,
                    skippedAt: null,
                    resolved: false,
                    resolvedAt: null,
                    metadata: {
                        track: { filePath: "/srv/music/private/track.flac" },
                    },
                },
            ],
            total: 1,
        });

        const response = await request(app).get("/api/enrichment/failures");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            failures: [
                {
                    id: "failure-1",
                    entityType: "audio",
                    entityId: "track-1",
                    entityName: "Example Track",
                    errorSummary:
                        "decoder crashed at [path] using https://example.test/[...]",
                    errorCode: "AUDIO_DECODER_FAILED",
                    retryCount: 2,
                    maxRetries: 3,
                    firstFailedAt: "2026-08-10T12:00:00.000Z",
                    lastFailedAt: "2026-08-11T12:00:00.000Z",
                    skipped: false,
                    skippedAt: null,
                    resolved: false,
                    resolvedAt: null,
                },
            ],
            total: 1,
        });
        expect(JSON.stringify(response.body)).not.toContain("worker:secret");
        expect(JSON.stringify(response.body)).not.toContain("/srv/music");
    });
});
