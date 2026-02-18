import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
    requireAdmin: (_req: Request, _res: Response, next: () => void) => next(),
    requireAuthOrToken: (_req: Request, _res: Response, next: () => void) =>
        next(),
}));

jest.mock("../../middleware/rateLimiter", () => ({
    imageLimiter: (_req: Request, _res: Response, next: () => void) => next(),
    apiLimiter: (_req: Request, _res: Response, next: () => void) => next(),
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
            findUnique: jest.fn(),
            findMany: jest.fn(),
        },
        ownedAlbum: {
            findMany: jest.fn(),
        },
        similarArtist: {
            findMany: jest.fn(),
        },
    },
    Prisma: {
        SortOrder: {
            asc: "asc",
            desc: "desc",
        },
        DbNull: null,
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: {
        get: jest.fn(),
        setEx: jest.fn(),
    },
}));

jest.mock("../../config", () => ({
    config: {
        music: {
            musicPath: "/music",
            transcodeCachePath: "/tmp/soundspan-cache",
            transcodeCacheMaxGb: 1,
        },
    },
}));

jest.mock("../../workers/queues", () => ({
    scanQueue: {
        add: jest.fn(),
        getJob: jest.fn(),
    },
}));

jest.mock("../../workers/organizeSingles", () => ({
    organizeSingles: jest.fn(),
}));

jest.mock("../../services/lastfm", () => ({
    lastFmService: {},
}));

jest.mock("../../services/fanart", () => ({
    fanartService: {},
}));

jest.mock("../../services/deezer", () => ({
    deezerService: {},
}));

jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {},
}));

jest.mock("../../services/coverArt", () => ({
    coverArtService: {},
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../services/audioStreaming", () => ({
    AudioStreamingService: jest.fn(),
}));

jest.mock("../../services/dataCache", () => ({
    dataCacheService: {},
}));

jest.mock("../../services/artistCountsService", () => ({
    backfillAllArtistCounts: jest.fn(),
    isBackfillNeeded: jest.fn(),
    getBackfillProgress: jest.fn(),
    isBackfillInProgress: jest.fn(),
}));

jest.mock("../../services/imageBackfill", () => ({
    isImageBackfillNeeded: jest.fn(),
    getImageBackfillProgress: jest.fn(),
    backfillAllImages: jest.fn(),
}));

jest.mock("../../utils/metadataOverrides", () => ({
    getMergedGenres: jest.fn(() => []),
    getArtistDisplaySummary: jest.fn(() => ""),
}));

jest.mock("../../utils/dateFilters", () => ({
    getEffectiveYear: jest.fn(),
    getDecadeWhereClause: jest.fn(),
    getDecadeFromYear: jest.fn(),
}));

jest.mock("../../utils/shuffle", () => ({
    shuffleArray: jest.fn((arr: unknown[]) => arr),
}));

jest.mock("../../utils/colorExtractor", () => ({
    extractColorsFromImage: jest.fn(async () => ({
        vibrant: "#000000",
        darkVibrant: "#000000",
        lightVibrant: "#000000",
        muted: "#000000",
        darkMuted: "#000000",
        lightMuted: "#000000",
    })),
}));

jest.mock("../../services/imageProxy", () => ({
    fetchExternalImage: jest.fn(),
    normalizeExternalImageUrl: jest.fn(() => null),
}));

import router from "../library";
import { prisma } from "../../utils/db";

const mockTrackFindUnique = prisma.track.findUnique as jest.Mock;
const mockTrackFindMany = prisma.track.findMany as jest.Mock;
const mockOwnedAlbumFindMany = prisma.ownedAlbum.findMany as jest.Mock;
const mockSimilarArtistFindMany = prisma.similarArtist.findMany as jest.Mock;

