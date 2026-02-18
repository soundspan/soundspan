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
        artist: {
            findFirst: jest.fn(),
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

const mockArtistFindFirst = prisma.artist.findFirst as jest.Mock;

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

function createMockArtist() {
    return {
        id: "artist-1",
        name: "AC/DC",
        mbid: "mbid-artist-1",
        heroUrl: null,
        userHeroUrl: null,
        albums: [],
        ownedAlbums: [],
        similarArtistsJson: null,
    };
}

describe("library artist lookup compatibility", () => {
    const artistHandler = getGetHandler("/artists/:id");

    beforeEach(() => {
        jest.clearAllMocks();
        mockArtistFindFirst.mockResolvedValue(createMockArtist());
    });

    it.each([
        {
            label: "library id",
            routeParam: "artist-local-id-123",
            decodedName: "artist-local-id-123",
        },
        {
            label: "url-encoded artist name",
            routeParam: encodeURIComponent("AC/DC"),
            decodedName: "AC/DC",
        },
        {
            label: "uuid mbid",
            routeParam: "550e8400-e29b-41d4-a716-446655440000",
            decodedName: "550e8400-e29b-41d4-a716-446655440000",
        },
        {
            label: "temp mbid",
            routeParam: "temp-artist-lookup-id",
            decodedName: "temp-artist-lookup-id",
        },
    ])(
        "always includes id/name/mbid candidates for $label route params",
        async ({ routeParam, decodedName }) => {
            const req = {
                params: { id: routeParam },
                query: {
                    includeDiscography: "false",
                    includeTopTracks: "false",
                    includeSimilarArtists: "false",
                },
                user: { id: "user-1" },
            } as any;
            const res = createRes();

            await artistHandler(req, res);

            expect(mockArtistFindFirst).toHaveBeenCalledTimes(1);
            expect(mockArtistFindFirst).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        OR: expect.arrayContaining([
                            { id: routeParam },
                            {
                                name: {
                                    equals: decodedName,
                                    mode: "insensitive",
                                },
                            },
                            { mbid: routeParam },
                        ]),
                    },
                })
            );
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual(
                expect.objectContaining({
                    id: "artist-1",
                    albums: [],
                    topTracks: [],
                    similarArtists: [],
                    discographyComplete: true,
                })
            );
        }
    );

    it("returns 404 when artist does not exist", async () => {
        mockArtistFindFirst.mockResolvedValueOnce(null);

        const req = {
            params: { id: "missing-artist-id" },
            query: {
                includeDiscography: "false",
                includeTopTracks: "false",
                includeSimilarArtists: "false",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await artistHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Artist not found" });
    });

    it("keeps discovery off and avoids extra enrichment when all lookup flags are disabled", async () => {
        const req = {
            params: { id: "artist-local-id-123" },
            query: {
                includeDiscography: "0",
                includeTopTracks: "0",
                includeSimilarArtists: "0",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await artistHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "artist-1",
                albums: [],
                topTracks: [],
                similarArtists: [],
                discographyComplete: true,
            })
        );
    });
});
