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

class MockSegmentedSessionError extends Error {
    statusCode: number;
    code: string;

    constructor(message: string, statusCode: number, code: string) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
    }
}

const mockCreateLocalSession = jest.fn();
const mockGetAuthorizedSession = jest.fn();
const mockValidateSessionToken = jest.fn();
const mockHeartbeatSession = jest.fn();
const mockCreateHandoffSession = jest.fn();
const mockWaitForManifestReady = jest.fn();
const mockWaitForSegmentReady = jest.fn();
const mockGetRuntimeDrainState = jest.fn();

jest.mock("../../utils/runtimeLifecycle", () => ({
    getRuntimeDrainState: () => mockGetRuntimeDrainState(),
}));

jest.mock("../../services/segmented-streaming/sessionService", () => ({
    SEGMENTED_SESSION_TOKEN_QUERY_PARAM: "st",
    SegmentedSessionError: MockSegmentedSessionError,
    segmentedStreamingSessionService: {
        createLocalSession: (...args: unknown[]) => mockCreateLocalSession(...args),
        getAuthorizedSession: (...args: unknown[]) =>
            mockGetAuthorizedSession(...args),
        validateSessionToken: (...args: unknown[]) =>
            mockValidateSessionToken(...args),
        heartbeatSession: (...args: unknown[]) => mockHeartbeatSession(...args),
        createHandoffSession: (...args: unknown[]) =>
            mockCreateHandoffSession(...args),
        waitForManifestReady: (...args: unknown[]) =>
            mockWaitForManifestReady(...args),
        waitForSegmentReady: (...args: unknown[]) =>
            mockWaitForSegmentReady(...args),
    },
}));

import router from "../streaming";
import {
    SegmentedSessionError,
} from "../../services/segmented-streaming/sessionService";

function getHandler(method: "get" | "post", path: string) {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === path && entry.route?.methods?.[method],
    );
    if (!layer) {
        throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
    }
    return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createResponse() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        headers: new Map<string, string>(),
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.body = payload;
            return res;
        }),
        type: jest.fn(function () {
            return res;
        }),
        setHeader: jest.fn(function (name: string, value: string) {
            res.headers.set(name, value);
            return res;
        }),
        sendFile: jest.fn(function (filePath: string) {
            res.body = { filePath };
            return res;
        }),
    };
    return res;
}

