import type { Request, Response } from "express";
import { PassThrough } from "stream";

// ── Mocks ──────────────────────────────────────────────────────────

jest.mock("../../middleware/auth", () => ({
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

const ytMusicService = {
    search: jest.fn(),
    getStreamProxy: jest.fn(),
};

jest.mock("../../services/youtubeMusic", () => ({
    ytMusicService,
}));

jest.mock("../../services/deezer", () => ({
    deezerService: {
        getTrackPreview: jest.fn(),
        getArtistImage: jest.fn(),
        getAlbumCover: jest.fn(),
    },
}));

jest.mock("../../services/musicbrainz", () => ({
    musicBrainzService: {
        searchArtist: jest.fn(),
        getArtist: jest.fn(),
        getReleaseGroups: jest.fn(),
        getReleaseGroup: jest.fn(),
        getRelease: jest.fn(),
    },
}));

jest.mock("../../services/lastfm", () => ({
    lastFmService: {
        getArtistInfo: jest.fn(),
        getArtistTopTracks: jest.fn(),
        getBestImage: jest.fn(),
        getAlbumInfo: jest.fn(),
    },
}));

jest.mock("../../services/fanart", () => ({
    fanartService: { getArtistImage: jest.fn() },
}));

const redisClient = {
    get: jest.fn(),
    set: jest.fn(),
    setEx: jest.fn(),
};

jest.mock("../../utils/redis", () => ({
    redisClient,
}));

const mockGetSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: (...args: unknown[]) => mockGetSystemSettings(...args),
}));

const mockPrisma = {
    userSettings: {
        findUnique: jest.fn(),
    },
};

jest.mock("../../utils/db", () => ({
    prisma: mockPrisma,
}));

jest.mock("../../utils/normalize", () => ({
    normalizeToArray: jest.fn((val: unknown) =>
        Array.isArray(val) ? val : val != null ? [val] : []
    ),
}));

import router from "../artists";
import { logger } from "../../utils/logger";

// ── Helpers ────────────────────────────────────────────────────────

const mockSearch = ytMusicService.search as jest.Mock;
const mockGetStreamProxy = ytMusicService.getStreamProxy as jest.Mock;
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSet = redisClient.set as jest.Mock;
const mockLoggerError = logger.error as jest.Mock;
const mockLoggerWarn = logger.warn as jest.Mock;
const mockFindUniqueUserSettings = mockPrisma.userSettings.findUnique as jest.Mock;

function getGetHandler(path: string) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.get
    );
    if (!layer) throw new Error(`GET route not found: ${path}`);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        headersSent: false,
        _headers: {} as Record<string, string>,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
        setHeader: jest.fn(function (name: string, value: string) {
            res._headers[name] = value;
            return res;
        }),
        end: jest.fn(),
    };
    return res;
}

