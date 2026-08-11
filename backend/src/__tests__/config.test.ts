export {};

const mockDotenvConfig = jest.fn();
const mockValidateMusicConfig = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock("dotenv", () => ({
    __esModule: true,
    default: {
        config: (...args: unknown[]) => mockDotenvConfig(...args),
    },
}));

jest.mock("../utils/configValidator", () => ({
    validateMusicConfig: (...args: unknown[]) =>
        mockValidateMusicConfig(...args),
}));

jest.mock("../utils/logger", () => ({
    logger: {
        debug: (...args: unknown[]) => mockLoggerDebug(...args),
        error: (...args: unknown[]) => mockLoggerError(...args),
        warn: (...args: unknown[]) => mockLoggerWarn(...args),
    },
}));

describe("config module", () => {
    const originalEnv = process.env;

    function requiredEnv(): Record<string, string> {
        return {
            DATABASE_URL: "postgresql://db/soundspan",
            REDIS_URL: "redis://127.0.0.1:6379",
            SESSION_SECRET: "12345678901234567890123456789012",
            SETTINGS_ENCRYPTION_KEY: "23456789012345678901234567890123",
            INTERNAL_API_SECRET: "34567890123456789012345678901234",
            MUSIC_PATH: "/music",
        };
    }

    async function loadConfigModule(
        overrides: Record<string, string | undefined> = {},
    ) {
        jest.resetModules();
        jest.clearAllMocks();

        const nextEnv: Record<string, string> = {
            ...requiredEnv(),
            ...Object.fromEntries(
                Object.entries(overrides).filter(
                    ([, value]) => value !== undefined,
                ) as Array<[string, string]>,
            ),
        };

        Object.entries(overrides).forEach(([key, value]) => {
            if (value === undefined) {
                delete nextEnv[key];
            }
        });

        process.env = { ...originalEnv, ...nextEnv };
        Object.entries(overrides).forEach(([key, value]) => {
            if (value === undefined) {
                delete process.env[key];
            }
        });
        return import("../config");
    }

    afterEach(() => {
        process.env = originalEnv;
    });

    it("builds config from validated env with explicit integrations", async () => {
        const { config } = await loadConfigModule({
            PORT: "4010",
            NODE_ENV: "production",
            TRANSCODE_CACHE_PATH: "/cache/transcodes",
            TRANSCODE_CACHE_MAX_GB: "12",
            LIDARR_ENABLED: "true",
            LIDARR_URL: "http://lidarr:8686",
            LIDARR_API_KEY: "lidarr-key",
            LASTFM_API_KEY: "lastfm-key",
            OPENAI_API_KEY: "openai-key",
            DEEZER_API_KEY: "deezer-key",
            DISCOVERY_MODE: "legacy",
            AUDIOBOOKSHELF_URL: "http://audiobookshelf:13378",
            AUDIOBOOKSHELF_API_KEY: "abs-token",
            ALLOWED_ORIGINS: "https://app.example, http://localhost:5173 ",
        });

        expect(mockDotenvConfig).toHaveBeenCalledTimes(1);
        expect(mockDotenvConfig).toHaveBeenCalledWith({ quiet: true });
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "Environment variables validated",
        );

        expect(config.port).toBe(4010);
        expect(config.nodeEnv).toBe("production");
        expect(config.databaseUrl).toBe("postgresql://db/soundspan");
        expect(config.redisUrl).toBe("redis://127.0.0.1:6379");
        expect(config.sessionSecret).toBe("12345678901234567890123456789012");
        expect(config.music).toEqual({
            musicPath: "/music",
            transcodeCachePath: "/cache/transcodes",
            transcodeCacheMaxGb: 12,
        });
        expect(config.lidarr).toEqual({
            url: "http://lidarr:8686",
            apiKey: "lidarr-key",
            enabled: true,
        });
        expect(config.lastfm).toEqual({ apiKey: "lastfm-key" });
        expect(config.openai).toEqual({ apiKey: "openai-key" });
        expect(config.deezer).toEqual({ apiKey: "deezer-key" });
        expect(config.discover).toEqual({ mode: "legacy" });
        expect(config.audiobookshelf).toEqual({
            url: "http://audiobookshelf:13378",
            apiKey: "abs-token",
        });
        expect(config.allowedOrigins).toEqual([
            "https://app.example",
            "http://localhost:5173",
        ]);
    });

    it("retains integration secret env fallbacks by default", async () => {
        const { config } = await loadConfigModule({
            SECRETS_DB_ONLY: undefined,
            LASTFM_API_KEY: "env-key-456",
            AUDIOBOOKSHELF_URL: "http://audiobookshelf:13378",
            AUDIOBOOKSHELF_API_KEY: "env-abs-key-456",
        });

        expect(config.secretsDbOnly).toBe(false);
        expect(config.lastfm.apiKey).toBe("env-key-456");
        expect(config.audiobookshelf).toEqual({
            url: "http://audiobookshelf:13378",
            apiKey: "env-abs-key-456",
        });
    });

    it("blanks integration secret env values in DB-only mode", async () => {
        const { config } = await loadConfigModule({
            SECRETS_DB_ONLY: "true",
            LASTFM_API_KEY: "env-lastfm-key-456",
            OPENAI_API_KEY: "env-openai-key-456",
            DEEZER_API_KEY: "env-deezer-key-456",
            AUDIOBOOKSHELF_URL: "http://audiobookshelf:13378",
            AUDIOBOOKSHELF_API_KEY: "env-abs-key-456",
            LIDARR_ENABLED: "true",
            LIDARR_URL: "http://lidarr:8686",
            // Deliberately low-entropy synthetic fixture (gitleaks-safe).
            LIDARR_API_KEY: "env-lidarr-fixture",
        });

        expect(config.secretsDbOnly).toBe(true);
        expect(config.lastfm.apiKey).toBe("");
        expect(config.openai.apiKey).toBe("");
        expect(config.deezer.apiKey).toBe("");
        expect(config.audiobookshelf).toBeUndefined();
        expect(config.lidarr?.apiKey).toBe("");
        expect(config.lidarr?.url).toBe("http://lidarr:8686");
    });

    it("uses allowedOrigins fallbacks for development and production", async () => {
        const devModule = await loadConfigModule({
            NODE_ENV: "development",
            ALLOWED_ORIGINS: undefined,
        });
        expect(devModule.config.allowedOrigins).toBe(true);

        const prodModule = await loadConfigModule({
            NODE_ENV: "production",
            ALLOWED_ORIGINS: undefined,
        });
        expect(prodModule.config.allowedOrigins).toEqual([]);
        expect(prodModule.config.lastfm).toEqual({ apiKey: "" });
    });

    it("defaults secureCookies to true in production and false otherwise", async () => {
        const prod = await loadConfigModule({ NODE_ENV: "production" });
        expect(prod.config.secureCookies).toBe(true);

        const dev = await loadConfigModule({ NODE_ENV: "development" });
        expect(dev.config.secureCookies).toBe(false);
    });

    it("honors an explicit SECURE_COOKIES override in any environment", async () => {
        const prodOff = await loadConfigModule({
            NODE_ENV: "production",
            SECURE_COOKIES: "false",
        });
        expect(prodOff.config.secureCookies).toBe(false);

        const devOn = await loadConfigModule({
            NODE_ENV: "development",
            SECURE_COOKIES: "true",
        });
        expect(devOn.config.secureCookies).toBe(true);
    });

    it("trustProxy defaults to true and accepts a numeric hop count", async () => {
        const def = await loadConfigModule({ TRUST_PROXY_HOPS: undefined });
        expect(def.config.trustProxy).toBe(true);

        const oneHop = await loadConfigModule({ TRUST_PROXY_HOPS: "1" });
        expect(oneHop.config.trustProxy).toBe(1);

        const noTrust = await loadConfigModule({ TRUST_PROXY_HOPS: "0" });
        expect(noTrust.config.trustProxy).toBe(0);

        const invalid = await loadConfigModule({ TRUST_PROXY_HOPS: "nope" });
        expect(invalid.config.trustProxy).toBe(true);
    });

    it("falls back for malformed numeric env values", async () => {
        const { config } = await loadConfigModule({
            PORT: "not-a-number",
            TRANSCODE_CACHE_MAX_GB: "invalid-size",
        });

        expect(config.port).toBe(3006);
        expect(config.music.transcodeCacheMaxGb).toBe(10);
    });

    it("treats only literal true as an enabled feature flag", async () => {
        const { config } = await loadConfigModule({
            LIDARR_ENABLED: "TRUE",
            LIDARR_URL: "http://lidarr:8686",
            LIDARR_API_KEY: "ignored",
        });

        expect(config.lidarr).toBeUndefined();
    });

    it("keeps explicit empty allowed-origins input without fallback", async () => {
        const { config } = await loadConfigModule({
            NODE_ENV: "production",
            ALLOWED_ORIGINS: "",
        });

        expect(config.allowedOrigins).toEqual([""]);
    });

    it("falls back to SESSION_SECRET when JWT_SECRET is absent", async () => {
        const fallback = await loadConfigModule({ JWT_SECRET: undefined });
        expect(fallback.config.jwtSecret).toBe(requiredEnv().SESSION_SECRET);
    });

    it("rejects JWT_SECRET values shorter than 32 characters", async () => {
        const exitSpy = jest.spyOn(process, "exit").mockImplementation(((
            code?: number,
        ) => {
            throw new Error(`process.exit:${code}`);
        }) as never);

        await expect(
            loadConfigModule({ JWT_SECRET: "short-jwt-secret" }),
        ).rejects.toThrow("process.exit:1");
        expect(
            mockLoggerError.mock.calls.some(
                (call) =>
                    typeof call[0] === "string" &&
                    call[0].includes(
                        "JWT_SECRET must be at least 32 characters",
                    ),
            ),
        ).toBe(true);

        exitSpy.mockRestore();
    });

    it("uses JWT_SECRET when it is at least 32 characters", async () => {
        const jwtSecret = "12345678901234567890123456789012";
        const explicit = await loadConfigModule({ JWT_SECRET: jwtSecret });

        expect(explicit.config.jwtSecret).toBe(jwtSecret);
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "Environment variables validated",
        );
    });

    it.each([
        ["SETTINGS_ENCRYPTION_KEY", "x".repeat(31)],
        ["INTERNAL_API_SECRET", "y".repeat(31)],
    ])("rejects a weak %s at startup", async (name, value) => {
        const exitSpy = jest.spyOn(process, "exit").mockImplementation(((
            code?: number,
        ) => {
            throw new Error(`process.exit:${code}`);
        }) as never);

        await expect(loadConfigModule({ [name]: value })).rejects.toThrow(
            "process.exit:1",
        );
        expect(
            mockLoggerError.mock.calls.some(
                (call) =>
                    typeof call[0] === "string" &&
                    call[0].includes(`${name} must be at least 32 characters`),
            ),
        ).toBe(true);
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain(value);

        exitSpy.mockRestore();
    });

    it("validates the legacy ENCRYPTION_KEY fallback with the same minimum", async () => {
        const exitSpy = jest.spyOn(process, "exit").mockImplementation(((
            code?: number,
        ) => {
            throw new Error(`process.exit:${code}`);
        }) as never);

        await expect(
            loadConfigModule({
                SETTINGS_ENCRYPTION_KEY: undefined,
                ENCRYPTION_KEY: "z".repeat(31),
            }),
        ).rejects.toThrow("process.exit:1");
        expect(
            mockLoggerError.mock.calls.some(
                (call) =>
                    typeof call[0] === "string" &&
                    call[0].includes(
                        "ENCRYPTION_KEY must be at least 32 characters",
                    ),
            ),
        ).toBe(true);

        exitSpy.mockRestore();
    });

    it.each([
        [
            "SETTINGS_ENCRYPTION_KEY",
            {
                SETTINGS_ENCRYPTION_KEY: undefined,
                ENCRYPTION_KEY: undefined,
            },
        ],
        ["INTERNAL_API_SECRET", { INTERNAL_API_SECRET: undefined }],
    ])("requires %s at startup", async (name, overrides) => {
        const exitSpy = jest.spyOn(process, "exit").mockImplementation(((
            code?: number,
        ) => {
            throw new Error(`process.exit:${code}`);
        }) as never);

        await expect(loadConfigModule(overrides)).rejects.toThrow(
            "process.exit:1",
        );
        expect(
            mockLoggerError.mock.calls.some(
                (call) =>
                    typeof call[0] === "string" &&
                    call[0].includes(`${name} is required`),
            ),
        ).toBe(true);

        exitSpy.mockRestore();
    });

    it.each([
        ["SETTINGS_ENCRYPTION_KEY", "default-encryption-key-change-me"],
        ["INTERNAL_API_SECRET", "soundspan-internal-secret-change-me"],
    ])("rejects the published %s default at startup", async (name, value) => {
        const exitSpy = jest.spyOn(process, "exit").mockImplementation(((
            code?: number,
        ) => {
            throw new Error(`process.exit:${code}`);
        }) as never);

        await expect(loadConfigModule({ [name]: value })).rejects.toThrow(
            "process.exit:1",
        );
        expect(
            mockLoggerError.mock.calls.some(
                (call) =>
                    typeof call[0] === "string" &&
                    call[0].includes(`${name} must not use the published`),
            ),
        ).toBe(true);

        exitSpy.mockRestore();
    });

    it("accepts critical secrets at the 32-character boundary", async () => {
        const { config } = await loadConfigModule({
            SETTINGS_ENCRYPTION_KEY: "e".repeat(32),
            INTERNAL_API_SECRET: "i".repeat(32),
        });

        expect(config.internalApiSecret).toBe("i".repeat(32));
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "Environment variables validated",
        );
    });

    it("enables public docs and strict decryption only for literal true", async () => {
        const enabled = await loadConfigModule({
            DOCS_PUBLIC: "true",
            SETTINGS_DECRYPT_FAIL_CLOSED: "true",
        });
        expect(enabled.config.docsPublic).toBe(true);
        expect(enabled.config.settingsDecryptFailClosed).toBe(true);

        const disabled = await loadConfigModule({
            DOCS_PUBLIC: "TRUE",
            SETTINGS_DECRYPT_FAIL_CLOSED: "1",
        });
        expect(disabled.config.docsPublic).toBe(false);
        expect(disabled.config.settingsDecryptFailClosed).toBe(false);
    });

    it("configures the YouTube Music region and TIDAL sidecar URL", async () => {
        const defaults = await loadConfigModule({
            YTMUSIC_REGION: undefined,
            TIDAL_SIDECAR_URL: undefined,
        });
        expect(defaults.config.ytmusicRegion).toBe("US");
        expect(defaults.config.tidal.sidecarUrl).toBe("http://127.0.0.1:8585");

        const overrides = await loadConfigModule({
            YTMUSIC_REGION: "GB",
            TIDAL_SIDECAR_URL: "http://tidal:8585",
        });
        expect(overrides.config.ytmusicRegion).toBe("GB");
        expect(overrides.config.tidal.sidecarUrl).toBe("http://tidal:8585");
    });

    it("exposes the optional one-shot admin reset password", async () => {
        const absent = await loadConfigModule({
            ADMIN_RESET_PASSWORD: undefined,
        });
        expect(absent.config.adminResetPassword).toBeUndefined();

        const configured = await loadConfigModule({
            ADMIN_RESET_PASSWORD: "new-admin-password",
        });
        expect(configured.config.adminResetPassword).toBe("new-admin-password");
    });

    it("uses Listen Together defaults", async () => {
        const { config } = await loadConfigModule({
            LISTEN_TOGETHER_RECONNECT_SLO_MS: undefined,
            LISTEN_TOGETHER_ALLOW_POLLING: undefined,
            LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED: undefined,
            LISTEN_TOGETHER_MUTATION_LOCK_ENABLED: undefined,
            LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS: undefined,
            LISTEN_TOGETHER_MUTATION_LOCK_PREFIX: undefined,
        });

        expect(config.listenTogether).toEqual({
            reconnectSloMs: 5000,
            allowPolling: false,
            redisAdapterEnabled: true,
            mutationLockEnabled: true,
            mutationLockTtlMs: 3000,
            mutationLockPrefix: "listen-together:mutation-lock",
        });
    });

    it("honors Listen Together overrides and rejects invalid positive integers", async () => {
        const overridden = await loadConfigModule({
            LISTEN_TOGETHER_RECONNECT_SLO_MS: "7500",
            LISTEN_TOGETHER_ALLOW_POLLING: "true",
            LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED: "false",
            LISTEN_TOGETHER_MUTATION_LOCK_ENABLED: "false",
            LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS: "4500",
            LISTEN_TOGETHER_MUTATION_LOCK_PREFIX: "custom-lock",
        });
        expect(overridden.config.listenTogether).toEqual({
            reconnectSloMs: 7500,
            allowPolling: true,
            redisAdapterEnabled: false,
            mutationLockEnabled: false,
            mutationLockTtlMs: 4500,
            mutationLockPrefix: "custom-lock",
        });

        const invalid = await loadConfigModule({
            LISTEN_TOGETHER_RECONNECT_SLO_MS: "0",
            LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS: "malformed",
        });
        expect(invalid.config.listenTogether.reconnectSloMs).toBe(5000);
        expect(invalid.config.listenTogether.mutationLockTtlMs).toBe(3000);
    });

    it("uses readiness defaults and honors explicit overrides", async () => {
        const defaults = await loadConfigModule({
            READINESS_DEPENDENCY_CHECK_INTERVAL_MS: undefined,
            READINESS_DEPENDENCY_CHECK_TIMEOUT_MS: undefined,
            READINESS_REQUIRE_DEPENDENCIES: undefined,
        });
        expect(defaults.config.readiness).toEqual({
            dependencyCheckIntervalMs: 5000,
            dependencyCheckTimeoutMs: 2000,
            requireDependencies: true,
        });

        const overridden = await loadConfigModule({
            READINESS_DEPENDENCY_CHECK_INTERVAL_MS: "9000",
            READINESS_DEPENDENCY_CHECK_TIMEOUT_MS: "3500",
            READINESS_REQUIRE_DEPENDENCIES: "false",
        });
        expect(overridden.config.readiness).toEqual({
            dependencyCheckIntervalMs: 9000,
            dependencyCheckTimeoutMs: 3500,
            requireDependencies: false,
        });

        const nonLiteral = await loadConfigModule({
            READINESS_REQUIRE_DEPENDENCIES: "FALSE",
        });
        expect(nonLiteral.config.readiness.requireDependencies).toBe(true);
    });

    it("uses segmented streaming defaults", async () => {
        const { config } = await loadConfigModule({
            SEGMENTED_STREAMING_DASH_BUILD_LOCK_ENABLED: undefined,
            SEGMENTED_STREAMING_DASH_BUILD_LOCK_PREFIX: undefined,
            SEGMENTED_STREAMING_DASH_BUILD_LOCK_TTL_MS: undefined,
            SEGMENTED_LOCAL_SEG_DURATION_SEC: undefined,
            FFMPEG_PATH: undefined,
            STREAMING_TRACE_LOGS: undefined,
            SEGMENTED_STREAMING_TRACE_LOGS: undefined,
            SEGMENTED_STREAMING_CACHE_PATH: undefined,
            SEGMENTED_STREAMING_CACHE_MAX_GB: undefined,
            SEGMENTED_STREAMING_CACHE_PRUNE_INTERVAL_MS: undefined,
            SEGMENTED_STREAMING_CACHE_MIN_AGE_MS: undefined,
            SEGMENTED_STREAMING_CACHE_PRUNE_TARGET_RATIO: undefined,
            SEGMENTED_STREAMING_CACHE_SCHEMA_VERSION: undefined,
        });

        expect(config.segmentedStreaming).toEqual({
            dashBuildLockEnabled: true,
            dashBuildLockPrefix: "segmented-streaming:dash-build-lock",
            dashBuildLockTtlMsOverride: null,
            localSegmentDurationSecOverride: null,
            ffmpegPathOverride: undefined,
            traceEnabled: false,
            cache: {
                basePathOverride: undefined,
                maxGbOverride: null,
                pruneIntervalMsOverride: null,
                minAgeMsOverride: null,
                pruneTargetRatioOverride: null,
                schemaVersionOverride: undefined,
            },
        });
    });

    it("honors segmented streaming overrides", async () => {
        const { config } = await loadConfigModule({
            SEGMENTED_STREAMING_DASH_BUILD_LOCK_ENABLED: "false",
            SEGMENTED_STREAMING_DASH_BUILD_LOCK_PREFIX: "dash-lock",
            SEGMENTED_STREAMING_DASH_BUILD_LOCK_TTL_MS: "12000",
            SEGMENTED_LOCAL_SEG_DURATION_SEC: "4.5",
            FFMPEG_PATH: " /usr/local/bin/ffmpeg ",
            SEGMENTED_STREAMING_TRACE_LOGS: "yes",
            SEGMENTED_STREAMING_CACHE_PATH: " /var/cache/segments ",
            SEGMENTED_STREAMING_CACHE_MAX_GB: "25.5",
            SEGMENTED_STREAMING_CACHE_PRUNE_INTERVAL_MS: "60000",
            SEGMENTED_STREAMING_CACHE_MIN_AGE_MS: "1500",
            SEGMENTED_STREAMING_CACHE_PRUNE_TARGET_RATIO: "0.8",
            SEGMENTED_STREAMING_CACHE_SCHEMA_VERSION: " v2 ",
        });

        expect(config.segmentedStreaming).toEqual({
            dashBuildLockEnabled: false,
            dashBuildLockPrefix: "dash-lock",
            dashBuildLockTtlMsOverride: 12000,
            localSegmentDurationSecOverride: 4.5,
            ffmpegPathOverride: "/usr/local/bin/ffmpeg",
            traceEnabled: true,
            cache: {
                basePathOverride: "/var/cache/segments",
                maxGbOverride: 25.5,
                pruneIntervalMsOverride: 60000,
                minAgeMsOverride: 1500,
                pruneTargetRatioOverride: 0.8,
                schemaVersionOverride: "v2",
            },
        });
    });

    it.each(["1", "true", "yes", "on"])(
        "enables streaming trace logs for STREAMING_TRACE_LOGS=%s",
        async (value) => {
            const { config } = await loadConfigModule({
                STREAMING_TRACE_LOGS: value,
                SEGMENTED_STREAMING_TRACE_LOGS: undefined,
            });
            expect(config.segmentedStreaming.traceEnabled).toBe(true);
        },
    );

    it("rejects non-positive segmented streaming numeric overrides", async () => {
        const { config } = await loadConfigModule({
            SEGMENTED_STREAMING_DASH_BUILD_LOCK_TTL_MS: "0",
            SEGMENTED_LOCAL_SEG_DURATION_SEC: "-1",
            SEGMENTED_STREAMING_CACHE_MAX_GB: "0",
            SEGMENTED_STREAMING_CACHE_PRUNE_INTERVAL_MS: "-2",
            SEGMENTED_STREAMING_CACHE_MIN_AGE_MS: "0",
            SEGMENTED_STREAMING_CACHE_PRUNE_TARGET_RATIO: "-0.1",
        });

        expect(config.segmentedStreaming.dashBuildLockTtlMsOverride).toBeNull();
        expect(
            config.segmentedStreaming.localSegmentDurationSecOverride,
        ).toBeNull();
        expect(config.segmentedStreaming.cache.maxGbOverride).toBeNull();
        expect(
            config.segmentedStreaming.cache.pruneIntervalMsOverride,
        ).toBeNull();
        expect(config.segmentedStreaming.cache.minAgeMsOverride).toBeNull();
        expect(
            config.segmentedStreaming.cache.pruneTargetRatioOverride,
        ).toBeNull();
    });

    it("requires both Audiobookshelf URL and API key", async () => {
        const urlOnly = await loadConfigModule({
            AUDIOBOOKSHELF_URL: "http://audiobookshelf:13378",
            AUDIOBOOKSHELF_API_KEY: undefined,
        });
        expect(urlOnly.config.audiobookshelf).toBeUndefined();

        const keyOnly = await loadConfigModule({
            AUDIOBOOKSHELF_URL: undefined,
            AUDIOBOOKSHELF_API_KEY: "abs-token",
        });
        expect(keyOnly.config.audiobookshelf).toBeUndefined();
    });

    it("logs validation errors and exits for invalid environment variables", async () => {
        const exitSpy = jest.spyOn(process, "exit").mockImplementation(((
            code?: number,
        ) => {
            throw new Error(`process.exit:${code}`);
        }) as never);

        await expect(
            loadConfigModule({
                DATABASE_URL: undefined,
            }),
        ).rejects.toThrow("process.exit:1");

        expect(mockLoggerError).toHaveBeenCalledWith(
            " Environment validation failed:",
        );
        expect(
            mockLoggerError.mock.calls.some(
                (call) =>
                    typeof call[0] === "string" &&
                    call[0].includes("DATABASE_URL"),
            ),
        ).toBe(true);
        expect(mockLoggerError).toHaveBeenCalledWith(
            "\n Please check your .env file and ensure all required variables are set.",
        );

        exitSpy.mockRestore();
    });

    it("initializes music config from validator result", async () => {
        mockValidateMusicConfig.mockResolvedValueOnce({
            musicPath: "/validated/music",
            transcodeCachePath: "/validated/cache",
            transcodeCacheMaxGb: 20,
        });

        const { config, initializeMusicConfig } = await loadConfigModule({
            TRANSCODE_CACHE_PATH: "/default/cache",
            TRANSCODE_CACHE_MAX_GB: "6",
        });

        expect(config.music).toEqual({
            musicPath: "/music",
            transcodeCachePath: "/default/cache",
            transcodeCacheMaxGb: 6,
        });

        await initializeMusicConfig();

        expect(config.music).toEqual({
            musicPath: "/validated/music",
            transcodeCachePath: "/validated/cache",
            transcodeCacheMaxGb: 20,
        });
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "Music configuration initialized",
        );
    });

    it("keeps existing music config when validator fails", async () => {
        mockValidateMusicConfig.mockRejectedValueOnce(new Error("bad config"));

        const { config, initializeMusicConfig } = await loadConfigModule({
            MUSIC_PATH: "/fallback/music",
            TRANSCODE_CACHE_PATH: "/fallback/cache",
            TRANSCODE_CACHE_MAX_GB: "9",
        });

        expect(config.music).toEqual({
            musicPath: "/fallback/music",
            transcodeCachePath: "/fallback/cache",
            transcodeCacheMaxGb: 9,
        });

        await initializeMusicConfig();

        expect(config.music).toEqual({
            musicPath: "/fallback/music",
            transcodeCachePath: "/fallback/cache",
            transcodeCacheMaxGb: 9,
        });
        expect(mockLoggerError).toHaveBeenCalledWith(
            " Configuration validation failed:",
            "bad config",
        );
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "   Using default/environment configuration",
        );
    });
});
