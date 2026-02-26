import { promises as fsPromises } from "fs";
import os from "os";
import path from "path";

const SEGMENTED_ENV_KEYS = [
    "SEGMENTED_STREAMING_CACHE_PATH",
    "SEGMENTED_STREAMING_CACHE_MAX_GB",
    "SEGMENTED_STREAMING_CACHE_PRUNE_INTERVAL_MS",
    "SEGMENTED_STREAMING_CACHE_MIN_AGE_MS",
    "SEGMENTED_STREAMING_CACHE_PRUNE_TARGET_RATIO",
    "SEGMENTED_STREAMING_CACHE_SCHEMA_VERSION",
] as const;

const originalSegmentedEnv: Record<string, string | undefined> = {};
for (const envKey of SEGMENTED_ENV_KEYS) {
    originalSegmentedEnv[envKey] = process.env[envKey];
}

const defaultPruneResult = {
    inspectedEntries: 0,
    removedEntries: 0,
    skippedActiveEntries: 0,
    skippedRecentEntries: 0,
    totalBytesBefore: 0,
    totalBytesAfter: 0,
    maxBytes: 0,
};

const restoreSegmentedEnv = (): void => {
    for (const envKey of SEGMENTED_ENV_KEYS) {
        const value = originalSegmentedEnv[envKey];
        if (typeof value === "string") {
            process.env[envKey] = value;
        } else {
            delete process.env[envKey];
        }
    }
};

const resolveCacheService = async (transcodeCachePath = "/tmp/transcode-cache") => {
    jest.resetModules();
    jest.doMock("../../../config", () => ({
        config: {
            music: {
                transcodeCachePath,
                transcodeCacheMaxGb: 10,
            },
        },
    }));
    jest.doMock("../../../utils/logger", () => ({
        logger: {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        },
    }));

    const module = await import("../cacheService");
    return module.segmentedStreamingCacheService;
};

const createDashCacheEntry = async (params: {
    cacheRoot: string;
    cacheKey: string;
    sizeBytes: number;
    modifiedAtMs: number;
}): Promise<string> => {
    const outputDir = path.join(params.cacheRoot, "segmented-dash", params.cacheKey);
    await fsPromises.mkdir(outputDir, { recursive: true });
    const segmentPath = path.join(outputDir, "chunk-00001.m4s");
    await fsPromises.writeFile(segmentPath, Buffer.alloc(params.sizeBytes, 1));
    const modifiedAt = new Date(params.modifiedAtMs);
    await fsPromises.utimes(segmentPath, modifiedAt, modifiedAt);
    return outputDir;
};

const pathExists = async (targetPath: string): Promise<boolean> => {
    try {
        await fsPromises.access(targetPath);
        return true;
    } catch {
        return false;
    }
};

afterEach(() => {
    restoreSegmentedEnv();
    jest.useRealTimers();
    jest.resetModules();
    jest.dontMock("../../../config");
    jest.dontMock("../../../utils/logger");
});

