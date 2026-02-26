const resolveSessionService = async () => {
    jest.resetModules();

    const mockTrackFindUnique = jest.fn();
    const mockUserSettingsFindUnique = jest.fn();
    const mockManifestGetOrCreateLocalDashAsset = jest.fn();
    const mockRedisSetEx = jest.fn();
    const mockRedisGet = jest.fn();
    const mockRedisDel = jest.fn();
    const mockRedisExists = jest.fn();
    const mockRegisterSessionReference = jest.fn();
    const mockClearSessionReference = jest.fn();
    const mockFsAccess = jest.fn();
    const mockFsReadFile = jest.fn();
    const mockHasInFlightBuild = jest.fn();
    const mockGetBuildInFlightStatus = jest.fn(async (...args: unknown[]) => {
        const cacheKey = typeof args[0] === "string" ? args[0] : "";
        const localInFlight = Boolean(mockHasInFlightBuild(cacheKey));
        return {
            localInFlight,
            distributedInFlight: false,
            inFlight: localInFlight,
        };
    });
    const mockGetBuildFailure = jest.fn();
    const mockForceRegenerateDashSegments = jest.fn();
    const mockIsCacheMarkedInvalid = jest.fn((_cacheKey?: string) => false);

    jest.doMock("fs", () => ({
        promises: {
            access: (...args: unknown[]) => mockFsAccess(...args),
            readFile: (...args: unknown[]) => mockFsReadFile(...args),
        },
    }));

    jest.doMock("../../../utils/db", () => ({
        prisma: {
            track: {
                findUnique: (...args: unknown[]) => mockTrackFindUnique(...args),
            },
            userSettings: {
                findUnique: (...args: unknown[]) =>
                    mockUserSettingsFindUnique(...args),
            },
        },
    }));

    jest.doMock("../../../utils/redis", () => ({
        redisClient: {
            setEx: (...args: unknown[]) => mockRedisSetEx(...args),
            get: (...args: unknown[]) => mockRedisGet(...args),
            del: (...args: unknown[]) => mockRedisDel(...args),
            exists: (...args: unknown[]) => mockRedisExists(...args),
        },
    }));

    jest.doMock("../../../config", () => ({
        config: {
            sessionSecret: "test-session-secret",
            music: {
                musicPath: "/music",
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

    jest.doMock("../manifestService", () => ({
        segmentedManifestService: {
            getOrCreateLocalDashAsset: (...args: unknown[]) =>
                mockManifestGetOrCreateLocalDashAsset(...args),
        },
    }));

    jest.doMock("../cacheService", () => ({
        segmentedStreamingCacheService: {
            registerSessionReference: (...args: unknown[]) =>
                mockRegisterSessionReference(...args),
            clearSessionReference: (...args: unknown[]) =>
                mockClearSessionReference(...args),
        },
    }));

    jest.doMock("../segmentService", () => ({
        LOSSLESS_FILE_EXTENSION_REGEX:
            /\.(flac|wav|aiff|aif|alac|ape|wv|tta|dff|dsf)$/i,
        segmentedSegmentService: {
            getBuildFailure: (...args: unknown[]) =>
                mockGetBuildFailure(...args),
            getBuildInFlightStatus: (...args: unknown[]) =>
                mockGetBuildInFlightStatus(...args),
            hasInFlightBuild: (...args: unknown[]) =>
                mockHasInFlightBuild(...args),
            isCacheMarkedInvalid: (cacheKey: string) =>
                mockIsCacheMarkedInvalid(cacheKey),
            forceRegenerateDashSegments: (...args: unknown[]) =>
                mockForceRegenerateDashSegments(...args),
        },
    }));

    const module = await import("../sessionService");

    return {
        segmentedStreamingSessionService: module.segmentedStreamingSessionService,
        mocks: {
            mockTrackFindUnique,
            mockUserSettingsFindUnique,
            mockManifestGetOrCreateLocalDashAsset,
            mockRedisSetEx,
            mockRedisGet,
            mockRedisDel,
            mockRedisExists,
            mockRegisterSessionReference,
            mockClearSessionReference,
            mockFsAccess,
            mockFsReadFile,
            mockHasInFlightBuild,
            mockGetBuildInFlightStatus,
            mockGetBuildFailure,
            mockForceRegenerateDashSegments,
            mockIsCacheMarkedInvalid,
        },
    };
};

describe("segmentedStreamingSessionService local quality handling", () => {
    afterEach(() => {
        jest.resetModules();
        jest.dontMock("../../../utils/db");
        jest.dontMock("../../../utils/redis");
        jest.dontMock("fs");
        jest.dontMock("../../../config");
        jest.dontMock("../../../utils/logger");
        jest.dontMock("../manifestService");
        jest.dontMock("../cacheService");
        jest.dontMock("../segmentService");
    });

    it("returns FLAC playback profile for local original segmented sessions", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        mocks.mockUserSettingsFindUnique.mockResolvedValueOnce({
            playbackQuality: "medium",
        });
        mocks.mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-1",
            filePath: "albums/track-1.flac",
            fileModified: new Date("2026-02-20T00:00:00.000Z"),
        });
        mocks.mockFsAccess.mockResolvedValue(undefined);
        mocks.mockManifestGetOrCreateLocalDashAsset.mockResolvedValueOnce({
            cacheKey: "cache-1",
            outputDir: "/tmp/segmented/cache-1",
            manifestPath: "/tmp/segmented/cache-1/manifest.mpd",
            quality: "original",
        });
        mocks.mockHasInFlightBuild.mockReturnValue(false);

        const session = await segmentedStreamingSessionService.createLocalSession({
            userId: "user-1",
            trackId: "track-1",
            desiredQuality: "original",
        });

        expect(session.playbackProfile).toMatchObject({
            protocol: "dash",
            sourceType: "local",
            codec: "flac",
            bitrateKbps: null,
        });
        expect(mocks.mockManifestGetOrCreateLocalDashAsset).toHaveBeenCalledWith(
            expect.objectContaining({
                trackId: "track-1",
                quality: "original",
            }),
        );
        expect(mocks.mockRedisSetEx).toHaveBeenCalledTimes(1);
        expect(mocks.mockRegisterSessionReference).toHaveBeenCalledTimes(1);
    });

    it("returns AAC playback profile for local original segmented sessions sourced from lossy files", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        mocks.mockUserSettingsFindUnique.mockResolvedValueOnce({
            playbackQuality: "medium",
        });
        mocks.mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-lossy-original",
            filePath: "albums/track-lossy-original.mp3",
            fileModified: new Date("2026-02-20T00:00:00.000Z"),
        });
        mocks.mockFsAccess.mockResolvedValue(undefined);
        mocks.mockManifestGetOrCreateLocalDashAsset.mockResolvedValueOnce({
            cacheKey: "cache-lossy-original",
            outputDir: "/tmp/segmented/cache-lossy-original",
            manifestPath: "/tmp/segmented/cache-lossy-original/manifest.mpd",
            quality: "original",
        });
        mocks.mockHasInFlightBuild.mockReturnValue(false);

        const session = await segmentedStreamingSessionService.createLocalSession({
            userId: "user-1",
            trackId: "track-lossy-original",
            desiredQuality: "original",
        });

        expect(session.playbackProfile).toMatchObject({
            protocol: "dash",
            sourceType: "local",
            codec: "aac",
            bitrateKbps: 320,
        });
    });

    it("marks local cold-start segmented sessions as asset-build in-flight", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        mocks.mockUserSettingsFindUnique.mockResolvedValueOnce({
            playbackQuality: "original",
        });
        mocks.mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-2",
            filePath: "albums/track-2.flac",
            fileModified: new Date("2026-02-20T00:00:00.000Z"),
        });
        mocks.mockFsAccess.mockResolvedValue(undefined);
        mocks.mockManifestGetOrCreateLocalDashAsset.mockResolvedValueOnce({
            cacheKey: "cache-2",
            outputDir: "/tmp/segmented/cache-2",
            manifestPath: "/tmp/segmented/cache-2/manifest.mpd",
            quality: "original",
        });
        mocks.mockHasInFlightBuild.mockReturnValue(true);

        const session = await segmentedStreamingSessionService.createLocalSession({
            userId: "user-1",
            trackId: "track-2",
            desiredQuality: "original",
        });

        expect(session.engineHints).toMatchObject({
            protocol: "dash",
            sourceType: "local",
            recommendedEngine: "videojs",
            assetBuildInFlight: true,
        });
    });

    it("marks local cold-start segmented sessions as asset-build in-flight when another pod holds the distributed build lock", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        mocks.mockUserSettingsFindUnique.mockResolvedValueOnce({
            playbackQuality: "original",
        });
        mocks.mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-2-cross-pod",
            filePath: "albums/track-2-cross-pod.flac",
            fileModified: new Date("2026-02-20T00:00:00.000Z"),
        });
        mocks.mockFsAccess.mockResolvedValue(undefined);
        mocks.mockManifestGetOrCreateLocalDashAsset.mockResolvedValueOnce({
            cacheKey: "cache-2-cross-pod",
            outputDir: "/tmp/segmented/cache-2-cross-pod",
            manifestPath: "/tmp/segmented/cache-2-cross-pod/manifest.mpd",
            quality: "original",
        });
        mocks.mockHasInFlightBuild.mockReturnValue(false);
        mocks.mockGetBuildInFlightStatus.mockResolvedValue({
            localInFlight: false,
            distributedInFlight: true,
            inFlight: true,
        });

        const session = await segmentedStreamingSessionService.createLocalSession({
            userId: "user-1",
            trackId: "track-2-cross-pod",
            desiredQuality: "original",
        });

        expect(session.engineHints).toMatchObject({
            protocol: "dash",
            sourceType: "local",
            recommendedEngine: "videojs",
            assetBuildInFlight: true,
        });
        expect(mocks.mockGetBuildInFlightStatus).toHaveBeenCalledWith(
            "cache-2-cross-pod",
        );
    });
});

