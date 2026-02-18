import { Request, Response } from "express";
import fs from "fs";

const mockStreamGetStreamFilePath = jest.fn();
const mockStreamWithRangeSupport = jest.fn();
const mockStreamDestroy = jest.fn();
const mockParseFile = jest.fn();

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
        audiobookProgress: {
            findMany: jest.fn(),
        },
        podcastProgress: {
            findMany: jest.fn(),
        },
        ownedAlbum: {
            groupBy: jest.fn(),
            findMany: jest.fn(),
            findUnique: jest.fn(),
            deleteMany: jest.fn(),
        },
        genre: {
            findMany: jest.fn(),
        },
        similarArtist: {
            findMany: jest.fn(),
            deleteMany: jest.fn(),
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

jest.mock("../../services/fanart", () => ({
    fanartService: {},
}));

jest.mock("../../services/deezer", () => ({
    deezerService: {
        getAlbumCover: jest.fn(),
        getArtistImage: jest.fn(),
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
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("../../services/audioStreaming", () => ({
    AudioStreamingService: jest.fn().mockImplementation(() => ({
        getStreamFilePath: mockStreamGetStreamFilePath,
        streamFileWithRangeSupport: mockStreamWithRangeSupport,
        destroy: mockStreamDestroy,
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

const mockLidarrDeleteArtist = jest.fn();
jest.mock("../../services/lidarr", () => ({
    lidarrService: {
        deleteArtist: mockLidarrDeleteArtist,
    },
}));

jest.mock(
    "music-metadata",
    () => ({
        parseFile: mockParseFile,
    }),
    { virtual: true }
);

import router from "../library";
import { config } from "../../config";
import { prisma } from "../../utils/db";
import { redisClient } from "../../utils/redis";
import { scanQueue } from "../../workers/queues";
import { organizeSingles } from "../../workers/organizeSingles";
import { logger } from "../../utils/logger";
import { AudioStreamingService } from "../../services/audioStreaming";
import { coverArtService } from "../../services/coverArt";
import {
    fetchExternalImage,
    normalizeExternalImageUrl,
} from "../../services/imageProxy";
import { extractColorsFromImage } from "../../utils/colorExtractor";
import { getSystemSettings } from "../../utils/systemSettings";
import { dataCacheService } from "../../services/dataCache";
import { lastFmService } from "../../services/lastfm";
import { deezerService } from "../../services/deezer";
import { musicBrainzService } from "../../services/musicbrainz";
import { getMergedGenres } from "../../utils/metadataOverrides";
import {
    isBackfillNeeded,
    getBackfillProgress,
    isBackfillInProgress,
    backfillAllArtistCounts,
} from "../../services/artistCountsService";
import {
    isImageBackfillNeeded,
    getImageBackfillProgress,
    backfillAllImages,
} from "../../services/imageBackfill";
import {
    getDecadeFromYear,
    getDecadeWhereClause,
    getEffectiveYear,
} from "../../utils/dateFilters";
import { shuffleArray } from "../../utils/shuffle";

const mockTrackFindUnique = prisma.track.findUnique as jest.Mock;
const mockTrackFindMany = prisma.track.findMany as jest.Mock;
const mockTrackCount = prisma.track.count as jest.Mock;
const mockTrackDelete = prisma.track.delete as jest.Mock;
const mockTrackDeleteMany = prisma.track.deleteMany as jest.Mock;
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;
const mockPlayFindFirst = prisma.play.findFirst as jest.Mock;
const mockPlayCreate = prisma.play.create as jest.Mock;
const mockPlayFindMany = prisma.play.findMany as jest.Mock;
const mockPlayGroupBy = prisma.play.groupBy as jest.Mock;
const mockUserSettingsFindUnique = prisma.userSettings.findUnique as jest.Mock;
const mockArtistFindMany = prisma.artist.findMany as jest.Mock;
const mockArtistFindUnique = prisma.artist.findUnique as jest.Mock;
const mockArtistFindFirst = prisma.artist.findFirst as jest.Mock;
const mockArtistUpdateMany = prisma.artist.updateMany as jest.Mock;
const mockArtistUpdate = prisma.artist.update as jest.Mock;
const mockArtistDeleteMany = prisma.artist.deleteMany as jest.Mock;
const mockArtistDelete = prisma.artist.delete as jest.Mock;
const mockAlbumFindMany = prisma.album.findMany as jest.Mock;
const mockAlbumGroupBy = prisma.album.groupBy as jest.Mock;
const mockAlbumCount = prisma.album.count as jest.Mock;
const mockAlbumFindFirst = prisma.album.findFirst as jest.Mock;
const mockAlbumFindUnique = prisma.album.findUnique as jest.Mock;
const mockAlbumDelete = prisma.album.delete as jest.Mock;
const mockAlbumUpdate = prisma.album.update as jest.Mock;
const mockAudiobookProgressFindMany = prisma.audiobookProgress.findMany as jest.Mock;
const mockPodcastProgressFindMany = prisma.podcastProgress.findMany as jest.Mock;
const mockOwnedAlbumGroupBy = prisma.ownedAlbum.groupBy as jest.Mock;
const mockOwnedAlbumFindMany = prisma.ownedAlbum.findMany as jest.Mock;
const mockOwnedAlbumFindUnique = prisma.ownedAlbum.findUnique as jest.Mock;
const mockOwnedAlbumDeleteMany = prisma.ownedAlbum.deleteMany as jest.Mock;
const mockGenreFindMany = prisma.genre.findMany as jest.Mock;
const mockSimilarArtistFindMany = prisma.similarArtist.findMany as jest.Mock;
const mockSimilarArtistDeleteMany = prisma.similarArtist.deleteMany as jest.Mock;
const mockPrismaTransaction = prisma.$transaction as jest.Mock;
const mockPrismaQueryRaw = prisma.$queryRaw as jest.Mock;
const mockScanQueueAdd = scanQueue.add as jest.Mock;
const mockScanQueueGetJob = scanQueue.getJob as jest.Mock;
const mockOrganizeSingles = organizeSingles as jest.Mock;
const mockLoggerInfo = logger.info as jest.Mock;
const mockLoggerError = logger.error as jest.Mock;
const mockLoggerDebug = logger.debug as jest.Mock;
const mockAudioStreamingCtor = AudioStreamingService as unknown as jest.Mock;
const mockCoverArtGetCoverArt = coverArtService.getCoverArt as jest.Mock;
const mockFetchExternalImage = fetchExternalImage as jest.Mock;
const mockNormalizeExternalImageUrl = normalizeExternalImageUrl as jest.Mock;
const mockExtractColorsFromImage = extractColorsFromImage as jest.Mock;
const mockGetSystemSettings = getSystemSettings as jest.Mock;
const mockGetArtistImagesBatch = dataCacheService.getArtistImagesBatch as jest.Mock;
const mockGetArtistImage = dataCacheService.getArtistImage as jest.Mock;
const mockLastFmGetArtistTopTracks = lastFmService.getArtistTopTracks as jest.Mock;
const mockLastFmGetSimilarArtists = lastFmService.getSimilarArtists as jest.Mock;
const mockDeezerGetArtistImage = deezerService.getArtistImage as jest.Mock;
const mockMusicBrainzSearchArtist = musicBrainzService.searchArtist as jest.Mock;
const mockMusicBrainzGetReleaseGroups = musicBrainzService.getReleaseGroups as jest.Mock;
const mockIsBackfillNeeded = isBackfillNeeded as jest.Mock;
const mockGetBackfillProgress = getBackfillProgress as jest.Mock;
const mockIsBackfillInProgress = isBackfillInProgress as jest.Mock;
const mockBackfillAllArtistCounts = backfillAllArtistCounts as jest.Mock;
const mockIsImageBackfillNeeded = isImageBackfillNeeded as jest.Mock;
const mockGetImageBackfillProgress = getImageBackfillProgress as jest.Mock;
const mockBackfillAllImages = backfillAllImages as jest.Mock;
const mockGetDecadeFromYear = getDecadeFromYear as jest.Mock;
const mockGetDecadeWhereClause = getDecadeWhereClause as jest.Mock;
const mockGetEffectiveYear = getEffectiveYear as jest.Mock;
const mockShuffleArray = shuffleArray as jest.Mock;
const mockGetMergedGenres = getMergedGenres as jest.Mock;
const mockDeezerGetAlbumCover = deezerService.getAlbumCover as jest.Mock;

function getHandler(
    method: "get" | "post" | "delete" | "put" | "patch",
    path: string,
    stackIndex = 0
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );
    if (!layer) {
        throw new Error(`Route not found: [${method}] ${path}`);
    }
    return layer.route.stack[stackIndex].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        body: undefined as unknown,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
        send: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
        sendFile: jest.fn(function (filePath: string, options?: unknown) {
            res.body = { filePath, options };
            return res;
        }),
        redirect: jest.fn(function (location: string) {
            res.body = { redirect: location };
            return res;
        }),
        end: jest.fn(function () {
            return res;
        }),
        setHeader: jest.fn(function (key: string, value: string) {
            res.headers[key] = value;
            return res;
        }),
    };
    return res;
}

const flushPromises = () =>
    new Promise<void>((resolve) => {
        setImmediate(resolve);
    });

function createNativeTrack(overrides?: Partial<any>) {
    return {
        id: "track-1",
        title: "Track One",
        filePath: "Artist\\Album\\track.flac",
        fileModified: new Date("2024-01-01T00:00:00.000Z"),
        ...overrides,
    };
}

function createRadioTrack(id: string, overrides?: Partial<any>) {
    return {
        id,
        title: `Track ${id}`,
        duration: 180,
        trackNo: 1,
        filePath: `/music/${id}.flac`,
        bpm: 120,
        energy: 0.6,
        valence: 0.5,
        arousal: 0.5,
        danceability: 0.5,
        keyScale: "major",
        instrumentalness: 0.1,
        analysisMode: "standard",
        analysisVersion: "1.0.0",
        moodHappy: 0.5,
        moodSad: 0.5,
        moodRelaxed: 0.5,
        moodAggressive: 0.5,
        moodParty: 0.5,
        moodAcoustic: 0.5,
        moodElectronic: 0.5,
        album: {
            id: `album-${id}`,
            title: `Album ${id}`,
            coverUrl: `cover-${id}.jpg`,
            artist: {
                id: `artist-${id}`,
                name: `Artist ${id}`,
            },
        },
        trackGenres: [],
        ...overrides,
    };
}

describe("library scan and organize runtime coverage", () => {
    const scanHandler = getHandler("post", "/scan");
    const scanStatusHandler = getHandler("get", "/scan/status/:jobId");
    const organizeHandler = getHandler("post", "/organize");

    beforeEach(() => {
        jest.clearAllMocks();
        (config.music as any).musicPath = "/music";
        (config.music as any).transcodeCachePath = "/tmp/soundspan-cache";
        (config.music as any).transcodeCacheMaxGb = 1;

        mockOrganizeSingles.mockResolvedValue(undefined);
        mockScanQueueAdd.mockResolvedValue({ id: "job-123" });
        mockScanQueueGetJob.mockResolvedValue(null);
    });

    it("short-circuits scan when MUSIC_PATH is missing", async () => {
        (config.music as any).musicPath = "";

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();

        await scanHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Music path not configured. Please set MUSIC_PATH environment variable.",
        });
        expect(mockOrganizeSingles).not.toHaveBeenCalled();
        expect(mockScanQueueAdd).not.toHaveBeenCalled();
    });

    it("continues scan when pre-scan organization fails", async () => {
        mockOrganizeSingles.mockRejectedValueOnce(new Error("slskd unavailable"));

        const req = { user: { id: "user-22" } } as any;
        const res = createRes();

        await scanHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Library scan started",
            jobId: "job-123",
            musicPath: "/music",
        });
        expect(mockScanQueueAdd).toHaveBeenCalledWith("scan", {
            userId: "user-22",
            musicPath: "/music",
        });
        expect(mockLoggerInfo).toHaveBeenCalledWith(
            "[Scan] SLSKD organization skipped:",
            "slskd unavailable"
        );
    });

    it("uses system user id when scan requester is missing", async () => {
        const req = {} as any;
        const res = createRes();

        await scanHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockScanQueueAdd).toHaveBeenCalledWith("scan", {
            userId: "system",
            musicPath: "/music",
        });
    });

    it("returns scan trigger error when queue add fails", async () => {
        mockScanQueueAdd.mockRejectedValueOnce(new Error("queue unavailable"));

        const req = { user: { id: "user-3" } } as any;
        const res = createRes();

        await scanHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to start scan" });
    });

    it("returns 404 for unknown scan jobs", async () => {
        mockScanQueueGetJob.mockResolvedValueOnce(null);

        const req = { params: { jobId: "missing-job" } } as any;
        const res = createRes();

        await scanStatusHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Job not found" });
    });

    it("maps Bull job state, progress, and result to response payload", async () => {
        const job = {
            getState: jest.fn().mockResolvedValue("completed"),
            progress: jest.fn(() => 68),
            returnvalue: { indexed: 241 },
        };
        mockScanQueueGetJob.mockResolvedValueOnce(job);

        const req = { params: { jobId: "job-123" } } as any;
        const res = createRes();

        await scanStatusHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            status: "completed",
            progress: 68,
            result: { indexed: 241 },
        });
        expect(job.getState).toHaveBeenCalledTimes(1);
        expect(job.progress).toHaveBeenCalledTimes(1);
    });

    it("returns 500 when scan status lookup throws", async () => {
        mockScanQueueGetJob.mockRejectedValueOnce(new Error("redis down"));

        const req = { params: { jobId: "job-99" } } as any;
        const res = createRes();

        await scanStatusHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to get job status" });
    });

    it("starts manual organization in background", async () => {
        const req = {} as any;
        const res = createRes();

        await organizeHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Organization started in background",
        });
        expect(mockOrganizeSingles).toHaveBeenCalledTimes(1);
    });

    it("keeps organization endpoint successful when background promise rejects", async () => {
        const backgroundError = new Error("organizer worker failed");
        mockOrganizeSingles.mockReturnValueOnce(Promise.reject(backgroundError));

        const req = {} as any;
        const res = createRes();

        await organizeHandler(req, res);
        await flushPromises();

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Organization started in background",
        });
        expect(mockLoggerError).toHaveBeenCalledWith(
            "Manual organization failed:",
            backgroundError
        );
    });

    it("returns 500 when manual organization throws synchronously", async () => {
        mockOrganizeSingles.mockImplementationOnce(() => {
            throw new Error("sync crash");
        });

        const req = {} as any;
        const res = createRes();

        await organizeHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to start organization" });
    });
});

