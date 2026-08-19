import type { NextFunction, Request, Response } from "express";

const mockPlaybackRouteLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
const mockPlaybackMetricLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};
const mockPlaybackTraceLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
};

jest.mock("../../config", () => ({
    config: { streaming: { traceEnabled: true } },
}));

type AuthFailureMode = "ok" | "unauthorized";

const mockAuthFailureState = { mode: "ok" as AuthFailureMode };

const mockRequireAuth = jest.fn(
    (_req: Request, res: Response, next: NextFunction) => {
        if (mockAuthFailureState.mode === "unauthorized") {
            return res.status(401).json({ error: "Unauthorized" });
        }

        return next();
    },
);

jest.mock("../../middleware/auth", () => ({
    requireAuth: mockRequireAuth,
}));

jest.mock("../../utils/logger", () => ({
    logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn((scope: string) => {
            if (scope === "Playback") return mockPlaybackRouteLogger;
            if (scope === "Playback.Metric") return mockPlaybackMetricLogger;
            if (scope === "Playback.Trace") return mockPlaybackTraceLogger;
            throw new Error(`Unexpected logger scope: ${scope}`);
        }),
    },
}));

import router from "../streaming";

function getClientMetricsRoute() {
    const layer = (router as any).stack.find(
        (entry: any) =>
            entry.route?.path === "/v1/client-metrics" &&
            entry.route?.methods?.post,
    );
    if (!layer) {
        throw new Error("Client metrics route not found");
    }
    return layer.route;
}

function getClientMetricsHandler() {
    const route = getClientMetricsRoute();
    return route.stack[route.stack.length - 1].handle;
}

function createResponse() {
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

describe("playback client-signal route", () => {
    const postClientMetric = getClientMetricsHandler();

    beforeEach(() => {
        jest.clearAllMocks();
        mockAuthFailureState.mode = "ok";
    });

    it("rejects unauthenticated requests through the complete route chain", () => {
        mockAuthFailureState.mode = "unauthorized";
        const route = getClientMetricsRoute();
        const req = {
            method: "POST",
            url: "/v1/client-metrics",
            originalUrl: "/v1/client-metrics",
            baseUrl: "",
            body: { event: "player.engine_startup" },
        } as any;
        const res = createResponse();
        const next = jest.fn();

        expect(route.stack.map((layer: any) => layer.handle)).toContain(
            mockRequireAuth,
        );

        (router as any).handle(req, res, next);

        expect(mockRequireAuth).toHaveBeenCalledTimes(1);
        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Unauthorized" });
        expect(mockPlaybackMetricLogger.info).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
    });

    it("accepts native engine startup through the client-signal pipeline", async () => {
        const req = {
            user: { id: "user-1" },
            body: {
                event: "player.engine_startup",
                fields: {
                    engineMode: "native",
                    activeEngine: "native",
                    sourceType: "local",
                    trackId: "track-1",
                },
            },
        } as any;
        const res = createResponse();

        await postClientMetric(req, res);

        expect(res.statusCode).toBe(202);
        expect(res.body).toEqual({ accepted: true });
        expect(mockPlaybackMetricLogger.info).toHaveBeenCalledWith(
            "client.signal",
            expect.objectContaining({
                status: "success",
                event: "player.engine_startup",
                sourceType: "local",
                trackId: "track-1",
                userId: "user-1",
            }),
        );
        expect(mockPlaybackTraceLogger.info).toHaveBeenCalledWith(
            "playback.client.signal",
            expect.objectContaining({
                event: "player.engine_startup",
                userId: "user-1",
            }),
        );
    });

    it("keeps retired startup fields in the generic trace only", async () => {
        const fields = {
            outcome: "audible",
            loadId: 42,
            startupCorrelationId: "startup-42",
            totalToAudibleMs: 175,
        };
        const req = {
            user: { id: "user-1" },
            body: {
                event: "player.startup_timeline",
                fields,
            },
        } as any;
        const res = createResponse();

        await postClientMetric(req, res);

        expect(res.statusCode).toBe(202);
        const metricFields = mockPlaybackMetricLogger.info.mock.calls[0]?.[1];
        expect(metricFields).not.toHaveProperty("outcome");
        expect(metricFields).not.toHaveProperty("loadId");
        expect(metricFields).not.toHaveProperty("startupCorrelationId");
        expect(metricFields).not.toHaveProperty("totalToAudibleMs");
        expect(mockPlaybackTraceLogger.info).toHaveBeenCalledWith(
            "playback.client.signal",
            expect.objectContaining({ fields }),
        );
    });

    it("rejects unauthenticated client signals", async () => {
        const req = {
            body: { event: "player.engine_startup" },
        } as any;
        const res = createResponse();

        await postClientMetric(req, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ error: "Unauthorized" });
    });

    it("rejects malformed client signals", async () => {
        const req = {
            user: { id: "user-1" },
            body: { event: "" },
        } as any;
        const res = createResponse();

        await postClientMetric(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual(
            expect.objectContaining({
                error: "Invalid request body",
                details: expect.any(Object),
            }),
        );
    });

    it("returns 404 for the removed session surface", async () => {
        const req = {
            method: "POST",
            url: "/v1/sessions",
            originalUrl: "/v1/sessions",
            baseUrl: "",
        } as any;
        const res = { statusCode: 200 } as any;

        await new Promise<void>((resolve, reject) => {
            (router as any).handle(req, res, (error?: unknown) => {
                if (error) {
                    reject(error);
                    return;
                }
                res.statusCode = 404;
                resolve();
            });
        });

        expect(res.statusCode).toBe(404);
    });
});
