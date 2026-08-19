import { jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";

type RateLimitOptions = {
    windowMs: number;
    max: number;
    message: string;
    standardHeaders: boolean;
    legacyHeaders: boolean;
    validate: { trustProxy: boolean };
    store?: unknown;
    skipSuccessfulRequests?: boolean;
    skip?: (req: { path: string }) => boolean;
    keyGenerator?: (req: {
        ip: string;
        federationPeer?: { id: string };
    }) => string;
    handler?: (
        req: { ip: string; method: string; path: string },
        res: {
            status: (code: number) => {
                send: (message: string) => unknown;
                json: (body: unknown) => unknown;
            };
        },
        next: jest.Mock,
        options: { statusCode: number; message: string },
    ) => void;
};

type RateLimitHandlerResponse = {
    status: jest.MockedFunction<(code: number) => RateLimitHandlerResponse>;
    send: jest.MockedFunction<(message: string) => void>;
    json: jest.MockedFunction<(body: unknown) => void>;
};

const mockRateLimit = jest.fn((options: RateLimitOptions) => options);
const mockRateLimiterLoggerWarn = jest.fn();
const mockCreateRedisRateLimitOptions = jest.fn(
    (name: string, options?: { fallback?: "memory" | "open" }) => ({
        store: `redis:${name}`,
        passOnStoreError: true,
        fallback: options?.fallback,
    }),
);

jest.mock("../../utils/logger", () => ({
    logger: {
        warn: (...args: unknown[]) => mockRateLimiterLoggerWarn(...args),
    },
}));

describe("rateLimiter middleware config", () => {
    async function loadRateLimiterModule() {
        jest.resetModules();
        mockRateLimit.mockClear();
        mockRateLimiterLoggerWarn.mockClear();
        mockCreateRedisRateLimitOptions.mockClear();

        jest.doMock("express-rate-limit", () => ({
            __esModule: true,
            default: (options: RateLimitOptions) => mockRateLimit(options),
        }));
        jest.doMock("../rateLimitStore", () => ({
            createRedisRateLimitOptions: mockCreateRedisRateLimitOptions,
        }));

        return import("../rateLimiter");
    }

    function getOptions(index: number): RateLimitOptions {
        return mockRateLimit.mock.calls[index][0] as RateLimitOptions;
    }

    it("creates each limiter with the documented window and max values", async () => {
        const mod = await loadRateLimiterModule();

        expect(mockRateLimit).toHaveBeenCalledTimes(16);
        expect(mod.apiLimiter).toBeDefined();
        expect(mod.adminSurfaceLimiter).toBeDefined();
        expect(mod.shareLinkLimiter).toBeDefined();
        expect(mod.playbackStateLimiter).toBeDefined();
        expect(mod.authLimiter).toBeDefined();
        expect(mod.refreshLimiter).toBeDefined();
        expect(mod.oidcFlowLimiter).toBeDefined();
        expect(mod.imageLimiter).toBeDefined();
        expect(mod.downloadLimiter).toBeDefined();
        expect(mod.lyricsLimiter).toBeDefined();
        expect(mod.lyricsMutationLimiter).toBeDefined();
        expect(mod.ytMusicSearchLimiter).toBeDefined();
        expect(mod.ytMusicStreamLimiter).toBeDefined();
        expect(mod.webhookLimiter).toBeDefined();
        expect(mod.federationPeerLimiter).toBeDefined();
        expect(mod.federationPairingLimiter).toBeDefined();

        const expectedConfigs = [
            { index: 0, windowMs: 60_000, max: 5000 },
            { index: 1, windowMs: 60_000, max: 5000 },
            { index: 2, windowMs: 60_000, max: 5000 },
            { index: 3, windowMs: 60_000, max: 600 },
            { index: 4, windowMs: 900_000, max: 40 },
            { index: 5, windowMs: 300_000, max: 60 },
            { index: 6, windowMs: 900_000, max: 40 },
            { index: 7, windowMs: 60_000, max: 500 },
            { index: 8, windowMs: 60_000, max: 100 },
            { index: 9, windowMs: 60_000, max: 120 },
            { index: 10, windowMs: 900_000, max: 20 },
            { index: 11, windowMs: 60_000, max: 30 },
            { index: 12, windowMs: 60_000, max: 20 },
            { index: 13, windowMs: 60_000, max: 60 },
            { index: 14, windowMs: 60_000, max: 1000 },
            { index: 15, windowMs: 900_000, max: 20 },
        ];

        for (const config of expectedConfigs) {
            expect(getOptions(config.index)).toEqual(
                expect.objectContaining({
                    windowMs: config.windowMs,
                    max: config.max,
                }),
            );
        }

        expect(getOptions(4).skipSuccessfulRequests).toBe(true);
        expect(getOptions(5).skipSuccessfulRequests).toBe(true);
        expect(getOptions(6).skipSuccessfulRequests).not.toBe(true);
    });

    it.each([
        ["admin-surface", 1],
        ["share-link", 2],
        ["auth", 4],
        ["auth-refresh", 5],
        ["oidc-flow", 6],
        ["webhook", 13],
        ["federation-peer", 14],
        ["federation-pairing", 15],
    ])("uses the namespaced shared store for %s", async (name, index) => {
        await loadRateLimiterModule();

        expect(getOptions(index).store).toBe(`redis:${name}`);
    });

    it.each([
        "share-link",
        "auth",
        "auth-refresh",
        "oidc-flow",
        "webhook",
        "federation-pairing",
    ])("uses the memory fallback for the %s credential guard", async (name) => {
        await loadRateLimiterModule();

        expect(mockCreateRedisRateLimitOptions).toHaveBeenCalledWith(name, {
            fallback: "memory",
        });
    });

    it.each(["admin-surface", "federation-peer"])(
        "keeps the %s shared limiter availability-first",
        async (name) => {
            await loadRateLimiterModule();

            expect(mockCreateRedisRateLimitOptions).toHaveBeenCalledWith(name);
        },
    );

    it.each([
        ["general API", 0],
        ["playback state", 3],
        ["image", 7],
        ["download", 8],
        ["lyrics lookup", 9],
        ["lyrics mutation", 10],
        ["YouTube Music search", 11],
        ["YouTube Music stream", 12],
    ])("keeps the %s limiter in memory", async (_name, index) => {
        await loadRateLimiterModule();

        expect(getOptions(index).store).toBeUndefined();
    });

    it("keys authenticated federation limits by peer identity", async () => {
        await loadRateLimiterModule();
        const keyGenerator = getOptions(14).keyGenerator!;

        expect(
            keyGenerator({ ip: "10.0.0.1", federationPeer: { id: "peer-1" } }),
        ).toBe("peer-1");
        expect(keyGenerator({ ip: "10.0.0.1" })).toBe("unresolved-peer");
    });

    it("uses standard headers, disables legacy headers, and disables trustProxy validation for all limiters", async () => {
        await loadRateLimiterModule();

        for (const [options] of mockRateLimit.mock.calls) {
            expect(options).toEqual(
                expect.objectContaining({
                    standardHeaders: true,
                    legacyHeaders: false,
                    validate: { trustProxy: false },
                }),
            );
        }
    });

    it("apiLimiter skip function bypasses only intended health, streaming, and polling endpoints", async () => {
        await loadRateLimiterModule();
        const skip = getOptions(0).skip as (req: { path: string }) => boolean;

        expect(skip({ path: "/health" })).toBe(true);
        expect(skip({ path: "/api/health" })).toBe(true);
        expect(skip({ path: "/api/library/tracks/track-1/stream" })).toBe(true);
        expect(
            skip({ path: "/api/podcasts/podcast-1/episodes/episode-2/stream" }),
        ).toBe(true);
        expect(
            skip({
                path: "/api/soulseek/search/abc123de-adbe-4cab-9fed-1234567890ab",
            }),
        ).toBe(true);
        expect(skip({ path: "/api/spotify/import/job_123/status" })).toBe(
            false,
        );

        expect(skip({ path: "/health/check" })).toBe(false);
        expect(skip({ path: "/api/library/tracks/track-1/stream/extra" })).toBe(
            false,
        );
        expect(
            skip({
                path: "/api/podcasts/podcast-1/episodes/episode-2/download",
            }),
        ).toBe(false);
        expect(skip({ path: "/api/soulseek/search/ABC-123" })).toBe(false);
        expect(skip({ path: "/api/spotify/import/job_123/status/extra" })).toBe(
            false,
        );
        expect(skip({ path: "/api/other" })).toBe(false);
    });

    it("apiLimiter handler logs the offending request and sends the configured limit response", async () => {
        await loadRateLimiterModule();
        const handler = getOptions(0).handler as NonNullable<
            RateLimitOptions["handler"]
        >;
        const res = {} as RateLimitHandlerResponse;
        res.status = jest.fn((_: number) => res);
        res.send = jest.fn();
        res.json = jest.fn();

        handler(
            { ip: "10.0.0.1", method: "GET", path: "/api/library" },
            res,
            jest.fn(),
            {
                statusCode: 429,
                message:
                    "Too many requests from this IP, please try again later.",
            },
        );

        expect(mockRateLimiterLoggerWarn).toHaveBeenCalledWith(
            "API rate limit exceeded: 10.0.0.1 on GET /api/library",
        );
        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.send).toHaveBeenCalledWith(
            "Too many requests from this IP, please try again later.",
        );
    });

    it("authLimiter handler logs the client IP and sends the configured limit response", async () => {
        await loadRateLimiterModule();
        const handler = getOptions(4).handler as NonNullable<
            RateLimitOptions["handler"]
        >;
        const res = {} as RateLimitHandlerResponse;
        res.status = jest.fn((_: number) => res);
        res.send = jest.fn();
        res.json = jest.fn();

        handler(
            { ip: "10.0.0.2", method: "POST", path: "/api/auth/login" },
            res,
            jest.fn(),
            {
                statusCode: 429,
                message:
                    "Too many login attempts, please try again in 15 minutes.",
            },
        );

        expect(mockRateLimiterLoggerWarn).toHaveBeenCalledWith(
            "Auth rate limit exceeded: 10.0.0.2",
        );
        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.send).toHaveBeenCalledWith(
            "Too many login attempts, please try again in 15 minutes.",
        );
    });

    it("refreshLimiter returns the stable JSON rate-limit response", async () => {
        await loadRateLimiterModule();
        const handler = getOptions(5).handler as NonNullable<
            RateLimitOptions["handler"]
        >;
        const res = {} as RateLimitHandlerResponse;
        res.status = jest.fn((_: number) => res);
        res.send = jest.fn();
        res.json = jest.fn();

        handler(
            { ip: "10.0.0.3", method: "POST", path: "/api/auth/refresh" },
            res,
            jest.fn(),
            {
                statusCode: 429,
                message:
                    "Too many token refresh attempts. Please try again later.",
            },
        );

        expect(mockRateLimiterLoggerWarn).toHaveBeenCalledWith(
            "Refresh rate limit exceeded: 10.0.0.3",
        );
        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.json).toHaveBeenCalledWith({
            error: "Too many token refresh attempts. Please try again later.",
            code: "RATE_LIMITED",
        });
    });

    it("counts redirect responses against the OIDC flow limit", async () => {
        jest.resetModules();
        jest.dontMock("express-rate-limit");
        jest.doMock("../rateLimitStore", () => {
            const { MemoryStore } = jest.requireActual(
                "express-rate-limit",
            ) as {
                MemoryStore: new () => unknown;
            };
            return {
                createRedisRateLimitOptions: () => ({
                    store: new MemoryStore(),
                    passOnStoreError: true,
                }),
            };
        });
        const { oidcFlowLimiter } = await import("../rateLimiter");
        const runRedirect = async (): Promise<number> => {
            const req = {
                app: { get: () => false },
                headers: {},
                ip: "127.0.0.1",
                originalUrl: "/oidc",
                socket: { remoteAddress: "127.0.0.1" },
            } as unknown as Request & {
                rateLimit?: { remaining: number };
            };
            const res = {
                headersSent: false,
                statusCode: 302,
                setHeader: jest.fn(),
            } as unknown as Response;
            await new Promise<void>((resolve, reject) => {
                const next: NextFunction = (error?: unknown) => {
                    if (error) reject(error);
                    else resolve();
                };
                oidcFlowLimiter(req, res, next);
            });
            return req.rateLimit!.remaining;
        };

        const firstRemaining = await runRedirect();
        const secondRemaining = await runRedirect();

        expect(secondRemaining).toBe(firstRemaining - 1);
    });
});
