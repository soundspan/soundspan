import express, { type Request, type Response } from "express";
import fs from "fs";
import request from "supertest";

const mockStreamGetStreamFilePath = jest.fn();
const mockStreamWithRangeSupport = jest.fn();
const mockStreamDestroy = jest.fn();
const mockParseFile = jest.fn();
const mockLookup = jest.fn();
const mockProxyFederatedTrackStream = jest.fn();
const mockProxyFederatedCover = jest.fn();
const mockLoadPeerPlaybackFallback = jest.fn();
const mockServeMappedProviderStream = jest.fn();
const mockTerminateCommittedStream = jest.fn((res: Response) => res.end());
const mockGetYtMusicUserIdOrPublic = jest.fn();
const mockBumpSearchCacheVersion = jest.fn().mockResolvedValue(undefined);

jest.mock("dns/promises", () => ({
    lookup: (...args: unknown[]) => mockLookup(...args),
}));

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
    requireAdmin: (req: Request, res: Response, next: () => void) => {
        if (req.user?.role !== "admin") {
            return res.status(403).json({ error: "Admin access required" });
        }
        next();
    },
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
        remoteLikedTrack: {
            findUnique: jest.fn(),
            upsert: jest.fn(),
            deleteMany: jest.fn(),
            findMany: jest.fn(),
            count: jest.fn(),
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
        federationPeer: {
            findUnique: jest.fn(),
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
        systemSettings: {
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
            updateMany: jest.fn(),
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
        $executeRaw: jest.fn(),
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
        features: { federation: true },
        audiobookshelf: undefined,
        music: {
            musicPath: "/music",
            transcodeCachePath: "/tmp/soundspan-cache",
            transcodeCacheMaxGb: 1,
        },
        generationDiversity: {
            weightAlpha: 0.5,
            shareCeiling: 0.3,
        },
    },
}));

jest.mock("../../services/federationStreamProxy", () => ({
    proxyFederatedTrackStream: (...args: unknown[]) =>
        mockProxyFederatedTrackStream(...args),
}));
jest.mock("../../services/federationCoverProxy", () => ({
    proxyFederatedCover: (...args: unknown[]) =>
        mockProxyFederatedCover(...args),
}));
jest.mock("../../services/peerPlaybackFallback", () => ({
    loadPeerPlaybackFallback: (...args: unknown[]) =>
        mockLoadPeerPlaybackFallback(...args),
}));
jest.mock("../../services/mappedProviderStream", () => ({
    serveMappedProviderStream: (...args: unknown[]) =>
        mockServeMappedProviderStream(...args),
    terminateCommittedStream: (...args: [Response]) =>
        mockTerminateCommittedStream(...args),
    mappedProviderResponseState: (res: Response) => ({
        headersSent: Boolean(res.headersSent),
        destroyed: Boolean(res.destroyed),
        writableEnded: Boolean(res.writableEnded),
    }),
    isMappedProviderResponseUnusable: (state: {
        headersSent: boolean;
        destroyed: boolean;
        writableEnded: boolean;
    }) => state.headersSent || state.destroyed || state.writableEnded,
}));
jest.mock("../youtubeMusic", () => ({
    getUserIdOrPublic: (...args: unknown[]) =>
        mockGetYtMusicUserIdOrPublic(...args),
}));

jest.mock("../../workers/queues", () => ({
    scanQueue: {
        add: jest.fn(),
        getJob: jest.fn(),
        getJobs: jest.fn(),
        client: {
            set: jest.fn(),
            eval: jest.fn(),
        },
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
    },
}));

jest.mock("../../services/imageProvider", () => ({
    imageProviderService: {
        getAlbumCover: jest.fn(),
    },
}));

jest.mock("../../services/musicbrainz", () => ({
    isValidMbid: (value: unknown) =>
        typeof value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            value,
        ),
    musicBrainzService: {
        searchArtist: jest.fn(),
        getReleaseGroups: jest.fn(),
    },
}));

