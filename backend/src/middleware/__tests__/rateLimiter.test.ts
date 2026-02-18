const mockRateLimit = jest.fn((options: any) => options);

describe("rateLimiter middleware config", () => {
    async function loadRateLimiterModule() {
        jest.resetModules();
        mockRateLimit.mockClear();

        jest.doMock("express-rate-limit", () => ({
            __esModule: true,
            default: (options: unknown) => mockRateLimit(options),
        }));

        return import("../rateLimiter");
    }

    it("creates all expected limiter instances with trustProxy validation disabled", async () => {
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

        for (const [options] of mockRateLimit.mock.calls) {
            expect(options.validate).toEqual({ trustProxy: false });
            expect(options.standardHeaders).toBe(true);
            expect(options.legacyHeaders).toBe(false);
        }
    });

    it("uses documented thresholds/messages for each limiter", async () => {
        await loadRateLimiterModule();

        const [apiOptions] = mockRateLimit.mock.calls[0];
        const [authOptions] = mockRateLimit.mock.calls[1];
        const [imageOptions] = mockRateLimit.mock.calls[2];
        const [downloadOptions] = mockRateLimit.mock.calls[3];
        const [lyricsOptions] = mockRateLimit.mock.calls[4];
        const [lyricsMutationOptions] = mockRateLimit.mock.calls[5];
        const [ytSearchOptions] = mockRateLimit.mock.calls[6];
        const [ytStreamOptions] = mockRateLimit.mock.calls[7];

        expect(apiOptions.max).toBe(5000);
        expect(apiOptions.windowMs).toBe(60_000);
        expect(apiOptions.message).toContain("Too many requests");

        expect(authOptions.max).toBe(20);
        expect(authOptions.windowMs).toBe(900_000);
        expect(authOptions.skipSuccessfulRequests).toBe(true);

        expect(imageOptions.max).toBe(500);
        expect(downloadOptions.max).toBe(100);
        expect(lyricsOptions.max).toBe(120);
        expect(lyricsMutationOptions.max).toBe(20);
        expect(lyricsMutationOptions.windowMs).toBe(900_000);
        expect(ytSearchOptions.max).toBe(30);
        expect(ytStreamOptions.max).toBe(20);
    });

    it("apiLimiter skip function bypasses only intended endpoints", async () => {
        await loadRateLimiterModule();
        const [apiOptions] = mockRateLimit.mock.calls[0];
        const skip = apiOptions.skip as (req: { path: string }) => boolean;

        expect(skip({ path: "/health" })).toBe(true);
        expect(skip({ path: "/api/health" })).toBe(true);
        expect(skip({ path: "/api/library/tracks/abc/stream" })).toBe(true);
        expect(skip({ path: "/api/podcasts/p1/episodes/e2/stream" })).toBe(true);
        expect(skip({ path: "/api/soulseek/search/abc-123" })).toBe(true);
        expect(skip({ path: "/api/spotify/import/job_123/status" })).toBe(true);

        expect(skip({ path: "/api/soulseek/search/ABC-123" })).toBe(false);
        expect(skip({ path: "/api/library/tracks/abc/download" })).toBe(false);
        expect(skip({ path: "/api/spotify/import/job_123" })).toBe(false);
        expect(skip({ path: "/api/other" })).toBe(false);
    });
});