describe("library policy and backfill runtime coverage", () => {
    const deletePolicyHandler = getHandler("get", "/delete-policy");
    const artistCountsStatusHandler = getHandler("get", "/artist-counts/status");
    const artistCountsBackfillHandler = getHandler(
        "post",
        "/artist-counts/backfill"
    );
    const imageBackfillStatusHandler = getHandler(
        "get",
        "/image-backfill/status"
    );
    const imageBackfillStartHandler = getHandler("post", "/image-backfill/start");
    const backfillGenresHandler = getHandler("post", "/backfill-genres");

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetSystemSettings.mockResolvedValue({
            libraryDeletionEnabled: true,
        });
        mockIsBackfillNeeded.mockResolvedValue(true);
        mockGetBackfillProgress.mockResolvedValue({
            inProgress: false,
            processed: 0,
            total: 50,
        });
        mockIsBackfillInProgress.mockReturnValue(false);
        mockBackfillAllArtistCounts.mockResolvedValue(undefined);
        mockIsImageBackfillNeeded.mockResolvedValue({
            needsBackfill: true,
            totalArtists: 50,
        });
        mockGetImageBackfillProgress.mockReturnValue({
            inProgress: false,
            processed: 0,
            total: 50,
        });
        mockBackfillAllImages.mockResolvedValue(undefined);
        mockArtistFindMany.mockResolvedValue([]);
        mockArtistUpdateMany.mockResolvedValue({ count: 0 });
    });

    it("returns deny-all delete policy for non-admin users", async () => {
        const req = { user: { id: "user-1", role: "user" } } as any;
        const res = createRes();

        await deletePolicyHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            isAdmin: false,
            libraryDeletionEnabled: false,
            canDelete: false,
        });
        expect(mockGetSystemSettings).not.toHaveBeenCalled();
    });

    it("returns admin delete policy from system settings", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: false,
        });

        const req = { user: { id: "admin-1", role: "admin" } } as any;
        const res = createRes();
        await deletePolicyHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            isAdmin: true,
            libraryDeletionEnabled: false,
            canDelete: false,
        });
    });

    it("handles delete policy errors", async () => {
        mockGetSystemSettings.mockRejectedValueOnce(new Error("settings down"));

        const req = { user: { id: "admin-1", role: "admin" } } as any;
        const res = createRes();
        await deletePolicyHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to determine delete policy" });
    });

    it("returns artist count status and handles status failures", async () => {
        const okRes = createRes();
        await artistCountsStatusHandler({ user: { id: "admin-1" } } as any, okRes);

        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual({
            needsBackfill: true,
            inProgress: false,
            processed: 0,
            total: 50,
        });

        mockIsBackfillNeeded.mockRejectedValueOnce(new Error("status failed"));
        const errRes = createRes();
        await artistCountsStatusHandler(
            { user: { id: "admin-1" } } as any,
            errRes
        );

        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to check status" });
    });

    it("handles artist count backfill in-progress, start, and trigger errors", async () => {
        mockIsBackfillInProgress.mockReturnValueOnce(true);
        const inProgressRes = createRes();
        await artistCountsBackfillHandler(
            { user: { id: "admin-1" } } as any,
            inProgressRes
        );
        expect(inProgressRes.statusCode).toBe(200);
        expect(inProgressRes.body).toEqual({
            message: "Backfill already in progress",
            status: "processing",
        });

        mockIsBackfillInProgress.mockReturnValueOnce(false);
        const startRes = createRes();
        await artistCountsBackfillHandler(
            { user: { id: "admin-1" } } as any,
            startRes
        );
        expect(startRes.statusCode).toBe(200);
        expect(startRes.body).toEqual({
            message: "Backfill started",
            status: "processing",
        });
        expect(mockBackfillAllArtistCounts).toHaveBeenCalledWith(
            expect.any(Function)
        );

        mockIsBackfillInProgress.mockImplementationOnce(() => {
            throw new Error("tracker unavailable");
        });
        const errRes = createRes();
        await artistCountsBackfillHandler({ user: { id: "admin-1" } } as any, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to start backfill" });
    });

    it("logs artist-count progress on 100-item boundaries and still responds with started", async () => {
        mockIsBackfillInProgress.mockReturnValueOnce(false);
        mockBackfillAllArtistCounts.mockImplementationOnce(async (callback: any) => {
            callback(50, 100);
            callback(100, 100);
            callback(200, 200);
        });

        const res = createRes();
        await artistCountsBackfillHandler(
            { user: { id: "admin-1" } } as any,
            res
        );

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Backfill started",
            status: "processing",
        });
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "[ArtistCounts] Progress: 100/100"
        );
    });

    it("returns image backfill status and handles status errors", async () => {
        const okRes = createRes();
        await imageBackfillStatusHandler({ user: { id: "admin-1" } } as any, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual({
            needsBackfill: true,
            totalArtists: 50,
            inProgress: false,
            processed: 0,
            total: 50,
        });

        mockIsImageBackfillNeeded.mockRejectedValueOnce(
            new Error("image status failed")
        );
        const errRes = createRes();
        await imageBackfillStatusHandler(
            { user: { id: "admin-1" } } as any,
            errRes
        );
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to check status" });
    });

    it("handles image backfill start in-progress, start, and trigger errors", async () => {
        mockGetImageBackfillProgress.mockReturnValueOnce({
            inProgress: true,
            processed: 7,
            total: 50,
        });
        const inProgressRes = createRes();
        await imageBackfillStartHandler(
            { user: { id: "admin-1" } } as any,
            inProgressRes
        );
        expect(inProgressRes.statusCode).toBe(200);
        expect(inProgressRes.body).toEqual({
            message: "Image backfill already in progress",
            status: "processing",
            progress: {
                inProgress: true,
                processed: 7,
                total: 50,
            },
        });

        mockGetImageBackfillProgress.mockReturnValueOnce({
            inProgress: false,
            processed: 0,
            total: 50,
        });
        const startRes = createRes();
        await imageBackfillStartHandler({ user: { id: "admin-1" } } as any, startRes);
        expect(startRes.statusCode).toBe(200);
        expect(startRes.body).toEqual({
            message: "Image backfill started",
            status: "processing",
        });
        expect(mockBackfillAllImages).toHaveBeenCalledTimes(1);

        mockGetImageBackfillProgress.mockImplementationOnce(() => {
            throw new Error("progress unavailable");
        });
        const errRes = createRes();
        await imageBackfillStartHandler({ user: { id: "admin-1" } } as any, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to start image backfill" });
    });

    it("keeps image backfill request responsive when background backfill fails", async () => {
        mockGetImageBackfillProgress.mockReturnValueOnce({
            inProgress: false,
            processed: 0,
            total: 50,
        });
        mockBackfillAllImages.mockRejectedValueOnce(new Error("boom"));

        const res = createRes();
        await imageBackfillStartHandler({ user: { id: "admin-1" } } as any, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Image backfill started",
            status: "processing",
        });
        await flushPromises();
        expect(mockLoggerError).toHaveBeenCalledWith(
            "[ImageBackfill] Backfill failed:",
            expect.any(Error)
        );
    });

    it("handles genre backfill no-op, success, and failure branches", async () => {
        const emptyRes = createRes();
        await backfillGenresHandler({ user: { id: "admin-1" } } as any, emptyRes);
        expect(emptyRes.statusCode).toBe(200);
        expect(emptyRes.body).toEqual({
            message: "No artists need genre backfill",
            count: 0,
        });

        mockArtistFindMany.mockResolvedValueOnce([
            { id: "artist-1", name: "Artist One", mbid: "mbid-1" },
            { id: "artist-2", name: "Artist Two", mbid: "mbid-2" },
        ]);
        mockArtistUpdateMany.mockResolvedValueOnce({ count: 2 });

        const successRes = createRes();
        await backfillGenresHandler(
            { user: { id: "admin-1" } } as any,
            successRes
        );
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            message: "Reset 2 artists for genre enrichment",
            count: 2,
            artists: ["Artist One", "Artist Two"],
        });
        expect(mockArtistUpdateMany).toHaveBeenCalledWith({
            where: { id: { in: ["artist-1", "artist-2"] } },
            data: {
                enrichmentStatus: "pending",
                lastEnriched: null,
            },
        });

        mockArtistFindMany.mockRejectedValueOnce(new Error("artist query failed"));
        const errRes = createRes();
        await backfillGenresHandler({ user: { id: "admin-1" } } as any, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to backfill genres" });
    });
});

