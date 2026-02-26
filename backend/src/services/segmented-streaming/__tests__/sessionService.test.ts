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
    const mockFsReadFile = jest.fn();
    const mockHasInFlightBuild = jest.fn();
    const mockGetBuildFailure = jest.fn();

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
            getBuildFailure: (...args: unknown[]) =>
                mockGetBuildFailure(...args),
            hasInFlightBuild: (...args: unknown[]) =>
                mockHasInFlightBuild(...args),
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
            mockFsReadFile,
            mockHasInFlightBuild,
            mockGetBuildFailure,
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

    it("waits for startup timeline plus first two chunks before serving manifest", async () => {
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
            manifestPath: "/tmp/assets/manifest.mpd",
            assetDir: "/tmp/assets",
            createdAt: "2026-02-20T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
        });

        setTimeout(() => {
            availablePaths.add("/tmp/assets/init-0.m4s");
            availablePaths.add("/tmp/assets/chunk-0-00001.m4s");
            availablePaths.add("/tmp/assets/chunk-0-00002.m4s");
            manifestContents = `<?xml version="1.0"?>
<MPD>
  <Period>
    <AdaptationSet>
      <Representation>
        <SegmentTemplate>
          <SegmentTimeline><S t="0" d="45056" /><S d="45056" /></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
        }, 10);

        await expect(waitPromise).resolves.toBeUndefined();
    });

    it("fails startup readiness when init plus two chunks are not all available", async () => {
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
          <SegmentTimeline><S t="0" d="45056" /><S d="45056" /></SegmentTimeline>
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

    it("does not block manifest when build is no longer in-flight", async () => {
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

        await expect(
            segmentedStreamingSessionService.waitForManifestReady({
                sessionId: "session-2",
                userId: "user-1",
                trackId: "track-1",
                cacheKey: "cache-1",
                quality: "medium",
                sourceType: "local",
                manifestPath: "/tmp/assets/manifest.mpd",
                assetDir: "/tmp/assets",
                createdAt: "2026-02-20T00:00:00.000Z",
                expiresAt: "2099-01-01T00:00:00.000Z",
            }),
        ).resolves.toBeUndefined();
    });
});
