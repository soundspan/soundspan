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

const prisma = {
    artist: { count: jest.fn(), findMany: jest.fn() },
    album: { findMany: jest.fn(), count: jest.fn() },
    ownedAlbum: { findMany: jest.fn() },
    $transaction: jest.fn(),
};

jest.mock("../../utils/db", () => ({
    prisma,
    Prisma: {
        SortOrder: { asc: "asc", desc: "desc" },
        DbNull: null,
    },
}));

jest.mock("../../utils/redis", () => ({
    redisClient: { get: jest.fn(), setEx: jest.fn() },
}));

jest.mock("../../config", () => ({
    config: {
        audiobookshelf: undefined,
        music: {
            musicPath: "/music",
            transcodeCachePath: "/tmp/soundspan-cache",
            transcodeCacheMaxGb: 1,
        },
        generationDiversity: { weightAlpha: 0.5, shareCeiling: 0.3 },
    },
}));

jest.mock("../../workers/queues", () => ({
    scanQueue: { add: jest.fn(), getJob: jest.fn() },
}));

jest.mock("../../workers/organizeSingles", () => ({
    organizeSingles: jest.fn(),
}));

jest.mock("../../services/lastfm", () => ({
    lastFmService: {
        getArtistTopTracks: jest.fn(),
        getSimilarArtists: jest.fn(),
    },
}));

jest.mock("../../services/fanart", () => ({
    fanartService: {},
}));

jest.mock("../../services/deezer", () => ({
    deezerService: {
        getAlbumCover: jest.fn(),
        getArtistImage: jest.fn(),
    },
}));

jest.mock("../../services/imageProvider", () => ({
    imageProviderService: {
        getAlbumCover: jest.fn(),
    },
}));

jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        searchArtist: jest.fn(),
        getReleaseGroups: jest.fn(),
    },
}));

jest.mock("../../services/coverArt", () => ({
    coverArtService: {
        getCoverArt: jest.fn(),
        clearNotFoundCache: jest.fn(),
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../services/audioStreaming", () => ({
    AudioStreamingService: jest.fn().mockImplementation(() => ({
        getStreamFilePath: jest.fn(),
        streamFileWithRangeSupport: jest.fn(),
        destroy: jest.fn(),
    })),
}));

jest.mock("../../services/dataCache", () => ({
    dataCacheService: {
        getArtistImagesBatch: jest.fn(),
        getArtistImage: jest.fn(),
    },
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

jest.mock("../../services/imageStorage", () => ({
    downloadAndStoreImage: jest.fn(),
}));

jest.mock("../../services/lidarr", () => ({
    lidarrService: {
        deleteArtist: jest.fn(),
    },
}));

jest.mock(
    "music-metadata",
    () => ({
        parseFile: jest.fn(),
    }),
    { virtual: true },
);

jest.mock("../../services/remoteTrackMetadataResolver", () => ({
    resolveRemoteTrackMetadataForRequest: jest.fn(
        async ({ metadata }: any) => ({
            title: metadata.title ?? "Unknown",
            artist: metadata.artist ?? "Unknown",
            album: metadata.album ?? "Unknown",
            duration: metadata.duration ?? 180,
            thumbnailUrl: metadata.thumbnailUrl,
            isrc: metadata.isrc,
            explicit: metadata.explicit,
            quality: metadata.quality,
        }),
    ),
}));

import router from "../library";
import { prisma as dbPrisma } from "../../utils/db";

const mockArtistCount = dbPrisma.artist.count as jest.Mock;
const mockOwnedAlbumFindMany = dbPrisma.ownedAlbum.findMany as jest.Mock;
const mockPrismaTransaction = dbPrisma.$transaction as jest.Mock;

function getRouteHandler(path: string, method: "get" | "post" | "delete") {
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

describe("library route errors do not disclose caught values", () => {
    it("returns a curated artists error", async () => {
        mockArtistCount.mockResolvedValueOnce(0);
        mockPrismaTransaction.mockRejectedValueOnce(SECRET_ERROR);
        const res = createRes();

        await getRouteHandler("/artists", "get")(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body.error).toBe("Failed to fetch artists");
        expect(JSON.stringify(res.body)).not.toContain("SECRET_LEAK_MARKER");
        expect(res.body).not.toHaveProperty("details");
    });

    it("returns a curated albums error", async () => {
        mockOwnedAlbumFindMany.mockRejectedValueOnce(SECRET_ERROR);
        const res = createRes();

        await getRouteHandler("/albums", "get")(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body.error).toBe("Failed to fetch albums");
        expect(JSON.stringify(res.body)).not.toContain("SECRET_LEAK_MARKER");
        expect(res.body).not.toHaveProperty("details");
    });
});
