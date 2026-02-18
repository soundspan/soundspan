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

import router from "../enrichment";
import { musicBrainzService } from "../../services/musicbrainz";

const mockSearchArtist = musicBrainzService.searchArtist as jest.Mock;
const mockSearchReleaseGroups =
    musicBrainzService.searchReleaseGroups as jest.Mock;

function getHandler(path: string, method: "get", stackIndex = 0) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );

    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }

    return layer.route.stack[stackIndex].handle;
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

describe("enrichment MusicBrainz lookup compatibility", () => {
    const searchArtistsHandler = getHandler("/search/musicbrainz/artists", "get");
    const searchReleaseGroupsHandler = getHandler(
        "/search/musicbrainz/release-groups",
        "get"
    );

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("returns 400 for artist lookup queries shorter than two characters", async () => {
        const req = { query: { q: "a" }, user: { id: "user-1" } } as any;
        const res = createRes();

        await searchArtistsHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Query must be at least 2 characters",
        });
        expect(mockSearchArtist).not.toHaveBeenCalled();
    });

    it("maps artist lookup responses to UI contract fields", async () => {
        mockSearchArtist.mockResolvedValue([
            {
                id: "mbid-artist-1",
                name: "Daft Punk",
                disambiguation: "French electronic duo",
                country: "FR",
                type: "Group",
                score: "99",
            },
        ]);

        const req = { query: { q: " Daft Punk " }, user: { id: "user-1" } } as any;
        const res = createRes();

        await searchArtistsHandler(req, res);

        expect(mockSearchArtist).toHaveBeenCalledWith("Daft Punk", 10);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            artists: [
                {
                    mbid: "mbid-artist-1",
                    name: "Daft Punk",
                    disambiguation: "French electronic duo",
                    country: "FR",
                    type: "Group",
                    score: 99,
                },
            ],
        });
    });

    it("returns 500 with message when artist lookup fails", async () => {
        mockSearchArtist.mockRejectedValue(new Error("artist lookup failed"));

        const req = { query: { q: "Daft" }, user: { id: "user-1" } } as any;
        const res = createRes();

        await searchArtistsHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "artist lookup failed" });
    });

    it("preserves non-numeric artist scores as NaN", async () => {
        mockSearchArtist.mockResolvedValue([
            {
                id: "artist-no-score",
                name: "Mystery Artist",
                score: "not-a-number",
            },
        ]);

        const req = { query: { q: "Mystery" }, user: { id: "user-1" } } as any;
        const res = createRes();

        await searchArtistsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.artists).toHaveLength(1);
        expect(res.body.artists[0]).toEqual(
            expect.objectContaining({
                mbid: "artist-no-score",
                name: "Mystery Artist",
                disambiguation: null,
                country: null,
                type: null,
            })
        );
        expect(Number.isNaN(res.body.artists[0].score)).toBe(true);
    });

    it("returns 400 for release-group lookup queries shorter than two characters", async () => {
        const req = { query: { q: "" }, user: { id: "user-1" } } as any;
        const res = createRes();

        await searchReleaseGroupsHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Query must be at least 2 characters",
        });
        expect(mockSearchReleaseGroups).not.toHaveBeenCalled();
    });

    it("maps release-group lookup responses and forwards optional artist filter", async () => {
        mockSearchReleaseGroups.mockResolvedValue([
            {
                id: "rg-1",
                title: "Random Access Memories",
                "primary-type": "Album",
                "secondary-types": ["Compilation"],
                "first-release-date": "2013-05-17",
                "artist-credit": [{ name: "Daft Punk" }],
                score: "88",
            },
        ]);

        const req = {
            query: { q: "Random Access", artist: " Daft Punk " },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await searchReleaseGroupsHandler(req, res);

        expect(mockSearchReleaseGroups).toHaveBeenCalledWith(
            "Random Access",
            "Daft Punk",
            10
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            albums: [
                {
                    rgMbid: "rg-1",
                    title: "Random Access Memories",
                    primaryType: "Album",
                    secondaryTypes: ["Compilation"],
                    firstReleaseDate: "2013-05-17",
                    artistCredit: "Daft Punk",
                    score: 88,
                },
            ],
        });
    });

    it("returns 500 with message when release-group lookup fails", async () => {
        mockSearchReleaseGroups.mockRejectedValue(
            new Error("release-group lookup failed")
        );

        const req = { query: { q: "Random Access" }, user: { id: "user-1" } } as any;
        const res = createRes();

        await searchReleaseGroupsHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "release-group lookup failed" });
    });

    it("normalizes missing artist-credit and score defaults for release-group lookup", async () => {
        mockSearchReleaseGroups.mockResolvedValue([
            {
                id: "rg-none",
                title: "Unknown Credits Album",
                "first-release-date": null,
                score: undefined,
            },
        ]);

        const req = {
            query: { q: "Unknown Credits" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await searchReleaseGroupsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            albums: [
                {
                    rgMbid: "rg-none",
                    title: "Unknown Credits Album",
                    primaryType: "Album",
                    secondaryTypes: [],
                    firstReleaseDate: null,
                    artistCredit: "Unknown Artist",
                    score: 0,
                },
            ],
        });
    });
});