jest.mock("../../utils/musicIds", () => ({
    isRealArtistMbid: (value: unknown) =>
        typeof value === "string" && !value.startsWith("temp-"),
    rgMbidKind: (value: string) =>
        value.startsWith("federation:")
            ? "federation"
            : value.startsWith("remote:")
              ? "remote"
              : value.startsWith("temp-")
                ? "temp"
                : "musicbrainz",
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

const mockResolveArtistImage = jest.fn();
jest.mock("../../services/metadata/artistImageResolver", () => ({
    resolveArtistImage: mockResolveArtistImage,
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
    ...jest.requireActual("../../services/imageProxy"),
    fetchExternalImage: jest.fn(),
    normalizeExternalImageUrl: jest.fn(() => null),
}));

jest.mock("../../services/imageStorage", () => ({
    downloadAndStoreImage: jest.fn(),
}));

jest.mock("../../services/searchCacheVersion", () => ({
    bumpSearchCacheVersion: mockBumpSearchCacheVersion,
}));

const mockPersistCatalogReleaseGroups = jest.fn();
jest.mock("../../services/metadata/catalogPersistence", () => ({
    findFreshCatalogAlbum: jest.fn(async () => null),
    findFreshCatalogReleaseGroups: jest.fn(async () => null),
    logCatalogPersistenceError: jest.fn(),
    persistCatalogReleaseGroups: mockPersistCatalogReleaseGroups,
    persistCatalogTracklist: jest.fn(async () => undefined),
    readFreshCatalogReleaseGroups: jest.fn(() => null),
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
import { flattenLibraryRouteLayers } from "./libraryRouteTestUtils";
import { errorHandler } from "../../middleware/errorHandler";
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
import { downloadAndStoreImage } from "../../services/imageStorage";
import { extractColorsFromImage } from "../../utils/colorExtractor";
import { getSystemSettings } from "../../utils/systemSettings";
import { dataCacheService } from "../../services/dataCache";
import { lastFmService } from "../../services/lastfm";
import { deezerService } from "../../services/deezer";
import { imageProviderService } from "../../services/imageProvider";
import { musicBrainzService } from "../../services/musicbrainz";
import { nativeCoverHealInFlight } from "../../services/nativeCoverHealing";
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
const mockLikedTrackFindUnique = prisma.likedTrack.findUnique as jest.Mock;
const mockLikedTrackFindMany = prisma.likedTrack.findMany as jest.Mock;
const mockLikedTrackCount = prisma.likedTrack.count as jest.Mock;
const mockLikedTrackUpsert = prisma.likedTrack.upsert as jest.Mock;
const mockLikedTrackCreateMany = prisma.likedTrack.createMany as jest.Mock;
const mockLikedTrackDeleteMany = prisma.likedTrack.deleteMany as jest.Mock;
const mockDislikedEntityFindUnique = prisma.dislikedEntity
    .findUnique as jest.Mock;
const mockDislikedEntityFindMany = prisma.dislikedEntity.findMany as jest.Mock;
const mockDislikedEntityUpsert = prisma.dislikedEntity.upsert as jest.Mock;
const mockDislikedEntityCreateMany = prisma.dislikedEntity
    .createMany as jest.Mock;
const mockDislikedEntityDeleteMany = prisma.dislikedEntity
    .deleteMany as jest.Mock;
const mockRemoteLikedTrackFindMany = (prisma as any).likedRemoteTrack
    .findMany as jest.Mock;
const mockRemoteLikedTrackCount = (prisma as any).likedRemoteTrack
    .count as jest.Mock;
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSetEx = redisClient.setEx as jest.Mock;
const mockPlayFindFirst = prisma.play.findFirst as jest.Mock;
const mockPlayCreate = prisma.play.create as jest.Mock;
const mockPlayFindMany = prisma.play.findMany as jest.Mock;
const mockPlayGroupBy = prisma.play.groupBy as jest.Mock;
const mockTrackMappingFindMany = (prisma as any).trackMapping
    .findMany as jest.Mock;
const mockFederationPeerFindUnique = (prisma as any).federationPeer
    .findUnique as jest.Mock;
const mockUserSettingsFindUnique = prisma.userSettings.findUnique as jest.Mock;
const mockArtistFindMany = prisma.artist.findMany as jest.Mock;
const mockArtistFindUnique = prisma.artist.findUnique as jest.Mock;
const mockArtistFindFirst = prisma.artist.findFirst as jest.Mock;
const mockArtistCount = prisma.artist.count as jest.Mock;
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
const mockAlbumUpdateMany = prisma.album.updateMany as jest.Mock;
const mockAudiobookProgressFindMany = prisma.audiobookProgress
    .findMany as jest.Mock;
const mockPodcastProgressFindMany = prisma.podcastProgress
    .findMany as jest.Mock;
const mockOwnedAlbumGroupBy = prisma.ownedAlbum.groupBy as jest.Mock;
const mockOwnedAlbumFindMany = prisma.ownedAlbum.findMany as jest.Mock;
const mockOwnedAlbumFindUnique = prisma.ownedAlbum.findUnique as jest.Mock;
const mockOwnedAlbumDeleteMany = prisma.ownedAlbum.deleteMany as jest.Mock;
const mockGenreFindMany = prisma.genre.findMany as jest.Mock;
const mockSimilarArtistFindMany = prisma.similarArtist.findMany as jest.Mock;
const mockSimilarArtistDeleteMany = prisma.similarArtist
    .deleteMany as jest.Mock;
const mockPrismaTransaction = prisma.$transaction as jest.Mock;
const mockPrismaQueryRaw = prisma.$queryRaw as jest.Mock;
const mockPrismaExecuteRaw = prisma.$executeRaw as jest.Mock;
const mockScanQueueAdd = scanQueue.add as jest.Mock;
const mockScanQueueGetJob = scanQueue.getJob as jest.Mock;
const mockScanQueueGetJobs = scanQueue.getJobs as jest.Mock;
const mockScanQueueClientSet = scanQueue.client.set as jest.Mock;
const mockScanQueueClientEval = scanQueue.client.eval as jest.Mock;
const mockOrganizeSingles = organizeSingles as jest.Mock;
const mockLoggerInfo = logger.info as jest.Mock;
const mockLoggerError = logger.error as jest.Mock;
const mockLoggerWarn = logger.warn as jest.Mock;
const mockLoggerDebug = logger.debug as jest.Mock;
const mockAudioStreamingCtor = AudioStreamingService as unknown as jest.Mock;
const mockCoverArtGetCoverArt = coverArtService.getCoverArt as jest.Mock;
const mockCoverArtClearNotFoundCache =
    coverArtService.clearNotFoundCache as jest.Mock;
const mockFetchExternalImage = fetchExternalImage as jest.Mock;
const mockNormalizeExternalImageUrl = normalizeExternalImageUrl as jest.Mock;
const mockDownloadAndStoreImage = downloadAndStoreImage as jest.Mock;
const mockExtractColorsFromImage = extractColorsFromImage as jest.Mock;
const mockGetSystemSettings = getSystemSettings as jest.Mock;
const mockGetArtistImagesBatch =
    dataCacheService.getArtistImagesBatch as jest.Mock;
const mockGetArtistImage = dataCacheService.getArtistImage as jest.Mock;
const mockLastFmGetArtistTopTracks =
    lastFmService.getArtistTopTracks as jest.Mock;
const mockLastFmGetSimilarArtists =
    lastFmService.getSimilarArtists as jest.Mock;
const mockImageProviderGetAlbumCover =
    imageProviderService.getAlbumCover as jest.Mock;
const mockMusicBrainzSearchArtist =
    musicBrainzService.searchArtist as jest.Mock;
const mockMusicBrainzGetReleaseGroups =
    musicBrainzService.getReleaseGroups as jest.Mock;
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
    stackIndex = 0,
) {
    const layer = flattenLibraryRouteLayers(router).find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer) {
        throw new Error(`Route not found: [${method}] ${path}`);
    }
    return layer.route.stack[stackIndex].handle;
}

function getFinalHandler(
    method: "get" | "post" | "delete" | "put" | "patch",
    path: string,
) {
    const layer = flattenLibraryRouteLayers(router).find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer) {
        throw new Error(`Route not found: [${method}] ${path}`);
    }
    return layer.route.stack[layer.route.stack.length - 1].handle;
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

/**
 * Invokes a route handler the way Express does with `errorHandler` mounted
 * after the router (as index.ts wires it in production): awaits the handler,
 * and if it forwarded an error via next() (the asyncHandler path), runs the
 * real errorHandler to produce the final response. Also compatible with
 * hand-rolled try/catch handlers, which respond directly and never call
 * next(err).
 */
async function invokeWithErrorHandler(handler: any, req: any, res: any) {
    const next = jest.fn();
    await handler(req, res, next);
    const forwarded = next.mock.calls.find((call: any[]) => call[0] != null);
    if (forwarded) {
        errorHandler(forwarded[0], req, res, jest.fn());
    }
}

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
        loudnessLufs: null,
        truePeakDb: null,
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
            albumLoudnessLufs: null,
            albumTruePeakDb: null,
            artist: {
                id: `artist-${id}`,
                name: `Artist ${id}`,
            },
        },
        trackGenres: [],
        ...overrides,
    };
}

const visibleAlbumRelationWhere = {
    album: {
        location: {
            in: ["LIBRARY", "DISCOVER", "REMOTE", "FEDERATED"],
        },
    },
};

function expectBoundedRandomQuery(call: unknown[], limit: number) {
    const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join("?");
    expect(sql).toContain("ORDER BY random()");
    expect(sql).toContain("LIMIT");
    expect(values).toContain(limit);
}

function expectNoUnboundedIdPoolFetch() {
    expect(
        mockTrackFindMany.mock.calls.some(
            ([args]) =>
                args?.select?.id === true &&
                Object.keys(args.select).length === 1 &&
                args.take === undefined,
        ),
    ).toBe(false);
}

export {
    express,
    Request,
    Response,
    fs,
    request,
    mockStreamGetStreamFilePath,
    mockStreamWithRangeSupport,
    mockStreamDestroy,
    mockParseFile,
    mockLookup,
    mockProxyFederatedTrackStream,
    mockProxyFederatedCover,
    mockLoadPeerPlaybackFallback,
    mockServeMappedProviderStream,
    mockTerminateCommittedStream,
    mockGetYtMusicUserIdOrPublic,
    mockBumpSearchCacheVersion,
    mockResolveArtistImage,
    mockPersistCatalogReleaseGroups,
    mockLidarrDeleteArtist,
    router,
    flattenLibraryRouteLayers,
    errorHandler,
    config,
    prisma,
    redisClient,
    scanQueue,
    organizeSingles,
    logger,
    AudioStreamingService,
    coverArtService,
    fetchExternalImage,
    normalizeExternalImageUrl,
    downloadAndStoreImage,
    extractColorsFromImage,
    getSystemSettings,
    dataCacheService,
    lastFmService,
    deezerService,
    imageProviderService,
    musicBrainzService,
    nativeCoverHealInFlight,
    getMergedGenres,
    isBackfillNeeded,
    getBackfillProgress,
    isBackfillInProgress,
    backfillAllArtistCounts,
    isImageBackfillNeeded,
    getImageBackfillProgress,
    backfillAllImages,
    getDecadeFromYear,
    getDecadeWhereClause,
    getEffectiveYear,
    shuffleArray,
    mockTrackFindUnique,
    mockTrackFindMany,
    mockTrackCount,
    mockTrackDelete,
    mockTrackDeleteMany,
    mockLikedTrackFindUnique,
    mockLikedTrackFindMany,
    mockLikedTrackCount,
    mockLikedTrackUpsert,
    mockLikedTrackCreateMany,
    mockLikedTrackDeleteMany,
    mockDislikedEntityFindUnique,
    mockDislikedEntityFindMany,
    mockDislikedEntityUpsert,
    mockDislikedEntityCreateMany,
    mockDislikedEntityDeleteMany,
    mockRemoteLikedTrackFindMany,
    mockRemoteLikedTrackCount,
    mockRedisGet,
    mockRedisSetEx,
    mockPlayFindFirst,
    mockPlayCreate,
    mockPlayFindMany,
    mockPlayGroupBy,
    mockTrackMappingFindMany,
    mockFederationPeerFindUnique,
    mockUserSettingsFindUnique,
    mockArtistFindMany,
    mockArtistFindUnique,
    mockArtistFindFirst,
    mockArtistCount,
    mockArtistUpdateMany,
    mockArtistUpdate,
    mockArtistDeleteMany,
    mockArtistDelete,
    mockAlbumFindMany,
    mockAlbumGroupBy,
    mockAlbumCount,
    mockAlbumFindFirst,
    mockAlbumFindUnique,
    mockAlbumDelete,
    mockAlbumUpdate,
    mockAlbumUpdateMany,
    mockAudiobookProgressFindMany,
    mockPodcastProgressFindMany,
    mockOwnedAlbumGroupBy,
    mockOwnedAlbumFindMany,
    mockOwnedAlbumFindUnique,
    mockOwnedAlbumDeleteMany,
    mockGenreFindMany,
    mockSimilarArtistFindMany,
    mockSimilarArtistDeleteMany,
    mockPrismaTransaction,
    mockPrismaQueryRaw,
    mockPrismaExecuteRaw,
    mockScanQueueAdd,
    mockScanQueueGetJob,
    mockScanQueueGetJobs,
    mockScanQueueClientSet,
    mockScanQueueClientEval,
    mockOrganizeSingles,
    mockLoggerInfo,
    mockLoggerError,
    mockLoggerWarn,
    mockLoggerDebug,
    mockAudioStreamingCtor,
    mockCoverArtGetCoverArt,
    mockCoverArtClearNotFoundCache,
    mockFetchExternalImage,
    mockNormalizeExternalImageUrl,
    mockDownloadAndStoreImage,
    mockExtractColorsFromImage,
    mockGetSystemSettings,
    mockGetArtistImagesBatch,
    mockGetArtistImage,
    mockLastFmGetArtistTopTracks,
    mockLastFmGetSimilarArtists,
    mockImageProviderGetAlbumCover,
    mockMusicBrainzSearchArtist,
    mockMusicBrainzGetReleaseGroups,
    mockIsBackfillNeeded,
    mockGetBackfillProgress,
    mockIsBackfillInProgress,
    mockBackfillAllArtistCounts,
    mockIsImageBackfillNeeded,
    mockGetImageBackfillProgress,
    mockBackfillAllImages,
    mockGetDecadeFromYear,
    mockGetDecadeWhereClause,
    mockGetEffectiveYear,
    mockShuffleArray,
    mockGetMergedGenres,
    mockDeezerGetAlbumCover,
    getHandler,
    getFinalHandler,
    createRes,
    flushPromises,
    invokeWithErrorHandler,
    createNativeTrack,
    createRadioTrack,
    visibleAlbumRelationWhere,
    expectBoundedRandomQuery,
    expectNoUnboundedIdPoolFetch,
};
