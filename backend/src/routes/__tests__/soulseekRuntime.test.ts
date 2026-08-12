import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
    requireAdmin: (_req: Request, _res: Response, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: (() => {
        const mockLogger = {
            child: jest.fn(),
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        mockLogger.child.mockReturnValue(mockLogger);
        return mockLogger;
    })(),
}));

jest.mock("../../services/soulseek", () => ({
    soulseekService: {
        isAvailable: jest.fn(),
        getStatus: jest.fn(),
        connect: jest.fn(),
        searchTrack: jest.fn(),
        searchAndDownload: jest.fn(),
        disconnect: jest.fn(),
    },
}));

jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: jest.fn(),
}));

jest.mock("crypto", () => ({
    randomUUID: jest.fn(),
}));

jest.useFakeTimers();

import router from "../soulseek";
import { requireAdmin } from "../../middleware/auth";
import { logger } from "../../utils/logger";
import { soulseekService } from "../../services/soulseek";
import { getSystemSettings } from "../../utils/systemSettings";
import { randomUUID } from "crypto";

type HttpMethod = "get" | "post";

const mockLogger = logger as jest.Mocked<typeof logger>;
const mockSoulseekService = soulseekService as jest.Mocked<
    typeof soulseekService
>;
const mockGetSystemSettings = getSystemSettings as unknown as jest.Mock;
const mockRandomUUID = randomUUID as unknown as jest.Mock;

function getRouteLayer(path: string, method: HttpMethod) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );

    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }

    return layer;
}

function getLastHandler(path: string, method: HttpMethod) {
    const layer = getRouteLayer(path, method);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const headers = new Map<string, string>();
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
        setHeader: jest.fn(function (name: string, value: string) {
            headers.set(name.toLowerCase(), value);
            return res;
        }),
        getHeader: jest.fn((name: string) => headers.get(name.toLowerCase())),
    };

    return res;
}

async function flushPromises() {
    for (let turn = 0; turn < 8; turn += 1) {
        await Promise.resolve();
    }
}

const emptySearchResult = {
    found: false,
    bestMatch: null,
    allMatches: [],
};

async function finishPendingSearches(
    pending: Array<(result: typeof emptySearchResult) => void>,
    total: number,
) {
    let resolved = 0;
    for (let round = 0; round < total && resolved < total; round += 1) {
        const available = pending.length;
        for (
            let pendingIndex = resolved;
            pendingIndex < available;
            pendingIndex += 1
        ) {
            pending[pendingIndex](emptySearchResult);
        }
        resolved = available;
        await flushPromises();
    }
}