describe("segmentedStreamingSessionService token validation", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.resetModules();
        jest.dontMock("../../../utils/db");
        jest.dontMock("../../../utils/redis");
        jest.dontMock("fs");
        jest.dontMock("../../../config");
        jest.dontMock("../../../utils/logger");
        jest.dontMock("../manifestService");
        jest.dontMock("../cacheService");
        jest.dontMock("../segmentService");
    });

    it("accepts expired token claims when the active session has been refreshed", async () => {
        jest.useFakeTimers();
        const baseNow = new Date("2026-02-21T00:00:00.000Z");
        jest.setSystemTime(baseNow);

        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        mocks.mockUserSettingsFindUnique.mockResolvedValueOnce({
            playbackQuality: "medium",
        });
        mocks.mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-1",
            filePath: "albums/track-1.flac",
            fileModified: new Date("2026-02-20T00:00:00.000Z"),
        });
        mocks.mockFsAccess.mockResolvedValue(undefined);
        mocks.mockManifestGetOrCreateLocalDashAsset.mockResolvedValueOnce({
            cacheKey: "cache-token-1",
            outputDir: "/tmp/segmented/cache-token-1",
            manifestPath: "/tmp/segmented/cache-token-1/manifest.mpd",
            quality: "medium",
        });
        mocks.mockHasInFlightBuild.mockReturnValue(false);

        const session = await segmentedStreamingSessionService.createLocalSession({
            userId: "user-1",
            trackId: "track-1",
            desiredQuality: "medium",
        });
        const initialToken = session.sessionToken;

        const initialRecord =
            await segmentedStreamingSessionService.getAuthorizedSession(
                session.sessionId,
                "user-1",
            );
        expect(initialRecord).not.toBeNull();

        jest.setSystemTime(new Date(baseNow.getTime() + 4 * 60 * 1000));
        await segmentedStreamingSessionService.heartbeatSession(initialRecord!, {
            positionSec: 32,
            isPlaying: true,
        });

        const refreshedRecord =
            await segmentedStreamingSessionService.getAuthorizedSession(
                session.sessionId,
                "user-1",
            );
        expect(refreshedRecord).not.toBeNull();

        // Initial token is now expired, but refreshed session continuity should allow it.
        jest.setSystemTime(new Date(baseNow.getTime() + 6 * 60 * 1000));
        expect(() =>
            segmentedStreamingSessionService.validateSessionToken(
                refreshedRecord!,
                initialToken,
            ),
        ).not.toThrow();
    });

    it("still rejects malformed session tokens", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        mocks.mockUserSettingsFindUnique.mockResolvedValueOnce({
            playbackQuality: "medium",
        });
        mocks.mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-2",
            filePath: "albums/track-2.flac",
            fileModified: new Date("2026-02-20T00:00:00.000Z"),
        });
        mocks.mockFsAccess.mockResolvedValue(undefined);
        mocks.mockManifestGetOrCreateLocalDashAsset.mockResolvedValueOnce({
            cacheKey: "cache-token-2",
            outputDir: "/tmp/segmented/cache-token-2",
            manifestPath: "/tmp/segmented/cache-token-2/manifest.mpd",
            quality: "medium",
        });
        mocks.mockHasInFlightBuild.mockReturnValue(false);

        const session = await segmentedStreamingSessionService.createLocalSession({
            userId: "user-1",
            trackId: "track-2",
            desiredQuality: "medium",
        });
        const sessionRecord =
            await segmentedStreamingSessionService.getAuthorizedSession(
                session.sessionId,
                "user-1",
            );
        expect(sessionRecord).not.toBeNull();

        try {
            segmentedStreamingSessionService.validateSessionToken(
                sessionRecord!,
                "not-a-jwt",
            );
            throw new Error("Expected validateSessionToken to throw");
        } catch (error) {
            expect((error as { code?: string }).code).toBe(
                "STREAMING_SESSION_TOKEN_INVALID",
            );
        }
    });

    it("rejects session-id token scope mismatches by default", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        mocks.mockUserSettingsFindUnique.mockResolvedValue({
            playbackQuality: "medium",
        });
        mocks.mockTrackFindUnique.mockResolvedValue({
            id: "track-3",
            filePath: "albums/track-3.flac",
            fileModified: new Date("2026-02-20T00:00:00.000Z"),
        });
        mocks.mockFsAccess.mockResolvedValue(undefined);
        mocks.mockManifestGetOrCreateLocalDashAsset.mockResolvedValue({
            cacheKey: "cache-token-3",
            outputDir: "/tmp/segmented/cache-token-3",
            manifestPath: "/tmp/segmented/cache-token-3/manifest.mpd",
            quality: "medium",
        });
        mocks.mockHasInFlightBuild.mockReturnValue(false);

        const firstSession =
            await segmentedStreamingSessionService.createLocalSession({
                userId: "user-1",
                trackId: "track-3",
                desiredQuality: "medium",
            });
        const secondSession =
            await segmentedStreamingSessionService.createLocalSession({
                userId: "user-1",
                trackId: "track-3",
                desiredQuality: "medium",
            });
        const firstSessionRecord =
            await segmentedStreamingSessionService.getAuthorizedSession(
                firstSession.sessionId,
                "user-1",
            );
        expect(firstSessionRecord).not.toBeNull();

        expect(() =>
            segmentedStreamingSessionService.validateSessionToken(
                firstSessionRecord!,
                secondSession.sessionToken,
            ),
        ).toThrow(
            expect.objectContaining({
                code: "STREAMING_SESSION_TOKEN_SCOPE_MISMATCH",
            }),
        );
    });

    it("allows session-id token scope mismatches for in-flight media requests when explicitly enabled", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        mocks.mockUserSettingsFindUnique.mockResolvedValue({
            playbackQuality: "medium",
        });
        mocks.mockTrackFindUnique.mockResolvedValue({
            id: "track-4",
            filePath: "albums/track-4.flac",
            fileModified: new Date("2026-02-20T00:00:00.000Z"),
        });
        mocks.mockFsAccess.mockResolvedValue(undefined);
        mocks.mockManifestGetOrCreateLocalDashAsset.mockResolvedValue({
            cacheKey: "cache-token-4",
            outputDir: "/tmp/segmented/cache-token-4",
            manifestPath: "/tmp/segmented/cache-token-4/manifest.mpd",
            quality: "medium",
        });
        mocks.mockHasInFlightBuild.mockReturnValue(false);

        const firstSession =
            await segmentedStreamingSessionService.createLocalSession({
                userId: "user-1",
                trackId: "track-4",
                desiredQuality: "medium",
            });
        const secondSession =
            await segmentedStreamingSessionService.createLocalSession({
                userId: "user-1",
                trackId: "track-4",
                desiredQuality: "medium",
            });
        const firstSessionRecord =
            await segmentedStreamingSessionService.getAuthorizedSession(
                firstSession.sessionId,
                "user-1",
            );
        expect(firstSessionRecord).not.toBeNull();

        expect(() =>
            segmentedStreamingSessionService.validateSessionToken(
                firstSessionRecord!,
                secondSession.sessionToken,
                { allowSessionIdMismatch: true },
            ),
        ).not.toThrow();
    });
});

