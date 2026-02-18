import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
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
            entry.route?.path === path && entry.route?.methods?.[method]
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

async function flushPromises() {
    await Promise.resolve();
    await Promise.resolve();
}

describe("soulseek runtime routes", () => {
    const statusHandler = getLastHandler("/status", "get");
    const connectHandler = getLastHandler("/connect", "post");
    const searchHandler = getLastHandler("/search", "post");
    const searchByIdHandler = getLastHandler("/search/:searchId", "get");
    const downloadHandler = getLastHandler("/download", "post");
    const disconnectHandler = getLastHandler("/disconnect", "post");
    const requireConfiguredMiddleware = getRouteLayer(
        "/connect",
        "post"
    ).route.stack[1].handle;

    beforeEach(() => {
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

    afterAll(() => {
        jest.useRealTimers();
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
            new Error("status failed")
        );

        const req = { user: { id: "user-1" } } as any;
        const res = createRes();
        await statusHandler(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to get Soulseek status",
            details: "status failed",
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
            new Error("availability failed")
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
            new Error("connect failed")
        );
        const errorRes = createRes();
        await connectHandler(req, errorRes);

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({
            error: "Failed to connect to Soulseek",
            details: "connect failed",
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
        const queryReq = { body: { query: "Daft Punk" } } as any;
        const queryRes = createRes();
        await searchHandler(queryReq, queryRes);

        expect(queryRes.statusCode).toBe(200);
        expect(queryRes.body).toEqual({
            searchId: "search-query-id",
            message: "Search started",
        });
        expect(mockSoulseekService.searchTrack).toHaveBeenCalledWith(
            "Daft Punk",
            ""
        );

        mockRandomUUID.mockReturnValueOnce("search-track-id");
        const trackReq = { body: { artist: "Artist", title: "Track" } } as any;
        const trackRes = createRes();
        await searchHandler(trackReq, trackRes);

        expect(trackRes.statusCode).toBe(200);
        expect(trackRes.body).toEqual({
            searchId: "search-track-id",
            message: "Search started",
        });
        expect(mockSoulseekService.searchTrack).toHaveBeenCalledWith(
            "Artist Track",
            ""
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

    it("returns formatted search results and 404 when search session is missing", async () => {
        mockRandomUUID.mockReturnValueOnce("search-results-id");
        mockSoulseekService.searchTrack.mockResolvedValueOnce({
            found: true,
            bestMatch: null,
            allMatches: [
                {
                    username: "peer-1",
                    filename: "01 - My Song.flac",
                    fullPath: "/library/Artist Name/Album Name/01 - My Song.flac",
                    size: 123456,
                    bitRate: 990,
                    quality: "lossless",
                    score: 0.99,
                },
            ],
        });

        const searchReq = { body: { query: "Artist Name My Song" } } as any;
        const searchRes = createRes();
        await searchHandler(searchReq, searchRes);
        await flushPromises();

        const resultsReq = { params: { searchId: "search-results-id" } } as any;
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

        const missingReq = { params: { searchId: "missing-session-id" } } as any;
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

        const searchReq = { body: { query: "bad file" } } as any;
        const searchRes = createRes();
        await searchHandler(searchReq, searchRes);
        await flushPromises();

        const resultsReq = { params: { searchId: "search-bad-file-id" } } as any;
        const resultsRes = createRes();
        await searchByIdHandler(resultsReq, resultsRes);

        expect(resultsRes.statusCode).toBe(500);
        expect(resultsRes.body).toMatchObject({
            error: "Failed to get results",
        });
        expect(resultsRes.body.details).toEqual(expect.any(String));
        expect(mockLogger.error).toHaveBeenCalled();
    });

    it("logs async search exceptions without failing the request", async () => {
        mockRandomUUID.mockReturnValueOnce("search-reject-id");
        mockSoulseekService.searchTrack.mockRejectedValueOnce(
            new Error("search exploded")
        );

        const req = { body: { query: "broken query" } } as any;
        const res = createRes();
        await searchHandler(req, res);
        await flushPromises();

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            searchId: "search-reject-id",
            message: "Search started",
        });
        expect(mockLogger.error).toHaveBeenCalledWith(
            "[Soulseek] Search search-reject-id failed:",
            "search exploded"
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
            "/music"
        );

        mockGetSystemSettings.mockResolvedValueOnce({ musicPath: null });
        const missingPathRes = createRes();
        await downloadHandler(req, missingPathRes);

        expect(missingPathRes.statusCode).toBe(400);
        expect(missingPathRes.body).toEqual({
            error: "Music path not configured",
        });

        mockSoulseekService.searchAndDownload.mockRejectedValueOnce(
            new Error("download exploded")
        );
        const errorRes = createRes();
        await downloadHandler(req, errorRes);

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({
            error: "Download failed",
            details: "download exploded",
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
            success: false,
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
            "/music"
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
        expect(errorRes.body).toEqual({ error: "disconnect failed" });
    });
});
