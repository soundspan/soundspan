import path from "node:path";

const BYTES_PER_GB = 1024 * 1024 * 1024;
const SEGMENTED_ENV_KEYS = [
    "SEGMENTED_STREAMING_CACHE_PATH",
    "SEGMENTED_STREAMING_CACHE_MAX_GB",
    "SEGMENTED_STREAMING_CACHE_PRUNE_INTERVAL_MS",
    "SEGMENTED_STREAMING_CACHE_MIN_AGE_MS",
    "SEGMENTED_STREAMING_CACHE_PRUNE_TARGET_RATIO",
    "SEGMENTED_STREAMING_CACHE_SCHEMA_VERSION",
] as const;

const originalSegmentedEnv: Record<
    (typeof SEGMENTED_ENV_KEYS)[number],
    string | undefined
> = {
    SEGMENTED_STREAMING_CACHE_PATH:
        process.env.SEGMENTED_STREAMING_CACHE_PATH,
    SEGMENTED_STREAMING_CACHE_MAX_GB:
        process.env.SEGMENTED_STREAMING_CACHE_MAX_GB,
    SEGMENTED_STREAMING_CACHE_PRUNE_INTERVAL_MS:
        process.env.SEGMENTED_STREAMING_CACHE_PRUNE_INTERVAL_MS,
    SEGMENTED_STREAMING_CACHE_MIN_AGE_MS:
        process.env.SEGMENTED_STREAMING_CACHE_MIN_AGE_MS,
    SEGMENTED_STREAMING_CACHE_PRUNE_TARGET_RATIO:
        process.env.SEGMENTED_STREAMING_CACHE_PRUNE_TARGET_RATIO,
    SEGMENTED_STREAMING_CACHE_SCHEMA_VERSION:
        process.env.SEGMENTED_STREAMING_CACHE_SCHEMA_VERSION,
};

const defaultPruneResult = {
    inspectedEntries: 0,
    removedEntries: 0,
    skippedActiveEntries: 0,
    skippedRecentEntries: 0,
    totalBytesBefore: 0,
    totalBytesAfter: 0,
    maxBytes: 0,
};

type MockDirent = {
    name: string;
    isDirectory: () => boolean;
};

type PruneDirectoryFixture = {
    cacheKey: string;
    files: Array<{
        name: string;
        sizeBytes: number;
        modifiedAtMs: number;
    }>;
};

type LoadCacheServiceOptions = {
    env?: Partial<Record<(typeof SEGMENTED_ENV_KEYS)[number], string | undefined>>;
    transcodeCachePath?: string;
    transcodeCacheMaxGb?: number;
    buildCachePathImpl?: (basePath: string, ...segments: string[]) => string;
    buildSha256CacheKeyImpl?: (input: {
        identity: string;
        suffix?: string;
        length?: number;
    }) => string;
};

const createDirent = (name: string, isDirectory: boolean): MockDirent => ({
    name,
    isDirectory: () => isDirectory,
});

const createErrno = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(code), { code });

const flushPromises = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
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