describe("segmentedStreamingSessionService playback error repair", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.resetModules();
        jest.dontMock("../../../utils/db");
        jest.dontMock("../../../utils/redis");
        jest.dontMock("fs");
        jest.dontMock("../../../config");
        jest.dontMock("../../../utils/logger");
        jest.dontMock("../manifestService");
        jest.dontMock("../cacheService");
        jest.dontMock("../segmentService");
    });

    it("skips scheduling playback repair for missing session ids and non-local source types", async () => {
        const { segmentedStreamingSessionService } = await resolveSessionService();
        const repairSpy = jest
            .spyOn(
                segmentedStreamingSessionService as any,
                "repairPlaybackErrorSessionCache",
            )
            .mockResolvedValue(undefined);

        segmentedStreamingSessionService.schedulePlaybackErrorRepair({
            userId: "user-1",
            sessionId: "   ",
            sourceType: "local",
        });
        segmentedStreamingSessionService.schedulePlaybackErrorRepair({
            userId: "user-1",
            sessionId: "session-remote",
            sourceType: "remote",
        });

        expect(repairSpy).not.toHaveBeenCalled();
    });

    it("queues one follow-up repair when a repair is already in-flight for the same session", async () => {
        const { segmentedStreamingSessionService } = await resolveSessionService();
        let releaseRepair: (() => void) | undefined;
        const repairGate = new Promise<void>((resolve) => {
            releaseRepair = resolve;
        });
        const repairSpy = jest
            .spyOn(
                segmentedStreamingSessionService as any,
                "repairPlaybackErrorSessionCache",
            )
            .mockReturnValue(repairGate);

        // First call starts the repair.
        segmentedStreamingSessionService.schedulePlaybackErrorRepair({
            userId: "user-1",
            sessionId: " session-repair-1 ",
            trackId: " track-1 ",
            sourceType: "local",
        });
        expect(repairSpy).toHaveBeenCalledTimes(1);
        expect(repairSpy).toHaveBeenCalledWith({
            userId: "user-1",
            sessionId: "session-repair-1",
            trackId: "track-1",
        });

        // Second call while in-flight queues a follow-up (does not start a second repair yet).
        segmentedStreamingSessionService.schedulePlaybackErrorRepair({
            userId: "user-1",
            sessionId: "session-repair-1",
            trackId: "track-1",
            sourceType: "local",
        });
        expect(repairSpy).toHaveBeenCalledTimes(1);

        // Third call while in-flight is capped — already queued, so silently dropped.
        segmentedStreamingSessionService.schedulePlaybackErrorRepair({
            userId: "user-1",
            sessionId: "session-repair-1",
            trackId: "track-1",
            sourceType: "local",
        });
        expect(repairSpy).toHaveBeenCalledTimes(1);

        // Release the first repair — the queued follow-up should fire.
        releaseRepair?.();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(repairSpy).toHaveBeenCalledTimes(2);
    });

    it("allows a new repair after both active and queued repairs complete", async () => {
        const { segmentedStreamingSessionService } = await resolveSessionService();
        let releaseRepair: (() => void) | undefined;
        let repairGate = new Promise<void>((resolve) => {
            releaseRepair = resolve;
        });
        const repairSpy = jest
            .spyOn(
                segmentedStreamingSessionService as any,
                "repairPlaybackErrorSessionCache",
            )
            .mockImplementation(() => repairGate);

        // First call starts repair #1.
        segmentedStreamingSessionService.schedulePlaybackErrorRepair({
            userId: "user-1",
            sessionId: "session-repair-chain",
            trackId: "track-1",
            sourceType: "local",
        });
        // Second call queues repair #2.
        segmentedStreamingSessionService.schedulePlaybackErrorRepair({
            userId: "user-1",
            sessionId: "session-repair-chain",
            trackId: "track-1",
            sourceType: "local",
        });
        expect(repairSpy).toHaveBeenCalledTimes(1);

        // Release repair #1 — queued repair #2 should start via re-invocation.
        releaseRepair?.();
        repairGate = new Promise<void>((resolve) => {
            releaseRepair = resolve;
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(repairSpy).toHaveBeenCalledTimes(2);

        // Release repair #2 — slot should now be clear.
        releaseRepair?.();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // A third call should start a fresh repair.
        segmentedStreamingSessionService.schedulePlaybackErrorRepair({
            userId: "user-1",
            sessionId: "session-repair-chain",
            trackId: "track-1",
            sourceType: "local",
        });
        expect(repairSpy).toHaveBeenCalledTimes(3);
    });

    it("does not clear a newer in-flight repair entry when an older repair promise finishes", async () => {
        const { segmentedStreamingSessionService } = await resolveSessionService();
        let releaseRepair: (() => void) | undefined;
        const repairGate = new Promise<void>((resolve) => {
            releaseRepair = resolve;
        });
        const repairSpy = jest
            .spyOn(
                segmentedStreamingSessionService as any,
                "repairPlaybackErrorSessionCache",
            )
            .mockReturnValue(repairGate);
        const replacementPromise = Promise.resolve();

        segmentedStreamingSessionService.schedulePlaybackErrorRepair({
            userId: "user-1",
            sessionId: "session-repair-replaced",
            sourceType: "local",
        });
        expect(repairSpy).toHaveBeenCalledTimes(1);

        (segmentedStreamingSessionService as any).playbackErrorRepairInFlight.set(
            "session-repair-replaced",
            replacementPromise,
        );

        releaseRepair?.();
        await Promise.resolve();
        await Promise.resolve();

        expect(
            (segmentedStreamingSessionService as any).playbackErrorRepairInFlight.get(
                "session-repair-replaced",
            ),
        ).toBe(replacementPromise);
    });

    it("skips playback repair when the authorized session no longer exists", async () => {
        const { segmentedStreamingSessionService, mocks } = await resolveSessionService();
        jest.spyOn(segmentedStreamingSessionService, "getAuthorizedSession").mockResolvedValue(
            null,
        );

        await expect(
            (segmentedStreamingSessionService as any).repairPlaybackErrorSessionCache({
                userId: "user-1",
                sessionId: "missing-session",
            }),
        ).resolves.toBeUndefined();

        expect(mocks.mockTrackFindUnique).not.toHaveBeenCalled();
        expect(mocks.mockForceRegenerateDashSegments).not.toHaveBeenCalled();
    });

    it("skips playback repair when the requested track id does not match the active session track", async () => {
        const { segmentedStreamingSessionService, mocks } = await resolveSessionService();
        jest.spyOn(segmentedStreamingSessionService, "getAuthorizedSession").mockResolvedValue(
            {
                sessionId: "session-track-mismatch",
                userId: "user-1",
                trackId: "track-active",
                cacheKey: "cache-active",
                quality: "medium",
                sourceType: "local",
                manifestProfile: "startup_single",
                manifestPath: "/tmp/assets/manifest.mpd",
                assetDir: "/tmp/assets",
                createdAt: "2026-02-20T00:00:00.000Z",
                expiresAt: "2099-01-01T00:00:00.000Z",
            },
        );

        await expect(
            (segmentedStreamingSessionService as any).repairPlaybackErrorSessionCache({
                userId: "user-1",
                sessionId: "session-track-mismatch",
                trackId: "track-other",
            }),
        ).resolves.toBeUndefined();

        expect(mocks.mockTrackFindUnique).not.toHaveBeenCalled();
        expect(mocks.mockForceRegenerateDashSegments).not.toHaveBeenCalled();
    });

    it("skips playback repair when track source metadata is unavailable", async () => {
        const { segmentedStreamingSessionService, mocks } = await resolveSessionService();
        jest.spyOn(segmentedStreamingSessionService, "getAuthorizedSession").mockResolvedValue(
            {
                sessionId: "session-track-metadata-missing",
                userId: "user-1",
                trackId: "track-metadata-missing",
                cacheKey: "cache-track-metadata-missing",
                quality: "medium",
                sourceType: "local",
                manifestProfile: "startup_single",
                manifestPath: "/tmp/assets/manifest.mpd",
                assetDir: "/tmp/assets",
                createdAt: "2026-02-20T00:00:00.000Z",
                expiresAt: "2099-01-01T00:00:00.000Z",
            },
        );
        mocks.mockTrackFindUnique.mockResolvedValue({
            id: "track-metadata-missing",
            filePath: null,
            fileModified: null,
        });

        await expect(
            (segmentedStreamingSessionService as any).repairPlaybackErrorSessionCache({
                userId: "user-1",
                sessionId: "session-track-metadata-missing",
            }),
        ).resolves.toBeUndefined();

        expect(mocks.mockForceRegenerateDashSegments).not.toHaveBeenCalled();
    });

    it("queues playback repair regeneration when session and track source are valid", async () => {
        const { segmentedStreamingSessionService, mocks } = await resolveSessionService();
        const sourceModified = new Date("2026-02-20T00:00:00.000Z");
        jest.spyOn(segmentedStreamingSessionService, "getAuthorizedSession").mockResolvedValue(
            {
                sessionId: "session-repair-success",
                userId: "user-1",
                trackId: "track-repair-success",
                cacheKey: "cache-repair-success",
                quality: "medium",
                sourceType: "local",
                manifestProfile: "startup_single",
                manifestPath: "/tmp/assets/manifest.mpd",
                assetDir: "/tmp/assets",
                createdAt: "2026-02-20T00:00:00.000Z",
                expiresAt: "2099-01-01T00:00:00.000Z",
            },
        );
        mocks.mockTrackFindUnique.mockResolvedValue({
            id: "track-repair-success",
            filePath: "albums/track-repair-success.flac",
            fileModified: sourceModified,
        });
        mocks.mockFsAccess.mockResolvedValue(undefined);
        mocks.mockForceRegenerateDashSegments.mockResolvedValue(undefined);

        await expect(
            (segmentedStreamingSessionService as any).repairPlaybackErrorSessionCache({
                userId: "user-1",
                sessionId: "session-repair-success",
                trackId: "track-repair-success",
            }),
        ).resolves.toBeUndefined();

        expect(mocks.mockForceRegenerateDashSegments).toHaveBeenCalledWith({
            trackId: "track-repair-success",
            sourcePath: "/music/albums/track-repair-success.flac",
            sourceModified,
            quality: "medium",
            manifestProfile: "startup_single",
        });
    });

    it("swallows playback repair regeneration errors", async () => {
        const { segmentedStreamingSessionService, mocks } = await resolveSessionService();
        jest.spyOn(segmentedStreamingSessionService, "getAuthorizedSession").mockResolvedValue(
            {
                sessionId: "session-repair-error",
                userId: "user-1",
                trackId: "track-repair-error",
                cacheKey: "cache-repair-error",
                quality: "medium",
                sourceType: "local",
                manifestProfile: "startup_single",
                manifestPath: "/tmp/assets/manifest.mpd",
                assetDir: "/tmp/assets",
                createdAt: "2026-02-20T00:00:00.000Z",
                expiresAt: "2099-01-01T00:00:00.000Z",
            },
        );
        mocks.mockTrackFindUnique.mockResolvedValue({
            id: "track-repair-error",
            filePath: "albums/track-repair-error.flac",
            fileModified: new Date("2026-02-20T00:00:00.000Z"),
        });
        mocks.mockFsAccess.mockResolvedValue(undefined);
        mocks.mockForceRegenerateDashSegments.mockRejectedValue(
            new Error("regen failed"),
        );

        await expect(
            (segmentedStreamingSessionService as any).repairPlaybackErrorSessionCache({
                userId: "user-1",
                sessionId: "session-repair-error",
                trackId: "track-repair-error",
            }),
        ).resolves.toBeUndefined();
    });
});

