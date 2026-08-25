import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
    requireAdmin: (_req: Request, _res: Response, next: () => void) => next(),
    requireAuthOrToken: (_req: Request, _res: Response, next: () => void) =>
        next(),
}));

jest.mock("../../middleware/rateLimiter", () => ({
    coverArtLimiter: (_req: Request, _res: Response, next: () => void) =>
        next(),
    libraryMetadataLimiter: (_req: Request, _res: Response, next: () => void) =>
        next(),
    streamingLimiter: (_req: Request, _res: Response, next: () => void) =>
        next(),
}));

jest.mock("../../utils/logger", () => {
    const logger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
    };
    logger.child.mockReturnValue(logger);
    return { logger };
});

jest.mock("../../utils/db", () => ({
    prisma: {
        artist: {
            findFirst: jest.fn(),
        },
        play: {
            groupBy: jest.fn(),
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
    lastFmService: {
        getArtistTopTracks: jest.fn(),
    },
}));

jest.mock("../../services/fanart", () => ({
    fanartService: {},
}));

jest.mock("../../services/deezer", () => ({
    deezerService: {
        getAlbumCover: jest.fn(),
    },
}));

jest.mock("../../services/imageProvider", () => ({
    imageProviderService: {},
}));

jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        getReleaseGroups: jest.fn(),
    },
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
    dataCacheService: {
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

import router from "../library";
import { flattenLibraryRouteLayers } from "./libraryRouteTestUtils";
import { prisma } from "../../utils/db";
import { lastFmService } from "../../services/lastfm";
import { deezerService } from "../../services/deezer";
import { dataCacheService } from "../../services/dataCache";
import { musicBrainzService } from "../../services/musicbrainz";

const mockArtistFindFirst = prisma.artist.findFirst as jest.Mock;
const mockPlayGroupBy = prisma.play.groupBy as jest.Mock;
const mockLastFmGetArtistTopTracks =
    lastFmService.getArtistTopTracks as jest.Mock;
const mockDeezerGetAlbumCover = deezerService.getAlbumCover as jest.Mock;
const mockDataCacheGetArtistImage =
    dataCacheService.getArtistImage as jest.Mock;
const mockMusicBrainzGetReleaseGroups =
    musicBrainzService.getReleaseGroups as jest.Mock;

function getGetHandler(path: string, stackIndex = 0) {
    const layer = flattenLibraryRouteLayers(router).find(
        (entry: any) => entry.route?.path === path && entry.route?.methods?.get,
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

function createMockArtist(name = "AC/DC") {
    return {
        id: "artist-1",
        name,
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
        mockPlayGroupBy.mockResolvedValue([]);
        mockLastFmGetArtistTopTracks.mockResolvedValue([]);
        mockDeezerGetAlbumCover.mockResolvedValue(null);
        mockDataCacheGetArtistImage.mockResolvedValue(null);
        mockMusicBrainzGetReleaseGroups.mockResolvedValue([]);
    });

    it.each([
        {
            label: "library id",
            routeParam: "artist-local-id-123",
            decodedName: "artist-local-id-123",
        },
        {
            label: "Express-decoded artist name",
            routeParam: "AC/DC",
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
                }),
            );
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual(
                expect.objectContaining({
                    id: "artist-1",
                    albums: [],
                    topTracks: [],
                    similarArtists: [],
                    discographyComplete: true,
                }),
            );
        },
    );

    it.each(["100% Pure", "A/B", "Earth, Wind & Fire", "Björk", "A%2FB"])(
        "finds the stored artist named %s without decoding the route param again",
        async (storedName) => {
            mockArtistFindFirst.mockImplementation(async (args: any) => {
                const nameCandidate = args.where.OR.find(
                    (candidate: any) => candidate.name,
                )?.name.equals;
                return nameCandidate === storedName
                    ? createMockArtist(storedName)
                    : null;
            });

            const req = {
                params: { id: storedName },
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
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual(
                expect.objectContaining({
                    id: "artist-1",
                    name: storedName,
                }),
            );
        },
    );

    it("falls back to the decoded artist name for legacy double-encoded library requests", async () => {
        const storedName = "Legacy / Artist";
        const legacyRouteParam = encodeURIComponent(storedName);
        mockArtistFindFirst.mockImplementation(async (args: any) => {
            const nameCandidate = args.where.OR.find(
                (candidate: any) => candidate.name,
            )?.name.equals;
            return nameCandidate === storedName
                ? createMockArtist(storedName)
                : null;
        });

        const req = {
            params: { id: legacyRouteParam },
            query: {
                includeDiscography: "false",
                includeTopTracks: "false",
                includeSimilarArtists: "false",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await artistHandler(req, res);

        expect(mockArtistFindFirst).toHaveBeenCalledTimes(2);
        expect(mockArtistFindFirst.mock.calls[0][0].where.OR).toEqual(
            expect.arrayContaining([
                {
                    name: {
                        equals: legacyRouteParam,
                        mode: "insensitive",
                    },
                },
            ]),
        );
        expect(mockArtistFindFirst.mock.calls[1][0].where.OR).toEqual(
            expect.arrayContaining([
                {
                    name: { equals: storedName, mode: "insensitive" },
                },
            ]),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "artist-1",
                name: storedName,
            }),
        );
    });

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
            }),
        );
    });

    it("exposes the album artist on matched Last.fm top tracks", async () => {
        mockArtistFindFirst.mockResolvedValueOnce({
            ...createMockArtist(),
            albums: [
                {
                    id: "album-1",
                    title: "Owned Album",
                    rgMbid: "rg-owned",
                    coverUrl: "owned-cover.jpg",
                    tracks: [
                        {
                            id: "track-1",
                            title: "Owned Track",
                            album: {
                                id: "album-1",
                                title: "Owned Album",
                                coverUrl: "owned-cover.jpg",
                                albumLoudnessLufs: null,
                                albumTruePeakDb: null,
                                artist: {
                                    id: "artist-1",
                                    name: "AC/DC",
                                    mbid: "mbid-artist-1",
                                },
                            },
                        },
                    ],
                },
            ],
        });
        mockLastFmGetArtistTopTracks.mockResolvedValueOnce([
            {
                name: "Owned Track",
                playcount: "12",
                listeners: "34",
                duration: "245",
                url: "https://last.fm/track/owned",
                album: { "#text": "Owned Album" },
            },
        ]);

        const req = {
            params: { id: "artist-local-id-123" },
            query: {
                includeDiscography: "false",
                includeTopTracks: "true",
                includeSimilarArtists: "false",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await artistHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.topTracks).toEqual([
            expect.objectContaining({
                id: "track-1",
                artist: {
                    id: "artist-1",
                    name: "AC/DC",
                    mbid: "mbid-artist-1",
                },
            }),
        ]);
    });

    it.each([
        ["Song Title (2011 Remaster)", "Song Title"],
        ["Song Title (feat. Guest)", "Song Title"],
        ["Song: Title!", "Song Title"],
    ])(
        "matches normalized library title %p to Last.fm title %p",
        async (libraryTitle, lastFmTitle) => {
            mockArtistFindFirst.mockResolvedValueOnce({
                ...createMockArtist(),
                albums: [
                    {
                        id: "album-1",
                        title: "Owned Album",
                        rgMbid: "rg-owned",
                        coverUrl: "owned-cover.jpg",
                        tracks: [
                            {
                                id: "track-remaster",
                                title: libraryTitle,
                                album: {
                                    id: "album-1",
                                    title: "Owned Album",
                                    coverUrl: "owned-cover.jpg",
                                    albumLoudnessLufs: null,
                                    albumTruePeakDb: null,
                                    artist: {
                                        id: "artist-1",
                                        name: "AC/DC",
                                        mbid: "mbid-artist-1",
                                    },
                                },
                            },
                        ],
                    },
                ],
            });
            mockLastFmGetArtistTopTracks.mockResolvedValueOnce([
                {
                    name: lastFmTitle,
                    playcount: "12",
                    listeners: "34",
                    duration: "245",
                    url: "https://last.fm/track/song-title",
                    album: { "#text": "Owned Album" },
                },
            ]);
            const req = {
                params: { id: "artist-local-id-123" },
                query: {
                    includeDiscography: "false",
                    includeTopTracks: "true",
                    includeSimilarArtists: "false",
                },
                user: { id: "user-1" },
            } as any;
            const res = createRes();

            await artistHandler(req, res);

            expect(res.statusCode).toBe(200);
            expect(res.body.topTracks).toEqual([
                expect.objectContaining({
                    id: "track-remaster",
                    title: libraryTitle,
                    album: expect.objectContaining({ id: "album-1" }),
                }),
            ]);
            expect(mockDeezerGetAlbumCover).not.toHaveBeenCalled();
        },
    );

    it("folds a MusicBrainz base album into its owned deluxe edition", async () => {
        mockArtistFindFirst.mockResolvedValueOnce({
            ...createMockArtist(),
            albums: [
                {
                    id: "album-deluxe",
                    title: "Album (Deluxe Edition)",
                    rgMbid: "rg-owned-deluxe",
                    coverUrl: "owned-cover.jpg",
                    location: "LIBRARY",
                    tracks: [],
                },
            ],
        });
        mockMusicBrainzGetReleaseGroups.mockResolvedValueOnce([
            {
                id: "rg-mb-base",
                title: "Album",
                "first-release-date": "2011-01-01",
                "primary-type": "Album",
                "secondary-types": [],
            },
        ]);
        const req = {
            params: { id: "artist-local-id-123" },
            query: {
                includeDiscography: "true",
                includeTopTracks: "false",
                includeSimilarArtists: "false",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await artistHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.albums).toEqual([
            expect.objectContaining({
                id: "album-deluxe",
                title: "Album (Deluxe Edition)",
                owned: true,
                source: "database",
            }),
        ]);
        expect(res.body.discographyComplete).toBe(true);
    });

    it("hydrates unmatched Last.fm top tracks and skips Deezer lookup for unknown albums", async () => {
        mockArtistFindFirst.mockResolvedValueOnce(createMockArtist());
        mockLastFmGetArtistTopTracks.mockResolvedValueOnce([
            {
                name: "Unmatched With Cover",
                playcount: "12",
                listeners: "34",
                duration: "245",
                url: "https://last.fm/track/1",
                album: { "#text": "Rare EP" },
            },
            {
                name: "Unmatched Unknown Album",
                playcount: "7",
                listeners: "11",
                duration: "210",
                url: "https://last.fm/track/2",
                album: {},
            },
        ]);
        mockDeezerGetAlbumCover.mockResolvedValueOnce(
            "https://cdn.deezer.com/rare-ep.jpg",
        );

        const req = {
            params: { id: "artist-local-id-123" },
            query: {
                includeDiscography: "false",
                includeTopTracks: "true",
                includeSimilarArtists: "false",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await artistHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockLastFmGetArtistTopTracks).toHaveBeenCalledWith(
            "mbid-artist-1",
            "AC/DC",
            10,
        );
        expect(mockDeezerGetAlbumCover).toHaveBeenCalledTimes(1);
        expect(mockDeezerGetAlbumCover).toHaveBeenCalledWith(
            "AC/DC",
            "Rare EP",
        );
        const unownedTrack = res.body.topTracks.find(
            (track: any) => track.title === "Unmatched With Cover",
        );
        expect(unownedTrack).toEqual(
            expect.objectContaining({
                artist: { name: "AC/DC" },
                duration: 245,
            }),
        );
        expect(unownedTrack.album).not.toHaveProperty("id");
        expect(res.body.topTracks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    title: "Unmatched With Cover",
                    album: expect.objectContaining({
                        title: "Rare EP",
                        coverArt: "https://cdn.deezer.com/rare-ep.jpg",
                    }),
                }),
                expect.objectContaining({
                    title: "Unmatched Unknown Album",
                    album: expect.objectContaining({
                        title: "Unknown Album",
                        coverArt: null,
                    }),
                }),
            ]),
        );
    });

    it("continues top-track hydration when a Deezer cover lookup rejects", async () => {
        mockArtistFindFirst.mockResolvedValueOnce(createMockArtist());
        mockLastFmGetArtistTopTracks.mockResolvedValueOnce([
            {
                name: "Rejected Cover Lookup",
                playcount: "5",
                listeners: "9",
                duration: "180",
                url: "https://last.fm/track/rejected",
                album: { "#text": "Broken Cover Album" },
            },
        ]);
        mockDeezerGetAlbumCover.mockRejectedValueOnce(
            new Error("deezer timeout"),
        );

        const req = {
            params: { id: "artist-local-id-123" },
            query: {
                includeDiscography: "false",
                includeTopTracks: "true",
                includeSimilarArtists: "false",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await artistHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.topTracks).toEqual([
            expect.objectContaining({
                title: "Rejected Cover Lookup",
                album: expect.objectContaining({
                    title: "Broken Cover Album",
                    coverArt: null,
                }),
            }),
        ]);
    });

    it("skips Deezer batch lookups when Last.fm contributes no non-unknown unowned albums", async () => {
        mockArtistFindFirst.mockResolvedValueOnce(createMockArtist());
        mockLastFmGetArtistTopTracks.mockResolvedValueOnce([
            {
                name: "Unknown Album Track",
                playcount: "3",
                listeners: "6",
                duration: "160",
                url: "https://last.fm/track/unknown",
                album: {},
            },
        ]);

        const req = {
            params: { id: "artist-local-id-123" },
            query: {
                includeDiscography: "false",
                includeTopTracks: "true",
                includeSimilarArtists: "false",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await artistHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockDeezerGetAlbumCover).not.toHaveBeenCalled();
        expect(res.body.topTracks).toEqual([
            expect.objectContaining({
                title: "Unknown Album Track",
                album: expect.objectContaining({
                    title: "Unknown Album",
                    coverArt: null,
                }),
            }),
        ]);
    });
});