const loadCacheService = async (options: LoadCacheServiceOptions = {}) => {
    jest.resetModules();
    restoreSegmentedEnv();

    for (const envKey of SEGMENTED_ENV_KEYS) {
        delete process.env[envKey];

        if (!(envKey in (options.env ?? {}))) {
            continue;
        }

        const value = options.env?.[envKey];
        if (value !== undefined) {
            process.env[envKey] = value;
        }
    }

    const mockMkdir = jest.fn();
    const mockRm = jest.fn();
    const mockAccess = jest.fn();
    const mockReaddir = jest.fn();
    const mockStat = jest.fn();
    const mockBuildCachePath = jest.fn(
        options.buildCachePathImpl ??
            ((basePath: string, ...segments: string[]) =>
                path.join(basePath, ...segments)),
    );
    const mockBuildSha256CacheKey = jest.fn(
        options.buildSha256CacheKeyImpl ??
            ((input: { identity: string; suffix?: string; length?: number }) =>
                `hash:${input.identity}:${input.suffix ?? ""}:${input.length ?? 24}`),
    );
    const mockLogger = {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        child: jest.fn(),
    };
    mockLogger.child.mockReturnValue(mockLogger);

    jest.doMock("fs", () => ({
        promises: {
            mkdir: (...args: unknown[]) => mockMkdir(...args),
            rm: (...args: unknown[]) => mockRm(...args),
            access: (...args: unknown[]) => mockAccess(...args),
            readdir: (...args: unknown[]) => mockReaddir(...args),
            stat: (...args: unknown[]) => mockStat(...args),
        },
    }));

    jest.doMock("../../../config", () => ({
        config: {
            music: {
                transcodeCachePath: options.transcodeCachePath ?? "/config/transcodes",
                transcodeCacheMaxGb: options.transcodeCacheMaxGb ?? 10,
            },
        },
    }));

    jest.doMock("../../../utils/logger", () => ({
        logger: mockLogger,
    }));

    jest.doMock("../../cacheHelpers", () => ({
        buildCachePath: (...args: Parameters<typeof mockBuildCachePath>) =>
            mockBuildCachePath(...args),
        buildSha256CacheKey: (...args: Parameters<typeof mockBuildSha256CacheKey>) =>
            mockBuildSha256CacheKey(...args),
    }));

    const module = await import("../cacheService");

    return {
        cacheService: module.segmentedStreamingCacheService,
        mocks: {
            mockMkdir,
            mockRm,
            mockAccess,
            mockReaddir,
            mockStat,
            mockBuildCachePath,
            mockBuildSha256CacheKey,
            mockLogger,
        },
    };
};

const configurePruneTree = (
    mockReaddir: jest.Mock,
    mockStat: jest.Mock,
    dashRoot: string,
    directories: PruneDirectoryFixture[],
): void => {
    mockReaddir.mockImplementation(
        async (
            targetPath: string,
            options?: { withFileTypes?: boolean },
        ): Promise<MockDirent[] | string[]> => {
            if (targetPath === dashRoot && options?.withFileTypes) {
                return directories.map((directory) =>
                    createDirent(directory.cacheKey, true),
                );
            }

            for (const directory of directories) {
                const outputDir = path.join(dashRoot, directory.cacheKey);
                if (targetPath === outputDir && options?.withFileTypes) {
                    return directory.files.map((file) =>
                        createDirent(file.name, false),
                    );
                }
            }

            throw createErrno("ENOENT");
        },
    );

    mockStat.mockImplementation(async (targetPath: string) => {
        for (const directory of directories) {
            for (const file of directory.files) {
                const filePath = path.join(dashRoot, directory.cacheKey, file.name);
                if (targetPath === filePath) {
                    return {
                        size: file.sizeBytes,
                        mtimeMs: file.modifiedAtMs,
                    };
                }
            }
        }

        throw createErrno("ENOENT");
    });
};

afterEach(() => {
    restoreSegmentedEnv();
    jest.useRealTimers();
    jest.resetModules();
    jest.dontMock("fs");
    jest.dontMock("../../../config");
    jest.dontMock("../../../utils/logger");
    jest.dontMock("../../cacheHelpers");
    jest.restoreAllMocks();
});

