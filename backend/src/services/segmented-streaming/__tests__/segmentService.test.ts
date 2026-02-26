import { EventEmitter } from "events";
import { promises as fsPromises } from "fs";

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
    const mockRemoveDashAsset = jest.fn();
    const mockListDashSegments = jest.fn();
    const mockScheduleDashCachePrune = jest.fn();
    const mockSpawn = jest.fn();
    const heldBuildLocks = new Map<string, string>();
    const mockBuildLockSet = jest.fn(
        async (
            lockKey: string,
            lockToken: string,
            _mode: "EX",
            _ttlSeconds: number,
            _condition: "NX",
        ) => {
            if (heldBuildLocks.has(lockKey)) {
                return null;
            }
            heldBuildLocks.set(lockKey, lockToken);
            return "OK";
        },
    );
    const mockBuildLockEval = jest.fn(
        async (
            _script: string,
            _numKeys: number,
            lockKey: string,
            lockToken: string,
        ) => {
            if (heldBuildLocks.get(lockKey) !== lockToken) {
                return 0;
            }
            heldBuildLocks.delete(lockKey);
            return 1;
        },
    );
    const mockBuildLockExists = jest.fn(async (lockKey: string) =>
        heldBuildLocks.has(lockKey) ? 1 : 0,
    );
    const mockCreateIORedisClient = jest.fn(() => ({
        set: (...args: Parameters<typeof mockBuildLockSet>) =>
            mockBuildLockSet(...args),
        exists: (...args: Parameters<typeof mockBuildLockExists>) =>
            mockBuildLockExists(...args),
        eval: (...args: Parameters<typeof mockBuildLockEval>) =>
            mockBuildLockEval(...args),
    }));

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
            removeDashAsset: (...args: unknown[]) =>
                mockRemoveDashAsset(...args),
            listDashSegments: (...args: unknown[]) =>
                mockListDashSegments(...args),
            scheduleDashCachePrune: (...args: unknown[]) =>
                mockScheduleDashCachePrune(...args),
        },
    }));

    jest.doMock("../../../utils/ioredis", () => ({
        createIORedisClient: mockCreateIORedisClient,
    }));

    const module = await import("../segmentService");

    return {
        segmentedSegmentService: module.segmentedSegmentService,
        SegmentedSegmentService: module.SegmentedSegmentService,
        mocks: {
            mockBuildDashCacheKey,
            mockGetDashAssetPaths,
            mockHasDashManifest,
            mockEnsureDashAssetDirectory,
            mockRemoveDashAsset,
            mockListDashSegments,
            mockScheduleDashCachePrune,
            mockSpawn,
            mockBuildLockSet,
            mockBuildLockExists,
            mockBuildLockEval,
            mockCreateIORedisClient,
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
        jest.dontMock("../../../utils/ioredis");
        jest.restoreAllMocks();
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
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });
        expect(mocks.mockScheduleDashCachePrune).toHaveBeenCalledTimes(1);
        expect(mocks.mockSpawn).toHaveBeenCalledTimes(1);

        ffmpegProcess.emit("close", 0);
        await wait(0);
    });

    it("falls back to local ensure rebuild when a distributed lock is already held", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-lock-held";
        const ffmpegProcess = createMockFfmpegProcess();

        mocks.mockBuildLockSet.mockResolvedValueOnce(null);
        mocks.mockBuildDashCacheKey.mockReturnValue(cacheKey);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        mocks.mockHasDashManifest.mockResolvedValueOnce(false).mockResolvedValue(true);
        mocks.mockEnsureDashAssetDirectory.mockResolvedValue(undefined);
        mocks.mockSpawn.mockReturnValue(ffmpegProcess);

        await expect(
            segmentedSegmentService.ensureLocalDashSegments({
                trackId: "track-lock-held",
                sourcePath: "/music/track-lock-held.flac",
                sourceModified: new Date("2026-02-20T00:00:00.000Z"),
                quality: "medium",
            }),
        ).resolves.toEqual({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });

        expect(mocks.mockSpawn).toHaveBeenCalledTimes(1);
        expect(mocks.mockBuildLockSet).toHaveBeenCalledTimes(1);
        expect(mocks.mockBuildLockSet.mock.calls[0]?.[0]).toBe(
            `segmented-streaming:dash-build-lock:${cacheKey}`,
        );
        expect(mocks.mockBuildLockSet.mock.calls[0]?.[2]).toBe("EX");
        expect(mocks.mockBuildLockSet.mock.calls[0]?.[4]).toBe("NX");
        expect(mocks.mockBuildLockEval).not.toHaveBeenCalled();

        ffmpegProcess.emit("close", 0);
        await wait(0);
    });

    it("keeps local-only hasInFlightBuild behavior while reporting distributed lock presence", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-distributed-inflight-only";
        const lockKey = `segmented-streaming:dash-build-lock:${cacheKey}`;

        await mocks.mockBuildLockSet(lockKey, "remote-lock-token", "EX", 30, "NX");

        expect(segmentedSegmentService.hasInFlightBuild(cacheKey)).toBe(false);
        await expect(
            segmentedSegmentService.getBuildInFlightStatus(cacheKey),
        ).resolves.toEqual({
            localInFlight: false,
            distributedInFlight: true,
            inFlight: true,
        });
    });

    it("short-circuits distributed lock checks when local build is already in-flight", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-local-inflight";
        (segmentedSegmentService as any).inFlightBuilds.set(
            cacheKey,
            Promise.resolve({
                cacheKey,
                outputDir: `/tmp/${cacheKey}`,
                manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
                manifestProfile: "steady_state_dual",
                quality: "medium",
            }),
        );
        mocks.mockBuildLockExists.mockRejectedValueOnce(
            new Error("should not query distributed lock"),
        );

        await expect(
            segmentedSegmentService.getBuildInFlightStatus(cacheKey),
        ).resolves.toEqual({
            localInFlight: true,
            distributedInFlight: false,
            inFlight: true,
        });
        expect(mocks.mockBuildLockExists).not.toHaveBeenCalled();
    });

    it("falls back to local in-flight status when distributed lock presence check errors", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-lock-exists-error-fallback";

        mocks.mockBuildLockExists.mockRejectedValueOnce(
            new Error("lock exists backend down"),
        );

        await expect(
            segmentedSegmentService.getBuildInFlightStatus(cacheKey),
        ).resolves.toEqual({
            localInFlight: false,
            distributedInFlight: false,
            inFlight: false,
        });
    });

    it("falls back to local guard when distributed lock acquisition errors", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const ffmpegProcess = createMockFfmpegProcess();
        const cacheKey = "cache-lock-error-fallback";

        mocks.mockBuildLockSet.mockRejectedValueOnce(new Error("lock backend down"));
        mocks.mockBuildDashCacheKey.mockReturnValue(cacheKey);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        mocks.mockHasDashManifest.mockResolvedValue(false);
        mocks.mockEnsureDashAssetDirectory.mockResolvedValue(undefined);
        mocks.mockSpawn.mockReturnValue(ffmpegProcess);

        await expect(
            segmentedSegmentService.ensureLocalDashSegments({
                trackId: "track-lock-error-fallback",
                sourcePath: "/music/track-lock-error-fallback.flac",
                sourceModified: new Date("2026-02-20T00:00:00.000Z"),
                quality: "medium",
            }),
        ).resolves.toEqual({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });

        expect(mocks.mockSpawn).toHaveBeenCalledTimes(1);

        ffmpegProcess.emit("close", 0);
        await wait(0);

        expect(mocks.mockBuildLockEval).not.toHaveBeenCalled();
    });

    it("releases distributed ensure lock after background generation settles", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const ffmpegProcess = createMockFfmpegProcess();
        const cacheKey = "cache-lock-release";

        mocks.mockBuildDashCacheKey.mockReturnValue(cacheKey);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        mocks.mockHasDashManifest.mockResolvedValue(false);
        mocks.mockEnsureDashAssetDirectory.mockResolvedValue(undefined);
        mocks.mockSpawn.mockReturnValue(ffmpegProcess);

        await segmentedSegmentService.ensureLocalDashSegments({
            trackId: "track-lock-release",
            sourcePath: "/music/track-lock-release.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium",
        });
        await wait(0);

        const lockSetArgs = mocks.mockBuildLockSet.mock.calls[0];
        expect(lockSetArgs).toBeDefined();

        ffmpegProcess.emit("close", 0);
        await wait(0);

        expect(mocks.mockBuildLockEval).toHaveBeenCalledTimes(1);
        expect(mocks.mockBuildLockEval).toHaveBeenCalledWith(
            expect.any(String),
            1,
            lockSetArgs?.[0],
            lockSetArgs?.[1],
        );
    });

    it("allows local rebuild fallback across independent service instances on lock conflict", async () => {
        const { SegmentedSegmentService, mocks } = await resolveSegmentService();
        const serviceA = new SegmentedSegmentService();
        const serviceB = new SegmentedSegmentService();
        const ffmpegProcess = createMockFfmpegProcess();
        const cacheKey = "cache-cross-instance";
        const ensureInput = {
            trackId: "track-cross-instance",
            sourcePath: "/music/track-cross-instance.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium" as const,
        };

        mocks.mockBuildDashCacheKey.mockReturnValue(cacheKey);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        mocks.mockHasDashManifest.mockResolvedValue(false);
        mocks.mockEnsureDashAssetDirectory.mockResolvedValue(undefined);
        mocks.mockSpawn.mockReturnValue(ffmpegProcess);

        const [resultA, resultB] = await Promise.all([
            serviceA.ensureLocalDashSegments(ensureInput),
            serviceB.ensureLocalDashSegments(ensureInput),
        ]);

        expect(resultA).toEqual({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });
        expect(resultB).toEqual({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });
        expect(mocks.mockBuildLockSet).toHaveBeenCalledTimes(2);
        expect(mocks.mockSpawn).toHaveBeenCalledTimes(2);

        ffmpegProcess.emit("close", 0);
        await wait(0);

        expect(mocks.mockBuildLockEval).toHaveBeenCalledTimes(1);
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
        jest
            .spyOn(segmentedSegmentService as any, "validateCachedDashAssetIfNeeded")
            .mockResolvedValue(true);

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
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });
        expect(mocks.mockScheduleDashCachePrune).toHaveBeenCalledTimes(1);
        expect(mocks.mockSpawn).not.toHaveBeenCalled();
    });

    it("queues async repair when cache validation is degraded but still usable", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-hit-degraded";
        const ensureInput = {
            trackId: "track-hit-degraded",
            sourcePath: "/music/track-hit-degraded.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium" as const,
        };

        mocks.mockBuildDashCacheKey.mockReturnValue(cacheKey);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        mocks.mockHasDashManifest.mockResolvedValue(true);
        jest
            .spyOn(segmentedSegmentService as any, "validateCachedDashAssetIfNeeded")
            .mockResolvedValue(true);
        (segmentedSegmentService as any).recoverableValidationFailures.set(cacheKey, {
            reason: "segment_too_small",
            segmentName: "chunk-0-00275.m4s",
            segmentCount: 558,
            detectedAtMs: Date.now() - 200,
        });
        const repairSpy = jest
            .spyOn(segmentedSegmentService, "forceRegenerateDashSegments")
            .mockResolvedValue(undefined);

        const result = await segmentedSegmentService.ensureLocalDashSegments(
            ensureInput,
        );

        expect(result).toEqual({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });
        expect(repairSpy).toHaveBeenCalledTimes(1);
        expect(repairSpy).toHaveBeenCalledWith({
            ...ensureInput,
            manifestProfile: "steady_state_dual",
        });
    });

    it("does not block cache-hit startup while background full validation runs", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-hit-background";
        const ensureInput = {
            trackId: "track-hit-background",
            sourcePath: "/music/track-hit-background.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium" as const,
        };
        let releaseFullValidation: (() => void) | undefined;
        const fullValidationGate = new Promise<void>((resolve) => {
            releaseFullValidation = resolve;
        });

        mocks.mockBuildDashCacheKey.mockReturnValue(cacheKey);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        mocks.mockHasDashManifest.mockResolvedValue(true);

        const validateSpy = jest
            .spyOn(segmentedSegmentService as any, "validateDashAssetFiles")
            .mockImplementation(async (...args: unknown[]) => {
                const mode = (args[1] as "startup" | "full" | undefined) ?? "full";
                if (mode === "startup") {
                    return {
                        valid: true,
                        segmentCount: 3,
                    };
                }
                await fullValidationGate;
                return {
                    valid: true,
                    segmentCount: 3,
                };
            });

        const result = await Promise.race([
            segmentedSegmentService.ensureLocalDashSegments(ensureInput),
            wait(40).then(() => "timeout"),
        ]);

        expect(result).not.toBe("timeout");
        expect(result).toEqual({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });
        expect(validateSpy).toHaveBeenCalledWith(cacheKey, "startup");

        releaseFullValidation?.();
        await wait(0);

        expect(validateSpy).toHaveBeenCalledWith(cacheKey, "full");
    });

    it("quarantines and repairs cache keys when background full validation fails", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-hit-background-invalid";
        const ensureInput = {
            trackId: "track-hit-background-invalid",
            sourcePath: "/music/track-hit-background-invalid.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium" as const,
        };

        mocks.mockBuildDashCacheKey.mockReturnValue(cacheKey);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        mocks.mockHasDashManifest.mockResolvedValue(true);
        const validateSpy = jest
            .spyOn(segmentedSegmentService as any, "validateDashAssetFiles")
            .mockImplementation(async (...args: unknown[]) => {
                const mode = (args[1] as "startup" | "full" | undefined) ?? "full";
                if (mode === "startup") {
                    return {
                        valid: true,
                        segmentCount: 4,
                    };
                }
                return {
                    valid: false,
                    reason: "segment_too_small",
                    segmentName: "chunk-1-00001.m4s",
                    segmentCount: 400,
                };
            });
        const repairSpy = jest
            .spyOn(segmentedSegmentService, "forceRegenerateDashSegments")
            .mockResolvedValue(undefined);

        const result = await segmentedSegmentService.ensureLocalDashSegments(ensureInput);

        expect(result).toEqual({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });
        await wait(0);

        expect(validateSpy).toHaveBeenCalledWith(cacheKey, "startup");
        expect(validateSpy).toHaveBeenCalledWith(cacheKey, "full");
        expect((segmentedSegmentService as any).invalidCacheKeys.has(cacheKey)).toBe(
            true,
        );
        expect(repairSpy).toHaveBeenCalledTimes(1);
        expect(repairSpy).toHaveBeenCalledWith({
            ...ensureInput,
            manifestProfile: "steady_state_dual",
        });
    });

    it("does not trigger duplicate rebuild during failure completion observers", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const ffmpegProcess = createMockFfmpegProcess();
        const cacheKey = "cache-race";
        const buildInput = {
            trackId: "track-race",
            sourcePath: "/music/track-race.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium" as const,
        };

        mocks.mockBuildDashCacheKey.mockReturnValue(cacheKey);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        mocks.mockHasDashManifest.mockResolvedValue(false);
        mocks.mockEnsureDashAssetDirectory.mockResolvedValue(undefined);
        mocks.mockSpawn.mockReturnValue(ffmpegProcess);

        await segmentedSegmentService.ensureLocalDashSegments(buildInput);
        await wait(0);

        const inFlightPromise = (segmentedSegmentService as any).inFlightBuilds.get(
            cacheKey,
        ) as Promise<unknown>;
        expect(inFlightPromise).toBeDefined();

        const observer = inFlightPromise.finally(async () => {
            const buildFailure = segmentedSegmentService.getBuildFailure(cacheKey);
            const hasInFlight = segmentedSegmentService.hasInFlightBuild(cacheKey);
            if (!buildFailure && !hasInFlight) {
                await segmentedSegmentService.ensureLocalDashSegments(buildInput);
            }
        });

        ffmpegProcess.emit("close", 1);
        await observer.catch(() => undefined);
        await wait(0);

        expect(segmentedSegmentService.hasInFlightBuild(cacheKey)).toBe(false);
        expect(segmentedSegmentService.getBuildFailure(cacheKey)).toBeInstanceOf(
            Error,
        );
        expect(mocks.mockSpawn).toHaveBeenCalledTimes(1);
    });

    it("keeps existing DASH assets available until staged force-regenerate promote", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-force-live";
        const outputDir = `/tmp/${cacheKey}`;
        let releaseStagedGeneration: (() => void) | undefined;
        const stagedGenerationGate = new Promise<void>((resolve) => {
            releaseStagedGeneration = resolve;
        });

        mocks.mockBuildDashCacheKey.mockReturnValue(cacheKey);
        mocks.mockGetDashAssetPaths.mockImplementation((requestedCacheKey: string) => ({
            cacheKey: requestedCacheKey,
            outputDir: `/tmp/${requestedCacheKey}`,
            manifestPath: `/tmp/${requestedCacheKey}/manifest.mpd`,
        }));
        mocks.mockRemoveDashAsset.mockResolvedValue(undefined);

        const generateSpy = jest
            .spyOn(segmentedSegmentService as any, "generateDashAsset")
            .mockImplementation(async (params: any) => {
                await stagedGenerationGate;
                return {
                    cacheKey: params.cacheKey,
                    outputDir: params.outputDir,
                    manifestPath: params.manifestPath,
                    manifestProfile: "steady_state_dual",
                    quality: params.quality,
                };
            });
        const validateSpy = jest
            .spyOn(segmentedSegmentService as any, "validateDashAssetFiles")
            .mockResolvedValue({
                valid: true,
                segmentCount: 3,
            });
        const accessSpy = jest
            .spyOn(fsPromises, "access")
            .mockImplementation(async (targetPath: unknown) => {
                if (String(targetPath) === outputDir) {
                    return;
                }
                const notFoundError = new Error("ENOENT");
                (notFoundError as NodeJS.ErrnoException).code = "ENOENT";
                throw notFoundError;
            });
        const renameSpy = jest
            .spyOn(fsPromises, "rename")
            .mockResolvedValue(undefined);

        await segmentedSegmentService.forceRegenerateDashSegments({
            trackId: "track-force-live",
            sourcePath: "/music/track-force-live.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium",
        });

        expect(generateSpy).toHaveBeenCalledTimes(1);
        expect(renameSpy).not.toHaveBeenCalled();
        expect(mocks.mockRemoveDashAsset).not.toHaveBeenCalledWith(cacheKey);

        releaseStagedGeneration?.();
        await wait(0);

        const stagedCacheKey = (generateSpy.mock.calls[0][0] as { cacheKey: string })
            .cacheKey;
        expect(stagedCacheKey).not.toBe(cacheKey);
        expect(validateSpy).toHaveBeenCalledWith(stagedCacheKey);
        expect(renameSpy).toHaveBeenCalledTimes(2);
        expect(renameSpy.mock.calls[0][0]).toBe(outputDir);
        expect(String(renameSpy.mock.calls[0][1])).toContain(
            `${outputDir}.previous.`,
        );
        expect(renameSpy.mock.calls[1]).toEqual([
            `/tmp/${stagedCacheKey}`,
            outputDir,
        ]);
        expect(accessSpy).toHaveBeenCalledWith(outputDir);
        expect(mocks.mockRemoveDashAsset).not.toHaveBeenCalledWith(cacheKey);
    });

    it("cleans staged force-regenerate artifacts on failure without deleting live assets", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-force-failure";
        const generationError = new Error("regeneration failed");

        mocks.mockBuildDashCacheKey.mockReturnValue(cacheKey);
        mocks.mockGetDashAssetPaths.mockImplementation((requestedCacheKey: string) => ({
            cacheKey: requestedCacheKey,
            outputDir: `/tmp/${requestedCacheKey}`,
            manifestPath: `/tmp/${requestedCacheKey}/manifest.mpd`,
        }));
        mocks.mockRemoveDashAsset.mockResolvedValue(undefined);

        const generateSpy = jest
            .spyOn(segmentedSegmentService as any, "generateDashAsset")
            .mockRejectedValue(generationError);
        const validateSpy = jest
            .spyOn(segmentedSegmentService as any, "validateDashAssetFiles")
            .mockResolvedValue({
                valid: true,
                segmentCount: 3,
            });
        const renameSpy = jest
            .spyOn(fsPromises, "rename")
            .mockResolvedValue(undefined);

        await segmentedSegmentService.forceRegenerateDashSegments({
            trackId: "track-force-failure",
            sourcePath: "/music/track-force-failure.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium",
        });
        await wait(0);

        const stagedCacheKey = (generateSpy.mock.calls[0][0] as { cacheKey: string })
            .cacheKey;

        expect(renameSpy).not.toHaveBeenCalled();
        expect(validateSpy).not.toHaveBeenCalled();
        expect(mocks.mockRemoveDashAsset).toHaveBeenCalledWith(stagedCacheKey);
        expect(mocks.mockRemoveDashAsset).not.toHaveBeenCalledWith(cacheKey);
        expect(segmentedSegmentService.hasInFlightBuild(cacheKey)).toBe(false);
        expect(segmentedSegmentService.getBuildFailure(cacheKey)).toBe(
            generationError,
        );
    });

    it("normalizes non-Error force-regeneration failures into Error instances", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-force-non-error";

        mocks.mockBuildDashCacheKey.mockReturnValue(cacheKey);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });

        jest.spyOn(
            segmentedSegmentService as any,
            "generateForceRegeneratedDashAsset",
        ).mockRejectedValue("non-error-failure");

        await segmentedSegmentService.forceRegenerateDashSegments({
            trackId: "track-force-non-error",
            sourcePath: "/music/track-force-non-error.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium",
        });
        await wait(0);

        const failure = segmentedSegmentService.getBuildFailure(cacheKey);
        expect(failure).toBeInstanceOf(Error);
        expect(failure?.message).toContain("non-error-failure");
    });

    it("chunks local original lossless tracks as FLAC fMP4-DASH (no lossy bitrate)", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const ffmpegProcess = createMockFfmpegProcess();
        const readManifestSpy = jest
            .spyOn(fsPromises, "readFile")
            .mockResolvedValue('<Representation codecs="flac" />');
        const writeManifestSpy = jest
            .spyOn(fsPromises, "writeFile")
            .mockResolvedValue(undefined);
        jest.spyOn(fsPromises, "access").mockResolvedValue(undefined);

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
        expect(ffmpegArgs).toContain("-fflags");
        expect(ffmpegArgs).toContain("+genpts");
        expect(ffmpegArgs).toContain("-c:a:1");
        const codec0Index = ffmpegArgs.indexOf("-c:a:0");
        const codec1Index = ffmpegArgs.indexOf("-c:a:1");
        expect(codec0Index).toBeGreaterThanOrEqual(0);
        expect(codec1Index).toBeGreaterThanOrEqual(0);
        expect(ffmpegArgs[codec0Index + 1]).toBe("flac");
        expect(ffmpegArgs[codec1Index + 1]).toBe("aac");
        expect(ffmpegArgs).not.toContain("-b:a:0");
        expect(ffmpegArgs).toContain("-b:a:1");
        expect(ffmpegArgs).toContain("320k");
        expect(ffmpegArgs).toContain("-adaptation_sets");
        expect(ffmpegArgs).toContain("id=0,streams=a");
        expect(ffmpegArgs.filter((arg) => arg === "-map")).toHaveLength(2);
        expect(ffmpegArgs).toContain("flac");
        expect(ffmpegArgs).toContain("-strict");
        expect(ffmpegArgs).toContain("-2");
        expect(ffmpegArgs).toContain("-streaming");
        expect(ffmpegArgs).toContain("1");
        expect(ffmpegArgs).toContain("-ldash");
        expect(ffmpegArgs).toContain("-window_size");
        expect(ffmpegArgs).toContain("0");
        expect(ffmpegArgs).toContain("-extra_window_size");
        expect(ffmpegArgs).toContain("-remove_at_exit");
        expect(ffmpegArgs).toContain("-start_number");
        expect(ffmpegArgs).toContain("init-$RepresentationID$.m4s");
        expect(ffmpegArgs).toContain("chunk-$RepresentationID$-$Number%05d$.m4s");
        expect(ffmpegArgs).not.toContain("128k");

        ffmpegProcess.emit("close", 0);
        await wait(0);
        expect(readManifestSpy).toHaveBeenCalledWith(
            "/tmp/cache-original/manifest.mpd",
            "utf8",
        );
        expect(writeManifestSpy).toHaveBeenCalledWith(
            "/tmp/cache-original/manifest.mpd",
            expect.stringContaining('codecs="fLaC"'),
            "utf8",
        );
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
                "Muxer dash [Dynamic Adaptive Streaming over HTTP]:\n  -streaming         E.......... Enable streaming\n  -ldash             E.......... Enable Low-latency dash\n",
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
        expect(ffmpegArgs).toContain("-streaming");
        expect(ffmpegArgs).toContain("1");
        expect(ffmpegArgs).toContain("-ldash");

        ffmpegProcess.emit("close", 0);
        await wait(0);
    });

    it("retries generation without -streaming when ffmpeg build does not support it", async () => {
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
        expect(firstFfmpegArgs).toContain("-streaming");
        expect(firstFfmpegArgs).toContain("-ldash");

        firstFfmpegProcess.stderr.emit(
            "data",
            Buffer.from("Unrecognized option 'streaming'.\n"),
        );
        firstFfmpegProcess.emit("close", 1);
        await wait(0);

        const secondFfmpegArgs = mocks.mockSpawn.mock.calls[1][1] as string[];
        expect(secondFfmpegArgs).not.toContain("-streaming");
        expect(secondFfmpegArgs).toContain("-ldash");

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
        expect(ffmpegArgs).toContain("-c:a:1");
        expect(ffmpegArgs).toContain("-b:a:1");
        expect(ffmpegArgs).toContain("192k");
        expect(ffmpegArgs.filter((arg) => arg === "-map")).toHaveLength(2);
        expect(ffmpegArgs).toContain("-ldash");

        ffmpegProcess.emit("close", 0);
        await wait(0);
    });

    it("retries generation without -ldash when ffmpeg build does not support it", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const firstFfmpegProcess = createMockFfmpegProcess();
        const secondFfmpegProcess = createMockFfmpegProcess();

        mocks.mockBuildDashCacheKey.mockReturnValue("cache-ldash-compat");
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey: "cache-ldash-compat",
            outputDir: "/tmp/cache-ldash-compat",
            manifestPath: "/tmp/cache-ldash-compat/manifest.mpd",
        });
        mocks.mockHasDashManifest.mockResolvedValueOnce(false).mockResolvedValue(true);
        mocks.mockEnsureDashAssetDirectory.mockResolvedValue(undefined);
        mocks.mockSpawn
            .mockReturnValueOnce(firstFfmpegProcess)
            .mockReturnValueOnce(secondFfmpegProcess);

        await segmentedSegmentService.ensureLocalDashSegments({
            trackId: "track-ldash-compat",
            sourcePath: "/music/track-ldash-compat.flac",
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

        secondFfmpegProcess.emit("close", 0);
        await wait(0);

        expect(mocks.mockSpawn).toHaveBeenCalledTimes(2);
        expect(
            segmentedSegmentService.getBuildFailure("cache-ldash-compat"),
        ).toBeNull();
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

    it("uses a 1-second local DASH segment default when env override is unset", async () => {
        delete process.env.SEGMENTED_LOCAL_SEG_DURATION_SEC;
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const ffmpegProcess = createMockFfmpegProcess();

        mocks.mockBuildDashCacheKey.mockReturnValue("cache-local-default-seg-duration");
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey: "cache-local-default-seg-duration",
            outputDir: "/tmp/cache-local-default-seg-duration",
            manifestPath: "/tmp/cache-local-default-seg-duration/manifest.mpd",
        });
        mocks.mockHasDashManifest.mockResolvedValueOnce(false).mockResolvedValue(true);
        mocks.mockEnsureDashAssetDirectory.mockResolvedValue(undefined);
        mocks.mockSpawn.mockReturnValue(ffmpegProcess);

        await segmentedSegmentService.ensureLocalDashSegments({
            trackId: "track-local-default-seg-duration",
            sourcePath: "/music/track-local-default-seg-duration.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium",
        });
        await wait(0);

        const ffmpegArgs = mocks.mockSpawn.mock.calls[0][1] as string[];
        const segDurationIndex = ffmpegArgs.indexOf("-seg_duration");
        expect(segDurationIndex).toBeGreaterThanOrEqual(0);
        expect(ffmpegArgs[segDurationIndex + 1]).toBe("1");

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
        expect(ffmpegArgs).toContain("-fflags");
        expect(ffmpegArgs).toContain("+genpts");
        expect(ffmpegArgs).toContain("-ldash");
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

    it("returns cached paths while an identical ensure request is already building", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const ffmpegProcess = createMockFfmpegProcess();
        const cacheKey = "cache-inflight-paths";
        const ensureInput = {
            trackId: "track-inflight-paths",
            sourcePath: "/music/track-inflight-paths.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium" as const,
        };

        mocks.mockBuildDashCacheKey.mockReturnValue(cacheKey);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        mocks.mockHasDashManifest.mockResolvedValue(false);
        mocks.mockEnsureDashAssetDirectory.mockResolvedValue(undefined);
        mocks.mockSpawn.mockReturnValue(ffmpegProcess);

        const firstEnsureResult =
            await segmentedSegmentService.ensureLocalDashSegments(ensureInput);
        const secondEnsureResult =
            await segmentedSegmentService.ensureLocalDashSegments(ensureInput);

        expect(firstEnsureResult).toEqual({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });
        expect(secondEnsureResult).toEqual({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });
        expect(mocks.mockSpawn).toHaveBeenCalledTimes(1);

        ffmpegProcess.emit("close", 0);
        await wait(0);
    });

    it("invalidates and removes a cache key marked invalid before rebuilding", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-invalidated";

        mocks.mockBuildDashCacheKey.mockReturnValue(cacheKey);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        mocks.mockHasDashManifest.mockResolvedValue(true);
        mocks.mockRemoveDashAsset.mockResolvedValue(undefined);

        const generateSpy = jest
            .spyOn(segmentedSegmentService as any, "generateDashAsset")
            .mockResolvedValue({
                cacheKey,
                outputDir: `/tmp/${cacheKey}`,
                manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
                manifestProfile: "steady_state_dual",
                quality: "medium",
            });
        (segmentedSegmentService as any).invalidCacheKeys.add(cacheKey);

        await segmentedSegmentService.ensureLocalDashSegments({
            trackId: "track-invalidated",
            sourcePath: "/music/track-invalidated.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium",
        });

        expect(mocks.mockRemoveDashAsset).toHaveBeenCalledWith(cacheKey);
        expect(generateSpy).toHaveBeenCalledTimes(1);
    });

    it("skips force regenerate when the same cache key is already in-flight", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-force-inflight";
        let resolveGeneration:
            | ((value: {
                  cacheKey: string;
                  outputDir: string;
                  manifestPath: string;
                  manifestProfile: "steady_state_dual";
                  quality: "medium";
              }) => void)
            | undefined;
        const generationPromise = new Promise<{
            cacheKey: string;
            outputDir: string;
            manifestPath: string;
            manifestProfile: "steady_state_dual";
            quality: "medium";
        }>((resolve) => {
            resolveGeneration = resolve;
        });

        mocks.mockBuildDashCacheKey.mockReturnValue(cacheKey);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });

        const generateForceSpy = jest
            .spyOn(segmentedSegmentService as any, "generateForceRegeneratedDashAsset")
            .mockReturnValue(generationPromise);

        await segmentedSegmentService.forceRegenerateDashSegments({
            trackId: "track-force-inflight",
            sourcePath: "/music/track-force-inflight.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium",
        });
        await segmentedSegmentService.forceRegenerateDashSegments({
            trackId: "track-force-inflight",
            sourcePath: "/music/track-force-inflight.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium",
        });

        expect(generateForceSpy).toHaveBeenCalledTimes(1);

        resolveGeneration?.({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });
        await wait(0);
    });

    it("skips force regenerate when distributed lock acquisition returns conflict", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-force-lock-conflict";

        mocks.mockBuildLockSet.mockResolvedValueOnce(null);
        mocks.mockBuildDashCacheKey.mockReturnValue(cacheKey);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        const generateForceSpy = jest.spyOn(
            segmentedSegmentService as any,
            "generateForceRegeneratedDashAsset",
        );

        await segmentedSegmentService.forceRegenerateDashSegments({
            trackId: "track-force-lock-conflict",
            sourcePath: "/music/track-force-lock-conflict.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium",
        });

        expect(generateForceSpy).not.toHaveBeenCalled();
        expect(mocks.mockBuildLockSet).toHaveBeenCalledTimes(1);
        expect(mocks.mockBuildLockEval).not.toHaveBeenCalled();
    });

    it("releases distributed force-regenerate lock after completion", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-force-lock-release";

        mocks.mockBuildDashCacheKey.mockReturnValue(cacheKey);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        jest.spyOn(
            segmentedSegmentService as any,
            "generateForceRegeneratedDashAsset",
        ).mockResolvedValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });

        await segmentedSegmentService.forceRegenerateDashSegments({
            trackId: "track-force-lock-release",
            sourcePath: "/music/track-force-lock-release.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium",
        });
        await wait(0);

        const lockSetArgs = mocks.mockBuildLockSet.mock.calls[0];
        expect(lockSetArgs).toBeDefined();
        expect(mocks.mockBuildLockEval).toHaveBeenCalledTimes(1);
        expect(mocks.mockBuildLockEval).toHaveBeenCalledWith(
            expect.any(String),
            1,
            lockSetArgs?.[0],
            lockSetArgs?.[1],
        );
    });

    it("throws when staged regeneration validation fails", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-force-validation-fail";

        mocks.mockGetDashAssetPaths.mockImplementation((requestedCacheKey: string) => ({
            cacheKey: requestedCacheKey,
            outputDir: `/tmp/${requestedCacheKey}`,
            manifestPath: `/tmp/${requestedCacheKey}/manifest.mpd`,
        }));
        mocks.mockRemoveDashAsset.mockResolvedValue(undefined);

        jest.spyOn(segmentedSegmentService as any, "generateDashAsset").mockResolvedValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });
        jest.spyOn(segmentedSegmentService as any, "validateDashAssetFiles").mockResolvedValue({
            valid: false,
            reason: "segments_missing",
            segmentCount: 0,
        });

        await expect(
            (segmentedSegmentService as any).generateForceRegeneratedDashAsset({
                trackId: "track-force-validation-fail",
                sourcePath: "/music/track-force-validation-fail.flac",
                quality: "medium",
                manifestProfile: "steady_state_dual",
                cacheKey,
                outputDir: `/tmp/${cacheKey}`,
                manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            }),
        ).rejects.toThrow("validation failed");
    });

    it("uses unknown validation reason when staged regeneration validation omits reason", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-force-validation-unknown";

        mocks.mockGetDashAssetPaths.mockImplementation((requestedCacheKey: string) => ({
            cacheKey: requestedCacheKey,
            outputDir: `/tmp/${requestedCacheKey}`,
            manifestPath: `/tmp/${requestedCacheKey}/manifest.mpd`,
        }));
        mocks.mockRemoveDashAsset.mockResolvedValue(undefined);

        jest.spyOn(segmentedSegmentService as any, "generateDashAsset").mockResolvedValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });
        jest.spyOn(segmentedSegmentService as any, "validateDashAssetFiles").mockResolvedValue({
            valid: false,
            reason: undefined,
            segmentCount: 0,
        });

        await expect(
            (segmentedSegmentService as any).generateForceRegeneratedDashAsset({
                trackId: "track-force-validation-unknown",
                sourcePath: "/music/track-force-validation-unknown.flac",
                quality: "medium",
                manifestProfile: "steady_state_dual",
                cacheKey,
                outputDir: `/tmp/${cacheKey}`,
                manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            }),
        ).rejects.toThrow("unknown");
    });

    it("promotes staged assets directly when no live output directory exists", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-force-no-live";

        mocks.mockGetDashAssetPaths.mockImplementation((requestedCacheKey: string) => ({
            cacheKey: requestedCacheKey,
            outputDir: `/tmp/${requestedCacheKey}`,
            manifestPath: `/tmp/${requestedCacheKey}/manifest.mpd`,
        }));
        mocks.mockRemoveDashAsset.mockResolvedValue(undefined);
        jest.spyOn(segmentedSegmentService as any, "generateDashAsset").mockResolvedValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });
        jest.spyOn(segmentedSegmentService as any, "validateDashAssetFiles").mockResolvedValue({
            valid: true,
            segmentCount: 2,
        });
        jest.spyOn(fsPromises, "access").mockRejectedValue(
            Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
        );
        const renameSpy = jest.spyOn(fsPromises, "rename").mockResolvedValue(undefined);

        await expect(
            (segmentedSegmentService as any).generateForceRegeneratedDashAsset({
                trackId: "track-force-no-live",
                sourcePath: "/music/track-force-no-live.flac",
                quality: "medium",
                manifestProfile: "steady_state_dual",
                cacheKey,
                outputDir: `/tmp/${cacheKey}`,
                manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            }),
        ).resolves.toEqual({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });
        expect(renameSpy).toHaveBeenCalledTimes(1);
    });

    it("attempts rollback restore when staged promote fails after backing up live assets", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-force-rollback";
        const outputDir = `/tmp/${cacheKey}`;
        const promoteError = new Error("promote failed");

        mocks.mockGetDashAssetPaths.mockImplementation((requestedCacheKey: string) => ({
            cacheKey: requestedCacheKey,
            outputDir: `/tmp/${requestedCacheKey}`,
            manifestPath: `/tmp/${requestedCacheKey}/manifest.mpd`,
        }));
        mocks.mockRemoveDashAsset.mockResolvedValue(undefined);
        jest.spyOn(segmentedSegmentService as any, "generateDashAsset").mockResolvedValue({
            cacheKey,
            outputDir,
            manifestPath: `${outputDir}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });
        jest.spyOn(segmentedSegmentService as any, "validateDashAssetFiles").mockResolvedValue({
            valid: true,
            segmentCount: 2,
        });
        jest.spyOn(fsPromises, "access").mockResolvedValue(undefined);
        const renameSpy = jest
            .spyOn(fsPromises, "rename")
            .mockImplementation(async (fromPath, toPath) => {
                const from = String(fromPath);
                const to = String(toPath);
                if (from === outputDir && to.startsWith(`${outputDir}.previous.`)) {
                    return;
                }
                throw promoteError;
            });
        const restoreSpy = jest
            .spyOn(segmentedSegmentService as any, "tryRestoreForceRegenerateBackup")
            .mockResolvedValue(undefined);

        await expect(
            (segmentedSegmentService as any).generateForceRegeneratedDashAsset({
                trackId: "track-force-rollback",
                sourcePath: "/music/track-force-rollback.flac",
                quality: "medium",
                manifestProfile: "steady_state_dual",
                cacheKey,
                outputDir,
                manifestPath: `${outputDir}/manifest.mpd`,
            }),
        ).rejects.toBe(promoteError);

        expect(renameSpy).toHaveBeenCalled();
        expect(restoreSpy).toHaveBeenCalledTimes(1);
    });

    it("throws promote failure without rollback when no live backup was created", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-force-promote-no-backup";
        const outputDir = `/tmp/${cacheKey}`;
        const promoteError = new Error("promote failed without backup");

        mocks.mockGetDashAssetPaths.mockImplementation((requestedCacheKey: string) => ({
            cacheKey: requestedCacheKey,
            outputDir: `/tmp/${requestedCacheKey}`,
            manifestPath: `/tmp/${requestedCacheKey}/manifest.mpd`,
        }));
        mocks.mockRemoveDashAsset.mockResolvedValue(undefined);
        jest.spyOn(segmentedSegmentService as any, "generateDashAsset").mockResolvedValue({
            cacheKey,
            outputDir,
            manifestPath: `${outputDir}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });
        jest.spyOn(segmentedSegmentService as any, "validateDashAssetFiles").mockResolvedValue({
            valid: true,
            segmentCount: 2,
        });
        jest.spyOn(fsPromises, "access").mockRejectedValue(
            Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
        );
        jest.spyOn(fsPromises, "rename").mockRejectedValue(promoteError);
        const restoreSpy = jest.spyOn(
            segmentedSegmentService as any,
            "tryRestoreForceRegenerateBackup",
        );

        await expect(
            (segmentedSegmentService as any).generateForceRegeneratedDashAsset({
                trackId: "track-force-promote-no-backup",
                sourcePath: "/music/track-force-promote-no-backup.flac",
                quality: "medium",
                manifestProfile: "steady_state_dual",
                cacheKey,
                outputDir,
                manifestPath: `${outputDir}/manifest.mpd`,
            }),
        ).rejects.toBe(promoteError);
        expect(restoreSpy).not.toHaveBeenCalled();
    });

    it("continues successfully when backup cleanup after promote fails", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-force-backup-cleanup";
        const outputDir = `/tmp/${cacheKey}`;

        mocks.mockGetDashAssetPaths.mockImplementation((requestedCacheKey: string) => ({
            cacheKey: requestedCacheKey,
            outputDir: `/tmp/${requestedCacheKey}`,
            manifestPath: `/tmp/${requestedCacheKey}/manifest.mpd`,
        }));
        mocks.mockRemoveDashAsset.mockResolvedValue(undefined);
        jest.spyOn(segmentedSegmentService as any, "generateDashAsset").mockResolvedValue({
            cacheKey,
            outputDir,
            manifestPath: `${outputDir}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });
        jest.spyOn(segmentedSegmentService as any, "validateDashAssetFiles").mockResolvedValue({
            valid: true,
            segmentCount: 2,
        });
        jest.spyOn(fsPromises, "access").mockResolvedValue(undefined);
        const renameSpy = jest.spyOn(fsPromises, "rename").mockResolvedValue(undefined);
        const rmSpy = jest
            .spyOn(fsPromises, "rm")
            .mockRejectedValue(new Error("cleanup failed"));

        await expect(
            (segmentedSegmentService as any).generateForceRegeneratedDashAsset({
                trackId: "track-force-backup-cleanup",
                sourcePath: "/music/track-force-backup-cleanup.flac",
                quality: "medium",
                manifestProfile: "steady_state_dual",
                cacheKey,
                outputDir,
                manifestPath: `${outputDir}/manifest.mpd`,
            }),
        ).resolves.toEqual({
            cacheKey,
            outputDir,
            manifestPath: `${outputDir}/manifest.mpd`,
            manifestProfile: "steady_state_dual",
            quality: "medium",
        });

        expect(renameSpy).toHaveBeenCalledTimes(2);
        expect(rmSpy).toHaveBeenCalledTimes(1);
    });

    it("keeps original regeneration error when staged cleanup itself also fails", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-force-cleanup-error";
        const generationError = new Error("generation failed");

        mocks.mockGetDashAssetPaths.mockImplementation((requestedCacheKey: string) => ({
            cacheKey: requestedCacheKey,
            outputDir: `/tmp/${requestedCacheKey}`,
            manifestPath: `/tmp/${requestedCacheKey}/manifest.mpd`,
        }));
        mocks.mockRemoveDashAsset.mockRejectedValue(new Error("cleanup failed"));
        jest.spyOn(segmentedSegmentService as any, "generateDashAsset").mockRejectedValue(
            generationError,
        );

        await expect(
            (segmentedSegmentService as any).generateForceRegeneratedDashAsset({
                trackId: "track-force-cleanup-error",
                sourcePath: "/music/track-force-cleanup-error.flac",
                quality: "medium",
                manifestProfile: "steady_state_dual",
                cacheKey,
                outputDir: `/tmp/${cacheKey}`,
                manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
            }),
        ).rejects.toBe(generationError);
    });

    it("restores live assets from backup when rollback rename succeeds", async () => {
        const { segmentedSegmentService } = await resolveSegmentService();
        const renameSpy = jest.spyOn(fsPromises, "rename").mockResolvedValue(undefined);

        await expect(
            (segmentedSegmentService as any).tryRestoreForceRegenerateBackup({
                backupOutputDir: "/tmp/cache-restore.previous",
                liveOutputDir: "/tmp/cache-restore",
                trackId: "track-restore",
                quality: "medium",
                sourceKind: "local",
                cacheKey: "cache-restore",
            }),
        ).resolves.toBeUndefined();
        expect(renameSpy).toHaveBeenCalledWith(
            "/tmp/cache-restore.previous",
            "/tmp/cache-restore",
        );
    });

    it("swallows rollback restore errors and keeps regeneration flow moving", async () => {
        const { segmentedSegmentService } = await resolveSegmentService();
        jest.spyOn(fsPromises, "rename").mockRejectedValue(new Error("restore failed"));

        await expect(
            (segmentedSegmentService as any).tryRestoreForceRegenerateBackup({
                backupOutputDir: "/tmp/cache-restore-error.previous",
                liveOutputDir: "/tmp/cache-restore-error",
                trackId: "track-restore-error",
                quality: "medium",
                sourceKind: "local",
                cacheKey: "cache-restore-error",
            }),
        ).resolves.toBeUndefined();
    });

    it("deduplicates background cache validation while one validation is already in-flight", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-validation-dedupe";
        let releaseValidation: ((result: boolean) => void) | undefined;
        const validationGate = new Promise<boolean>((resolve) => {
            releaseValidation = resolve;
        });

        mocks.mockBuildDashCacheKey.mockReturnValue(cacheKey);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        mocks.mockHasDashManifest.mockResolvedValue(true);
        const validateSpy = jest
            .spyOn(segmentedSegmentService as any, "validateCachedDashAsset")
            .mockReturnValue(validationGate);

        const firstEnsurePromise = segmentedSegmentService.ensureLocalDashSegments({
            trackId: "track-validation-dedupe",
            sourcePath: "/music/track-validation-dedupe.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium",
        });
        const secondEnsurePromise = segmentedSegmentService.ensureLocalDashSegments({
            trackId: "track-validation-dedupe",
            sourcePath: "/music/track-validation-dedupe.flac",
            sourceModified: new Date("2026-02-20T00:00:00.000Z"),
            quality: "medium",
        });

        await wait(0);
        expect(validateSpy).toHaveBeenCalledTimes(1);

        releaseValidation?.(true);
        await expect(
            Promise.all([firstEnsurePromise, secondEnsurePromise]),
        ).resolves.toEqual([
            {
                cacheKey,
                outputDir: `/tmp/${cacheKey}`,
                manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
                manifestProfile: "steady_state_dual",
                quality: "medium",
            },
            {
                cacheKey,
                outputDir: `/tmp/${cacheKey}`,
                manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
                manifestProfile: "steady_state_dual",
                quality: "medium",
            },
        ]);
    });

    it("leaves cache key valid when cached asset validation succeeds", async () => {
        const { segmentedSegmentService } = await resolveSegmentService();
        const cacheKey = "cache-validate-ok";

        jest.spyOn(segmentedSegmentService as any, "validateDashAssetFiles").mockResolvedValue(
            {
                valid: true,
                segmentCount: 3,
            },
        );

        await expect(
            (segmentedSegmentService as any).validateCachedDashAsset({
                cacheKey,
                trackId: "track-validate-ok",
                quality: "medium",
                sourceKind: "local",
            }),
        ).resolves.toBe(true);
        expect((segmentedSegmentService as any).invalidCacheKeys.has(cacheKey)).toBe(
            false,
        );
    });

    it("marks cache key invalid when cached asset validation fails", async () => {
        const { segmentedSegmentService } = await resolveSegmentService();
        const cacheKey = "cache-validate-invalid";

        jest.spyOn(segmentedSegmentService as any, "validateDashAssetFiles").mockResolvedValue(
            {
                valid: false,
                reason: "segment_too_small",
                segmentCount: 1,
                segmentName: "chunk-0-00001.m4s",
            },
        );

        await expect(
            (segmentedSegmentService as any).validateCachedDashAsset({
                cacheKey,
                trackId: "track-validate-invalid",
                quality: "medium",
                sourceKind: "local",
            }),
        ).resolves.toBe(false);
        expect((segmentedSegmentService as any).invalidCacheKeys.has(cacheKey)).toBe(
            true,
        );
    });

    it("keeps cache usable and records recoverable failure for non-startup segment_too_small", async () => {
        const { segmentedSegmentService } = await resolveSegmentService();
        const cacheKey = "cache-validate-recoverable";

        jest.spyOn(segmentedSegmentService as any, "validateDashAssetFiles").mockResolvedValue(
            {
                valid: false,
                reason: "segment_too_small",
                segmentCount: 558,
                segmentName: "chunk-0-00275.m4s",
            },
        );

        await expect(
            (segmentedSegmentService as any).validateCachedDashAsset({
                cacheKey,
                trackId: "track-validate-recoverable",
                quality: "medium",
                sourceKind: "local",
            }),
        ).resolves.toBe(true);
        expect((segmentedSegmentService as any).invalidCacheKeys.has(cacheKey)).toBe(
            false,
        );
        expect(
            (segmentedSegmentService as any).recoverableValidationFailures.has(
                cacheKey,
            ),
        ).toBe(true);
    });

    it("uses startup-fast validation for init and first startup chunks only", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-startup-fast-validation";

        mocks.mockHasDashManifest.mockResolvedValue(true);
        mocks.mockListDashSegments.mockResolvedValue([
            "chunk-1-00001.m4s",
            "chunk-1-00002.m4s",
            "chunk-1-00420.m4s",
            "init-1.m4s",
        ]);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        jest.spyOn(fsPromises, "stat").mockImplementation(async (targetPath: unknown) => {
            const fileName = String(targetPath).split("/").pop() ?? "";
            return {
                isFile: () => true,
                size: fileName === "chunk-1-00420.m4s" ? 8 : 1024,
            } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>;
        });
        jest.spyOn(segmentedSegmentService as any, "readSegmentProbeBytes").mockResolvedValue(
            Buffer.from("...moof...mdat..."),
        );

        await expect(
            (segmentedSegmentService as any).validateDashAssetFiles(
                cacheKey,
                "startup",
            ),
        ).resolves.toEqual({
            valid: true,
            segmentCount: 4,
        });
        await expect(
            (segmentedSegmentService as any).validateDashAssetFiles(cacheKey, "full"),
        ).resolves.toEqual({
            valid: false,
            reason: "segment_too_small",
            segmentName: "chunk-1-00420.m4s",
            segmentCount: 4,
        });
    });

    it("returns manifest_missing when validating cached assets without a manifest", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        mocks.mockHasDashManifest.mockResolvedValue(false);

        await expect(
            (segmentedSegmentService as any).validateDashAssetFiles("cache-no-manifest"),
        ).resolves.toEqual({
            valid: false,
            reason: "manifest_missing",
            segmentCount: 0,
        });
    });

    it("returns segments_missing when validating cached assets with no segments", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        mocks.mockHasDashManifest.mockResolvedValue(true);
        mocks.mockListDashSegments.mockResolvedValue([]);

        await expect(
            (segmentedSegmentService as any).validateDashAssetFiles("cache-no-segments"),
        ).resolves.toEqual({
            valid: false,
            reason: "segments_missing",
            segmentCount: 0,
        });
    });

    it("returns segment_not_file when a listed segment path is not a file", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-segment-not-file";
        const segmentName = "chunk-0-00001.m4s";

        mocks.mockHasDashManifest.mockResolvedValue(true);
        mocks.mockListDashSegments.mockResolvedValue([segmentName]);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        jest.spyOn(fsPromises, "stat").mockResolvedValue({
            isFile: () => false,
            size: 1024,
        } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>);

        await expect(
            (segmentedSegmentService as any).validateDashAssetFiles(cacheKey),
        ).resolves.toEqual({
            valid: false,
            reason: "segment_not_file",
            segmentName,
            segmentCount: 1,
        });
    });

    it("returns segment_too_small when a segment is below minimum byte size", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-segment-too-small";
        const segmentName = "chunk-0-00001.m4s";

        mocks.mockHasDashManifest.mockResolvedValue(true);
        mocks.mockListDashSegments.mockResolvedValue([segmentName]);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        jest.spyOn(fsPromises, "stat").mockResolvedValue({
            isFile: () => true,
            size: 8,
        } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>);

        await expect(
            (segmentedSegmentService as any).validateDashAssetFiles(cacheKey),
        ).resolves.toEqual({
            valid: false,
            reason: "segment_too_small",
            segmentName,
            segmentCount: 1,
        });
    });

    it("skips probe checks for init and non-m4s segments and still validates", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-skip-probe";

        mocks.mockHasDashManifest.mockResolvedValue(true);
        mocks.mockListDashSegments.mockResolvedValue([
            "init-0.m4s",
            "chunk-0-00001.webm",
        ]);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        jest.spyOn(fsPromises, "stat").mockResolvedValue({
            isFile: () => true,
            size: 1024,
        } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>);
        const probeSpy = jest.spyOn(
            segmentedSegmentService as any,
            "readSegmentProbeBytes",
        );

        await expect(
            (segmentedSegmentService as any).validateDashAssetFiles(cacheKey),
        ).resolves.toEqual({
            valid: true,
            segmentCount: 2,
        });
        expect(probeSpy).not.toHaveBeenCalled();
    });

    it("returns segment_missing_moof when media segment probe bytes omit moof box", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-missing-moof";
        const segmentName = "chunk-0-00001.m4s";

        mocks.mockHasDashManifest.mockResolvedValue(true);
        mocks.mockListDashSegments.mockResolvedValue([segmentName]);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        jest.spyOn(fsPromises, "stat").mockResolvedValue({
            isFile: () => true,
            size: 1024,
        } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>);
        jest.spyOn(segmentedSegmentService as any, "readSegmentProbeBytes").mockResolvedValue(
            Buffer.from("...mdat..."),
        );

        await expect(
            (segmentedSegmentService as any).validateDashAssetFiles(cacheKey),
        ).resolves.toEqual({
            valid: false,
            reason: "segment_missing_moof",
            segmentName,
            segmentCount: 1,
        });
    });

    it("returns segment_missing_mdat when media segment probe bytes omit mdat box", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-missing-mdat";
        const segmentName = "chunk-0-00001.m4s";

        mocks.mockHasDashManifest.mockResolvedValue(true);
        mocks.mockListDashSegments.mockResolvedValue([segmentName]);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        jest.spyOn(fsPromises, "stat").mockResolvedValue({
            isFile: () => true,
            size: 1024,
        } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>);
        jest.spyOn(segmentedSegmentService as any, "readSegmentProbeBytes").mockResolvedValue(
            Buffer.from("...moof..."),
        );

        await expect(
            (segmentedSegmentService as any).validateDashAssetFiles(cacheKey),
        ).resolves.toEqual({
            valid: false,
            reason: "segment_missing_mdat",
            segmentName,
            segmentCount: 1,
        });
    });

    it("accepts m4s probe bytes that contain both moof and mdat boxes", async () => {
        const { segmentedSegmentService, mocks } = await resolveSegmentService();
        const cacheKey = "cache-valid-probe";

        mocks.mockHasDashManifest.mockResolvedValue(true);
        mocks.mockListDashSegments.mockResolvedValue(["chunk-0-00001.m4s"]);
        mocks.mockGetDashAssetPaths.mockReturnValue({
            cacheKey,
            outputDir: `/tmp/${cacheKey}`,
            manifestPath: `/tmp/${cacheKey}/manifest.mpd`,
        });
        jest.spyOn(fsPromises, "stat").mockResolvedValue({
            isFile: () => true,
            size: 1024,
        } as unknown as Awaited<ReturnType<typeof fsPromises.stat>>);
        jest.spyOn(segmentedSegmentService as any, "readSegmentProbeBytes").mockResolvedValue(
            Buffer.from("...moof...mdat..."),
        );

        await expect(
            (segmentedSegmentService as any).validateDashAssetFiles(cacheKey),
        ).resolves.toEqual({
            valid: true,
            segmentCount: 1,
        });
    });

    it("reads and closes file handles when probing segment bytes", async () => {
        const { segmentedSegmentService } = await resolveSegmentService();
        const closeSpy = jest.fn().mockResolvedValue(undefined);
        const readSpy = jest
            .fn()
            .mockImplementation(async (probeBuffer: Buffer) => {
                const payload = Buffer.from("moofmdat");
                payload.copy(probeBuffer, 0);
                return {
                    bytesRead: payload.length,
                    buffer: probeBuffer,
                };
            });
        const openSpy = jest.spyOn(fsPromises, "open").mockResolvedValue({
            read: readSpy,
            close: closeSpy,
        } as unknown as Awaited<ReturnType<typeof fsPromises.open>>);

        await expect(
            (segmentedSegmentService as any).readSegmentProbeBytes(
                "/tmp/probe-segment.m4s",
            ),
        ).resolves.toEqual(Buffer.from("moofmdat"));
        expect(openSpy).toHaveBeenCalledWith("/tmp/probe-segment.m4s", "r");
        expect(readSpy).toHaveBeenCalledTimes(1);
        expect(closeSpy).toHaveBeenCalledTimes(1);
    });
});
