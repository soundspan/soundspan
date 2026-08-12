/**
 * Authorization contract for the enrichment router.
 *
 * Library-wide enrichment triggers must be admin-only, matching their
 * admin-gated siblings (/full, /pause, /resume, /stop, resets):
 *   - POST /api/enrichment/sync  (only UI caller is the admin page)
 *   - POST /api/enrichment/start (same worker as the admin-gated /full)
 *   - POST /api/enrichment/artist/:id and /album/:id (apply enrichment
 *     results library-wide and make outbound API calls)
 *   - GET /api/enrichment/failures and /failures/counts (global operational
 *     failure data has no user ownership scope)
 *
 * Deliberately NOT admin-gated (user-facing by design):
 *   - GET/PUT /settings (per-user settings)
 *   - PUT  /artists|albums|tracks/:id/metadata and POST .../:id/reset
 *     (MetadataEditor is exposed to every authenticated user)
 *   - GET /search/musicbrainz/* (backs the MetadataEditor lookup)
 */

export {};

const mockTriggerEnrichmentNow = jest.fn(async () => ({ triggered: true }));
const mockRunFullEnrichment = jest.fn(async () => undefined);
const mockEnrichArtist = jest.fn(async () => ({ confidence: 0.9 }));
const mockEnrichAlbum = jest.fn(async () => ({ confidence: 0.9 }));
const mockApplyArtistEnrichment = jest.fn(async () => undefined);
const mockApplyAlbumEnrichment = jest.fn(async () => undefined);
const mockGetFailures = jest.fn(async () => ({ failures: [], total: 0 }));
const mockGetFailureCounts = jest.fn(async () => ({
    artist: 0,
    track: 0,
    audio: 0,
    vibe: 0,
    total: 0,
}));
const mockSystemSettingsFindUnique = jest.fn(async () => ({
    autoEnrichMetadata: true,
}));

jest.mock("../middleware/auth", () => ({
    requireAuth: (req: any, res: any, next: any) => {
        const role = req.headers["x-test-role"];
        if (!role) {
            return res.status(401).json({ error: "Not authenticated" });
        }
        req.user = { id: "user-1", username: "tester", role };
        return next();
    },
    requireAdmin: (req: any, res: any, next: any) => {
        if (!req.user || req.user.role !== "admin") {
            return res.status(403).json({ error: "Admin access required" });
        }
        return next();
    },
}));

jest.mock("../services/enrichment", () => ({
    enrichmentService: {
        getSettings: jest.fn(async () => ({ enabled: true })),
        updateSettings: jest.fn(async () => ({ enabled: true })),
        enrichArtist: mockEnrichArtist,
        enrichAlbum: mockEnrichAlbum,
        applyArtistEnrichment: mockApplyArtistEnrichment,
        applyAlbumEnrichment: mockApplyAlbumEnrichment,
    },
}));

jest.mock("../workers/unifiedEnrichment", () => ({
    getEnrichmentProgress: jest.fn(async () => ({})),
    runFullEnrichment: mockRunFullEnrichment,
    reRunArtistsOnly: jest.fn(),
    reRunMoodTagsOnly: jest.fn(),
    reRunAudioAnalysisOnly: jest.fn(),
    reRunVibeEmbeddingsOnly: jest.fn(),
    triggerEnrichmentNow: mockTriggerEnrichmentNow,
}));

jest.mock("../services/enrichmentState", () => ({
    enrichmentStateService: {},
}));

jest.mock("../services/enrichmentFailureService", () => ({
    enrichmentFailureService: {
        getFailures: mockGetFailures,
        getFailureCounts: mockGetFailureCounts,
    },
}));

jest.mock("../services/musicbrainz", () => ({
    musicBrainzService: {},
}));

jest.mock("../services/coverArt", () => ({
    coverArtService: {},
}));

jest.mock("../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(async () => ({})),
    invalidateSystemSettingsCache: jest.fn(),
}));

jest.mock("../services/rateLimiter", () => ({
    rateLimiter: {},
}));

jest.mock("../utils/redis", () => ({
    redisClient: {},
}));

jest.mock("../utils/db", () => ({
    prisma: {
        systemSettings: {
            findUnique: mockSystemSettingsFindUnique,
        },
    },
}));

