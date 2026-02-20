import path from "path";

const resolveCacheService = async () => {
    jest.resetModules();
    jest.doMock("../../../config", () => ({
        config: {
            music: {
                transcodeCachePath: "/tmp/transcode-cache",
            },
        },
    }));

    const module = await import("../cacheService");
    return module.segmentedStreamingCacheService;
};

describe("segmentedStreamingCacheService cache base path", () => {
    const originalSegmentedCachePath = process.env.SEGMENTED_STREAMING_CACHE_PATH;

    afterEach(() => {
        if (typeof originalSegmentedCachePath === "string") {
            process.env.SEGMENTED_STREAMING_CACHE_PATH = originalSegmentedCachePath;
        } else {
            delete process.env.SEGMENTED_STREAMING_CACHE_PATH;
        }
        jest.resetModules();
        jest.dontMock("../../../config");
    });

    it("defaults segmented cache base path to TRANSCODE_CACHE_PATH", async () => {
        delete process.env.SEGMENTED_STREAMING_CACHE_PATH;
        const cacheService = await resolveCacheService();

        const paths = cacheService.getDashAssetPaths("cache-key");
        expect(paths.outputDir).toBe(
            path.join("/tmp/transcode-cache", "segmented-dash", "cache-key"),
        );
        expect(paths.manifestPath).toBe(
            path.join(
                "/tmp/transcode-cache",
                "segmented-dash",
                "cache-key",
                "manifest.mpd",
            ),
        );
    });

    it("uses SEGMENTED_STREAMING_CACHE_PATH override when configured", async () => {
        process.env.SEGMENTED_STREAMING_CACHE_PATH = "/tmp/segmented-cache";
        const cacheService = await resolveCacheService();

        const paths = cacheService.getDashAssetPaths("cache-key");
        expect(paths.outputDir).toBe(
            path.join("/tmp/segmented-cache", "segmented-dash", "cache-key"),
        );
        expect(paths.manifestPath).toBe(
            path.join(
                "/tmp/segmented-cache",
                "segmented-dash",
                "cache-key",
                "manifest.mpd",
            ),
        );
    });
});
