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
const mockSchedulePlaybackErrorRepair = jest.fn();
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
        schedulePlaybackErrorRepair: (...args: unknown[]) =>
            mockSchedulePlaybackErrorRepair(...args),
    },
}));

import router from "../streaming";
import {
    SegmentedSessionError,
} from "../../services/segmented-streaming/sessionService";
import { logger } from "../../utils/logger";

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
        headersSent: false,
        writableEnded: false,
        headers: new Map<string, string>(),
        status: jest.fn(function (code: number) {
            res.statusCode = code;
            return res;
        }),
        json: jest.fn(function (payload: unknown) {
            res.headersSent = true;
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
        end: jest.fn(function () {
            res.headersSent = true;
            res.writableEnded = true;
            return res;
        }),
        sendFile: jest.fn(function (
            filePath: string,
            callback?: (error?: NodeJS.ErrnoException) => void,
        ) {
            res.body = { filePath };
            callback?.();
            return res;
        }),
    };
    return res;
}

function findSegmentedMetricLogCall(
    event: "session.create" | "manifest.fetch" | "segment.fetch",
    status: "success" | "error" | "reject",
): [string, Record<string, unknown>] | undefined {
    return (logger.info as jest.Mock).mock.calls.find(
        (call: unknown[]) =>
            call[0] === `[SegmentedStreaming][Metric] ${event}` &&
            (call[1] as { status?: unknown } | undefined)?.status === status,
    ) as [string, Record<string, unknown>] | undefined;
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
        mockSchedulePlaybackErrorRepair.mockReset();
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
            startupHint: {
                stage: "session_create",
                state: "waiting",
                transient: true,
                reason: "runtime_draining",
                retryAfterMs: 1000,
            },
        });
        expect(res.headers.get("Retry-After")).toBe("1");
        expect(mockCreateLocalSession).not.toHaveBeenCalled();
    });

    it("creates a segmented session for valid payloads", async () => {
        mockCreateLocalSession.mockResolvedValueOnce({
            sessionId: "session-1",
            manifestUrl: "/api/streaming/v1/sessions/session-1/manifest.mpd",
            expiresAt: "2099-01-01T00:00:00.000Z",
            playbackProfile: {
                protocol: "dash",
                sourceType: "local",
                quality: "high",
                codec: "aac",
                bitrateKbps: 320,
            },
            engineHints: {
                protocol: "dash",
                sourceType: "local",
                recommendedEngine: "videojs",
            },
        });

        const req = {
            user: { id: "user-1" },
            body: { trackId: "track-1", desiredQuality: "high" },
            headers: {
                "x-segmented-startup-load-id": "42",
                "x-segmented-startup-correlation-id": "corr-track-1-42",
            },
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
        const metricCall = findSegmentedMetricLogCall("session.create", "success");
        expect(metricCall?.[1]).toEqual(
            expect.objectContaining({
                startupLoadId: 42,
                startupCorrelationId: "corr-track-1-42",
                quality: "high",
                requestedQuality: "high",
                qualitySource: "request",
            }),
        );
    });

    it("logs default quality metadata when desiredQuality is omitted", async () => {
        mockCreateLocalSession.mockResolvedValueOnce({
            sessionId: "session-default-quality",
            manifestUrl:
                "/api/streaming/v1/sessions/session-default-quality/manifest.mpd",
            expiresAt: "2099-01-01T00:00:00.000Z",
            playbackProfile: {
                protocol: "dash",
                sourceType: "local",
                codec: "aac",
                bitrateKbps: 192,
            },
            engineHints: {
                protocol: "dash",
                sourceType: "local",
                recommendedEngine: "videojs",
            },
        });

        const req = {
            user: { id: "user-1" },
            body: { trackId: "track-default-quality" },
        } as any;
        const res = createResponse();

        await postSession(req, res);

        expect(mockCreateLocalSession).toHaveBeenCalledWith({
            userId: "user-1",
            trackId: "track-default-quality",
            desiredQuality: undefined,
        });
        const metricCall = findSegmentedMetricLogCall("session.create", "success");
        expect(metricCall?.[1]).toEqual(
            expect.objectContaining({
                quality: "unknown",
                requestedQuality: null,
                qualitySource: "user_settings_or_default",
            }),
        );
        expect(res.statusCode).toBe(201);
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
            startupHint: {
                stage: "session_create",
                state: "failed",
                transient: false,
                reason: "track_not_found",
                retryAfterMs: null,
            },
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
            headers: {
                "x-segmented-startup-load-id": "7",
                "x-segmented-startup-correlation-id": "corr-track-1-7",
            },
        } as any;
        const res = createResponse();

        await getManifest(req, res);

        expect(mockGetAuthorizedSession).toHaveBeenCalledWith("session-1", "user-1");
        expect(mockValidateSessionToken).toHaveBeenCalledWith(session, "token-1", {
            allowSessionIdMismatch: true,
        });
        expect(mockWaitForManifestReady).toHaveBeenCalledWith(session);
        expect(res.sendFile).toHaveBeenCalledWith(
            "/tmp/manifest.mpd",
            expect.any(Function),
        );
        const metricCall = findSegmentedMetricLogCall("manifest.fetch", "success");
        expect(metricCall?.[1]).toEqual(
            expect.objectContaining({
                startupLoadId: 7,
                startupCorrelationId: "corr-track-1-7",
            }),
        );
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
            startupHint: {
                stage: "manifest",
                state: "blocked",
                transient: false,
                reason: "session_token_required",
                retryAfterMs: null,
            },
        });
        expect(res.headers.get("Retry-After")).toBeUndefined();
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
        expect(res.body).toEqual({
            error: "Streaming session not found",
            startupHint: {
                stage: "manifest",
                state: "failed",
                transient: false,
                reason: "session_not_found",
                retryAfterMs: null,
            },
        });
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
        expect(res.sendFile).toHaveBeenCalledWith(
            "/tmp/manifest.mpd",
            expect.any(Function),
        );
    });

    it("maps manifest sendFile callback ENOENT errors after readiness checks", async () => {
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
        res.sendFile.mockImplementationOnce(
            (_filePath: string, callback?: (error?: NodeJS.ErrnoException) => void) => {
                const error = Object.assign(new Error("manifest missing"), {
                    code: "ENOENT",
                }) as NodeJS.ErrnoException;
                callback?.(error);
                return res;
            },
        );

        await getManifest(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({
            error: "Manifest not found",
            startupHint: {
                stage: "manifest",
                state: "failed",
                transient: false,
                reason: "manifest_not_found",
                retryAfterMs: null,
            },
        });
        const metricCall = findSegmentedMetricLogCall("manifest.fetch", "error");
        expect(metricCall?.[1]).toEqual(
            expect.objectContaining({
                sessionId: "session-1",
                errorCode: "ENOENT",
            }),
        );
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
        expect(mockSchedulePlaybackErrorRepair).not.toHaveBeenCalled();
    });

    it("queues cache repair when player playback errors are reported", async () => {
        const req = {
            user: { id: "user-1" },
            body: {
                event: "player.playback_error",
                fields: {
                    sessionId: "session-9",
                    sourceType: "local",
                    trackId: "track-9",
                },
            },
        } as any;
        const res = createResponse();

        await postClientMetric(req, res);

        expect(res.statusCode).toBe(202);
        expect(mockSchedulePlaybackErrorRepair).toHaveBeenCalledWith({
            userId: "user-1",
            sessionId: "session-9",
            trackId: "track-9",
            sourceType: "local",
        });
    });

    it("queues cache repair when quarantined segments are reported", async () => {
        const req = {
            user: { id: "user-1" },
            body: {
                event: "player.segment_quarantined",
                fields: {
                    sessionId: "session-10",
                    sourceType: "local",
                    trackId: "track-10",
                    chunkName: "chunk-0-00069.m4s",
                },
            },
        } as any;
        const res = createResponse();

        await postClientMetric(req, res);

        expect(res.statusCode).toBe(202);
        expect(mockSchedulePlaybackErrorRepair).toHaveBeenCalledWith({
            userId: "user-1",
            sessionId: "session-10",
            trackId: "track-10",
            sourceType: "local",
        });
    });

    it("queues cache repair when prewarm validation failures are reported", async () => {
        const req = {
            user: { id: "user-1" },
            body: {
                event: "session.prewarm_validation_failed",
                fields: {
                    sessionId: "session-11",
                    sourceType: "local",
                    trackId: "track-11",
                    failedChunkName: "chunk-0-00001.m4s",
                },
            },
        } as any;
        const res = createResponse();

        await postClientMetric(req, res);

        expect(res.statusCode).toBe(202);
        expect(mockSchedulePlaybackErrorRepair).toHaveBeenCalledWith({
            userId: "user-1",
            sessionId: "session-11",
            trackId: "track-11",
            sourceType: "local",
        });
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
            headers: {
                "x-segmented-startup-load-id": "13",
                "x-segmented-startup-correlation-id": "corr-track-1-13",
            },
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
        expect(res.sendFile).toHaveBeenCalledWith(
            "/tmp/assets/chunk-0-00001.m4s",
            expect.any(Function),
        );
        const metricCall = findSegmentedMetricLogCall("segment.fetch", "success");
        expect(metricCall?.[1]).toEqual(
            expect.objectContaining({
                startupLoadId: 13,
                startupCorrelationId: "corr-track-1-13",
            }),
        );
    });

    it("serves fallback representation segments for authorized users", async () => {
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
        mockWaitForSegmentReady.mockResolvedValueOnce("/tmp/assets/chunk-1-00001.m4s");

        const req = {
            user: { id: "user-1" },
            params: {
                sessionId: "session-1",
                segmentName: "chunk-1-00001.m4s",
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
            "chunk-1-00001.m4s",
        );
        expect(res.type).toHaveBeenCalledWith("video/iso.segment");
        expect(res.sendFile).toHaveBeenCalledWith(
            "/tmp/assets/chunk-1-00001.m4s",
            expect.any(Function),
        );
    });

    it("maps segment sendFile callback ENOENT errors after readiness checks", async () => {
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
        res.sendFile.mockImplementationOnce(
            (_filePath: string, callback?: (error?: NodeJS.ErrnoException) => void) => {
                const error = Object.assign(new Error("segment missing"), {
                    code: "ENOENT",
                }) as NodeJS.ErrnoException;
                callback?.(error);
                return res;
            },
        );

        await getSegment(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({
            error: "Segment not found",
            startupHint: {
                stage: "segment",
                state: "failed",
                transient: false,
                reason: "segment_not_found",
                retryAfterMs: null,
            },
        });
        const metricCall = findSegmentedMetricLogCall("segment.fetch", "error");
        expect(metricCall?.[1]).toEqual(
            expect.objectContaining({
                sessionId: "session-1",
                segmentName: "chunk-0-00001.m4s",
                errorCode: "ENOENT",
            }),
        );
    });

    it("logs segment sendFile callback errors after headers are sent without forcing stream termination", async () => {
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
        res.sendFile.mockImplementationOnce(
            (_filePath: string, callback?: (error?: NodeJS.ErrnoException) => void) => {
                res.headersSent = true;
                const error = Object.assign(new Error("client aborted"), {
                    code: "EPIPE",
                }) as NodeJS.ErrnoException;
                callback?.(error);
                return res;
            },
        );

        await getSegment(req, res);

        expect(res.status).not.toHaveBeenCalled();
        expect(res.json).not.toHaveBeenCalled();
        expect(res.end).not.toHaveBeenCalled();
        const metricCall = findSegmentedMetricLogCall("segment.fetch", "error");
        expect(metricCall?.[1]).toEqual(
            expect.objectContaining({
                errorCode: "EPIPE",
            }),
        );
        expect(logger.error).toHaveBeenCalledWith(
            "[SegmentedStreaming] segment sendFile failed after headers were sent:",
            expect.any(Error),
        );
    });

    it("does not call res.end when segment sendFile fails after writable stream already ended", async () => {
        const session = {
            sessionId: "session-ended",
            userId: "user-1",
            trackId: "track-1",
            quality: "medium",
            sourceType: "local",
            cacheKey: "cache-ended",
            manifestPath: "/tmp/manifest-ended.mpd",
            assetDir: "/tmp/assets-ended",
            createdAt: "2099-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:05:00.000Z",
        };
        mockGetAuthorizedSession.mockResolvedValueOnce(session);
        mockWaitForSegmentReady.mockResolvedValueOnce(
            "/tmp/assets-ended/chunk-0-00001.m4s",
        );

        const req = {
            user: { id: "user-1" },
            params: {
                sessionId: "session-ended",
                segmentName: "chunk-0-00001.m4s",
            },
            query: { st: "token-ended" },
        } as any;
        const res = createResponse();
        res.sendFile.mockImplementationOnce(
            (_filePath: string, callback?: (error?: NodeJS.ErrnoException) => void) => {
                res.headersSent = true;
                res.writableEnded = true;
                const error = Object.assign(new Error("already ended"), {
                    code: "ECONNRESET",
                }) as NodeJS.ErrnoException;
                callback?.(error);
                return res;
            },
        );

        await getSegment(req, res);

        expect(res.end).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(
            "[SegmentedStreaming] segment sendFile failed after headers were sent:",
            expect.any(Error),
        );
    });

    it("returns transient startup hint while segment assets are still preparing", async () => {
        const session = {
            sessionId: "session-1",
            userId: "user-1",
            trackId: "track-1",
            quality: "medium",
            sourceType: "local",
            manifestPath: "/tmp/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2099-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:05:00.000Z",
        };
        mockGetAuthorizedSession.mockResolvedValueOnce(session);
        mockWaitForSegmentReady.mockImplementationOnce(() => {
            throw new SegmentedSessionError(
                "Segment is still being prepared",
                503,
                "STREAMING_ASSET_NOT_READY",
            );
        });

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

        expect(res.statusCode).toBe(503);
        expect(res.body).toEqual({
            error: "Segment is still being prepared",
            code: "STREAMING_ASSET_NOT_READY",
            startupHint: {
                stage: "segment",
                state: "waiting",
                transient: true,
                reason: "asset_not_ready",
                retryAfterMs: 1000,
            },
        });
        expect(res.headers.get("Retry-After")).toBe("1");
    });

    it("returns transient startup hint while segment asset build failures are being retried", async () => {
        const session = {
            sessionId: "session-1",
            userId: "user-1",
            trackId: "track-1",
            quality: "medium",
            sourceType: "local",
            manifestPath: "/tmp/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2099-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:05:00.000Z",
        };
        mockGetAuthorizedSession.mockResolvedValueOnce(session);
        mockWaitForSegmentReady.mockImplementationOnce(() => {
            throw new SegmentedSessionError(
                "Streaming segment build failed: spawn EAGAIN",
                502,
                "STREAMING_ASSET_BUILD_FAILED",
            );
        });

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

        expect(res.statusCode).toBe(502);
        expect(res.body).toEqual({
            error: "Streaming segment build failed: spawn EAGAIN",
            code: "STREAMING_ASSET_BUILD_FAILED",
            startupHint: {
                stage: "segment",
                state: "waiting",
                transient: true,
                reason: "asset_build_failed",
                retryAfterMs: 1000,
            },
        });
        expect(res.headers.get("Retry-After")).toBe("1");
    });

    it("returns non-transient startup hint for permanent segment asset build failures", async () => {
        const session = {
            sessionId: "session-1",
            userId: "user-1",
            trackId: "track-1",
            quality: "medium",
            sourceType: "local",
            manifestPath: "/tmp/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2099-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:05:00.000Z",
        };
        mockGetAuthorizedSession.mockResolvedValueOnce(session);
        mockWaitForSegmentReady.mockImplementationOnce(() => {
            throw new SegmentedSessionError(
                "Streaming segment build failed: invalid data found when processing input",
                502,
                "STREAMING_ASSET_BUILD_FAILED",
            );
        });

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

        expect(res.statusCode).toBe(502);
        expect(res.body).toEqual({
            error: "Streaming segment build failed: invalid data found when processing input",
            code: "STREAMING_ASSET_BUILD_FAILED",
            startupHint: {
                stage: "segment",
                state: "failed",
                transient: false,
                reason: "asset_build_failed",
                retryAfterMs: null,
            },
        });
        expect(res.headers.get("Retry-After")).toBeUndefined();
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
            startupHint: {
                stage: "segment",
                state: "failed",
                transient: false,
                reason: "invalid_segment_name",
                retryAfterMs: null,
            },
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
        expect(res.sendFile).toHaveBeenCalledWith(
            "/tmp/assets/chunk-0-00002.m4s",
            expect.any(Function),
        );
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
        expect(res.sendFile).toHaveBeenCalledWith(
            "/tmp/assets/chunk-0-00002.webm",
            expect.any(Function),
        );
    });

    it("accepts session tokens from header strings and header arrays", async () => {
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
        mockGetAuthorizedSession.mockResolvedValue(session);

        const stringHeaderReq = {
            user: { id: "user-1" },
            params: { sessionId: "session-1" },
            query: {},
            headers: { "x-streaming-session-token": "  token-header  " },
        } as any;
        const stringHeaderRes = createResponse();
        await getManifest(stringHeaderReq, stringHeaderRes);
        expect(mockValidateSessionToken).toHaveBeenCalledWith(session, "token-header", {
            allowSessionIdMismatch: true,
        });

        mockValidateSessionToken.mockClear();
        const arrayHeaderReq = {
            user: { id: "user-1" },
            params: { sessionId: "session-1" },
            query: {},
            headers: {
                "x-streaming-session-token": ["token-array", "ignored-token"],
                "x-segmented-startup-load-id": ["19", "20"],
                "x-segmented-startup-correlation-id": ["corr-array"],
            },
        } as any;
        const arrayHeaderRes = createResponse();
        await getManifest(arrayHeaderReq, arrayHeaderRes);
        expect(mockValidateSessionToken).toHaveBeenCalledWith(session, "token-array", {
            allowSessionIdMismatch: true,
        });
        const metricCall = (logger.info as jest.Mock).mock.calls.find(
            (call: unknown[]) =>
                call[0] === "[SegmentedStreaming][Metric] manifest.fetch" &&
                (call[1] as Record<string, unknown>)?.status === "success" &&
                (call[1] as Record<string, unknown>)?.startupLoadId === 19,
        ) as [string, Record<string, unknown>] | undefined;
        expect(metricCall?.[1]).toEqual(
            expect.objectContaining({
                startupLoadId: 19,
                startupCorrelationId: "corr-array",
            }),
        );
    });

    it("maps plain-object segmented errors and computes fallback startup hints", async () => {
        mockCreateLocalSession.mockRejectedValueOnce({
            message: "Rate limit reached",
            statusCode: 429,
            code: "SYNTH_RATE_LIMIT",
        });

        const req = {
            user: { id: "user-1" },
            body: { trackId: "track-1" },
        } as any;
        const res = createResponse();

        await postSession(req, res);

        expect(res.statusCode).toBe(429);
        expect(res.body).toEqual({
            error: "Rate limit reached",
            code: "SYNTH_RATE_LIMIT",
            startupHint: {
                stage: "session_create",
                state: "waiting",
                transient: true,
                reason: "synth_rate_limit",
                retryAfterMs: 1000,
            },
        });
        expect(res.headers.get("Retry-After")).toBe("1");
    });

    it("falls back to status-based startup reasons when segmented error codes normalize to empty", async () => {
        mockCreateLocalSession
            .mockRejectedValueOnce({
                message: "Rejected",
                statusCode: 400,
                code: "***",
            })
            .mockRejectedValueOnce({
                message: "Unavailable",
                statusCode: 503,
                code: "***",
            });

        const rejectedReq = {
            user: { id: "user-1" },
            body: { trackId: "track-rejected" },
        } as any;
        const rejectedRes = createResponse();
        await postSession(rejectedReq, rejectedRes);
        expect(rejectedRes.statusCode).toBe(400);
        expect(rejectedRes.body).toEqual({
            error: "Rejected",
            code: "***",
            startupHint: {
                stage: "session_create",
                state: "failed",
                transient: false,
                reason: "startup_rejected",
                retryAfterMs: null,
            },
        });

        const unavailableReq = {
            user: { id: "user-1" },
            body: { trackId: "track-unavailable" },
        } as any;
        const unavailableRes = createResponse();
        await postSession(unavailableReq, unavailableRes);
        expect(unavailableRes.statusCode).toBe(503);
        expect(unavailableRes.body).toEqual({
            error: "Unavailable",
            code: "***",
            startupHint: {
                stage: "session_create",
                state: "waiting",
                transient: true,
                reason: "startup_unavailable",
                retryAfterMs: 1000,
            },
        });
        expect(unavailableRes.headers.get("Retry-After")).toBe("1");
    });

    it("returns startup unauthorized hints when manifest access has no authenticated user", async () => {
        const req = {
            params: { sessionId: "session-1" },
            query: { st: "token-1" },
        } as any;
        const res = createResponse();

        await getManifest(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({
            error: "Unauthorized",
            startupHint: {
                stage: "manifest",
                state: "blocked",
                transient: false,
                reason: "unauthorized",
                retryAfterMs: null,
            },
        });
    });

    it("returns startup failure when manifest sendFile reports non-ENOENT errors", async () => {
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
        res.sendFile.mockImplementationOnce(
            (_filePath: string, callback?: (error?: NodeJS.ErrnoException) => void) => {
                const error = Object.assign(new Error("manifest fs failure"), {
                    code: "EIO",
                }) as NodeJS.ErrnoException;
                callback?.(error);
                return res;
            },
        );

        await getManifest(req, res);

        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            error: "Failed to load manifest",
            startupHint: {
                stage: "manifest",
                state: "failed",
                transient: false,
                reason: "manifest_load_failed",
                retryAfterMs: null,
            },
        });
    });

    it("maps segmented session errors raised by manifest sendFile callback", async () => {
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
        res.sendFile.mockImplementationOnce(
            (_filePath: string, callback?: (error?: NodeJS.ErrnoException) => void) => {
                callback?.(
                    new SegmentedSessionError(
                        "Manifest token expired",
                        403,
                        "STREAMING_SESSION_TOKEN_EXPIRED",
                    ) as unknown as NodeJS.ErrnoException,
                );
                return res;
            },
        );

        await getManifest(req, res);

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({
            error: "Manifest token expired",
            code: "STREAMING_SESSION_TOKEN_EXPIRED",
            startupHint: {
                stage: "manifest",
                state: "blocked",
                transient: false,
                reason: "session_token_expired",
                retryAfterMs: null,
            },
        });
    });

    it("maps manifest readiness ENOENT and unknown failures in the catch path", async () => {
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
        mockGetAuthorizedSession.mockResolvedValue(session);

        mockWaitForManifestReady.mockRejectedValueOnce(
            Object.assign(new Error("manifest missing"), { code: "ENOENT" }),
        );
        const enoentReq = {
            user: { id: "user-1" },
            params: { sessionId: "session-1" },
            query: { st: "token-1" },
        } as any;
        const enoentRes = createResponse();
        await getManifest(enoentReq, enoentRes);
        expect(enoentRes.statusCode).toBe(404);
        expect(enoentRes.body).toEqual({
            error: "Manifest not found",
            startupHint: {
                stage: "manifest",
                state: "failed",
                transient: false,
                reason: "manifest_not_found",
                retryAfterMs: null,
            },
        });

        mockWaitForManifestReady.mockRejectedValueOnce(
            new Error("manifest load exploded"),
        );
        const genericReq = {
            user: { id: "user-1" },
            params: { sessionId: "session-1" },
            query: { st: "token-1" },
        } as any;
        const genericRes = createResponse();
        await getManifest(genericReq, genericRes);
        expect(genericRes.statusCode).toBe(500);
        expect(genericRes.body).toEqual({
            error: "Failed to load manifest",
            startupHint: {
                stage: "manifest",
                state: "failed",
                transient: false,
                reason: "manifest_load_failed",
                retryAfterMs: null,
            },
        });
    });

    it("returns segment not-found and generic startup hints when segment readiness fails before sendFile", async () => {
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
        mockGetAuthorizedSession.mockResolvedValue(session);

        mockWaitForSegmentReady.mockRejectedValueOnce(
            Object.assign(new Error("segment missing"), { code: "ENOENT" }),
        );
        const missingReq = {
            user: { id: "user-1" },
            params: {
                sessionId: "session-1",
                segmentName: "chunk-0-00001.m4s",
            },
            query: { st: "token-1" },
        } as any;
        const missingRes = createResponse();
        await getSegment(missingReq, missingRes);
        expect(missingRes.statusCode).toBe(404);
        expect(missingRes.body).toEqual({
            error: "Segment not found",
            startupHint: {
                stage: "segment",
                state: "failed",
                transient: false,
                reason: "segment_not_found",
                retryAfterMs: null,
            },
        });

        mockWaitForSegmentReady.mockRejectedValueOnce(
            new Error("segment prep crashed"),
        );
        const genericReq = {
            user: { id: "user-1" },
            params: {
                sessionId: "session-1",
                segmentName: "chunk-0-00001.m4s",
            },
            query: { st: "token-1" },
        } as any;
        const genericRes = createResponse();
        await getSegment(genericReq, genericRes);
        expect(genericRes.statusCode).toBe(500);
        expect(genericRes.body).toEqual({
            error: "Failed to load segment",
            startupHint: {
                stage: "segment",
                state: "failed",
                transient: false,
                reason: "segment_load_failed",
                retryAfterMs: null,
            },
        });
    });

    it("returns segment session-not-found startup payload and logs reject trace context", async () => {
        mockGetAuthorizedSession.mockResolvedValueOnce(null);

        const req = {
            user: { id: "user-1" },
            params: {
                sessionId: "missing-session",
                segmentName: "chunk-0-00001.m4s",
            },
            query: { st: "token-1" },
        } as any;
        const res = createResponse();

        await getSegment(req, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({
            error: "Streaming session not found",
            startupHint: {
                stage: "segment",
                state: "failed",
                transient: false,
                reason: "session_not_found",
                retryAfterMs: null,
            },
        });
    });

    it("handles unauthorized and failure paths for heartbeat/handoff/client-metrics routes", async () => {
        const unauthorizedHeartbeatReq = {
            params: { sessionId: "session-1" },
            query: { st: "token-1" },
            body: { positionSec: 1 },
        } as any;
        const unauthorizedHeartbeatRes = createResponse();
        await postHeartbeat(unauthorizedHeartbeatReq, unauthorizedHeartbeatRes);
        expect(unauthorizedHeartbeatRes.statusCode).toBe(401);
        expect(unauthorizedHeartbeatRes.body).toEqual({ error: "Unauthorized" });

        const unauthorizedHandoffReq = {
            params: { sessionId: "session-1" },
            query: { st: "token-1" },
            body: { positionSec: 1 },
        } as any;
        const unauthorizedHandoffRes = createResponse();
        await postHandoff(unauthorizedHandoffReq, unauthorizedHandoffRes);
        expect(unauthorizedHandoffRes.statusCode).toBe(401);
        expect(unauthorizedHandoffRes.body).toEqual({ error: "Unauthorized" });

        const unauthorizedMetricReq = {
            body: { event: "player.rebuffer", fields: {} },
        } as any;
        const unauthorizedMetricRes = createResponse();
        await postClientMetric(unauthorizedMetricReq, unauthorizedMetricRes);
        expect(unauthorizedMetricRes.statusCode).toBe(401);
        expect(unauthorizedMetricRes.body).toEqual({ error: "Unauthorized" });

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
        mockGetAuthorizedSession.mockResolvedValue(session);
        mockHeartbeatSession.mockRejectedValueOnce(
            new SegmentedSessionError(
                "Heartbeat rejected",
                409,
                "HEARTBEAT_REJECTED",
            ),
        );
        const heartbeatRejectReq = {
            user: { id: "user-1" },
            params: { sessionId: "session-1" },
            query: { st: "token-1" },
            body: { positionSec: 3 },
        } as any;
        const heartbeatRejectRes = createResponse();
        await postHeartbeat(heartbeatRejectReq, heartbeatRejectRes);
        expect(heartbeatRejectRes.statusCode).toBe(409);
        expect(heartbeatRejectRes.body).toEqual({
            error: "Heartbeat rejected",
            code: "HEARTBEAT_REJECTED",
        });

        mockHeartbeatSession.mockRejectedValueOnce(new Error("heartbeat crashed"));
        const heartbeatErrorReq = {
            user: { id: "user-1" },
            params: { sessionId: "session-1" },
            query: { st: "token-1" },
            body: { positionSec: 3 },
        } as any;
        const heartbeatErrorRes = createResponse();
        await postHeartbeat(heartbeatErrorReq, heartbeatErrorRes);
        expect(heartbeatErrorRes.statusCode).toBe(500);
        expect(heartbeatErrorRes.body).toEqual({
            error: "Failed to process streaming heartbeat",
        });

        mockCreateHandoffSession.mockRejectedValueOnce(
            new SegmentedSessionError("Handoff blocked", 403, "HANDOFF_BLOCKED"),
        );
        const handoffRejectReq = {
            user: { id: "user-1" },
            params: { sessionId: "session-1" },
            query: { st: "token-1" },
            body: { positionSec: 10 },
        } as any;
        const handoffRejectRes = createResponse();
        await postHandoff(handoffRejectReq, handoffRejectRes);
        expect(handoffRejectRes.statusCode).toBe(403);
        expect(handoffRejectRes.body).toEqual({
            error: "Handoff blocked",
            code: "HANDOFF_BLOCKED",
        });

        mockCreateHandoffSession.mockRejectedValueOnce(new Error("handoff failed"));
        const handoffErrorReq = {
            user: { id: "user-1" },
            params: { sessionId: "session-1" },
            query: { st: "token-1" },
            body: { positionSec: 10 },
        } as any;
        const handoffErrorRes = createResponse();
        await postHandoff(handoffErrorReq, handoffErrorRes);
        expect(handoffErrorRes.statusCode).toBe(500);
        expect(handoffErrorRes.body).toEqual({
            error: "Failed to process streaming handoff",
        });
    });

    it("returns handoff validation errors and session-not-found responses for heartbeat/handoff", async () => {
        const invalidHandoffReq = {
            user: { id: "user-1" },
            params: { sessionId: "session-1" },
            query: { st: "token-1" },
            body: { positionSec: -1 },
        } as any;
        const invalidHandoffRes = createResponse();
        await postHandoff(invalidHandoffReq, invalidHandoffRes);
        expect(invalidHandoffRes.statusCode).toBe(400);
        expect(invalidHandoffRes.body).toEqual(
            expect.objectContaining({
                error: "Invalid request body",
            }),
        );

        mockGetAuthorizedSession.mockResolvedValueOnce(null);
        const heartbeatMissingReq = {
            user: { id: "user-1" },
            params: { sessionId: "missing-session" },
            query: { st: "token-1" },
            body: { positionSec: 1 },
        } as any;
        const heartbeatMissingRes = createResponse();
        await postHeartbeat(heartbeatMissingReq, heartbeatMissingRes);
        expect(heartbeatMissingRes.statusCode).toBe(404);
        expect(heartbeatMissingRes.body).toEqual({
            error: "Streaming session not found",
        });

        mockGetAuthorizedSession.mockResolvedValueOnce(null);
        const handoffMissingReq = {
            user: { id: "user-1" },
            params: { sessionId: "missing-session" },
            query: { st: "token-1" },
            body: { positionSec: 1 },
        } as any;
        const handoffMissingRes = createResponse();
        await postHandoff(handoffMissingReq, handoffMissingRes);
        expect(handoffMissingRes.statusCode).toBe(404);
        expect(handoffMissingRes.body).toEqual({
            error: "Streaming session not found",
        });
    });

    it("captures startup timeline fields and handles client-metric ingestion failures", async () => {
        const req = {
            user: { id: "user-1" },
            body: {
                event: "player.startup_timeline",
                fields: {
                    sessionId: "session-33",
                    sourceType: "local",
                    trackId: "track-33",
                    outcome: "success",
                    initSource: "cache",
                    firstChunkName: "chunk-0-00001.m4s",
                    startupCorrelationId: "corr-33",
                    cmcdObjectType: "video",
                    loadId: 33,
                    startupRetryCount: 2,
                    createLatencyMs: 25,
                    createToManifestMs: 40,
                    manifestToFirstChunkMs: 55,
                    firstChunkToAudibleMs: 65,
                    totalToAudibleMs: 120,
                    retryBudgetMax: 5,
                    retryBudgetRemaining: 2,
                    startupRecoveryWindowMs: 8000,
                    startupSessionResetsUsed: 1,
                    startupSessionResetsMax: 2,
                    invalidNumeric: "123",
                },
            },
        } as any;
        const res = createResponse();

        await postClientMetric(req, res);

        expect(res.statusCode).toBe(202);
        const metricCall = (logger.info as jest.Mock).mock.calls.find(
            (call: unknown[]) =>
                call[0] === "[SegmentedStreaming][Metric] client.signal" &&
                (call[1] as Record<string, unknown>)?.event ===
                    "player.startup_timeline",
        ) as [string, Record<string, unknown>] | undefined;
        expect(metricCall?.[1]).toEqual(
            expect.objectContaining({
                outcome: "success",
                initSource: "cache",
                firstChunkName: "chunk-0-00001.m4s",
                startupCorrelationId: "corr-33",
                cmcdObjectType: "video",
                loadId: 33,
                startupRetryCount: 2,
                createLatencyMs: 25,
                createToManifestMs: 40,
                manifestToFirstChunkMs: 55,
                firstChunkToAudibleMs: 65,
                totalToAudibleMs: 120,
                retryBudgetMax: 5,
                retryBudgetRemaining: 2,
                startupRecoveryWindowMs: 8000,
                startupSessionResetsUsed: 1,
                startupSessionResetsMax: 2,
            }),
        );
        expect(metricCall?.[1]).not.toHaveProperty("invalidNumeric");

        mockSchedulePlaybackErrorRepair.mockImplementationOnce(() => {
            throw new Error("repair queue unavailable");
        });
        const failingReq = {
            user: { id: "user-1" },
            body: {
                event: "player.playback_error",
                fields: {
                    sessionId: "session-err",
                    sourceType: "local",
                    trackId: "track-err",
                },
            },
        } as any;
        const failingRes = createResponse();
        await postClientMetric(failingReq, failingRes);

        expect(failingRes.statusCode).toBe(500);
        expect(failingRes.body).toEqual({ error: "Failed to ingest client signal" });
    });

    it("handles unauthorized session create and unknown session-create errors", async () => {
        const unauthorizedReq = {
            body: { trackId: "track-1" },
        } as any;
        const unauthorizedRes = createResponse();
        await postSession(unauthorizedReq, unauthorizedRes);
        expect(unauthorizedRes.statusCode).toBe(401);
        expect(unauthorizedRes.body).toEqual({
            error: "Unauthorized",
            startupHint: {
                stage: "session_create",
                state: "blocked",
                transient: false,
                reason: "unauthorized",
                retryAfterMs: null,
            },
        });

        mockCreateLocalSession.mockRejectedValueOnce(new Error("session create blew up"));
        const errorReq = {
            user: { id: "user-1" },
            body: { trackId: "track-1" },
        } as any;
        const errorRes = createResponse();
        await postSession(errorReq, errorRes);
        expect(errorRes.statusCode).toBe(500);
        expect(errorRes.body).toEqual({
            error: "Failed to create segmented streaming session",
            startupHint: {
                stage: "session_create",
                state: "failed",
                transient: false,
                reason: "session_create_failed",
                retryAfterMs: null,
            },
        });
    });
});