describe("streaming route runtime", () => {
    const postSession = getHandler("post", "/v1/sessions");
    const getManifest = getHandler("get", "/v1/sessions/:sessionId/manifest.mpd");
    const getSegment = getHandler(
        "get",
        "/v1/sessions/:sessionId/segments/:segmentName",
    );
    const getSegmentAlias = getHandler(
        "get",
        "/v1/sessions/:sessionId/:segmentName([A-Za-z0-9_.-]+\\.(?:m4s|webm))",
    );
    const postHeartbeat = getHandler("post", "/v1/sessions/:sessionId/heartbeat");
    const postHandoff = getHandler("post", "/v1/sessions/:sessionId/handoff");
    const postClientMetric = getHandler("post", "/v1/client-metrics");

    beforeEach(() => {
        jest.clearAllMocks();
        mockCreateLocalSession.mockReset();
        mockGetAuthorizedSession.mockReset();
        mockValidateSessionToken.mockReset();
        mockHeartbeatSession.mockReset();
        mockCreateHandoffSession.mockReset();
        mockWaitForManifestReady.mockReset();
        mockWaitForSegmentReady.mockReset();
        mockGetRuntimeDrainState.mockReset();
        mockWaitForManifestReady.mockResolvedValue(undefined);
        mockWaitForSegmentReady.mockResolvedValue("/tmp/assets/chunk-0-00001.m4s");
        mockValidateSessionToken.mockImplementation(() => {});
        mockGetRuntimeDrainState.mockReturnValue(false);
    });

    it("returns 400 when session payload is invalid", async () => {
        const req = {
            user: { id: "user-1" },
            body: {},
        } as any;
        const res = createResponse();

        await postSession(req, res);

        expect(res.statusCode).toBe(400);
        expect(mockCreateLocalSession).not.toHaveBeenCalled();
    });

    it("rejects new segmented sessions while draining", async () => {
        mockGetRuntimeDrainState.mockReturnValue(true);

        const req = {
            user: { id: "user-1" },
            body: { trackId: "track-1" },
        } as any;
        const res = createResponse();

        await postSession(req, res);

        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({
            error: "Streaming service is draining",
            code: "STREAMING_DRAINING",
        });
        expect(mockCreateLocalSession).not.toHaveBeenCalled();
    });

    it("creates a segmented session for valid payloads", async () => {
        mockCreateLocalSession.mockResolvedValueOnce({
            sessionId: "session-1",
            manifestUrl: "/api/streaming/v1/sessions/session-1/manifest.mpd",
            expiresAt: "2099-01-01T00:00:00.000Z",
            engineHints: {
                protocol: "dash",
                sourceType: "local",
                recommendedEngine: "videojs",
            },
        });

        const req = {
            user: { id: "user-1" },
            body: { trackId: "track-1", desiredQuality: "high" },
        } as any;
        const res = createResponse();

        await postSession(req, res);

        expect(mockCreateLocalSession).toHaveBeenCalledWith({
            userId: "user-1",
            trackId: "track-1",
            desiredQuality: "high",
        });
        expect(res.statusCode).toBe(201);
        expect(res.body).toEqual(
            expect.objectContaining({
                sessionId: "session-1",
            }),
        );
    });

    it("rejects segmented session creation for non-local source types", async () => {
        const req = {
            user: { id: "user-1" },
            body: { trackId: "12345", sourceType: "tidal" },
        } as any;
        const res = createResponse();

        await postSession(req, res);

        expect(res.statusCode).toBe(400);
        expect(mockCreateLocalSession).not.toHaveBeenCalled();
    });

    it("maps service session errors on session creation", async () => {
        mockCreateLocalSession.mockRejectedValueOnce(
            new SegmentedSessionError("Track not found", 404, "TRACK_NOT_FOUND"),
        );

        const req = {
            user: { id: "user-1" },
            body: { trackId: "missing" },
        } as any;
        const res = createResponse();

        await postSession(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({
            error: "Track not found",
            code: "TRACK_NOT_FOUND",
        });
    });

    it("serves session manifest for authorized users", async () => {
        const session = {
            sessionId: "session-1",
            userId: "user-1",
            trackId: "track-1",
            quality: "medium",
            sourceType: "local",
            cacheKey: "cache-1",
            manifestPath: "/tmp/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2099-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:05:00.000Z",
        };
        mockGetAuthorizedSession.mockResolvedValueOnce(session);

        const req = {
            user: { id: "user-1" },
            params: { sessionId: "session-1" },
            query: { st: "token-1" },
        } as any;
        const res = createResponse();

        await getManifest(req, res);

        expect(mockGetAuthorizedSession).toHaveBeenCalledWith("session-1", "user-1");
        expect(mockValidateSessionToken).toHaveBeenCalledWith(session, "token-1", {
            allowSessionIdMismatch: true,
        });
        expect(mockWaitForManifestReady).toHaveBeenCalledWith(session);
        expect(res.sendFile).toHaveBeenCalledWith("/tmp/manifest.mpd");
    });

    it("returns token validation errors for manifest access", async () => {
        const session = {
            sessionId: "session-1",
            userId: "user-1",
            trackId: "track-1",
            quality: "medium",
            sourceType: "local",
            cacheKey: "cache-1",
            manifestPath: "/tmp/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2099-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:05:00.000Z",
        };
        mockGetAuthorizedSession.mockResolvedValueOnce(session);
        mockValidateSessionToken.mockImplementationOnce(() => {
            throw new SegmentedSessionError(
                "Session token is required",
                401,
                "STREAMING_SESSION_TOKEN_REQUIRED",
            );
        });

        const req = {
            user: { id: "user-1" },
            params: { sessionId: "session-1" },
            query: {},
        } as any;
        const res = createResponse();

        await getManifest(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({
            error: "Session token is required",
            code: "STREAMING_SESSION_TOKEN_REQUIRED",
        });
        expect(mockWaitForManifestReady).not.toHaveBeenCalled();
    });

    it("returns 404 when manifest session is not found", async () => {
        mockGetAuthorizedSession.mockResolvedValueOnce(null);

        const req = {
            user: { id: "user-1" },
            params: { sessionId: "missing" },
        } as any;
        const res = createResponse();

        await getManifest(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: "Streaming session not found" });
    });

    it("still serves manifest while draining for existing sessions", async () => {
        mockGetRuntimeDrainState.mockReturnValue(true);

        const session = {
            sessionId: "session-1",
            userId: "user-1",
            trackId: "track-1",
            quality: "medium",
            sourceType: "local",
            cacheKey: "cache-1",
            manifestPath: "/tmp/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2099-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:05:00.000Z",
        };
        mockGetAuthorizedSession.mockResolvedValueOnce(session);

        const req = {
            user: { id: "user-1" },
            params: { sessionId: "session-1" },
            query: { st: "token-1" },
        } as any;
        const res = createResponse();

        await getManifest(req, res);

        expect(mockGetAuthorizedSession).toHaveBeenCalledWith("session-1", "user-1");
        expect(mockValidateSessionToken).toHaveBeenCalledWith(session, "token-1", {
            allowSessionIdMismatch: true,
        });
        expect(mockWaitForManifestReady).toHaveBeenCalledWith(session);
        expect(res.sendFile).toHaveBeenCalledWith("/tmp/manifest.mpd");
    });

    it("records heartbeat for authorized users", async () => {
        const session = {
            sessionId: "session-1",
            userId: "user-1",
            trackId: "track-1",
            quality: "medium",
            sourceType: "local",
            cacheKey: "cache-1",
            manifestPath: "/tmp/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2099-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:05:00.000Z",
        };
        mockGetAuthorizedSession.mockResolvedValueOnce(session);
        mockHeartbeatSession.mockResolvedValueOnce({
            sessionId: "session-1",
            sessionToken: "token-2",
            expiresAt: "2099-01-01T00:05:30.000Z",
        });

        const req = {
            user: { id: "user-1" },
            params: { sessionId: "session-1" },
            query: { st: "token-1" },
            body: { positionSec: 42, isPlaying: true },
        } as any;
        const res = createResponse();

        await postHeartbeat(req, res);

        expect(mockValidateSessionToken).toHaveBeenCalledWith(session, "token-1");
        expect(mockHeartbeatSession).toHaveBeenCalledWith(
            session,
            expect.objectContaining({
                positionSec: 42,
                isPlaying: true,
            }),
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual(
            expect.objectContaining({
                sessionToken: "token-2",
            }),
        );
    });

    it("creates handoff session for authorized users", async () => {
        const session = {
            sessionId: "session-1",
            userId: "user-1",
            trackId: "track-1",
            quality: "medium",
            sourceType: "local",
            cacheKey: "cache-1",
            manifestPath: "/tmp/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2099-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:05:00.000Z",
        };
        mockGetAuthorizedSession.mockResolvedValueOnce(session);
        mockCreateHandoffSession.mockResolvedValueOnce({
            sessionId: "session-2",
            manifestUrl: "/api/streaming/v1/sessions/session-2/manifest.mpd?st=token-2",
            sessionToken: "token-2",
            expiresAt: "2099-01-01T00:10:00.000Z",
            previousSessionId: "session-1",
            resumeAtSec: 120,
            shouldPlay: true,
            engineHints: {
                protocol: "dash",
                sourceType: "local",
                recommendedEngine: "videojs",
            },
        });

        const req = {
            user: { id: "user-1" },
            params: { sessionId: "session-1" },
            query: { st: "token-1" },
            body: { positionSec: 120, isPlaying: true },
        } as any;
        const res = createResponse();

        await postHandoff(req, res);

        expect(mockValidateSessionToken).toHaveBeenCalledWith(session, "token-1");
        expect(mockCreateHandoffSession).toHaveBeenCalledWith(
            session,
            expect.objectContaining({
                positionSec: 120,
                isPlaying: true,
            }),
        );
        expect(res.statusCode).toBe(201);
        expect(res.body).toEqual(
            expect.objectContaining({
                sessionId: "session-2",
                previousSessionId: "session-1",
                resumeAtSec: 120,
                shouldPlay: true,
            }),
        );
    });

    it("returns 400 for invalid heartbeat payloads", async () => {
        const req = {
            user: { id: "user-1" },
            params: { sessionId: "session-1" },
            query: { st: "token-1" },
            body: { positionSec: -1 },
        } as any;
        const res = createResponse();

        await postHeartbeat(req, res);

        expect(res.statusCode).toBe(400);
        expect(mockGetAuthorizedSession).not.toHaveBeenCalled();
        expect(mockHeartbeatSession).not.toHaveBeenCalled();
    });

    it("accepts segmented client signal metrics", async () => {
        const req = {
            user: { id: "user-1" },
            body: {
                event: "player.rebuffer",
                fields: {
                    sessionId: "session-1",
                    sourceType: "local",
                    trackId: "track-1",
                    reason: "heartbeat_stall",
                },
            },
        } as any;
        const res = createResponse();

        await postClientMetric(req, res);

        expect(res.statusCode).toBe(202);
        expect(res.body).toEqual({ accepted: true });
    });

    it("returns 400 for invalid segmented client signal payloads", async () => {
        const req = {
            user: { id: "user-1" },
            body: {
                event: "",
            },
        } as any;
        const res = createResponse();

        await postClientMetric(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Invalid request body",
            }),
        );
    });

    it("serves session segment for authorized users", async () => {
        const session = {
            sessionId: "session-1",
            userId: "user-1",
            trackId: "track-1",
            quality: "medium",
            sourceType: "local",
            cacheKey: "cache-1",
            manifestPath: "/tmp/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2099-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:05:00.000Z",
        };
        mockGetAuthorizedSession.mockResolvedValueOnce(session);
        const req = {
            user: { id: "user-1" },
            params: {
                sessionId: "session-1",
                segmentName: "chunk-0-00001.m4s",
            },
            query: { st: "token-1" },
        } as any;
        const res = createResponse();

        await getSegment(req, res);

        expect(mockValidateSessionToken).toHaveBeenCalledWith(session, "token-1", {
            allowSessionIdMismatch: true,
        });
        expect(mockWaitForSegmentReady).toHaveBeenCalledWith(
            session,
            "chunk-0-00001.m4s",
        );
        expect(res.sendFile).toHaveBeenCalledWith("/tmp/assets/chunk-0-00001.m4s");
    });

    it("maps invalid segment name errors", async () => {
        mockGetAuthorizedSession.mockResolvedValueOnce({
            sessionId: "session-1",
            userId: "user-1",
            trackId: "track-1",
            quality: "medium",
            sourceType: "local",
            manifestPath: "/tmp/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2099-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:05:00.000Z",
        });
        mockWaitForSegmentReady.mockImplementationOnce(() => {
            throw new SegmentedSessionError(
                "Invalid segment file name",
                400,
                "INVALID_SEGMENT_NAME",
            );
        });

        const req = {
            user: { id: "user-1" },
            params: {
                sessionId: "session-1",
                segmentName: "../etc/passwd",
            },
        } as any;
        const res = createResponse();

        await getSegment(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            error: "Invalid segment file name",
            code: "INVALID_SEGMENT_NAME",
        });
    });

    it("serves segment from manifest-relative alias route", async () => {
        const session = {
            sessionId: "session-1",
            userId: "user-1",
            trackId: "track-1",
            quality: "medium",
            sourceType: "local",
            cacheKey: "cache-1",
            manifestPath: "/tmp/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2099-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:05:00.000Z",
        };
        mockGetAuthorizedSession.mockResolvedValueOnce(session);
        mockWaitForSegmentReady.mockResolvedValueOnce("/tmp/assets/chunk-0-00002.m4s");

        const req = {
            user: { id: "user-1" },
            params: {
                sessionId: "session-1",
                segmentName: "chunk-0-00002.m4s",
            },
            query: { st: "token-1" },
            originalUrl: "/api/streaming/v1/sessions/session-1/chunk-0-00002.m4s?st=token-1",
        } as any;
        const res = createResponse();

        await getSegmentAlias(req, res);

        expect(mockValidateSessionToken).toHaveBeenCalledWith(session, "token-1", {
            allowSessionIdMismatch: true,
        });
        expect(mockWaitForSegmentReady).toHaveBeenCalledWith(
            session,
            "chunk-0-00002.m4s",
        );
        expect(res.sendFile).toHaveBeenCalledWith("/tmp/assets/chunk-0-00002.m4s");
        expect(res.type).toHaveBeenCalledWith("video/iso.segment");
    });

    it("serves legacy webm segment aliases for compatibility with older cached manifests", async () => {
        const session = {
            sessionId: "session-1",
            userId: "user-1",
            trackId: "track-1",
            quality: "original",
            sourceType: "local",
            cacheKey: "cache-1",
            manifestPath: "/tmp/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2099-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:05:00.000Z",
        };
        mockGetAuthorizedSession.mockResolvedValueOnce(session);
        mockWaitForSegmentReady.mockResolvedValueOnce("/tmp/assets/chunk-0-00002.webm");

        const req = {
            user: { id: "user-1" },
            params: {
                sessionId: "session-1",
                segmentName: "chunk-0-00002.webm",
            },
            query: { st: "token-1" },
            originalUrl: "/api/streaming/v1/sessions/session-1/chunk-0-00002.webm?st=token-1",
        } as any;
        const res = createResponse();

        await getSegmentAlias(req, res);

        expect(mockValidateSessionToken).toHaveBeenCalledWith(session, "token-1", {
            allowSessionIdMismatch: true,
        });
        expect(mockWaitForSegmentReady).toHaveBeenCalledWith(
            session,
            "chunk-0-00002.webm",
        );
        expect(res.type).toHaveBeenCalledWith("video/webm");
        expect(res.sendFile).toHaveBeenCalledWith("/tmp/assets/chunk-0-00002.webm");
    });
});
