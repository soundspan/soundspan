const resolveSessionService = async () => {
    jest.resetModules();

    const mockTrackFindUnique = jest.fn();
    const mockManifestGetOrCreateLocalDashAsset = jest.fn();
    const mockRedisSetEx = jest.fn();
    const mockRedisGet = jest.fn();
    const mockRedisDel = jest.fn();
    const mockRegisterSessionReference = jest.fn();
    const mockClearSessionReference = jest.fn();

    jest.doMock("../../../utils/db", () => ({
        prisma: {
            track: {
                findUnique: (...args: unknown[]) => mockTrackFindUnique(...args),
            },
            userSettings: {
                findUnique: jest.fn(),
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
            hasInFlightBuild: jest.fn(),
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
            mockManifestGetOrCreateLocalDashAsset,
            mockRedisSetEx,
            mockRedisGet,
            mockRedisDel,
            mockRegisterSessionReference,
            mockClearSessionReference,
        },
    };
};

describe("segmentedStreamingSessionService local quality handling", () => {
    afterEach(() => {
        jest.resetModules();
        jest.dontMock("../../../utils/db");
        jest.dontMock("../../../utils/redis");
        jest.dontMock("../../../config");
        jest.dontMock("../../../utils/logger");
        jest.dontMock("../manifestService");
        jest.dontMock("../cacheService");
        jest.dontMock("../segmentService");
        jest.dontMock("../providerAdapters/tidalAdapter");
        jest.dontMock("../providerAdapters/ytMusicAdapter");
        jest.dontMock("../providerAdapters/adapterError");
    });

    it("rejects local original quality segmented sessions so clients can fall back to direct playback", async () => {
        const { segmentedStreamingSessionService, mocks } =
            await resolveSessionService();

        mocks.mockTrackFindUnique.mockResolvedValueOnce({
            id: "track-1",
            filePath: "albums/track-1.flac",
            fileModified: new Date("2026-02-20T00:00:00.000Z"),
        });

        await expect(
            segmentedStreamingSessionService.createLocalSession({
                userId: "user-1",
                trackId: "track-1",
                desiredQuality: "original",
            }),
        ).rejects.toMatchObject({
            statusCode: 409,
            code: "STREAMING_ORIGINAL_QUALITY_REQUIRES_DIRECT",
        });

        expect(mocks.mockManifestGetOrCreateLocalDashAsset).not.toHaveBeenCalled();
        expect(mocks.mockRedisSetEx).not.toHaveBeenCalled();
        expect(mocks.mockRegisterSessionReference).not.toHaveBeenCalled();
    });
});