describe("soulseek runtime routes", () => {
    const statusHandler = getLastHandler("/status", "get");
    const connectHandler = getLastHandler("/connect", "post");
    const searchHandler = getLastHandler("/search", "post");
    const searchByIdHandler = getLastHandler("/search/:searchId", "get");
    const downloadHandler = getLastHandler("/download", "post");
    const disconnectHandler = getLastHandler("/disconnect", "post");
    const requireConfiguredMiddleware = getRouteLayer("/connect", "post").route
        .stack[1].handle;

    beforeEach(() => {
        jest.advanceTimersByTime(6 * 60 * 1000);
        jest.clearAllMocks();

        mockRandomUUID.mockReturnValue("search-default-id");

        mockSoulseekService.isAvailable.mockResolvedValue(true);
        mockSoulseekService.getStatus.mockResolvedValue({
            connected: true,
            username: "slsk-user",
        });
        mockSoulseekService.connect.mockResolvedValue(undefined);
        mockSoulseekService.searchTrack.mockResolvedValue({
            found: true,
            bestMatch: null,
            allMatches: [],
        });
        mockSoulseekService.searchAndDownload.mockResolvedValue({
            success: true,
            filePath: "/music/Singles/Artist/Album/Track.flac",
        });
        mockSoulseekService.disconnect.mockImplementation(() => undefined);

        mockGetSystemSettings.mockResolvedValue({
            musicPath: "/music",
        });
    });

    afterEach(async () => {
        await flushPromises();
    });

    afterAll(() => {
        jest.useRealTimers();
    });

    it("requires admin authorization for direct downloads", () => {
        const middlewares = getRouteLayer("/download", "post").route.stack.map(
            (entry: { handle: unknown }) => entry.handle,
        );

        expect(middlewares).toContain(requireAdmin);
    });

    it("returns configured and unconfigured status responses", async () => {
        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await statusHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            enabled: true,
            connected: true,
            username: "slsk-user",
        });

        mockSoulseekService.isAvailable.mockResolvedValueOnce(false);
        const disabledRes = createRes();
        await statusHandler(req, disabledRes);

        expect(disabledRes.statusCode).toBe(200);
        expect(disabledRes.body).toEqual({
            enabled: false,
            connected: false,
            message: "Soulseek credentials not configured",
        });
    });

    it("returns status 500 when status lookup throws", async () => {
        mockSoulseekService.getStatus.mockRejectedValueOnce(
            new Error("status failed"),
        );

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await statusHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to get Soulseek status",
        });
        expect(mockLogger.error).toHaveBeenCalled();
    });

    it("evaluates soulseek-configured middleware for unavailable, error, and success", async () => {
        const req = {} as any;
        const next = jest.fn();

        mockSoulseekService.isAvailable.mockResolvedValueOnce(false);
        const unavailableRes = createRes();
        await requireConfiguredMiddleware(req, unavailableRes, next);
        expect(unavailableRes.statusCode).toBe(403);
        expect(unavailableRes.body).toEqual({
            error: "Soulseek credentials not configured. Add username/password in System Settings.",
        });
        expect(next).not.toHaveBeenCalled();

        mockSoulseekService.isAvailable.mockRejectedValueOnce(
            new Error("availability failed"),
        );
        const errorRes = createRes();
        await requireConfiguredMiddleware(req, errorRes, next);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "Failed to check settings" });
        expect(next).not.toHaveBeenCalled();

        mockSoulseekService.isAvailable.mockResolvedValueOnce(true);
        const okRes = createRes();
        await requireConfiguredMiddleware(req, okRes, next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(okRes.statusCode).toBe(200);
    });

    it("connects and surfaces connect failures", async () => {
        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await connectHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            message: "Connected to Soulseek network",
        });
        expect(mockSoulseekService.connect).toHaveBeenCalled();

        mockSoulseekService.connect.mockRejectedValueOnce(
            new Error("connect failed"),
        );
        const errorRes = createRes();
        await connectHandler(req, errorRes);

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({
            error: "Failed to connect to Soulseek",
        });
    });

    it("validates search payload and supports both query formats", async () => {
        const invalidReq = { body: {} } as any;
        const invalidRes = createRes();
        await searchHandler(invalidReq, invalidRes);

        expect(invalidRes.statusCode).toBe(400);
        expect(invalidRes.body).toEqual({
            error: "Either 'query' or both 'artist' and 'title' are required",
        });

        mockRandomUUID.mockReturnValueOnce("search-query-id");
        const queryReq = {
            user: { id: "user-query" },
            body: { query: "Daft Punk" },
        } as any;
        const queryRes = createRes();
        await searchHandler(queryReq, queryRes);

        expect(queryRes.statusCode).toBe(200);
        expect(queryRes.body).toEqual({
            searchId: "search-query-id",
            message: "Search started",
        });
        expect(mockSoulseekService.searchTrack).toHaveBeenCalledWith(
            "Daft Punk",
            "",
            false,
            15000,
        );

        mockRandomUUID.mockReturnValueOnce("search-track-id");
        const trackReq = {
            user: { id: "user-track" },
            body: { artist: "Artist", title: "Track" },
        } as any;
        const trackRes = createRes();
        await searchHandler(trackReq, trackRes);

        expect(trackRes.statusCode).toBe(200);
        expect(trackRes.body).toEqual({
            searchId: "search-track-id",
            message: "Search started",
        });
        expect(mockSoulseekService.searchTrack).toHaveBeenCalledWith(
            "Artist Track",
            "",
            false,
            15000,
        );
    });

    it("returns validation error for empty query when artist/title are missing", async () => {
        const req = { body: { query: "" } } as any;
        const res = createRes();
        await searchHandler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Either 'query' or both 'artist' and 'title' are required",
        });
    });

    it("rejects a search when authenticated user context is unavailable", async () => {
        const res = createRes();
        await searchHandler({ body: { query: "valid query" } } as any, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Not authenticated" });
        expect(mockSoulseekService.searchTrack).not.toHaveBeenCalled();
    });

    it("stores the search owner, returns their results, and hides them from other users", async () => {
        mockRandomUUID.mockReturnValueOnce("search-results-id");
        mockSoulseekService.searchTrack.mockResolvedValueOnce({
            found: true,
            bestMatch: null,
            allMatches: [
                {
                    username: "peer-1",
                    filename: "01 - My Song.flac",
                    fullPath:
                        "/library/Artist Name/Album Name/01 - My Song.flac",
                    size: 123456,
                    bitRate: 990,
                    quality: "lossless",
                    score: 0.99,
                },
            ],
        });

        const searchReq = {
            user: { id: "user-results" },
            body: { query: "Artist Name My Song" },
        } as any;
        const searchRes = createRes();
        await searchHandler(searchReq, searchRes);
        await flushPromises();

        const resultsReq = {
            user: { id: "user-results" },
            params: { searchId: "search-results-id" },
        } as any;
        const resultsRes = createRes();
        await searchByIdHandler(resultsReq, resultsRes);

        expect(resultsRes.statusCode).toBe(200);
        expect(resultsRes.body).toEqual({
            results: [
                {
                    username: "peer-1",
                    path: "/library/Artist Name/Album Name/01 - My Song.flac",
                    filename: "01 - My Song.flac",
                    size: 123456,
                    bitrate: 990,
                    format: "flac",
                    parsedArtist: "Artist Name",
                    parsedAlbum: "Album Name",
                    parsedTitle: "My Song",
                },
            ],
            count: 1,
        });

        const otherUserReq = {
            user: { id: "other-user" },
            params: { searchId: "search-results-id" },
        } as any;
        const otherUserRes = createRes();
        await searchByIdHandler(otherUserReq, otherUserRes);

        expect(otherUserRes.statusCode).toBe(404);
        expect(otherUserRes.body).toEqual({
            error: "Search not found or expired",
            results: [],
            count: 0,
        });
        expect(JSON.stringify(otherUserRes.body)).not.toContain("peer-1");
        expect(JSON.stringify(otherUserRes.body)).not.toContain("/library/");

        const missingReq = {
            params: { searchId: "missing-session-id" },
        } as any;
        const missingRes = createRes();
        await searchByIdHandler(missingReq, missingRes);

        expect(missingRes.statusCode).toBe(404);
        expect(missingRes.body).toEqual({
            error: "Search not found or expired",
            results: [],
            count: 0,
        });
    });

    it("maps search result formatting errors to internal error response", async () => {
        mockRandomUUID.mockReturnValueOnce("search-bad-file-id");
        mockSoulseekService.searchTrack.mockResolvedValueOnce({
            found: true,
            bestMatch: null,
            allMatches: [
                {
                    username: "peer-1",
                    filename: "01 - Broken.mp3",
                    fullPath: null as any,
                    size: 123,
                    bitRate: 321,
                    quality: "lossless",
                    score: 0.7,
                },
            ],
        } as any);

        const searchReq = {
            user: { id: "user-bad-file" },
            body: { query: "bad file" },
        } as any;
        const searchRes = createRes();
        await searchHandler(searchReq, searchRes);
        await flushPromises();

        const resultsReq = {
            user: { id: "user-bad-file" },
            params: { searchId: "search-bad-file-id" },
        } as any;
        const resultsRes = createRes();
        await searchByIdHandler(resultsReq, resultsRes);

        expect(resultsRes.statusCode).toBe(500);
        expect(resultsRes.body).toMatchObject({
            error: "Failed to get results",
        });
        expect(mockLogger.error).toHaveBeenCalled();
    });

    it("logs async search exceptions without failing the request", async () => {
        mockRandomUUID.mockReturnValueOnce("search-reject-id");
        mockSoulseekService.searchTrack.mockRejectedValueOnce(
            new Error("search exploded"),
        );

        const req = {
            user: { id: "user-reject" },
            body: { query: "broken query" },
        } as any;
        const res = createRes();
        await searchHandler(req, res);
        await flushPromises();

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            searchId: "search-reject-id",
            message: "Search started",
        });
        expect(mockLogger.error).toHaveBeenCalledWith("UI search failed", {
            error: expect.any(Error),
            searchId: "search-reject-id",
            userId: "user-reject",
        });
    });

    it("sanitizes synchronous search admission failures", async () => {
        const failure = new Error("private admission detail");
        mockRandomUUID.mockImplementationOnce(() => {
            throw failure;
        });
        const res = createRes();

        await searchHandler(
            {
                user: { id: "admission-failure-user" },
                body: { query: "valid query" },
            } as any,
            res,
        );

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({ error: "Search failed" });
        expect(JSON.stringify(res.body)).not.toContain(failure.message);
        expect(mockLogger.error).toHaveBeenCalledWith(
            "UI search admission failed",
            {
                error: failure,
            },
        );
    });

    it("bounds global search concurrency and rejects work beyond the queue capacity", async () => {
        const pending: Array<(result: typeof emptySearchResult) => void> = [];
        mockSoulseekService.searchTrack.mockImplementation(
            () =>
                new Promise((resolve) => {
                    pending.push(resolve);
                }),
        );
        mockRandomUUID.mockImplementation(
            () => `global-search-${mockRandomUUID.mock.calls.length}`,
        );

        for (let index = 0; index < 24; index += 1) {
            const res = createRes();
            await searchHandler(
                {
                    user: { id: `global-user-${index}` },
                    body: { query: `query ${index}` },
                } as any,
                res,
            );
            expect(res.statusCode).toBe(200);
        }

        expect(mockSoulseekService.searchTrack).toHaveBeenCalledTimes(4);

        const overloadedRes = createRes();
        await searchHandler(
            {
                user: { id: "global-overload-user" },
                body: { query: "overloaded query" },
            } as any,
            overloadedRes,
        );

        expect(overloadedRes.statusCode).toBe(503);
        expect(overloadedRes.body).toEqual({
            error: "Soulseek search capacity is full. Please try again later.",
        });
        expect(overloadedRes.getHeader("Retry-After")).toBe("15");

        await finishPendingSearches(pending, 24);
        expect(mockSoulseekService.searchTrack).toHaveBeenCalledTimes(24);
    });

    it("enforces per-user concurrency and queue fairness", async () => {
        const pending: Array<(result: typeof emptySearchResult) => void> = [];
        mockSoulseekService.searchTrack.mockImplementation(
            () =>
                new Promise((resolve) => {
                    pending.push(resolve);
                }),
        );
        mockRandomUUID.mockImplementation(
            () => `user-search-${mockRandomUUID.mock.calls.length}`,
        );

        for (let index = 0; index < 6; index += 1) {
            const res = createRes();
            await searchHandler(
                {
                    user: { id: "busy-user" },
                    body: { query: `busy query ${index}` },
                } as any,
                res,
            );
            expect(res.statusCode).toBe(200);
        }
        expect(mockSoulseekService.searchTrack).toHaveBeenCalledTimes(2);

        const busyUserRes = createRes();
        await searchHandler(
            {
                user: { id: "busy-user" },
                body: { query: "one too many" },
            } as any,
            busyUserRes,
        );
        expect(busyUserRes.statusCode).toBe(503);

        const otherUserRes = createRes();
        await searchHandler(
            {
                user: { id: "other-user" },
                body: { query: "fair query" },
            } as any,
            otherUserRes,
        );
        expect(otherUserRes.statusCode).toBe(200);
        expect(mockSoulseekService.searchTrack).toHaveBeenCalledTimes(3);

        await finishPendingSearches(pending, 7);
        expect(mockSoulseekService.searchTrack).toHaveBeenCalledTimes(7);
    });

    it("rate limits repeated searches per user and provides retry guidance", async () => {
        mockRandomUUID.mockImplementation(
            () => `rate-search-${mockRandomUUID.mock.calls.length}`,
        );

        for (let index = 0; index < 10; index += 1) {
            const res = createRes();
            await searchHandler(
                {
                    user: { id: "rate-user" },
                    body: { query: `rate query ${index}` },
                } as any,
                res,
            );
            await flushPromises();
            expect(res.statusCode).toBe(200);
        }

        const limitedRes = createRes();
        await searchHandler(
            {
                user: { id: "rate-user" },
                body: { query: "rate query rejected" },
            } as any,
            limitedRes,
        );

        expect(limitedRes.statusCode).toBe(429);
        expect(limitedRes.body).toEqual({
            error: "Too many Soulseek searches. Please try again later.",
        });
        expect(limitedRes.getHeader("Retry-After")).toBe("60");

        jest.advanceTimersByTime(60 * 1000);
        const retryRes = createRes();
        await searchHandler(
            {
                user: { id: "rate-user" },
                body: { query: "rate query accepted later" },
            } as any,
            retryRes,
        );
        expect(retryRes.statusCode).toBe(200);
        await flushPromises();
    });

    it("rate limits aggregate searches across users", async () => {
        mockRandomUUID.mockImplementation(
            () => `aggregate-search-${mockRandomUUID.mock.calls.length}`,
        );

        for (let index = 0; index < 60; index += 1) {
            const res = createRes();
            await searchHandler(
                {
                    user: { id: `aggregate-user-${index}` },
                    body: { query: `aggregate query ${index}` },
                } as any,
                res,
            );
            await flushPromises();
            expect(res.statusCode).toBe(200);
        }

        const limitedRes = createRes();
        await searchHandler(
            {
                user: { id: "aggregate-limited-user" },
                body: { query: "aggregate rejected" },
            } as any,
            limitedRes,
        );
        expect(limitedRes.statusCode).toBe(429);
        expect(mockSoulseekService.searchTrack).toHaveBeenCalledTimes(60);
    });

    it("evicts the oldest retained session at the hard session cap", async () => {
        mockRandomUUID.mockImplementation(
            () => `retained-search-${mockRandomUUID.mock.calls.length}`,
        );

        for (let index = 0; index < 101; index += 1) {
            if (index === 50 || index === 100) {
                jest.advanceTimersByTime(60 * 1000);
            }
            const res = createRes();
            await searchHandler(
                {
                    user: { id: `retained-user-${index}` },
                    body: { query: `retained query ${index}` },
                } as any,
                res,
            );
            await flushPromises();
            expect(res.statusCode).toBe(200);
        }

        const oldestRes = createRes();
        await searchByIdHandler(
            { params: { searchId: "retained-search-1" } } as any,
            oldestRes,
        );
        expect(oldestRes.statusCode).toBe(404);

        const newestRes = createRes();
        await searchByIdHandler(
            {
                user: { id: "retained-user-100" },
                params: { searchId: "retained-search-101" },
            } as any,
            newestRes,
        );
        expect(newestRes.statusCode).toBe(200);
    });

    it("retains at most 100 results for a search session", async () => {
        mockRandomUUID.mockReturnValueOnce("bounded-results-id");
        mockSoulseekService.searchTrack.mockResolvedValueOnce({
            found: true,
            bestMatch: null,
            allMatches: Array.from({ length: 101 }, (_, index) => ({
                username: `peer-${index}`,
                filename: `${index}.mp3`,
                fullPath: `/library/Artist/Album/${index}.mp3`,
                size: index,
                bitRate: 320,
                quality: "lossy" as const,
                score: 1,
            })),
        });

        const searchRes = createRes();
        await searchHandler(
            {
                user: { id: "bounded-results-user" },
                body: { query: "bounded results" },
            } as any,
            searchRes,
        );
        await flushPromises();

        const resultsRes = createRes();
        await searchByIdHandler(
            {
                user: { id: "bounded-results-user" },
                params: { searchId: "bounded-results-id" },
            } as any,
            resultsRes,
        );

        expect(resultsRes.statusCode).toBe(200);
        expect(resultsRes.body.count).toBe(100);
        expect(resultsRes.body.results[99].path).toBe(
            "/library/Artist/Album/99.mp3",
        );
    });

    it("downloads tracks and handles missing musicPath plus download exceptions", async () => {
        const req = {
            body: { artist: "Artist", title: "Track", album: "Album" },
        } as any;
        const res = createRes();
        await downloadHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            filePath: "/music/Singles/Artist/Album/Track.flac",
        });
        expect(mockSoulseekService.searchAndDownload).toHaveBeenCalledWith(
            "Artist",
            "Track",
            "Album",
            "/music",
        );

        mockGetSystemSettings.mockResolvedValueOnce({ musicPath: null });
        const missingPathRes = createRes();
        await downloadHandler(req, missingPathRes);

        expect(missingPathRes.statusCode).toBe(400);
        expect(missingPathRes.body).toEqual({
            error: "Music path not configured",
        });

        mockSoulseekService.searchAndDownload.mockRejectedValueOnce(
            new Error("download exploded"),
        );
        const errorRes = createRes();
        await downloadHandler(req, errorRes);

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({
            error: "Download failed",
        });
    });

    it("maps unsuccessful search-and-download results to 404", async () => {
        mockSoulseekService.searchAndDownload.mockResolvedValueOnce({
            success: false,
            filePath: "",
            error: "track not available",
        } as any);

        const req = {
            body: { artist: "Artist", title: "Track", album: "Album" },
        } as any;
        const res = createRes();
        await downloadHandler(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({
            error: "track not available",
        });
    });

    it("derives artist/title from filename when download body is missing both", async () => {
        const req = {
            body: {
                filepath: "/tmp/12 - Example Track.mp3",
            },
        } as any;
        const res = createRes();
        await downloadHandler(req, res);

        expect(mockSoulseekService.searchAndDownload).toHaveBeenCalledWith(
            "Unknown",
            "Example Track",
            "Unknown Album",
            "/music",
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            filePath: "/music/Singles/Artist/Album/Track.flac",
        });
    });

    it("disconnects and handles disconnect exceptions", async () => {
        const req = {} as any;
        const res = createRes();
        await disconnectHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            success: true,
            message: "Disconnected",
        });
        expect(mockSoulseekService.disconnect).toHaveBeenCalled();

        mockSoulseekService.disconnect.mockImplementationOnce(() => {
            throw new Error("disconnect failed");
        });
        const errorRes = createRes();
        await disconnectHandler(req, errorRes);

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "Internal server error" });
    });
});