describe("segmentedStreamingSessionService segment path validation", () => {
    afterEach(() => {
        jest.resetModules();
        jest.dontMock("../../../utils/db");
        jest.dontMock("../../../utils/redis");
        jest.dontMock("fs");
        jest.dontMock("../../../config");
        jest.dontMock("../../../utils/logger");
        jest.dontMock("../manifestService");
        jest.dontMock("../cacheService");
        jest.dontMock("../segmentService");
    });

    it("accepts both m4s and legacy webm segment names", async () => {
        const { segmentedStreamingSessionService } = await resolveSessionService();
        const session = {
            sessionId: "session-1",
            userId: "user-1",
            trackId: "track-1",
            cacheKey: "cache-1",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2099-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:05:00.000Z",
        } as const;

        expect(
            segmentedStreamingSessionService.resolveSegmentPath(
                session,
                "chunk-0-00001.m4s",
            ),
        ).toBe("/tmp/assets/chunk-0-00001.m4s");
        expect(
            segmentedStreamingSessionService.resolveSegmentPath(
                session,
                "chunk-0-00001.webm",
            ),
        ).toBe("/tmp/assets/chunk-0-00001.webm");
        expect(
            segmentedStreamingSessionService.resolveSegmentPath(
                session,
                "chunk-1-00001.m4s",
            ),
        ).toBe("/tmp/assets/chunk-1-00001.m4s");
    });
});

