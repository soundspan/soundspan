export {};

const mockDotenvConfig = jest.fn();
const mockValidateMusicConfig = jest.fn();
const mockLoggerDebug = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();
const mockValidateEncryptionKey = jest.fn();

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

jest.mock("../utils/encryption", () => ({
    validateEncryptionKey: (...args: unknown[]) =>
        mockValidateEncryptionKey(...args),
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
            LOCAL_LOGIN_ENABLED: "true",
            OIDC_ENABLED: "false",
            OIDC_MANAGE_ROLES: "false",
        };
    }

    function validOidcEnv(): Record<string, string> {
        return {
            OIDC_ENABLED: "true",
            OIDC_ISSUER_URL: "https://idp.example/application/o/soundspan/",
            OIDC_CLIENT_ID: "soundspan-client",
            OIDC_CLIENT_SECRET: "client-secret-fixture",
            OIDC_REDIRECT_URI:
                "https://soundspan.example/api/auth/oidc/callback",
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

    async function expectStartupValidationFailure(
        overrides: Record<string, string | undefined>,
        expectedMessage: string,
    ): Promise<void> {
        const exitSpy = jest.spyOn(process, "exit").mockImplementation(((
            code?: number,
        ) => {
            throw new Error(`process.exit:${code}`);
        }) as never);

        try {
            await expect(loadConfigModule(overrides)).rejects.toThrow(
                "process.exit:1",
            );
            expect(
                mockLoggerError.mock.calls.some(
                    (call) =>
                        typeof call[0] === "string" &&
                        call[0].includes(expectedMessage),
                ),
            ).toBe(true);
        } finally {
            exitSpy.mockRestore();
        }
    }

    it("builds config from validated env with explicit integrations", async () => {
        const { config } = await loadConfigModule({
            PORT: "4010",
            NODE_ENV: "production",
            TRANSCODE_CACHE_PATH: "/cache/transcodes",
            TRANSCODE_CACHE_MAX_GB: "12",
            BROWSE_IMAGE_CACHE_MAX_BYTES: "1234567",
            BROWSE_IMAGE_CACHE_MAX_ENTRIES: "123",
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
            FEDERATION_ALLOW_PROXY: undefined,
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
        expect(config.browseImageCache).toEqual({
            maxBytes: 1234567,
            maxEntries: 123,
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
        expect(config.features.federation).toBe(false);
        expect(config.features.requests).toBe(true);
        expect(config.requests).toEqual({ dailyCapPerUser: 10 });
        expect(config.federation.allowPrivatePeers).toBe(false);
        expect(config.federation.allowProxy).toBe(false);
        expect(config.workers.federationTombstoneRetentionDays).toBe(90);
        expect(config.workers.federationSyncIntervalMinutes).toBe(15);
    });

    it("uses safe local-login and OIDC defaults", async () => {
        const { config } = await loadConfigModule({
            LOCAL_LOGIN_ENABLED: undefined,
            OIDC_ENABLED: undefined,
            OIDC_ISSUER_URL: undefined,
            OIDC_CLIENT_ID: undefined,
            OIDC_CLIENT_SECRET: undefined,
            OIDC_REDIRECT_URI: undefined,
            OIDC_WEB_BASE_URL: undefined,
            OIDC_SCOPES: undefined,
            OIDC_AUTO_PROVISION: undefined,
            OIDC_MANAGE_ROLES: undefined,
            OIDC_GROUPS_CLAIM: undefined,
            OIDC_ADMIN_GROUP: undefined,
            OIDC_EMAIL_CLAIM: undefined,
            OIDC_NAME_CLAIM: undefined,
            OIDC_PROVIDER_NAME: undefined,
        });

        expect(config).toMatchObject({
            localLoginEnabled: true,
            oidc: {
                enabled: false,
                webBaseUrl: "",
                scopes: "openid profile email",
                autoProvision: false,
                manageRoles: false,
                groupsClaim: "groups",
                adminGroup: "",
                emailClaim: "email",
                nameClaim: "name",
                providerName: "SSO",
            },
        });
    });

    it("keeps the vibe provider disabled when its URL is absent", async () => {
        const { config } = await loadConfigModule({
            VIBE_PROVIDER_URL: undefined,
            VIBE_EMBED_CONCURRENCY: undefined,
        });

        expect(config.vibeProviderUrl).toBeUndefined();
        expect(config.vibeEmbedConcurrency).toBe(1);
    });

    it("defaults the loudness target to the ReplayGain 2 reference", async () => {
        const { config } = await loadConfigModule({
            LOUDNESS_TARGET_LUFS: undefined,
        });

        expect(config.loudnessTargetLufs).toBe(-18);
    });

    it.each(["-30", "-18.5", "-10"])(
        "accepts the bounded loudness target %s LUFS",
        async (loudnessTargetLufs) => {
            const { config } = await loadConfigModule({
                LOUDNESS_TARGET_LUFS: loudnessTargetLufs,
            });

            expect(config.loudnessTargetLufs).toBe(Number(loudnessTargetLufs));
        },
    );

    it.each(["", "-30.1", "-9.9", "not-a-number"])(
        "rejects invalid loudness target %s",
        async (loudnessTargetLufs) => {
            await expectStartupValidationFailure(
                { LOUDNESS_TARGET_LUFS: loudnessTargetLufs },
                "LOUDNESS_TARGET_LUFS",
            );
        },
    );

    it.each([
        [undefined, 25],
        ["0", 1],
        ["1", 1],
        ["75", 75],
        ["200", 200],
        ["201", 200],
    ])("clamps LOUDNESS_BACKFILL_BATCH_SIZE %s", async (raw, expected) => {
        const { config } = await loadConfigModule({
            LOUDNESS_BACKFILL_BATCH_SIZE: raw,
        });

        expect(config.analysisQueues.loudnessBackfillBatchSize).toBe(expected);
    });

    it.each(["", "1.5", "not-a-number"])(
        "rejects invalid LOUDNESS_BACKFILL_BATCH_SIZE %s",
        async (raw) => {
            await expectStartupValidationFailure(
                { LOUDNESS_BACKFILL_BATCH_SIZE: raw },
                "LOUDNESS_BACKFILL_BATCH_SIZE must be an integer",
            );
        },
    );

    it.each([
        ["1", 1],
        ["4", 4],
        ["8", 8],
        ["32", 32],
    ])("parses VIBE_EMBED_CONCURRENCY %s", async (raw, expected) => {
        const { config } = await loadConfigModule({
            VIBE_EMBED_CONCURRENCY: raw,
        });

        expect(config.vibeEmbedConcurrency).toBe(expected);
    });

    it.each(["", "0", "33", "1.5", "not-a-number"])(
        "rejects invalid VIBE_EMBED_CONCURRENCY %s",
        async (raw) => {
            await expectStartupValidationFailure(
                { VIBE_EMBED_CONCURRENCY: raw },
                "VIBE_EMBED_CONCURRENCY must be an integer from 1 through 32",
            );
        },
    );

    it("uses safe embedding-space lifecycle defaults", async () => {
        const { config } = await loadConfigModule({
            VIBE_SPACE_CUTOVER_THRESHOLD: undefined,
            VIBE_SPACE_RETIREMENT_GRACE_DAYS: undefined,
        });

        expect(config.vibeSpaceCutoverThreshold).toBe(0.95);
        expect(config.vibeSpaceRetirementGraceDays).toBe(7);
        expect(config.vibeSpaceCutoverAllowFailed).toBe(false);
    });

    it.each([
        ["true", true],
        ["false", false],
    ])("parses VIBE_SPACE_CUTOVER_ALLOW_FAILED %s", async (raw, expected) => {
        const { config } = await loadConfigModule({
            VIBE_SPACE_CUTOVER_ALLOW_FAILED: raw,
        });
        expect(config.vibeSpaceCutoverAllowFailed).toBe(expected);
    });

    it.each([
        ["0.5", 0.5],
        ["0.95", 0.95],
        ["1", 1],
    ])("parses VIBE_SPACE_CUTOVER_THRESHOLD %s", async (raw, expected) => {
        const { config } = await loadConfigModule({
            VIBE_SPACE_CUTOVER_THRESHOLD: raw,
        });
        expect(config.vibeSpaceCutoverThreshold).toBe(expected);
    });

    it.each(["", "0.49", "1.01", "NaN", "95%"])(
        "rejects invalid VIBE_SPACE_CUTOVER_THRESHOLD %s",
        async (raw) => {
            await expectStartupValidationFailure(
                { VIBE_SPACE_CUTOVER_THRESHOLD: raw },
                "VIBE_SPACE_CUTOVER_THRESHOLD must be a number from 0.5 through 1",
            );
        },
    );

    it.each([
        ["1", 1],
        ["7", 7],
        ["90", 90],
    ])("parses VIBE_SPACE_RETIREMENT_GRACE_DAYS %s", async (raw, expected) => {
        const { config } = await loadConfigModule({
            VIBE_SPACE_RETIREMENT_GRACE_DAYS: raw,
        });
        expect(config.vibeSpaceRetirementGraceDays).toBe(expected);
    });

    it.each(["", "0", "91", "1.5", "seven"])(
        "rejects invalid VIBE_SPACE_RETIREMENT_GRACE_DAYS %s",
        async (raw) => {
            await expectStartupValidationFailure(
                { VIBE_SPACE_RETIREMENT_GRACE_DAYS: raw },
                "VIBE_SPACE_RETIREMENT_GRACE_DAYS must be an integer from 1 through 90",
            );
        },
    );

    it.each([
        ["http://vibe-provider:8090", "http://vibe-provider:8090"],
        ["http://vibe-provider:8090/", "http://vibe-provider:8090"],
        [
            "https://example.test/internal/vibe/",
            "https://example.test/internal/vibe",
        ],
    ])("normalizes VIBE_PROVIDER_URL %s", async (providerUrl, expected) => {
        const { config } = await loadConfigModule({
            VIBE_PROVIDER_URL: providerUrl,
        });

        expect(config.vibeProviderUrl).toBe(expected);
    });

    it.each([
        "",
        "   ",
        "not-a-url",
        "ftp://provider.test",
        "http://user:pass@host",
        "https://provider.test?tenant=one",
        "https://provider.test#fragment",
    ])("rejects invalid VIBE_PROVIDER_URL %s", async (providerUrl) => {
        await expectStartupValidationFailure(
            { VIBE_PROVIDER_URL: providerUrl },
            "VIBE_PROVIDER_URL must be a valid HTTP(S) URL without credentials",
        );
    });

    it.each([
        "OIDC_ISSUER_URL",
        "OIDC_CLIENT_ID",
        "OIDC_CLIENT_SECRET",
        "OIDC_REDIRECT_URI",
    ])("requires %s when OIDC is enabled", async (missingKey) => {
        await expectStartupValidationFailure(
            {
                ...validOidcEnv(),
                [missingKey]: undefined,
            },
            `${missingKey} is required when OIDC_ENABLED=true`,
        );
    });

    it.each([
        ["OIDC_ISSUER_URL", "not-a-url"],
        ["OIDC_ISSUER_URL", "ftp://idp.example/issuer"],
        ["OIDC_REDIRECT_URI", "not-a-url"],
        ["OIDC_REDIRECT_URI", "ftp://soundspan.example/callback"],
    ])("rejects non-HTTP(S) %s values", async (key, invalidValue) => {
        await expectStartupValidationFailure(
            {
                ...validOidcEnv(),
                [key]: invalidValue,
            },
            `${key} must be a valid HTTP(S) URL`,
        );
    });

    it.each([
        ["https://music.example", "https://music.example"],
        ["https://music.example/", "https://music.example"],
        ["http://localhost:3030/", "http://localhost:3030"],
    ])(
        "normalizes OIDC_WEB_BASE_URL origin %s",
        async (webBaseUrl, expected) => {
            const { config } = await loadConfigModule({
                ...validOidcEnv(),
                OIDC_WEB_BASE_URL: webBaseUrl,
            });

            expect(config.oidc.webBaseUrl).toBe(expected);
        },
    );

    it.each([
        "https://music.example/app",
        "https://music.example/?tenant=one",
        "https://music.example/#login",
        "https:music.example",
        "ftp://music.example",
    ])("rejects non-origin OIDC_WEB_BASE_URL %s", async (webBaseUrl) => {
        await expectStartupValidationFailure(
            {
                ...validOidcEnv(),
                OIDC_WEB_BASE_URL: webBaseUrl,
            },
            "OIDC_WEB_BASE_URL must be a valid HTTP(S) origin with no path, query, or fragment",
        );
    });

    it("rejects OIDC_WEB_BASE_URL when OIDC is disabled", async () => {
        await expectStartupValidationFailure(
            {
                OIDC_ENABLED: "false",
                OIDC_WEB_BASE_URL: "https://music.example",
            },
            "OIDC_WEB_BASE_URL requires OIDC_ENABLED=true",
        );
    });

    it("rejects configurations that disable every login method", async () => {
        await expectStartupValidationFailure(
            {
                LOCAL_LOGIN_ENABLED: "false",
                OIDC_ENABLED: "false",
            },
            "LOCAL_LOGIN_ENABLED=false requires OIDC_ENABLED=true to prevent total lockout",
        );
    });

    it.each([undefined, "", "   "])(
        "requires a non-empty OIDC admin group when role management is enabled",
        async (adminGroup) => {
            await expectStartupValidationFailure(
                {
                    ...validOidcEnv(),
                    OIDC_MANAGE_ROLES: "true",
                    OIDC_ADMIN_GROUP: adminGroup,
                },
                "OIDC_ADMIN_GROUP is required when OIDC_MANAGE_ROLES=true",
            );
        },
    );

    it("rejects OIDC role management when OIDC is disabled", async () => {
        await expectStartupValidationFailure(
            {
                OIDC_ENABLED: "false",
                OIDC_MANAGE_ROLES: "true",
                OIDC_ADMIN_GROUP: "soundspan-admins",
            },
            "OIDC_MANAGE_ROLES=true requires OIDC_ENABLED=true",
        );
    });

    it("constructs DATABASE_URL from percent-encoded PostgreSQL components", async () => {
        const { config } = await loadConfigModule({
            DATABASE_URL: "",
            POSTGRES_HOST: "postgres",
            POSTGRES_PORT: "5432",
            POSTGRES_USER: "user@:/?#% 雪",
            POSTGRES_PASSWORD: "pass@:/?#% 雪",
            POSTGRES_DB: "soundspan",
        });

        expect(config.databaseUrl).toBe(
            "postgresql://user%40%3A%2F%3F%23%25%20%E9%9B%AA:" +
                "pass%40%3A%2F%3F%23%25%20%E9%9B%AA@postgres:5432/soundspan",
        );
    });

    it("preserves an explicit DATABASE_URL unchanged", async () => {
        const explicitDatabaseUrl =
            "postgresql://explicit:raw%2Fvalue@external:6432/custom?schema=tenant";
        const { config } = await loadConfigModule({
            DATABASE_URL: explicitDatabaseUrl,
            POSTGRES_HOST: "postgres",
            POSTGRES_PORT: "5432",
            POSTGRES_USER: "component-user",
            POSTGRES_PASSWORD: "component-password",
            POSTGRES_DB: "soundspan",
        });

        expect(config.databaseUrl).toBe(explicitDatabaseUrl);
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

    it("configures the TCP socket keepalive delay with a safe fallback", async () => {
        const defaults = await loadConfigModule({
            SOCKET_KEEPALIVE_DELAY_MS: undefined,
        });
        expect(defaults.config.socketKeepAliveDelayMs).toBe(30_000);

        const overridden = await loadConfigModule({
            SOCKET_KEEPALIVE_DELAY_MS: "45000",
        });
        expect(overridden.config.socketKeepAliveDelayMs).toBe(45_000);

        const invalid = await loadConfigModule({
            SOCKET_KEEPALIVE_DELAY_MS: "invalid",
        });
        expect(invalid.config.socketKeepAliveDelayMs).toBe(30_000);
    });

    it("falls back for malformed numeric env values", async () => {
        const { config } = await loadConfigModule({
            PORT: "not-a-number",
            TRANSCODE_CACHE_MAX_GB: "invalid-size",
            BROWSE_IMAGE_CACHE_MAX_BYTES: "invalid-size",
            BROWSE_IMAGE_CACHE_MAX_ENTRIES: "0",
        });

        expect(config.port).toBe(3006);
        expect(config.music.transcodeCacheMaxGb).toBe(10);
        expect(config.browseImageCache).toEqual({
            maxBytes: 256 * 1024 * 1024,
            maxEntries: 2048,
        });
    });

    it.each([
        [undefined, 3],
        ["1", 1],
        ["10", 10],
        ["0", 3],
        ["11", 3],
        ["1.5", 3],
        ["not-a-number", 3],
    ])("parses bounded SCAN_FILE_CONCURRENCY %s", async (raw, expected) => {
        const { config } = await loadConfigModule({
            SCAN_FILE_CONCURRENCY: raw,
        });

        expect(config.scanFileConcurrency).toBe(expected);
    });

    it("treats only literal true as an enabled feature flag", async () => {
        const { config } = await loadConfigModule({
            LIDARR_ENABLED: "TRUE",
            LIDARR_URL: "http://lidarr:8686",
            LIDARR_API_KEY: "ignored",
        });

        expect(config.lidarr).toBeUndefined();
    });

    it("configures music requests from bounded environment knobs", async () => {
        const enabled = await loadConfigModule({
            FEATURE_REQUESTS: "false",
            REQUESTS_PER_USER_PER_DAY: "25",
        });
        expect(enabled.config.features.requests).toBe(false);
        expect(enabled.config.requests).toEqual({ dailyCapPerUser: 25 });

        const fallback = await loadConfigModule({
            FEATURE_REQUESTS: undefined,
            REQUESTS_PER_USER_PER_DAY: "0",
        });
        expect(fallback.config.features.requests).toBe(true);
        expect(fallback.config.requests).toEqual({ dailyCapPerUser: 10 });
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

    it("parses metrics access settings with private defaults", async () => {
        const defaults = await loadConfigModule({
            METRICS_TOKEN: undefined,
            METRICS_PUBLIC: undefined,
        });
        expect(defaults.config.metrics).toEqual({
            token: undefined,
            publicAccess: false,
        });

        const configured = await loadConfigModule({
            METRICS_TOKEN: "  scrape-token  ",
            METRICS_PUBLIC: "true",
        });
        expect(configured.config.metrics).toEqual({
            token: "scrape-token",
            publicAccess: true,
        });
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
            LISTEN_TOGETHER_MUTATION_LOCK_RENEW_INTERVAL_MS: undefined,
            LISTEN_TOGETHER_PUBLICATION_DEADLINE_MS: undefined,
            LISTEN_TOGETHER_MUTATION_LOCK_PREFIX: undefined,
            LISTEN_TOGETHER_STATE_SYNC_ENABLED: undefined,
            LISTEN_TOGETHER_STATE_STORE_ENABLED: undefined,
        });

        expect(config.listenTogether).toEqual({
            reconnectSloMs: 5000,
            allowPolling: false,
            redisAdapterEnabled: true,
            mutationLockEnabled: true,
            mutationLockTtlMs: 3000,
            mutationLockRenewIntervalMs: 1000,
            publicationDeadlineMs: 750,
            mutationDrainDeadlineMs: 10_000,
            mutationLockPrefix: "listen-together:mutation-lock",
            stateSyncEnabled: true,
            stateSyncChannel: "listen-together:state-sync",
            stateStoreEnabled: true,
            stateStoreKeyPrefix: "listen-together:state",
            stateStoreTtlSeconds: 21_600,
        });
    });

    it("honors safe Listen Together overrides", async () => {
        const overridden = await loadConfigModule({
            LISTEN_TOGETHER_RECONNECT_SLO_MS: "7500",
            LISTEN_TOGETHER_ALLOW_POLLING: "true",
            LISTEN_TOGETHER_REDIS_ADAPTER_ENABLED: "false",
            LISTEN_TOGETHER_MUTATION_LOCK_ENABLED: "false",
            LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS: "4500",
            LISTEN_TOGETHER_MUTATION_LOCK_RENEW_INTERVAL_MS: "1200",
            LISTEN_TOGETHER_PUBLICATION_DEADLINE_MS: "900",
            LISTEN_TOGETHER_MUTATION_LOCK_PREFIX: "custom-lock",
            LISTEN_TOGETHER_STATE_SYNC_ENABLED: "false",
            LISTEN_TOGETHER_STATE_SYNC_CHANNEL: "custom-sync",
            LISTEN_TOGETHER_STATE_STORE_ENABLED: "false",
            LISTEN_TOGETHER_STATE_STORE_KEY_PREFIX: "custom-state",
            LISTEN_TOGETHER_STATE_STORE_TTL_SECONDS: "10800",
        });
        expect(overridden.config.listenTogether).toEqual({
            reconnectSloMs: 7500,
            allowPolling: true,
            redisAdapterEnabled: false,
            mutationLockEnabled: false,
            mutationLockTtlMs: 4500,
            mutationLockRenewIntervalMs: 1200,
            publicationDeadlineMs: 900,
            mutationDrainDeadlineMs: 10_000,
            mutationLockPrefix: "custom-lock",
            stateSyncEnabled: false,
            stateSyncChannel: "custom-sync",
            stateStoreEnabled: false,
            stateStoreKeyPrefix: "custom-state",
            stateStoreTtlSeconds: 10_800,
        });
    });

    it.each([
        [
            { LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS: "499" },
            "LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS must be an integer greater than or equal to 500",
        ],
        [
            { LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS: "malformed" },
            "LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS must be an integer greater than or equal to 500",
        ],
        [
            {
                LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS: "3000",
                LISTEN_TOGETHER_MUTATION_LOCK_RENEW_INTERVAL_MS: "1001",
            },
            "LISTEN_TOGETHER_MUTATION_LOCK_RENEW_INTERVAL_MS must be at most one third of LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS",
        ],
        [
            {
                LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS: "500",
                LISTEN_TOGETHER_PUBLICATION_DEADLINE_MS: "500",
            },
            "LISTEN_TOGETHER_PUBLICATION_DEADLINE_MS must be less than LISTEN_TOGETHER_MUTATION_LOCK_TTL_MS",
        ],
        [
            { LISTEN_TOGETHER_PUBLICATION_DEADLINE_MS: "0" },
            "LISTEN_TOGETHER_PUBLICATION_DEADLINE_MS",
        ],
    ])(
        "rejects unsafe Listen Together timing %#",
        async (overrides, message) => {
            await expectStartupValidationFailure(overrides, message);
        },
    );

    it("rejects state sync without the authoritative Redis state store", async () => {
        await expectStartupValidationFailure(
            {
                LISTEN_TOGETHER_STATE_SYNC_ENABLED: "true",
                LISTEN_TOGETHER_STATE_STORE_ENABLED: "false",
            },
            "LISTEN_TOGETHER_STATE_SYNC_ENABLED=true requires LISTEN_TOGETHER_STATE_STORE_ENABLED=true; valid combinations are sync=true/store=true, sync=false/store=true, or sync=false/store=false",
        );
    });

    it("exposes migrated route, integration, logging, and worker values", async () => {
        const { config } = await loadConfigModule({
            npm_package_version: "2.0.0-test",
            DEBUG_WEBHOOKS: "true",
            PODCAST_DEBUG: "1",
            SUBSONIC_TRACE_LOGS: "true",
            SOUNDSPAN_CALLBACK_URL: "http://soundspan-api:3006",
            FANART_API_KEY: "fanart-fixture",
            AUDIOBOOKSHELF_URL: "http://audiobookshelf:13378",
            AUDIOBOOKSHELF_API_KEY: "audiobookshelf-fixture",
            PLAYLIST_LOG_DIR: "/tmp/playlist-logs",
            MOOD_BUCKET_CLAIM_TTL_MS: "120001",
            ENRICHMENT_CLAIM_TTL_MS: "900001",
            TRACK_RECONCILIATION_MAX_ROWS: "10001",
            TRACK_RECONCILIATION_TIMEOUT_MS: "600001",
            PROVIDER_TRACK_RETENTION_DAYS: "45",
            FEDERATION_ENABLED: "true",
            FEDERATION_ALLOW_PRIVATE_PEERS: "true",
            FEDERATION_ALLOW_PROXY: "true",
            FEDERATION_TOMBSTONE_RETENTION_DAYS: "30",
            FEDERATION_SYNC_INTERVAL_MINUTES: "7",
        });

        expect(config.appVersion).toBe("2.0.0-test");
        expect(config.debugWebhooks).toBe(true);
        expect(config.podcastDebug).toBe(true);
        expect(config.subsonicTraceLogs).toBe(true);
        expect(config.soundspanCallbackUrl).toBe("http://soundspan-api:3006");
        expect(config.fanart.apiKey).toBe("fanart-fixture");
        expect(config.audiobookshelfEnv).toEqual({
            url: "http://audiobookshelf:13378",
            apiKey: "audiobookshelf-fixture",
        });
        expect(config.playlistLogDir).toBe("/tmp/playlist-logs");
        expect(config.workers).toEqual({
            moodBucketClaimTtlMs: 120_001,
            schedulerClaimSkipWarnThreshold: 3,
            enrichmentClaimTtlMs: 900_001,
            trackReconciliationMaxRows: 10_001,
            trackReconciliationTimeoutMs: 600_001,
            providerTrackRetentionDays: 45,
            trackRemovalRetentionDays: 90,
            federationTombstoneRetentionDays: 30,
            federationSyncIntervalMinutes: 7,
        });
        expect(config.features.federation).toBe(true);
        expect(config.federation.allowPrivatePeers).toBe(true);
        expect(config.federation.allowProxy).toBe(true);
    });

    it("rejects an ambiguous private-federation boolean", async () => {
        await expectStartupValidationFailure(
            { FEDERATION_ALLOW_PRIVATE_PEERS: "yes" },
            "FEDERATION_ALLOW_PRIVATE_PEERS",
        );
    });

    it("preserves migrated value defaults and literal flag parsing", async () => {
        const { config } = await loadConfigModule({
            npm_package_version: undefined,
            DEBUG_WEBHOOKS: "TRUE",
            PODCAST_DEBUG: "true",
            SUBSONIC_TRACE_LOGS: "1",
            SOUNDSPAN_CALLBACK_URL: undefined,
            FANART_API_KEY: undefined,
            AUDIOBOOKSHELF_URL: undefined,
            AUDIOBOOKSHELF_API_KEY: undefined,
            PLAYLIST_LOG_DIR: "",
            MOOD_BUCKET_CLAIM_TTL_MS: "invalid",
            ENRICHMENT_CLAIM_TTL_MS: "0",
            TRACK_RECONCILIATION_MAX_ROWS: "100001",
            TRACK_RECONCILIATION_TIMEOUT_MS: "3600001",
        });

        expect(config.appVersion).toBe("unknown");
        expect(config.debugWebhooks).toBe(false);
        expect(config.podcastDebug).toBe(false);
        expect(config.subsonicTraceLogs).toBe(false);
        expect(config.soundspanCallbackUrl).toBe("http://backend:3006");
        expect(config.fanart.apiKey).toBeUndefined();
        expect(config.audiobookshelfEnv).toEqual({ url: "", apiKey: "" });
        expect(config.playlistLogDir).toBeUndefined();
        expect(config.workers).toEqual({
            moodBucketClaimTtlMs: 120_000,
            schedulerClaimSkipWarnThreshold: 3,
            enrichmentClaimTtlMs: 900_000,
            trackReconciliationMaxRows: 10_000,
            trackReconciliationTimeoutMs: 10 * 60 * 1000,
            providerTrackRetentionDays: 30,
            trackRemovalRetentionDays: 90,
            federationTombstoneRetentionDays: 90,
            federationSyncIntervalMinutes: 15,
        });
    });

    it("keeps request-time config accessors lazy", async () => {
        const { config } = await loadConfigModule({
            DEBUG_WEBHOOKS: "false",
            PODCAST_DEBUG: "0",
            SOUNDSPAN_CALLBACK_URL: "http://initial:3006",
            FANART_API_KEY: "initial-fanart",
        });

        process.env.DEBUG_WEBHOOKS = "true";
        process.env.PODCAST_DEBUG = "1";
        process.env.SOUNDSPAN_CALLBACK_URL = "http://updated:3006";
        process.env.FANART_API_KEY = "updated-fanart";

        expect(config.debugWebhooks).toBe(true);
        expect(config.podcastDebug).toBe(true);
        expect(config.soundspanCallbackUrl).toBe("http://updated:3006");
        expect(config.fanart.apiKey).toBe("updated-fanart");
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

    it("uses the streaming ffmpeg default and honors an override", async () => {
        const defaults = await loadConfigModule({ FFMPEG_PATH: undefined });
        expect(defaults.config.streaming.ffmpegPathOverride).toBeUndefined();
        expect(defaults.config.streaming.traceEnabled).toBe(false);

        const overridden = await loadConfigModule({
            FFMPEG_PATH: " /usr/local/bin/ffmpeg ",
        });
        expect(overridden.config.streaming.ffmpegPathOverride).toBe(
            "/usr/local/bin/ffmpeg",
        );
    });

    it.each(["1", "true", "yes", "on"])(
        "enables streaming trace logs for STREAMING_TRACE_LOGS=%s",
        async (value) => {
            const { config } = await loadConfigModule({
                STREAMING_TRACE_LOGS: value,
            });
            expect(config.streaming.traceEnabled).toBe(true);
        },
    );

    it("does not enable tracing from the removed trace alias", async () => {
        const { config } = await loadConfigModule({
            STREAMING_TRACE_LOGS: undefined,
            SEGMENTED_STREAMING_TRACE_LOGS: "true",
        });

        expect(config.streaming.traceEnabled).toBe(false);
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

    it("accepts the three-day federation tombstone floor and rejects lower values", async () => {
        const minimum = await loadConfigModule({
            FEDERATION_TOMBSTONE_RETENTION_DAYS: "3",
        });
        expect(minimum.config.workers.federationTombstoneRetentionDays).toBe(3);

        const exitSpy = jest.spyOn(process, "exit").mockImplementation(((
            code?: number,
        ) => {
            throw new Error(`process.exit:${code}`);
        }) as never);
        await expect(
            loadConfigModule({ FEDERATION_TOMBSTONE_RETENTION_DAYS: "2" }),
        ).rejects.toThrow("process.exit:1");
        exitSpy.mockRestore();
    });

    it("bounds provider-track retention days", async () => {
        const minimum = await loadConfigModule({
            PROVIDER_TRACK_RETENTION_DAYS: "1",
        });
        expect(minimum.config.workers.providerTrackRetentionDays).toBe(1);
        const maximum = await loadConfigModule({
            PROVIDER_TRACK_RETENTION_DAYS: "3650",
        });
        expect(maximum.config.workers.providerTrackRetentionDays).toBe(3650);

        await expectStartupValidationFailure(
            { PROVIDER_TRACK_RETENTION_DAYS: "0" },
            "PROVIDER_TRACK_RETENTION_DAYS",
        );
        await expectStartupValidationFailure(
            { PROVIDER_TRACK_RETENTION_DAYS: "3651" },
            "PROVIDER_TRACK_RETENTION_DAYS",
        );
    });

    it("logs and exits when post-schema encryption validation throws", async () => {
        mockValidateEncryptionKey.mockImplementationOnce(() => {
            throw new Error("encryption validation failed");
        });
        const exitSpy = jest.spyOn(process, "exit").mockImplementation(((
            code?: number,
        ) => {
            throw new Error(`process.exit:${code}`);
        }) as never);

        await expect(loadConfigModule()).rejects.toThrow("process.exit:1");
        expect(mockLoggerError).toHaveBeenCalledWith(
            " Environment validation failed:",
            expect.any(Error),
        );

        exitSpy.mockRestore();
    });

    it("requires a positive federation sync interval", async () => {
        const one = await loadConfigModule({
            FEDERATION_SYNC_INTERVAL_MINUTES: "1",
        });
        expect(one.config.workers.federationSyncIntervalMinutes).toBe(1);

        const exitSpy = jest.spyOn(process, "exit").mockImplementation(((
            code?: number,
        ) => {
            throw new Error(`process.exit:${code}`);
        }) as never);
        await expect(
            loadConfigModule({ FEDERATION_SYNC_INTERVAL_MINUTES: "0" }),
        ).rejects.toThrow("process.exit:1");
        exitSpy.mockRestore();
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
                POSTGRES_HOST: undefined,
                POSTGRES_PORT: undefined,
                POSTGRES_USER: undefined,
                POSTGRES_PASSWORD: undefined,
                POSTGRES_DB: undefined,
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