describe("segmentedStreamingCacheService cache base path", () => {
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

describe("segmentedStreamingCacheService cache key versioning", () => {
    it("changes DASH cache keys when schema version changes", async () => {
        delete process.env.SEGMENTED_STREAMING_CACHE_SCHEMA_VERSION;
        const defaultVersionCacheService = await resolveCacheService();
        const defaultVersionKey = defaultVersionCacheService.buildDashCacheKey({
            trackId: "track-1",
            sourcePath: "/music/artist/track-1.flac",
            sourceModifiedIso: "2026-02-23T00:00:00.000Z",
            quality: "medium",
        });

        process.env.SEGMENTED_STREAMING_CACHE_SCHEMA_VERSION = "dash-v3-test";
        const overriddenVersionCacheService = await resolveCacheService();
        const overriddenVersionKey = overriddenVersionCacheService.buildDashCacheKey(
            {
                trackId: "track-1",
                sourcePath: "/music/artist/track-1.flac",
                sourceModifiedIso: "2026-02-23T00:00:00.000Z",
                quality: "medium",
            },
        );

        expect(defaultVersionKey).not.toBe(overriddenVersionKey);
    });
});

describe("segmentedStreamingCacheService pruning", () => {
    it("prunes oldest DASH cache entries until the prune target is met", async () => {
        const cacheRoot = await fsPromises.mkdtemp(
            path.join(os.tmpdir(), "segmented-cache-prune-"),
        );

        process.env.SEGMENTED_STREAMING_CACHE_PATH = cacheRoot;
        process.env.SEGMENTED_STREAMING_CACHE_MAX_GB = "0.0000018";
        process.env.SEGMENTED_STREAMING_CACHE_PRUNE_TARGET_RATIO = "0.5";
        process.env.SEGMENTED_STREAMING_CACHE_MIN_AGE_MS = "1000";

        const cacheService = await resolveCacheService();
        const now = Date.now();
        await createDashCacheEntry({
            cacheRoot,
            cacheKey: "oldest",
            sizeBytes: 800,
            modifiedAtMs: now - 600_000,
        });
        await createDashCacheEntry({
            cacheRoot,
            cacheKey: "middle",
            sizeBytes: 800,
            modifiedAtMs: now - 500_000,
        });
        await createDashCacheEntry({
            cacheRoot,
            cacheKey: "newest",
            sizeBytes: 800,
            modifiedAtMs: now - 400_000,
        });

        const result = await cacheService.pruneDashCacheIfNeeded();

        expect(result.inspectedEntries).toBe(3);
        expect(result.removedEntries).toBe(2);
        expect(result.skippedActiveEntries).toBe(0);
        expect(result.skippedRecentEntries).toBe(0);
        expect(result.totalBytesBefore).toBe(2400);
        expect(result.totalBytesAfter).toBe(800);
        expect(
            await pathExists(path.join(cacheRoot, "segmented-dash", "oldest")),
        ).toBe(false);
        expect(
            await pathExists(path.join(cacheRoot, "segmented-dash", "middle")),
        ).toBe(false);
        expect(
            await pathExists(path.join(cacheRoot, "segmented-dash", "newest")),
        ).toBe(true);

        await fsPromises.rm(cacheRoot, { recursive: true, force: true });
    });

    it("skips active and recent DASH cache entries during prune", async () => {
        const cacheRoot = await fsPromises.mkdtemp(
            path.join(os.tmpdir(), "segmented-cache-protect-"),
        );

        process.env.SEGMENTED_STREAMING_CACHE_PATH = cacheRoot;
        process.env.SEGMENTED_STREAMING_CACHE_MAX_GB = "0.000002";
        process.env.SEGMENTED_STREAMING_CACHE_PRUNE_TARGET_RATIO = "0.5";
        process.env.SEGMENTED_STREAMING_CACHE_MIN_AGE_MS = "600000";

        const cacheService = await resolveCacheService();
        const now = Date.now();
        await createDashCacheEntry({
            cacheRoot,
            cacheKey: "active-old",
            sizeBytes: 900,
            modifiedAtMs: now - 2 * 60 * 60 * 1000,
        });
        await createDashCacheEntry({
            cacheRoot,
            cacheKey: "removable-old",
            sizeBytes: 900,
            modifiedAtMs: now - 90 * 60 * 1000,
        });
        await createDashCacheEntry({
            cacheRoot,
            cacheKey: "recent",
            sizeBytes: 900,
            modifiedAtMs: now - 60 * 1000,
        });
        cacheService.registerSessionReference("active-old", "session-1");

        const result = await cacheService.pruneDashCacheIfNeeded();

        expect(result.inspectedEntries).toBe(3);
        expect(result.removedEntries).toBe(1);
        expect(result.skippedActiveEntries).toBe(1);
        expect(result.skippedRecentEntries).toBe(1);
        expect(result.totalBytesBefore).toBe(2700);
        expect(result.totalBytesAfter).toBe(1800);
        expect(
            await pathExists(path.join(cacheRoot, "segmented-dash", "active-old")),
        ).toBe(true);
        expect(
            await pathExists(path.join(cacheRoot, "segmented-dash", "removable-old")),
        ).toBe(false);
        expect(
            await pathExists(path.join(cacheRoot, "segmented-dash", "recent")),
        ).toBe(true);

        await fsPromises.rm(cacheRoot, { recursive: true, force: true });
    });
});

describe("segmentedStreamingCacheService prune scheduler", () => {
    it("does not overlap scheduled prune runs while one is in-flight", async () => {
        process.env.SEGMENTED_STREAMING_CACHE_PRUNE_INTERVAL_MS = "60000";
        const cacheService = await resolveCacheService();

        let resolvePrune:
            | ((value: typeof defaultPruneResult) => void)
            | undefined;
        const inFlightPrune = new Promise<typeof defaultPruneResult>((resolve) => {
            resolvePrune = resolve;
        });
        const pruneSpy = jest
            .spyOn(cacheService, "pruneDashCacheIfNeeded")
            .mockReturnValue(inFlightPrune);

        cacheService.scheduleDashCachePrune();
        cacheService.scheduleDashCachePrune();
        expect(pruneSpy).toHaveBeenCalledTimes(1);

        resolvePrune?.(defaultPruneResult);
        await Promise.resolve();
    });

    it("throttles scheduled prune runs using the configured interval", async () => {
        jest.useFakeTimers();
        const baseNow = new Date("2026-02-23T00:00:00.000Z");
        jest.setSystemTime(baseNow);
        process.env.SEGMENTED_STREAMING_CACHE_PRUNE_INTERVAL_MS = "60000";

        const cacheService = await resolveCacheService();
        const pruneSpy = jest
            .spyOn(cacheService, "pruneDashCacheIfNeeded")
            .mockResolvedValue(defaultPruneResult);

        cacheService.scheduleDashCachePrune();
        await Promise.resolve();
        await Promise.resolve();
        expect(pruneSpy).toHaveBeenCalledTimes(1);

        jest.setSystemTime(new Date(baseNow.getTime() + 30_000));
        cacheService.scheduleDashCachePrune();
        expect(pruneSpy).toHaveBeenCalledTimes(1);

        jest.setSystemTime(new Date(baseNow.getTime() + 61_000));
        cacheService.scheduleDashCachePrune();
        expect(pruneSpy).toHaveBeenCalledTimes(2);
    });
});
