import type { Request, Response } from "express";
import fs from "node:fs";

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
            count: jest.fn(),
            delete: jest.fn(),
            deleteMany: jest.fn(),
        },
        likedTrack: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
            count: jest.fn(),
            upsert: jest.fn(),
            createMany: jest.fn(),
            deleteMany: jest.fn(),
        },
        dislikedEntity: {
            findUnique: jest.fn(),
            findMany: jest.fn(),
            upsert: jest.fn(),
            createMany: jest.fn(),
            deleteMany: jest.fn(),
        },
        likedRemoteTrack: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
            deleteMany: jest.fn(),
            findMany: jest.fn(),
            count: jest.fn(),
        },
        trackTidal: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
        },
        trackYtMusic: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
        },
        trackMapping: {
            findMany: jest.fn(),
        },
        play: {
            findFirst: jest.fn(),
            create: jest.fn(),
            findMany: jest.fn(),
            groupBy: jest.fn(),
        },
        userSettings: {
            findUnique: jest.fn(),
        },
        artist: {
            findMany: jest.fn(),
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            count: jest.fn(),
            updateMany: jest.fn(),
            update: jest.fn(),
            deleteMany: jest.fn(),
            delete: jest.fn(),
        },
        album: {
            findMany: jest.fn(),
            groupBy: jest.fn(),
            count: jest.fn(),
            findFirst: jest.fn(),
            findUnique: jest.fn(),
            delete: jest.fn(),
            update: jest.fn(),
        },
        ownedAlbum: {
            groupBy: jest.fn(),
            findMany: jest.fn(),
            findUnique: jest.fn(),
            deleteMany: jest.fn(),
        },
        similarArtist: {
            findMany: jest.fn(),
            deleteMany: jest.fn(),
        },
        genre: {
            findMany: jest.fn(),
        },
        playlist: {
            findUnique: jest.fn(),
        },
        playlistItem: {
            findMany: jest.fn(),
        },
        $transaction: jest.fn(),
        $queryRaw: jest.fn(),
    },
    Prisma: {
        SortOrder: {
            asc: "asc",
            desc: "desc",
        },
        DbNull: null,
        sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
            strings,
            values,
        }),
        join: (values: unknown[]) => values,
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
        getSimilarArtists: jest.fn(),
    },
}));

jest.mock("../../services/fanart", () => ({ fanartService: {} }));

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
    AudioStreamingService: jest.fn(),
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

jest.mock("../../services/remoteTrackBackfillService", () => ({
    backfillRemoteArtistAlbumLinks: jest.fn(),
    isRemoteBackfillInProgress: jest.fn(),
}));

jest.mock("../../services/imageBackfill", () => ({
    isImageBackfillNeeded: jest.fn(),
    getImageBackfillProgress: jest.fn(),
    backfillAllImages: jest.fn(),
}));

jest.mock("../../utils/metadataOverrides", () => ({
    getMergedGenres: jest.fn((artist: any) => [
        ...((artist?.genres as string[] | undefined) ?? []),
        ...((artist?.userGenres as string[] | undefined) ?? []),
    ]),
    getArtistDisplaySummary: jest.fn(() => ""),
}));

