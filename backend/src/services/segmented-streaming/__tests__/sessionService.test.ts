const resolveSessionService = async () => {
    jest.resetModules();

    const mockTrackFindUnique = jest.fn();
    const mockUserSettingsFindUnique = jest.fn();
    const mockManifestGetOrCreateLocalDashAsset = jest.fn();
    const mockRedisSetEx = jest.fn();
    const mockRedisGet = jest.fn();
    const mockRedisDel = jest.fn();
    const mockRegisterSessionReference = jest.fn();
    const mockClearSessionReference = jest.fn();
    const mockFsAccess = jest.fn();
    const mockHasInFlightBuild = jest.fn();

    jest.doMock("fs", () => ({
        promises: {
            access: (...args: unknown[]) => mockFsAccess(...args),
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
        segmentedSegmentService: {
            getBuildFailure: jest.fn(),
            hasInFlightBuild: (...args: unknown[]) =>
                mockHasInFlightBuild(...args),
        },
    }));

    jest.doMock("../providerAdapters/tidalAdapter", () => ({
        tidalSegmentedProviderAdapter: {
            createSessionAsset: jest.fn(),
        },
    }));

    jest.doMock("../providerAdapters/ytMusicAdapter", () => ({
        ytMusicSegmentedProviderAdapter: {
            createSessionAsset: jest.fn(),
        },
    }));

    jest.doMock("../providerAdapters/adapterError", () => ({
        SegmentedProviderAdapterError: class SegmentedProviderAdapterError extends Error {
            statusCode: number;
            code: string;

            constructor(message: string, statusCode = 500, code = "UNKNOWN_ERROR") {
                super(message);
                this.statusCode = statusCode;
                this.code = code;
            }
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
            mockRegisterSessionReference,
            mockClearSessionReference,
            mockFsAccess,
            mockHasInFlightBuild,
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
        jest.dontMock("../providerAdapters/tidalAdapter");
        jest.dontMock("../providerAdapters/ytMusicAdapter");
        jest.dontMock("../providerAdapters/adapterError");
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

    it("marks local cold-start segmented sessions to prefer direct startup", async () => {
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
            preferDirectStartup: true,
        });
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
        jest.dontMock("../providerAdapters/tidalAdapter");
        jest.dontMock("../providerAdapters/ytMusicAdapter");
        jest.dontMock("../providerAdapters/adapterError");
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
});
