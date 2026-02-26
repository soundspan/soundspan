import { ErrorCategory, ErrorCode } from "../errors";

type Settings = {
    musicPath?: string;
    transcodeCacheMaxGb?: number;
} | null;

type LoadOptions = {
    env?: Record<string, string | undefined>;
    settings?: Settings;
    existingPaths?: string[];
    missingPaths?: string[];
    unreadablePaths?: string[];
    unwritablePaths?: string[];
    mkdirError?: string;
    execOutput?: string;
    execError?: string;
    ffmpegPath?: string;
};

type ValidatorModule = {
    validateMusicConfig: () => Promise<{
        musicPath: string;
        transcodeCachePath: string;
        transcodeCacheMaxGb: number;
    }>;
};

describe("validateMusicConfig", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadValidator(options: LoadOptions = {}) {
        const baseEnv = { ...originalEnv };
        delete baseEnv.MUSIC_PATH;
        delete baseEnv.TRANSCODE_CACHE_PATH;
        delete baseEnv.TRANSCODE_CACHE_MAX_GB;
        delete baseEnv.NODE_ENV;

        process.env = {
            ...baseEnv,
            TRANSCODE_CACHE_PATH: "/cache/transcodes",
            TRANSCODE_CACHE_MAX_GB: "10",
            ...options.env,
        };

        const ffmpegPath = options.ffmpegPath ?? "/bin/ffmpeg";
        const existingPaths = new Set<string>([
            "/music",
            "/cache/transcodes",
            ffmpegPath,
            ...(options.existingPaths ?? []),
        ]);
        const missingPaths = new Set<string>(options.missingPaths ?? []);
        const unreadablePaths = new Set<string>(options.unreadablePaths ?? []);
        const unwritablePaths = new Set<string>(options.unwritablePaths ?? []);
        const createdPaths = new Set<string>();

        const existsSync = jest.fn((candidate: unknown) => {
            const target = String(candidate);
            if (missingPaths.has(target)) {
                return false;
            }
            return createdPaths.has(target) || existingPaths.has(target);
        });
        const accessSync = jest.fn((candidate: unknown, mode?: number) => {
            const target = String(candidate);
            if (mode === 4 && unreadablePaths.has(target)) {
                throw new Error("EACCES");
            }
            if (mode === 2 && unwritablePaths.has(target)) {
                throw new Error("EACCES");
            }
        });
        const mkdirSync = jest.fn((candidate: unknown) => {
            if (options.mkdirError) {
                throw new Error(options.mkdirError);
            }
            createdPaths.add(String(candidate));
        });
        const execSync = jest.fn(() => {
            if (options.execError) {
                throw new Error(options.execError);
            }
            return options.execOutput ?? "ffmpeg version 7.0";
        });
        const getSystemSettings = jest
            .fn()
            .mockResolvedValue(options.settings ?? null);
        const logger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };

        jest.doMock("fs", () => ({
            existsSync,
            accessSync,
            mkdirSync,
            constants: { R_OK: 4, W_OK: 2 },
        }));
        jest.doMock("child_process", () => ({
            execSync,
        }));
        jest.doMock("@ffmpeg-installer/ffmpeg", () => ({
            __esModule: true,
            default: { path: ffmpegPath },
        }));
        jest.doMock("../systemSettings", () => ({
            getSystemSettings,
        }));
        jest.doMock("../logger", () => ({
            logger,
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { validateMusicConfig } = require("../configValidator") as ValidatorModule;

        return {
            validateMusicConfig,
            existsSync,
            accessSync,
            mkdirSync,
            execSync,
            getSystemSettings,
            logger,
            ffmpegPath,
        };
    }

    it("prefers MUSIC_PATH env over database settings path", async () => {
        const { validateMusicConfig, getSystemSettings, logger } = loadValidator({
            env: { MUSIC_PATH: "/env/music" },
            settings: { musicPath: "/settings/music", transcodeCacheMaxGb: 8 },
            existingPaths: ["/env/music"],
        });

        const result = await validateMusicConfig();

        expect(getSystemSettings).toHaveBeenCalledTimes(1);
        expect(result.musicPath).toBe("/env/music");
        expect(result.transcodeCacheMaxGb).toBe(8);
        expect(logger.debug).toHaveBeenCalledWith(
            "Database has musicPath=/settings/music, using /env/music from env/default"
        );
    });

    it("falls back to /music inside Docker when configured path is missing", async () => {
        const { validateMusicConfig, logger } = loadValidator({
            env: { MUSIC_PATH: "/host/music" },
            settings: { musicPath: "/db/music" },
            existingPaths: ["/.dockerenv"],
            missingPaths: ["/host/music"],
        });

        const result = await validateMusicConfig();

        expect(result.musicPath).toBe("/music");
        expect(logger.warn).toHaveBeenCalledWith(
            "MUSIC_PATH=/host/music not found in container, using /music (Docker mount point)"
        );
    });

    it("throws AppError when music path is missing", async () => {
        const { validateMusicConfig } = loadValidator({
            env: { MUSIC_PATH: "/missing/music" },
            missingPaths: ["/missing/music"],
        });

        await expect(validateMusicConfig()).rejects.toMatchObject({
            name: "AppError",
            code: ErrorCode.MUSIC_PATH_NOT_ACCESSIBLE,
            category: ErrorCategory.FATAL,
            message: expect.stringContaining(
                "Music path does not exist: /missing/music"
            ),
        });
    });

    it("throws AppError when music path is unreadable", async () => {
        const { validateMusicConfig } = loadValidator({
            env: { MUSIC_PATH: "/restricted/music" },
            existingPaths: ["/restricted/music"],
            unreadablePaths: ["/restricted/music"],
        });

        await expect(validateMusicConfig()).rejects.toMatchObject({
            name: "AppError",
            code: ErrorCode.MUSIC_PATH_NOT_ACCESSIBLE,
            category: ErrorCategory.FATAL,
            message: "Music path not readable: /restricted/music. Check file permissions.",
        });
    });

    it("creates transcode cache directory when it does not exist", async () => {
        const { validateMusicConfig, mkdirSync, logger } = loadValidator({
            env: {
                MUSIC_PATH: "/env/music",
                TRANSCODE_CACHE_PATH: "/cache/new-transcodes",
            },
            existingPaths: ["/env/music"],
        });

        const result = await validateMusicConfig();

        expect(mkdirSync).toHaveBeenCalledWith("/cache/new-transcodes", {
            recursive: true,
        });
        expect(logger.debug).toHaveBeenCalledWith(
            "Created transcode cache directory: /cache/new-transcodes"
        );
        expect(result.transcodeCachePath).toBe("/cache/new-transcodes");
    });

    it("throws AppError when transcode cache directory creation fails", async () => {
        const { validateMusicConfig } = loadValidator({
            env: {
                MUSIC_PATH: "/env/music",
                TRANSCODE_CACHE_PATH: "/cache/create-fails",
            },
            existingPaths: ["/env/music"],
            mkdirError: "mkdir denied",
        });

        await expect(validateMusicConfig()).rejects.toMatchObject({
            name: "AppError",
            code: ErrorCode.TRANSCODE_CACHE_NOT_WRITABLE,
            category: ErrorCategory.FATAL,
            message: "Cannot create transcode cache directory: /cache/create-fails",
            details: {
                originalError: "mkdir denied",
            },
        });
    });

    it("throws AppError when transcode cache path is not writable", async () => {
        const { validateMusicConfig } = loadValidator({
            env: {
                MUSIC_PATH: "/env/music",
                TRANSCODE_CACHE_PATH: "/cache/unwritable",
            },
            existingPaths: ["/env/music", "/cache/unwritable"],
            unwritablePaths: ["/cache/unwritable"],
        });

        await expect(validateMusicConfig()).rejects.toMatchObject({
            name: "AppError",
            code: ErrorCode.TRANSCODE_CACHE_NOT_WRITABLE,
            category: ErrorCategory.FATAL,
            message: "Transcode cache not writable: /cache/unwritable. Check file permissions.",
        });
    });

    it("throws AppError for invalid transcodeCacheMaxGb", async () => {
        const { validateMusicConfig } = loadValidator({
            env: {
                MUSIC_PATH: "/env/music",
                TRANSCODE_CACHE_MAX_GB: "0",
            },
            existingPaths: ["/env/music"],
        });

        await expect(validateMusicConfig()).rejects.toMatchObject({
            name: "AppError",
            code: ErrorCode.INVALID_CONFIG,
            category: ErrorCategory.FATAL,
            message: "Invalid transcode cache size: must be a positive integer. Got: 0",
        });
    });

    it("throws AppError for non-numeric transcodeCacheMaxGb", async () => {
        const { validateMusicConfig } = loadValidator({
            env: {
                MUSIC_PATH: "/env/music",
                TRANSCODE_CACHE_MAX_GB: "abc",
            },
            existingPaths: ["/env/music"],
        });

        await expect(validateMusicConfig()).rejects.toMatchObject({
            name: "AppError",
            code: ErrorCode.INVALID_CONFIG,
            category: ErrorCategory.FATAL,
            message: "Invalid transcode cache size: must be a positive integer. Got: NaN",
        });
    });

    it("logs warning and continues when bundled ffmpeg is missing", async () => {
        const { validateMusicConfig, execSync, logger, ffmpegPath } = loadValidator({
            env: { MUSIC_PATH: "/env/music" },
            existingPaths: ["/env/music"],
            missingPaths: ["/bin/ffmpeg"],
        });

        const result = await validateMusicConfig();

        expect(result.musicPath).toBe("/env/music");
        expect(execSync).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            "  Bundled FFmpeg not available. Transcoding will not be available."
        );
        expect(logger.warn).toHaveBeenCalledWith(
            `   Error: Bundled FFmpeg not found at: ${ffmpegPath}`
        );
    });

    it("logs warning and continues when ffmpeg output is invalid", async () => {
        const { validateMusicConfig, execSync, logger } = loadValidator({
            env: { MUSIC_PATH: "/env/music" },
            existingPaths: ["/env/music"],
            execOutput: "not-ffmpeg",
        });

        const result = await validateMusicConfig();

        expect(result.musicPath).toBe("/env/music");
        expect(execSync).toHaveBeenCalledWith('"/bin/ffmpeg" -version', {
            encoding: "utf8",
        });
        expect(logger.warn).toHaveBeenCalledWith(
            "  Bundled FFmpeg not available. Transcoding will not be available."
        );
        expect(logger.warn).toHaveBeenCalledWith("   Error: Invalid ffmpeg output");
    });

    it("returns validated configuration when all checks pass", async () => {
        const { validateMusicConfig, logger } = loadValidator({
            env: { TRANSCODE_CACHE_PATH: "/cache/custom" },
            settings: { musicPath: "/settings/music", transcodeCacheMaxGb: 25 },
            existingPaths: ["/settings/music", "/cache/custom"],
            execOutput: "ffmpeg version 6.1\nconfiguration",
        });

        await expect(validateMusicConfig()).resolves.toEqual({
            musicPath: "/settings/music",
            transcodeCachePath: "/cache/custom",
            transcodeCacheMaxGb: 25,
        });
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(
            "Music configuration validated successfully"
        );
    });
});
