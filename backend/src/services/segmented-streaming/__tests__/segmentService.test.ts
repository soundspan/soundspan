import { EventEmitter } from "events";

const wait = async (durationMs: number): Promise<void> => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, durationMs);
    });
};

const createMockFfmpegProcess = () => {
    const processEmitter = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        kill: jest.Mock;
    };
    processEmitter.stderr = new EventEmitter();
    processEmitter.kill = jest.fn();
    return processEmitter;
};

const resolveSegmentService = async () => {
    jest.resetModules();

    const mockBuildDashCacheKey = jest.fn();
    const mockGetDashAssetPaths = jest.fn();
    const mockHasDashManifest = jest.fn();
    const mockEnsureDashAssetDirectory = jest.fn();
    const mockSpawn = jest.fn();

    jest.doMock("@ffmpeg-installer/ffmpeg", () => ({
        __esModule: true,
        default: {
            path: "/tmp/mock-ffmpeg",
        },
    }));

    jest.doMock("child_process", () => ({
        spawn: (...args: unknown[]) => mockSpawn(...args),
    }));

    jest.doMock("../cacheService", () => ({
        segmentedStreamingCacheService: {
            buildDashCacheKey: (...args: unknown[]) =>
                mockBuildDashCacheKey(...args),
            getDashAssetPaths: (...args: unknown[]) =>
                mockGetDashAssetPaths(...args),
            hasDashManifest: (...args: unknown[]) =>
                mockHasDashManifest(...args),
            ensureDashAssetDirectory: (...args: unknown[]) =>
                mockEnsureDashAssetDirectory(...args),
        },
    }));

    const module = await import("../segmentService");

    return {
        segmentedSegmentService: module.segmentedSegmentService,
        mocks: {
            mockBuildDashCacheKey,
            mockGetDashAssetPaths,
            mockHasDashManifest,
            mockEnsureDashAssetDirectory,
            mockSpawn,
        },
    };
};

describe("segmentedSegmentService", () => {
    afterEach(() => {
        jest.resetModules();
        jest.dontMock("@ffmpeg-installer/ffmpeg");
        jest.dontMock("child_process");
        jest.dontMock("../cacheService");
    });

    it("starts DASH generation in the background without blocking ensure", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const ffmpegProcess = createMockFfmpegProcess();

        mocks.mockBuildDashCacheKey.mockReturnValue("cache-bg");
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey: "cache-bg",
            outputDir: "/tmp/cache-bg",
            manifestPath: "/tmp/cache-bg/manifest.mpd",
        });
        mocks.mockHasDashManifest.mockResolvedValueOnce(false).mockResolvedValue(true);
        mocks.mockEnsureDashAssetDirectory.mockResolvedValue(undefined);
        mocks.mockSpawn.mockReturnValue(ffmpegProcess);

        const result = await Promise.race([
            segmentedSegmentService.ensureLocalDashSegments({
                trackId: "track-bg",
                sourcePath: "/music/track-bg.flac",
                sourceModified: new Date("2026-02-20T00:00:00.000Z"),
                quality: "medium",
            }),
            wait(40).then(() => "timeout"),
        ]);

        expect(result).not.toBe("timeout");
        expect(result).toEqual({
            cacheKey: "cache-bg",
            outputDir: "/tmp/cache-bg",
            manifestPath: "/tmp/cache-bg/manifest.mpd",
            quality: "medium",
        });
        expect(mocks.mockSpawn).toHaveBeenCalledTimes(1);

        ffmpegProcess.emit("close", 0);
        await wait(0);
    });

    it("chunks local original lossless tracks as FLAC fMP4-DASH (no lossy bitrate)", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const ffmpegProcess = createMockFfmpegProcess();

        mocks.mockBuildDashCacheKey.mockReturnValue("cache-original");
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey: "cache-original",
            outputDir: "/tmp/cache-original",
            manifestPath: "/tmp/cache-original/manifest.mpd",
        });
        mocks.mockHasDashManifest.mockResolvedValueOnce(false).mockResolvedValue(true);
        mocks.mockEnsureDashAssetDirectory.mockResolvedValue(undefined);
        mocks.mockSpawn.mockReturnValue(ffmpegProcess);

        await segmentedSegmentService.ensureLocalDashSegments({
            trackId: "track-original",
            sourcePath: "/music/track-original.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "original",
        });
        await wait(0);

        const ffmpegArgs = mocks.mockSpawn.mock.calls[0][1] as string[];
        expect(ffmpegArgs).toContain("-c:a");
        expect(ffmpegArgs).toContain("flac");
        expect(ffmpegArgs).toContain("-strict");
        expect(ffmpegArgs).toContain("-2");
        expect(ffmpegArgs).toContain("-streaming");
        expect(ffmpegArgs).toContain("1");
        expect(ffmpegArgs).toContain("-ldash");
        expect(ffmpegArgs).toContain("init-$RepresentationID$.m4s");
        expect(ffmpegArgs).toContain("chunk-$RepresentationID$-$Number%05d$.m4s");
        expect(ffmpegArgs).not.toContain("-b:a");
        expect(ffmpegArgs).not.toContain("320k");

        ffmpegProcess.emit("close", 0);
        await wait(0);
    });

    it("keeps AAC transcoding for non-original quality selections", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const ffmpegProcess = createMockFfmpegProcess();

        mocks.mockBuildDashCacheKey.mockReturnValue("cache-high");
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey: "cache-high",
            outputDir: "/tmp/cache-high",
            manifestPath: "/tmp/cache-high/manifest.mpd",
        });
        mocks.mockHasDashManifest.mockResolvedValueOnce(false).mockResolvedValue(true);
        mocks.mockEnsureDashAssetDirectory.mockResolvedValue(undefined);
        mocks.mockSpawn.mockReturnValue(ffmpegProcess);

        await segmentedSegmentService.ensureLocalDashSegments({
            trackId: "track-high",
            sourcePath: "/music/track-high.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "high",
        });
        await wait(0);

        const ffmpegArgs = mocks.mockSpawn.mock.calls[0][1] as string[];
        expect(ffmpegArgs).toContain("-c:a");
        expect(ffmpegArgs).toContain("aac");
        expect(ffmpegArgs).toContain("-b:a");
        expect(ffmpegArgs).toContain("320k");

        ffmpegProcess.emit("close", 0);
        await wait(0);
    });
});
