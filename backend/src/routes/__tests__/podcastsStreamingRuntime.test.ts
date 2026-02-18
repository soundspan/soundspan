import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
    requireAuthOrToken: (_req: Request, _res: Response, next: () => void) =>
        next(),
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
    $connect: jest.fn(),
    podcast: {
        findUnique: jest.fn(),
    },
    podcastEpisode: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
    podcastProgress: {
        upsert: jest.fn(),
        deleteMany: jest.fn(),
    },
    podcastRecommendation: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
        createMany: jest.fn(),
    },
    track: {
        count: jest.fn(),
    },
    downloadJob: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
    },
    album: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
    },
    artist: {
        findUnique: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({
    prisma,
    Prisma: {
        PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
            code = "P2037";
        },
        PrismaClientRustPanicError: class PrismaClientRustPanicError extends Error {},
        PrismaClientUnknownRequestError: class PrismaClientUnknownRequestError extends Error {},
    },
}));

jest.mock("../../services/rss-parser", () => ({
    rssParserService: {
        parseFeed: jest.fn(async () => ({
            podcast: {
                title: "Mock Podcast",
                author: "Host",
                description: "Desc",
                imageUrl: "https://image/pod.jpg",
                language: "en",
                explicit: false,
            },
            episodes: [],
        })),
    },
}));

jest.mock("../../services/podcastCache", () => ({
    podcastCacheService: {
        syncAllCovers: jest.fn(async () => ({ synced: 0 })),
        syncEpisodeCovers: jest.fn(async () => ({ synced: 0 })),
    },
}));

const getCachedFilePath = jest.fn();
const isDownloading = jest.fn();
const getDownloadProgress = jest.fn();
const downloadInBackground = jest.fn();
jest.mock("../../services/podcastDownload", () => ({
    getCachedFilePath: (episodeId: string) => getCachedFilePath(episodeId),
    isDownloading: (episodeId: string) => isDownloading(episodeId),
    getDownloadProgress: (episodeId: string) => getDownloadProgress(episodeId),
    downloadInBackground: (
        episodeId: string,
        audioUrl: string,
        userId: string
    ) => downloadInBackground(episodeId, audioUrl, userId),
}));

const getSimilarPodcasts = jest.fn();
jest.mock("../../services/itunes", () => ({
    itunesService: {
        getSimilarPodcasts: (
            title: string,
            description?: string,
            author?: string
        ) => getSimilarPodcasts(title, description, author),
    },
}));

jest.mock("../../services/discoverWeekly", () => ({
    discoverWeeklyService: {
        checkBatchCompletion: jest.fn(async () => undefined),
        buildFinalPlaylist: jest.fn(async () => undefined),
        reconcileDiscoveryTracks: jest.fn(async () => ({
            tracksAdded: 0,
            batchesChecked: 0,
        })),
    },
}));

jest.mock("../../services/spotifyImport", () => ({
    spotifyImportService: {
        reconcilePendingTracks: jest.fn(async () => ({
            tracksAdded: 0,
            playlistsUpdated: 0,
        })),
        buildPlaylistAfterScan: jest.fn(async () => undefined),
    },
}));

jest.mock("../../services/notificationService", () => ({
    notificationService: {
        notifySystem: jest.fn(async () => undefined),
    },
}));

jest.mock("../../workers/unifiedEnrichment", () => ({
    triggerEnrichmentNow: jest.fn(async () => ({ tracks: 0 })),
}));

jest.mock("../../workers/artistEnrichment", () => ({
    enrichSimilarArtist: jest.fn(async () => undefined),
}));

const mockParseRangeHeader = jest.fn();
jest.mock("../../utils/rangeParser", () => ({
    parseRangeHeader: (...args: any[]) => mockParseRangeHeader(...args),
}));

const mockAxiosGet = jest.fn();
const mockAxiosHead = jest.fn();
const mockAxiosIsCancel = jest.fn();
const mockAxiosIsAxiosError = jest.fn();
jest.mock("axios", () => ({
    __esModule: true,
    default: {
        get: (...args: any[]) => mockAxiosGet(...args),
        head: (...args: any[]) => mockAxiosHead(...args),
        isCancel: (error: any) => mockAxiosIsCancel(error),
        isAxiosError: (error: any) => mockAxiosIsAxiosError(error),
    },
}));

const mockFsStat = jest.fn();
const mockCreateReadStream = jest.fn();
jest.mock("fs", () => ({
    __esModule: true,
    default: {
        promises: {
            stat: (...args: any[]) => mockFsStat(...args),
        },
        createReadStream: (...args: any[]) => mockCreateReadStream(...args),
    },
    promises: {
        stat: (...args: any[]) => mockFsStat(...args),
    },
    createReadStream: (...args: any[]) => mockCreateReadStream(...args),
}));

import router from "../podcasts";

