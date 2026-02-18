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

jest.mock("../../utils/db", () => ({
    prisma,
}));

import router from "../enrichment";
import { enrichmentService } from "../../services/enrichment";
import {
    getEnrichmentProgress,
    runFullEnrichment,
    reRunArtistsOnly,
    reRunMoodTagsOnly,
    reRunAudioAnalysisOnly,
    reRunVibeEmbeddingsOnly,
    triggerEnrichmentNow,
} from "../../workers/unifiedEnrichment";
import { enrichmentStateService } from "../../services/enrichmentState";
import { enrichmentFailureService } from "../../services/enrichmentFailureService";
import { musicBrainzService } from "../../services/musicbrainz";
import {
    getSystemSettings,
    invalidateSystemSettingsCache,
} from "../../utils/systemSettings";
import { rateLimiter } from "../../services/rateLimiter";
import { prisma as dbPrisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";

const mockGetEnrichmentProgress = getEnrichmentProgress as jest.Mock;
const mockRunFullEnrichment = runFullEnrichment as jest.Mock;
const mockReRunArtistsOnly = reRunArtistsOnly as jest.Mock;
const mockReRunMoodTagsOnly = reRunMoodTagsOnly as jest.Mock;
const mockReRunAudioAnalysisOnly = reRunAudioAnalysisOnly as jest.Mock;
const mockReRunVibeEmbeddingsOnly = reRunVibeEmbeddingsOnly as jest.Mock;
const mockTriggerEnrichmentNow = triggerEnrichmentNow as jest.Mock;

const mockGetState = enrichmentStateService.getState as jest.Mock;
const mockPause = enrichmentStateService.pause as jest.Mock;
const mockResume = enrichmentStateService.resume as jest.Mock;
const mockStop = enrichmentStateService.stop as jest.Mock;
const mockMusicBrainzSearchArtist = musicBrainzService.searchArtist as jest.Mock;
const mockMusicBrainzSearchReleaseGroups =
    musicBrainzService.searchReleaseGroups as jest.Mock;

const mockGetSettings = enrichmentService.getSettings as jest.Mock;
const mockUpdateSettings = enrichmentService.updateSettings as jest.Mock;
const mockEnrichArtist = enrichmentService.enrichArtist as jest.Mock;
const mockApplyArtistEnrichment =
    enrichmentService.applyArtistEnrichment as jest.Mock;
const mockEnrichAlbum = enrichmentService.enrichAlbum as jest.Mock;
const mockApplyAlbumEnrichment =
    enrichmentService.applyAlbumEnrichment as jest.Mock;

const mockGetFailures = enrichmentFailureService.getFailures as jest.Mock;
const mockGetFailureCounts =
    enrichmentFailureService.getFailureCounts as jest.Mock;
const mockResetRetryCount =
    enrichmentFailureService.resetRetryCount as jest.Mock;
const mockGetFailure = enrichmentFailureService.getFailure as jest.Mock;
const mockResolveFailures =
    enrichmentFailureService.resolveFailures as jest.Mock;
const mockSkipFailures = enrichmentFailureService.skipFailures as jest.Mock;
const mockClearAllFailures =
    enrichmentFailureService.clearAllFailures as jest.Mock;
const mockDeleteFailures = enrichmentFailureService.deleteFailures as jest.Mock;

const mockGetSystemSettings = getSystemSettings as jest.Mock;
const mockInvalidateSystemSettingsCache =
    invalidateSystemSettingsCache as jest.Mock;
const mockUpdateConcurrencyMultiplier =
    rateLimiter.updateConcurrencyMultiplier as jest.Mock;

    const mockArtistFindUnique = dbPrisma.artist.findUnique as jest.Mock;
    const mockArtistFindFirst = dbPrisma.artist.findFirst as jest.Mock;
const mockArtistUpdate = dbPrisma.artist.update as jest.Mock;
const mockAlbumFindUnique = dbPrisma.album.findUnique as jest.Mock;
const mockAlbumUpdate = dbPrisma.album.update as jest.Mock;
const mockOwnedAlbumDeleteMany = dbPrisma.ownedAlbum.deleteMany as jest.Mock;
const mockOwnedAlbumUpsert = dbPrisma.ownedAlbum.upsert as jest.Mock;
const mockTrackFindUnique = dbPrisma.track.findUnique as jest.Mock;
const mockTrackUpdate = dbPrisma.track.update as jest.Mock;
const mockSystemSettingsFindUnique =
    dbPrisma.systemSettings.findUnique as jest.Mock;
const mockSystemSettingsUpsert = dbPrisma.systemSettings.upsert as jest.Mock;
const mockRedisDel = redisClient.del as jest.Mock;

function getRouteHandler(
    path: string,
    method: "get" | "post" | "put" | "delete"
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
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

describe("enrichment route runtime behavior", () => {
    const progressHandler = getRouteHandler("/progress", "get");
    const statusHandler = getRouteHandler("/status", "get");
    const pauseHandler = getRouteHandler("/pause", "post");
    const resumeHandler = getRouteHandler("/resume", "post");
    const stopHandler = getRouteHandler("/stop", "post");
    const resetArtistsHandler = getRouteHandler("/reset-artists", "post");
    const resetMoodTagsHandler = getRouteHandler("/reset-mood-tags", "post");
    const resetAudioAnalysisHandler = getRouteHandler(
        "/reset-audio-analysis",
        "post"
    );
    const resetVibeEmbeddingsHandler = getRouteHandler(
        "/reset-vibe-embeddings",
        "post"
    );
    const fullHandler = getRouteHandler("/full", "post");
    const syncHandler = getRouteHandler("/sync", "post");
    const settingsGetHandler = getRouteHandler("/settings", "get");
    const settingsPutHandler = getRouteHandler("/settings", "put");
    const enrichArtistHandler = getRouteHandler("/artist/:id", "post");
    const enrichAlbumHandler = getRouteHandler("/album/:id", "post");
    const startHandler = getRouteHandler("/start", "post");
    const failuresGetHandler = getRouteHandler("/failures", "get");
    const failureCountsHandler = getRouteHandler("/failures/counts", "get");
    const retryHandler = getRouteHandler("/retry", "post");
    const skipHandler = getRouteHandler("/skip", "post");
    const searchArtistsHandler = getRouteHandler(
        "/search/musicbrainz/artists",
        "get"
    );
    const searchReleaseGroupsHandler = getRouteHandler(
        "/search/musicbrainz/release-groups",
        "get"
    );
    const failuresClearHandler = getRouteHandler("/failures", "delete");
    const failureDeleteHandler = getRouteHandler("/failures/:id", "delete");
    const resetArtistMetadataHandler = getRouteHandler("/artists/:id/reset", "post");
    const updateArtistMetadataHandler = getRouteHandler("/artists/:id/metadata", "put");
    const updateAlbumMetadataHandler = getRouteHandler("/albums/:id/metadata", "put");
    const updateTrackMetadataHandler = getRouteHandler("/tracks/:id/metadata", "put");
    const resetAlbumMetadataHandler = getRouteHandler("/albums/:id/reset", "post");
    const concurrencyGetHandler = getRouteHandler("/concurrency", "get");
    const concurrencyPutHandler = getRouteHandler("/concurrency", "put");
    const resetTrackMetadataHandler = getRouteHandler("/tracks/:id/reset", "post");

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetEnrichmentProgress.mockResolvedValue({
            artists: { processed: 1, total: 10 },
        });
        mockGetState.mockResolvedValue({
            status: "running",
            currentPhase: "artists",
        });
        mockPause.mockResolvedValue({ status: "paused" });
        mockResume.mockResolvedValue({ status: "running" });
        mockStop.mockResolvedValue({ status: "stopping" });
        mockRedisDel.mockResolvedValue(undefined);
        mockRunFullEnrichment.mockResolvedValue({
            artists: 0,
            tracks: 0,
            audioQueued: 0,
        });
        mockReRunArtistsOnly.mockResolvedValue({ count: 3 });
        mockReRunMoodTagsOnly.mockResolvedValue({ count: 5 });
        mockReRunAudioAnalysisOnly.mockResolvedValue(6);
        mockReRunVibeEmbeddingsOnly.mockResolvedValue(7);
        mockTriggerEnrichmentNow.mockResolvedValue({ queued: 11 });
        mockGetSettings.mockResolvedValue({
            enabled: true,
        });
        mockUpdateSettings.mockResolvedValue({
            enabled: false,
        });
        mockEnrichArtist.mockResolvedValue({
            confidence: 0.9,
            provider: "mock",
        });
        mockApplyArtistEnrichment.mockResolvedValue(undefined);
        mockEnrichAlbum.mockResolvedValue({
            confidence: 0.8,
            provider: "mock",
        });
        mockApplyAlbumEnrichment.mockResolvedValue(undefined);
        mockSystemSettingsFindUnique.mockResolvedValue({
            autoEnrichMetadata: true,
        });
        mockGetFailures.mockResolvedValue({ items: [], total: 0 });
        mockGetFailureCounts.mockResolvedValue({ artist: 1, track: 2, audio: 3 });
        mockResetRetryCount.mockResolvedValue(undefined);
        mockGetFailure.mockResolvedValue(null);
        mockResolveFailures.mockResolvedValue(undefined);
        mockSkipFailures.mockResolvedValue(2);
        mockClearAllFailures.mockResolvedValue(2);
        mockDeleteFailures.mockResolvedValue(1);
        mockArtistFindUnique.mockResolvedValue({ id: "artist-1" });
        mockArtistUpdate.mockResolvedValue(undefined);
        mockAlbumFindUnique.mockResolvedValue(null);
        mockAlbumUpdate.mockResolvedValue(undefined);
        mockOwnedAlbumDeleteMany.mockResolvedValue({ count: 0 });
        mockOwnedAlbumUpsert.mockResolvedValue({});
        mockTrackFindUnique.mockResolvedValue({ id: "track-1" });
        mockTrackUpdate.mockResolvedValue(undefined);
        mockGetSystemSettings.mockResolvedValue({ enrichmentConcurrency: 2 });
        mockSystemSettingsUpsert.mockResolvedValue({});
        mockArtistFindFirst.mockResolvedValue(null);
        mockMusicBrainzSearchArtist.mockResolvedValue([]);
        mockMusicBrainzSearchReleaseGroups.mockResolvedValue([]);
    });

    it("validates musicbrainz artist search query length", async () => {
        const res = createRes();

        await searchArtistsHandler(
            { query: { q: "a" } } as any,
            res
        );

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Query must be at least 2 characters",
        });
    });

    it("maps musicbrainz artist search results with score parsing", async () => {
        mockMusicBrainzSearchArtist.mockResolvedValueOnce([
            {
                id: "11111111-1111-1111-1111-111111111111",
                name: "The Test Artist",
                disambiguation: "Alt artist",
                country: "US",
                type: "Person",
                score: "99",
            },
            {
                id: "22222222-2222-2222-2222-222222222222",
                name: "The Other Artist",
                country: null,
                type: null,
                score: 12,
            },
        ]);

        const res = createRes();

        await searchArtistsHandler(
            { query: { q: "test artist" } } as any,
            res
        );

        expect(mockMusicBrainzSearchArtist).toHaveBeenCalledWith(
            "test artist",
            10
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            artists: [
                {
                    mbid: "11111111-1111-1111-1111-111111111111",
                    name: "The Test Artist",
                    disambiguation: "Alt artist",
                    country: "US",
                    type: "Person",
                    score: 99,
                },
                {
                    mbid: "22222222-2222-2222-2222-222222222222",
                    name: "The Other Artist",
                    disambiguation: null,
                    country: null,
                    type: null,
                    score: 12,
                },
            ],
        });
    });

    it("surfaces musicbrainz artist search failures", async () => {
        mockMusicBrainzSearchArtist.mockRejectedValueOnce(
            new Error("musicbrainz down")
        );

        const res = createRes();

        await searchArtistsHandler(
            { query: { q: "failing query" } } as any,
            res
        );

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "musicbrainz down" });
    });

    it("validates musicbrainz release-group query length", async () => {
        const res = createRes();

        await searchReleaseGroupsHandler(
            { query: { q: "r" } } as any,
            res
        );

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Query must be at least 2 characters",
        });
    });

    it("maps release-group search results with artist-credit reduction", async () => {
        mockMusicBrainzSearchReleaseGroups.mockResolvedValueOnce([
            {
                id: "33333333-3333-3333-3333-333333333333",
                title: "Test Album",
                "primary-type": "EP",
                "secondary-types": ["Live", "Compilation"],
                "first-release-date": "2019-05-20",
                "artist-credit": [
                    { name: "Alpha" },
                    { artist: { name: "Beta" } },
                ],
                score: "85",
            },
        ]);

        const res = createRes();

        await searchReleaseGroupsHandler(
            {
                query: { q: "test album", artist: "Alpha" },
            } as any,
            res
        );

        expect(mockMusicBrainzSearchReleaseGroups).toHaveBeenCalledWith(
            "test album",
            "Alpha",
            10
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            albums: [
                {
                    rgMbid: "33333333-3333-3333-3333-333333333333",
                    title: "Test Album",
                    primaryType: "EP",
                    secondaryTypes: ["Live", "Compilation"],
                    firstReleaseDate: "2019-05-20",
                    artistCredit: "Alpha, Beta",
                    score: 85,
                },
            ],
        });
    });

    it("surfaces release-group search failures", async () => {
        mockMusicBrainzSearchReleaseGroups.mockRejectedValueOnce(
            new Error("release service down")
        );

        const res = createRes();

        await searchReleaseGroupsHandler(
            { query: { q: "test album" } } as any,
            res
        );

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "release service down" });
    });

    it("returns enrichment progress payload", async () => {
        const res = createRes();
        await progressHandler({ user: { id: "user-1" } } as any, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            artists: { processed: 1, total: 10 },
        });
    });

    it("returns 500 when progress retrieval fails", async () => {
        mockGetEnrichmentProgress.mockRejectedValueOnce(new Error("boom"));

        const res = createRes();
        await progressHandler({ user: { id: "user-1" } } as any, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get progress" });
    });

    it("returns 500 when enrichment settings retrieval fails", async () => {
        mockGetSettings.mockRejectedValueOnce(new Error("db down"));

        const res = createRes();
        await settingsGetHandler({ user: { id: "user-1" } } as any, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get settings" });
    });

    it("returns 500 when enrichment status retrieval fails", async () => {
        mockGetState.mockRejectedValueOnce(new Error("status db down"));

        const res = createRes();
        await statusHandler({ user: { id: "admin-1" } } as any, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get status" });
    });

    it("returns idle status when no enrichment state exists", async () => {
        mockGetState.mockResolvedValueOnce(null);

        const res = createRes();
        await statusHandler({ user: { id: "user-1" } } as any, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ status: "idle", currentPhase: null });
    });

    it("supports pause/resume/stop and returns state payloads", async () => {
        const pauseRes = createRes();
        await pauseHandler({ user: { id: "admin-1" } } as any, pauseRes);
        expect(pauseRes.body).toEqual({
            message: "Enrichment paused",
            state: { status: "paused" },
        });

        const resumeRes = createRes();
        await resumeHandler({ user: { id: "admin-1" } } as any, resumeRes);
        expect(resumeRes.body).toEqual({
            message: "Enrichment resumed",
            state: { status: "running" },
        });

        const stopRes = createRes();
        await stopHandler({ user: { id: "admin-1" } } as any, stopRes);
        expect(stopRes.body).toEqual({
            message: "Enrichment stopping...",
            state: { status: "stopping" },
        });
    });

    it("returns 400 for state transition errors", async () => {
        mockPause.mockRejectedValueOnce(new Error("already paused"));

        const res = createRes();
        await pauseHandler({ user: { id: "admin-1" } } as any, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "already paused" });
    });

    it("returns 400 for resume and stop transition errors", async () => {
        mockResume.mockRejectedValueOnce(new Error("already running"));

        const resumeRes = createRes();
        await resumeHandler({ user: { id: "admin-1" } } as any, resumeRes);

        expect(resumeRes.statusCode).toBe(400);
        expect(resumeRes.body).toEqual({ error: "already running" });

        mockStop.mockRejectedValueOnce(new Error("already stopped"));

        const stopRes = createRes();
        await stopHandler({ user: { id: "admin-1" } } as any, stopRes);

        expect(stopRes.statusCode).toBe(400);
        expect(stopRes.body).toEqual({ error: "already stopped" });
    });

    it("handles reset routes for artists, tags, audio, and vibes", async () => {
        const resetArtistsRes = createRes();
        await resetArtistsHandler({ user: { id: "admin-1" } } as any, resetArtistsRes);
        expect(resetArtistsRes.statusCode).toBe(200);
        expect(resetArtistsRes.body).toEqual({
            message: "Artist enrichment reset",
            description: "3 artists queued for re-enrichment",
            count: 3,
        });

        const resetMoodRes = createRes();
        await resetMoodTagsHandler({ user: { id: "admin-1" } } as any, resetMoodRes);
        expect(resetMoodRes.statusCode).toBe(200);
        expect(resetMoodRes.body).toEqual({
            message: "Mood tags reset",
            description: "5 tracks queued for mood tag re-enrichment",
            count: 5,
        });

        const resetAudioRes = createRes();
        await resetAudioAnalysisHandler(
            { user: { id: "admin-1" } } as any,
            resetAudioRes
        );
        expect(resetAudioRes.statusCode).toBe(200);
        expect(resetAudioRes.body).toEqual({
            message: "Audio analysis reset",
            description: "6 tracks queued for audio re-analysis",
            count: 6,
        });

        const resetVibeRes = createRes();
        await resetVibeEmbeddingsHandler(
            { user: { id: "admin-1" } } as any,
            resetVibeRes
        );
        expect(resetVibeRes.statusCode).toBe(200);
        expect(resetVibeRes.body).toEqual({
            message: "Vibe embeddings reset",
            description: "7 tracks queued for vibe embedding re-analysis",
            count: 7,
        });
    });

    it("returns 500 when artist reset fails", async () => {
        mockReRunArtistsOnly.mockRejectedValueOnce(new Error("reset failed"));

        const res = createRes();
        await resetArtistsHandler({ user: { id: "admin-1" } } as any, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to reset artist enrichment" });
    });

    it("returns 500 from reset route failures", async () => {
        mockReRunMoodTagsOnly.mockRejectedValueOnce(new Error("worker down"));

        const res = createRes();
        await resetMoodTagsHandler({ user: { id: "admin-1" } } as any, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to reset mood tags" });
    });

    it("handles full enrichment asynchronous and synchronous startup failures", async () => {
        mockRunFullEnrichment.mockRejectedValueOnce(new Error("queue rejected"));
        const asyncFailureRes = createRes();
        await fullHandler({ user: { id: "admin-1" }, body: {} } as any, asyncFailureRes);
        await Promise.resolve();

        expect(asyncFailureRes.statusCode).toBe(200);
        expect(asyncFailureRes.body).toEqual({
            message: "Full enrichment started",
            description: "All artists, track tags, and audio analysis will be re-processed",
            forceVibeRebuild: false,
            forceMoodBucketBackfill: false,
        });

        mockRunFullEnrichment.mockImplementationOnce(() => {
            throw new Error("sync fail");
        });
        const syncFailureRes = createRes();
        await fullHandler({ user: { id: "admin-1" }, body: {} } as any, syncFailureRes);

        expect(syncFailureRes.statusCode).toBe(500);
        expect(syncFailureRes.body).toEqual({ error: "Failed to start full enrichment" });
    });

    it("starts incremental sync and surfaces error messages", async () => {
        const successRes = createRes();
        await syncHandler({ user: { id: "user-1" } } as any, successRes);
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            message: "Incremental sync started",
            description: "Processing new and pending items only",
            result: { queued: 11 },
        });

        mockTriggerEnrichmentNow.mockRejectedValueOnce(new Error("queue busy"));
        const errorRes = createRes();
        await syncHandler({ user: { id: "user-1" } } as any, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "queue busy" });
    });

    it("reads and writes per-user enrichment settings", async () => {
        const getRes = createRes();
        await settingsGetHandler({ user: { id: "user-1" } } as any, getRes);
        expect(mockGetSettings).toHaveBeenCalledWith("user-1");
        expect(getRes.statusCode).toBe(200);
        expect(getRes.body).toEqual({ enabled: true });

        const putRes = createRes();
        await settingsPutHandler(
            { user: { id: "user-1" }, body: { enabled: false } } as any,
            putRes
        );
        expect(mockUpdateSettings).toHaveBeenCalledWith("user-1", {
            enabled: false,
        });
        expect(putRes.statusCode).toBe(200);
        expect(putRes.body).toEqual({ enabled: false });
    });

    it("returns 500 when enrichment settings update fails", async () => {
        mockUpdateSettings.mockRejectedValueOnce(new Error("db write error"));

        const res = createRes();
        await settingsPutHandler(
            { user: { id: "user-1" }, body: { enabled: false } } as any,
            res
        );

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to update settings" });
    });

    it("gates artist enrichment by settings and confidence", async () => {
        mockGetSettings.mockResolvedValueOnce({ enabled: false });
        const disabledRes = createRes();
        await enrichArtistHandler(
            { user: { id: "user-1" }, params: { id: "artist-1" } } as any,
            disabledRes
        );
        expect(disabledRes.statusCode).toBe(400);
        expect(disabledRes.body).toEqual({ error: "Enrichment is not enabled" });

        mockGetSettings.mockResolvedValueOnce({ enabled: true });
        mockEnrichArtist.mockResolvedValueOnce(null);
        const missingRes = createRes();
        await enrichArtistHandler(
            { user: { id: "user-1" }, params: { id: "artist-1" } } as any,
            missingRes
        );
        expect(missingRes.statusCode).toBe(404);
        expect(missingRes.body).toEqual({ error: "No enrichment data found" });

        mockGetSettings.mockResolvedValueOnce({ enabled: true });
        mockEnrichArtist.mockResolvedValueOnce({ confidence: 0.2, foo: "bar" });
        const lowConfidenceRes = createRes();
        await enrichArtistHandler(
            { user: { id: "user-1" }, params: { id: "artist-low" } } as any,
            lowConfidenceRes
        );
        expect(mockApplyArtistEnrichment).not.toHaveBeenCalled();
        expect(lowConfidenceRes.statusCode).toBe(200);
        expect(lowConfidenceRes.body).toEqual({
            success: true,
            confidence: 0.2,
            data: { confidence: 0.2, foo: "bar" },
        });
    });

    it("applies artist enrichment above confidence threshold", async () => {
        mockGetSettings.mockResolvedValueOnce({ enabled: true });
        mockEnrichArtist.mockResolvedValueOnce({
            confidence: 0.9,
            provider: "mock",
        });

        const res = createRes();
        await enrichArtistHandler(
            { user: { id: "user-1" }, params: { id: "artist-high" } } as any,
            res
        );

        expect(mockApplyArtistEnrichment).toHaveBeenCalledWith("artist-high", {
            confidence: 0.9,
            provider: "mock",
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            confidence: 0.9,
            data: { confidence: 0.9, provider: "mock" },
        });
    });

    it("returns 500 when single artist enrichment throws", async () => {
        mockGetSettings.mockResolvedValueOnce({ enabled: true });
        mockEnrichArtist.mockRejectedValueOnce(new Error("enrichment service down"));

        const res = createRes();
        await enrichArtistHandler(
            { user: { id: "user-1" }, params: { id: "artist-err" } } as any,
            res
        );

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "enrichment service down" });
    });

    it("applies album enrichment only above confidence threshold", async () => {
        mockGetSettings.mockResolvedValueOnce({ enabled: true });
        mockEnrichAlbum.mockResolvedValueOnce({ confidence: 0.9, score: 9 });

        const highConfidenceRes = createRes();
        await enrichAlbumHandler(
            { user: { id: "user-1" }, params: { id: "album-1" } } as any,
            highConfidenceRes
        );
        expect(mockApplyAlbumEnrichment).toHaveBeenCalledWith("album-1", {
            confidence: 0.9,
            score: 9,
        });
        expect(highConfidenceRes.statusCode).toBe(200);

        mockGetSettings.mockResolvedValueOnce({ enabled: true });
        mockEnrichAlbum.mockResolvedValueOnce({ confidence: 0.1, score: 1 });
        const lowConfidenceRes = createRes();
        await enrichAlbumHandler(
            { user: { id: "user-1" }, params: { id: "album-2" } } as any,
            lowConfidenceRes
        );
        expect(lowConfidenceRes.statusCode).toBe(200);
        expect(lowConfidenceRes.body).toEqual({
            success: true,
            confidence: 0.1,
            data: { confidence: 0.1, score: 1 },
        });
    });

    it("returns 500 when single album enrichment throws", async () => {
        mockGetSettings.mockResolvedValueOnce({ enabled: true });
        mockEnrichAlbum.mockRejectedValueOnce(new Error("album provider timeout"));

        const res = createRes();
        await enrichAlbumHandler(
            { user: { id: "user-1" }, params: { id: "album-err" } } as any,
            res
        );

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "album provider timeout" });
    });

    it("enforces auto-enrichment setting when starting full library run", async () => {
        mockSystemSettingsFindUnique.mockResolvedValueOnce({
            autoEnrichMetadata: false,
        });

        const disabledRes = createRes();
        await startHandler({ user: { id: "admin-1" } } as any, disabledRes);

        expect(disabledRes.statusCode).toBe(400);
        expect(disabledRes.body).toEqual({
            error: "Enrichment is not enabled. Enable it in settings first.",
        });

        const successRes = createRes();
        await startHandler({ user: { id: "admin-1" } } as any, successRes);
        expect(mockRunFullEnrichment).toHaveBeenCalledWith();
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            success: true,
            message: "Library enrichment started in background",
        });
    });

    it("returns 500 when start flow throws unexpectedly", async () => {
        mockSystemSettingsFindUnique.mockRejectedValueOnce(new Error("db timeout"));

        const res = createRes();
        await startHandler({ user: { id: "admin-1" } } as any, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "db timeout" });
    });

    it("still returns 200 if start background task rejects", async () => {
        mockRunFullEnrichment.mockRejectedValueOnce(new Error("worker crash"));

        const res = createRes();
        await startHandler({ user: { id: "admin-1" } } as any, res);
        await Promise.resolve();

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            message: "Library enrichment started in background",
        });
    });

    it("maps failure list filters and handles failure list errors", async () => {
        const req = {
            query: {
                entityType: "artist",
                includeSkipped: "true",
                includeResolved: "true",
                limit: "25",
                offset: "10",
            },
            user: { id: "admin-1" },
        } as any;
        const res = createRes();
        await failuresGetHandler(req, res);

        expect(mockGetFailures).toHaveBeenCalledWith({
            entityType: "artist",
            includeSkipped: true,
            includeResolved: true,
            limit: 25,
            offset: 10,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ items: [], total: 0 });

        mockGetFailures.mockRejectedValueOnce(new Error("bad query"));
        const errorRes = createRes();
        await failuresGetHandler({ query: {}, user: { id: "admin-1" } } as any, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "Failed to get failures" });
    });

    it("returns failure counts and handles count errors", async () => {
        const res = createRes();
        await failureCountsHandler({ user: { id: "admin-1" } } as any, res);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ artist: 1, track: 2, audio: 3 });

        mockGetFailureCounts.mockRejectedValueOnce(new Error("no counts"));
        const errorRes = createRes();
        await failureCountsHandler({ user: { id: "admin-1" } } as any, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "Failed to get failure counts" });
    });

    it("validates retry ids and requeues existing artist/audio items", async () => {
        const invalidRes = createRes();
        await retryHandler({ body: {}, user: { id: "admin-1" } } as any, invalidRes);
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({
            error: "Must provide array of failure IDs",
        });

        mockGetFailure
            .mockResolvedValueOnce({
                id: "f-artist",
                entityType: "artist",
                entityId: "artist-1",
            })
            .mockResolvedValueOnce({
                id: "f-track",
                entityType: "track",
                entityId: "track-missing",
            })
            .mockResolvedValueOnce({
                id: "f-audio",
                entityType: "audio",
                entityId: "track-1",
            })
            .mockResolvedValueOnce(null);

        mockArtistFindUnique.mockResolvedValueOnce({ id: "artist-1" });
        mockTrackFindUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: "track-1" });

        const res = createRes();
        await retryHandler(
            {
                body: { ids: ["f-artist", "f-track", "f-audio", "f-none"] },
                user: { id: "admin-1" },
            } as any,
            res
        );

        expect(mockResetRetryCount).toHaveBeenCalledWith([
            "f-artist",
            "f-track",
            "f-audio",
            "f-none",
        ]);
        expect(mockArtistUpdate).toHaveBeenCalledWith({
            where: { id: "artist-1" },
            data: { enrichmentStatus: "pending" },
        });
        expect(mockResolveFailures).toHaveBeenCalledWith(["f-track"]);
        expect(mockTrackUpdate).toHaveBeenCalledWith({
            where: { id: "track-1" },
            data: { analysisStatus: "pending", analysisRetryCount: 0 },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message:
                "Queued 2 items for retry, 1 skipped (entities no longer exist)",
            queued: 2,
            skipped: 1,
        });
    });

    it("handles missing and present failures per-entity", async () => {
        mockGetFailure
            .mockResolvedValueOnce({
                id: "f-artist-missing",
                entityType: "artist",
                entityId: "artist-missing",
            })
            .mockResolvedValueOnce({
                id: "f-track-present",
                entityType: "track",
                entityId: "track-present",
            })
            .mockResolvedValueOnce({
                id: "f-audio-missing",
                entityType: "audio",
                entityId: "track-missing",
            });

        mockArtistFindUnique.mockResolvedValueOnce(null);
        mockTrackFindUnique
            .mockResolvedValueOnce({ id: "track-present" })
            .mockResolvedValueOnce(null);

        const res = createRes();
        await retryHandler(
            {
                body: {
                    ids: ["f-artist-missing", "f-track-present", "f-audio-missing"],
                },
                user: { id: "admin-1" },
            } as any,
            res
        );

        expect(mockResolveFailures).toHaveBeenCalledWith(["f-artist-missing"]);
        expect(mockResolveFailures).toHaveBeenCalledWith(["f-audio-missing"]);
        expect(mockTrackUpdate).toHaveBeenCalledWith({
            where: { id: "track-present" },
            data: { lastfmTags: [] },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message:
                "Queued 1 items for retry, 2 skipped (entities no longer exist)",
            queued: 1,
            skipped: 2,
        });
    });

    it("returns 500 when retry setup fails", async () => {
        mockResetRetryCount.mockRejectedValueOnce(new Error("reset failed"));

        const res = createRes();
        await retryHandler(
            { body: { ids: ["f-1"] }, user: { id: "admin-1" } } as any,
            res
        );

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "reset failed" });
    });

    it("validates skip payload and skips failures by id", async () => {
        const invalidRes = createRes();
        await skipHandler({ body: { ids: [] }, user: { id: "admin-1" } } as any, invalidRes);
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({
            error: "Must provide array of failure IDs",
        });

        const successRes = createRes();
        await skipHandler(
            { body: { ids: ["f-1", "f-2"] }, user: { id: "admin-1" } } as any,
            successRes
        );
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            message: "Skipped 2 failures",
            count: 2,
        });
    });

    it("validates and clears failures with singular/plural responses", async () => {
        const invalidRes = createRes();
        await failuresClearHandler(
            {
                query: { entityType: "playlist" },
                user: { id: "admin-1" },
            } as any,
            invalidRes
        );
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({ error: "Invalid entityType" });

        mockClearAllFailures.mockResolvedValueOnce(1);
        const singularRes = createRes();
        await failuresClearHandler(
            {
                query: { entityType: "artist" },
                user: { id: "admin-1" },
            } as any,
            singularRes
        );
        expect(mockClearAllFailures).toHaveBeenCalledWith("artist");
        expect(singularRes.statusCode).toBe(200);
        expect(singularRes.body).toEqual({
            message: "Cleared 1 failure",
            count: 1,
        });
    });

    it("returns 500 when clearing failures fails", async () => {
        mockClearAllFailures.mockRejectedValueOnce(
            new Error("clear failure store offline")
        );

        const res = createRes();
        await failuresClearHandler(
            {
                query: {},
                user: { id: "admin-1" },
            } as any,
            res
        );

        expect(mockClearAllFailures).toHaveBeenCalledWith(undefined);
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "clear failure store offline",
        });
    });

    it("deletes a single failure by id", async () => {
        const res = createRes();
        await failureDeleteHandler(
            { params: { id: "failure-123" }, user: { id: "admin-1" } } as any,
            res
        );

        expect(mockDeleteFailures).toHaveBeenCalledWith(["failure-123"]);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Failure deleted",
            count: 1,
        });
    });

    it("returns 500 when artist metadata reset fails", async () => {
        mockArtistFindUnique.mockResolvedValueOnce({ id: "artist-1" });
        mockArtistUpdate.mockRejectedValueOnce(
            new Error("artist reset failed")
        );

        const res = createRes();
        await resetArtistMetadataHandler(
            { params: { id: "artist-1" }, body: {}, user: { id: "admin-1" } } as any,
            res
        );

        expect(mockArtistUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "artist-1" },
            })
        );
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "artist reset failed" });
    });

    it("returns 500 when deleting a failure record fails", async () => {
        mockDeleteFailures.mockRejectedValueOnce(new Error("delete failed"));

        const res = createRes();
        await failureDeleteHandler(
            { params: { id: "failure-err" }, user: { id: "admin-1" } } as any,
            res
        );

        expect(mockDeleteFailures).toHaveBeenCalledWith(["failure-err"]);
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "delete failed" });
    });

    it("reads concurrency settings and estimated throughput", async () => {
        const res = createRes();
        await concurrencyGetHandler({ user: { id: "admin-1" } } as any, res);

        expect(mockGetSystemSettings).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            concurrency: 2,
            estimatedSpeed: "~20 artists/min, ~120 tracks/min",
            artistsPerMin: 20,
            tracksPerMin: 120,
        });
    });

    it("updates concurrency with clamp/floor and refreshes runtime dependencies", async () => {
        const invalidRes = createRes();
        await concurrencyPutHandler(
            { body: { concurrency: "2" }, user: { id: "admin-1" } } as any,
            invalidRes
        );
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({
            error: "Missing or invalid 'concurrency' parameter",
        });

        const successRes = createRes();
        await concurrencyPutHandler(
            { body: { concurrency: 5.9 }, user: { id: "admin-1" } } as any,
            successRes
        );
        expect(mockSystemSettingsUpsert).toHaveBeenCalledWith({
            where: { id: "default" },
            create: {
                id: "default",
                enrichmentConcurrency: 5,
            },
            update: {
                enrichmentConcurrency: 5,
            },
        });
        expect(mockInvalidateSystemSettingsCache).toHaveBeenCalledTimes(1);
        expect(mockUpdateConcurrencyMultiplier).toHaveBeenCalledWith(5);
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            concurrency: 5,
            estimatedSpeed: "~50 artists/min, ~300 tracks/min",
            artistsPerMin: 50,
            tracksPerMin: 300,
        });
    });

    it("returns 500 when updating concurrency fails", async () => {
        mockSystemSettingsUpsert.mockRejectedValueOnce(new Error("db down"));

        const res = createRes();
        await concurrencyPutHandler(
            { body: { concurrency: 2 }, user: { id: "admin-1" } } as any,
            res
        );

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to update enrichment settings" });
    });

    it("rejects non-positive concurrency values", async () => {
        const lowRes = createRes();
        await concurrencyPutHandler(
            { body: { concurrency: 0 }, user: { id: "admin-1" } } as any,
            lowRes
        );

        expect(mockSystemSettingsUpsert).not.toHaveBeenCalled();
        expect(mockInvalidateSystemSettingsCache).not.toHaveBeenCalled();
        expect(mockUpdateConcurrencyMultiplier).not.toHaveBeenCalled();
        expect(lowRes.statusCode).toBe(400);
        expect(lowRes.body).toEqual({
            error: "Missing or invalid 'concurrency' parameter",
        });
    });

    it("resets track metadata to canonical values", async () => {
        const track = {
            id: "track-1",
            displayTitle: null,
            displayTrackNo: null,
            hasUserOverrides: false,
            album: {
                id: "album-1",
                title: "Album",
                artist: {
                    id: "artist-1",
                    name: "Artist",
                },
            },
        };
        mockTrackFindUnique.mockResolvedValueOnce({ id: "track-1" });
        mockTrackUpdate.mockResolvedValueOnce(track);

        const res = createRes();
        await resetTrackMetadataHandler(
            { params: { id: "track-1" }, user: { id: "admin-1" } } as any,
            res
        );

        expect(mockTrackFindUnique).toHaveBeenCalledWith({
            where: { id: "track-1" },
            select: { id: true },
        });
        expect(mockTrackUpdate).toHaveBeenCalledWith({
            where: { id: "track-1" },
            data: {
                displayTitle: null,
                displayTrackNo: null,
                hasUserOverrides: false,
            },
            include: {
                album: {
                    select: {
                        id: true,
                        title: true,
                        artist: {
                            select: { id: true, name: true },
                        },
                    },
                },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Track metadata reset to original values",
            track,
        });
    });

    it("returns 500 when album metadata reset fails", async () => {
        mockAlbumFindUnique.mockResolvedValueOnce({ id: "album-1" });
        mockAlbumUpdate.mockRejectedValueOnce(new Error("album reset failed"));

        const res = createRes();
        await resetAlbumMetadataHandler(
            { params: { id: "album-1" }, body: {}, user: { id: "admin-1" } } as any,
            res
        );

        expect(mockAlbumUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "album-1" },
            })
        );
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "album reset failed" });
    });

    it("still returns success when artist cache invalidation fails during metadata reset", async () => {
        const artist = {
            id: "artist-1",
            displayName: null,
            userSummary: null,
            userHeroUrl: null,
            userGenres: [],
            hasUserOverrides: false,
        };
        mockArtistUpdate.mockResolvedValueOnce(artist);
        mockRedisDel.mockRejectedValueOnce(new Error("cache down"));

        const res = createRes();
        await resetArtistMetadataHandler(
            { params: { id: "artist-1" }, user: { id: "admin-1" } } as any,
            res
        );

        expect(mockRedisDel).toHaveBeenCalledWith("hero:artist-1");
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Artist metadata reset to original values",
            artist,
        });
    });

    it("returns 404 on track metadata reset race condition", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({ id: "track-race" });
        mockTrackUpdate.mockRejectedValueOnce(
            Object.assign(new Error("track deleted"), { code: "P2025" })
        );

        const res = createRes();
        await resetTrackMetadataHandler(
            { params: { id: "track-race" }, user: { id: "admin-1" } } as any,
            res
        );

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({
            error: "Track not found",
            message: "The track may have been deleted",
        });
    });

    it("validates artist metadata MBID format and tolerates cache invalidation failure", async () => {
        const invalidRes = createRes();
        await updateArtistMetadataHandler(
            {
                params: { id: "artist-1" },
                body: { mbid: 123 },
                user: { id: "admin-1" },
            } as any,
            invalidRes
        );

        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({
            error: "Invalid MusicBrainz ID format",
            code: "INVALID_MBID_FORMAT",
            field: "mbid",
            expectedFormat: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        });
        expect(mockArtistFindUnique).not.toHaveBeenCalled();

        mockArtistFindUnique.mockResolvedValueOnce({
            mbid: "11111111-1111-1111-8000-111111111111",
        });
        mockArtistFindFirst.mockResolvedValueOnce(null);
        const updatedArtist = { id: "artist-1", albums: [] };
        mockArtistUpdate.mockResolvedValueOnce(updatedArtist);
        mockRedisDel.mockRejectedValueOnce(new Error("cache down"));

        const redisFailureRes = createRes();
        await updateArtistMetadataHandler(
            {
                params: { id: "artist-1" },
                body: {
                    name: "Fallback Artist",
                    mbid: "123e4567-e89b-12d3-a456-426614174000",
                },
                user: { id: "admin-1" },
            } as any,
            redisFailureRes
        );

        expect(redisFailureRes.statusCode).toBe(200);
        expect(redisFailureRes.body).toEqual(updatedArtist);
    });

    it("returns 404 when artist metadata target no longer exists", async () => {
        mockArtistFindUnique.mockResolvedValueOnce(null);

        const res = createRes();
        await updateArtistMetadataHandler(
            {
                params: { id: "missing-artist" },
                body: { mbid: "123e4567-e89b-12d3-a456-426614174000" },
                user: { id: "admin-1" },
            } as any,
            res
        );

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({
            error: "Artist not found",
            message: "The artist may have been deleted",
        });
    });

    it("updates album metadata and skips owned-album remap for non-library albums", async () => {
        const album = {
            id: "album-1",
            displayTitle: "Edited Album",
            displayYear: null,
            userCoverUrl: null,
            hasUserOverrides: true,
        };
        mockAlbumFindUnique.mockResolvedValueOnce({
            artistId: "artist-1",
            rgMbid: "11111111-1111-4111-8111-111111111111",
            location: "SEARCH",
        });
        mockAlbumUpdate.mockResolvedValueOnce(album);

        const res = createRes();
        await updateAlbumMetadataHandler(
            {
                params: { id: "album-1" },
                body: {
                    rgMbid: "22222222-2222-4222-8222-222222222222",
                    title: "Edited Album",
                },
                user: { id: "admin-1" },
            } as any,
            res
        );

        expect(mockAlbumFindUnique).toHaveBeenCalledWith({
            where: { id: "album-1" },
            select: { artistId: true, rgMbid: true, location: true },
        });
        expect(mockOwnedAlbumDeleteMany).not.toHaveBeenCalled();
        expect(mockOwnedAlbumUpsert).not.toHaveBeenCalled();
        expect(mockAlbumUpdate).toHaveBeenCalledWith({
            where: { id: "album-1" },
            data: expect.objectContaining({
                displayTitle: "Edited Album",
                rgMbid: "22222222-2222-4222-8222-222222222222",
                hasUserOverrides: true,
            }),
            include: {
                artist: {
                    select: {
                        id: true,
                        name: true,
                    },
                },
                tracks: {
                    select: {
                        id: true,
                        title: true,
                        trackNo: true,
                        duration: true,
                    },
                },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(album);
    });

    it("updates track metadata overrides and formats track number as integer", async () => {
        const track = {
            id: "track-1",
            displayTitle: "Manual title",
            displayTrackNo: 42,
            album: {
                id: "album-1",
                title: "Album",
                artist: {
                    id: "artist-1",
                    name: "Artist",
                },
            },
        };
        mockTrackUpdate.mockResolvedValueOnce(track);

        const res = createRes();
        await updateTrackMetadataHandler(
            {
                params: { id: "track-1" },
                body: { title: "Manual title", trackNo: "42" },
                user: { id: "admin-1" },
            } as any,
            res
        );

        expect(mockTrackUpdate).toHaveBeenCalledWith({
            where: { id: "track-1" },
            data: {
                displayTitle: "Manual title",
                displayTrackNo: 42,
                hasUserOverrides: true,
            },
            include: {
                album: {
                    select: {
                        id: true,
                        title: true,
                        artist: {
                            select: {
                                id: true,
                                name: true,
                            },
                        },
                    },
                },
            },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(track);
    });

    it("returns 500 when track metadata override fails", async () => {
        mockTrackUpdate.mockRejectedValueOnce(
            new Error("track metadata failed")
        );

        const res = createRes();
        await updateTrackMetadataHandler(
            {
                params: { id: "track-1" },
                body: { title: "Manual title", trackNo: "42" },
                user: { id: "admin-1" },
            } as any,
            res
        );

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "track metadata failed" });
    });

    it("returns 409 when artist metadata update hits MBID conflict", async () => {
        mockArtistFindUnique.mockResolvedValueOnce({
            mbid: "11111111-1111-1111-8000-111111111111",
        });
        mockArtistFindFirst.mockResolvedValueOnce({ id: "artist-2" });

        const res = createRes();
        await updateArtistMetadataHandler(
            {
                params: { id: "artist-1" },
                body: {
                    mbid: "123e4567-e89b-12d3-a456-426614174000",
                },
                user: { id: "admin-1" },
            } as any,
            res
        );

        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({
            error: "MusicBrainz ID is already used by another artist",
            code: "MBID_CONFLICT",
            field: "mbid",
            hint: "Use MusicBrainz lookup to pick the correct artist MBID",
        });
    });

    it("continues retry processing if a failure item cannot be reset", async () => {
        mockGetFailure.mockResolvedValueOnce({
            id: "f-artist",
            entityType: "artist",
            entityId: "artist-1",
        });
        mockArtistFindUnique.mockRejectedValueOnce(
            new Error("lookup failed")
        );

        const res = createRes();
        await retryHandler(
            { body: { ids: ["f-artist"] }, user: { id: "admin-1" } } as any,
            res
        );

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Queued 0 items for retry, 0 skipped (entities no longer exist)",
            queued: 0,
            skipped: 0,
        });
        expect(mockResolveFailures).not.toHaveBeenCalled();
    });

    it("skips retrying unsupported failure entity types", async () => {
        mockGetFailure.mockResolvedValueOnce({
            id: "f-unsupported",
            entityType: "album",
            entityId: "album-1",
        });

        const res = createRes();
        await retryHandler(
            {
                body: { ids: ["f-unsupported"] },
                user: { id: "admin-1" },
            } as any,
            res
        );

        expect(mockResetRetryCount).toHaveBeenCalledWith(["f-unsupported"]);
        expect(mockResolveFailures).not.toHaveBeenCalled();
        expect(mockArtistFindUnique).not.toHaveBeenCalled();
        expect(mockTrackFindUnique).not.toHaveBeenCalled();
        expect(mockTrackUpdate).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Queued 0 items for retry, 0 skipped (entities no longer exist)",
            queued: 0,
            skipped: 0,
        });
    });

    it("returns 500 when concurrency settings cannot be read", async () => {
        mockGetSystemSettings.mockRejectedValueOnce(
            new Error("settings timeout")
        );

        const res = createRes();
        await concurrencyGetHandler({ user: { id: "admin-1" } } as any, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get enrichment settings" });
    });

    it("defaults concurrency and speed estimates when settings omit enrichmentConcurrency", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({});

        const res = createRes();
        await concurrencyGetHandler({ user: { id: "admin-1" } } as any, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            concurrency: 1,
            estimatedSpeed: "~10 artists/min, ~60 tracks/min",
            artistsPerMin: 10,
            tracksPerMin: 60,
        });
    });
});
