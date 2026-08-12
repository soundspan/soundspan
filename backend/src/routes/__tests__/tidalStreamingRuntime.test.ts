jest.mock("../../middleware/auth", () => ({
    requireAuth: (_req: any, _res: any, next: () => void) => next(),
    requireAuthOrToken: (_req: any, _res: any, next: () => void) => next(),
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    },
}));

const tidalStreamingService = {
    isEnabled: jest.fn(),
    isAvailable: jest.fn(),
    getAuthStatus: jest.fn(),
    checkSidecarAuthStatus: jest.fn(),
    getUserPreferredQuality: jest.fn(),
    initiateDeviceAuth: jest.fn(),
    pollDeviceAuth: jest.fn(),
    restoreOAuth: jest.fn(),
    clearAuth: jest.fn(),
    search: jest.fn(),
    findMatchForTrack: jest.fn(),
    findMatchesForAlbum: jest.fn(),
    getStreamInfo: jest.fn(),
    getStreamProxy: jest.fn(),
};
jest.mock("../../services/tidalStreaming", () => ({
    tidalStreamingService,
}));

const prisma = {
    userSettings: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
    },
};
jest.mock("../../utils/db", () => ({
    prisma,
}));

const mockEncrypt = jest.fn((value: string) => `enc:${value}`);
const mockDecrypt = jest.fn((value: string) =>
    typeof value === "string" && value.startsWith("enc:")
        ? value.slice(4)
        : value,
);
jest.mock("../../utils/encryption", () => ({
    encrypt: mockEncrypt,
    decrypt: mockDecrypt,
}));

import { EventEmitter } from "node:events";
import router from "../tidalStreaming";

function getRouteLayer(
    path: string,
    method: "get" | "post" | "put" | "delete",
) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer)
        throw new Error(`${method.toUpperCase()} route not found: ${path}`);
    return layer;
}

function getLastHandler(
    path: string,
    method: "get" | "post" | "put" | "delete",
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
        end: jest.fn(),
        on: jest.fn(),
    };
    return res;
}