describe("segmentedStreamingCacheService", () => {
    describe("buildDashCacheKey", () => {
        it("passes the schema version and trimmed cache identity into the sha256 key builder", async () => {
            const { cacheService, mocks } = await loadCacheService({
                env: {
                    SEGMENTED_STREAMING_CACHE_SCHEMA_VERSION: " dash-v9 ",
                },
            });
            mocks.mockBuildSha256CacheKey.mockReturnValue("dash-cache-key");

            const cacheKey = cacheService.buildDashCacheKey({
                trackId: "track-1",
                sourcePath: "/music/track-1.flac",
                sourceModifiedIso: "2026-02-23T00:00:00.000Z",
                quality: "high",
                cacheIdentity: " custom-identity ",
            });

            expect(cacheKey).toBe("dash-cache-key");
            expect(mocks.mockBuildSha256CacheKey).toHaveBeenCalledWith({
                identity: "custom-identity",
                suffix: "high:dash-v9",
                length: 24,
            });
        });

        it("falls back to the track-source identity and default schema version", async () => {
            const { cacheService, mocks } = await loadCacheService();

            cacheService.buildDashCacheKey({
                trackId: "track-2",
                sourcePath: "/music/track-2.flac",
                sourceModifiedIso: "2026-02-24T00:00:00.000Z",
                quality: "medium",
                cacheIdentity: "   ",
            });

            expect(mocks.mockBuildSha256CacheKey).toHaveBeenCalledWith({
                identity: "track-2:/music/track-2.flac:2026-02-24T00:00:00.000Z",
                suffix: "medium:dash-v2",
                length: 24,
            });
        });
    });

    describe("getDashAssetPaths", () => {
        it("returns the computed output and manifest paths", async () => {
            const { cacheService, mocks } = await loadCacheService({
                env: {
                    SEGMENTED_STREAMING_CACHE_PATH: "  /env/cache  ",
                },
            });

            const paths = cacheService.getDashAssetPaths("cache-key");

            expect(paths).toEqual({
                cacheKey: "cache-key",
                outputDir: path.join("/env/cache", "segmented-dash", "cache-key"),
                manifestPath: path.join(
                    "/env/cache",
                    "segmented-dash",
                    "cache-key",
                    "manifest.mpd",
                ),
            });
            expect(mocks.mockBuildCachePath).toHaveBeenNthCalledWith(
                1,
                "/env/cache",
                "segmented-dash",
            );
        });
    });

    describe("filesystem helpers", () => {
        it("creates the DASH output directory recursively", async () => {
            const { cacheService, mocks } = await loadCacheService();

            const paths = await cacheService.ensureDashAssetDirectory("cache-dir");

            expect(paths).toEqual({
                cacheKey: "cache-dir",
                outputDir: path.join(
                    "/config/transcodes",
                    "segmented-dash",
                    "cache-dir",
                ),
                manifestPath: path.join(
                    "/config/transcodes",
                    "segmented-dash",
                    "cache-dir",
                    "manifest.mpd",
                ),
            });
            expect(mocks.mockMkdir).toHaveBeenCalledWith(paths.outputDir, {
                recursive: true,
            });
        });

        it("removes the DASH output directory recursively", async () => {
            const { cacheService, mocks } = await loadCacheService();

            await cacheService.removeDashAsset("cache-remove");

            expect(mocks.mockRm).toHaveBeenCalledWith(
                path.join(
                    "/config/transcodes",
                    "segmented-dash",
                    "cache-remove",
                ),
                {
                    recursive: true,
                    force: true,
                },
            );
        });

        it("returns true when the DASH manifest exists", async () => {
            const { cacheService, mocks } = await loadCacheService();
            mocks.mockAccess.mockResolvedValue(undefined);

            await expect(cacheService.hasDashManifest("cache-hit")).resolves.toBe(true);
            expect(mocks.mockAccess).toHaveBeenCalledWith(
                path.join(
                    "/config/transcodes",
                    "segmented-dash",
                    "cache-hit",
                    "manifest.mpd",
                ),
            );
        });

        it("returns false when the DASH manifest is missing", async () => {
            const { cacheService, mocks } = await loadCacheService();
            mocks.mockAccess.mockRejectedValue(createErrno("ENOENT"));

            await expect(cacheService.hasDashManifest("cache-miss")).resolves.toBe(
                false,
            );
        });

        it("returns sorted DASH segment filenames and filters non-segment files", async () => {
            const { cacheService, mocks } = await loadCacheService();
            mocks.mockReaddir.mockResolvedValue([
                "chunk-00010.m4s",
                "chunk-00002.webm",
                "manifest.mpd",
                "notes.txt",
                "chunk-00001.m4s",
            ]);

            await expect(cacheService.listDashSegments("cache-list")).resolves.toEqual([
                "chunk-00001.m4s",
                "chunk-00002.webm",
                "chunk-00010.m4s",
            ]);
        });
    });

    describe("session reference tracking", () => {
        it("deduplicates session ids and clears empty reference sets", async () => {
            const { cacheService } = await loadCacheService();

            cacheService.clearSessionReference("cache-refs", "missing-session");
            cacheService.registerSessionReference("cache-refs", "session-1");
            cacheService.registerSessionReference("cache-refs", "session-1");
            cacheService.registerSessionReference("cache-refs", "session-2");

            expect(cacheService.getSessionReferenceCount("cache-refs")).toBe(2);

            cacheService.clearSessionReference("cache-refs", "session-1");
            expect(cacheService.getSessionReferenceCount("cache-refs")).toBe(1);

            cacheService.clearSessionReference("cache-refs", "session-2");
            expect(cacheService.getSessionReferenceCount("cache-refs")).toBe(0);
        });
    });

    describe("pruneDashCacheIfNeeded", () => {
        it("prunes the oldest eligible directories until the target byte ratio is met", async () => {
            jest.useFakeTimers();
            const baseNow = new Date("2026-02-23T00:00:00.000Z");
            jest.setSystemTime(baseNow);
            const maxBytes = 2_000;
            const { cacheService, mocks } = await loadCacheService({
                env: {
                    SEGMENTED_STREAMING_CACHE_PATH: "/prune-cache",
                    SEGMENTED_STREAMING_CACHE_MAX_GB: String(maxBytes / BYTES_PER_GB),
                    SEGMENTED_STREAMING_CACHE_PRUNE_TARGET_RATIO: "0.5",
                    SEGMENTED_STREAMING_CACHE_MIN_AGE_MS: "1000",
                },
            });
            const dashRoot = path.join("/prune-cache", "segmented-dash");

            configurePruneTree(mocks.mockReaddir, mocks.mockStat, dashRoot, [
                {
                    cacheKey: "oldest",
                    files: [
                        {
                            name: "chunk-00001.m4s",
                            sizeBytes: 800,
                            modifiedAtMs: baseNow.getTime() - 600_000,
                        },
                    ],
                },
                {
                    cacheKey: "middle",
                    files: [
                        {
                            name: "chunk-00001.m4s",
                            sizeBytes: 800,
                            modifiedAtMs: baseNow.getTime() - 500_000,
                        },
                    ],
                },
                {
                    cacheKey: "newest",
                    files: [
                        {
                            name: "chunk-00001.m4s",
                            sizeBytes: 800,
                            modifiedAtMs: baseNow.getTime() - 400_000,
                        },
                    ],
                },
            ]);

            const result = await cacheService.pruneDashCacheIfNeeded();

            expect(result).toEqual({
                inspectedEntries: 3,
                removedEntries: 2,
                skippedActiveEntries: 0,
                skippedRecentEntries: 0,
                totalBytesBefore: 2_400,
                totalBytesAfter: 800,
                maxBytes,
            });
            expect(mocks.mockRm).toHaveBeenNthCalledWith(
                1,
                path.join(dashRoot, "oldest"),
                { recursive: true, force: true },
            );
            expect(mocks.mockRm).toHaveBeenNthCalledWith(
                2,
                path.join(dashRoot, "middle"),
                { recursive: true, force: true },
            );
            expect(mocks.mockLogger.info).toHaveBeenCalledWith(
                "[SegmentedStreaming] Pruned DASH cache directories",
                {
                    removedEntries: 2,
                    skippedActiveEntries: 0,
                    skippedRecentEntries: 0,
                    totalBytesBefore: 2_400,
                    totalBytesAfter: 800,
                    maxBytes,
                },
            );
        });

        it("skips active and recent directories during pruning", async () => {
            jest.useFakeTimers();
            const baseNow = new Date("2026-02-23T00:00:00.000Z");
            jest.setSystemTime(baseNow);
            const maxBytes = 2_000;
            const { cacheService, mocks } = await loadCacheService({
                env: {
                    SEGMENTED_STREAMING_CACHE_PATH: "/protect-cache",
                    SEGMENTED_STREAMING_CACHE_MAX_GB: String(maxBytes / BYTES_PER_GB),
                    SEGMENTED_STREAMING_CACHE_PRUNE_TARGET_RATIO: "0.5",
                    SEGMENTED_STREAMING_CACHE_MIN_AGE_MS: "600000",
                },
            });
            const dashRoot = path.join("/protect-cache", "segmented-dash");

            configurePruneTree(mocks.mockReaddir, mocks.mockStat, dashRoot, [
                {
                    cacheKey: "active-old",
                    files: [
                        {
                            name: "chunk-00001.m4s",
                            sizeBytes: 900,
                            modifiedAtMs: baseNow.getTime() - 2 * 60 * 60 * 1000,
                        },
                    ],
                },
                {
                    cacheKey: "removable-old",
                    files: [
                        {
                            name: "chunk-00001.m4s",
                            sizeBytes: 900,
                            modifiedAtMs: baseNow.getTime() - 90 * 60 * 1000,
                        },
                    ],
                },
                {
                    cacheKey: "recent",
                    files: [
                        {
                            name: "chunk-00001.m4s",
                            sizeBytes: 900,
                            modifiedAtMs: baseNow.getTime() - 60 * 1000,
                        },
                    ],
                },
            ]);
            cacheService.registerSessionReference("active-old", "session-1");

            const result = await cacheService.pruneDashCacheIfNeeded();

            expect(result).toEqual({
                inspectedEntries: 3,
                removedEntries: 1,
                skippedActiveEntries: 1,
                skippedRecentEntries: 1,
                totalBytesBefore: 2_700,
                totalBytesAfter: 1_800,
                maxBytes,
            });
            expect(mocks.mockRm).toHaveBeenCalledTimes(1);
            expect(mocks.mockRm).toHaveBeenCalledWith(
                path.join(dashRoot, "removable-old"),
                { recursive: true, force: true },
            );
        });

        it("logs and continues pruning when a directory removal fails", async () => {
            jest.useFakeTimers();
            const baseNow = new Date("2026-02-23T00:00:00.000Z");
            jest.setSystemTime(baseNow);
            const maxBytes = 2_000;
            const { cacheService, mocks } = await loadCacheService({
                env: {
                    SEGMENTED_STREAMING_CACHE_PATH: "/warn-cache",
                    SEGMENTED_STREAMING_CACHE_MAX_GB: String(maxBytes / BYTES_PER_GB),
                    SEGMENTED_STREAMING_CACHE_PRUNE_TARGET_RATIO: "0.5",
                    SEGMENTED_STREAMING_CACHE_MIN_AGE_MS: "1000",
                },
            });
            const dashRoot = path.join("/warn-cache", "segmented-dash");
            const removalError = new Error("rm failed");

            configurePruneTree(mocks.mockReaddir, mocks.mockStat, dashRoot, [
                {
                    cacheKey: "oldest",
                    files: [
                        {
                            name: "chunk-00001.m4s",
                            sizeBytes: 800,
                            modifiedAtMs: baseNow.getTime() - 600_000,
                        },
                    ],
                },
                {
                    cacheKey: "middle",
                    files: [
                        {
                            name: "chunk-00001.m4s",
                            sizeBytes: 800,
                            modifiedAtMs: baseNow.getTime() - 500_000,
                        },
                    ],
                },
                {
                    cacheKey: "newest",
                    files: [
                        {
                            name: "chunk-00001.m4s",
                            sizeBytes: 800,
                            modifiedAtMs: baseNow.getTime() - 400_000,
                        },
                    ],
                },
            ]);
            mocks.mockRm
                .mockRejectedValueOnce(removalError)
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce(undefined);

            const result = await cacheService.pruneDashCacheIfNeeded();

            expect(result).toEqual({
                inspectedEntries: 3,
                removedEntries: 2,
                skippedActiveEntries: 0,
                skippedRecentEntries: 0,
                totalBytesBefore: 2_400,
                totalBytesAfter: 800,
                maxBytes,
            });
            expect(mocks.mockLogger.warn).toHaveBeenCalledWith(
                "[SegmentedStreaming] Failed to remove DASH cache directory",
                {
                    cacheKey: "oldest",
                    outputDir: path.join(dashRoot, "oldest"),
                    error: removalError,
                },
            );
        });

        it("returns without prune logging when all oversized entries are protected", async () => {
            jest.useFakeTimers();
            const baseNow = new Date("2026-02-23T00:00:00.000Z");
            jest.setSystemTime(baseNow);
            const maxBytes = 1_500;
            const { cacheService, mocks } = await loadCacheService({
                env: {
                    SEGMENTED_STREAMING_CACHE_PATH: "/protected-only-cache",
                    SEGMENTED_STREAMING_CACHE_MAX_GB: String(maxBytes / BYTES_PER_GB),
                    SEGMENTED_STREAMING_CACHE_PRUNE_TARGET_RATIO: "0.5",
                    SEGMENTED_STREAMING_CACHE_MIN_AGE_MS: "600000",
                },
            });
            const dashRoot = path.join("/protected-only-cache", "segmented-dash");

            configurePruneTree(mocks.mockReaddir, mocks.mockStat, dashRoot, [
                {
                    cacheKey: "active-old",
                    files: [
                        {
                            name: "chunk-00001.m4s",
                            sizeBytes: 900,
                            modifiedAtMs: baseNow.getTime() - 2 * 60 * 60 * 1000,
                        },
                    ],
                },
                {
                    cacheKey: "recent",
                    files: [
                        {
                            name: "chunk-00001.m4s",
                            sizeBytes: 900,
                            modifiedAtMs: baseNow.getTime() - 60 * 1000,
                        },
                    ],
                },
            ]);
            cacheService.registerSessionReference("active-old", "session-1");

            const result = await cacheService.pruneDashCacheIfNeeded();

            expect(result).toEqual({
                inspectedEntries: 2,
                removedEntries: 0,
                skippedActiveEntries: 1,
                skippedRecentEntries: 1,
                totalBytesBefore: 1_800,
                totalBytesAfter: 1_800,
                maxBytes,
            });
            expect(mocks.mockLogger.info).not.toHaveBeenCalled();
        });

        it("returns an empty prune result when the DASH cache root does not exist", async () => {
            const { cacheService, mocks } = await loadCacheService({
                env: {
                    SEGMENTED_STREAMING_CACHE_PATH: "/missing-cache",
                },
            });
            mocks.mockReaddir.mockRejectedValue(createErrno("ENOENT"));

            await expect(cacheService.pruneDashCacheIfNeeded()).resolves.toEqual({
                inspectedEntries: 0,
                removedEntries: 0,
                skippedActiveEntries: 0,
                skippedRecentEntries: 0,
                totalBytesBefore: 0,
                totalBytesAfter: 0,
                maxBytes: 10 * BYTES_PER_GB,
            });
            expect(mocks.mockRm).not.toHaveBeenCalled();
        });
    });

    describe("scheduleDashCachePrune", () => {
        it("does not overlap prune runs while one is still in flight", async () => {
            const { cacheService } = await loadCacheService({
                env: {
                    SEGMENTED_STREAMING_CACHE_PRUNE_INTERVAL_MS: "60000",
                },
            });
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
            await flushPromises();
        });

        it("throttles prune scheduling according to the configured interval", async () => {
            jest.useFakeTimers();
            const baseNow = new Date("2026-02-23T00:00:00.000Z");
            jest.setSystemTime(baseNow);
            const { cacheService } = await loadCacheService({
                env: {
                    SEGMENTED_STREAMING_CACHE_PRUNE_INTERVAL_MS: "60000",
                },
            });
            const pruneSpy = jest
                .spyOn(cacheService, "pruneDashCacheIfNeeded")
                .mockResolvedValue(defaultPruneResult);

            cacheService.scheduleDashCachePrune();
            await flushPromises();
            expect(pruneSpy).toHaveBeenCalledTimes(1);

            jest.setSystemTime(new Date(baseNow.getTime() + 30_000));
            cacheService.scheduleDashCachePrune();
            expect(pruneSpy).toHaveBeenCalledTimes(1);

            jest.setSystemTime(new Date(baseNow.getTime() + 61_000));
            cacheService.scheduleDashCachePrune();
            expect(pruneSpy).toHaveBeenCalledTimes(2);
        });

        it("logs prune failures and clears the in-flight marker for future runs", async () => {
            jest.useFakeTimers();
            const baseNow = new Date("2026-02-23T00:00:00.000Z");
            jest.setSystemTime(baseNow);
            const { cacheService, mocks } = await loadCacheService({
                env: {
                    SEGMENTED_STREAMING_CACHE_PRUNE_INTERVAL_MS: "1",
                },
                transcodeCacheMaxGb: 3,
            });
            const pruneError = new Error("prune exploded");
            const pruneSpy = jest
                .spyOn(cacheService, "pruneDashCacheIfNeeded")
                .mockRejectedValueOnce(pruneError)
                .mockResolvedValueOnce(defaultPruneResult);

            cacheService.scheduleDashCachePrune();
            await flushPromises();

            expect(mocks.mockLogger.warn).toHaveBeenCalledWith(
                "[SegmentedStreaming] DASH cache prune failed",
                pruneError,
            );

            jest.setSystemTime(new Date(baseNow.getTime() + 10));
            cacheService.scheduleDashCachePrune();
            expect(pruneSpy).toHaveBeenCalledTimes(2);
        });
    });

    describe("environment configuration", () => {
        it("uses explicit segmented cache env overrides for path and max size", async () => {
            const explicitMaxGb = 1.5;
            const { cacheService, mocks } = await loadCacheService({
                env: {
                    SEGMENTED_STREAMING_CACHE_PATH: "  /env-override  ",
                    SEGMENTED_STREAMING_CACHE_MAX_GB: String(explicitMaxGb),
                },
                transcodeCachePath: "/config-cache",
                transcodeCacheMaxGb: 7,
            });
            mocks.mockReaddir.mockRejectedValue(createErrno("ENOENT"));

            expect(cacheService.getDashAssetPaths("env-key")).toEqual({
                cacheKey: "env-key",
                outputDir: path.join("/env-override", "segmented-dash", "env-key"),
                manifestPath: path.join(
                    "/env-override",
                    "segmented-dash",
                    "env-key",
                    "manifest.mpd",
                ),
            });
            await expect(cacheService.pruneDashCacheIfNeeded()).resolves.toEqual(
                expect.objectContaining({
                    maxBytes: Math.floor(explicitMaxGb * BYTES_PER_GB),
                }),
            );
        });

        it("falls back to config-based max size when the env value is invalid", async () => {
            const fallbackMaxGb = 2;
            const { cacheService, mocks } = await loadCacheService({
                env: {
                    SEGMENTED_STREAMING_CACHE_MAX_GB: "0",
                },
                transcodeCacheMaxGb: fallbackMaxGb,
            });
            mocks.mockReaddir.mockRejectedValue(createErrno("ENOENT"));

            await expect(cacheService.pruneDashCacheIfNeeded()).resolves.toEqual(
                expect.objectContaining({
                    maxBytes: fallbackMaxGb * BYTES_PER_GB,
                }),
            );
        });

        it("falls back to the default max size when env and config values are invalid", async () => {
            const { cacheService, mocks } = await loadCacheService({
                env: {
                    SEGMENTED_STREAMING_CACHE_MAX_GB: "not-a-number",
                },
                transcodeCacheMaxGb: 0,
            });
            mocks.mockReaddir.mockRejectedValue(createErrno("ENOENT"));

            await expect(cacheService.pruneDashCacheIfNeeded()).resolves.toEqual(
                expect.objectContaining({
                    maxBytes: 10 * BYTES_PER_GB,
                }),
            );
        });
    });
});
