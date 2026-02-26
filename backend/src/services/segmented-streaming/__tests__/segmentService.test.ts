import { EventEmitter } from "events";

const wait = async (durationMs: number): Promise<void> => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, durationMs);
    });
};

const createMockFfmpegProcess = () => {
    const processEmitter = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: jest.Mock;
    };
    processEmitter.stdout = new EventEmitter();
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
    const mockScheduleDashCachePrune = jest.fn();
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
            scheduleDashCachePrune: (...args: unknown[]) =>
                mockScheduleDashCachePrune(...args),
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
            mockScheduleDashCachePrune,
            mockSpawn,
        },
    };
};

describe("segmentedSegmentService", () => {
    const originalLocalSegmentDurationSec =
        process.env.SEGMENTED_LOCAL_SEG_DURATION_SEC;

    afterEach(() => {
        if (originalLocalSegmentDurationSec === undefined) {
            delete process.env.SEGMENTED_LOCAL_SEG_DURATION_SEC;
        } else {
            process.env.SEGMENTED_LOCAL_SEG_DURATION_SEC =
                originalLocalSegmentDurationSec;
        }
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
        expect(mocks.mockScheduleDashCachePrune).toHaveBeenCalledTimes(1);
        expect(mocks.mockSpawn).toHaveBeenCalledTimes(1);

        ffmpegProcess.emit("close", 0);
        await wait(0);
    });

    it("schedules prune checks even on DASH cache hits", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();

        mocks.mockBuildDashCacheKey.mockReturnValue("cache-hit");
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey: "cache-hit",
            outputDir: "/tmp/cache-hit",
            manifestPath: "/tmp/cache-hit/manifest.mpd",
        });
        mocks.mockHasDashManifest.mockResolvedValue(true);

        const result = await segmentedSegmentService.ensureLocalDashSegments({
            trackId: "track-hit",
            sourcePath: "/music/track-hit.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium",
        });

        expect(result).toEqual({
            cacheKey: "cache-hit",
            outputDir: "/tmp/cache-hit",
            manifestPath: "/tmp/cache-hit/manifest.mpd",
            quality: "medium",
        });
        expect(mocks.mockScheduleDashCachePrune).toHaveBeenCalledTimes(1);
        expect(mocks.mockSpawn).not.toHaveBeenCalled();
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
        expect(ffmpegArgs).toContain("-c:a:0");
        expect(ffmpegArgs).not.toContain("-b:a:0");
        expect(ffmpegArgs).not.toContain("320k");
        expect(ffmpegArgs).toContain("-adaptation_sets");
        expect(ffmpegArgs).toContain("id=0,streams=a");
        expect(ffmpegArgs.filter((arg) => arg === "-map")).toHaveLength(1);
        expect(ffmpegArgs).toContain("flac");
        expect(ffmpegArgs).toContain("-strict");
        expect(ffmpegArgs).toContain("-2");
        expect(ffmpegArgs).toContain("-streaming");
        expect(ffmpegArgs).toContain("1");
        expect(ffmpegArgs).toContain("-ldash");
        expect(ffmpegArgs).toContain("init-$RepresentationID$.m4s");
        expect(ffmpegArgs).toContain("chunk-$RepresentationID$-$Number%05d$.m4s");
        expect(ffmpegArgs).not.toContain("320k");

        ffmpegProcess.emit("close", 0);
        await wait(0);
    });

    it("uses startup DASH capability probe to skip unsupported ffmpeg flags", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const dashProbeProcess = createMockFfmpegProcess();
        const remoteProbeProcess = createMockFfmpegProcess();
        const ffmpegProcess = createMockFfmpegProcess();

        mocks.mockSpawn
            .mockReturnValueOnce(dashProbeProcess)
            .mockReturnValueOnce(remoteProbeProcess)
            .mockReturnValueOnce(ffmpegProcess);

        const probePromise = segmentedSegmentService.initializeDashCapabilityProbe();
        dashProbeProcess.stdout.emit(
            "data",
            Buffer.from(
                "Muxer dash [Dynamic Adaptive Streaming over HTTP]:\n  -streaming         E.......... Enable streaming\n",
            ),
        );
        dashProbeProcess.emit("close", 0);
        remoteProbeProcess.stdout.emit(
            "data",
            Buffer.from(
                "http AVOptions:\n  -reconnect            <boolean> E....\n  -rw_timeout           <int64> E....\n",
            ),
        );
        remoteProbeProcess.emit("close", 0);
        await probePromise;

        mocks.mockBuildDashCacheKey.mockReturnValue("cache-probed");
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey: "cache-probed",
            outputDir: "/tmp/cache-probed",
            manifestPath: "/tmp/cache-probed/manifest.mpd",
        });
        mocks.mockHasDashManifest.mockResolvedValueOnce(false).mockResolvedValue(true);
        mocks.mockEnsureDashAssetDirectory.mockResolvedValue(undefined);

        await segmentedSegmentService.ensureLocalDashSegments({
            trackId: "track-probed",
            sourcePath: "/music/track-probed.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "original",
        });
        await wait(0);

        const ffmpegArgs = mocks.mockSpawn.mock.calls[2][1] as string[];
        expect(ffmpegArgs).not.toContain("-ldash");
        expect(ffmpegArgs).toContain("-streaming");
        expect(ffmpegArgs).toContain("1");

        ffmpegProcess.emit("close", 0);
        await wait(0);
    });

    it("retries generation without -ldash when ffmpeg build does not support it", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const firstFfmpegProcess = createMockFfmpegProcess();
        const secondFfmpegProcess = createMockFfmpegProcess();

        mocks.mockBuildDashCacheKey.mockReturnValue("cache-compat");
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey: "cache-compat",
            outputDir: "/tmp/cache-compat",
            manifestPath: "/tmp/cache-compat/manifest.mpd",
        });
        mocks.mockHasDashManifest.mockResolvedValueOnce(false).mockResolvedValue(true);
        mocks.mockEnsureDashAssetDirectory.mockResolvedValue(undefined);
        mocks.mockSpawn
            .mockReturnValueOnce(firstFfmpegProcess)
            .mockReturnValueOnce(secondFfmpegProcess);

        await segmentedSegmentService.ensureLocalDashSegments({
            trackId: "track-compat",
            sourcePath: "/music/track-compat.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "original",
        });
        await wait(0);

        const firstFfmpegArgs = mocks.mockSpawn.mock.calls[0][1] as string[];
        expect(firstFfmpegArgs).toContain("-ldash");

        firstFfmpegProcess.stderr.emit(
            "data",
            Buffer.from("Unrecognized option 'ldash'.\n"),
        );
        firstFfmpegProcess.emit("close", 1);
        await wait(0);

        const secondFfmpegArgs = mocks.mockSpawn.mock.calls[1][1] as string[];
        expect(secondFfmpegArgs).not.toContain("-ldash");
        expect(secondFfmpegArgs).toContain("-streaming");
        expect(secondFfmpegArgs).toContain("1");

        secondFfmpegProcess.emit("close", 0);
        await wait(0);

        expect(mocks.mockSpawn).toHaveBeenCalledTimes(2);
        expect(
            segmentedSegmentService.getBuildFailure("cache-compat"),
        ).toBeNull();
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
        expect(ffmpegArgs).toContain("-c:a:0");
        expect(ffmpegArgs).toContain("aac");
        expect(ffmpegArgs).toContain("-b:a:0");
        expect(ffmpegArgs).toContain("320k");
        expect(ffmpegArgs.filter((arg) => arg === "-map")).toHaveLength(1);

        ffmpegProcess.emit("close", 0);
        await wait(0);
    });

    it("uses SEGMENTED_LOCAL_SEG_DURATION_SEC for local DASH generation", async () => {
        process.env.SEGMENTED_LOCAL_SEG_DURATION_SEC = "0.5";
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const ffmpegProcess = createMockFfmpegProcess();

        mocks.mockBuildDashCacheKey.mockReturnValue("cache-local-seg-duration");
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey: "cache-local-seg-duration",
            outputDir: "/tmp/cache-local-seg-duration",
            manifestPath: "/tmp/cache-local-seg-duration/manifest.mpd",
        });
        mocks.mockHasDashManifest.mockResolvedValueOnce(false).mockResolvedValue(true);
        mocks.mockEnsureDashAssetDirectory.mockResolvedValue(undefined);
        mocks.mockSpawn.mockReturnValue(ffmpegProcess);

        await segmentedSegmentService.ensureLocalDashSegments({
            trackId: "track-local-seg-duration",
            sourcePath: "/music/track-local-seg-duration.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium",
        });
        await wait(0);

        const ffmpegArgs = mocks.mockSpawn.mock.calls[0][1] as string[];
        const segDurationIndex = ffmpegArgs.indexOf("-seg_duration");
        expect(segDurationIndex).toBeGreaterThanOrEqual(0);
        expect(ffmpegArgs[segDurationIndex + 1]).toBe("0.5");

        ffmpegProcess.emit("close", 0);
        await wait(0);
    });

    it("adds reconnect-safe ffmpeg input args for remote DASH sources", async () => {
        process.env.SEGMENTED_LOCAL_SEG_DURATION_SEC = "0.5";
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const ffmpegProcess = createMockFfmpegProcess();

        mocks.mockBuildDashCacheKey.mockReturnValue("cache-remote");
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey: "cache-remote",
            outputDir: "/tmp/cache-remote",
            manifestPath: "/tmp/cache-remote/manifest.mpd",
        });
        mocks.mockHasDashManifest.mockResolvedValueOnce(false).mockResolvedValue(true);
        mocks.mockEnsureDashAssetDirectory.mockResolvedValue(undefined);
        mocks.mockSpawn.mockReturnValue(ffmpegProcess);

        await segmentedSegmentService.ensureLocalDashSegments({
            trackId: "track-remote",
            sourcePath: "https://example.com/user/stream/12345?user_id=u1",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium",
        });
        await wait(0);

        const ffmpegArgs = mocks.mockSpawn.mock.calls[0][1] as string[];
        expect(ffmpegArgs).toContain("-reconnect");
        expect(ffmpegArgs).toContain("-reconnect_streamed");
        expect(ffmpegArgs).toContain("-reconnect_on_network_error");
        expect(ffmpegArgs).toContain("-reconnect_on_http_error");
        expect(ffmpegArgs).toContain("4xx,5xx");
        expect(ffmpegArgs).toContain("-rw_timeout");
        expect(ffmpegArgs).toContain("15000000");
        const segDurationIndex = ffmpegArgs.indexOf("-seg_duration");
        expect(segDurationIndex).toBeGreaterThanOrEqual(0);
        expect(ffmpegArgs[segDurationIndex + 1]).toBe("2");

        ffmpegProcess.emit("close", 0);
        await wait(0);
    });

    it("retries remote generation without unsupported reconnect flag", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const firstFfmpegProcess = createMockFfmpegProcess();
        const secondFfmpegProcess = createMockFfmpegProcess();

        mocks.mockBuildDashCacheKey.mockReturnValue("cache-remote-compat");
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey: "cache-remote-compat",
            outputDir: "/tmp/cache-remote-compat",
            manifestPath: "/tmp/cache-remote-compat/manifest.mpd",
        });
        mocks.mockHasDashManifest.mockResolvedValueOnce(false).mockResolvedValue(true);
        mocks.mockEnsureDashAssetDirectory.mockResolvedValue(undefined);
        mocks.mockSpawn
            .mockReturnValueOnce(firstFfmpegProcess)
            .mockReturnValueOnce(secondFfmpegProcess);

        await segmentedSegmentService.ensureLocalDashSegments({
            trackId: "track-remote-compat",
            sourcePath: "https://example.com/user/stream/12345?user_id=u1",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium",
        });
        await wait(0);

        const firstFfmpegArgs = mocks.mockSpawn.mock.calls[0][1] as string[];
        expect(firstFfmpegArgs).toContain("-reconnect_on_network_error");

        firstFfmpegProcess.stderr.emit(
            "data",
            Buffer.from("Unrecognized option 'reconnect_on_network_error'.\n"),
        );
        firstFfmpegProcess.emit("close", 1);
        await wait(0);

        const secondFfmpegArgs = mocks.mockSpawn.mock.calls[1][1] as string[];
        expect(secondFfmpegArgs).not.toContain("-reconnect_on_network_error");
        expect(secondFfmpegArgs).toContain("-reconnect");
        expect(secondFfmpegArgs).toContain("-rw_timeout");

        secondFfmpegProcess.emit("close", 0);
        await wait(0);

        expect(mocks.mockSpawn).toHaveBeenCalledTimes(2);
        expect(
            segmentedSegmentService.getBuildFailure("cache-remote-compat"),
        ).toBeNull();
    });
});