describe("tidal streaming route runtime", () => {
    const statusHandler = getLastHandler("/status", "get");
    const deviceCodeHandler = getLastHandler("/auth/device-code", "post");
    const pollHandler = getLastHandler("/auth/device-code/poll", "post");
    const saveTokenHandler = getLastHandler("/auth/save-token", "post");
    const clearAuthHandler = getLastHandler("/auth/clear", "post");
    const searchHandler = getLastHandler("/search", "post");
    const matchHandler = getLastHandler("/match", "post");
    const matchBatchHandler = getLastHandler("/match-batch", "post");
    const streamInfoHandler = getLastHandler("/stream-info/:trackId", "get");
    const streamHandler = getLastHandler("/stream/:trackId", "get");

    beforeEach(() => {
        jest.clearAllMocks();

        tidalStreamingService.isEnabled.mockResolvedValue(true);
        tidalStreamingService.isAvailable.mockResolvedValue(true);
        tidalStreamingService.getUserPreferredQuality.mockResolvedValue(
            "LOSSLESS",
        );
        tidalStreamingService.getAuthStatus.mockResolvedValue({
            authenticated: true,
            credentialsConfigured: true,
        });
        tidalStreamingService.initiateDeviceAuth.mockResolvedValue({
            device_code: "device-code",
            user_code: "user-code",
            verification_uri: "https://verify",
            verification_uri_complete: "https://verify/complete",
            expires_in: 600,
            interval: 5,
        });
        tidalStreamingService.pollDeviceAuth.mockResolvedValue(null);
        tidalStreamingService.restoreOAuth.mockResolvedValue(true);
        tidalStreamingService.clearAuth.mockResolvedValue(undefined);
        tidalStreamingService.search.mockResolvedValue({ tracks: [] });
        tidalStreamingService.findMatchForTrack.mockResolvedValue({
            id: 123,
            score: 0.98,
        });
        tidalStreamingService.findMatchesForAlbum.mockResolvedValue([
            { id: 1 },
            { id: 2 },
        ]);
        tidalStreamingService.getStreamInfo.mockResolvedValue({
            codec: "AAC",
            bitrate: 320,
        });
        tidalStreamingService.getStreamProxy.mockResolvedValue({
            status: 206,
            headers: {
                "content-type": "audio/aac",
                "content-range": "bytes 0-100/200",
            },
            data: {
                on: jest.fn(),
                pipe: jest.fn(),
            },
        });

        prisma.userSettings.findUnique.mockResolvedValue({
            userId: "u1",
            tidalOAuthJson: 'enc:{"access_token":"abc"}',
            tidalStreamingQuality: "LOSSLESS",
        });
        prisma.userSettings.upsert.mockResolvedValue({});
        prisma.userSettings.update.mockResolvedValue({});

        // Sidecar reports an existing in-memory session by default (F31: this
        // now flows through the authenticated tidalStreaming client).
        tidalStreamingService.checkSidecarAuthStatus.mockResolvedValue(true);
    });

    it("reports status and handles status errors", async () => {
        const req = { user: { id: "u1" } } as any;
        const res = createRes();
        await statusHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            enabled: true,
            available: true,
            authenticated: true,
            credentialsConfigured: true,
        });
        // Fifth call site (F31): the sidecar session probe goes through the
        // authenticated service client, not a bare axios.get.
        expect(
            tidalStreamingService.checkSidecarAuthStatus,
        ).toHaveBeenCalledWith("u1");

        tidalStreamingService.getAuthStatus.mockRejectedValueOnce(
            new Error("status failed"),
        );
        const errRes = createRes();
        await statusHandler(req, errRes);
        expect(errRes.statusCode).toBe(500);
    });

    it("restores user oauth during status checks when sidecar session is missing", async () => {
        tidalStreamingService.checkSidecarAuthStatus.mockResolvedValueOnce(
            false,
        );
        prisma.userSettings.findUnique.mockResolvedValueOnce({
            userId: "u1",
            tidalOAuthJson: 'enc:{"access_token":"abc"}',
            tidalStreamingQuality: "LOSSLESS",
        });

        const req = { user: { id: "u1" } } as any;
        const res = createRes();
        await statusHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            enabled: true,
            available: true,
            authenticated: true,
            credentialsConfigured: true,
        });
        expect(tidalStreamingService.restoreOAuth).toHaveBeenCalledWith(
            "u1",
            '{"access_token":"abc"}',
        );
    });

    it("coalesces concurrent missing-oauth lookups and preserves the unauthorized response", async () => {
        let resolveAuthStatus!: (authenticated: boolean) => void;
        tidalStreamingService.checkSidecarAuthStatus.mockReturnValueOnce(
            new Promise<boolean>((resolve) => {
                resolveAuthStatus = resolve;
            }),
        );
        prisma.userSettings.findUnique.mockResolvedValueOnce(null);
        const req = {
            user: { id: "concurrent-no-oauth" },
            body: { query: "hello" },
        } as any;
        const firstRes = createRes();
        const secondRes = createRes();

        const firstRequest = searchHandler(req, firstRes);
        const secondRequest = searchHandler(req, secondRes);
        await Promise.resolve();
        await Promise.resolve();
        expect(
            tidalStreamingService.checkSidecarAuthStatus,
        ).toHaveBeenCalledTimes(1);

        resolveAuthStatus(false);
        await Promise.all([firstRequest, secondRequest]);

        expect(prisma.userSettings.findUnique).toHaveBeenCalledTimes(1);
        expect(firstRes.statusCode).toBe(401);
        expect(secondRes.statusCode).toBe(401);
        expect(firstRes.body).toEqual({ error: "Not authenticated to TIDAL" });
        expect(secondRes.body).toEqual(firstRes.body);
    });

    it("keeps logout authoritative when a lazy oauth restore finishes late", async () => {
        let sidecarAuthenticated = false;
        let resolveRestore!: () => void;
        let markRestoreStarted!: () => void;
        const restoreStarted = new Promise<void>((resolve) => {
            markRestoreStarted = resolve;
        });
        const restoreGate = new Promise<void>((resolve) => {
            resolveRestore = resolve;
        });
        tidalStreamingService.checkSidecarAuthStatus.mockResolvedValueOnce(
            false,
        );
        tidalStreamingService.restoreOAuth.mockImplementationOnce(async () => {
            markRestoreStarted();
            await restoreGate;
            sidecarAuthenticated = true;
            return true;
        });
        tidalStreamingService.clearAuth.mockImplementation(async () => {
            sidecarAuthenticated = false;
        });
        const userId = "logout-restore-race";
        const searchRes = createRes();
        const clearRes = createRes();

        const searchRequest = searchHandler(
            { user: { id: userId }, body: { query: "hello" } } as any,
            searchRes,
        );
        await restoreStarted;
        const clearRequest = clearAuthHandler(
            { user: { id: userId } } as any,
            clearRes,
        );
        resolveRestore();
        await Promise.all([searchRequest, clearRequest]);

        expect(searchRes.statusCode).toBe(401);
        expect(searchRes.body).toEqual({ error: "Not authenticated to TIDAL" });
        expect(clearRes.body).toEqual({ success: true });
        expect(sidecarAuthenticated).toBe(false);
        expect(tidalStreamingService.search).not.toHaveBeenCalled();
    });

    it("does not persist a device poll that becomes stale before completion", async () => {
        let sidecarAuthenticated = false;
        let resolvePoll!: () => void;
        let markPollStarted!: () => void;
        const pollStarted = new Promise<void>((resolve) => {
            markPollStarted = resolve;
        });
        const pollGate = new Promise<void>((resolve) => {
            resolvePoll = resolve;
        });
        tidalStreamingService.pollDeviceAuth.mockImplementationOnce(
            async () => {
                markPollStarted();
                await pollGate;
                return {
                    access_token: "stale-access",
                    refresh_token: "stale-refresh",
                    user_id: "stale-user",
                    country_code: "US",
                    username: "stale-name",
                };
            },
        );
        tidalStreamingService.restoreOAuth.mockImplementation(async () => {
            sidecarAuthenticated = true;
            return true;
        });
        tidalStreamingService.clearAuth.mockImplementation(async () => {
            sidecarAuthenticated = false;
        });
        const userId = "logout-poll-race";
        const pollRes = createRes();
        const clearRes = createRes();

        const pollRequest = pollHandler(
            {
                user: { id: userId },
                body: { deviceCode: "device-code" },
            } as any,
            pollRes,
        );
        await pollStarted;
        const clearRequest = clearAuthHandler(
            { user: { id: userId } } as any,
            clearRes,
        );
        resolvePoll();
        await Promise.all([pollRequest, clearRequest]);

        expect(pollRes.body).toEqual({ status: "pending" });
        expect(clearRes.body).toEqual({ success: true });
        expect(prisma.userSettings.upsert).not.toHaveBeenCalled();
        expect(tidalStreamingService.restoreOAuth).not.toHaveBeenCalled();
        expect(sidecarAuthenticated).toBe(false);
    });

    it("does not persist a manual token save whose generation is stale", async () => {
        const userId = "logout-save-race";
        const saveRes = createRes();
        const clearRes = createRes();

        const saveRequest = saveTokenHandler(
            {
                user: { id: userId },
                body: { oauthJson: '{"access_token":"stale"}' },
            } as any,
            saveRes,
        );
        const clearRequest = clearAuthHandler(
            { user: { id: userId } } as any,
            clearRes,
        );
        await Promise.all([saveRequest, clearRequest]);

        expect(saveRes.body).toEqual({ success: false });
        expect(clearRes.body).toEqual({ success: true });
        expect(prisma.userSettings.upsert).not.toHaveBeenCalled();
        expect(tidalStreamingService.restoreOAuth).not.toHaveBeenCalled();
    });

    it("evaluates the tidal-enabled middleware for 404, 503, and success", async () => {
        const layer = getRouteLayer("/auth/device-code", "post");
        const middleware = layer.route.stack[1].handle;
        const req = {} as any;
        const res = createRes();
        const next = jest.fn();

        tidalStreamingService.isEnabled.mockResolvedValueOnce(false);
        await middleware(req, res, next);
        expect(res.statusCode).toBe(404);
        expect(next).not.toHaveBeenCalled();

        const resUnavailable = createRes();
        tidalStreamingService.isEnabled.mockResolvedValueOnce(true);
        tidalStreamingService.isAvailable.mockResolvedValueOnce(false);
        await middleware(req, resUnavailable, next);
        expect(resUnavailable.statusCode).toBe(503);

        const resOk = createRes();
        tidalStreamingService.isEnabled.mockResolvedValueOnce(true);
        tidalStreamingService.isAvailable.mockResolvedValueOnce(true);
        await middleware(req, resOk, next);
        expect(next).toHaveBeenCalled();
    });

    it("polls device auth with validation, pending, and success branches", async () => {
        const invalidReq = { user: { id: "u1" }, body: {} } as any;
        const invalidRes = createRes();
        await pollHandler(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);

        tidalStreamingService.pollDeviceAuth.mockResolvedValueOnce(null);
        const pendingReq = {
            user: { id: "u1" },
            body: { deviceCode: "device-code" },
        } as any;
        const pendingRes = createRes();
        await pollHandler(pendingReq, pendingRes);
        expect(pendingRes.statusCode).toBe(200);
        expect(pendingRes.body).toEqual({ status: "pending" });

        tidalStreamingService.pollDeviceAuth.mockResolvedValueOnce({
            access_token: "access",
            refresh_token: "refresh",
            user_id: "tidal-user",
            country_code: "US",
            username: "tidal-user-name",
        });
        const successReq = {
            user: { id: "u1" },
            body: { deviceCode: "device-code" },
        } as any;
        const successRes = createRes();
        await pollHandler(successReq, successRes);

        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            status: "success",
            username: "tidal-user-name",
            country_code: "US",
        });
        expect(prisma.userSettings.upsert).toHaveBeenCalled();
        expect(tidalStreamingService.restoreOAuth).toHaveBeenCalled();
    });

    it("sanitizes device auth poll failures", async () => {
        const req = {
            user: { id: "u1" },
            body: { deviceCode: "device-code" },
        } as any;

        tidalStreamingService.pollDeviceAuth.mockRejectedValueOnce(
            new Error("connect ECONNREFUSED 10.0.0.5:9999"),
        );
        const errorRes = createRes();
        await pollHandler(req, errorRes);

        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({
            status: "error",
            error: "Device-code poll failed",
        });
        expect(JSON.stringify(errorRes.body)).not.toContain("ECONNREFUSED");

        tidalStreamingService.pollDeviceAuth.mockRejectedValueOnce(
            "string-failure",
        );
        const stringErrorRes = createRes();
        await expect(pollHandler(req, stringErrorRes)).resolves.toBeUndefined();
        expect(stringErrorRes.statusCode).toBe(500);
        expect(stringErrorRes.body).toEqual({
            status: "error",
            error: "Device-code poll failed",
        });
    });

    it("saves and clears auth tokens", async () => {
        const invalidSaveReq = { user: { id: "u1" }, body: {} } as any;
        const invalidSaveRes = createRes();
        await saveTokenHandler(invalidSaveReq, invalidSaveRes);
        expect(invalidSaveRes.statusCode).toBe(400);

        const saveReq = {
            user: { id: "u1" },
            body: { oauthJson: '{"access_token":"x"}' },
        } as any;
        const saveRes = createRes();
        await saveTokenHandler(saveReq, saveRes);
        expect(saveRes.statusCode).toBe(200);
        expect(saveRes.body).toEqual({ success: true });
        expect(prisma.userSettings.upsert).toHaveBeenCalled();

        const clearReq = { user: { id: "u1" } } as any;
        const clearRes = createRes();
        await clearAuthHandler(clearReq, clearRes);
        expect(clearRes.statusCode).toBe(200);
        expect(clearRes.body).toEqual({ success: true });
        expect(prisma.userSettings.update).toHaveBeenCalledWith({
            where: { userId: "u1" },
            data: { tidalOAuthJson: null },
        });
    });

    it("searches and matches tracks with oauth restoration behavior", async () => {
        const invalidSearchReq = { user: { id: "u1" }, body: {} } as any;
        const invalidSearchRes = createRes();
        await searchHandler(invalidSearchReq, invalidSearchRes);
        expect(invalidSearchRes.statusCode).toBe(400);

        tidalStreamingService.checkSidecarAuthStatus.mockResolvedValueOnce(
            false,
        );
        prisma.userSettings.findUnique.mockResolvedValueOnce(null);
        const noAuthReq = {
            user: { id: "u1" },
            body: { query: "hello" },
        } as any;
        const noAuthRes = createRes();
        await searchHandler(noAuthReq, noAuthRes);
        expect(noAuthRes.statusCode).toBe(401);

        tidalStreamingService.checkSidecarAuthStatus.mockResolvedValueOnce(
            true,
        );
        const okSearchReq = {
            user: { id: "u1" },
            body: { query: "hello" },
        } as any;
        const okSearchRes = createRes();
        await searchHandler(okSearchReq, okSearchRes);
        expect(okSearchRes.statusCode).toBe(200);
        expect(okSearchRes.body).toEqual({ tracks: [] });

        const invalidMatchReq = {
            user: { id: "u1" },
            body: {},
        } as any;
        const invalidMatchRes = createRes();
        await matchHandler(invalidMatchReq, invalidMatchRes);
        expect(invalidMatchRes.statusCode).toBe(400);

        const okMatchReq = {
            user: { id: "u1" },
            body: { artist: "A", title: "T" },
        } as any;
        const okMatchRes = createRes();
        await matchHandler(okMatchReq, okMatchRes);
        expect(okMatchRes.statusCode).toBe(200);
        expect(okMatchRes.body.match).toEqual({ id: 123, score: 0.98 });
    });

    it("supports batch match and stream-info branches", async () => {
        const invalidBatchReq = { user: { id: "u1" }, body: {} } as any;
        const invalidBatchRes = createRes();
        await matchBatchHandler(invalidBatchReq, invalidBatchRes);
        expect(invalidBatchRes.statusCode).toBe(400);

        const batchReq = {
            user: { id: "u1" },
            body: { tracks: [{ artist: "A", title: "T" }] },
        } as any;
        const batchRes = createRes();
        await matchBatchHandler(batchReq, batchRes);
        expect(batchRes.statusCode).toBe(200);
        expect(batchRes.body).toEqual({ matches: [{ id: 1 }, { id: 2 }] });

        const invalidInfoReq = {
            user: { id: "u1" },
            params: { trackId: "abc" },
            query: {},
        } as any;
        const invalidInfoRes = createRes();
        await streamInfoHandler(invalidInfoReq, invalidInfoRes);
        expect(invalidInfoRes.statusCode).toBe(400);

        tidalStreamingService.checkSidecarAuthStatus.mockResolvedValueOnce(
            false,
        );
        prisma.userSettings.findUnique.mockResolvedValueOnce(null);
        const noAuthInfoReq = {
            user: { id: "u1" },
            params: { trackId: "42" },
            query: {},
        } as any;
        const noAuthInfoRes = createRes();
        await streamInfoHandler(noAuthInfoReq, noAuthInfoRes);
        expect(noAuthInfoRes.statusCode).toBe(401);

        const okInfoReq = {
            user: { id: "u1" },
            params: { trackId: "42" },
            query: { quality: "LOSSLESS" },
        } as any;
        const okInfoRes = createRes();
        await streamInfoHandler(okInfoReq, okInfoRes);
        expect(okInfoRes.statusCode).toBe(200);
        expect(okInfoRes.body).toEqual({ codec: "AAC", bitrate: 320 });
        expect(tidalStreamingService.getStreamInfo).toHaveBeenLastCalledWith(
            "u1",
            42,
            "LOSSLESS",
        );

        const defaultQualityReq = {
            user: { id: "u1" },
            params: { trackId: "43" },
            query: {},
        } as any;
        const defaultQualityRes = createRes();
        await streamInfoHandler(defaultQualityReq, defaultQualityRes);
        expect(defaultQualityRes.statusCode).toBe(200);
        expect(tidalStreamingService.getStreamInfo).toHaveBeenLastCalledWith(
            "u1",
            43,
            "LOSSLESS",
        );

        tidalStreamingService.getUserPreferredQuality.mockResolvedValueOnce(
            "HIGH",
        );
        const dbFallbackReq = {
            user: { id: "u1" },
            params: { trackId: "44" },
            query: {},
        } as any;
        const dbFallbackRes = createRes();
        await streamInfoHandler(dbFallbackReq, dbFallbackRes);
        expect(dbFallbackRes.statusCode).toBe(200);
        expect(tidalStreamingService.getStreamInfo).toHaveBeenLastCalledWith(
            "u1",
            44,
            "HIGH",
        );
    });

    it("proxies stream responses and handles invalid track IDs", async () => {
        const invalidReq = {
            user: { id: "u1" },
            params: { trackId: "NaN" },
            query: {},
            headers: {},
        } as any;
        const invalidRes = createRes();
        await streamHandler(invalidReq, invalidRes);
        expect(invalidRes.statusCode).toBe(400);

        const pipeMock = jest.fn();
        tidalStreamingService.getStreamProxy.mockResolvedValueOnce({
            status: 206,
            headers: {
                "content-type": "audio/aac",
                "content-range": "bytes 0-100/200",
            },
            data: { on: jest.fn(), pipe: pipeMock },
        });

        const req = {
            user: { id: "u1" },
            params: { trackId: "99" },
            query: {},
            headers: { range: "bytes=0-100" },
        } as any;
        const res = createRes();
        await streamHandler(req, res);

        expect(res.status).toHaveBeenCalledWith(206);
        expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "audio/aac");
        expect(res.setHeader).toHaveBeenCalledWith(
            "Content-Range",
            "bytes 0-100/200",
        );
        expect(pipeMock).toHaveBeenCalledWith(res);
    });

    it("destroys the upstream stream when the client disconnects", async () => {
        const data = {
            on: jest.fn(),
            pipe: jest.fn(),
            destroy: jest.fn(),
            destroyed: false,
        };
        tidalStreamingService.getStreamProxy.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data,
        });
        const req = {
            user: { id: "u1" },
            params: { trackId: "99" },
            query: {},
            headers: {},
        } as any;
        const res = createRes();

        await streamHandler(req, res);

        const closeHandler = res.on.mock.calls.find(
            ([event]: [string]) => event === "close",
        )?.[1];
        expect(closeHandler).toEqual(expect.any(Function));
        closeHandler();
        expect(data.destroy).toHaveBeenCalledTimes(1);

        data.destroyed = true;
        closeHandler();
        expect(data.destroy).toHaveBeenCalledTimes(1);
    });

    it("ends the response when the upstream stream errors after headers are sent", async () => {
        const data = Object.assign(new EventEmitter(), {
            pipe: jest.fn(),
            destroy: jest.fn(),
            destroyed: false,
        });
        tidalStreamingService.getStreamProxy.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data,
        });
        const req = {
            user: { id: "u1" },
            params: { trackId: "99" },
            query: {},
            headers: {},
        } as any;
        const res = createRes();
        res.headersSent = true;

        await streamHandler(req, res);

        expect(data.listenerCount("error")).toBeGreaterThan(0);
        expect(() =>
            data.emit("error", new Error("sidecar dropped")),
        ).not.toThrow();
        expect(res.end).toHaveBeenCalledTimes(1);
    });

    it("returns 502 when the upstream stream errors before headers are sent", async () => {
        const data = Object.assign(new EventEmitter(), {
            pipe: jest.fn(),
            destroy: jest.fn(),
            destroyed: false,
        });
        tidalStreamingService.getStreamProxy.mockResolvedValueOnce({
            status: 200,
            headers: {},
            data,
        });
        const req = {
            user: { id: "u1" },
            params: { trackId: "99" },
            query: {},
            headers: {},
        } as any;
        const res = createRes();

        await streamHandler(req, res);
        data.emit("error", new Error("sidecar dropped"));

        expect(res.statusCode).toBe(502);
        expect(res.body).toEqual({ error: "Upstream stream failed" });
    });

    it("initiates device auth and maps initiation errors", async () => {
        const req = { user: { id: "u1" } } as any;
        const successRes = createRes();
        await deviceCodeHandler(req, successRes);
        expect(successRes.statusCode).toBe(200);
        expect(successRes.body).toEqual({
            device_code: "device-code",
            user_code: "user-code",
            verification_uri: "https://verify",
            verification_uri_complete: "https://verify/complete",
            expires_in: 600,
            interval: 5,
        });

        tidalStreamingService.initiateDeviceAuth.mockRejectedValueOnce(
            new Error("device auth failed"),
        );
        const errorRes = createRes();
        await deviceCodeHandler(req, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({
            error: "Failed to initiate TIDAL auth",
        });
    });

    it("restores DB-stored credentials when sidecar auth status lookup fails", async () => {
        tidalStreamingService.checkSidecarAuthStatus.mockRejectedValueOnce(
            new Error("sidecar down"),
        );
        prisma.userSettings.findUnique.mockResolvedValueOnce({
            userId: "u1",
            tidalOAuthJson: 'enc:{"access_token":"abc"}',
            tidalStreamingQuality: "LOSSLESS",
        });

        const req = { user: { id: "u1" }, body: { query: "hello" } } as any;
        const res = createRes();
        await searchHandler(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ tracks: [] });
        expect(tidalStreamingService.restoreOAuth).toHaveBeenCalledWith(
            "u1",
            '{"access_token":"abc"}',
        );
    });

    it("maps search, matching, stream-info, and stream lookup failures", async () => {
        const reqBase = { user: { id: "u1" } } as any;

        tidalStreamingService.findMatchForTrack.mockRejectedValueOnce(
            new Error("match failed"),
        );
        const matchRes = createRes();
        await matchHandler(
            { ...reqBase, body: { artist: "A", title: "T" } },
            matchRes,
        );
        expect(matchRes.statusCode).toBe(500);
        expect(matchRes.body).toEqual({ error: "TIDAL match failed" });

        tidalStreamingService.findMatchesForAlbum.mockRejectedValueOnce(
            new Error("batch failed"),
        );
        const batchRes = createRes();
        await matchBatchHandler(
            {
                ...reqBase,
                body: { tracks: [{ artist: "A", title: "T" }] },
            },
            batchRes,
        );
        expect(batchRes.statusCode).toBe(500);
        expect(batchRes.body).toEqual({ error: "TIDAL batch match failed" });

        tidalStreamingService.getStreamInfo.mockRejectedValueOnce(
            new Error("stream info failed"),
        );
        const streamInfoReq = {
            ...reqBase,
            params: { trackId: "42" },
            query: {},
        } as any;
        const streamInfoRes = createRes();
        await streamInfoHandler(streamInfoReq, streamInfoRes);
        expect(streamInfoRes.statusCode).toBe(500);
        expect(streamInfoRes.body).toEqual({
            error: "Failed to get stream info",
        });

        tidalStreamingService.getStreamProxy.mockRejectedValueOnce(
            new Error("stream proxy failed"),
        );
        const streamReq = {
            ...reqBase,
            params: { trackId: "99" },
            query: {},
            headers: { range: "bytes=0-100" },
        } as any;
        const streamRes = createRes();
        await streamHandler(streamReq, streamRes);
        expect(streamRes.statusCode).toBe(500);
        expect(streamRes.body).toEqual({ error: "Stream failed" });
    });

    it("maps save and clear token failures", async () => {
        tidalStreamingService.restoreOAuth.mockRejectedValueOnce(
            new Error("restore failed"),
        );
        const saveRes = createRes();
        await saveTokenHandler(
            {
                user: { id: "u1" },
                body: { oauthJson: '{"access_token":"x"}' },
            },
            saveRes,
        );
        expect(saveRes.statusCode).toBe(500);
        expect(saveRes.body).toEqual({ error: "Failed to save TIDAL token" });

        tidalStreamingService.clearAuth.mockRejectedValueOnce(
            new Error("clear failed"),
        );
        const clearRes = createRes();
        await clearAuthHandler({ user: { id: "u1" } } as any, clearRes);
        expect(clearRes.statusCode).toBe(500);
        expect(clearRes.body).toEqual({ error: "Failed to clear TIDAL auth" });
    });
});