describe("library stream runtime coverage", () => {
    const streamHandler = getHandler("get", "/tracks/:id/stream");

    beforeEach(() => {
        jest.clearAllMocks();
        (config.music as any).musicPath = "/music";
        (config.music as any).transcodeCachePath = "/tmp/soundspan-cache";
        (config.music as any).transcodeCacheMaxGb = 1;

        mockTrackFindUnique.mockResolvedValue(createNativeTrack());
        mockPlayFindFirst.mockResolvedValue(null);
        mockPlayCreate.mockResolvedValue({ id: "play-1" });
        mockUserSettingsFindUnique.mockResolvedValue({
            playbackQuality: "high",
        });
        mockStreamGetStreamFilePath.mockResolvedValue({
            filePath: "/tmp/soundspan-cache/track-high.mp3",
            mimeType: "audio/mpeg",
        });
        mockStreamWithRangeSupport.mockResolvedValue(undefined);
        mockStreamDestroy.mockImplementation(() => undefined);
    });

    it("returns 401 when stream request has no authenticated user", async () => {
        const req = {
            params: { id: "track-1" },
            query: {},
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Unauthorized" });
        expect(mockTrackFindUnique).not.toHaveBeenCalled();
    });

    it("returns 404 when requested track does not exist", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(null);

        const req = {
            params: { id: "missing-track" },
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Track not found" });
        expect(mockPlayCreate).not.toHaveBeenCalled();
    });

    it("returns 404 when track has no native file path", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(
            createNativeTrack({ filePath: null, fileModified: null })
        );

        const req = {
            params: { id: "track-1" },
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Track not available" });
        expect(mockAudioStreamingCtor).not.toHaveBeenCalled();
    });

    it("creates a play record only when no recent play exists", async () => {
        const req = {
            params: { id: "track-1" },
            query: { quality: "high" },
            user: { id: "user-9" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(mockPlayFindFirst).toHaveBeenCalledWith({
            where: {
                userId: "user-9",
                trackId: "track-1",
                playedAt: {
                    gte: expect.any(Date),
                },
            },
            orderBy: { playedAt: "desc" },
        });
        expect(mockPlayCreate).toHaveBeenCalledWith({
            data: { userId: "user-9", trackId: "track-1" },
        });
        expect(mockUserSettingsFindUnique).not.toHaveBeenCalled();
        expect(mockAudioStreamingCtor).toHaveBeenCalledWith(
            "/music",
            "/tmp/soundspan-cache",
            1
        );
        expect(mockStreamGetStreamFilePath).toHaveBeenCalledWith(
            "track-1",
            "high",
            new Date("2024-01-01T00:00:00.000Z"),
            "/music/Artist/Album/track.flac"
        );
        expect(mockStreamWithRangeSupport).toHaveBeenCalledWith(
            req,
            res,
            "/tmp/soundspan-cache/track-high.mp3",
            "audio/mpeg"
        );
        expect(mockStreamDestroy).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(200);
    });

    it("uses user playback settings when quality query is not provided", async () => {
        mockUserSettingsFindUnique.mockResolvedValueOnce({
            playbackQuality: "low",
        });

        const req = {
            params: { id: "track-1" },
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(mockUserSettingsFindUnique).toHaveBeenCalledWith({
            where: { userId: "user-1" },
        });
        expect(mockStreamGetStreamFilePath).toHaveBeenCalledWith(
            "track-1",
            "low",
            new Date("2024-01-01T00:00:00.000Z"),
            "/music/Artist/Album/track.flac"
        );
    });

    it("does not create duplicate play entries when a recent play exists", async () => {
        mockPlayFindFirst.mockResolvedValueOnce({ id: "existing-play" });

        const req = {
            params: { id: "track-1" },
            query: { quality: "high" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(mockPlayCreate).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
    });

    it("falls back to original quality when ffmpeg is unavailable", async () => {
        mockStreamGetStreamFilePath
            .mockRejectedValueOnce({
                code: "FFMPEG_NOT_FOUND",
                message: "ffmpeg binary not found",
            })
            .mockResolvedValueOnce({
                filePath: "/tmp/soundspan-cache/track-original.flac",
                mimeType: "audio/flac",
            });

        const req = {
            params: { id: "track-1" },
            query: { quality: "medium" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(mockAudioStreamingCtor).toHaveBeenCalledTimes(2);
        expect(mockStreamGetStreamFilePath).toHaveBeenNthCalledWith(
            1,
            "track-1",
            "medium",
            new Date("2024-01-01T00:00:00.000Z"),
            "/music/Artist/Album/track.flac"
        );
        expect(mockStreamGetStreamFilePath).toHaveBeenNthCalledWith(
            2,
            "track-1",
            "original",
            new Date("2024-01-01T00:00:00.000Z"),
            "/music/Artist/Album/track.flac"
        );
        expect(mockStreamWithRangeSupport).toHaveBeenCalledWith(
            req,
            res,
            "/tmp/soundspan-cache/track-original.flac",
            "audio/flac"
        );
        expect(res.statusCode).toBe(200);
    });

    it("returns 500 when native streaming fails without a recoverable fallback", async () => {
        mockStreamGetStreamFilePath.mockRejectedValueOnce(
            new Error("transcoder failed")
        );

        const req = {
            params: { id: "track-1" },
            query: { quality: "high" },
            user: { id: "user-2" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to stream track" });
        expect(mockStreamWithRangeSupport).not.toHaveBeenCalled();
    });

    it("returns 500 when an upstream lookup throws before streaming starts", async () => {
        mockTrackFindUnique.mockRejectedValueOnce(new Error("db unavailable"));

        const req = {
            params: { id: "track-1" },
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to stream track" });
    });
});

describe("library catalog list runtime coverage", () => {
    const recentlyListenedHandler = getHandler("get", "/recently-listened");
    const recentlyAddedHandler = getHandler("get", "/recently-added");
    const artistsHandler = getHandler("get", "/artists");
    const artistByIdHandler = getHandler("get", "/artists/:id");
    const albumsHandler = getHandler("get", "/albums");
    const albumByIdHandler = getHandler("get", "/albums/:id");
    const tracksHandler = getHandler("get", "/tracks");
    const shuffleHandler = getHandler("get", "/tracks/shuffle");
    const coverArtHandler = getHandler("get", "/cover-art/:id?", 1);
    const albumCoverHandler = getHandler("get", "/album-cover/:mbid", 1);
    const coverArtColorsHandler = getHandler("get", "/cover-art-colors", 1);
    const trackByIdHandler = getHandler("get", "/tracks/:id");
    const audioInfoHandler = getHandler("get", "/tracks/:id/audio-info", 1);
    const deleteTrackHandler = getHandler("delete", "/tracks/:id", 1);
    const deleteAlbumHandler = getHandler("delete", "/albums/:id", 1);
    const deleteArtistHandler = getHandler("delete", "/artists/:id", 1);
    const genresHandler = getHandler("get", "/genres");
    const decadesHandler = getHandler("get", "/decades");
    const radioHandler = getHandler("get", "/radio");

    beforeEach(() => {
        jest.clearAllMocks();
        mockPlayFindMany.mockResolvedValue([]);
        mockAudiobookProgressFindMany.mockResolvedValue([]);
        mockPodcastProgressFindMany.mockResolvedValue([]);
        mockOwnedAlbumGroupBy.mockResolvedValue([]);
        mockAlbumFindMany.mockResolvedValue([]);
        mockAlbumGroupBy.mockResolvedValue([]);
        mockAlbumCount.mockResolvedValue(0);
        mockAlbumFindFirst.mockResolvedValue(null);
        mockOwnedAlbumFindMany.mockResolvedValue([]);
        mockOwnedAlbumFindUnique.mockResolvedValue(null);
        mockOwnedAlbumDeleteMany.mockResolvedValue({ count: 0 });
        mockGenreFindMany.mockResolvedValue([]);
        mockSimilarArtistFindMany.mockResolvedValue([]);
        mockTrackFindMany.mockResolvedValue([]);
        mockTrackCount.mockResolvedValue(0);
        mockTrackDelete.mockResolvedValue(undefined);
        mockTrackDeleteMany.mockResolvedValue({ count: 0 });
        mockPlayGroupBy.mockResolvedValue([]);
        mockRedisGet.mockResolvedValue(null);
        mockRedisSetEx.mockResolvedValue("OK");
        mockPrismaQueryRaw.mockResolvedValue([]);
        mockPrismaTransaction.mockImplementation(async (callback: any) =>
            callback({
                artist: {
                    findMany: async () => [],
                    count: async () => 0,
                },
            })
        );
        mockGetArtistImagesBatch.mockResolvedValue(new Map());
        mockGetArtistImage.mockResolvedValue(null);
        mockLastFmGetArtistTopTracks.mockResolvedValue([]);
        mockLastFmGetSimilarArtists.mockResolvedValue([]);
        mockDeezerGetArtistImage.mockResolvedValue(null);
        mockMusicBrainzSearchArtist.mockResolvedValue([]);
        mockMusicBrainzGetReleaseGroups.mockResolvedValue([]);
        mockArtistFindMany.mockResolvedValue([]);
        mockArtistFindUnique.mockResolvedValue(null);
        mockArtistFindFirst.mockResolvedValue(null);
        mockArtistUpdate.mockResolvedValue(undefined);
        mockArtistDeleteMany.mockResolvedValue({ count: 0 });
        mockArtistDelete.mockResolvedValue(undefined);
        mockAlbumFindUnique.mockResolvedValue(null);
        mockAlbumDelete.mockResolvedValue(undefined);
        mockAlbumUpdate.mockResolvedValue(undefined);
        mockSimilarArtistDeleteMany.mockResolvedValue({ count: 0 });
        mockCoverArtGetCoverArt.mockResolvedValue(null);
        mockNormalizeExternalImageUrl.mockImplementation(
            (url: string) => url
        );
        mockFetchExternalImage.mockResolvedValue({
            ok: true,
            url: "https://images.example/cover.jpg",
            buffer: Buffer.from("cover"),
            etag: "etag-1",
            contentType: "image/jpeg",
        });
        mockExtractColorsFromImage.mockResolvedValue({
            vibrant: "#111111",
            darkVibrant: "#222222",
            lightVibrant: "#333333",
            muted: "#444444",
            darkMuted: "#555555",
            lightMuted: "#666666",
        });
        mockParseFile.mockResolvedValue({
            format: {
                codec: "flac",
                bitrate: 960000,
                sampleRate: 48000,
                bitsPerSample: 24,
                lossless: true,
                numberOfChannels: 2,
            },
        });
        mockShuffleArray.mockImplementation((arr: unknown[]) => arr);
        mockGetEffectiveYear.mockImplementation((album: any) =>
            album.displayYear ?? album.originalYear ?? album.year ?? null
        );
        mockGetDecadeWhereClause.mockImplementation((decadeStart: number) => ({
            OR: [
                { displayYear: { gte: decadeStart, lt: decadeStart + 10 } },
                {
                    displayYear: null,
                    originalYear: { gte: decadeStart, lt: decadeStart + 10 },
                },
                {
                    displayYear: null,
                    originalYear: null,
                    year: { gte: decadeStart, lt: decadeStart + 10 },
                },
            ],
        }));
        mockGetDecadeFromYear.mockImplementation((year: number) =>
            Math.floor(year / 10) * 10
        );
        mockGetMergedGenres.mockReturnValue([]);
    });

    it("returns recently listened artists, audiobooks, and deduplicated podcasts", async () => {
        mockPlayFindMany.mockResolvedValueOnce([
            {
                playedAt: new Date("2025-01-03T00:00:00.000Z"),
                track: {
                    album: {
                        artist: {
                            id: "artist-1",
                            mbid: "mbid-1",
                            name: "Artist One",
                            heroUrl: "hero-1.jpg",
                            userHeroUrl: null,
                        },
                    },
                },
            },
            {
                playedAt: new Date("2025-01-02T00:00:00.000Z"),
                track: {
                    album: {
                        artist: {
                            id: "artist-2",
                            mbid: "mbid-2",
                            name: "Artist Two",
                            heroUrl: "hero-2.jpg",
                            userHeroUrl: "user-hero-2.jpg",
                        },
                    },
                },
            },
        ]);
        mockAudiobookProgressFindMany.mockResolvedValueOnce([
            {
                audiobookshelfId: "book-1",
                title: "Book One",
                coverUrl: "covers/book-1.jpg",
                author: "Author One",
                currentTime: 120,
                duration: 240,
                lastPlayedAt: new Date("2025-01-05T00:00:00.000Z"),
            },
        ]);
        mockPodcastProgressFindMany.mockResolvedValueOnce([
            {
                episodeId: "ep-1",
                currentTime: 75,
                duration: 150,
                lastPlayedAt: new Date("2025-01-04T00:00:00.000Z"),
                episode: {
                    podcast: {
                        id: "pod-1",
                        title: "Podcast One",
                        author: "Host One",
                        imageUrl: "pod-1.jpg",
                    },
                },
            },
            {
                episodeId: "ep-2",
                currentTime: 10,
                duration: 100,
                lastPlayedAt: new Date("2024-12-30T00:00:00.000Z"),
                episode: {
                    podcast: {
                        id: "pod-1",
                        title: "Podcast One",
                        author: "Host One",
                        imageUrl: "pod-1.jpg",
                    },
                },
            },
        ]);
        mockOwnedAlbumGroupBy.mockResolvedValueOnce([
            { artistId: "artist-1", _count: { rgMbid: 7 } },
            { artistId: "artist-2", _count: { rgMbid: 2 } },
        ]);

        const req = {
            query: { limit: "3" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await recentlyListenedHandler(req, res);

        expect(mockPlayFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                take: 9,
                where: expect.objectContaining({ userId: "user-1" }),
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.items).toEqual([
            expect.objectContaining({
                type: "audiobook",
                id: "book-1",
                coverArt: "audiobook__covers/book-1.jpg",
                progress: 50,
            }),
            expect.objectContaining({
                type: "podcast",
                id: "pod-1",
                episodeId: "ep-1",
                progress: 50,
            }),
            expect.objectContaining({
                type: "artist",
                id: "artist-1",
                coverArt: "hero-1.jpg",
                albumCount: 7,
            }),
        ]);
    });

    it("returns 500 when recently listened aggregation fails", async () => {
        mockPlayFindMany.mockRejectedValueOnce(new Error("play query failed"));
        const req = {
            query: { limit: "5" },
            user: { id: "user-2" },
        } as any;
        const res = createRes();

        await recentlyListenedHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to fetch recently listened" });
    });

    it("returns recently added artists with dedupe and album counts", async () => {
        mockAlbumFindMany.mockResolvedValueOnce([
            {
                id: "album-1",
                title: "Album 1",
                artist: {
                    id: "artist-1",
                    mbid: "mbid-1",
                    name: "Artist One",
                    heroUrl: "hero-1.jpg",
                    userHeroUrl: null,
                },
            },
            {
                id: "album-2",
                title: "Album 2",
                artist: {
                    id: "artist-1",
                    mbid: "mbid-1",
                    name: "Artist One",
                    heroUrl: "hero-1.jpg",
                    userHeroUrl: null,
                },
            },
            {
                id: "album-3",
                title: "Album 3",
                artist: {
                    id: "artist-2",
                    mbid: "mbid-2",
                    name: "Artist Two",
                    heroUrl: "hero-2.jpg",
                    userHeroUrl: "user-hero-2.jpg",
                },
            },
        ]);
        mockAlbumGroupBy.mockResolvedValueOnce([
            { artistId: "artist-1", _count: { id: 3 } },
            { artistId: "artist-2", _count: { id: 1 } },
        ]);

        const req = { query: { limit: "2" } } as any;
        const res = createRes();

        await recentlyAddedHandler(req, res);

        expect(mockAlbumFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    location: "LIBRARY",
                }),
                take: 20,
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.artists).toEqual([
            expect.objectContaining({
                id: "artist-1",
                coverArt: "hero-1.jpg",
                albumCount: 3,
            }),
            expect.objectContaining({
                id: "artist-2",
                coverArt: "user-hero-2.jpg",
                albumCount: 1,
            }),
        ]);
    });

    it("returns 500 when recently added query fails", async () => {
        mockAlbumFindMany.mockRejectedValueOnce(new Error("album query failed"));
        const req = { query: { limit: "3" } } as any;
        const res = createRes();

        await recentlyAddedHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to fetch recently added" });
    });

    it("uses transaction-backed artist list with image cache and cursor output", async () => {
        const txArtistFindMany = jest.fn().mockResolvedValue([
            {
                id: "artist-1",
                mbid: "mbid-1",
                name: "Artist One",
                heroUrl: "hero-1.jpg",
                userHeroUrl: null,
                libraryAlbumCount: 4,
                discoveryAlbumCount: 2,
                totalTrackCount: 44,
            },
            {
                id: "artist-2",
                mbid: "mbid-2",
                name: "Artist Two",
                heroUrl: "hero-2.jpg",
                userHeroUrl: null,
                libraryAlbumCount: 1,
                discoveryAlbumCount: 0,
                totalTrackCount: 11,
            },
        ]);
        const txArtistCount = jest.fn().mockResolvedValue(2);
        mockPrismaTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                artist: {
                    findMany: txArtistFindMany,
                    count: txArtistCount,
                },
            })
        );
        mockGetArtistImagesBatch.mockResolvedValueOnce(
            new Map([["artist-1", "cached-artist-1.jpg"]])
        );

        const req = {
            query: {
                query: "art",
                filter: "all",
                limit: "2",
                offset: "1",
                sortBy: "tracks",
            },
        } as any;
        const res = createRes();

        await artistsHandler(req, res);

        expect(mockPrismaTransaction).toHaveBeenCalled();
        expect(txArtistFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: [
                        { libraryAlbumCount: { gt: 0 } },
                        { discoveryAlbumCount: { gt: 0 } },
                    ],
                    name: { contains: "art", mode: "insensitive" },
                }),
                take: 2,
                skip: 1,
                orderBy: { totalTrackCount: "desc" },
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            artists: [
                {
                    id: "artist-1",
                    mbid: "mbid-1",
                    name: "Artist One",
                    heroUrl: "cached-artist-1.jpg",
                    coverArt: "cached-artist-1.jpg",
                    albumCount: 6,
                    trackCount: 44,
                },
                {
                    id: "artist-2",
                    mbid: "mbid-2",
                    name: "Artist Two",
                    heroUrl: "hero-2.jpg",
                    coverArt: "hero-2.jpg",
                    albumCount: 1,
                    trackCount: 11,
                },
            ],
            total: 2,
            offset: 1,
            limit: 2,
            nextCursor: "artist-2",
        });
    });

    it("applies cursor pagination for discovery artist filtering", async () => {
        const txArtistFindMany = jest.fn().mockResolvedValue([
            {
                id: "artist-3",
                mbid: "mbid-3",
                name: "Discovery Artist",
                heroUrl: null,
                userHeroUrl: null,
                libraryAlbumCount: 0,
                discoveryAlbumCount: 3,
                totalTrackCount: 9,
            },
        ]);
        const txArtistCount = jest.fn().mockResolvedValue(1);
        mockPrismaTransaction.mockImplementationOnce(async (callback: any) =>
            callback({
                artist: {
                    findMany: txArtistFindMany,
                    count: txArtistCount,
                },
            })
        );

        const req = {
            query: {
                filter: "discovery",
                query: "disco",
                cursor: "artist-1",
                limit: "5",
            },
        } as any;
        const res = createRes();

        await artistsHandler(req, res);

        expect(txArtistFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    discoveryAlbumCount: { gt: 0 },
                    libraryAlbumCount: 0,
                    name: { contains: "disco", mode: "insensitive" },
                }),
                cursor: { id: "artist-1" },
                skip: 1,
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.nextCursor).toBe(null);
    });

    it("returns 500 for artist list transaction errors", async () => {
        mockPrismaTransaction.mockRejectedValueOnce(new Error("tx failed"));
        const req = { query: {} } as any;
        const res = createRes();

        await artistsHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to fetch artists",
            details: "tx failed",
        });
    });

    it("hydrates artist detail with MBID resolution, discography, top tracks, and enriched similar artists", async () => {
        mockArtistFindFirst.mockResolvedValueOnce({
            id: "artist-1",
            name: "Artist One",
            mbid: "temp-artist-one",
            heroUrl: "hero-original.jpg",
            userHeroUrl: null,
            similarArtistsJson: [
                { name: "Similar One", mbid: "sim-1", match: 0.93 },
                { name: "Similar Two", mbid: null, match: 0.61 },
            ],
            ownedAlbums: [{ rgMbid: "rg-db-same" }],
            albums: [
                {
                    id: "album-db-1",
                    title: "Owned Album",
                    rgMbid: "rg-db-same",
                    year: 2010,
                    coverUrl: "db-cover.jpg",
                    tracks: [
                        {
                            id: "track-1",
                            title: "Song One",
                            album: {
                                id: "album-db-1",
                                title: "Owned Album",
                                coverUrl: "db-cover.jpg",
                            },
                        },
                    ],
                },
            ],
        });
        mockMusicBrainzSearchArtist.mockResolvedValueOnce([{ id: "artist-real-mbid" }]);
        mockArtistFindUnique.mockResolvedValueOnce(null);
        mockArtistUpdate.mockResolvedValueOnce(undefined);
        mockMusicBrainzGetReleaseGroups.mockResolvedValueOnce([
            {
                id: "rg-db-same",
                title: "Owned Album",
                "first-release-date": "2010-01-01",
                "primary-type": "Album",
                "secondary-types": [],
            },
            {
                id: "rg-new-1",
                title: "New Album",
                "first-release-date": "2011-02-02",
                "primary-type": "Album",
                "secondary-types": [],
            },
            {
                id: "rg-live-1",
                title: "Live Album",
                "first-release-date": "2012-03-03",
                "primary-type": "Album",
                "secondary-types": ["Live"],
            },
        ]);
        mockPlayGroupBy.mockResolvedValueOnce([{ trackId: "track-1", _count: { id: 6 } }]);
        mockLastFmGetArtistTopTracks.mockResolvedValueOnce([
            {
                name: "Song One",
                playcount: "101",
                listeners: "45",
                duration: "200000",
                url: "https://last.fm/song-one",
                album: { "#text": "Owned Album" },
            },
            {
                name: "Song Two",
                playcount: "50",
                listeners: "20",
                duration: "180000",
                url: "https://last.fm/song-two",
                album: { "#text": "Remote Album" },
            },
        ]);
        mockArtistFindMany.mockResolvedValueOnce([
            {
                id: "artist-sim-1",
                name: "Similar One",
                normalizedName: "similar one",
                mbid: "sim-1",
                heroUrl: "similar-one.jpg",
                _count: { albums: 3 },
            },
        ]);
        mockDeezerGetArtistImage.mockResolvedValueOnce("similar-two.jpg");
        mockGetArtistImage.mockResolvedValueOnce("hero-fetched.jpg");
        mockRedisGet.mockImplementation(async (key: string) => {
            if (key === "discography:artist-real-mbid") {
                return null;
            }
            if (key === "caa:rg-new-1") {
                return "cached-new-cover.jpg";
            }
            if (key === "top-tracks:artist-1") {
                return null;
            }
            if (key === "similar-artists:artist-1") {
                return null;
            }
            if (key === "deezer-artist-image:Similar Two") {
                return null;
            }
            return null;
        });

        const req = {
            params: { id: "artist-1" },
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await artistByIdHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockMusicBrainzSearchArtist).toHaveBeenCalledWith("Artist One", 1);
        expect(mockMusicBrainzGetReleaseGroups).toHaveBeenCalledWith(
            "artist-real-mbid",
            ["album", "ep"],
            100
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "discography:artist-real-mbid",
            24 * 60 * 60,
            expect.any(String)
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "top-tracks:artist-1",
            24 * 60 * 60,
            expect.any(String)
        );
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "artist-1",
                coverArt: "hero-fetched.jpg",
                discographyComplete: true,
                albums: expect.arrayContaining([
                    expect.objectContaining({
                        id: "album-db-1",
                        title: "Owned Album",
                        owned: true,
                        source: "database",
                    }),
                    expect.objectContaining({
                        id: "rg-new-1",
                        title: "New Album",
                        coverArt: "cached-new-cover.jpg",
                        owned: false,
                        source: "musicbrainz",
                    }),
                ]),
                topTracks: expect.arrayContaining([
                    expect.objectContaining({
                        id: "track-1",
                        userPlayCount: 6,
                        playCount: 101,
                        listeners: 45,
                    }),
                    expect.objectContaining({
                        title: "Song Two",
                        userPlayCount: 0,
                    }),
                ]),
                similarArtists: expect.arrayContaining([
                    expect.objectContaining({
                        id: "artist-sim-1",
                        name: "Similar One",
                        inLibrary: true,
                        coverArt: "similar-one.jpg",
                        ownedAlbumCount: 3,
                    }),
                    expect.objectContaining({
                        name: "Similar Two",
                        inLibrary: false,
                        coverArt: "similar-two.jpg",
                    }),
                ]),
            })
        );
    });

    it("falls back to local artist data when external lookups fail", async () => {
        const transientError = Object.assign(new Error("timeout"), {
            code: "ETIMEDOUT",
        });
        mockArtistFindFirst.mockResolvedValueOnce({
            id: "artist-err",
            name: "Artist Error",
            mbid: "mbid-error",
            heroUrl: null,
            userHeroUrl: "user-hero.jpg",
            similarArtistsJson: null,
            ownedAlbums: [{ rgMbid: "rg-owned" }],
            albums: [
                {
                    id: "album-owned",
                    title: "Owned Album",
                    rgMbid: "rg-owned",
                    year: 2020,
                    coverUrl: "owned-cover.jpg",
                    tracks: [
                        {
                            id: "track-owned",
                            title: "Owned Song",
                            album: {
                                id: "album-owned",
                                title: "Owned Album",
                                coverUrl: "owned-cover.jpg",
                            },
                        },
                    ],
                },
            ],
        });
        mockMusicBrainzGetReleaseGroups.mockRejectedValueOnce(transientError);
        mockPlayGroupBy.mockResolvedValueOnce([
            { trackId: "track-owned", _count: { id: 2 } },
        ]);
        mockLastFmGetArtistTopTracks.mockRejectedValueOnce(
            new Error("lastfm top tracks unavailable")
        );
        mockLastFmGetSimilarArtists.mockRejectedValueOnce(
            new Error("lastfm similar unavailable")
        );
        mockGetArtistImage.mockResolvedValueOnce("hero-from-cache.jpg");
        mockRedisGet.mockImplementation(async (key: string) => {
            if (key === "discography:mbid-error") {
                return null;
            }
            if (key === "top-tracks:artist-err") {
                return null;
            }
            if (key === "similar-artists:artist-err") {
                return null;
            }
            return null;
        });

        const req = {
            params: { id: "artist-err" },
            query: {},
            user: { id: "user-5" },
        } as any;
        const res = createRes();

        await artistByIdHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            "discography:mbid-error",
            120,
            "[]"
        );
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "artist-err",
                coverArt: "hero-from-cache.jpg",
                discographyComplete: false,
                albums: [
                    expect.objectContaining({
                        id: "album-owned",
                        source: "database",
                        owned: true,
                    }),
                ],
                topTracks: [
                    expect.objectContaining({
                        id: "track-owned",
                        userPlayCount: 2,
                    }),
                ],
                similarArtists: [],
            })
        );
    });

    it("treats explicit false query values as false for artist-detail includes", async () => {
        mockArtistFindFirst.mockResolvedValueOnce({
            id: "artist-flags",
            name: "Artist Flags",
            mbid: "temp-flags",
            heroUrl: "hero-flags.jpg",
            userHeroUrl: "user-hero-flags.jpg",
            similarArtistsJson: [
                { name: "Should Ignore", mbid: "ignored", match: 0.7 },
            ],
            ownedAlbums: [{ rgMbid: "rg-flags" }],
            albums: [
                {
                    id: "album-flags",
                    title: "Flag Album",
                    rgMbid: "rg-flags",
                    year: 2024,
                    coverUrl: "cover-flags.jpg",
                    tracks: [
                        {
                            id: "track-flags",
                            title: "Flagged Track",
                            album: {
                                id: "album-flags",
                                title: "Flag Album",
                                coverUrl: "cover-flags.jpg",
                            },
                        },
                    ],
                },
            ],
        });

        const req = {
            params: { id: "artist-flags" },
            query: {
                includeDiscography: "false",
                includeTopTracks: "off",
                includeSimilarArtists: "0",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await artistByIdHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockMusicBrainzSearchArtist).not.toHaveBeenCalled();
        expect(mockMusicBrainzGetReleaseGroups).not.toHaveBeenCalled();
        expect(mockPlayGroupBy).not.toHaveBeenCalled();
        expect(mockLastFmGetArtistTopTracks).not.toHaveBeenCalled();
        expect(mockLastFmGetSimilarArtists).not.toHaveBeenCalled();
        expect(mockGetArtistImage).not.toHaveBeenCalled();
        expect(res.body).toEqual(
            expect.objectContaining({
                id: "artist-flags",
                discographyComplete: true,
                topTracks: [],
                similarArtists: [],
                coverArt: "user-hero-flags.jpg",
                albums: [
                    expect.objectContaining({
                        id: "album-flags",
                        source: "database",
                        owned: true,
                    }),
                ],
            })
        );
    });

    it("treats unknown boolean-like artist query values as default values", async () => {
        mockArtistFindFirst.mockResolvedValueOnce({
            id: "artist-default-unknown",
            name: "Artist Unknown",
            mbid: "temp-unknown",
            heroUrl: "hero-unknown.jpg",
            userHeroUrl: null,
            similarArtistsJson: null,
            ownedAlbums: [{ rgMbid: "rg-unknown" }],
            albums: [],
        });
        mockMusicBrainzSearchArtist.mockResolvedValueOnce([
            { id: "artist-unknown-resolved" },
        ]);
        mockArtistFindUnique.mockResolvedValueOnce(null);
        mockMusicBrainzGetReleaseGroups.mockResolvedValueOnce([]);
        mockRedisGet.mockImplementation(async (key: string) => {
            if (key === "discography:artist-unknown-resolved") {
                return null;
            }
            if (key === "top-tracks:artist-default-unknown") {
                return null;
            }
            if (key === "similar-artists:artist-default-unknown") {
                return null;
            }
            return null;
        });

        const req = {
            params: { id: "artist-default-unknown" },
            query: {
                includeDiscography: "maybe",
                includeTopTracks: "maybe",
                includeSimilarArtists: "off",
            },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await artistByIdHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(mockMusicBrainzSearchArtist).toHaveBeenCalledWith(
            "Artist Unknown",
            1
        );
        expect(mockMusicBrainzGetReleaseGroups).toHaveBeenCalledWith(
            "artist-unknown-resolved",
            ["album", "ep"],
            100
        );
        expect(mockPlayGroupBy).toHaveBeenCalled();
        expect(mockLastFmGetArtistTopTracks).toHaveBeenCalled();
    });

    it("uses Last.fm top tracks and similar artists on cache misses", async () => {
        mockArtistFindFirst.mockResolvedValueOnce({
            id: "artist-cacheless",
            name: "Cacheless Artist",
            mbid: "mbid-cacheless",
            heroUrl: "hero-cacheless.jpg",
            userHeroUrl: null,
            similarArtistsJson: null,
            ownedAlbums: [{ rgMbid: "rg-owned-cacheless" }],
            albums: [
                {
                    id: "album-cacheless",
                    title: "Owned Cache Album",
                    rgMbid: "rg-owned-cacheless",
                    year: 2021,
                    coverUrl: "owned-cacheless.jpg",
                    tracks: [],
                },
            ],
        });
        mockRedisGet.mockImplementation(async (key: string) => {
            if (key === "discography:mbid-cacheless") {
                return null;
            }
            if (key === "top-tracks:artist-cacheless") {
                return null;
            }
            if (key === "similar-artists:artist-cacheless") {
                return null;
            }
            return null;
        });
        mockGetArtistImage.mockResolvedValueOnce("hero-from-cacheless-cache");
        mockLastFmGetArtistTopTracks.mockResolvedValueOnce([
            {
                name: "One-Track",
                playcount: "88",
                listeners: "100",
                duration: "240000",
                url: "https://last.fm/track/one-track",
                album: { "#text": "Single Album" },
            },
        ]);
        mockLastFmGetSimilarArtists.mockResolvedValueOnce([
            {
                name: "Similar Cacheless",
                mbid: "sim-cacheless",
                match: 0.91,
            },
        ]);
        mockDeezerGetArtistImage.mockResolvedValueOnce(
            "https://images.example/similar-cacheless.jpg"
        );

        const req = {
            params: { id: "artist-cacheless" },
            query: { includeDiscography: "false" },
            user: { id: "user-7" },
        } as any;
        const res = createRes();

        await artistByIdHandler(req, res);

        expect(mockMusicBrainzGetReleaseGroups).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
                expect.objectContaining({
                    id: "artist-cacheless",
                    coverArt: "hero-from-cacheless-cache",
                    discographyComplete: true,
                    topTracks: [
                    expect.objectContaining({
                        title: "One-Track",
                        id: "lastfm-mbid-cacheless-One-Track",
                        duration: 240,
                    }),
                ],
                    similarArtists: [
                        expect.objectContaining({
                        id: "Similar Cacheless",
                        name: "Similar Cacheless",
                        inLibrary: false,
                    }),
                ],
            })
        );
    });

    it("returns 404 when artist detail lookup misses", async () => {
        mockArtistFindFirst.mockResolvedValueOnce(null);
        const req = {
            params: { id: "missing-artist" },
            query: {},
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await artistByIdHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Artist not found" });
    });

    it("returns albums with ownership-aware filtering", async () => {
        mockOwnedAlbumFindMany.mockResolvedValueOnce([{ rgMbid: "rg-1" }]);
        mockAlbumFindMany.mockResolvedValueOnce([
            {
                id: "album-1",
                title: "Album One",
                artistId: "artist-1",
                rgMbid: "rg-1",
                coverUrl: "cover-1.jpg",
                artist: { id: "artist-1", mbid: "mbid-1", name: "Artist One" },
            },
        ]);
        mockAlbumCount.mockResolvedValueOnce(1);

        const req = {
            query: {
                artistId: "artist-1",
                filter: "owned",
                limit: "5",
                offset: "2",
                sortBy: "recent",
            },
        } as any;
        const res = createRes();

        await albumsHandler(req, res);

        expect(mockOwnedAlbumFindMany).toHaveBeenCalledWith({
            select: { rgMbid: true },
        });
        expect(mockAlbumFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    AND: [
                        {
                            OR: [
                                { location: "LIBRARY", tracks: { some: {} } },
                                {
                                    rgMbid: { in: ["rg-1"] },
                                    tracks: { some: {} },
                                },
                            ],
                        },
                        { artistId: "artist-1" },
                    ],
                },
                skip: 2,
                take: 5,
                orderBy: { year: "desc" },
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            albums: [
                expect.objectContaining({
                    id: "album-1",
                    coverArt: "cover-1.jpg",
                }),
            ],
            total: 1,
            offset: 2,
            limit: 5,
        });
    });

    it("supports discovery filter with optional artist scoping", async () => {
        mockAlbumFindMany.mockResolvedValueOnce([
            {
                id: "album-discovery",
                title: "Discovered Album",
                artistId: "artist-discovery",
                rgMbid: "rg-discovery",
                coverUrl: "discovery-cover.jpg",
                artist: {
                    id: "artist-discovery",
                    mbid: "mbid-discovery",
                    name: "Discovery Artist",
                },
            },
        ]);
        mockAlbumCount.mockResolvedValueOnce(1);

        const req = {
            query: {
                artistId: "artist-discovery",
                filter: "discovery",
                limit: "1",
                sortBy: "name-desc",
            },
        } as any;
        const res = createRes();

        await albumsHandler(req, res);

        expect(mockAlbumFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    tracks: { some: {} },
                    location: "DISCOVER",
                    artistId: "artist-discovery",
                },
                skip: 0,
                take: 1,
                orderBy: { title: "desc" },
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            albums: [expect.objectContaining({ id: "album-discovery" })],
            total: 1,
            offset: 0,
            limit: 1,
        });
    });

    it("returns 500 when album listing fails", async () => {
        mockAlbumFindMany.mockRejectedValueOnce(new Error("album list failed"));
        const req = { query: {} } as any;
        const res = createRes();

        await albumsHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to fetch albums",
            details: "album list failed",
        });
    });

    it("handles album lookup by id, includeTracks flag, and ownership", async () => {
        mockAlbumFindFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "album-2",
                artistId: "artist-2",
                rgMbid: "rg-2",
                coverUrl: "cover-2.jpg",
                artist: {
                    id: "artist-2",
                    mbid: "mbid-2",
                    name: "Artist Two",
                },
            })
            .mockResolvedValueOnce({
                id: "album-3",
                artistId: "artist-3",
                rgMbid: "rg-3",
                coverUrl: "cover-3.jpg",
                artist: {
                    id: "artist-3",
                    mbid: "mbid-3",
                    name: "Artist Three",
                },
                tracks: [{ id: "track-1", title: "Track One" }],
            });
        mockOwnedAlbumFindUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ artistId: "artist-3", rgMbid: "rg-3" });

        const missingReq = { params: { id: "missing" }, query: {} } as any;
        const missingRes = createRes();
        await albumByIdHandler(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);

        const noTracksReq = {
            params: { id: "album-2" },
            query: { includeTracks: "false" },
        } as any;
        const noTracksRes = createRes();
        await albumByIdHandler(noTracksReq, noTracksRes);
        expect(noTracksRes.statusCode).toBe(200);
        expect(noTracksRes.body).toEqual(
            expect.objectContaining({
                id: "album-2",
                tracks: [],
                owned: false,
                coverArt: "cover-2.jpg",
            })
        );

        const withTracksReq = {
            params: { id: "album-3" },
            query: {},
        } as any;
        const withTracksRes = createRes();
        await albumByIdHandler(withTracksReq, withTracksRes);
        expect(withTracksRes.statusCode).toBe(200);
        expect(withTracksRes.body).toEqual(
            expect.objectContaining({
                id: "album-3",
                tracks: [{ id: "track-1", title: "Track One" }],
                owned: true,
            })
        );
    });

    it("accepts includeTracks as string true and boolean true", async () => {
        mockAlbumFindFirst
            .mockResolvedValueOnce({
                id: "album-string-true",
                artistId: "artist-true",
                rgMbid: "rg-string-true",
                coverUrl: "cover-string.jpg",
                artist: {
                    id: "artist-true",
                    mbid: "mbid-true",
                    name: "Artist True",
                },
                tracks: [{ id: "track-true", title: "Track True" }],
            })
            .mockResolvedValueOnce({
                id: "album-bool-true",
                artistId: "artist-bool",
                rgMbid: "rg-bool-true",
                coverUrl: "cover-bool.jpg",
                artist: {
                    id: "artist-bool",
                    mbid: "mbid-bool",
                    name: "Artist Bool",
                },
                tracks: [{ id: "track-bool", title: "Track Bool" }],
            });
        mockOwnedAlbumFindUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                artistId: "artist-bool",
                rgMbid: "rg-bool-true",
            });

        const stringReq = {
            params: { id: "album-string-true" },
            query: { includeTracks: "true" },
        } as any;
        const stringRes = createRes();
        await albumByIdHandler(stringReq, stringRes);
        expect(stringRes.statusCode).toBe(200);
        expect(stringRes.body).toEqual(
            expect.objectContaining({
                id: "album-string-true",
                tracks: [{ id: "track-true", title: "Track True" }],
                owned: false,
            })
        );

        const boolReq = {
            params: { id: "album-bool-true" },
            query: { includeTracks: true },
        } as any;
        const boolRes = createRes();
        await albumByIdHandler(boolReq, boolRes);
        expect(boolRes.statusCode).toBe(200);
        expect(boolRes.body).toEqual(
            expect.objectContaining({
                id: "album-bool-true",
                tracks: [{ id: "track-bool", title: "Track Bool" }],
                owned: true,
            })
        );
    });

    it("returns tracks with album cover art and handles failures", async () => {
        mockTrackFindMany.mockResolvedValueOnce([
            {
                id: "track-10",
                title: "Track 10",
                albumId: "album-10",
                album: {
                    id: "album-10",
                    title: "Album 10",
                    coverUrl: "album-10.jpg",
                    artist: { id: "artist-10", name: "Artist 10" },
                },
            },
        ]);
        mockTrackCount.mockResolvedValueOnce(1);

        const req = {
            query: { albumId: "album-10", limit: "4", offset: "1" },
        } as any;
        const res = createRes();
        await tracksHandler(req, res);

        expect(mockTrackFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { albumId: "album-10" },
                skip: 1,
                take: 4,
                orderBy: [{ discNo: "asc" }, { trackNo: "asc" }],
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            tracks: [
                expect.objectContaining({
                    id: "track-10",
                    album: expect.objectContaining({
                        coverArt: "album-10.jpg",
                    }),
                }),
            ],
            total: 1,
            offset: 1,
            limit: 4,
        });

        mockTrackFindMany.mockRejectedValueOnce(new Error("track lookup failed"));
        const errReq = { query: {} } as any;
        const errRes = createRes();
        await tracksHandler(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to fetch tracks" });
    });

    it("handles shuffle for empty, small, and large libraries", async () => {
        mockTrackCount.mockResolvedValueOnce(0);
        const emptyReq = { query: { limit: "3" } } as any;
        const emptyRes = createRes();
        await shuffleHandler(emptyReq, emptyRes);
        expect(emptyRes.statusCode).toBe(200);
        expect(emptyRes.body).toEqual({ tracks: [], total: 0 });

        mockTrackCount.mockResolvedValueOnce(2);
        mockTrackFindMany.mockResolvedValueOnce([
            {
                id: "track-1",
                title: "Track 1",
                album: { id: "album-1", title: "A1", coverUrl: "c1.jpg" },
            },
            {
                id: "track-2",
                title: "Track 2",
                album: { id: "album-2", title: "A2", coverUrl: "c2.jpg" },
            },
        ]);
        const smallReq = { query: { limit: "5" } } as any;
        const smallRes = createRes();
        await shuffleHandler(smallReq, smallRes);
        expect(mockShuffleArray).toHaveBeenCalled();
        expect(smallRes.statusCode).toBe(200);
        expect(smallRes.body.total).toBe(2);
        expect(smallRes.body.tracks[0].album.coverArt).toBe("c1.jpg");

        mockTrackCount.mockResolvedValueOnce(10);
        mockPrismaQueryRaw.mockResolvedValueOnce([{ id: "track-9" }, { id: "track-8" }]);
        mockTrackFindMany.mockResolvedValueOnce([
            {
                id: "track-9",
                title: "Track 9",
                album: { id: "album-9", title: "A9", coverUrl: "c9.jpg" },
            },
            {
                id: "track-8",
                title: "Track 8",
                album: { id: "album-8", title: "A8", coverUrl: "c8.jpg" },
            },
        ]);
        const largeReq = { query: { limit: "2" } } as any;
        const largeRes = createRes();
        await shuffleHandler(largeReq, largeRes);
        expect(mockPrismaQueryRaw).toHaveBeenCalled();
        expect(mockTrackFindMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: { in: ["track-9", "track-8"] } },
            })
        );
        expect(largeRes.statusCode).toBe(200);
        expect(largeRes.body.total).toBe(10);

        mockTrackCount.mockRejectedValueOnce(new Error("shuffle failed"));
        const errReq = { query: {} } as any;
        const errRes = createRes();
        await shuffleHandler(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to shuffle tracks" });
    });

    it("formats single track responses and handles not-found/errors", async () => {
        mockTrackFindUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: "track-1",
                title: "Track 1",
                duration: 201,
                album: {
                    id: "album-1",
                    title: "Album 1",
                    coverUrl: "cover-1.jpg",
                    artist: { id: "artist-1", name: "Artist 1" },
                },
            })
            .mockRejectedValueOnce(new Error("track read failed"));

        const missingReq = { params: { id: "missing-track" } } as any;
        const missingRes = createRes();
        await trackByIdHandler(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);

        const okReq = { params: { id: "track-1" } } as any;
        const okRes = createRes();
        await trackByIdHandler(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual({
            id: "track-1",
            title: "Track 1",
            artist: { name: "Artist 1", id: "artist-1" },
            album: { title: "Album 1", coverArt: "cover-1.jpg", id: "album-1" },
            duration: 201,
        });

        const errReq = { params: { id: "err-track" } } as any;
        const errRes = createRes();
        await trackByIdHandler(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to fetch track" });
    });

    it("handles audio-info lookup for missing track, missing file, and parsed metadata", async () => {
        mockTrackFindUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ filePath: "Artist\\track.flac" })
            .mockResolvedValueOnce({ filePath: "Artist\\track.flac" });

        const missingReq = {
            params: { id: "missing-track" },
            user: { id: "user-1" },
        } as any;
        const missingRes = createRes();
        await audioInfoHandler(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);
        expect(missingRes.body).toEqual({ error: "Track not found" });

        const missingFileSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValueOnce(false);
        const missingFileReq = {
            params: { id: "track-no-file" },
            user: { id: "user-1" },
        } as any;
        const missingFileRes = createRes();
        await audioInfoHandler(missingFileReq, missingFileRes);
        expect(missingFileRes.statusCode).toBe(404);
        expect(missingFileRes.body).toEqual({ error: "File not found on disk" });
        missingFileSpy.mockRestore();

        const presentFileSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValueOnce(true);
        const okReq = { params: { id: "track-ok" }, user: { id: "user-1" } } as any;
        const okRes = createRes();
        await audioInfoHandler(okReq, okRes);
        expect(mockParseFile).toHaveBeenCalledWith(
            "/music/Artist/track.flac",
            { duration: false, skipCovers: true }
        );
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual({
            codec: "flac",
            bitrate: 960,
            sampleRate: 48000,
            bitDepth: 24,
            lossless: true,
            channels: 2,
        });
        presentFileSpy.mockRestore();
    });

    it("maps audio-info parsing errors to HTTP 500", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({
            filePath: "Artist\\track-corrupt.flac",
        });
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(true);
        mockParseFile.mockRejectedValueOnce(new Error("metadata-corrupt"));

        const req = {
            params: { id: "track-corrupt" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await audioInfoHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to read audio metadata" });

        existsSpy.mockRestore();
    });

    it("returns 404 when audio info track exists but has no stored file path", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-no-file-path",
            filePath: null,
        });

        const filePathMissingReq = {
            params: { id: "track-no-file-path" },
            user: { id: "user-1" },
        } as any;
        const filePathMissingRes = createRes();

        await audioInfoHandler(filePathMissingReq, filePathMissingRes);

        expect(filePathMissingRes.statusCode).toBe(404);
        expect(filePathMissingRes.body).toEqual({ error: "Track not found" });
    });

    it("returns 403 when album deletion is disabled in settings", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: false,
        });

        const disabledRes = createRes();
        await deleteAlbumHandler(
            { params: { id: "album-locked" } } as any,
            disabledRes
        );

        expect(disabledRes.statusCode).toBe(403);
        expect(disabledRes.body).toEqual({
            error: "Library deletion is disabled in admin settings",
        });
        expect(mockAlbumFindUnique).not.toHaveBeenCalled();
        expect(mockAlbumDelete).not.toHaveBeenCalled();
    });

    it("returns 500 when album deletion persistence fails", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockAlbumFindUnique.mockResolvedValueOnce({
            id: "album-delete-fail",
            title: "Album Delete Fail",
            artist: { name: "Failing Artist" },
            tracks: [],
        });
        mockAlbumDelete.mockRejectedValueOnce(
            new Error("album-db-down")
        );

        const failureRes = createRes();
        await deleteAlbumHandler(
            { params: { id: "album-delete-fail" } } as any,
            failureRes
        );

        expect(failureRes.statusCode).toBe(500);
        expect(failureRes.body).toEqual({ error: "Failed to delete album" });
    });

    it("applies delete-policy gates and not-found/success behavior for track, album, and artist deletion", async () => {
        mockGetSystemSettings
            .mockResolvedValueOnce({ libraryDeletionEnabled: false })
            .mockResolvedValueOnce({ libraryDeletionEnabled: true })
            .mockResolvedValueOnce({ libraryDeletionEnabled: true })
            .mockResolvedValueOnce({ libraryDeletionEnabled: false })
            .mockResolvedValueOnce({ libraryDeletionEnabled: true })
            .mockResolvedValueOnce({ libraryDeletionEnabled: true })
            .mockResolvedValueOnce({ libraryDeletionEnabled: false })
            .mockResolvedValueOnce({ libraryDeletionEnabled: true })
            .mockResolvedValueOnce({ libraryDeletionEnabled: true });

        const deleteTrackReq = { params: { id: "track-1" } } as any;
        const deleteTrackResDenied = createRes();
        await deleteTrackHandler(deleteTrackReq, deleteTrackResDenied);
        expect(deleteTrackResDenied.statusCode).toBe(403);

        mockTrackFindUnique.mockResolvedValueOnce(null);
        const deleteTrackResNotFound = createRes();
        await deleteTrackHandler(deleteTrackReq, deleteTrackResNotFound);
        expect(deleteTrackResNotFound.statusCode).toBe(404);
        expect(deleteTrackResNotFound.body).toEqual({ error: "Track not found" });

        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-2",
            title: "Track Two",
            filePath: null,
            album: { artist: { id: "artist-2", name: "Artist Two" } },
        });
        const deleteTrackResOk = createRes();
        await deleteTrackHandler({ params: { id: "track-2" } } as any, deleteTrackResOk);
        expect(mockTrackDelete).toHaveBeenCalledWith({ where: { id: "track-2" } });
        expect(deleteTrackResOk.statusCode).toBe(200);
        expect(deleteTrackResOk.body).toEqual({
            message: "Track deleted successfully",
        });

        const deleteAlbumReq = { params: { id: "album-1" } } as any;
        const deleteAlbumResDenied = createRes();
        await deleteAlbumHandler(deleteAlbumReq, deleteAlbumResDenied);
        expect(deleteAlbumResDenied.statusCode).toBe(403);

        mockAlbumFindUnique.mockResolvedValueOnce(null);
        const deleteAlbumResNotFound = createRes();
        await deleteAlbumHandler(deleteAlbumReq, deleteAlbumResNotFound);
        expect(deleteAlbumResNotFound.statusCode).toBe(404);
        expect(deleteAlbumResNotFound.body).toEqual({ error: "Album not found" });

        mockAlbumFindUnique.mockResolvedValueOnce({
            id: "album-2",
            title: "Album Two",
            artist: { name: "Artist Two" },
            tracks: [],
        });
        const albumFsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);
        const deleteAlbumResOk = createRes();
        await deleteAlbumHandler({ params: { id: "album-2" } } as any, deleteAlbumResOk);
        expect(mockAlbumDelete).toHaveBeenCalledWith({ where: { id: "album-2" } });
        expect(deleteAlbumResOk.statusCode).toBe(200);
        expect(deleteAlbumResOk.body).toEqual({
            message: "Album deleted successfully",
            deletedFiles: 0,
        });
        albumFsSpy.mockRestore();

        const deleteArtistReq = { params: { id: "artist-1" } } as any;
        const deleteArtistResDenied = createRes();
        await deleteArtistHandler(deleteArtistReq, deleteArtistResDenied);
        expect(deleteArtistResDenied.statusCode).toBe(403);

        mockArtistFindUnique.mockResolvedValueOnce(null);
        const deleteArtistResNotFound = createRes();
        await deleteArtistHandler(deleteArtistReq, deleteArtistResNotFound);
        expect(deleteArtistResNotFound.statusCode).toBe(404);
        expect(deleteArtistResNotFound.body).toEqual({ error: "Artist not found" });

        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-2",
            name: "Artist Two",
            mbid: "temp-artist-2",
            albums: [],
        });
        const artistFsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);
        const deleteArtistResOk = createRes();
        await deleteArtistHandler({ params: { id: "artist-2" } } as any, deleteArtistResOk);
        expect(mockOwnedAlbumDeleteMany).toHaveBeenCalledWith({
            where: { artistId: "artist-2" },
        });
        expect(mockArtistDelete).toHaveBeenCalledWith({
            where: { id: "artist-2" },
        });
        expect(deleteArtistResOk.statusCode).toBe(200);
        expect(deleteArtistResOk.body).toEqual({
            message: "Artist deleted successfully",
            deletedFiles: 0,
            lidarrDeleted: false,
            lidarrError: null,
        });
        artistFsSpy.mockRestore();
    });

    it("deletes track file when it exists on disk before database delete", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-delete-1",
            title: "Delete Me",
            filePath: "Artist-One/Track.flac",
        });
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValue(true);
        const unlinkSpy = jest
            .spyOn(fs, "unlinkSync")
            .mockImplementation(() => undefined);

        const res = createRes();
        await deleteTrackHandler({ params: { id: "track-delete-1" } } as any, res);

        expect(unlinkSpy).toHaveBeenCalledWith(
            "/music/Artist-One/Track.flac"
        );
        expect(mockTrackDelete).toHaveBeenCalledWith({
            where: { id: "track-delete-1" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ message: "Track deleted successfully" });

        existsSpy.mockRestore();
        unlinkSpy.mockRestore();
    });

    it("continues track deletion when file removal fails", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-delete-2",
            title: "Delete Me with Locked File",
            filePath: "Locked/Track.flac",
        });
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValue(true);
        const unlinkSpy = jest
            .spyOn(fs, "unlinkSync")
            .mockImplementation(() => {
                throw new Error("locked");
            });

        const res = createRes();
        await deleteTrackHandler({ params: { id: "track-delete-2" } } as any, res);

        expect(unlinkSpy).toHaveBeenCalledWith("/music/Locked/Track.flac");
        expect(mockTrackDelete).toHaveBeenCalledWith({
            where: { id: "track-delete-2" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ message: "Track deleted successfully" });

        existsSpy.mockRestore();
        unlinkSpy.mockRestore();
    });

    it("returns 500 when track deletion fails after permission checks", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-delete-3",
            title: "Delete Me",
            filePath: null,
        });
        mockTrackDelete.mockRejectedValueOnce(new Error("db delete failed"));

        const res = createRes();
        await deleteTrackHandler({ params: { id: "track-delete-3" } } as any, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to delete track" });
    });

    it("collects artist deletion folders from multiple file path formats", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-delete",
            name: "Delete Artist",
            mbid: null,
            albums: [
                {
                    tracks: [
                        { filePath: "Artist Folder/Album 1/track-one.flac" },
                        { filePath: "single-track.flac" },
                    ],
                },
            ],
        });

        const existingPaths = new Set([
            "/music/Artist Folder/Album 1/track-one.flac",
            "/music/Artist Folder",
            "/music/single-track.flac",
        ]);
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockImplementation((targetPath: fs.PathLike) => {
                return existingPaths.has(targetPath.toString());
            });
        const unlinkSpy = jest
            .spyOn(fs, "unlinkSync")
            .mockImplementation(() => undefined);
        const rmSpy = jest
            .spyOn(fs, "rmSync")
            .mockImplementation(() => undefined);

        const res = createRes();
        await deleteArtistHandler({ params: { id: "artist-delete" } } as any, res);

        expect(unlinkSpy).toHaveBeenCalledWith(
            "/music/Artist Folder/Album 1/track-one.flac"
        );
        expect(unlinkSpy).toHaveBeenCalledWith("/music/single-track.flac");
        expect(rmSpy).toHaveBeenCalledWith("/music/Artist Folder", {
            recursive: true,
            force: true,
        });
        expect(rmSpy).toHaveBeenCalledWith("/music/single-track.flac", {
            recursive: true,
            force: true,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Artist deleted successfully",
            deletedFiles: 2,
            lidarrDeleted: false,
            lidarrError: null,
        });

        existsSpy.mockRestore();
        unlinkSpy.mockRestore();
        rmSpy.mockRestore();
    });

    it("falls back to manual artist-folder cleanup when recursive delete fails", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-fallback",
            name: "Fallback Artist",
            mbid: null,
            albums: [
                {
                    tracks: [
                        { filePath: "Fallback Artist/Album/track-1.flac" },
                        { filePath: "Fallback Artist/Album/track-2.flac" },
                    ],
                },
            ],
        });

        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValue(true);
        const unlinkSpy = jest.spyOn(fs, "unlinkSync").mockImplementation((targetPath: fs.PathLike) => {
            if (targetPath.toString().endsWith("track-1.flac")) {
                throw new Error("locked");
            }
        });
        const rmSyncSpy = jest
            .spyOn(fs, "rmSync")
            .mockImplementation((targetPath: fs.PathLike) => {
                if (targetPath.toString() === "/music/Fallback Artist") {
                    throw new Error("rm failed");
                }
            });
        const readdirSpy = jest
            .spyOn(fs, "readdirSync")
            .mockReturnValue(["child-dir", "child.flac"] as any);
        const statSpy = jest
            .spyOn(fs, "statSync")
            .mockImplementation((targetPath: fs.PathLike) => ({
                isDirectory: () => targetPath.toString().endsWith("child-dir"),
            }) as fs.Stats);
        const rmdirSpy = jest
            .spyOn(fs, "rmdirSync")
            .mockImplementation(() => {
                throw new Error("rmdir failed");
            });

        const res = createRes();
        await deleteArtistHandler({ params: { id: "artist-fallback" } } as any, res);

        expect(unlinkSpy).toHaveBeenCalledWith(
            "/music/Fallback Artist/Album/track-1.flac"
        );
        expect(unlinkSpy).toHaveBeenCalledWith(
            "/music/Fallback Artist/child.flac"
        );
        expect(rmSyncSpy).toHaveBeenCalledWith("/music/Fallback Artist", {
            recursive: true,
            force: true,
        });
        expect(readdirSpy).toHaveBeenCalled();
        expect(statSpy).toHaveBeenCalled();
        expect(mockLoggerError).toHaveBeenCalledWith(
            expect.stringContaining("Cleanup also failed for /music/Fallback Artist"),
            "rmdir failed"
        );
        expect(res.body.deletedFiles).toBeGreaterThan(0);

        existsSpy.mockRestore();
        unlinkSpy.mockRestore();
        rmSyncSpy.mockRestore();
        readdirSpy.mockRestore();
        statSpy.mockRestore();
        rmdirSpy.mockRestore();
    });

    it("deletes additional common artist folders", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-common",
            name: "Common Artist",
            mbid: null,
            albums: [{ tracks: [{ filePath: "Common Folder/Track.flac" }] }],
        });
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockImplementation((targetPath: fs.PathLike) => [
                "/music/Common Folder/Track.flac",
                "/music/Common Folder",
                "/music/Common Artist",
            ].includes(targetPath.toString()));
        const unlinkSpy = jest
            .spyOn(fs, "unlinkSync")
            .mockImplementation(() => undefined);
        const rmSyncSpy = jest.spyOn(fs, "rmSync").mockImplementation(() => undefined);

        const res = createRes();
        await deleteArtistHandler({ params: { id: "artist-common" } } as any, res);

        expect(res.statusCode).toBe(200);
        expect(rmSyncSpy).toHaveBeenCalledWith("/music/Common Folder", { recursive: true, force: true });
        expect(rmSyncSpy).toHaveBeenCalledWith("/music/Common Artist", { recursive: true, force: true });
        expect(unlinkSpy).toHaveBeenCalled();
        existsSpy.mockRestore();
        rmSyncSpy.mockRestore();
        unlinkSpy.mockRestore();
    });

    it("handles Lidarr outcomes while still deleting artist", async () => {
        mockGetSystemSettings.mockResolvedValue({
            libraryDeletionEnabled: true,
        });
        const existsSpy = jest.spyOn(fs, "existsSync").mockReturnValue(false);

        mockLidarrDeleteArtist.mockResolvedValueOnce({
            success: true,
            message: "deleted",
        });
        mockOwnedAlbumDeleteMany.mockRejectedValueOnce(
            new Error("owned-album cleanup failed")
        );
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-lidarr-ok",
            name: "Lidarr Artist",
            mbid: "mbid-ok",
            albums: [],
        });
        let res = createRes();
        await deleteArtistHandler({ params: { id: "artist-lidarr-ok" } } as any, res);
        expect(res.body.lidarrDeleted).toBe(true);
        expect(res.body.lidarrError).toBeNull();

        mockLidarrDeleteArtist.mockResolvedValueOnce({
            success: false,
            message: "not-found",
        });
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-lidarr-failure",
            name: "Lidarr Artist",
            mbid: "mbid-fail",
            albums: [],
        });
        res = createRes();
        await deleteArtistHandler({ params: { id: "artist-lidarr-failure" } } as any, res);
        expect(res.body.lidarrDeleted).toBe(false);
        expect(res.body.lidarrError).toBe("not-found");

        mockLidarrDeleteArtist.mockRejectedValueOnce(
            new Error("lidarr service unavailable")
        );
        mockArtistDelete.mockRejectedValueOnce(new Error("db unavailable"));
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-lidarr-bad",
            name: "Lidarr Artist",
            mbid: "mbid-bad",
            albums: [],
        });
        res = createRes();
        await deleteArtistHandler({ params: { id: "artist-lidarr-bad" } } as any, res);
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to delete artist",
            details: "db unavailable",
        });

        existsSpy.mockRestore();
    });

    it("deletes physical album files and cleans empty album folders", async () => {
        mockGetSystemSettings.mockResolvedValueOnce({
            libraryDeletionEnabled: true,
        });
        mockAlbumFindUnique.mockResolvedValueOnce({
            id: "album-del",
            title: "Deletion Album",
            artist: { name: "Delete Artist" },
            tracks: [{ filePath: "Delete Artist/Deletion Album/track.flac" }],
        });
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValue(true);
        const unlinkSpy = jest
            .spyOn(fs, "unlinkSync")
            .mockImplementation(() => undefined);
        const readdirSpy = jest
            .spyOn(fs, "readdirSync")
            .mockReturnValue([]);
        const rmdirSpy = jest
            .spyOn(fs, "rmdirSync")
            .mockImplementation(() => undefined);

        const req = { params: { id: "album-del" } } as any;
        const res = createRes();
        await deleteAlbumHandler(req, res);

        expect(mockAlbumDelete).toHaveBeenCalledWith({ where: { id: "album-del" } });
        expect(unlinkSpy).toHaveBeenCalledWith(
            "/music/Delete Artist/Deletion Album/track.flac"
        );
        expect(readdirSpy).toHaveBeenCalledWith(
            "/music/Delete Artist/Deletion Album"
        );
        expect(rmdirSpy).toHaveBeenCalledWith(
            "/music/Delete Artist/Deletion Album"
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            message: "Album deleted successfully",
            deletedFiles: 1,
        });

        existsSpy.mockRestore();
        unlinkSpy.mockRestore();
        readdirSpy.mockRestore();
        rmdirSpy.mockRestore();
    });

    it("handles cover-art URL validation, cache branches, and proxied fetch outcomes", async () => {
        const noInputReq = { params: {}, query: {}, headers: {} } as any;
        const noInputRes = createRes();
        await coverArtHandler(noInputReq, noInputRes);
        expect(noInputRes.statusCode).toBe(400);
        expect(noInputRes.body).toEqual({ error: "No cover ID or URL provided" });

        mockNormalizeExternalImageUrl.mockReturnValueOnce(null);
        const invalidReq = {
            params: {},
            query: { url: "https://invalid.example/cover.jpg" },
            headers: {},
        } as any;
        const invalidRes = createRes();
        await coverArtHandler(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({ error: "Invalid cover art URL" });

        mockRedisGet.mockResolvedValueOnce(JSON.stringify({ notFound: true }));
        const cached404Req = {
            params: {},
            query: { url: "https://img.example/not-found.jpg" },
            headers: {},
        } as any;
        const cached404Res = createRes();
        await coverArtHandler(cached404Req, cached404Res);
        expect(cached404Res.statusCode).toBe(404);
        expect(cached404Res.body).toEqual({ error: "Cover art not found" });

        mockRedisGet.mockResolvedValueOnce(
            JSON.stringify({
                etag: "etag-cache",
                contentType: "image/jpeg",
                data: Buffer.from("cached-cover").toString("base64"),
            })
        );
        const cached304Req = {
            params: {},
            query: { url: "https://img.example/cached.jpg" },
            headers: { "if-none-match": "etag-cache" },
        } as any;
        const cached304Res = createRes();
        await coverArtHandler(cached304Req, cached304Res);
        expect(cached304Res.statusCode).toBe(304);

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: false,
            status: "invalid_url",
            url: "https://invalid.example/cover.jpg",
        });
        const invalidFetchReq = {
            params: {},
            query: { url: "https://img.example/invalid-fetch.jpg" },
            headers: {},
        } as any;
        const invalidFetchRes = createRes();
        await coverArtHandler(invalidFetchReq, invalidFetchRes);
        expect(invalidFetchRes.statusCode).toBe(400);
        expect(invalidFetchRes.body).toEqual({ error: "Invalid cover art URL" });

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: false,
            status: "not_found",
            url: "https://img.example/missing.jpg",
        });
        const notFoundReq = {
            params: {},
            query: { url: "https://img.example/missing.jpg" },
            headers: {},
        } as any;
        const notFoundRes = createRes();
        await coverArtHandler(notFoundReq, notFoundRes);
        expect(notFoundRes.statusCode).toBe(404);
        expect(notFoundRes.body).toEqual({ error: "Cover art not found" });
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            expect.stringContaining("cover-art:"),
            expect.any(Number),
            JSON.stringify({ notFound: true })
        );

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: false,
            status: "error",
            url: "https://img.example/error.jpg",
            message: "upstream timeout",
        });
        const errorReq = {
            params: {},
            query: { url: "https://img.example/error.jpg" },
            headers: {},
        } as any;
        const errorRes = createRes();
        await coverArtHandler(errorReq, errorRes);
        expect(errorRes.statusCode).toBe(502);
        expect(errorRes.body).toEqual({ error: "Failed to fetch cover art" });

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: true,
            url: "https://img.example/etag.jpg",
            buffer: Buffer.from("fresh-cover"),
            etag: "etag-fresh",
            contentType: "image/jpeg",
        });
        const fresh304Req = {
            params: {},
            query: { url: "https://img.example/etag.jpg" },
            headers: { "if-none-match": "etag-fresh" },
        } as any;
        const fresh304Res = createRes();
        await coverArtHandler(fresh304Req, fresh304Res);
        expect(fresh304Res.statusCode).toBe(304);

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: true,
            url: "https://img.example/success.jpg",
            buffer: Buffer.from("fresh-cover-2"),
            etag: "etag-success",
            contentType: "image/jpeg",
        });
        const successReq = {
            params: {},
            query: { url: "https://img.example/success.jpg" },
            headers: {},
        } as any;
        const successRes = createRes();
        await coverArtHandler(successReq, successRes);
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual(Buffer.from("fresh-cover-2"));
    });

    it("fetches audiobook covers for query URLs with Origin handling", async () => {
        const fetchSpy = jest
            .spyOn(global as any, "fetch")
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                statusText: "OK",
                headers: {
                    get: jest.fn(() => "image/jpeg"),
                },
                arrayBuffer: async () => Buffer.from("audiobook-cover"),
            } as any);
        mockGetSystemSettings.mockResolvedValueOnce({
            audiobookshelfUrl: "https://ab.example",
            audiobookshelfApiKey: "token-123",
        });

        const queryAudiobookReq = {
            params: {},
            query: { url: "audiobook__release-42" },
            headers: { origin: "https://app.example" },
        } as any;
        const queryAudiobookRes = createRes();

        await coverArtHandler(queryAudiobookReq, queryAudiobookRes);

        expect(queryAudiobookRes.statusCode).toBe(200);
        expect(queryAudiobookRes.body).toEqual(Buffer.from("audiobook-cover"));
        expect(queryAudiobookRes.headers["Access-Control-Allow-Origin"]).toBe(
            "https://app.example"
        );
        expect(queryAudiobookRes.headers["Cache-Control"]).toBe(
            "public, max-age=7776000, immutable"
        );
        expect(fetchSpy).toHaveBeenCalledWith(
            "https://ab.example/api/release-42",
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: "Bearer token-123",
                    "User-Agent": expect.stringContaining("soundspan/"),
                }),
            })
        );

        fetchSpy.mockRestore();
    });

    it("returns 404 when query audiobook cover fetch fails", async () => {
        const fetchSpy = jest
            .spyOn(global as any, "fetch")
            .mockResolvedValueOnce({
                ok: false,
                status: 404,
                statusText: "Not Found",
            } as any);
        mockGetSystemSettings.mockResolvedValueOnce({
            audiobookshelfUrl: "https://ab.example",
            audiobookshelfApiKey: "token-456",
        });

        const queryAudiobookReq = {
            params: {},
            query: { url: "audiobook__missing-release" },
            headers: {},
        } as any;
        const queryAudiobookRes = createRes();

        await coverArtHandler(queryAudiobookReq, queryAudiobookRes);

        expect(queryAudiobookRes.statusCode).toBe(404);
        expect(queryAudiobookRes.body).toEqual({
            error: "Audiobook cover art not found",
        });
        expect(fetchSpy).toHaveBeenCalledWith(
            "https://ab.example/api/missing-release",
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: "Bearer token-456",
                }),
            })
        );

        fetchSpy.mockRestore();
    });

    it("handles album-cover validation, fallback, success, and errors", async () => {
        const invalidReq = { params: { mbid: "temp-123" } } as any;
        const invalidRes = createRes();
        await albumCoverHandler(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({ error: "Valid MBID required" });

        mockCoverArtGetCoverArt.mockResolvedValueOnce(null);
        const noCoverReq = { params: { mbid: "mbid-1" } } as any;
        const noCoverRes = createRes();
        await albumCoverHandler(noCoverReq, noCoverRes);
        expect(noCoverRes.statusCode).toBe(204);

        mockCoverArtGetCoverArt.mockResolvedValueOnce(
            "https://coverartarchive.org/cover.jpg"
        );
        const okReq = { params: { mbid: "mbid-2" } } as any;
        const okRes = createRes();
        await albumCoverHandler(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual({
            coverUrl: "https://coverartarchive.org/cover.jpg",
        });

        mockCoverArtGetCoverArt.mockRejectedValueOnce(new Error("cover boom"));
        const errReq = { params: { mbid: "mbid-3" } } as any;
        const errRes = createRes();
        await albumCoverHandler(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to fetch cover art" });
    });

    it("serves local native cover IDs from disk and falls back to Deezer when missing", async () => {
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true);
        mockAlbumFindUnique
            .mockResolvedValueOnce({
            id: "cover-miss",
            title: "Missed Album",
            artist: {
                id: "artist-cover",
                name: "Cover Artist",
            },
            })
            .mockResolvedValueOnce({
                id: "cover-present",
                title: "Present Album",
                artist: {
                    id: "artist-cover",
                    name: "Cover Artist",
                },
            });
        mockDeezerGetAlbumCover.mockResolvedValueOnce(
            "https://images.example/cover.jpg"
        );

        const missingReq = {
            params: { id: "native:cover-miss.jpg" },
            query: {},
            headers: {},
        } as any;
        const missingRes = createRes();
        await coverArtHandler(missingReq, missingRes);
        expect(existsSpy).toHaveBeenCalledTimes(1);
        expect(mockDeezerGetAlbumCover).toHaveBeenCalledWith(
            "Cover Artist",
            "Missed Album"
        );
        expect(mockAlbumUpdate).toHaveBeenCalledWith({
            where: { id: "cover-miss" },
            data: { coverUrl: "https://images.example/cover.jpg" },
        });
        expect(missingRes.statusCode).toBe(200);
        expect(missingRes.body).toEqual({
            redirect: "https://images.example/cover.jpg",
        });
        const presentReq = {
            params: { id: "native:cover-present.jpg" },
            query: {},
            headers: { origin: "https://app.example" },
        } as any;
        const presentRes = createRes();
        await coverArtHandler(presentReq, presentRes);

        expect(presentRes.statusCode).toBe(200);
        expect(presentRes.body).toEqual({
            filePath: "/tmp/covers/cover-present.jpg",
            options: {
                headers: {
                    "Content-Type": "image/jpeg",
                    "Cache-Control":
                        "public, max-age=7776000, immutable",
                    "Cross-Origin-Resource-Policy": "cross-origin",
                    "Access-Control-Allow-Origin": "https://app.example",
                    "Access-Control-Allow-Credentials": "true",
                },
            },
        });
        existsSpy.mockRestore();
    });

    it("returns invalid cover ID format for malformed /cover-art path params", async () => {
        const invalidReq = { params: { id: "just-text" }, query: {} } as any;
        const invalidRes = createRes();

        await coverArtHandler(invalidReq, invalidRes);

        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({
            error: "Invalid cover ID format",
        });
    });

    it("handles cover-art-colors cache/fetch branches and extraction failures", async () => {
        const missingReq = { query: {} } as any;
        const missingRes = createRes();
        await coverArtColorsHandler(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(400);
        expect(missingRes.body).toEqual({ error: "URL parameter required" });

        mockNormalizeExternalImageUrl.mockReturnValueOnce(null);
        const invalidReq = { query: { url: "https://bad.example" } } as any;
        const invalidRes = createRes();
        await coverArtColorsHandler(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({ error: "Invalid image URL" });

        const placeholderReq = { query: { url: "https://cdn/placeholder.jpg" } } as any;
        const placeholderRes = createRes();
        await coverArtColorsHandler(placeholderReq, placeholderRes);
        expect(placeholderRes.statusCode).toBe(200);
        expect(placeholderRes.body).toEqual(
            expect.objectContaining({
                vibrant: "#1db954",
                muted: "#535353",
            })
        );

        mockRedisGet.mockResolvedValueOnce(
            JSON.stringify({
                vibrant: "#aaaaaa",
                darkVibrant: "#bbbbbb",
                lightVibrant: "#cccccc",
                muted: "#dddddd",
                darkMuted: "#eeeeee",
                lightMuted: "#ffffff",
            })
        );
        const cacheHitReq = { query: { url: "https://img.example/cache.jpg" } } as any;
        const cacheHitRes = createRes();
        await coverArtColorsHandler(cacheHitReq, cacheHitRes);
        expect(cacheHitRes.statusCode).toBe(200);
        expect(cacheHitRes.body).toEqual(
            expect.objectContaining({ vibrant: "#aaaaaa" })
        );

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: false,
            status: "not_found",
            url: "https://img.example/missing.jpg",
        });
        const notFoundReq = { query: { url: "https://img.example/missing.jpg" } } as any;
        const notFoundRes = createRes();
        await coverArtColorsHandler(notFoundReq, notFoundRes);
        expect(notFoundRes.statusCode).toBe(404);
        expect(notFoundRes.body).toEqual({ error: "Image not found" });

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: false,
            status: "error",
            url: "https://img.example/error.jpg",
            message: "fetch failed",
        });
        const fetchErrorReq = { query: { url: "https://img.example/error.jpg" } } as any;
        const fetchErrorRes = createRes();
        await coverArtColorsHandler(fetchErrorReq, fetchErrorRes);
        expect(fetchErrorRes.statusCode).toBe(504);
        expect(fetchErrorRes.body).toEqual({ error: "Image fetch failed" });

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: true,
            url: "https://img.example/ok.jpg",
            buffer: Buffer.from("img"),
        });
        mockExtractColorsFromImage.mockResolvedValueOnce({
            vibrant: "#100000",
            darkVibrant: "#200000",
            lightVibrant: "#300000",
            muted: "#400000",
            darkMuted: "#500000",
            lightMuted: "#600000",
        });
        const okReq = { query: { url: "https://img.example/ok.jpg" } } as any;
        const okRes = createRes();
        await coverArtColorsHandler(okReq, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(okRes.body).toEqual(
            expect.objectContaining({ vibrant: "#100000" })
        );
        expect(mockRedisSetEx).toHaveBeenCalledWith(
            expect.stringContaining("colors:"),
            2592000,
            expect.any(String)
        );

        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: true,
            url: "https://img.example/crash.jpg",
            buffer: Buffer.from("img"),
        });
        mockExtractColorsFromImage.mockRejectedValueOnce(new Error("extract failed"));
        const errReq = { query: { url: "https://img.example/crash.jpg" } } as any;
        const errRes = createRes();
        await coverArtColorsHandler(errReq, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to extract colors" });
    });

    it("continues color extraction when cache read fails", async () => {
        mockNormalizeExternalImageUrl.mockReturnValueOnce("https://img.example/cover.png");
        mockRedisGet.mockRejectedValueOnce(new Error("redis read failure"));
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: true,
            url: "https://img.example/cover.png",
            buffer: Buffer.from("image-pixels"),
        });

        const req = { query: { url: "https://img.example/cover.png" } } as any;
        const res = createRes();

        await coverArtColorsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(expect.objectContaining({ vibrant: "#111111" }));
        expect(mockFetchExternalImage).toHaveBeenCalledWith(
            expect.objectContaining({ url: "https://img.example/cover.png" })
        );
    });

    it("continues color extraction when cache write fails", async () => {
        mockNormalizeExternalImageUrl.mockReturnValueOnce("https://img.example/cover2.png");
        mockRedisGet.mockResolvedValueOnce(null);
        mockFetchExternalImage.mockResolvedValueOnce({
            ok: true,
            url: "https://img.example/cover2.png",
            buffer: Buffer.from("image-pixels-2"),
        });
        mockRedisSetEx.mockRejectedValueOnce(new Error("redis write failure"));

        const req = { query: { url: "https://img.example/cover2.png" } } as any;
        const res = createRes();

        await coverArtColorsHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(expect.objectContaining({ vibrant: "#111111" }));
    });

    it("filters artist-name genres and converts bigint counts", async () => {
        mockArtistFindMany.mockResolvedValueOnce([
            { name: "Radiohead", normalizedName: "radiohead" },
            { name: "Aphex Twin", normalizedName: "aphextwin" },
        ]);
        mockPrismaQueryRaw.mockResolvedValueOnce([
            { genre: "electronic", track_count: 24n },
            { genre: "radiohead", track_count: 30n },
        ]);

        const req = {} as any;
        const res = createRes();
        await genresHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            genres: [{ genre: "electronic", count: 24 }],
        });

        mockPrismaQueryRaw.mockRejectedValueOnce(new Error("genre query failed"));
        const errRes = createRes();
        await genresHandler(req, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to get genres" });
    });

    it("returns decades based on effective year and minimum track threshold", async () => {
        mockAlbumFindMany.mockResolvedValueOnce([
            {
                year: 1992,
                originalYear: null,
                displayYear: null,
                _count: { tracks: 8 },
            },
            {
                year: 1998,
                originalYear: null,
                displayYear: null,
                _count: { tracks: 9 },
            },
            {
                year: 2005,
                originalYear: null,
                displayYear: null,
                _count: { tracks: 6 },
            },
        ]);

        const req = {} as any;
        const res = createRes();
        await decadesHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            decades: [{ decade: 1990, count: 17 }],
        });

        mockAlbumFindMany.mockRejectedValueOnce(new Error("decade query failed"));
        const errRes = createRes();
        await decadesHandler(req, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to get decades" });
    });

    it("validates radio type and handles discovery unplayed and least-played fallback flows", async () => {
        const missingTypeReq = { query: {}, user: { id: "user-1" } } as any;
        const missingTypeRes = createRes();
        await radioHandler(missingTypeReq, missingTypeRes);
        expect(missingTypeRes.statusCode).toBe(400);
        expect(missingTypeRes.body).toEqual({ error: "Radio type is required" });

        mockTrackFindMany
            .mockResolvedValueOnce([{ id: "u1" }, { id: "u2" }])
            .mockResolvedValueOnce([
                createRadioTrack("u1"),
                createRadioTrack("u2"),
            ]);

        const discoveryReq = {
            query: { type: "discovery", limit: "2" },
            user: { id: "user-1" },
        } as any;
        const discoveryRes = createRes();
        await radioHandler(discoveryReq, discoveryRes);
        expect(discoveryRes.statusCode).toBe(200);
        expect(discoveryRes.body.tracks).toHaveLength(2);

        mockTrackFindMany
            .mockResolvedValueOnce([{ id: "u3" }])
            .mockResolvedValueOnce([
                createRadioTrack("lp1"),
                createRadioTrack("lp2"),
            ]);
        mockPrismaQueryRaw.mockResolvedValueOnce([{ id: "lp1" }, { id: "lp2" }]);

        const fallbackReq = {
            query: { type: "discovery", limit: "2" },
            user: { id: "user-1" },
        } as any;
        const fallbackRes = createRes();
        await radioHandler(fallbackReq, fallbackRes);
        expect(mockPrismaQueryRaw).toHaveBeenCalled();
        expect(fallbackRes.statusCode).toBe(200);
        expect(fallbackRes.body.tracks.map((track: any) => track.id)).toEqual([
            "lp1",
            "lp2",
        ]);
    });

    it("builds workout radio using audio, genre table, and album-genre fallback sources", async () => {
        mockTrackFindMany
            .mockResolvedValueOnce([{ id: "w1" }])
            .mockResolvedValueOnce([{ id: "w3" }])
            .mockResolvedValueOnce([
                createRadioTrack("w1"),
                createRadioTrack("w2"),
                createRadioTrack("w3"),
            ]);
        mockGenreFindMany.mockResolvedValueOnce([
            {
                trackGenres: [{ trackId: "w2" }],
            },
        ]);

        const req = {
            query: { type: "workout", limit: "3" },
            user: { id: "user-22" },
        } as any;
        const res = createRes();
        await radioHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.tracks).toHaveLength(3);
        expect(res.body.tracks.map((track: any) => track.id)).toEqual([
            "w1",
            "w2",
            "w3",
        ]);
    });

    it("supports artist radio validation, empty artist libraries, and mixed artist+similar queues", async () => {
        const missingArtistReq = {
            query: { type: "artist" },
            user: { id: "user-1" },
        } as any;
        const missingArtistRes = createRes();
        await radioHandler(missingArtistReq, missingArtistRes);
        expect(missingArtistRes.statusCode).toBe(400);
        expect(missingArtistRes.body).toEqual({
            error: "Artist ID required for artist radio",
        });

        mockTrackFindMany.mockResolvedValueOnce([]);
        const emptyArtistReq = {
            query: { type: "artist", value: "artist-main", limit: "5" },
            user: { id: "user-1" },
        } as any;
        const emptyArtistRes = createRes();
        await radioHandler(emptyArtistReq, emptyArtistRes);
        expect(emptyArtistRes.statusCode).toBe(200);
        expect(emptyArtistRes.body).toEqual({ tracks: [] });

        mockTrackFindMany
            .mockResolvedValueOnce([
                { id: "a1", bpm: 120, energy: 0.8, valence: 0.6, danceability: 0.7 },
                { id: "a2", bpm: 126, energy: 0.75, valence: 0.58, danceability: 0.72 },
            ])
            .mockResolvedValueOnce([
                {
                    id: "s1",
                    bpm: 122,
                    energy: 0.78,
                    valence: 0.59,
                    danceability: 0.71,
                },
                {
                    id: "s2",
                    bpm: null,
                    energy: null,
                    valence: null,
                    danceability: null,
                },
            ])
            .mockResolvedValueOnce([
                createRadioTrack("a1", {
                    album: {
                        id: "album-a1",
                        title: "Album A1",
                        coverUrl: "a1.jpg",
                        artist: { id: "artist-main", name: "Main Artist" },
                    },
                }),
                createRadioTrack("a2", {
                    album: {
                        id: "album-a2",
                        title: "Album A2",
                        coverUrl: "a2.jpg",
                        artist: { id: "artist-main", name: "Main Artist" },
                    },
                }),
                createRadioTrack("s1", {
                    album: {
                        id: "album-s1",
                        title: "Album S1",
                        coverUrl: "s1.jpg",
                        artist: { id: "artist-sim-1", name: "Similar Artist 1" },
                    },
                }),
                createRadioTrack("s2", {
                    album: {
                        id: "album-s2",
                        title: "Album S2",
                        coverUrl: "s2.jpg",
                        artist: { id: "artist-sim-1", name: "Similar Artist 1" },
                    },
                }),
            ]);
        mockOwnedAlbumFindMany.mockResolvedValueOnce([
            { artistId: "artist-main" },
            { artistId: "artist-sim-1" },
            { artistId: "artist-sim-2" },
        ]);
        mockSimilarArtistFindMany.mockResolvedValueOnce([
            { toArtistId: "artist-sim-1", weight: 0.95 },
        ]);
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-main",
            genres: [],
            userGenres: [],
        });

        const mixedReq = {
            query: { type: "artist", value: "artist-main", limit: "4" },
            user: { id: "user-1" },
        } as any;
        const mixedRes = createRes();
        await radioHandler(mixedReq, mixedRes);
        expect(mixedRes.statusCode).toBe(200);
        expect(mixedRes.body.tracks.map((track: any) => track.id)).toEqual([
            "a1",
            "a2",
            "s1",
            "s2",
        ]);
    });

    it("builds vibe radio queues with similarity scoring and layered fallbacks", async () => {
        const sourceTrack = {
            id: "source-track",
            title: "Source Track",
            bpm: 120,
            energy: 0.82,
            valence: 0.68,
            arousal: 0.7,
            danceability: 0.74,
            keyScale: "major",
            instrumentalness: 0.2,
            moodHappy: 0.78,
            moodSad: 0.12,
            moodRelaxed: 0.21,
            moodAggressive: 0.35,
            moodParty: 0.72,
            moodAcoustic: 0.2,
            moodElectronic: 0.62,
            danceabilityMl: 0.77,
            analysisMode: "enhanced",
            analysisVersion: "2.1b6-enhanced-v3.5",
            moodTags: ["energetic"],
            lastfmTags: ["rock"],
            essentiaGenres: ["alternative"],
            album: {
                id: "album-source",
                title: "Source Album",
                artistId: "artist-source",
                genres: ["rock"],
                artist: { id: "artist-source", name: "Source Artist" },
            },
        };
        mockTrackFindUnique
            .mockResolvedValueOnce(sourceTrack)
            .mockResolvedValueOnce({
                ...sourceTrack,
                trackGenres: [{ genre: { name: "rock" } }],
            });

        mockTrackFindMany.mockImplementation(async (args: any) => {
            if (
                args.where?.analysisStatus === "completed" &&
                args.where?.id?.not === "source-track"
            ) {
                return [
                    {
                        id: "an-1",
                        bpm: 121,
                        energy: 0.81,
                        valence: 0.66,
                        arousal: 0.69,
                        danceability: 0.73,
                        keyScale: "major",
                        moodTags: ["energetic"],
                        lastfmTags: ["rock"],
                        essentiaGenres: ["alternative"],
                        instrumentalness: 0.18,
                        moodHappy: 0.75,
                        moodSad: 0.14,
                        moodRelaxed: 0.23,
                        moodAggressive: 0.32,
                        moodParty: 0.7,
                        moodAcoustic: 0.2,
                        moodElectronic: 0.65,
                        danceabilityMl: 0.75,
                        analysisMode: "enhanced",
                        analysisVersion: "2.1b6-enhanced-v3.5",
                    },
                    {
                        id: "an-2",
                        bpm: 118,
                        energy: 0.76,
                        valence: 0.74,
                        arousal: 0.75,
                        danceability: 0.72,
                        keyScale: "minor",
                        moodTags: [],
                        lastfmTags: [],
                        essentiaGenres: [],
                        instrumentalness: 0.3,
                        moodHappy: 0.82,
                        moodSad: 0.8,
                        moodRelaxed: 0.81,
                        moodAggressive: 0.84,
                        moodParty: 0.79,
                        moodAcoustic: 0.78,
                        moodElectronic: 0.83,
                        danceabilityMl: 0.73,
                        analysisMode: "enhanced",
                        analysisVersion: "2.1b6-enhanced-v3.5",
                    },
                ];
            }
            if (
                args.where?.album?.artistId === "artist-source" &&
                Array.isArray(args.where?.id?.notIn)
            ) {
                return [{ id: "same-a1" }];
            }
            if (Array.isArray(args.where?.album?.artistId?.in)) {
                return [{ id: "sim-b1" }];
            }
            if (args.where?.trackGenres?.some) {
                return [{ id: "genre-c1" }];
            }
            if (
                Array.isArray(args.where?.id?.notIn) &&
                args.select?.id &&
                typeof args.take === "number" &&
                !args.where?.album &&
                !args.include
            ) {
                return Array.from({ length: args.take }, (_unused, index) => ({
                    id: `rnd-d${index + 1}`,
                }));
            }
            if (Array.isArray(args.where?.id?.in) && args.include?.album) {
                return (args.where.id.in as string[]).map((id: string, index: number) =>
                    createRadioTrack(id, {
                        trackGenres:
                            index === 0 ? [{ genre: { name: "rock" } }] : [],
                    }),
                );
            }
            return [];
        });
        mockOwnedAlbumFindMany.mockResolvedValueOnce([
            { artistId: "artist-source" },
            { artistId: "artist-sim-1" },
        ]);
        mockSimilarArtistFindMany.mockResolvedValueOnce([
            { toArtistId: "artist-sim-1", weight: 0.9 },
        ]);

        const missingSourceReq = {
            query: { type: "vibe" },
            user: { id: "user-1" },
        } as any;
        const missingSourceRes = createRes();
        await radioHandler(missingSourceReq, missingSourceRes);
        expect(missingSourceRes.statusCode).toBe(400);
        expect(missingSourceRes.body).toEqual({
            error: "Track ID required for vibe matching",
        });

        const vibeReq = {
            query: { type: "vibe", value: "source-track", limit: "55" },
            user: { id: "user-1" },
        } as any;
        const vibeRes = createRes();
        await radioHandler(vibeReq, vibeRes);

        expect(vibeRes.statusCode).toBe(200);
        expect(vibeRes.body.tracks).toHaveLength(55);
        expect(vibeRes.body.sourceFeatures).toEqual(
            expect.objectContaining({
                bpm: 120,
                energy: 0.82,
                analysisMode: "enhanced",
            })
        );
        expect(vibeRes.body.tracks[0]).toEqual(
            expect.objectContaining({
                id: expect.any(String),
                audioFeatures: expect.objectContaining({
                    bpm: expect.any(Number),
                }),
            })
        );
    });

    it("covers favorites, decade, genre, mood, and all radio branches", async () => {
        mockPrismaQueryRaw.mockResolvedValueOnce([{ id: "fav-1", play_count: 15n }]);
        mockTrackFindMany.mockResolvedValueOnce([createRadioTrack("fav-1")]);
        const favoritesReq = {
            query: { type: "favorites", limit: "1" },
            user: { id: "user-1" },
        } as any;
        const favoritesRes = createRes();
        await radioHandler(favoritesReq, favoritesRes);
        expect(favoritesRes.statusCode).toBe(200);
        expect(favoritesRes.body.tracks.map((track: any) => track.id)).toEqual([
            "fav-1",
        ]);

        mockPrismaQueryRaw.mockResolvedValueOnce([]);
        mockTrackFindMany
            .mockResolvedValueOnce([{ id: "rand-fav-1" }])
            .mockResolvedValueOnce([createRadioTrack("rand-fav-1")]);
        const fallbackFavoritesReq = {
            query: { type: "favorites", limit: "1" },
            user: { id: "user-1" },
        } as any;
        const fallbackFavoritesRes = createRes();
        await radioHandler(fallbackFavoritesReq, fallbackFavoritesRes);
        expect(fallbackFavoritesRes.statusCode).toBe(200);
        expect(fallbackFavoritesRes.body.tracks[0].id).toBe("rand-fav-1");

        mockTrackFindMany
            .mockResolvedValueOnce([{ id: "dec-1" }])
            .mockResolvedValueOnce([createRadioTrack("dec-1")]);
        const decadeReq = {
            query: { type: "decade", value: "1990", limit: "1" },
            user: { id: "user-1" },
        } as any;
        const decadeRes = createRes();
        await radioHandler(decadeReq, decadeRes);
        expect(decadeRes.statusCode).toBe(200);
        expect(mockGetDecadeWhereClause).toHaveBeenCalledWith(1990);
        expect(decadeRes.body.tracks[0].id).toBe("dec-1");

        mockPrismaQueryRaw.mockResolvedValueOnce([{ id: "genre-1" }]);
        mockTrackFindMany.mockResolvedValueOnce([createRadioTrack("genre-1")]);
        const genreReq = {
            query: { type: "genre", value: "rock", limit: "1" },
            user: { id: "user-1" },
        } as any;
        const genreRes = createRes();
        await radioHandler(genreReq, genreRes);
        expect(genreRes.statusCode).toBe(200);
        expect(genreRes.body.tracks[0].id).toBe("genre-1");

        mockTrackFindMany
            .mockResolvedValueOnce([{ id: "mood-1" }])
            .mockResolvedValueOnce([createRadioTrack("mood-1")]);
        const moodReq = {
            query: { type: "mood", value: "chill", limit: "1" },
            user: { id: "user-1" },
        } as any;
        const moodRes = createRes();
        await radioHandler(moodReq, moodRes);
        expect(moodRes.statusCode).toBe(200);
        expect(moodRes.body.tracks[0].id).toBe("mood-1");

        mockTrackFindMany
            .mockResolvedValueOnce([{ id: "mood-2" }])
            .mockResolvedValueOnce([createRadioTrack("mood-2")]);
        const defaultMoodReq = {
            query: { type: "mood", value: "obscure-tag", limit: "1" },
            user: { id: "user-1" },
        } as any;
        const defaultMoodRes = createRes();
        await radioHandler(defaultMoodReq, defaultMoodRes);
        expect(defaultMoodRes.statusCode).toBe(200);
        expect(defaultMoodRes.body.tracks[0].id).toBe("mood-2");

        const additionalMoodCases: Array<[string, string]> = [
            ["high-energy", "mood-high"],
            ["happy", "mood-happy"],
            ["melancholy", "mood-melancholy"],
            ["dance", "mood-dance"],
            ["acoustic", "mood-acoustic"],
            ["instrumental", "mood-instrumental"],
        ];
        for (const [moodValue, trackId] of additionalMoodCases) {
            mockTrackFindMany
                .mockResolvedValueOnce([{ id: trackId }])
                .mockResolvedValueOnce([createRadioTrack(trackId)]);
            const req = {
                query: { type: "mood", value: moodValue, limit: "1" },
                user: { id: "user-1" },
            } as any;
            const res = createRes();
            await radioHandler(req, res);
            expect(res.statusCode).toBe(200);
            expect(res.body.tracks[0].id).toBe(trackId);
        }

        mockTrackFindMany.mockResolvedValueOnce([]);
        const emptyAllReq = {
            query: { type: "all", limit: "5" },
            user: { id: "user-1" },
        } as any;
        const emptyAllRes = createRes();
        await radioHandler(emptyAllReq, emptyAllRes);
        expect(emptyAllRes.statusCode).toBe(200);
        expect(emptyAllRes.body).toEqual({ tracks: [] });
    });

    it("uses genre-based artist fallback when lastfm similar artists are insufficient", async () => {
        mockGetMergedGenres.mockImplementation((artist: any) => artist?.genres || []);
        mockTrackFindMany.mockImplementation(async (args: any) => {
            if (
                args.where?.album?.artistId === "artist-main" &&
                !args.where?.album?.artistId?.in
            ) {
                return [
                    { id: "main-1", bpm: 120, energy: 0.8, valence: 0.65, danceability: 0.72 },
                    { id: "main-2", bpm: 124, energy: 0.77, valence: 0.6, danceability: 0.7 },
                ];
            }
            if (Array.isArray(args.where?.album?.artistId?.in)) {
                return [
                    {
                        id: "genre-sim-1",
                        bpm: 122,
                        energy: 0.74,
                        valence: 0.59,
                        danceability: 0.68,
                    },
                    {
                        id: "genre-sim-2",
                        bpm: 118,
                        energy: 0.65,
                        valence: 0.55,
                        danceability: 0.6,
                    },
                ];
            }
            if (Array.isArray(args.where?.id?.in) && args.include?.album) {
                return [
                    createRadioTrack("main-1", {
                        album: {
                            id: "album-main-1",
                            title: "Main 1",
                            coverUrl: "main-1.jpg",
                            artist: { id: "artist-main", name: "Main Artist" },
                        },
                    }),
                    createRadioTrack("main-2", {
                        album: {
                            id: "album-main-2",
                            title: "Main 2",
                            coverUrl: "main-2.jpg",
                            artist: { id: "artist-main", name: "Main Artist" },
                        },
                    }),
                    createRadioTrack("genre-sim-1", {
                        album: {
                            id: "album-genre-sim-1",
                            title: "Genre Sim",
                            coverUrl: "genre-sim-1.jpg",
                            artist: { id: "artist-genre-1", name: "Genre Similar" },
                        },
                    }),
                    createRadioTrack("genre-sim-2", {
                        album: {
                            id: "album-genre-sim-2",
                            title: "Genre Sim 2",
                            coverUrl: "genre-sim-2.jpg",
                            artist: { id: "artist-genre-2", name: "Genre Similar 2" },
                        },
                    }),
                ];
            }
            return [];
        });
        mockOwnedAlbumFindMany.mockResolvedValueOnce([
            { artistId: "artist-main" },
            { artistId: "artist-genre-1" },
            { artistId: "artist-genre-2" },
        ]);
        mockSimilarArtistFindMany.mockResolvedValueOnce([]);
        mockArtistFindUnique.mockResolvedValueOnce({
            id: "artist-main",
            genres: ["rock"],
            userGenres: [],
        });
        mockArtistFindMany.mockResolvedValueOnce([
            { id: "artist-genre-1", genres: ["alt rock", "rock"], userGenres: [] },
            { id: "artist-genre-2", genres: ["rock"], userGenres: [] },
        ]);

        const req = {
            query: { type: "artist", value: "artist-main", limit: "4" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();
        await radioHandler(req, res);

        expect(mockArtistFindMany).toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body.tracks.map((track: any) => track.id)).toEqual([
            "main-1",
            "main-2",
            "genre-sim-1",
            "genre-sim-2",
        ]);
    });

    it("handles vibe not-found and top-level radio failures", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(null);
        const missingTrackReq = {
            query: { type: "vibe", value: "missing-track", limit: "3" },
            user: { id: "user-1" },
        } as any;
        const missingTrackRes = createRes();
        await radioHandler(missingTrackReq, missingTrackRes);
        expect(missingTrackRes.statusCode).toBe(404);
        expect(missingTrackRes.body).toEqual({ error: "Track not found" });

        mockTrackFindMany.mockRejectedValueOnce(new Error("radio explosion"));
        const errorReq = {
            query: { type: "all", limit: "2" },
            user: { id: "user-1" },
        } as any;
        const errorRes = createRes();
        await radioHandler(errorReq, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "Failed to get radio tracks" });
    });
});