function getGetHandler(path: string, stackIndex = 0) {
    const layer = (router as any).stack.find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.get
    );
    if (!layer) {
        throw new Error(`Route not found: ${path}`);
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

describe("library vibe radio reliability compatibility", () => {
    const radioHandler = getGetHandler("/radio");

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("treats legacy enhanced analysis as standard and requests analysisVersion", async () => {
        const sourceTrack = {
            id: "source-track",
            title: "Source Track",
            analysisStatus: "completed",
            analysisMode: "enhanced",
            analysisVersion: "legacy-enhanced-v2",
            bpm: 120,
            energy: 0.7,
            valence: 0.65,
            arousal: 0.6,
            danceability: 0.55,
            danceabilityMl: 0.58,
            keyScale: "major",
            instrumentalness: 0.1,
            moodHappy: 0.7,
            moodSad: 0.2,
            moodRelaxed: 0.25,
            moodAggressive: 0.3,
            moodParty: 0.6,
            moodAcoustic: 0.2,
            moodElectronic: 0.4,
            moodTags: ["upbeat"],
            lastfmTags: ["rock"],
            essentiaGenres: ["rock"],
            trackGenres: [{ genre: { name: "Rock" } }],
            album: {
                id: "album-1",
                title: "Album One",
                artistId: "artist-1",
                genres: [],
                artist: { id: "artist-1", name: "Artist One" },
            },
        };

        const analyzedCandidate = {
            id: "candidate-track",
            bpm: 120,
            energy: 0.7,
            valence: 0.65,
            arousal: 0.6,
            danceability: 0.55,
            danceabilityMl: 0.58,
            keyScale: "major",
            moodTags: ["upbeat"],
            lastfmTags: ["rock"],
            essentiaGenres: ["rock"],
            instrumentalness: 0.1,
            moodHappy: 0.68,
            moodSad: 0.21,
            moodRelaxed: 0.24,
            moodAggressive: 0.31,
            moodParty: 0.59,
            moodAcoustic: 0.22,
            moodElectronic: 0.38,
            analysisMode: "enhanced",
            analysisVersion: "legacy-enhanced-v2",
        };

        const hydratedCandidate = {
            id: "candidate-track",
            title: "Candidate Track",
            duration: 180,
            trackNo: 1,
            filePath: "/music/candidate.flac",
            analysisMode: "enhanced",
            analysisVersion: "legacy-enhanced-v2",
            bpm: 120,
            energy: 0.7,
            valence: 0.65,
            arousal: 0.6,
            danceability: 0.55,
            instrumentalness: 0.1,
            keyScale: "major",
            moodHappy: 0.68,
            moodSad: 0.21,
            moodRelaxed: 0.24,
            moodAggressive: 0.31,
            moodParty: 0.59,
            moodAcoustic: 0.22,
            moodElectronic: 0.38,
            album: {
                id: "album-2",
                title: "Album Two",
                coverUrl: null,
                artist: { id: "artist-2", name: "Artist Two" },
            },
            trackGenres: [],
        };

        mockTrackFindUnique.mockResolvedValue(sourceTrack);
        mockTrackFindMany
            .mockResolvedValueOnce([analyzedCandidate]) // analyzed comparison set
            .mockResolvedValueOnce([]) // fallback A: same artist
            .mockResolvedValueOnce([]) // fallback D: random
            .mockResolvedValueOnce([hydratedCandidate]); // final hydrated results
        mockOwnedAlbumFindMany.mockResolvedValue([]);
        mockSimilarArtistFindMany.mockResolvedValue([]);

        const req = {
            query: { type: "vibe", value: "source-track", limit: "10" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await radioHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                tracks: [
                    expect.objectContaining({
                        id: "candidate-track",
                        title: "Candidate Track",
                    }),
                ],
                sourceFeatures: expect.objectContaining({
                    analysisMode: "standard",
                }),
            })
        );
        expect(mockTrackFindMany).toHaveBeenCalled();
        expect(mockTrackFindMany.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                select: expect.objectContaining({
                    analysisVersion: true,
                }),
            })
        );
    });

    it("returns 404 when the vibe source track does not exist", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(null);

        const req = {
            query: { type: "vibe", value: "missing-track" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await radioHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Track not found" });
    });

    it("falls back to same-artist tracks when source has no audio analysis data", async () => {
        const sourceTrack = {
            id: "source-track-noaudio",
            title: "Source Track Without Analysis",
            analysisStatus: "completed",
            analysisMode: "standard",
            analysisVersion: null,
            bpm: null,
            energy: null,
            valence: null,
            arousal: null,
            danceability: null,
            danceabilityMl: null,
            keyScale: "major",
            instrumentalness: null,
            moodHappy: null,
            moodSad: null,
            moodRelaxed: null,
            moodAggressive: null,
            moodParty: null,
            moodAcoustic: null,
            moodElectronic: null,
            moodTags: [],
            lastfmTags: [],
            essentiaGenres: [],
            trackGenres: [{ genre: { name: "Rock" } }],
            album: {
                id: "album-source",
                title: "Source Album",
                artistId: "artist-source",
                genres: ["rock"],
                artist: { id: "artist-source", name: "Source Artist" },
            },
        };

        const hydratedFallbackTrack = {
            id: "fallback-track",
            title: "Fallback Track",
            duration: 190,
            trackNo: 3,
            filePath: "/music/fallback.flac",
            analysisMode: "standard",
            analysisVersion: null,
            bpm: null,
            energy: null,
            valence: null,
            arousal: null,
            danceability: null,
            instrumentalness: null,
            moodHappy: null,
            moodSad: null,
            moodRelaxed: null,
            moodAggressive: null,
            moodParty: null,
            moodAcoustic: null,
            moodElectronic: null,
            album: {
                id: "album-fallback",
                title: "Fallback Album",
                coverUrl: null,
                artist: { id: "artist-fallback", name: "Fallback Artist" },
            },
            trackGenres: [],
        };

        mockTrackFindUnique.mockResolvedValueOnce(sourceTrack);
        mockTrackFindMany
            .mockResolvedValueOnce([{ id: "fallback-track" }]) // fallback A: same artist
            .mockResolvedValueOnce([hydratedFallbackTrack]); // hydration

        const req = {
            query: { type: "vibe", value: "source-track-noaudio", limit: "1" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await radioHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                tracks: [
                    expect.objectContaining({
                        id: "fallback-track",
                        title: "Fallback Track",
                    }),
                ],
                sourceFeatures: expect.objectContaining({
                    analysisMode: "standard",
                }),
            })
        );
        expect(mockTrackFindMany).toHaveBeenCalledTimes(2);
        expect(mockTrackFindMany.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                where: expect.objectContaining({
                    album: { artistId: "artist-source" },
                    id: { notIn: ["source-track-noaudio"] },
                }),
            })
        );
    });

    it("returns 500 when radio processing throws", async () => {
        mockTrackFindUnique.mockRejectedValueOnce(new Error("radio failure"));

        const req = {
            query: { type: "vibe", value: "source-track" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await radioHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get radio tracks" });
    });
});
