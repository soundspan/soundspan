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
    validateMusicConfig: (...args: unknown[]) => mockValidateMusicConfig(...args),
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
            MUSIC_PATH: "/music",
        };
    }

    async function loadConfigModule(
        overrides: Record<string, string | undefined> = {}
    ) {
        jest.resetModules();
        jest.clearAllMocks();

        const nextEnv: Record<string, string> = {
            ...requiredEnv(),
            ...Object.fromEntries(
                Object.entries(overrides).filter(
                    ([, value]) => value !== undefined
                ) as Array<[string, string]>
            ),
        };

        Object.entries(overrides).forEach(([key, value]) => {
            if (value === undefined) {
                delete nextEnv[key];
            }
        });

        process.env = { ...originalEnv, ...nextEnv };
        return import("../config");
    }

    afterAll(() => {
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
            AUDIOBOOKSHELF_TOKEN: "abs-token",
            ALLOWED_ORIGINS: "https://app.example, http://localhost:5173 ",
        });

        expect(mockDotenvConfig).toHaveBeenCalledTimes(1);
        expect(mockLoggerDebug).toHaveBeenCalledWith(
            "Environment variables validated"
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
            token: "abs-token",
        });
        expect(config.allowedOrigins).toEqual([
            "https://app.example",
            "http://localhost:5173",
        ]);
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
    });

    it("logs validation errors and exits for invalid environment variables", async () => {
        const exitSpy = jest
            .spyOn(process, "exit")
            .mockImplementation(((code?: number) => {
                throw new Error(`process.exit:${code}`);
            }) as never);

        await expect(
            loadConfigModule({
                DATABASE_URL: undefined,
            })
        ).rejects.toThrow("process.exit:1");

        expect(mockLoggerError).toHaveBeenCalledWith(
            " Environment validation failed:"
        );
        expect(
            mockLoggerError.mock.calls.some(
                (call) =>
                    typeof call[0] === "string" &&
                    call[0].includes("DATABASE_URL")
            )
        ).toBe(true);
        expect(mockLoggerError).toHaveBeenCalledWith(
            "\n Please check your .env file and ensure all required variables are set."
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
            "Music configuration initialized"
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
            "bad config"
        );
        expect(mockLoggerWarn).toHaveBeenCalledWith(
            "   Using default/environment configuration"
        );
    });
});