describe("library album cover and media route edge coverage", () => {
    const albumCoverHandler = getHandler("get", "/album-cover/:mbid", 1);
    const audioInfoHandler = getHandler("get", "/tracks/:id/audio-info", 1);
    const trackStreamHandler = getHandler("get", "/tracks/:id/stream");

    beforeEach(() => {
        jest.clearAllMocks();
        (config.music as any).musicPath = "/music";
        (config.music as any).transcodeCachePath = "/tmp/soundspan-cache";
        (config.music as any).transcodeCacheMaxGb = 1;

        mockTrackFindUnique.mockResolvedValue(createNativeTrack());
        mockPlayFindFirst.mockResolvedValue(null);
        mockPlayCreate.mockResolvedValue({});
        mockUserSettingsFindUnique.mockResolvedValue({ playbackQuality: "medium" });
        mockStreamGetStreamFilePath.mockResolvedValue({
            filePath: "/tmp/stream.flac",
            mimeType: "audio/flac",
        });
        mockStreamWithRangeSupport.mockResolvedValue(undefined);
        mockStreamDestroy.mockImplementation(() => undefined);
    });

    it("returns 400 for temporary MBID album-cover requests", async () => {
        const req = { params: { mbid: "temp-album-1" } } as any;
        const res = createRes();

        await albumCoverHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ error: "Valid MBID required" });
        expect(mockCoverArtGetCoverArt).not.toHaveBeenCalled();
    });

    it("returns 204 when no album cover exists in archive", async () => {
        mockCoverArtGetCoverArt.mockResolvedValue(null);

        const req = { params: { mbid: "mbid-123" } } as any;
        const res = createRes();

        await albumCoverHandler(req, res);

        expect(res.statusCode).toBe(204);
        expect(mockCoverArtGetCoverArt).toHaveBeenCalledWith("mbid-123");
        expect(res.body).toBeUndefined();
    });

    it("maps album-cover lookup failures to 500", async () => {
        mockCoverArtGetCoverArt.mockRejectedValue(new Error("caa-down"));

        const req = { params: { mbid: "mbid-down" } } as any;
        const res = createRes();

        await albumCoverHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to fetch cover art" });
    });

    it("returns 404 when audio info track is missing", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(null);

        const req = { params: { id: "missing-track" }, user: { id: "user-1" } } as any;
        const res = createRes();

        await audioInfoHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Track not found" });
    });

    it("returns 404 for audio-info when file does not exist", async () => {
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValue(false);

        mockTrackFindUnique.mockResolvedValueOnce({
            filePath: "missing/track.flac",
        });

        const req = {
            params: { id: "ghost-track" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await audioInfoHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "File not found on disk" });

        existsSpy.mockRestore();
    });

    it("extracts audio metadata and maps fields correctly", async () => {
        const existsSpy = jest
            .spyOn(fs, "existsSync")
            .mockReturnValue(true);

        mockTrackFindUnique.mockResolvedValueOnce({
            filePath: "library/Track.flac",
        });
        mockParseFile.mockResolvedValueOnce({
            format: {
                codec: "FLAC",
                bitrate: 320000,
                sampleRate: 44100,
                bitsPerSample: 24,
                lossless: true,
                numberOfChannels: 2,
            },
        });

        const req = {
            params: { id: "real-track" },
            user: { id: "user-1" },
        } as any;
        const res = createRes();

        await audioInfoHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            codec: "FLAC",
            bitrate: 320,
            sampleRate: 44100,
            bitDepth: 24,
            lossless: true,
            channels: 2,
        });

        existsSpy.mockRestore();
    });

    it("returns stream 401 when authentication is missing", async () => {
        const req = { params: { id: "track-1" }, query: {} } as any;
        const res = createRes();

        await trackStreamHandler(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Unauthorized" });
    });

    it("returns 404 for missing tracks during stream", async () => {
        mockTrackFindUnique.mockResolvedValueOnce(null);

        const req = {
            params: { id: "missing-track" },
            user: { id: "user-1" },
            query: {},
        } as any;
        const res = createRes();

        await trackStreamHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Track not found" });
    });

    it("returns 404 for stream requests without a file path", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-fileless",
            filePath: null,
            fileModified: new Date(),
            title: "Track without file",
        });

        const req = {
            params: { id: "track-fileless" },
            user: { id: "user-1" },
            query: {},
        } as any;
        const res = createRes();

        await trackStreamHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Track not available" });
    });

    it("streams native file and logs play activity when first playback", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-stream",
            title: "Streamed Track",
            filePath: "Artists/Track.flac",
            fileModified: new Date("2024-01-01T00:00:00.000Z"),
        });
        mockUserSettingsFindUnique.mockResolvedValueOnce(null);
        mockPlayFindFirst.mockResolvedValueOnce(null);
        mockPlayCreate.mockResolvedValueOnce({});
        mockStreamGetStreamFilePath.mockResolvedValueOnce({
            filePath: "/tmp/stream.flac",
            mimeType: "audio/flac",
        });
        mockStreamWithRangeSupport.mockResolvedValueOnce(undefined);

        const req = {
            params: { id: "track-stream" },
            user: { id: "user-1" },
            query: {},
        } as any;
        const res = createRes();

        await trackStreamHandler(req, res);

        expect(mockTrackFindUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: "track-stream" },
            })
        );
        expect(mockPlayFindFirst).toHaveBeenCalledWith({
            where: {
                userId: "user-1",
                trackId: "track-stream",
                playedAt: { gte: expect.any(Date) },
            },
            orderBy: { playedAt: "desc" },
        });
        expect(mockPlayCreate).toHaveBeenCalledWith(
            expect.objectContaining({
                data: {
                    userId: "user-1",
                    trackId: "track-stream",
                },
            })
        );
        expect(mockStreamGetStreamFilePath).toHaveBeenCalledWith(
            "track-stream",
            "medium",
            expect.any(Date),
            expect.stringContaining("Artists/Track.flac")
        );
        expect(mockStreamWithRangeSupport).toHaveBeenCalledWith(
            req,
            res,
            "/tmp/stream.flac",
            "audio/flac"
        );
        expect(mockStreamDestroy).toHaveBeenCalled();
    });

    it("falls back to original quality when FFmpeg is unavailable", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-stream-fallback",
            title: "Fallback Track",
            filePath: "Fallback/Track.flac",
            fileModified: new Date("2024-01-02T00:00:00.000Z"),
        });
        mockUserSettingsFindUnique.mockResolvedValueOnce({
            playbackQuality: "high",
        });
        mockPlayFindFirst.mockResolvedValueOnce({});
        mockStreamGetStreamFilePath
            .mockRejectedValueOnce({ code: "FFMPEG_NOT_FOUND" })
            .mockResolvedValueOnce({
                filePath: "/tmp/stream-original.flac",
                mimeType: "audio/flac",
            });
        mockStreamWithRangeSupport.mockResolvedValueOnce(undefined);

        const req = {
            params: { id: "track-stream-fallback" },
            user: { id: "user-1" },
            query: { quality: "high" },
        } as any;
        const res = createRes();

        await trackStreamHandler(req, res);

        expect(mockStreamGetStreamFilePath).toHaveBeenNthCalledWith(
            1,
            "track-stream-fallback",
            "high",
            expect.any(Date),
            expect.stringContaining("Fallback/Track.flac")
        );
        expect(mockStreamGetStreamFilePath).toHaveBeenNthCalledWith(
            2,
            "track-stream-fallback",
            "original",
            expect.any(Date),
            expect.stringContaining("Fallback/Track.flac")
        );
        expect(mockStreamWithRangeSupport).toHaveBeenCalledWith(
            req,
            res,
            "/tmp/stream-original.flac",
            "audio/flac"
        );
        expect(mockStreamDestroy).toHaveBeenCalled();
    });

    it("returns 500 when stream file preparation fails for non-recoverable errors", async () => {
        mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-stream-error",
            title: "Broken Track",
            filePath: "Broken/Track.flac",
            fileModified: new Date("2024-01-03T00:00:00.000Z"),
        });
        mockUserSettingsFindUnique.mockResolvedValueOnce({
            playbackQuality: "low",
        });
        mockPlayFindFirst.mockResolvedValueOnce(null);
        mockPlayCreate.mockResolvedValueOnce({});
        mockStreamGetStreamFilePath.mockRejectedValueOnce(new Error("stream setup failed"));

        const req = {
            params: { id: "track-stream-error" },
            user: { id: "user-1" },
            query: {},
        } as any;
        const res = createRes();

        await trackStreamHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to stream track" });
    });
});