function getHandler(
    path: string,
    method: "get" | "post" | "delete" | "options"
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );
    if (!layer) throw new Error(`${method.toUpperCase()} route not found: ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const headers: Record<string, any> = {};
    const closeHandlers: Array<() => void> = [];
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        headers,
        headersSent: false,
        writableEnded: false,
        closeHandlers,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            res.headersSent = true;
            return res;
        }),
        setHeader: jest.fn(function (key: string, value: any) {
            headers[key] = value;
            return res;
        }),
        set: jest.fn(function (obj: Record<string, any>) {
            for (const [k, v] of Object.entries(obj)) {
                headers[k] = v;
            }
            return res;
        }),
        writeHead: jest.fn(function (code: number, outHeaders?: Record<string, any>) {
            res.statusCode = code;
            if (outHeaders) {
                for (const [k, v] of Object.entries(outHeaders)) {
                    headers[k] = v;
                }
            }
            return res;
        }),
        sendFile: jest.fn(function (filePath: string) {
            res.sentFile = filePath;
            res.headersSent = true;
            return res;
        }),
        redirect: jest.fn(function (url: string) {
            res.redirectedTo = url;
            res.headersSent = true;
            return res;
        }),
        end: jest.fn(function () {
            res.writableEnded = true;
            res.headersSent = true;
            return res;
        }),
        on: jest.fn(function (event: string, cb: () => void) {
            if (event === "close") closeHandlers.push(cb);
            return res;
        }),
    };
    return res;
}

function createStream() {
    const stream: any = {
        destroyed: false,
        on: jest.fn(),
        pipe: jest.fn(),
        destroy: jest.fn(function () {
            stream.destroyed = true;
        }),
    };
    stream.on.mockImplementation(() => stream);
    return stream;
}

describe("podcasts streaming/runtime behavior", () => {
    const cacheStatusHandler = getHandler(
        "/:podcastId/episodes/:episodeId/cache-status",
        "get"
    );
    const streamHandler = getHandler("/:podcastId/episodes/:episodeId/stream", "get");
    const progressHandler = getHandler(
        "/:podcastId/episodes/:episodeId/progress",
        "post"
    );
    const clearProgressHandler = getHandler(
        "/:podcastId/episodes/:episodeId/progress",
        "delete"
    );
    const similarHandler = getHandler("/:id/similar", "get");
    const podcastCoverOptionsHandler = getHandler("/:id/cover", "options");
    const coverHandler = getHandler("/:id/cover", "get");
    const episodeCoverOptionsHandler = getHandler(
        "/episodes/:episodeId/cover",
        "options"
    );
    const episodeCoverHandler = getHandler("/episodes/:episodeId/cover", "get");

    beforeEach(() => {
        jest.clearAllMocks();

        prisma.$connect.mockResolvedValue(undefined);
        prisma.podcast.findUnique.mockResolvedValue(null);
        prisma.podcastEpisode.findUnique.mockResolvedValue(null);
        prisma.podcastEpisode.update.mockResolvedValue({});
        prisma.podcastProgress.upsert.mockResolvedValue({
            currentTime: 30,
            duration: 60,
            isFinished: false,
        });
        prisma.podcastProgress.deleteMany.mockResolvedValue({ count: 1 });
        prisma.podcastRecommendation.findMany.mockResolvedValue([]);
        prisma.podcastRecommendation.deleteMany.mockResolvedValue({ count: 0 });
        prisma.podcastRecommendation.createMany.mockResolvedValue({ count: 0 });
        prisma.track.count.mockResolvedValue(0);
        prisma.downloadJob.findMany.mockResolvedValue([]);
        prisma.downloadJob.updateMany.mockResolvedValue({ count: 0 });
        prisma.album.findMany.mockResolvedValue([]);
        prisma.album.findFirst.mockResolvedValue(null);
        prisma.artist.findUnique.mockResolvedValue(null);

        getCachedFilePath.mockResolvedValue(null);
        isDownloading.mockReturnValue(false);
        getDownloadProgress.mockReturnValue(null);
        downloadInBackground.mockImplementation(() => undefined);

        getSimilarPodcasts.mockResolvedValue([]);

        mockParseRangeHeader.mockReturnValue({ ok: true, start: 0, end: 99 });
        mockAxiosGet.mockReset();
        mockAxiosHead.mockReset();
        mockAxiosIsCancel.mockReturnValue(false);
        mockAxiosIsAxiosError.mockReturnValue(false);
        mockFsStat.mockResolvedValue({ size: 1000 });
        mockCreateReadStream.mockReset();
    });

    it("returns cache status data and handles cache-status failures", async () => {
        getCachedFilePath.mockResolvedValueOnce("/cache/episode.mp3");
        isDownloading.mockReturnValueOnce(true);
        getDownloadProgress.mockReturnValueOnce({ progress: 42 });

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-1" },
        } as any;
        const res = createRes();
        await cacheStatusHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            episodeId: "ep-1",
            cached: true,
            downloading: true,
            downloadProgress: 42,
            path: true,
        });

        getCachedFilePath.mockRejectedValueOnce(new Error("cache lookup failed"));
        const errRes = createRes();
        await cacheStatusHandler(req, errRes);
        expect(errRes.statusCode).toBe(500);
        expect(errRes.body).toEqual({ error: "Failed to check cache status" });
    });

    it("returns 404 for stream requests when episode does not exist", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce(null);

        const req = {
            params: { podcastId: "pod-1", episodeId: "missing" },
            user: { id: "user-1" },
            headers: {},
        } as any;
        const res = createRes();

        await streamHandler(req, res);
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Episode not found" });
    });

    it("streams cached episode ranges with proper 206 headers", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            id: "ep-1",
            title: "Episode One",
            guid: "guid-1",
            audioUrl: "https://audio/ep-1.mp3",
            mimeType: "audio/mpeg",
            fileSize: 1000,
        });
        getCachedFilePath.mockResolvedValueOnce("/cache/ep-1.mp3");
        mockParseRangeHeader.mockReturnValueOnce({ ok: true, start: 0, end: 99 });

        const fileStream = createStream();
        mockCreateReadStream.mockReturnValueOnce(fileStream);

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-1" },
            user: { id: "user-1" },
            headers: { range: "bytes=0-99", origin: "https://app.test" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(mockParseRangeHeader).toHaveBeenCalledWith("bytes=0-99", 1000);
        expect(res.statusCode).toBe(206);
        expect(res.headers["Content-Range"]).toBe("bytes 0-99/1000");
        expect(mockCreateReadStream).toHaveBeenCalledWith("/cache/ep-1.mp3", {
            start: 0,
            end: 99,
        });
        expect(fileStream.pipe).toHaveBeenCalledWith(res);

        for (const closeHandler of res.closeHandlers) {
            closeHandler();
        }
        expect(fileStream.destroy).toHaveBeenCalled();
    });

    it("clamps invalid cached range requests to a tail window", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            id: "ep-clamp",
            title: "Episode Clamp",
            guid: "guid-clamp",
            audioUrl: "https://audio/ep-clamp.mp3",
            mimeType: "audio/mpeg",
            fileSize: 2097152,
        });
        getCachedFilePath.mockResolvedValueOnce("/cache/ep-clamp.mp3");
        mockFsStat.mockResolvedValueOnce({ size: 2097152 });
        mockParseRangeHeader.mockReturnValueOnce({ ok: false });

        const fileStream = createStream();
        mockCreateReadStream.mockReturnValueOnce(fileStream);

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-clamp" },
            user: { id: "user-1" },
            headers: { range: "bytes=invalid", origin: "https://app.test" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(mockCreateReadStream).toHaveBeenCalledWith("/cache/ep-clamp.mp3", {
            start: 1048576,
            end: 2097151,
        });
        expect(res.statusCode).toBe(206);
        expect(res.headers["Content-Range"]).toBe("bytes 1048576-2097151/2097152");
        expect(fileStream.pipe).toHaveBeenCalledWith(res);
    });

    it("returns 500 when cached range stream errors before headers are sent", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            id: "ep-cache-err",
            title: "Episode Cache Error",
            guid: "guid-cache-err",
            audioUrl: "https://audio/ep-cache-err.mp3",
            mimeType: "audio/mpeg",
            fileSize: 1000,
        });
        getCachedFilePath.mockResolvedValueOnce("/cache/ep-cache-err.mp3");
        mockParseRangeHeader.mockReturnValueOnce({ ok: true, start: 0, end: 99 });
        mockFsStat.mockResolvedValueOnce({ size: 1000 });

        const fileStream = createStream();
        mockCreateReadStream.mockReturnValueOnce(fileStream);

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-cache-err" },
            user: { id: "user-1" },
            headers: { range: "bytes=0-99" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        const cacheErrorHandler = fileStream.on.mock.calls.find(
            ([event]: [string]) => event === "error"
        )?.[1];
        expect(cacheErrorHandler).toBeDefined();
        cacheErrorHandler(new Error("cache read failed"));

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to stream episode" });
    });

    it("streams cached full-file requests and ends on post-header cache errors", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            id: "ep-cache-full",
            title: "Episode Cache Full",
            guid: "guid-cache-full",
            audioUrl: "https://audio/ep-cache-full.mp3",
            mimeType: "audio/mpeg",
            fileSize: 1200,
        });
        getCachedFilePath.mockResolvedValueOnce("/cache/ep-cache-full.mp3");
        mockFsStat.mockResolvedValueOnce({ size: 1200 });

        const fileStream = createStream();
        mockCreateReadStream.mockReturnValueOnce(fileStream);

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-cache-full" },
            user: { id: "user-1" },
            headers: { origin: "https://app.test" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.headers["Content-Length"]).toBe(1200);
        expect(fileStream.pipe).toHaveBeenCalledWith(res);

        res.headersSent = true;
        const cacheErrorHandler = fileStream.on.mock.calls.find(
            ([event]: [string]) => event === "error"
        )?.[1];
        expect(cacheErrorHandler).toBeDefined();
        cacheErrorHandler(new Error("stream broke after headers"));
        expect(res.end).toHaveBeenCalled();

        for (const closeHandler of res.closeHandlers) {
            closeHandler();
        }
        expect(fileStream.destroy).toHaveBeenCalled();
    });

    it("returns 500 when cached full-file streams fail before headers are sent", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            id: "ep-cache-full-err",
            title: "Episode Cache Full Error",
            guid: "guid-cache-full-err",
            audioUrl: "https://audio/ep-cache-full-err.mp3",
            mimeType: "audio/mpeg",
            fileSize: 1200,
        });
        getCachedFilePath.mockResolvedValueOnce("/cache/ep-cache-full-err.mp3");
        mockFsStat.mockResolvedValueOnce({ size: 1200 });

        const fileStream = createStream();
        mockCreateReadStream.mockReturnValueOnce(fileStream);

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-cache-full-err" },
            user: { id: "user-1" },
            headers: {},
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        const cacheErrorHandler = fileStream.on.mock.calls.find(
            ([event]: [string]) => event === "error"
        )?.[1];
        expect(cacheErrorHandler).toBeDefined();
        cacheErrorHandler(new Error("cache full-file error"));

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Failed to stream episode" });
    });

    it("ends ranged cached streams when errors occur after headers are sent", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            id: "ep-cache-range-end",
            title: "Episode Cache Range End",
            guid: "guid-cache-range-end",
            audioUrl: "https://audio/ep-cache-range-end.mp3",
            mimeType: "audio/mpeg",
            fileSize: 1000,
        });
        getCachedFilePath.mockResolvedValueOnce("/cache/ep-cache-range-end.mp3");
        mockParseRangeHeader.mockReturnValueOnce({ ok: true, start: 0, end: 99 });
        mockFsStat.mockResolvedValueOnce({ size: 1000 });

        const fileStream = createStream();
        mockCreateReadStream.mockReturnValueOnce(fileStream);

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-cache-range-end" },
            user: { id: "user-1" },
            headers: { range: "bytes=0-99" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        res.headersSent = true;
        const cacheErrorHandler = fileStream.on.mock.calls.find(
            ([event]: [string]) => event === "error"
        )?.[1];
        expect(cacheErrorHandler).toBeDefined();
        cacheErrorHandler(new Error("cache range post-header error"));
        expect(res.end).toHaveBeenCalled();
    });

    it("emits stream debug diagnostics when podcast debug mode is enabled", async () => {
        const originalDebug = process.env.PODCAST_DEBUG;
        process.env.PODCAST_DEBUG = "1";

        try {
            prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
                id: "ep-debug",
                title: "Episode Debug",
                guid: "guid-debug",
                audioUrl: "https://audio/ep-debug.mp3",
                mimeType: null,
                fileSize: null,
            });
            getCachedFilePath.mockResolvedValueOnce("/cache/ep-debug.mp3");
            mockFsStat.mockResolvedValueOnce({ size: 2048 });
            mockParseRangeHeader.mockReturnValueOnce({
                ok: true,
                start: 0,
                end: 127,
            });

            const fileStream = createStream();
            mockCreateReadStream.mockReturnValueOnce(fileStream);

            const req = {
                params: { podcastId: "pod-1", episodeId: "ep-debug" },
                user: { id: "user-1" },
                headers: {
                    range: "bytes=0-127",
                    "user-agent": "jest-agent",
                },
            } as any;
            const res = createRes();

            await streamHandler(req, res);

            expect(res.statusCode).toBe(206);
            expect(fileStream.pipe).toHaveBeenCalledWith(res);
        } finally {
            if (typeof originalDebug === "undefined") {
                delete process.env.PODCAST_DEBUG;
            } else {
                process.env.PODCAST_DEBUG = originalDebug;
            }
        }
    });

    it("falls back to RSS streaming when cached file is empty", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            id: "ep-cache-empty",
            title: "Episode Cache Empty",
            guid: "guid-cache-empty",
            audioUrl: "https://audio/ep-cache-empty.mp3",
            mimeType: "audio/mpeg",
            fileSize: 3000,
        });
        getCachedFilePath.mockResolvedValueOnce("/cache/ep-cache-empty.mp3");
        mockFsStat.mockResolvedValueOnce({ size: 0 });

        const upstream = createStream();
        mockAxiosGet.mockResolvedValueOnce({
            data: upstream,
            headers: { "content-length": "3000" },
        });

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-cache-empty" },
            user: { id: "user-1" },
            headers: {},
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        expect(upstream.pipe).toHaveBeenCalledWith(res);
        expect(res.statusCode).toBe(200);
    });

    it("streams from rss and triggers background caching when uncached", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            id: "ep-2",
            title: "Episode Two",
            guid: "guid-2",
            audioUrl: "https://audio/ep-2.mp3",
            mimeType: "audio/mpeg",
            fileSize: null,
        });
        getCachedFilePath.mockResolvedValueOnce(null);
        isDownloading.mockReturnValueOnce(false);
        mockAxiosHead.mockResolvedValueOnce({ headers: { "content-length": "12345" } });

        const upstream = createStream();
        mockAxiosGet.mockResolvedValueOnce({
            data: upstream,
            headers: { "content-length": "12345" },
        });

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-2" },
            user: { id: "user-99" },
            headers: { origin: "https://app.test" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(downloadInBackground).toHaveBeenCalledWith(
            "ep-2",
            "https://audio/ep-2.mp3",
            "user-99"
        );
        expect(prisma.podcastEpisode.update).toHaveBeenCalledWith({
            where: { id: "ep-2" },
            data: { fileSize: 12345 },
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers["Content-Type"]).toBe("audio/mpeg");
        const getCallOptions = mockAxiosGet.mock.calls[0]?.[1] as
            | Record<string, any>
            | undefined;
        expect(getCallOptions?.signal).toBeDefined();
        expect(upstream.pipe).toHaveBeenCalledWith(res);

        const streamErrorHandler = upstream.on.mock.calls.find(
            ([event]: [string]) => event === "error"
        )?.[1];
        expect(streamErrorHandler).toBeDefined();
        streamErrorHandler(
            Object.assign(new Error("rss full stream error"), { code: "EIO" })
        );
        expect(res.end).toHaveBeenCalled();

        for (const closeHandler of res.closeHandlers) {
            closeHandler();
        }
        expect(upstream.destroy).toHaveBeenCalled();
    });

    it("returns 500 when uncached full-file stream fails before headers", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            id: "ep-norange-fail",
            title: "Episode NoRange Fail",
            guid: "guid-norange-fail",
            audioUrl: "https://audio/ep-norange-fail.mp3",
            mimeType: "audio/mpeg",
            fileSize: null,
        });
        getCachedFilePath.mockResolvedValueOnce(null);
        mockAxiosHead.mockRejectedValueOnce(new Error("head failed"));
        mockAxiosGet.mockRejectedValueOnce(new Error("rss stream failed"));

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-norange-fail" },
            user: { id: "user-1" },
            headers: {},
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(mockAxiosHead).toHaveBeenCalledWith("https://audio/ep-norange-fail.mp3");
        expect(downloadInBackground).toHaveBeenCalledWith(
            "ep-norange-fail",
            "https://audio/ep-norange-fail.mp3",
            "user-1"
        );
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to stream episode",
            message: "rss stream failed",
        });
    });

    it("continues RSS streaming when HEAD lookup fails", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            id: "ep-head-fail",
            title: "Episode Head Fail",
            guid: "guid-head-fail",
            audioUrl: "https://audio/ep-head-fail.mp3",
            mimeType: "audio/mpeg",
            fileSize: null,
        });
        getCachedFilePath.mockResolvedValueOnce(null);
        mockAxiosHead.mockRejectedValueOnce(new Error("head failed"));

        const upstream = createStream();
        mockAxiosGet.mockResolvedValueOnce({
            data: upstream,
            headers: {},
        });

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-head-fail" },
            user: { id: "user-2" },
            headers: {},
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(mockAxiosHead).toHaveBeenCalledWith("https://audio/ep-head-fail.mp3");
        expect(mockAxiosGet).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(200);
        expect(upstream.pipe).toHaveBeenCalledWith(res);
    });

    it("returns 416 for invalid uncached range requests", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            id: "ep-invalid-range",
            title: "Episode Invalid Range",
            guid: "guid-invalid-range",
            audioUrl: "https://audio/ep-invalid-range.mp3",
            mimeType: "audio/mpeg",
            fileSize: 5000,
        });
        getCachedFilePath.mockResolvedValueOnce(null);
        mockParseRangeHeader.mockReturnValueOnce({ ok: false });

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-invalid-range" },
            user: { id: "user-1" },
            headers: { range: "bytes=999999-1000000" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.statusCode).toBe(416);
        expect(res.headers["Content-Range"]).toBe("bytes */5000");
        expect(res.end).toHaveBeenCalled();
        expect(mockAxiosGet).not.toHaveBeenCalled();
    });

    it("streams uncached range requests with 206 when upstream supports ranges", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            id: "ep-rss-range-206",
            title: "Episode RSS Range 206",
            guid: "guid-rss-range-206",
            audioUrl: "https://audio/ep-rss-range-206.mp3",
            mimeType: "audio/mpeg",
            fileSize: 4000,
        });
        getCachedFilePath.mockResolvedValueOnce(null);
        mockParseRangeHeader.mockReturnValueOnce({ ok: true, start: 100, end: 199 });

        const upstream = createStream();
        mockAxiosGet.mockResolvedValueOnce({
            status: 206,
            data: upstream,
            headers: { "content-length": "100" },
        });

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-rss-range-206" },
            user: { id: "user-1" },
            headers: { range: "bytes=100-199", origin: "https://app.test" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        const rangedCallOptions = mockAxiosGet.mock.calls[0]?.[1] as
            | Record<string, any>
            | undefined;
        expect(rangedCallOptions?.validateStatus(206)).toBe(true);
        expect(rangedCallOptions?.validateStatus(500)).toBe(false);

        expect(res.statusCode).toBe(206);
        expect(res.headers["Content-Range"]).toBe("bytes 100-199/4000");
        expect(upstream.pipe).toHaveBeenCalledWith(res);

        const streamErrorHandler = upstream.on.mock.calls.find(
            ([event]: [string]) => event === "error"
        )?.[1];
        expect(streamErrorHandler).toBeDefined();
        streamErrorHandler(Object.assign(new Error("rss error"), { code: "EPIPE" }));
        expect(res.end).toHaveBeenCalled();

        for (const closeHandler of res.closeHandlers) {
            closeHandler();
        }
        expect(upstream.destroy).toHaveBeenCalled();
    });

    it("streams uncached range requests with 200 when upstream ignores range", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            id: "ep-rss-range-200",
            title: "Episode RSS Range 200",
            guid: "guid-rss-range-200",
            audioUrl: "https://audio/ep-rss-range-200.mp3",
            mimeType: "audio/mpeg",
            fileSize: 4000,
        });
        getCachedFilePath.mockResolvedValueOnce(null);
        mockParseRangeHeader.mockReturnValueOnce({ ok: true, start: 0, end: 99 });

        const upstream = createStream();
        mockAxiosGet.mockResolvedValueOnce({
            status: 200,
            data: upstream,
            headers: {},
        });

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-rss-range-200" },
            user: { id: "user-1" },
            headers: { range: "bytes=0-99", origin: "https://app.test" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.headers["Content-Length"]).toBe(4000);
        expect(upstream.pipe).toHaveBeenCalledWith(res);
    });

    it("falls back to full RSS stream when ranged RSS request fails", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            id: "ep-rss-range-fallback",
            title: "Episode RSS Range Fallback",
            guid: "guid-rss-range-fallback",
            audioUrl: "https://audio/ep-rss-range-fallback.mp3",
            mimeType: "audio/mpeg",
            fileSize: 4000,
        });
        getCachedFilePath.mockResolvedValueOnce(null);
        mockParseRangeHeader.mockReturnValueOnce({ ok: true, start: 50, end: 149 });

        const rangeError: any = new Error("range unsupported");
        rangeError.response = { status: 416 };
        const fallbackStream = createStream();
        mockAxiosGet
            .mockRejectedValueOnce(rangeError)
            .mockResolvedValueOnce({
                data: fallbackStream,
                headers: {},
            });

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-rss-range-fallback" },
            user: { id: "user-1" },
            headers: { range: "bytes=50-149", origin: "https://app.test" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(mockAxiosGet).toHaveBeenNthCalledWith(
            1,
            "https://audio/ep-rss-range-fallback.mp3",
            expect.objectContaining({
                headers: { Range: "bytes=50-149" },
                responseType: "stream",
            })
        );
        expect(mockAxiosGet).toHaveBeenNthCalledWith(
            2,
            "https://audio/ep-rss-range-fallback.mp3",
            expect.objectContaining({
                responseType: "stream",
            })
        );
        expect(res.statusCode).toBe(200);
        expect(res.headers["Content-Length"]).toBeUndefined();
        expect(fallbackStream.pipe).toHaveBeenCalledWith(res);

        const fallbackErrorHandler = fallbackStream.on.mock.calls.find(
            ([event]: [string]) => event === "error"
        )?.[1];
        expect(fallbackErrorHandler).toBeDefined();
        fallbackErrorHandler(Object.assign(new Error("fallback error"), { code: "EIO" }));
        expect(res.end).toHaveBeenCalled();

        for (const closeHandler of res.closeHandlers) {
            closeHandler();
        }
        expect(fallbackStream.destroy).toHaveBeenCalled();
    });

    it("returns early when ranged RSS request is canceled by the client", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            id: "ep-rss-range-cancel",
            title: "Episode RSS Range Cancel",
            guid: "guid-rss-range-cancel",
            audioUrl: "https://audio/ep-rss-range-cancel.mp3",
            mimeType: "audio/mpeg",
            fileSize: 4000,
        });
        getCachedFilePath.mockResolvedValueOnce(null);
        mockParseRangeHeader.mockReturnValueOnce({ ok: true, start: 0, end: 99 });
        const cancelError = new Error("request canceled");
        mockAxiosGet.mockRejectedValueOnce(cancelError);
        mockAxiosIsCancel.mockImplementation((error: unknown) => error === cancelError);

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-rss-range-cancel" },
            user: { id: "user-1" },
            headers: { range: "bytes=0-99" },
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.writeHead).not.toHaveBeenCalled();
        expect(res.end).not.toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalledWith(500);
    });

    it("returns early when full RSS request is canceled by the client", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            id: "ep-rss-full-cancel",
            title: "Episode RSS Full Cancel",
            guid: "guid-rss-full-cancel",
            audioUrl: "https://audio/ep-rss-full-cancel.mp3",
            mimeType: "audio/mpeg",
            fileSize: 4000,
        });
        getCachedFilePath.mockResolvedValueOnce(null);
        const cancelError = new Error("request canceled");
        mockAxiosGet.mockRejectedValueOnce(cancelError);
        mockAxiosIsCancel.mockImplementation((error: unknown) => error === cancelError);

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-rss-full-cancel" },
            user: { id: "user-1" },
            headers: {},
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.writeHead).not.toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalledWith(500);
    });

    it("returns 500 when full RSS stream fails unexpectedly", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            id: "ep-rss-full-fail",
            title: "Episode RSS Full Fail",
            guid: "guid-rss-full-fail",
            audioUrl: "https://audio/ep-rss-full-fail.mp3",
            mimeType: "audio/mpeg",
            fileSize: 4000,
        });
        getCachedFilePath.mockResolvedValueOnce(null);
        mockAxiosGet.mockRejectedValueOnce(new Error("rss full request failed"));
        mockAxiosIsCancel.mockReturnValue(false);

        const req = {
            params: { podcastId: "pod-1", episodeId: "ep-rss-full-fail" },
            user: { id: "user-1" },
            headers: {},
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to stream episode",
            message: "rss full request failed",
        });
    });

    it("updates and clears episode progress with error handling", async () => {
        const progressReq = {
            params: { podcastId: "pod-1", episodeId: "ep-1" },
            user: { id: "user-1", username: "alice" },
            body: { currentTime: 90, duration: 180, isFinished: false },
        } as any;
        const progressRes = createRes();
        await progressHandler(progressReq, progressRes);
        expect(progressRes.statusCode).toBe(200);
        expect(progressRes.body).toEqual({
            success: true,
            progress: {
                currentTime: 30,
                progress: 50,
                isFinished: false,
            },
        });

        prisma.podcastProgress.upsert.mockRejectedValueOnce(
            new Error("progress write failed")
        );
        const progressErrRes = createRes();
        await progressHandler(progressReq, progressErrRes);
        expect(progressErrRes.statusCode).toBe(500);

        const clearReq = {
            params: { podcastId: "pod-1", episodeId: "ep-1" },
            user: { id: "user-1", username: "alice" },
        } as any;
        const clearRes = createRes();
        await clearProgressHandler(clearReq, clearRes);
        expect(clearRes.statusCode).toBe(200);
        expect(clearRes.body).toEqual({
            success: true,
            message: "Progress removed",
        });

        prisma.podcastProgress.deleteMany.mockRejectedValueOnce(
            new Error("delete failed")
        );
        const clearErrRes = createRes();
        await clearProgressHandler(clearReq, clearErrRes);
        expect(clearErrRes.statusCode).toBe(500);
    });

    it("serves cached and fetched similar podcast recommendations", async () => {
        prisma.podcast.findUnique.mockResolvedValue({
            id: "pod-1",
            title: "Original Show",
            description: "Description",
            author: "Host",
        });
        prisma.podcastRecommendation.findMany.mockResolvedValueOnce([
            {
                podcastId: "pod-1",
                recommendedId: "ext-1",
                title: "Cached Similar",
                author: "Host A",
                description: "Cached",
                coverUrl: "https://img/cached.jpg",
                episodeCount: 10,
                feedUrl: "https://feed/cached.xml",
                itunesId: "101",
                score: 8,
            },
        ]);

        const cachedReq = { params: { id: "pod-1" } } as any;
        const cachedRes = createRes();
        await similarHandler(cachedReq, cachedRes);
        expect(cachedRes.statusCode).toBe(200);
        expect(cachedRes.body).toEqual([
            expect.objectContaining({ id: "ext-1", title: "Cached Similar" }),
        ]);

        prisma.podcastRecommendation.findMany.mockResolvedValueOnce([]);
        getSimilarPodcasts.mockResolvedValueOnce([
            {
                collectionId: 202,
                collectionName: "iTunes Similar",
                artistName: "Host B",
                artworkUrl600: "https://img/itunes-600.jpg",
                artworkUrl100: "https://img/itunes-100.jpg",
                trackCount: 15,
                feedUrl: "https://feed/itunes.xml",
            },
        ]);

        const itunesRes = createRes();
        await similarHandler(cachedReq, itunesRes);
        expect(prisma.podcastRecommendation.deleteMany).toHaveBeenCalledWith({
            where: { podcastId: "pod-1" },
        });
        expect(prisma.podcastRecommendation.createMany).toHaveBeenCalled();
        expect(itunesRes.statusCode).toBe(200);
        expect(itunesRes.body).toEqual([
            expect.objectContaining({ id: "202", title: "iTunes Similar" }),
        ]);

        prisma.podcastRecommendation.findMany.mockResolvedValueOnce([]);
        getSimilarPodcasts.mockRejectedValueOnce(new Error("itunes down"));
        const emptyRes = createRes();
        await similarHandler(cachedReq, emptyRes);
        expect(emptyRes.statusCode).toBe(200);
        expect(emptyRes.body).toEqual([]);
    });

    it("returns not-found and server-error responses for similar podcast lookups", async () => {
        const req = { params: { id: "pod-missing" } } as any;

        prisma.podcast.findUnique.mockResolvedValueOnce(null);
        const notFoundRes = createRes();
        await similarHandler(req, notFoundRes);
        expect(notFoundRes.statusCode).toBe(404);
        expect(notFoundRes.body).toEqual({ error: "Podcast not found" });

        prisma.podcast.findUnique.mockRejectedValueOnce(new Error("similar lookup failed"));
        const errorRes = createRes();
        await similarHandler(req, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({
            error: "Failed to fetch similar podcasts",
            message: "similar lookup failed",
        });
    });

    it("responds to cover preflight routes with CORS headers", async () => {
        const podcastReq = {
            params: { id: "pod-1" },
            headers: { origin: "https://app.test" },
        } as any;
        const podcastRes = createRes();
        await podcastCoverOptionsHandler(podcastReq, podcastRes);

        expect(podcastRes.statusCode).toBe(204);
        expect(podcastRes.headers["Access-Control-Allow-Origin"]).toBe(
            "https://app.test"
        );
        expect(podcastRes.headers["Access-Control-Allow-Methods"]).toBe(
            "GET, OPTIONS"
        );
        expect(podcastRes.headers["Access-Control-Allow-Headers"]).toBe(
            "Content-Type"
        );
        expect(podcastRes.headers["Access-Control-Max-Age"]).toBe("86400");

        const episodeReq = {
            params: { episodeId: "ep-1" },
            headers: {},
        } as any;
        const episodeRes = createRes();
        await episodeCoverOptionsHandler(episodeReq, episodeRes);
        expect(episodeRes.statusCode).toBe(204);
        expect(episodeRes.headers["Access-Control-Allow-Origin"]).toBe("*");
        expect(episodeRes.headers["Access-Control-Allow-Credentials"]).toBe("true");
    });

    it("handles podcast and episode cover serving branches", async () => {
        const req = {
            params: { id: "pod-1", episodeId: "ep-1" },
            headers: { origin: "https://app.test" },
        } as any;

        prisma.podcast.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                localCoverPath: "/cache/podcast-cover.jpg",
                imageUrl: "https://img/pod.jpg",
            })
            .mockResolvedValueOnce({
                localCoverPath: null,
                imageUrl: "https://img/remote-pod.jpg",
            })
            .mockResolvedValueOnce({
                localCoverPath: null,
                imageUrl: null,
            });

        const notFoundRes = createRes();
        await coverHandler(req, notFoundRes);
        expect(notFoundRes.statusCode).toBe(404);

        const localRes = createRes();
        await coverHandler(req, localRes);
        expect(localRes.sentFile).toBe("/cache/podcast-cover.jpg");

        const redirectRes = createRes();
        await coverHandler(req, redirectRes);
        expect(redirectRes.redirectedTo).toBe("https://img/remote-pod.jpg");

        const missingRes = createRes();
        await coverHandler(req, missingRes);
        expect(missingRes.statusCode).toBe(404);
        expect(missingRes.body).toEqual({ error: "Cover not found" });

        prisma.podcastEpisode.findUnique
            .mockResolvedValueOnce({
                localCoverPath: "/cache/episode-cover.jpg",
                imageUrl: null,
            })
            .mockResolvedValueOnce(null);

        const epLocalRes = createRes();
        await episodeCoverHandler(req, epLocalRes);
        expect(epLocalRes.sentFile).toBe("/cache/episode-cover.jpg");

        const epMissingRes = createRes();
        await episodeCoverHandler(req, epMissingRes);
        expect(epMissingRes.statusCode).toBe(404);
        expect(epMissingRes.body).toEqual({ error: "Episode not found" });
    });

    it("redirects episode cover lookups to remote images when no local cache exists", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            localCoverPath: null,
            imageUrl: "https://img/remote-episode-cover.jpg",
        });

        const req = {
            params: { episodeId: "ep-redirect" },
            headers: {},
        } as any;
        const res = createRes();

        await episodeCoverHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.redirectedTo).toBe("https://img/remote-episode-cover.jpg");
    });

    it("returns cover-not-found when an episode has no local or remote cover image", async () => {
        prisma.podcastEpisode.findUnique.mockResolvedValueOnce({
            localCoverPath: null,
            imageUrl: null,
        });

        const req = {
            params: { episodeId: "ep-cover-missing" },
            headers: {},
        } as any;
        const res = createRes();

        await episodeCoverHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Cover not found" });
    });

    it("returns 500 for podcast and episode cover handler failures", async () => {
        prisma.podcast.findUnique.mockRejectedValueOnce(new Error("podcast cover read failed"));
        const podcastReq = {
            params: { id: "pod-err" },
            headers: {},
        } as any;
        const podcastRes = createRes();
        await coverHandler(podcastReq, podcastRes);

        expect(podcastRes.statusCode).toBe(500);
        expect(podcastRes.body).toEqual({
            error: "Failed to serve cover",
            message: "podcast cover read failed",
        });

        prisma.podcastEpisode.findUnique.mockRejectedValueOnce(
            new Error("episode cover read failed")
        );
        const episodeReq = {
            params: { episodeId: "ep-err" },
            headers: {},
        } as any;
        const episodeRes = createRes();
        await episodeCoverHandler(episodeReq, episodeRes);

        expect(episodeRes.statusCode).toBe(500);
        expect(episodeRes.body).toEqual({
            error: "Failed to serve cover",
            message: "episode cover read failed",
        });
    });
});