jest.mock("../../utils/dateFilters", () => ({
    getEffectiveYear: jest.fn(),
    getDecadeWhereClause: jest.fn(() => ({})),
    getDecadeFromYear: jest.fn(() => 2000),
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

jest.mock("../../services/trackMappingService", () => ({
    trackMappingService: {
        ensureRemoteTrack: jest.fn(),
    },
}));

jest.mock("../../services/remoteTrackMetadataResolver", () => ({
    resolveRemoteTrackMetadataForRequest: jest.fn(async ({ metadata }: any) => ({
        title: metadata?.title ?? "Unknown",
        artist: metadata?.artist ?? "Unknown",
        album: metadata?.album ?? "Unknown",
        duration: metadata?.duration ?? 180,
        thumbnailUrl: metadata?.thumbnailUrl,
        isrc: metadata?.isrc,
        explicit: metadata?.explicit,
    })),
}));

jest.mock("music-metadata", () => ({ parseFile: jest.fn() }), { virtual: true });

jest.mock("../../services/unifiedTrackResponse", () => ({
    normalizeLocalTrack: jest.fn((track: any) => ({
        id: track.id,
        title: track.title,
        duration: track.duration ?? 180,
        trackNo: track.trackNo ?? 1,
        filePath: track.filePath ?? null,
        source: "library",
        provider: {},
        artist: track.album?.artist ?? { id: "artist", name: "Artist" },
        album: {
            id: track.album?.id ?? "album",
            title: track.album?.title ?? "Album",
            coverArt: track.album?.coverUrl ?? null,
        },
    })),
    normalizeTidalTrack: jest.fn(),
    normalizeYtMusicTrack: jest.fn(),
}));

jest.mock("../../services/radioVibeEngine", () => ({
    computeAggregateFeatureVector: jest.fn(),
    scoreTracksAgainstSeed: jest.fn(),
}));

import router from "../library";
import { prisma } from "../../utils/db";
import {
    computeAggregateFeatureVector,
    scoreTracksAgainstSeed,
} from "../../services/radioVibeEngine";
import { AudioStreamingService } from "../../services/audioStreaming";
import { parseFile } from "music-metadata";
import { dataCacheService } from "../../services/dataCache";
import {
    backfillRemoteArtistAlbumLinks,
    isRemoteBackfillInProgress,
} from "../../services/remoteTrackBackfillService";

const mockTrackFindMany = prisma.track.findMany as jest.Mock;
const mockLikedTrackFindMany = prisma.likedTrack.findMany as jest.Mock;
const mockDislikedEntityFindMany = prisma.dislikedEntity.findMany as jest.Mock;
const mockOwnedAlbumFindMany = prisma.ownedAlbum.findMany as jest.Mock;
const mockSimilarArtistFindMany = prisma.similarArtist.findMany as jest.Mock;
const mockArtistFindFirst = prisma.artist.findFirst as jest.Mock;
const mockArtistFindUnique = prisma.artist.findUnique as jest.Mock;
const mockArtistFindMany = prisma.artist.findMany as jest.Mock;
const mockPlaylistFindUnique = prisma.playlist.findUnique as jest.Mock;
const mockPlaylistItemFindMany = prisma.playlistItem.findMany as jest.Mock;
const mockQueryRaw = prisma.$queryRaw as jest.Mock;
const mockTrackFindUnique = prisma.track.findUnique as jest.Mock;
const mockUserSettingsFindUnique = prisma.userSettings.findUnique as jest.Mock;
const mockLikedRemoteDeleteMany = prisma.likedRemoteTrack.deleteMany as jest.Mock;
const mockTrackTidalFindUnique = prisma.trackTidal.findUnique as jest.Mock;
const mockAudioStreamingService = AudioStreamingService as unknown as jest.Mock;
const mockParseFile = parseFile as jest.Mock;
const mockGetArtistImagesBatch =
    dataCacheService.getArtistImagesBatch as jest.Mock;
const mockArtistCount = prisma.artist.count as jest.Mock;
const mockPrismaTransaction = prisma.$transaction as jest.Mock;
const mockRemoteBackfillInProgress = isRemoteBackfillInProgress as jest.Mock;
const mockBackfillRemoteArtistAlbumLinks =
    backfillRemoteArtistAlbumLinks as jest.Mock;
const mockComputeAggregateFeatureVector =
    computeAggregateFeatureVector as jest.Mock;
const mockScoreTracksAgainstSeed = scoreTracksAgainstSeed as jest.Mock;

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

function makeHydratedTrack(id: string, artistId = "artist-x") {
    return {
        id,
        title: `Track ${id}`,
        duration: 180,
        trackNo: 1,
        filePath: `/music/${id}.flac`,
        bpm: 120,
        energy: 0.6,
        valence: 0.5,
        arousal: 0.55,
        danceability: 0.6,
        keyScale: "major",
        instrumentalness: 0.1,
        analysisMode: "standard",
        moodHappy: null,
        moodSad: null,
        moodRelaxed: null,
        moodAggressive: null,
        moodParty: null,
        moodAcoustic: null,
        moodElectronic: null,
        album: {
            id: `album-${artistId}`,
            title: `Album ${artistId}`,
            coverUrl: null,
            artist: { id: artistId, name: `Artist ${artistId}` },
        },
        trackGenres: [],
    };
}

describe("library branch coverage focus", () => {
    const radioHandler = getGetHandler("/radio");
    const likedHandler = getGetHandler("/liked");
    const trackPreferenceGetHandler = getGetHandler("/tracks/:id/preference");
    const trackPreferencePostHandler =
        (router as any).stack.find(
            (entry: any) =>
                entry.route?.path === "/tracks/:id/preference" &&
                entry.route?.methods?.post
        ).route.stack[0].handle;
    const albumPreferencePostHandler =
        (router as any).stack.find(
            (entry: any) =>
                entry.route?.path === "/albums/:id/preference" &&
                entry.route?.methods?.post
        ).route.stack[0].handle;
    const remotePreferenceGetHandler = getGetHandler(
        "/remote-tracks/:id/preference"
    );
    const remotePreferencePostHandler =
        (router as any).stack.find(
            (entry: any) =>
                entry.route?.path === "/remote-tracks/:id/preference" &&
                entry.route?.methods?.post
        ).route.stack[0].handle;
    const audioInfoHandler = getGetHandler("/tracks/:id/audio-info", 1);
    const artistsHandler = getGetHandler("/artists");
    const remoteBackfillHandler =
        (router as any).stack.find(
            (entry: any) =>
                entry.route?.path === "/backfill-remote-artists" &&
                entry.route?.methods?.post
        ).route.stack[0].handle;

    beforeEach(() => {
        jest.clearAllMocks();
        mockLikedTrackFindMany.mockResolvedValue([]);
        mockDislikedEntityFindMany.mockResolvedValue([]);
        mockTrackFindMany.mockResolvedValue([]);
        mockOwnedAlbumFindMany.mockResolvedValue([]);
        mockSimilarArtistFindMany.mockResolvedValue([]);
        mockArtistFindFirst.mockResolvedValue(null);
        mockArtistFindUnique.mockResolvedValue(null);
        mockArtistFindMany.mockResolvedValue([]);
        mockPlaylistFindUnique.mockResolvedValue(null);
        mockPlaylistItemFindMany.mockResolvedValue([]);
        mockQueryRaw.mockResolvedValue([]);
        mockTrackFindUnique.mockResolvedValue(null);
        mockUserSettingsFindUnique.mockResolvedValue(null);
        mockTrackTidalFindUnique.mockResolvedValue(null);
        mockLikedRemoteDeleteMany.mockResolvedValue({ count: 0 });
        mockGetArtistImagesBatch.mockResolvedValue(new Map());
        mockArtistCount.mockResolvedValue(1);
        mockPrismaTransaction.mockImplementation(async (callback: any) => {
            const tx = {
                artist: {
                    findMany: jest.fn().mockResolvedValue([]),
                    count: jest.fn().mockResolvedValue(0),
                },
            };
            return callback(tx);
        });
        mockRemoteBackfillInProgress.mockReturnValue(false);
        mockBackfillRemoteArtistAlbumLinks.mockResolvedValue(undefined);
        mockAudioStreamingService.mockImplementation(() => ({
            getStreamFilePath: jest.fn(),
            streamFileWithRangeSupport: jest.fn(),
            destroy: jest.fn(),
        }));
        mockParseFile.mockResolvedValue({
            format: {
                codec: "flac",
                bitrate: 800000,
                sampleRate: 44100,
                bitsPerSample: 16,
                lossless: true,
                numberOfChannels: 2,
            },
        });
        mockComputeAggregateFeatureVector.mockReturnValue(null);
        mockScoreTracksAgainstSeed.mockReturnValue([]);
    });

    it("returns 400 for artist-name radio without value", async () => {
        const req = {
            query: { type: "artist-name", value: "   " },
            user: { id: "u1" },
        } as any;
        const res = createRes();

        await radioHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Artist name is required for artist-name radio",
        });
    });

    it("returns empty tracks when artist-name lookup has no match", async () => {
        mockArtistFindFirst.mockResolvedValueOnce(null);
        const req = {
            query: { type: "artist-name", value: "No Such Artist", limit: "10" },
            user: { id: "u1" },
        } as any;
        const res = createRes();

        await radioHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ tracks: [] });
    });

    it("requires auth for liked radio", async () => {
        const req = {
            query: { type: "liked", limit: "10" },
        } as any;
        const res = createRes();

        await radioHandler(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({
            error: "Authentication required for liked radio",
        });
    });

    it("validates playlist radio input and access checks", async () => {
        const missingReq = {
            query: { type: "playlist" },
            user: { id: "u1" },
        } as any;
        const missingRes = createRes();
        await radioHandler(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(400);

        const myLikedNoAuthReq = {
            query: { type: "playlist", value: "my-liked" },
        } as any;
        const myLikedNoAuthRes = createRes();
        await radioHandler(myLikedNoAuthReq, myLikedNoAuthRes);
        expect(myLikedNoAuthRes.statusCode).toBe(401);

        mockPlaylistFindUnique.mockResolvedValueOnce(null);
        const notFoundReq = {
            query: { type: "playlist", value: "pl-404" },
            user: { id: "u1" },
        } as any;
        const notFoundRes = createRes();
        await radioHandler(notFoundReq, notFoundRes);
        expect(notFoundRes.statusCode).toBe(404);

        mockPlaylistFindUnique.mockResolvedValueOnce({
            userId: "owner-1",
            isPublic: false,
        });
        const deniedReq = {
            query: { type: "playlist", value: "pl-private" },
            user: { id: "u1" },
        } as any;
        const deniedRes = createRes();
        await radioHandler(deniedReq, deniedRes);
        expect(deniedRes.statusCode).toBe(403);
        expect(deniedRes.body).toEqual({ error: "Access denied to private playlist" });
    });

    it("returns empty tracks for tracks radio with blank list", async () => {
        const req = {
            query: { type: "tracks", value: " , ,  " },
            user: { id: "u1" },
        } as any;
        const res = createRes();

        await radioHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ tracks: [] });
    });

    it("returns 400 for tracks radio when value is missing", async () => {
        const req = {
            query: { type: "tracks" },
            user: { id: "u1" },
        } as any;
        const res = createRes();

        await radioHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Track IDs required for tracks radio" });
    });

    it("returns empty tracks when seeded tracks do not exist", async () => {
        mockTrackFindMany.mockResolvedValueOnce([]);

        const req = {
            query: { type: "tracks", value: "seed-a,seed-b", limit: "6" },
            user: { id: "u1" },
        } as any;
        const res = createRes();

        await radioHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ tracks: [] });
    });

    it("covers multi-track radio fallback chain and deterministic ordering", async () => {
        const seedTracks = [
            {
                id: "seed-1",
                bpm: 120,
                energy: 0.7,
                valence: 0.5,
                arousal: 0.5,
                danceability: 0.6,
                keyScale: "major",
                moodTags: ["upbeat"],
                lastfmTags: ["rock"],
                essentiaGenres: ["rock"],
                instrumentalness: 0.1,
                moodHappy: null,
                moodSad: null,
                moodRelaxed: null,
                moodAggressive: null,
                moodParty: null,
                moodAcoustic: null,
                moodElectronic: null,
                danceabilityMl: null,
                analysisMode: "standard",
                analysisVersion: null,
                album: {
                    artistId: "seed-artist",
                    artist: {
                        id: "seed-artist",
                        genres: ["Rock"],
                        userGenres: [],
                    },
                },
            },
        ];
        const candidateRows = [
            {
                id: "cand-1",
                bpm: 122,
                energy: 0.72,
                valence: 0.52,
                arousal: 0.51,
                danceability: 0.61,
                keyScale: "major",
                moodTags: [],
                lastfmTags: ["rock"],
                essentiaGenres: ["rock"],
                instrumentalness: 0.11,
                moodHappy: null,
                moodSad: null,
                moodRelaxed: null,
                moodAggressive: null,
                moodParty: null,
                moodAcoustic: null,
                moodElectronic: null,
                danceabilityMl: null,
                analysisMode: "standard",
                analysisVersion: null,
                album: { artistId: "sim-artist-a" },
            },
            {
                id: "cand-2",
                bpm: 100,
                energy: 0.2,
                valence: 0.2,
                arousal: 0.2,
                danceability: 0.2,
                keyScale: "minor",
                moodTags: [],
                lastfmTags: [],
                essentiaGenres: [],
                instrumentalness: 0.8,
                moodHappy: null,
                moodSad: null,
                moodRelaxed: null,
                moodAggressive: null,
                moodParty: null,
                moodAcoustic: null,
                moodElectronic: null,
                danceabilityMl: null,
                analysisMode: "standard",
                analysisVersion: null,
                album: { artistId: "sim-artist-b" },
            },
        ];

        mockTrackFindMany
            .mockResolvedValueOnce(seedTracks)
            .mockResolvedValueOnce(candidateRows)
            .mockResolvedValueOnce([{ id: "artist-fallback-1" }])
            .mockResolvedValueOnce([{ id: "random-fill-1" }])
            .mockResolvedValueOnce([
                makeHydratedTrack("cand-1", "sim-artist-a"),
                makeHydratedTrack("artist-fallback-1", "seed-artist"),
                makeHydratedTrack("genre-fallback-1", "genre-artist"),
                makeHydratedTrack("random-fill-1", "random-artist"),
            ]);
        mockLikedTrackFindMany
            .mockResolvedValueOnce([{ trackId: "cand-1", likedAt: new Date() }])
            .mockResolvedValueOnce([]);
        mockDislikedEntityFindMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        mockComputeAggregateFeatureVector.mockReturnValueOnce({ seed: true });
        mockScoreTracksAgainstSeed.mockReturnValueOnce([
            { id: "cand-1", score: 0.9 },
        ]);
        mockQueryRaw.mockResolvedValueOnce([{ id: "genre-fallback-1" }]);

        const req = {
            query: { type: "tracks", value: "seed-1", limit: "4" },
            user: { id: "u1" },
        } as any;
        const res = createRes();

        await radioHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.tracks).toHaveLength(4);
        expect(res.body.tracks.map((t: any) => t.id)).toEqual([
            "cand-1",
            "artist-fallback-1",
            "genre-fallback-1",
            "random-fill-1",
        ]);
    });

    it("applies similar-track preference weighting in artist radio", async () => {
        mockTrackFindMany
            .mockResolvedValueOnce([
                {
                    id: "artist-track-1",
                    bpm: 120,
                    energy: 0.7,
                    valence: 0.6,
                    danceability: 0.5,
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: "sim-track-1",
                    bpm: 121,
                    energy: 0.71,
                    valence: 0.61,
                    danceability: 0.5,
                    album: { artistId: "sim-a" },
                },
            ])
            .mockResolvedValueOnce([
                makeHydratedTrack("artist-track-1", "artist-main"),
                makeHydratedTrack("sim-track-1", "sim-a"),
            ]);
        mockOwnedAlbumFindMany.mockResolvedValue([{ artistId: "sim-a" }]);
        mockSimilarArtistFindMany.mockResolvedValue([
            { fromArtistId: "artist-main", toArtistId: "sim-a", weight: 0.8 },
        ]);
        mockLikedTrackFindMany
            .mockResolvedValueOnce([{ trackId: "sim-track-1", likedAt: new Date() }])
            .mockResolvedValueOnce([]);
        mockDislikedEntityFindMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);

        const req = {
            query: { type: "artist", value: "artist-main", limit: "2" },
            user: { id: "u1" },
        } as any;
        const res = createRes();

        await radioHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.tracks).toHaveLength(2);
        expect(mockLikedTrackFindMany).toHaveBeenCalled();
    });

    it("validates liked playlist cursor inputs", async () => {
        const mismatchedReq = {
            query: { cursorLikedAt: "2026-01-01T00:00:00.000Z" },
            user: { id: "u1" },
        } as any;
        const mismatchedRes = createRes();
        await likedHandler(mismatchedReq, mismatchedRes);
        expect(mismatchedRes.statusCode).toBe(400);

        const invalidDateReq = {
            query: {
                cursorLikedAt: "not-a-date",
                cursorTrackId: "track-1",
            },
            user: { id: "u1" },
        } as any;
        const invalidDateRes = createRes();
        await likedHandler(invalidDateReq, invalidDateRes);
        expect(invalidDateRes.statusCode).toBe(400);
    });

    it("covers local track preference auth and not-found branches", async () => {
        const noUserReq = { params: { id: "track-1" } } as any;
        const noUserRes = createRes();
        await trackPreferenceGetHandler(noUserReq, noUserRes);
        expect(noUserRes.statusCode).toBe(401);

        mockTrackFindUnique.mockResolvedValueOnce(null);
        const missingReq = {
            params: { id: "missing" },
            user: { id: "u1" },
        } as any;
        const missingRes = createRes();
        await trackPreferenceGetHandler(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);
    });

    it("covers track and album preference mutation validation branches", async () => {
        const albumNoUserReq = { params: { id: "album-1" }, body: {} } as any;
        const albumNoUserRes = createRes();
        await albumPreferencePostHandler(albumNoUserReq, albumNoUserRes);
        expect(albumNoUserRes.statusCode).toBe(401);

        (prisma.album.findFirst as jest.Mock).mockResolvedValueOnce(null);
        const albumMissingReq = {
            params: { id: "album-404" },
            body: { signal: "thumbs_up" },
            user: { id: "u1" },
        } as any;
        const albumMissingRes = createRes();
        await albumPreferencePostHandler(albumMissingReq, albumMissingRes);
        expect(albumMissingRes.statusCode).toBe(404);

        const trackNoUserReq = { params: { id: "track-1" }, body: {} } as any;
        const trackNoUserRes = createRes();
        await trackPreferencePostHandler(trackNoUserReq, trackNoUserRes);
        expect(trackNoUserRes.statusCode).toBe(401);

        mockTrackFindUnique.mockResolvedValueOnce(null);
        const trackMissingReq = {
            params: { id: "track-404" },
            body: { signal: "thumbs_up" },
            user: { id: "u1" },
        } as any;
        const trackMissingRes = createRes();
        await trackPreferencePostHandler(trackMissingReq, trackMissingRes);
        expect(trackMissingRes.statusCode).toBe(404);
    });

    it("covers remote preference auth and tidal id validation/clear branches", async () => {
        const getNoUserReq = { params: { id: "yt:abc" } } as any;
        const getNoUserRes = createRes();
        await remotePreferenceGetHandler(getNoUserReq, getNoUserRes);
        expect(getNoUserRes.statusCode).toBe(401);

        const invalidTidalGetReq = {
            params: { id: "tidal:0" },
            user: { id: "u1" },
        } as any;
        const invalidTidalGetRes = createRes();
        await remotePreferenceGetHandler(invalidTidalGetReq, invalidTidalGetRes);
        expect(invalidTidalGetRes.statusCode).toBe(400);

        const postNoUserReq = {
            params: { id: "tidal:10" },
            body: { signal: "clear" },
        } as any;
        const postNoUserRes = createRes();
        await remotePreferencePostHandler(postNoUserReq, postNoUserRes);
        expect(postNoUserRes.statusCode).toBe(401);

        mockTrackTidalFindUnique.mockResolvedValueOnce({ id: "tidal-row-1" });
        const clearReq = {
            params: { id: "tidal:10" },
            body: { signal: "clear" },
            user: { id: "u1" },
        } as any;
        const clearRes = createRes();
        await remotePreferencePostHandler(clearReq, clearRes);
        expect(clearRes.statusCode).toBe(200);
        expect(mockLikedRemoteDeleteMany).toHaveBeenCalledWith({
            where: { userId: "u1", trackTidalId: "tidal-row-1" },
        });
    });

    it("covers audio-info playback auth and playback-file resolution branches", async () => {
        const existsSpy = jest.spyOn(fs, "existsSync");
        existsSpy.mockImplementation((p: any) => !String(p).includes("missing"));

        mockTrackFindUnique.mockResolvedValue({
            filePath: "artist/album/source.flac",
            fileModified: new Date("2026-01-01T00:00:00.000Z"),
        });

        const unauthorizedPlaybackReq = {
            params: { id: "track-1" },
            query: { playback: "true" },
        } as any;
        const unauthorizedPlaybackRes = createRes();
        await audioInfoHandler(unauthorizedPlaybackReq, unauthorizedPlaybackRes);
        expect(unauthorizedPlaybackRes.statusCode).toBe(401);

        const getStreamFilePath = jest
            .fn()
            .mockResolvedValueOnce({ filePath: "/tmp/missing-playback.mp3" });
        mockAudioStreamingService.mockImplementationOnce(() => ({
            getStreamFilePath,
            streamFileWithRangeSupport: jest.fn(),
            destroy: jest.fn(),
        }));
        mockUserSettingsFindUnique.mockResolvedValueOnce({ playbackQuality: "invalid" });

        const missingPlaybackReq = {
            params: { id: "track-1" },
            query: { playback: "true", quality: "n/a" },
            user: { id: "u1" },
        } as any;
        const missingPlaybackRes = createRes();
        await audioInfoHandler(missingPlaybackReq, missingPlaybackRes);
        expect(missingPlaybackRes.statusCode).toBe(404);

        const getStreamFilePath2 = jest
            .fn()
            .mockResolvedValueOnce({ filePath: "/tmp/playback-ok.mp3" });
        mockAudioStreamingService.mockImplementationOnce(() => ({
            getStreamFilePath: getStreamFilePath2,
            streamFileWithRangeSupport: jest.fn(),
            destroy: jest.fn(),
        }));

        const successReq = {
            params: { id: "track-1" },
            query: { playback: "true", quality: "high" },
            user: { id: "u1" },
        } as any;
        const successRes = createRes();
        await audioInfoHandler(successReq, successRes);

        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual(
            expect.objectContaining({
                codec: "flac",
                bitrate: 800,
                sampleRate: 44100,
                bitDepth: 16,
                lossless: true,
                channels: 2,
            })
        );

        existsSpy.mockRestore();
    });

    it("covers artists fallback filtering when denormalized counts are not ready", async () => {
        const txArtistFindMany = jest.fn().mockResolvedValue([]);
        const txArtistCount = jest.fn().mockResolvedValue(0);
        mockPrismaTransaction.mockImplementation(async (callback: any) =>
            callback({
                artist: {
                    findMany: txArtistFindMany,
                    count: txArtistCount,
                },
            })
        );
        mockArtistCount.mockResolvedValue(0);

        const remoteReq = {
            query: { filter: "remote", limit: "5" },
            user: { id: "u1" },
        } as any;
        const remoteRes = createRes();
        await artistsHandler(remoteReq, remoteRes);
        expect(remoteRes.statusCode).toBe(200);
        expect(txArtistFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: [{ tracksTidal: { some: {} } }, { tracksYtMusic: { some: {} } }],
                    NOT: { albums: { some: { tracks: { some: {} } } } },
                }),
            })
        );

        const allReq = {
            query: { filter: "all", limit: "5" },
            user: { id: "u1" },
        } as any;
        const allRes = createRes();
        await artistsHandler(allReq, allRes);
        expect(allRes.statusCode).toBe(200);
        expect(txArtistFindMany).toHaveBeenLastCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: [
                        { albums: { some: { tracks: { some: {} } } } },
                        { tracksTidal: { some: {} } },
                        { tracksYtMusic: { some: {} } },
                    ],
                }),
            })
        );
    });

    it("covers remote artist backfill in-progress/start/error branches", async () => {
        mockRemoteBackfillInProgress.mockReturnValueOnce(true);
        const inProgressReq = { user: { id: "u1" } } as any;
        const inProgressRes = createRes();
        await remoteBackfillHandler(inProgressReq, inProgressRes);
        expect(inProgressRes.statusCode).toBe(200);
        expect(inProgressRes.body).toEqual({
            message: "Remote artist backfill already in progress",
            status: "processing",
        });

        mockRemoteBackfillInProgress.mockReturnValueOnce(false);
        mockBackfillRemoteArtistAlbumLinks.mockResolvedValueOnce(undefined);
        const startReq = { user: { id: "u1" } } as any;
        const startRes = createRes();
        await remoteBackfillHandler(startReq, startRes);
        expect(startRes.statusCode).toBe(200);
        expect(startRes.body).toEqual({
            message: "Remote artist backfill started",
            status: "processing",
        });

        mockRemoteBackfillInProgress.mockImplementationOnce(() => {
            throw new Error("boom");
        });
        const errReq = { user: { id: "u1" } } as any;
        const errRes = createRes();
        await remoteBackfillHandler(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
    });

    it("covers artist-name match remapping and playlist radio seed loading", async () => {
        mockArtistFindFirst.mockResolvedValueOnce({ id: "artist-main" });
        mockTrackFindMany
            .mockResolvedValueOnce([
                {
                    id: "artist-track-1",
                    bpm: 120,
                    energy: 0.7,
                    valence: 0.6,
                    danceability: 0.5,
                },
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([makeHydratedTrack("artist-track-1", "artist-main")]);
        mockOwnedAlbumFindMany.mockResolvedValue([]);
        mockSimilarArtistFindMany.mockResolvedValue([]);

        const artistNameReq = {
            query: { type: "artist-name", value: "Artist Name", limit: "1" },
            user: { id: "u1" },
        } as any;
        const artistNameRes = createRes();
        await radioHandler(artistNameReq, artistNameRes);
        expect(artistNameRes.statusCode).toBe(200);

        mockLikedTrackFindMany.mockResolvedValueOnce([{ trackId: "seed-like-1" }]);
        mockTrackFindMany.mockResolvedValueOnce([]);
        const myLikedReq = {
            query: { type: "playlist", value: "my-liked", limit: "5" },
            user: { id: "u1" },
        } as any;
        const myLikedRes = createRes();
        await radioHandler(myLikedReq, myLikedRes);
        expect(myLikedRes.statusCode).toBe(200);
        expect(myLikedRes.body).toEqual({ tracks: [] });

        mockPlaylistFindUnique.mockResolvedValueOnce({ userId: "u1", isPublic: false });
        mockPlaylistItemFindMany.mockResolvedValueOnce([
            { trackId: "seed-pl-1" },
            { trackId: null },
            { trackId: "seed-pl-2" },
        ]);
        mockTrackFindMany.mockResolvedValueOnce([]);
        const playlistReq = {
            query: { type: "playlist", value: "playlist-1", limit: "5" },
            user: { id: "u1" },
        } as any;
        const playlistRes = createRes();
        await radioHandler(playlistReq, playlistRes);
        expect(playlistRes.statusCode).toBe(200);
        expect(mockPlaylistItemFindMany).toHaveBeenCalledWith({
            where: { playlistId: "playlist-1", trackId: { not: null } },
            select: { trackId: true },
        });
    });
});
