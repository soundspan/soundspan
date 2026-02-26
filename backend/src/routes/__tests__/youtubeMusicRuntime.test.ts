import { Request, Response } from "express";

jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: Request, _res: Response, next: () => void) => next(),
    requireAuthOrToken: (
        _req: Request,
        _res: Response,
        next: () => void
    ) => next(),
}));

jest.mock("../../middleware/rateLimiter", () => ({
    ytMusicSearchLimiter: (
        _req: Request,
        _res: Response,
        next: () => void
    ) => next(),
    ytMusicStreamLimiter: (
        _req: Request,
        _res: Response,
        next: () => void
    ) => next(),
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
    isAvailable: jest.fn(),
    getAuthStatus: jest.fn(),
    restoreOAuthWithCredentials: jest.fn(),
    initiateDeviceAuth: jest.fn(),
    pollDeviceAuth: jest.fn(),
    clearAuth: jest.fn(),
    search: jest.fn(),
    searchCanonical: jest.fn(),
    getAlbum: jest.fn(),
    getArtist: jest.fn(),
    getSong: jest.fn(),
    getStreamInfo: jest.fn(),
    getStreamProxy: jest.fn(),
    getLibrarySongs: jest.fn(),
    getLibraryAlbums: jest.fn(),
    findMatchForTrack: jest.fn(),
    findMatchesForAlbum: jest.fn(),
};
const normalizeYtMusicStreamQuality = jest.fn(
    (quality: string | null | undefined) => {
        const normalized = quality?.trim().toLowerCase();
        return normalized === "low" ||
            normalized === "medium" ||
            normalized === "high" ||
            normalized === "lossless"
            ? normalized
            : undefined;
    }
);
jest.mock("../../services/youtubeMusic", () => ({
    ytMusicService,
    normalizeYtMusicStreamQuality,
}));

const mockGetSystemSettings = jest.fn();
jest.mock("../../utils/systemSettings", () => ({
    getSystemSettings: (...args: any[]) => mockGetSystemSettings(...args),
}));

const prisma = {
    userSettings: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({
    prisma,
}));

const mockEncrypt = jest.fn((value: string) => `enc:${value}`);
const mockDecrypt = jest.fn((value: string) =>
    typeof value === "string" && value.startsWith("enc:")
        ? value.slice(4)
        : value
);
jest.mock("../../utils/encryption", () => ({
    encrypt: (value: string) => mockEncrypt(value),
    decrypt: (value: string) => mockDecrypt(value),
}));

const mockRandomUUID = jest.fn(() => "search-id-1");
jest.mock("crypto", () => ({
    randomUUID: () => mockRandomUUID(),
}));

import router from "../youtubeMusic";

function getRouteLayer(
    path: string,
    method: "get" | "post" | "put" | "patch" | "delete"
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method]
    );
    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }
    return layer;
}

function getLastHandler(
    path: string,
    method: "get" | "post" | "put" | "patch" | "delete"
) {
    const layer = getRouteLayer(path, method);
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRes() {
    const headers: Record<string, string> = {};
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        headersSent: false,
        headers,
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            res.headersSent = true;
            return res;
        }),
        setHeader: jest.fn(function (key: string, value: string) {
            headers[key] = value;
            return res;
        }),
        end: jest.fn(function () {
            res.headersSent = true;
            return res;
        }),
    };
    return res;
}