function createMockStreamResponse(
    status = 200,
    headers: Record<string, string> = {},
    errorAfter?: Error
) {
    const data = new PassThrough();
    if (errorAfter) {
        process.nextTick(() => data.emit("error", errorAfter));
    } else {
        process.nextTick(() => {
            data.end(Buffer.from("audio-bytes"));
        });
    }
    return {
        status,
        headers: {
            "content-type": "audio/webm",
            ...headers,
        },
        data,
    };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("artists preview (YT Music) routes", () => {
    const getPreview = getGetHandler("/preview/:artistName/:trackTitle");
    const getPreviewStream = getGetHandler("/preview-stream/:videoId");

    beforeEach(() => {
        jest.clearAllMocks();
        mockGetSystemSettings.mockResolvedValue({ ytMusicEnabled: true });
        mockRedisGet.mockResolvedValue(null);
        mockRedisSet.mockResolvedValue("OK");
        mockSearch.mockResolvedValue({ results: [], total: 0 });
        mockFindUniqueUserSettings.mockResolvedValue(null);
    });

    // ── GET /preview/:artistName/:trackTitle ───────────────────────

    describe("GET /preview/:artistName/:trackTitle", () => {
        const buildReq = (artist: string, track: string) =>
            ({
                params: {
                    artistName: encodeURIComponent(artist),
                    trackTitle: encodeURIComponent(track),
                },
            }) as any;

        it("returns videoId when YT Music search finds a match", async () => {
            mockSearch.mockResolvedValueOnce({
                results: [{ videoId: "dQw4w9WgXcQ", title: "Track" }],
                total: 1,
            });

            const res = createRes();
            await getPreview(buildReq("AC/DC", "Back In Black"), res);

            expect(mockSearch).toHaveBeenCalledWith(
                "__public__",
                "AC/DC Back In Black",
                "songs"
            );
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ videoId: "dQw4w9WgXcQ" });
        });

        it("caches videoId in Redis after successful search", async () => {
            mockSearch.mockResolvedValueOnce({
                results: [{ videoId: "abc123" }],
                total: 1,
            });

            const res = createRes();
            await getPreview(buildReq("Artist", "Track"), res);

            expect(mockRedisSet).toHaveBeenCalledWith(
                "yt-preview:artist:track",
                "abc123",
                { EX: 24 * 60 * 60 }
            );
        });

        it("caches 'null' in Redis when no match found", async () => {
            mockSearch.mockResolvedValueOnce({ results: [], total: 0 });

            const res = createRes();
            await getPreview(buildReq("Nobody", "Nothing"), res);

            expect(mockRedisSet).toHaveBeenCalledWith(
                "yt-preview:nobody:nothing",
                "null",
                { EX: 24 * 60 * 60 }
            );
            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ error: "Preview not found" });
        });

        it("returns cached videoId from Redis (cache hit)", async () => {
            mockRedisGet.mockResolvedValueOnce("cached-vid-id");

            const res = createRes();
            await getPreview(buildReq("Cached Artist", "Cached Track"), res);

            expect(mockSearch).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ videoId: "cached-vid-id" });
        });

        it("returns 404 when Redis has cached 'null' (negative cache)", async () => {
            mockRedisGet.mockResolvedValueOnce("null");

            const res = createRes();
            await getPreview(buildReq("No Match", "Cached"), res);

            expect(mockSearch).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ error: "Preview not found" });
        });

        it("returns 404 when YT Music is disabled", async () => {
            mockGetSystemSettings.mockResolvedValueOnce({
                ytMusicEnabled: false,
            });

            const res = createRes();
            await getPreview(buildReq("Artist", "Track"), res);

            expect(mockSearch).not.toHaveBeenCalled();
            expect(res.statusCode).toBe(404);
            expect(res.body).toEqual({ error: "Preview not found" });
        });

        it("returns 404 when search result has no videoId", async () => {
            mockSearch.mockResolvedValueOnce({
                results: [{ title: "Track without videoId" }],
                total: 1,
            });

            const res = createRes();
            await getPreview(buildReq("Artist", "Track"), res);

            expect(res.statusCode).toBe(404);
        });

        it("returns 500 when YT Music search throws", async () => {
            mockSearch.mockRejectedValueOnce(new Error("sidecar down"));

            const res = createRes();
            await getPreview(buildReq("Artist", "Track"), res);

            expect(res.statusCode).toBe(500);
            expect(res.body).toEqual({ error: "Failed to fetch preview" });
            expect(mockLoggerError).toHaveBeenCalled();
        });

        it("normalizes artist and track names to lowercase for cache key", async () => {
            mockSearch.mockResolvedValueOnce({ results: [], total: 0 });

            const res = createRes();
            await getPreview(buildReq("LOUD ARTIST", "BIG TRACK"), res);

            expect(mockRedisSet).toHaveBeenCalledWith(
                "yt-preview:loud artist:big track",
                "null",
                expect.any(Object)
            );
        });
    });

    // ── GET /preview-stream/:videoId ───────────────────────────────

    describe("GET /preview-stream/:videoId", () => {
        const buildReq = (
            videoId: string,
            opts?: { userId?: string; range?: string }
        ) =>
            ({
                params: { videoId },
                user: opts?.userId
                    ? { id: opts.userId, username: "tester", role: "user" }
                    : undefined,
                headers: opts?.range ? { range: opts.range } : {},
            }) as any;

        it("returns 503 when YT Music is disabled", async () => {
            mockGetSystemSettings.mockResolvedValueOnce({
                ytMusicEnabled: false,
            });

            const res = createRes();
            await getPreviewStream(buildReq("vid-1", { userId: "u1" }), res);

            expect(res.statusCode).toBe(503);
            expect(res.body).toEqual({
                error: "YouTube Music not available",
            });
        });

        it("streams with __public__ userId when user has no OAuth", async () => {
            mockFindUniqueUserSettings.mockResolvedValueOnce(null);
            const mockStream = createMockStreamResponse();
            mockGetStreamProxy.mockResolvedValueOnce(mockStream);

            const res = createRes();
            // Simulate pipe
            res.pipe = jest.fn();
            mockStream.data.pipe = jest.fn();

            await getPreviewStream(
                buildReq("vid-pub", { userId: "user-no-oauth" }),
                res
            );

            expect(mockFindUniqueUserSettings).toHaveBeenCalledWith({
                where: { userId: "user-no-oauth" },
                select: { ytMusicOAuthJson: true },
            });
            expect(mockGetStreamProxy).toHaveBeenCalledWith(
                "__public__",
                "vid-pub",
                "high",
                undefined
            );
            expect(res.statusCode).toBe(200);
        });

        it("streams with user's userId when they have OAuth", async () => {
            mockFindUniqueUserSettings.mockResolvedValueOnce({
                ytMusicOAuthJson: '{"token":"secret"}',
            });
            const mockStream = createMockStreamResponse();
            mockGetStreamProxy.mockResolvedValueOnce(mockStream);
            mockStream.data.pipe = jest.fn();

            const res = createRes();
            await getPreviewStream(
                buildReq("vid-auth", { userId: "user-with-oauth" }),
                res
            );

            expect(mockGetStreamProxy).toHaveBeenCalledWith(
                "user-with-oauth",
                "vid-auth",
                "high",
                undefined
            );
        });

        it("streams with __public__ when req.user is undefined", async () => {
            const mockStream = createMockStreamResponse();
            mockGetStreamProxy.mockResolvedValueOnce(mockStream);
            mockStream.data.pipe = jest.fn();

            const res = createRes();
            await getPreviewStream(buildReq("vid-anon"), res);

            expect(mockGetStreamProxy).toHaveBeenCalledWith(
                "__public__",
                "vid-anon",
                "high",
                undefined
            );
        });

        it("forwards range header for seeking", async () => {
            mockFindUniqueUserSettings.mockResolvedValueOnce(null);
            const mockStream = createMockStreamResponse(206, {
                "content-range": "bytes 0-1024/5000",
                "accept-ranges": "bytes",
            });
            mockGetStreamProxy.mockResolvedValueOnce(mockStream);
            mockStream.data.pipe = jest.fn();

            const res = createRes();
            await getPreviewStream(
                buildReq("vid-range", {
                    userId: "u1",
                    range: "bytes=0-1024",
                }),
                res
            );

            expect(mockGetStreamProxy).toHaveBeenCalledWith(
                "__public__",
                "vid-range",
                "high",
                "bytes=0-1024"
            );
            expect(res.statusCode).toBe(206);
            expect(res._headers["content-range"]).toBe("bytes 0-1024/5000");
        });

        it("forwards content-type header from upstream", async () => {
            mockFindUniqueUserSettings.mockResolvedValueOnce(null);
            const mockStream = createMockStreamResponse(200, {
                "content-type": "audio/mp4",
                "content-length": "12345",
            });
            mockGetStreamProxy.mockResolvedValueOnce(mockStream);
            mockStream.data.pipe = jest.fn();

            const res = createRes();
            await getPreviewStream(
                buildReq("vid-mp4", { userId: "u1" }),
                res
            );

            expect(res._headers["content-type"]).toBe("audio/mp4");
            expect(res._headers["content-length"]).toBe("12345");
        });

        it("falls back to __public__ when OAuth stream returns 401", async () => {
            const oauthError: any = new Error("OAuth expired");
            oauthError.response = { status: 401 };
            mockGetStreamProxy.mockRejectedValueOnce(oauthError);

            // Fallback call succeeds
            const fallbackStream = createMockStreamResponse();
            mockGetStreamProxy.mockResolvedValueOnce(fallbackStream);
            fallbackStream.data.pipe = jest.fn();

            mockFindUniqueUserSettings.mockResolvedValueOnce({
                ytMusicOAuthJson: '{"token":"expired"}',
            });

            const res = createRes();
            await getPreviewStream(
                buildReq("vid-fallback", { userId: "user-expired" }),
                res
            );

            // First call with user's OAuth
            expect(mockGetStreamProxy).toHaveBeenNthCalledWith(
                1,
                "user-expired",
                "vid-fallback",
                "high",
                undefined
            );
            // Fallback with public
            expect(mockGetStreamProxy).toHaveBeenNthCalledWith(
                2,
                "__public__",
                "vid-fallback",
                "high",
                undefined
            );
            expect(res.statusCode).toBe(200);
        });

        it("returns 500 when stream proxy fails (non-401)", async () => {
            mockFindUniqueUserSettings.mockResolvedValueOnce(null);
            mockGetStreamProxy.mockRejectedValueOnce(
                new Error("sidecar timeout")
            );

            const res = createRes();
            await getPreviewStream(
                buildReq("vid-err", { userId: "u1" }),
                res
            );

            expect(res.statusCode).toBe(500);
            expect(res.body).toEqual({
                error: "Failed to stream preview",
            });
            expect(mockLoggerError).toHaveBeenCalled();
        });

        it("handles upstream stream error gracefully", async () => {
            mockFindUniqueUserSettings.mockResolvedValueOnce(null);
            const mockStream = createMockStreamResponse(
                200,
                {},
                new Error("upstream disconnected")
            );
            mockGetStreamProxy.mockResolvedValueOnce(mockStream);
            mockStream.data.pipe = jest.fn();

            const res = createRes();
            await getPreviewStream(
                buildReq("vid-stream-err", { userId: "u1" }),
                res
            );

            // The error handler is attached — give event loop a tick
            await new Promise((r) => setImmediate(r));

            expect(mockLoggerWarn).toHaveBeenCalledWith(
                expect.stringContaining("Preview stream error")
            );
        });
    });
});