jest.mock("../config", () => ({
    config: {
        features: {
            audioAnalysis: true,
            discovery: true,
            autoPlaylists: true,
        },
    },
}));

jest.mock("../utils/featureGate", () => ({
    sendFeatureDisabled: jest.fn((res: any) =>
        res.status(404).json({ error: "feature disabled" }),
    ),
    createFeatureDisabledHandler: jest.fn(),
}));

jest.mock("../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

import express from "express";
import request from "supertest";
import enrichmentRouter from "../routes/enrichment";

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/enrichment", enrichmentRouter);
    return app;
}

describe("enrichment router authorization", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("rejects unauthenticated requests at the router level", async () => {
        const response = await request(buildApp()).post("/api/enrichment/sync");
        expect(response.status).toBe(401);
    });

    it("rejects non-admin users on POST /sync", async () => {
        const response = await request(buildApp())
            .post("/api/enrichment/sync")
            .set("x-test-role", "user");

        expect(response.status).toBe(403);
        expect(mockTriggerEnrichmentNow).not.toHaveBeenCalled();
    });

    it("allows admins on POST /sync", async () => {
        const response = await request(buildApp())
            .post("/api/enrichment/sync")
            .set("x-test-role", "admin");

        expect(response.status).toBe(200);
        expect(mockTriggerEnrichmentNow).toHaveBeenCalledTimes(1);
    });

    it("rejects non-admin users on POST /start", async () => {
        const response = await request(buildApp())
            .post("/api/enrichment/start")
            .set("x-test-role", "user");

        expect(response.status).toBe(403);
        expect(mockRunFullEnrichment).not.toHaveBeenCalled();
    });

    it("allows admins on POST /start", async () => {
        const response = await request(buildApp())
            .post("/api/enrichment/start")
            .set("x-test-role", "admin");

        expect(response.status).toBe(200);
        expect(mockRunFullEnrichment).toHaveBeenCalledTimes(1);
    });

    it("rejects non-admin users on POST /artist/:id", async () => {
        const response = await request(buildApp())
            .post("/api/enrichment/artist/artist-1")
            .set("x-test-role", "user");

        expect(response.status).toBe(403);
        expect(mockEnrichArtist).not.toHaveBeenCalled();
    });

    it("allows admins on POST /artist/:id", async () => {
        const response = await request(buildApp())
            .post("/api/enrichment/artist/artist-1")
            .set("x-test-role", "admin");

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(mockEnrichArtist).toHaveBeenCalledTimes(1);
    });

    it("rejects non-admin users on POST /album/:id", async () => {
        const response = await request(buildApp())
            .post("/api/enrichment/album/album-1")
            .set("x-test-role", "user");

        expect(response.status).toBe(403);
        expect(mockEnrichAlbum).not.toHaveBeenCalled();
    });

    it("allows admins on POST /album/:id", async () => {
        const response = await request(buildApp())
            .post("/api/enrichment/album/album-1")
            .set("x-test-role", "admin");

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(mockEnrichAlbum).toHaveBeenCalledTimes(1);
    });

    it("rejects non-admin users on GET /failures", async () => {
        const response = await request(buildApp())
            .get("/api/enrichment/failures")
            .set("x-test-role", "user");

        expect(response.status).toBe(403);
        expect(response.body).toEqual({ error: "Admin access required" });
        expect(mockGetFailures).not.toHaveBeenCalled();
    });

    it("allows admins on GET /failures", async () => {
        const response = await request(buildApp())
            .get("/api/enrichment/failures")
            .set("x-test-role", "admin");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ failures: [], total: 0 });
        expect(mockGetFailures).toHaveBeenCalledTimes(1);
    });

    it("rejects non-admin users on GET /failures/counts", async () => {
        const response = await request(buildApp())
            .get("/api/enrichment/failures/counts")
            .set("x-test-role", "user");

        expect(response.status).toBe(403);
        expect(response.body).toEqual({ error: "Admin access required" });
        expect(mockGetFailureCounts).not.toHaveBeenCalled();
    });

    it("allows admins on GET /failures/counts", async () => {
        const response = await request(buildApp())
            .get("/api/enrichment/failures/counts")
            .set("x-test-role", "admin");

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            artist: 0,
            track: 0,
            audio: 0,
            vibe: 0,
            total: 0,
        });
        expect(mockGetFailureCounts).toHaveBeenCalledTimes(1);
    });
});