describe("segmentedStreamingSessionService manifest startup readiness", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.resetModules();
        jest.dontMock("../../../utils/db");
        jest.dontMock("../../../utils/redis");
        jest.dontMock("fs");
        jest.dontMock("../../../config");
        jest.dontMock("../../../utils/logger");
        jest.dontMock("../manifestService");
        jest.dontMock("../cacheService");
        jest.dontMock("../segmentService");
    });

    it("waits for startup timeline plus first three chunks before serving manifest", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        const availablePaths = new Set<string>(["/tmp/assets/manifest.mpd"]);
        let manifestContents = `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet>
      <Representation>
        <SegmentTemplate>
          <SegmentTimeline></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockFsReadFile.mockImplementation(async () => manifestContents);
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(true);

        const waitPromise = segmentedStreamingSessionService.waitForManifestReady({
            sessionId: "session-1",
            userId: "user-1",
            trackId: "track-1",
            cacheKey: "cache-1",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        });

        setTimeout(() => {
            availablePaths.add("/tmp/assets/init-0.m4s");
            availablePaths.add("/tmp/assets/chunk-0-00001.m4s");
            availablePaths.add("/tmp/assets/chunk-0-00002.m4s");
            availablePaths.add("/tmp/assets/chunk-0-00003.m4s");
            manifestContents = `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet>
      <Representation>
        <SegmentTemplate>
          <SegmentTimeline><S t="0" d="45056" /><S d="45056" /><S d="45056" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
        }, 10);

        await expect(waitPromise).resolves.toBeUndefined();
    });

    it("requires startup readiness for the selected representation only", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        const availablePaths = new Set<string>([
            "/tmp/assets/manifest.mpd",
            "/tmp/assets/init-0.m4s",
            "/tmp/assets/chunk-0-00001.m4s",
            "/tmp/assets/chunk-0-00002.m4s",
            "/tmp/assets/chunk-0-00003.m4s",
        ]);
        mocks.mockFsReadFile.mockResolvedValue(
            `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet>
      <Representation id="0">
        <SegmentTemplate>
          <SegmentTimeline><S t="0" d="45056" /><S d="45056" /><S d="45056" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
      <Representation id="1">
        <SegmentTemplate>
          <SegmentTimeline><S t="0" d="45056" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`,
        );
        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(true);

        const waitPromise = segmentedStreamingSessionService.waitForManifestReady({
            sessionId: "session-2-representation-ready",
            userId: "user-1",
            trackId: "track-1",
            cacheKey: "cache-1",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        });

        await expect(waitPromise).resolves.toBeUndefined();
    });

    it("fails startup readiness when init plus three chunks are not all available", async () => {
        jest.useFakeTimers();
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        const availablePaths = new Set<string>([
            "/tmp/assets/manifest.mpd",
            "/tmp/assets/init-0.m4s",
            "/tmp/assets/chunk-0-00001.m4s",
        ]);
        mocks.mockFsReadFile.mockResolvedValue(
            `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet>
      <Representation>
        <SegmentTemplate>
          <SegmentTimeline><S t="0" d="45056" /><S d="45056" /><S d="45056" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`,
        );
        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(true);

        const waitPromise = segmentedStreamingSessionService.waitForManifestReady({
            sessionId: "session-2",
            userId: "user-1",
            trackId: "track-1",
            cacheKey: "cache-1",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        });

        const startupWindowAssertion = expect(waitPromise).rejects.toMatchObject({
            code: "STREAMING_ASSET_NOT_READY",
            statusCode: 503,
        });

        await jest.advanceTimersByTimeAsync(21_000);

        await startupWindowAssertion;
    });

    it("grants startup-window polling a full timeout budget after manifest readiness", async () => {
        jest.useFakeTimers();
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        const availablePaths = new Set<string>();
        mocks.mockFsReadFile.mockResolvedValue(
            `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet>
      <Representation>
        <SegmentTemplate>
          <SegmentTimeline><S t="0" d="45056" /><S d="45056" /><S d="45056" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`,
        );
        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(true);

        const waitPromise = segmentedStreamingSessionService.waitForManifestReady({
            sessionId: "session-shared-deadline",
            userId: "user-1",
            trackId: "track-1",
            cacheKey: "cache-1",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        });

        // Manifest appears near the end of the deadline budget.
        setTimeout(() => {
            availablePaths.add("/tmp/assets/manifest.mpd");
        }, 19_500);

        // Startup assets appear after the original single shared budget, but
        // still within the startup-window phase timeout.
        setTimeout(() => {
            availablePaths.add("/tmp/assets/init-0.m4s");
            availablePaths.add("/tmp/assets/chunk-0-00001.m4s");
            availablePaths.add("/tmp/assets/chunk-0-00002.m4s");
            availablePaths.add("/tmp/assets/chunk-0-00003.m4s");
        }, 21_500);

        await jest.advanceTimersByTimeAsync(22_000);
        await expect(waitPromise).resolves.toBeUndefined();
    });

    it("does not mark manifest ready when startup prerequisites remain missing after build settles", async () => {
        jest.useFakeTimers();
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        const availablePaths = new Set<string>(["/tmp/assets/manifest.mpd"]);
        mocks.mockFsReadFile.mockResolvedValue(
            `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet>
      <Representation>
        <SegmentTemplate>
          <SegmentTimeline></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`,
        );
        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(false);

        const waitPromise = segmentedStreamingSessionService.waitForManifestReady({
            sessionId: "session-2",
            userId: "user-1",
            trackId: "track-1",
            cacheKey: "cache-1",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        });

        const startupWindowAssertion = expect(waitPromise).rejects.toMatchObject({
            code: "STREAMING_ASSET_NOT_READY",
            statusCode: 503,
        });

        await jest.advanceTimersByTimeAsync(21_000);
        await startupWindowAssertion;
    });

    it("does not require startup chunks for non-selected manifest timelines", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        const availablePaths = new Set<string>([
            "/tmp/assets/manifest.mpd",
            "/tmp/assets/init-0.m4s",
            "/tmp/assets/chunk-0-00001.m4s",
            "/tmp/assets/chunk-0-00002.m4s",
            "/tmp/assets/chunk-0-00003.m4s",
            "/tmp/assets/init-1.m4s",
        ]);
        mocks.mockFsReadFile.mockResolvedValue(
            `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet>
      <Representation id="0">
        <SegmentTemplate>
          <SegmentTimeline><S t="0" d="45056" /><S d="45056" /><S d="45056" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
      <Representation id="1">
        <SegmentTemplate>
          <SegmentTimeline><S t="0" d="45056" /><S d="45056" /><S d="45056" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`,
        );
        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(true);

        const waitPromise = segmentedStreamingSessionService.waitForManifestReady({
            sessionId: "session-multi-timeline-startup-prereq",
            userId: "user-1",
            trackId: "track-1",
            cacheKey: "cache-1",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        });

        await expect(waitPromise).resolves.toBeUndefined();
    });

    it("marks manifest ready when startup prerequisites exist for all required timelines", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        const availablePaths = new Set<string>([
            "/tmp/assets/manifest.mpd",
            "/tmp/assets/init-0.m4s",
            "/tmp/assets/chunk-0-00001.m4s",
            "/tmp/assets/chunk-0-00002.m4s",
            "/tmp/assets/chunk-0-00003.m4s",
            "/tmp/assets/init-1.m4s",
            "/tmp/assets/chunk-1-00001.m4s",
            "/tmp/assets/chunk-1-00002.m4s",
            "/tmp/assets/chunk-1-00003.m4s",
        ]);
        mocks.mockFsReadFile.mockResolvedValue(
            `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet>
      <Representation id="0">
        <SegmentTemplate>
          <SegmentTimeline><S t="0" d="45056" /><S d="45056" /><S d="45056" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
      <Representation id="1">
        <SegmentTemplate>
          <SegmentTimeline><S t="0" d="45056" /><S d="45056" /><S d="45056" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`,
        );
        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(true);

        await expect(
            segmentedStreamingSessionService.waitForManifestReady({
                sessionId: "session-multi-timeline-startup-ready",
                userId: "user-1",
                trackId: "track-1",
                cacheKey: "cache-1",
                quality: "medium",
                sourceType: "local",
                manifestProfile: "startup_single",
                manifestPath: "/tmp/assets/manifest.mpd",
                assetDir: "/tmp/assets",
                createdAt: "2026-02-20T00:00:00.000Z",
                expiresAt: "2099-01-01T00:00:00.000Z",
            }),
        ).resolves.toBeUndefined();
    });

    it("coalesces concurrent manifest readiness by session id", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        const availablePaths = new Set<string>([
            "/tmp/assets/manifest.mpd",
            "/tmp/assets/init-0.m4s",
            "/tmp/assets/chunk-0-00001.m4s",
            "/tmp/assets/chunk-0-00002.m4s",
            "/tmp/assets/chunk-0-00003.m4s",
        ]);
        const manifestContents = `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet>
      <Representation>
        <SegmentTemplate>
          <SegmentTimeline><S t="0" d="45056" /><S d="45056" /><S d="45056" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockFsReadFile.mockImplementation(async () => manifestContents);
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(true);

        const session = {
            sessionId: "session-manifest-coalesce",
            userId: "user-1",
            trackId: "track-1",
            cacheKey: "cache-1",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        } as const;

        const firstWaitPromise =
            segmentedStreamingSessionService.waitForManifestReady({
                ...session,
            });
        const secondWaitPromise =
            segmentedStreamingSessionService.waitForManifestReady(session);

        await expect(
            Promise.all([firstWaitPromise, secondWaitPromise]),
        ).resolves.toEqual([undefined, undefined]);

        expect(mocks.mockFsReadFile).toHaveBeenCalledTimes(1);
    });

    it("re-runs startup checks on sequential manifest requests", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        const availablePaths = new Set<string>([
            "/tmp/assets/manifest.mpd",
            "/tmp/assets/init-0.m4s",
            "/tmp/assets/chunk-0-00001.m4s",
            "/tmp/assets/chunk-0-00002.m4s",
            "/tmp/assets/chunk-0-00003.m4s",
        ]);
        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockFsReadFile.mockResolvedValue(
            `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet>
      <Representation>
        <SegmentTemplate>
          <SegmentTimeline><S t="0" d="45056" /><S d="45056" /><S d="45056" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`,
        );
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(true);

        const session = {
            sessionId: "session-manifest-sequential",
            userId: "user-1",
            trackId: "track-1",
            cacheKey: "cache-1",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        } as const;

        await segmentedStreamingSessionService.waitForManifestReady(session);
        await segmentedStreamingSessionService.waitForManifestReady(session);

        expect(mocks.mockFsReadFile).toHaveBeenCalledTimes(2);
    });

    it("blocks repeated manifest requests when startup chunk prerequisites regress", async () => {
        jest.useFakeTimers();
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        const availablePaths = new Set<string>([
            "/tmp/assets/manifest.mpd",
            "/tmp/assets/init-0.m4s",
            "/tmp/assets/chunk-0-00001.m4s",
            "/tmp/assets/chunk-0-00002.m4s",
            "/tmp/assets/chunk-0-00003.m4s",
        ]);
        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockFsReadFile.mockResolvedValue(
            `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet>
      <Representation>
        <SegmentTemplate>
          <SegmentTimeline><S t="0" d="45056" /><S d="45056" /><S d="45056" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`,
        );
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(true);

        const session = {
            sessionId: "session-manifest-ttl-expiry",
            userId: "user-1",
            trackId: "track-1",
            cacheKey: "cache-1",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        } as const;

        await segmentedStreamingSessionService.waitForManifestReady(session);
        availablePaths.delete("/tmp/assets/chunk-0-00002.m4s");
        mocks.mockHasInFlightBuild.mockReturnValue(false);

        const waitPromise = segmentedStreamingSessionService.waitForManifestReady(
            session,
        );
        const startupWindowAssertion = expect(waitPromise).rejects.toMatchObject({
            code: "STREAMING_ASSET_NOT_READY",
            statusCode: 503,
        });

        await jest.advanceTimersByTimeAsync(21_000);
        await startupWindowAssertion;
    });

    it("resets manifest readiness backoff and retries after self-heal kicks off a rebuild", async () => {
        jest.useFakeTimers();
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();
        const sourcePath = "/music/albums/track-manifest-self-heal.flac";
        const availablePaths = new Set<string>();
        const session = {
            sessionId: "session-manifest-self-heal",
            userId: "user-1",
            trackId: "track-manifest-self-heal",
            cacheKey: "cache-manifest-self-heal",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        } as const;

        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (candidatePath === sourcePath || availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(false);
        mocks.mockTrackFindUnique.mockResolvedValue({
            id: "track-manifest-self-heal",
            filePath: "albums/track-manifest-self-heal.flac",
            fileModified: new Date("2026-02-20T00:00:00.000Z"),
        });
        mocks.mockManifestGetOrCreateLocalDashAsset.mockImplementation(async () => {
            availablePaths.add(session.manifestPath);
            return {
                cacheKey: session.cacheKey,
                outputDir: session.assetDir,
                manifestPath: session.manifestPath,
                quality: "medium",
            };
        });

        const waitPromise = (segmentedStreamingSessionService as any).waitForAssetFile(
            session,
            session.manifestPath,
            "manifest",
            Date.now() + 1_000,
        );
        await jest.advanceTimersByTimeAsync(300);
        await expect(waitPromise).resolves.toBeUndefined();

        expect(mocks.mockTrackFindUnique).toHaveBeenCalledTimes(1);
        expect(mocks.mockManifestGetOrCreateLocalDashAsset).toHaveBeenCalledTimes(1);
    });

    it("waits through cross-pod grace polling when no in-flight build exists yet", async () => {
        jest.useFakeTimers();
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();
        const availablePaths = new Set<string>();
        const session = {
            sessionId: "session-manifest-cross-pod-grace",
            userId: "user-1",
            trackId: "track-manifest-cross-pod-grace",
            cacheKey: "cache-manifest-cross-pod-grace",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/manifest-grace.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        } as const;

        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(false);
        mocks.mockTrackFindUnique.mockResolvedValue(null);

        const waitPromise = (segmentedStreamingSessionService as any).waitForAssetFile(
            session,
            session.manifestPath,
            "manifest",
            Date.now() + 1_000,
        );
        setTimeout(() => {
            availablePaths.add(session.manifestPath);
        }, 50);

        await jest.advanceTimersByTimeAsync(300);
        await expect(waitPromise).resolves.toBeUndefined();
        expect(mocks.mockTrackFindUnique).toHaveBeenCalledTimes(1);
    });

    it("waits for manifest readiness when another pod holds the distributed build lock", async () => {
        jest.useFakeTimers();
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();
        const availablePaths = new Set<string>();
        const session = {
            sessionId: "session-manifest-distributed-in-flight",
            userId: "user-1",
            trackId: "track-manifest-distributed-in-flight",
            cacheKey: "cache-manifest-distributed-in-flight",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/manifest-distributed-lock.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        } as const;

        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(false);
        mocks.mockGetBuildInFlightStatus.mockResolvedValue({
            localInFlight: false,
            distributedInFlight: true,
            inFlight: true,
        });
        mocks.mockTrackFindUnique.mockResolvedValue(null);

        const waitPromise = (segmentedStreamingSessionService as any).waitForAssetFile(
            session,
            session.manifestPath,
            "manifest",
            Date.now() + 1_000,
        );
        setTimeout(() => {
            availablePaths.add(session.manifestPath);
        }, 50);

        await jest.advanceTimersByTimeAsync(300);
        await expect(waitPromise).resolves.toBeUndefined();
        expect(mocks.mockTrackFindUnique).not.toHaveBeenCalled();
        expect(mocks.mockGetBuildInFlightStatus).toHaveBeenCalled();
    });

    it("waits for startup window readiness when another pod holds the distributed build lock", async () => {
        jest.useFakeTimers();
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();
        const session = {
            sessionId: "session-startup-distributed-in-flight",
            userId: "user-1",
            trackId: "track-startup-distributed-in-flight",
            cacheKey: "cache-startup-distributed-in-flight",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/startup-distributed-lock.mpd",
            assetDir: "/tmp/assets/startup-distributed-lock",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        } as const;
        const availablePaths = new Set<string>();

        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockFsReadFile.mockResolvedValue(
            `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet>
      <Representation>
        <SegmentTemplate>
          <SegmentTimeline><S t="0" d="45056" /><S d="45056" /><S d="45056" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`,
        );
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(false);
        mocks.mockGetBuildInFlightStatus.mockResolvedValue({
            localInFlight: false,
            distributedInFlight: true,
            inFlight: true,
        });
        mocks.mockTrackFindUnique.mockResolvedValue(null);

        const waitPromise = (segmentedStreamingSessionService as any).waitForStartupWindowReady(
            session,
            Date.now() + 1_000,
        );
        setTimeout(() => {
            availablePaths.add(`${session.assetDir}/init-0.m4s`);
            availablePaths.add(`${session.assetDir}/chunk-0-00001.m4s`);
            availablePaths.add(`${session.assetDir}/chunk-0-00002.m4s`);
            availablePaths.add(`${session.assetDir}/chunk-0-00003.m4s`);
        }, 50);

        await jest.advanceTimersByTimeAsync(300);
        await expect(waitPromise).resolves.toBeUndefined();
        expect(mocks.mockTrackFindUnique).not.toHaveBeenCalled();
        expect(mocks.mockGetBuildInFlightStatus).toHaveBeenCalled();
    });

    it("resets startup window backoff after self-heal when build is not in-flight", async () => {
        jest.useFakeTimers();
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();
        const sourcePath = "/music/albums/track-startup-self-heal.flac";
        const session = {
            sessionId: "session-startup-self-heal",
            userId: "user-1",
            trackId: "track-startup-self-heal",
            cacheKey: "cache-startup-self-heal",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/startup-self-heal.mpd",
            assetDir: "/tmp/assets/startup-self-heal",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        } as const;
        const availablePaths = new Set<string>();
        let manifestContents = `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet>
      <Representation>
        <SegmentTemplate>
          <SegmentTimeline></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (candidatePath === sourcePath || availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockFsReadFile.mockImplementation(async () => manifestContents);
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(false);
        mocks.mockTrackFindUnique.mockResolvedValue({
            id: "track-startup-self-heal",
            filePath: "albums/track-startup-self-heal.flac",
            fileModified: new Date("2026-02-20T00:00:00.000Z"),
        });
        mocks.mockManifestGetOrCreateLocalDashAsset.mockImplementation(async () => {
            availablePaths.add("/tmp/assets/startup-self-heal/init-0.m4s");
            availablePaths.add("/tmp/assets/startup-self-heal/chunk-0-00001.m4s");
            availablePaths.add("/tmp/assets/startup-self-heal/chunk-0-00002.m4s");
            availablePaths.add("/tmp/assets/startup-self-heal/chunk-0-00003.m4s");
            manifestContents = `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet>
      <Representation>
        <SegmentTemplate>
          <SegmentTimeline><S t="0" d="45056" /><S d="45056" /><S d="45056" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
            return {
                cacheKey: session.cacheKey,
                outputDir: session.assetDir,
                manifestPath: session.manifestPath,
                quality: "medium",
            };
        });

        const waitPromise = (segmentedStreamingSessionService as any).waitForStartupWindowReady(
            session,
            Date.now() + 1_000,
        );
        await jest.advanceTimersByTimeAsync(400);

        await expect(waitPromise).resolves.toBeUndefined();
        expect(mocks.mockManifestGetOrCreateLocalDashAsset).toHaveBeenCalledTimes(1);
    });

    it("short-circuits polling wait when deadline has elapsed mid-loop", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();
        const session = {
            sessionId: "session-deadline-mid-loop",
            userId: "user-1",
            trackId: "track-deadline-mid-loop",
            cacheKey: "cache-deadline-mid-loop",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/deadline-mid-loop.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        } as const;

        mocks.mockFsAccess.mockRejectedValue(
            Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
        );
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(true);

        const nowValues = [0, 0, 2, 2];
        const nowSpy = jest
            .spyOn(Date, "now")
            .mockImplementation(() => nowValues.shift() ?? 2);

        await expect(
            (segmentedStreamingSessionService as any).waitForAssetFile(
                session,
                session.manifestPath,
                "manifest",
                1,
            ),
        ).rejects.toMatchObject({
            code: "STREAMING_ASSET_NOT_READY",
            statusCode: 503,
        });

        nowSpy.mockRestore();
    });

    it("detects manifest readiness when the asset appears near a tight deadline", async () => {
        jest.useFakeTimers();
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();
        const session = {
            sessionId: "session-tight-deadline-manifest",
            userId: "user-1",
            trackId: "track-tight-deadline-manifest",
            cacheKey: "cache-tight-deadline-manifest",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/tight-deadline-manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        } as const;
        const availablePaths = new Set<string>();

        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(true);

        const waitPromise = (segmentedStreamingSessionService as any).waitForAssetFile(
            session,
            session.manifestPath,
            "manifest",
            Date.now() + 220,
        );
        setTimeout(() => {
            availablePaths.add(session.manifestPath);
        }, 215);

        await jest.advanceTimersByTimeAsync(260);
        await expect(waitPromise).resolves.toBeUndefined();
    });

    it("allows manifest readiness when file exists even if cache is marked invalid", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();
        const session = {
            sessionId: "session-invalid-cache-manifest",
            userId: "user-1",
            trackId: "track-invalid-cache-manifest",
            cacheKey: "cache-invalid-cache-manifest",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/invalid-cache-manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        } as const;

        mocks.mockFsAccess.mockResolvedValue(undefined);
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(true);
        mocks.mockIsCacheMarkedInvalid.mockReturnValue(true);

        const waitPromise = (segmentedStreamingSessionService as any).waitForAssetFile(
            session,
            session.manifestPath,
            "manifest",
            Date.now() + 400,
        );

        await expect(waitPromise).resolves.toBeUndefined();
        expect(mocks.mockGetBuildInFlightStatus).not.toHaveBeenCalled();
    });
});

describe("segmentedStreamingSessionService segment readiness coalescing", () => {
    afterEach(() => {
        jest.useRealTimers();
        jest.resetModules();
        jest.dontMock("../../../utils/db");
        jest.dontMock("../../../utils/redis");
        jest.dontMock("fs");
        jest.dontMock("../../../config");
        jest.dontMock("../../../utils/logger");
        jest.dontMock("../manifestService");
        jest.dontMock("../cacheService");
        jest.dontMock("../segmentService");
    });

    it("coalesces concurrent segment readiness by session id plus segment", async () => {
        jest.useFakeTimers();
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        const segmentPath = "/tmp/assets/chunk-0-00001.m4s";
        const availablePaths = new Set<string>();
        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(true);

        const session = {
            sessionId: "session-segment-coalesce",
            userId: "user-1",
            trackId: "track-1",
            cacheKey: "cache-1",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        } as const;

        const firstWaitPromise = segmentedStreamingSessionService.waitForSegmentReady(
            session,
            "chunk-0-00001.m4s",
        );
        const secondWaitPromise =
            segmentedStreamingSessionService.waitForSegmentReady(
                session,
                "chunk-0-00001.m4s",
            );

        setTimeout(() => {
            availablePaths.add(segmentPath);
        }, 10);

        await jest.advanceTimersByTimeAsync(200);
        await expect(
            Promise.all([firstWaitPromise, secondWaitPromise]),
        ).resolves.toEqual([segmentPath, segmentPath]);

        const segmentAccessCalls = mocks.mockFsAccess.mock.calls.filter(
            ([candidatePath]) => candidatePath === segmentPath,
        );
        expect(segmentAccessCalls).toHaveLength(3);
    });

    it("uses segment readiness microcache within TTL to avoid duplicate fs access", async () => {
        jest.useFakeTimers();
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        const segmentPath = "/tmp/assets/chunk-0-00001.m4s";
        const availablePaths = new Set<string>([segmentPath]);
        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockGetBuildFailure.mockReturnValue(null);
        mocks.mockHasInFlightBuild.mockReturnValue(true);

        const session = {
            sessionId: "session-segment-microcache",
            userId: "user-1",
            trackId: "track-1",
            cacheKey: "cache-1",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        } as const;

        await segmentedStreamingSessionService.waitForSegmentReady(
            session,
            "chunk-0-00001.m4s",
        );
        await segmentedStreamingSessionService.waitForSegmentReady(
            session,
            "chunk-0-00001.m4s",
        );

        const segmentAccessCalls = mocks.mockFsAccess.mock.calls.filter(
            ([candidatePath]) => candidatePath === segmentPath,
        );
        expect(segmentAccessCalls).toHaveLength(1);
    });

    it("short-circuits coalesced segment wait work when microcache is set before wait factory executes", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();
        const segmentName = "chunk-0-00001.m4s";
        const session = {
            sessionId: "session-segment-inner-microcache",
            userId: "user-1",
            trackId: "track-1",
            cacheKey: "cache-1",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        } as const;
        const segmentReadinessKey = `${session.sessionId}:${segmentName}`;

        const waitPromise = segmentedStreamingSessionService.waitForSegmentReady(
            session,
            segmentName,
        );
        (segmentedStreamingSessionService as any).markReadinessMicrocacheHit(
            (segmentedStreamingSessionService as any).segmentReadyMicrocache,
            segmentReadinessKey,
        );

        await expect(waitPromise).resolves.toBe("/tmp/assets/chunk-0-00001.m4s");
        expect(mocks.mockFsAccess).not.toHaveBeenCalled();
    });

    it("clears segment readiness coalescing entry after failure so retries can run", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        const segmentPath = "/tmp/assets/chunk-0-00001.m4s";
        const availablePaths = new Set<string>();
        mocks.mockFsAccess.mockImplementation(async (candidatePath: string) => {
            if (availablePaths.has(candidatePath)) {
                return;
            }
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        });
        mocks.mockGetBuildFailure.mockReturnValue({
            message: "simulated segment build failure",
        });
        mocks.mockHasInFlightBuild.mockReturnValue(true);

        const session = {
            sessionId: "session-segment-failure-cleanup",
            userId: "user-1",
            trackId: "track-1",
            cacheKey: "cache-1",
            quality: "medium",
            sourceType: "local",
            manifestProfile: "startup_single",
            manifestPath: "/tmp/assets/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        } as const;

        const firstWaitPromise = segmentedStreamingSessionService.waitForSegmentReady(
            session,
            "chunk-0-00001.m4s",
        );
        const secondWaitPromise =
            segmentedStreamingSessionService.waitForSegmentReady(
                session,
                "chunk-0-00001.m4s",
            );

        await expect(firstWaitPromise).rejects.toMatchObject({
            code: "STREAMING_ASSET_BUILD_FAILED",
            statusCode: 502,
        });
        await expect(secondWaitPromise).rejects.toMatchObject({
            code: "STREAMING_ASSET_BUILD_FAILED",
            statusCode: 502,
        });
        expect(mocks.mockGetBuildFailure).toHaveBeenCalledTimes(1);

        mocks.mockGetBuildFailure.mockReturnValue(null);
        availablePaths.add(segmentPath);

        await expect(
            segmentedStreamingSessionService.waitForSegmentReady(
                session,
                "chunk-0-00001.m4s",
            ),
        ).resolves.toBe(segmentPath);
    });

    it("retains replaced in-flight entries when coalesced finally cleanup sees a new promise", async () => {
        const { segmentedStreamingSessionService } = await resolveSessionService();

        const inFlight = new Map<string, Promise<void>>();
        const key = "manual-coalesce-key";
        let releaseWait: (() => void) | null = null;
        const waitGate = new Promise<void>((resolve) => {
            releaseWait = resolve;
        });
        const replacementPromise = Promise.resolve();

        const coalescedPromise = (segmentedStreamingSessionService as any).coalesceInFlightByKey(
            inFlight,
            key,
            async () => {
                inFlight.set(key, replacementPromise);
                await waitGate;
            },
        );

        expect(inFlight.has(key)).toBe(true);
        if (releaseWait) {
            (releaseWait as () => void)();
        }
        await expect(coalescedPromise).resolves.toBeUndefined();
        expect(inFlight.get(key)).toBe(replacementPromise);
    });
});