describe("youtube music route runtime behavior", () => {
    const statusHandler = getLastHandler("/status", "get");
    const deviceCodeHandler = getLastHandler("/auth/device-code", "post");
    const pollDeviceCodeHandler = getLastHandler(
        "/auth/device-code/poll",
        "post"
    );
    const saveTokenHandler = getLastHandler("/auth/save-token", "post");
    const clearAuthHandler = getLastHandler("/auth/clear", "post");
    const searchHandler = getLastHandler("/search", "post");
    const albumHandler = getLastHandler("/album/:browseId", "get");
    const artistHandler = getLastHandler("/artist/:channelId", "get");
    const songHandler = getLastHandler("/song/:videoId", "get");
    const streamInfoHandler = getLastHandler("/stream-info/:videoId", "get");
    const streamHandler = getLastHandler("/stream/:videoId", "get");
    const librarySongsHandler = getLastHandler("/library/songs", "get");
    const libraryAlbumsHandler = getLastHandler("/library/albums", "get");
    const matchHandler = getLastHandler("/match", "post");
    const matchBatchHandler = getLastHandler("/match-batch", "post");

    beforeEach(() => {
        jest.clearAllMocks();

        mockGetSystemSettings.mockResolvedValue({
            ytMusicEnabled: true,
            ytMusicClientId: "client-id",
            ytMusicClientSecret: "client-secret",
        });

        ytMusicService.isAvailable.mockResolvedValue(true);
        ytMusicService.getAuthStatus.mockResolvedValue({ authenticated: true });
        ytMusicService.restoreOAuthWithCredentials.mockResolvedValue(undefined);
        ytMusicService.initiateDeviceAuth.mockResolvedValue({
            device_code: "device-code",
            user_code: "ABCD-EFGH",
        });
        ytMusicService.pollDeviceAuth.mockResolvedValue({
            status: "pending",
            error: undefined,
        });
        ytMusicService.clearAuth.mockResolvedValue(undefined);
        ytMusicService.searchCanonical.mockResolvedValue({
            query: "nina simone",
            filter: "songs",
            total: 0,
            results: [],
        });
        ytMusicService.getAlbum.mockResolvedValue({ id: "album-1" });
        ytMusicService.getArtist.mockResolvedValue({ id: "artist-1" });
        ytMusicService.getSong.mockResolvedValue({ id: "song-1" });
        ytMusicService.getStreamInfo.mockResolvedValue({
            videoId: "vid-1",
            abr: 192,
            acodec: "mp4a.40.2",
            duration: 200,
            content_type: "audio/webm",
        });
        ytMusicService.getStreamProxy.mockResolvedValue({
            status: 206,
            headers: {
                "content-type": "audio/webm",
                "content-length": "1024",
                "content-range": "bytes 0-1023/2048",
                "accept-ranges": "bytes",
            },
            data: {
                on: jest.fn(),
                pipe: jest.fn(),
            },
        });
        ytMusicService.getLibrarySongs.mockResolvedValue([{ id: "song-1" }]);
        ytMusicService.getLibraryAlbums.mockResolvedValue([{ id: "album-1" }]);
        ytMusicService.findMatchForTrack.mockResolvedValue({
            videoId: "match-1",
        });
        ytMusicService.findMatchesForAlbum.mockResolvedValue([
            { videoId: "m1" },
            { videoId: "m2" },
        ]);
        normalizeYtMusicStreamQuality.mockImplementation(
            (quality: string | null | undefined) => {
                const normalized = quality?.trim().toLowerCase();
                return normalized === "low" ||
                    normalized === "medium" ||
                    normalized === "high" ||
                    normalized === "lossless"
                    ? normalized
                    : undefined;
            }
        );

        prisma.userSettings.findUnique.mockResolvedValue({
            ytMusicOAuthJson: "enc:{\"access_token\":\"abc\"}",
        });
        prisma.userSettings.upsert.mockResolvedValue({});
    });

    it("evaluates enabled middleware branches", async () => {
        const layer = getRouteLayer("/auth/device-code", "post");
        const enabledMiddleware = layer.route.stack[1].handle;

        const disabledRes = createRes();
        const disabledNext = jest.fn();
        mockGetSystemSettings.mockResolvedValueOnce({ ytMusicEnabled: false });
        await enabledMiddleware({} as any, disabledRes, disabledNext);
        expect(disabledRes.statusCode).toBe(403);
        expect(disabledNext).not.toHaveBeenCalled();

        const errorRes = createRes();
        const errorNext = jest.fn();
        mockGetSystemSettings.mockRejectedValueOnce(new Error("settings failed"));
        await enabledMiddleware({} as any, errorRes, errorNext);
        expect(errorRes.statusCode).toBe(500);
        expect(errorNext).not.toHaveBeenCalled();

        const okRes = createRes();
        const okNext = jest.fn();
        mockGetSystemSettings.mockResolvedValueOnce({ ytMusicEnabled: true });
        await enabledMiddleware({} as any, okRes, okNext);
        expect(okNext).toHaveBeenCalledTimes(1);
    });

    it("handles status unavailable, oauth restore, and status errors", async () => {
        const req = { user: { id: "user-1" } } as any;

        ytMusicService.isAvailable.mockResolvedValueOnce(false);
        const unavailableRes = createRes();
        await statusHandler(req, unavailableRes);
        expect(unavailableRes.statusCode).toBe(200);
        expect(unavailableRes.body).toEqual({
            enabled: true,
            available: false,
            authenticated: false,
            credentialsConfigured: true,
        });

        ytMusicService.getAuthStatus
            .mockResolvedValueOnce({ authenticated: false })
            .mockResolvedValueOnce({ authenticated: true, tier: "premium" });
        prisma.userSettings.findUnique.mockResolvedValueOnce({
            ytMusicOAuthJson: "enc:{\"refresh_token\":\"r1\"}",
        });

        const restoredRes = createRes();
        await statusHandler(req, restoredRes);
        expect(ytMusicService.restoreOAuthWithCredentials).toHaveBeenCalledWith(
            "user-1",
            "{\"refresh_token\":\"r1\"}",
            "client-id",
            "client-secret"
        );
        expect(restoredRes.body).toEqual(
            expect.objectContaining({
                enabled: true,
                available: true,
                credentialsConfigured: true,
                authenticated: true,
                tier: "premium",
            })
        );

        mockGetSystemSettings.mockRejectedValueOnce(new Error("boom"));
        const errorRes = createRes();
        await statusHandler(req, errorRes);
        expect(errorRes.statusCode).toBe(500);
    });

    it("validates and initiates device auth with error fallback", async () => {
        const req = { user: { id: "user-1" } } as any;

        mockGetSystemSettings.mockResolvedValueOnce({
            ytMusicEnabled: true,
            ytMusicClientId: "",
            ytMusicClientSecret: "",
        });
        const missingCredsRes = createRes();
        await deviceCodeHandler(req, missingCredsRes);
        expect(missingCredsRes.statusCode).toBe(400);

        const okRes = createRes();
        await deviceCodeHandler(req, okRes);
        expect(okRes.statusCode).toBe(200);
        expect(ytMusicService.initiateDeviceAuth).toHaveBeenCalledWith(
            "client-id",
            "client-secret"
        );

        ytMusicService.initiateDeviceAuth.mockRejectedValueOnce({
            response: { data: { detail: "init failed" } },
        });
        const errorRes = createRes();
        await deviceCodeHandler(req, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "init failed" });
    });

    it("polls device auth with validation, pending, success, and error branches", async () => {
        const reqBase = { user: { id: "user-1" } } as any;

        const missingCodeRes = createRes();
        await pollDeviceCodeHandler(
            { ...reqBase, body: {} } as any,
            missingCodeRes
        );
        expect(missingCodeRes.statusCode).toBe(400);

        mockGetSystemSettings.mockResolvedValueOnce({
            ytMusicEnabled: true,
            ytMusicClientId: null,
            ytMusicClientSecret: null,
        });
        const missingCredsRes = createRes();
        await pollDeviceCodeHandler(
            { ...reqBase, body: { deviceCode: "dc-1" } } as any,
            missingCredsRes
        );
        expect(missingCredsRes.statusCode).toBe(400);

        const pendingRes = createRes();
        await pollDeviceCodeHandler(
            { ...reqBase, body: { deviceCode: "dc-1" } } as any,
            pendingRes
        );
        expect(pendingRes.statusCode).toBe(200);
        expect(pendingRes.body).toEqual({ status: "pending", error: undefined });

        ytMusicService.pollDeviceAuth.mockResolvedValueOnce({
            status: "success",
            oauth_json: "{\"access_token\":\"token-1\"}",
            error: null,
        });
        const successRes = createRes();
        await pollDeviceCodeHandler(
            { ...reqBase, body: { deviceCode: "dc-2" } } as any,
            successRes
        );
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({ status: "success", error: null });
        expect(prisma.userSettings.upsert).toHaveBeenCalledWith({
            where: { userId: "user-1" },
            create: {
                userId: "user-1",
                ytMusicOAuthJson: "enc:{\"access_token\":\"token-1\"}",
            },
            update: {
                ytMusicOAuthJson: "enc:{\"access_token\":\"token-1\"}",
            },
        });

        ytMusicService.pollDeviceAuth.mockRejectedValueOnce({
            response: { data: { detail: "poll failed" } },
        });
        const errorRes = createRes();
        await pollDeviceCodeHandler(
            { ...reqBase, body: { deviceCode: "dc-3" } } as any,
            errorRes
        );
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "poll failed" });
    });

    it("validates save-token payload and persists encrypted oauth", async () => {
        const reqBase = { user: { id: "user-1" } } as any;

        const missingBodyRes = createRes();
        await saveTokenHandler(
            { ...reqBase, body: {} } as any,
            missingBodyRes
        );
        expect(missingBodyRes.statusCode).toBe(400);

        const invalidJsonRes = createRes();
        await saveTokenHandler(
            { ...reqBase, body: { oauthJson: "not-json" } } as any,
            invalidJsonRes
        );
        expect(invalidJsonRes.statusCode).toBe(400);

        const successRes = createRes();
        await saveTokenHandler(
            {
                ...reqBase,
                body: { oauthJson: "{\"access_token\":\"ok\"}" },
            } as any,
            successRes
        );
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({ success: true });
        expect(prisma.userSettings.upsert).toHaveBeenCalledWith({
            where: { userId: "user-1" },
            create: {
                userId: "user-1",
                ytMusicOAuthJson: "enc:{\"access_token\":\"ok\"}",
            },
            update: {
                ytMusicOAuthJson: "enc:{\"access_token\":\"ok\"}",
            },
        });
        expect(ytMusicService.restoreOAuthWithCredentials).toHaveBeenCalledWith(
            "user-1",
            "{\"access_token\":\"ok\"}",
            "client-id",
            "client-secret"
        );

        ytMusicService.restoreOAuthWithCredentials.mockRejectedValueOnce({
            response: { data: { detail: "restore failed" } },
        });
        const errorRes = createRes();
        await saveTokenHandler(
            {
                ...reqBase,
                body: { oauthJson: "{\"access_token\":\"bad\"}" },
            } as any,
            errorRes
        );
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "restore failed" });
    });

    it("clears auth for sidecar and db and maps failures", async () => {
        const req = { user: { id: "user-1" } } as any;

        const successRes = createRes();
        await clearAuthHandler(req, successRes);
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({ success: true });
        expect(ytMusicService.clearAuth).toHaveBeenCalledWith("user-1");
        expect(prisma.userSettings.upsert).toHaveBeenCalledWith({
            where: { userId: "user-1" },
            create: { userId: "user-1", ytMusicOAuthJson: null },
            update: { ytMusicOAuthJson: null },
        });

        ytMusicService.clearAuth.mockRejectedValueOnce({
            response: { data: { detail: "clear failed" } },
        });
        const errorRes = createRes();
        await clearAuthHandler(req, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "clear failed" });
    });

    it("handles search validation, success, auth failures, and generic errors", async () => {
        const reqBase = { user: { id: "user-1" } } as any;

        const missingQueryRes = createRes();
        await searchHandler({ ...reqBase, body: {} } as any, missingQueryRes);
        expect(missingQueryRes.statusCode).toBe(400);

        const successRes = createRes();
        await searchHandler(
            { ...reqBase, body: { query: "nina simone", filter: "songs" } } as any,
            successRes
        );
        expect(successRes.statusCode).toBe(200);
        expect(ytMusicService.searchCanonical).toHaveBeenCalledWith(
            "user-1",
            "nina simone",
            "songs"
        );
        expect(successRes.body).toEqual(
            expect.objectContaining({
                query: "nina simone",
                filter: "songs",
                total: 0,
                results: [],
            })
        );

        ytMusicService.searchCanonical.mockRejectedValueOnce({
            response: { status: 401 },
        });
        const authErrorRes = createRes();
        await searchHandler(
            { ...reqBase, body: { query: "auth error test" } } as any,
            authErrorRes
        );
        expect(authErrorRes.statusCode).toBe(401);

        ytMusicService.searchCanonical.mockRejectedValueOnce({
            response: { data: { detail: "search crashed" } },
        });
        const errorRes = createRes();
        await searchHandler(
            { ...reqBase, body: { query: "generic error" } } as any,
            errorRes
        );
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "search crashed" });
    });

    it("covers album/artist/song auth and detail fallback branches", async () => {
        const reqBase = { user: { id: "user-1" } } as any;

        const albumRes = createRes();
        await albumHandler(
            { ...reqBase, params: { browseId: "alb-1" } } as any,
            albumRes
        );
        expect(albumRes.statusCode).toBe(200);
        expect(ytMusicService.getAlbum).toHaveBeenCalledWith("user-1", "alb-1");

        const artistRes = createRes();
        await artistHandler(
            { ...reqBase, params: { channelId: "artist-1" } } as any,
            artistRes
        );
        expect(artistRes.statusCode).toBe(200);
        expect(ytMusicService.getArtist).toHaveBeenCalledWith(
            "user-1",
            "artist-1"
        );

        ytMusicService.getAlbum.mockRejectedValueOnce({ response: { status: 401 } });
        const albumAuthErrorRes = createRes();
        await albumHandler(
            { ...reqBase, params: { browseId: "alb-1" } } as any,
            albumAuthErrorRes
        );
        expect(albumAuthErrorRes.statusCode).toBe(401);
        expect(albumAuthErrorRes.body).toEqual({
            error: "YouTube Music authentication expired or invalid. Please reconnect your account.",
        });

        ytMusicService.getAlbum.mockRejectedValueOnce({
            response: { data: { detail: "album failed to load" } },
        });
        const albumDetailRes = createRes();
        await albumHandler(
            { ...reqBase, params: { browseId: "alb-1" } } as any,
            albumDetailRes
        );
        expect(albumDetailRes.statusCode).toBe(500);
        expect(albumDetailRes.body).toEqual({ error: "album failed to load" });

        ytMusicService.getArtist.mockRejectedValueOnce({
            response: { status: 401 },
        });
        const artistAuthErrorRes = createRes();
        await artistHandler(
            { ...reqBase, params: { channelId: "artist-1" } } as any,
            artistAuthErrorRes
        );
        expect(artistAuthErrorRes.statusCode).toBe(401);
        expect(artistAuthErrorRes.body).toEqual({
            error: "YouTube Music authentication expired or invalid. Please reconnect your account.",
        });

        ytMusicService.getArtist.mockRejectedValueOnce({
            response: { data: { detail: "artist lookup failed" } },
        });
        const artistDetailRes = createRes();
        await artistHandler(
            { ...reqBase, params: { channelId: "artist-1" } } as any,
            artistDetailRes
        );
        expect(artistDetailRes.statusCode).toBe(500);
        expect(artistDetailRes.body).toEqual({ error: "artist lookup failed" });

        ytMusicService.getSong.mockRejectedValueOnce({ response: { status: 401 } });
        const songAuthErrorRes = createRes();
        await songHandler(
            { ...reqBase, params: { videoId: "song-1" } } as any,
            songAuthErrorRes
        );
        expect(songAuthErrorRes.statusCode).toBe(401);
        expect(songAuthErrorRes.body).toEqual({
            error: "YouTube Music authentication expired or invalid. Please reconnect your account.",
        });

        ytMusicService.getSong.mockRejectedValueOnce({
            response: { data: { detail: "song failed to load" } },
        });
        const songDetailRes = createRes();
        await songHandler(
            { ...reqBase, params: { videoId: "song-1" } } as any,
            songDetailRes
        );
        expect(songDetailRes.statusCode).toBe(500);
        expect(songDetailRes.body).toEqual({ error: "song failed to load" });
    });

    it("covers library albums auth and detail fallback branches", async () => {
        const reqBase = { user: { id: "user-1" } } as any;

        const albumsRes = createRes();
        await libraryAlbumsHandler(
            { ...reqBase, query: {} } as any,
            albumsRes
        );
        expect(albumsRes.statusCode).toBe(200);
        expect(albumsRes.body).toEqual({ albums: [{ id: "album-1" }] });

        ytMusicService.getLibraryAlbums.mockRejectedValueOnce({
            response: { status: 401 },
        });
        const albumsAuthErrorRes = createRes();
        await libraryAlbumsHandler(
            { ...reqBase, query: {} } as any,
            albumsAuthErrorRes
        );
        expect(albumsAuthErrorRes.statusCode).toBe(401);
        expect(albumsAuthErrorRes.body).toEqual({
            error: "YouTube Music authentication expired or invalid. Please reconnect your account.",
        });

        ytMusicService.getLibraryAlbums.mockRejectedValueOnce({
            response: { data: { detail: "library albums failed" } },
        });
        const albumsDetailRes = createRes();
        await libraryAlbumsHandler(
            { ...reqBase, query: {} } as any,
            albumsDetailRes
        );
        expect(albumsDetailRes.statusCode).toBe(500);
        expect(albumsDetailRes.body).toEqual({ error: "library albums failed" });
    });

    it("covers stream-info success and mapped error branches", async () => {
        const req = {
            user: { id: "user-1" },
            params: { videoId: "vid-1" },
            query: { quality: "high" },
        } as any;

        const successRes = createRes();
        await streamInfoHandler(req, successRes);
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            videoId: "vid-1",
            abr: 192,
            acodec: "mp4a.40.2",
            duration: 200,
            content_type: "audio/webm",
        });
        expect(ytMusicService.getStreamInfo).toHaveBeenCalledWith(
            "user-1",
            "vid-1",
            "high"
        );

        ytMusicService.getStreamInfo.mockRejectedValueOnce({
            response: { status: 404 },
        });
        const notFoundRes = createRes();
        await streamInfoHandler(req, notFoundRes);
        expect(notFoundRes.statusCode).toBe(404);

        ytMusicService.getStreamInfo.mockRejectedValueOnce({
            response: { status: 451 },
        });
        const ageRestrictedRes = createRes();
        await streamInfoHandler(req, ageRestrictedRes);
        expect(ageRestrictedRes.statusCode).toBe(451);

        ytMusicService.getStreamInfo.mockRejectedValueOnce({
            response: { status: 401 },
        });
        const authErrorRes = createRes();
        await streamInfoHandler(req, authErrorRes);
        expect(authErrorRes.statusCode).toBe(401);

        ytMusicService.getStreamInfo.mockRejectedValueOnce(new Error("stream info"));
        const errorRes = createRes();
        await streamInfoHandler(req, errorRes);
        expect(errorRes.statusCode).toBe(500);
    });

    it("falls back to user ytMusicQuality for stream-info and stream when request omits quality", async () => {
        prisma.userSettings.findUnique.mockResolvedValue({ ytMusicQuality: "LOW" });

        const streamInfoReq = {
            user: { id: "user-1" },
            params: { videoId: "vid-1" },
            query: {},
        } as any;
        const streamInfoRes = createRes();
        await streamInfoHandler(streamInfoReq, streamInfoRes);
        expect(streamInfoRes.statusCode).toBe(200);
        expect(ytMusicService.getStreamInfo).toHaveBeenCalledWith(
            "user-1",
            "vid-1",
            "low"
        );

        const streamReq = {
            user: { id: "user-1" },
            params: { videoId: "vid-1" },
            query: {},
            headers: {},
        } as any;
        const streamRes = createRes();
        await streamHandler(streamReq, streamRes);
        expect(streamRes.statusCode).toBe(206);
        expect(ytMusicService.getStreamProxy).toHaveBeenCalledWith(
            "user-1",
            "vid-1",
            "low",
            undefined
        );
    });

    it("proxies stream responses, handles upstream errors, and maps proxy exceptions", async () => {
        const reqBase = {
            user: { id: "user-1" },
            params: { videoId: "vid-1" },
            query: { quality: "medium" },
            headers: { range: "bytes=0-200" },
        } as any;

        type StreamMock = {
            on: jest.Mock;
            pipe: jest.Mock;
        };

        let onError: ((err: Error) => void) | undefined;
        const streamData: StreamMock = {
            on: jest.fn(),
            pipe: jest.fn(),
        };
        streamData.on.mockImplementation(
            (event: string, cb: (err: Error) => void) => {
                if (event === "error") onError = cb;
                return streamData;
            }
        );
        ytMusicService.getStreamProxy.mockResolvedValueOnce({
            status: 206,
            headers: {
                "content-type": "audio/webm",
                "content-length": "1200",
                "content-range": "bytes 0-199/1200",
                "accept-ranges": "bytes",
            },
            data: streamData,
        });

        const successRes = createRes();
        await streamHandler(reqBase, successRes);
        expect(successRes.statusCode).toBe(206);
        expect(successRes.headers["content-type"]).toBe("audio/webm");
        expect(streamData.pipe).toHaveBeenCalledWith(successRes);
        expect(ytMusicService.getStreamProxy).toHaveBeenCalledWith(
            "user-1",
            "vid-1",
            "medium",
            "bytes=0-200"
        );

        if (!onError) {
            throw new Error("Expected stream on(error) handler to be attached");
        }
        onError(new Error("upstream failed"));
        expect(successRes.statusCode).toBe(502);
        expect(successRes.body).toEqual({ error: "Upstream stream failed" });

        let onErrorHeadersSent: ((err: Error) => void) | undefined;
        const streamDataHeadersSent: StreamMock = {
            on: jest.fn(),
            pipe: jest.fn(),
        };
        streamDataHeadersSent.on.mockImplementation(
            (event: string, cb: (err: Error) => void) => {
                if (event === "error") onErrorHeadersSent = cb;
                return streamDataHeadersSent;
            }
        );
        ytMusicService.getStreamProxy.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data: streamDataHeadersSent,
        });
        const headersSentRes = createRes();
        headersSentRes.headersSent = true;
        await streamHandler(reqBase, headersSentRes);
        if (!onErrorHeadersSent) {
            throw new Error("Expected stream on(error) handler with headersSent");
        }
        onErrorHeadersSent(new Error("upstream failed again"));
        expect(headersSentRes.end).toHaveBeenCalledTimes(1);

        ytMusicService.getStreamProxy.mockRejectedValueOnce({
            response: { status: 404 },
        });
        const notFoundRes = createRes();
        await streamHandler(reqBase, notFoundRes);
        expect(notFoundRes.statusCode).toBe(404);

        ytMusicService.getStreamProxy.mockRejectedValueOnce({
            response: { status: 451 },
        });
        const ageRestrictedRes = createRes();
        await streamHandler(reqBase, ageRestrictedRes);
        expect(ageRestrictedRes.statusCode).toBe(451);

        ytMusicService.getStreamProxy.mockRejectedValueOnce({
            response: { status: 401 },
        });
        const authErrorRes = createRes();
        await streamHandler(reqBase, authErrorRes);
        expect(authErrorRes.statusCode).toBe(401);

        ytMusicService.getStreamProxy.mockRejectedValueOnce(new Error("proxy failed"));
        const errorRes = createRes();
        await streamHandler(reqBase, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({ error: "Failed to stream audio" });
    });

    it("handles library songs and albums retrieval with fallback errors", async () => {
        const reqBase = { user: { id: "user-1" } } as any;

        const songsRes = createRes();
        await librarySongsHandler(
            { ...reqBase, query: { limit: "25" } } as any,
            songsRes
        );
        expect(songsRes.statusCode).toBe(200);
        expect(songsRes.body).toEqual({ songs: [{ id: "song-1" }] });
        expect(ytMusicService.getLibrarySongs).toHaveBeenCalledWith("user-1", 25);

        const albumsRes = createRes();
        await libraryAlbumsHandler(
            { ...reqBase, query: {} } as any,
            albumsRes
        );
        expect(albumsRes.statusCode).toBe(200);
        expect(ytMusicService.getLibraryAlbums).toHaveBeenCalledWith("user-1", 100);

        ytMusicService.getLibrarySongs.mockRejectedValueOnce({
            response: { data: { detail: "library songs failed" } },
        });
        const songsErrorRes = createRes();
        await librarySongsHandler(
            { ...reqBase, query: {} } as any,
            songsErrorRes
        );
        expect(songsErrorRes.statusCode).toBe(500);
        expect(songsErrorRes.body).toEqual({ error: "library songs failed" });
    });

    it("covers match and match-batch validation, success, and failure paths", async () => {
        const reqBase = { user: { id: "user-1" } } as any;

        const invalidMatchRes = createRes();
        await matchHandler(
            { ...reqBase, body: { artist: "", title: "" } } as any,
            invalidMatchRes
        );
        expect(invalidMatchRes.statusCode).toBe(400);

        const matchRes = createRes();
        await matchHandler(
            {
                ...reqBase,
                body: {
                    artist: "Massive Attack",
                    title: "Teardrop",
                    albumTitle: "Mezzanine",
                    duration: 330,
                    isrc: "GBBKS9800363",
                },
            } as any,
            matchRes
        );
        expect(matchRes.statusCode).toBe(200);
        expect(matchRes.body).toEqual({ match: { videoId: "match-1" } });

        ytMusicService.findMatchForTrack.mockRejectedValueOnce(
            new Error("match failed")
        );
        const matchErrorRes = createRes();
        await matchHandler(
            {
                ...reqBase,
                body: { artist: "A", title: "B" },
            } as any,
            matchErrorRes
        );
        expect(matchErrorRes.statusCode).toBe(500);

        const invalidBatchRes = createRes();
        await matchBatchHandler(
            { ...reqBase, body: { tracks: [] } } as any,
            invalidBatchRes
        );
        expect(invalidBatchRes.statusCode).toBe(400);

        const batchRes = createRes();
        await matchBatchHandler(
            {
                ...reqBase,
                body: {
                    tracks: [
                        { artist: "Artist 1", title: "Track 1" },
                        { artist: "Artist 2", title: "Track 2", duration: 200 },
                    ],
                },
            } as any,
            batchRes
        );
        expect(batchRes.statusCode).toBe(200);
        expect(batchRes.body).toEqual({
            matches: [{ videoId: "m1" }, { videoId: "m2" }],
        });

        ytMusicService.findMatchesForAlbum.mockRejectedValueOnce(
            new Error("batch failed")
        );
        const batchErrorRes = createRes();
        await matchBatchHandler(
            {
                ...reqBase,
                body: {
                    tracks: [{ artist: "Artist 3", title: "Track 3" }],
                },
            } as any,
            batchErrorRes
        );
        expect(batchErrorRes.statusCode).toBe(500);
    });

    it("does not attempt OAuth restore/status checks for search endpoint", async () => {
        const req = {
            user: { id: "user-1" },
            body: { query: "nina simone" },
        } as any;
        const res = createRes();
        await searchHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(ytMusicService.getAuthStatus).not.toHaveBeenCalled();
        expect(ytMusicService.restoreOAuthWithCredentials).not.toHaveBeenCalled();
    });

    it("does not attempt OAuth restore/status checks for match endpoints", async () => {
        const reqBase = { user: { id: "user-1" } } as any;

        const matchRes = createRes();
        await matchHandler(
            {
                ...reqBase,
                body: { artist: "Massive Attack", title: "Teardrop" },
            } as any,
            matchRes
        );
        expect(matchRes.statusCode).toBe(200);

        const batchRes = createRes();
        await matchBatchHandler(
            {
                ...reqBase,
                body: {
                    tracks: [{ artist: "Artist 1", title: "Track 1" }],
                },
            } as any,
            batchRes
        );
        expect(batchRes.statusCode).toBe(200);
        expect(ytMusicService.getAuthStatus).not.toHaveBeenCalled();
        expect(ytMusicService.restoreOAuthWithCredentials).not.toHaveBeenCalled();
    });

    it("still maps sidecar 401 responses to unauthorized for search", async () => {
        ytMusicService.searchCanonical.mockRejectedValueOnce({
            response: { status: 401 },
        });
        const req = {
            user: { id: "user-1" },
            body: { query: "nina simone" },
        } as any;
        const res = createRes();
        await searchHandler(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({
            error: "YouTube Music authentication expired or invalid. Please reconnect your account.",
        });
    });
});
