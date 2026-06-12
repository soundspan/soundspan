import { jest } from "@jest/globals";

type RateLimitOptions = {
    windowMs: number;
    max: number;
    message: string;
    standardHeaders: boolean;
    legacyHeaders: boolean;
    validate: { trustProxy: boolean };
    skipSuccessfulRequests?: boolean;
    skip?: (req: { path: string }) => boolean;
    handler?: (
        req: { ip: string; method: string; path: string },
        res: { status: (code: number) => { send: (message: string) => unknown } },
        next: jest.Mock,
        options: { statusCode: number; message: string },
    ) => void;
};

type RateLimitHandlerResponse = {
    status: jest.MockedFunction<(code: number) => RateLimitHandlerResponse>;
    send: jest.MockedFunction<(message: string) => void>;
};

const mockRateLimit = jest.fn((options: RateLimitOptions) => options);
const mockRateLimiterLoggerWarn = jest.fn();

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

        jest.doMock("express-rate-limit", () => ({
            __esModule: true,
            default: (options: RateLimitOptions) => mockRateLimit(options),
        }));

        return import("../rateLimiter");
    }

    function getOptions(index: number): RateLimitOptions {
        return mockRateLimit.mock.calls[index][0] as RateLimitOptions;
    }

    it("creates each limiter with the documented window and max values", async () => {
        const mod = await loadRateLimiterModule();

        expect(mockRateLimit).toHaveBeenCalledTimes(8);
        expect(mod.apiLimiter).toBeDefined();
        expect(mod.authLimiter).toBeDefined();
        expect(mod.imageLimiter).toBeDefined();
        expect(mod.downloadLimiter).toBeDefined();
        expect(mod.lyricsLimiter).toBeDefined();
        expect(mod.lyricsMutationLimiter).toBeDefined();
        expect(mod.ytMusicSearchLimiter).toBeDefined();
        expect(mod.ytMusicStreamLimiter).toBeDefined();

        const expectedConfigs = [
            { index: 0, windowMs: 60_000, max: 5000 },
            { index: 1, windowMs: 900_000, max: 40 },
            { index: 2, windowMs: 60_000, max: 500 },
            { index: 3, windowMs: 60_000, max: 100 },
            { index: 4, windowMs: 60_000, max: 120 },
            { index: 5, windowMs: 900_000, max: 20 },
            { index: 6, windowMs: 60_000, max: 30 },
            { index: 7, windowMs: 60_000, max: 20 },
        ];

        for (const config of expectedConfigs) {
            expect(getOptions(config.index)).toEqual(
                expect.objectContaining({
                    windowMs: config.windowMs,
                    max: config.max,
                })
            );
        }

        expect(getOptions(1).skipSuccessfulRequests).toBe(true);
    });

    it("uses standard headers, disables legacy headers, and disables trustProxy validation for all limiters", async () => {
        await loadRateLimiterModule();

        for (const [options] of mockRateLimit.mock.calls) {
            expect(options).toEqual(
                expect.objectContaining({
                    standardHeaders: true,
                    legacyHeaders: false,
                    validate: { trustProxy: false },
                })
            );
        }
    });

    it("apiLimiter skip function bypasses only intended health, streaming, and polling endpoints", async () => {
        await loadRateLimiterModule();
        const skip = getOptions(0).skip as (req: { path: string }) => boolean;

        expect(skip({ path: "/health" })).toBe(true);
        expect(skip({ path: "/api/health" })).toBe(true);
        expect(skip({ path: "/api/library/tracks/track-1/stream" })).toBe(true);
        expect(skip({ path: "/api/podcasts/podcast-1/episodes/episode-2/stream" })).toBe(true);
        expect(skip({ path: "/api/soulseek/search/abc123de-adbe-4cab-9fed-1234567890ab" })).toBe(true);
        expect(skip({ path: "/api/spotify/import/job_123/status" })).toBe(true);

        expect(skip({ path: "/health/check" })).toBe(false);
        expect(skip({ path: "/api/library/tracks/track-1/stream/extra" })).toBe(false);
        expect(skip({ path: "/api/podcasts/podcast-1/episodes/episode-2/download" })).toBe(false);
        expect(skip({ path: "/api/soulseek/search/ABC-123" })).toBe(false);
        expect(skip({ path: "/api/spotify/import/job_123/status/extra" })).toBe(false);
        expect(skip({ path: "/api/other" })).toBe(false);
    });

    it("apiLimiter handler logs the offending request and sends the configured limit response", async () => {
        await loadRateLimiterModule();
        const handler = getOptions(0).handler as NonNullable<RateLimitOptions["handler"]>;
        const res = {} as RateLimitHandlerResponse;
        res.status = jest.fn((_: number) => res);
        res.send = jest.fn();

        handler(
            { ip: "10.0.0.1", method: "GET", path: "/api/library" },
            res,
            jest.fn(),
            { statusCode: 429, message: "Too many requests from this IP, please try again later." }
        );

        expect(mockRateLimiterLoggerWarn).toHaveBeenCalledWith(
            "API rate limit exceeded: 10.0.0.1 on GET /api/library"
        );
        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.send).toHaveBeenCalledWith(
            "Too many requests from this IP, please try again later."
        );
    });

    it("authLimiter handler logs the client IP and sends the configured limit response", async () => {
        await loadRateLimiterModule();
        const handler = getOptions(1).handler as NonNullable<RateLimitOptions["handler"]>;
        const res = {} as RateLimitHandlerResponse;
        res.status = jest.fn((_: number) => res);
        res.send = jest.fn();

        handler(
            { ip: "10.0.0.2", method: "POST", path: "/api/auth/login" },
            res,
            jest.fn(),
            { statusCode: 429, message: "Too many login attempts, please try again in 15 minutes." }
        );

        expect(mockRateLimiterLoggerWarn).toHaveBeenCalledWith(
            "Auth rate limit exceeded: 10.0.0.2"
        );
        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.send).toHaveBeenCalledWith(
            "Too many login attempts, please try again in 15 minutes."
        );
    });
});
