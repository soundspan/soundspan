import * as path from "path";

describe("playlist logger utilities", () => {
    const originalEnv = process.env;

    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadPlaylistLoggerModule(options?: {
        playlistLogDir?: string | null;
    }) {
        jest.resetModules();
        process.env = { ...originalEnv };

        if (options?.playlistLogDir === null) {
            delete process.env.PLAYLIST_LOG_DIR;
        } else {
            process.env.PLAYLIST_LOG_DIR =
                options?.playlistLogDir ?? "/tmp/playlist-logger-tests";
        }

        const mkdirSync = jest.fn();
        const writeFileSync = jest.fn();
        const appendFileSync = jest.fn();
        const existsSync = jest.fn();
        const readFileSync = jest.fn();

        const logger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };

        jest.doMock("fs", () => ({
            mkdirSync,
            writeFileSync,
            appendFileSync,
            existsSync,
            readFileSync,
        }));
        jest.doMock("../logger", () => ({
            logger,
        }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require("../playlistLogger") as typeof import("../playlistLogger");

        return {
            mod,
            mkdirSync,
            writeFileSync,
            appendFileSync,
            existsSync,
            readFileSync,
            logger,
        };
    }

    function getAppendedContent(appendFileSync: jest.Mock, filePath: string): string {
        return appendFileSync.mock.calls
            .filter((call: unknown[]) => call[0] === filePath)
            .map((call: unknown[]) => String(call[1]))
            .join("");
    }

    it("resolves session log path from env override and cwd fallback", () => {
        const customDir = "/tmp/playlist-logger-custom";
        const custom = loadPlaylistLoggerModule({ playlistLogDir: customDir });

        expect(custom.mod.getSessionLogPath()).toBe(
            path.join(path.resolve(customDir), "session.log")
        );
        expect(custom.mkdirSync).toHaveBeenCalledWith(path.resolve(customDir), {
            recursive: true,
        });

        const fallback = loadPlaylistLoggerModule({ playlistLogDir: null });
        expect(fallback.mod.getSessionLogPath()).toBe(
            path.join(process.cwd(), "logs", "playlists", "session.log")
        );
    });

    it("reads session log content and handles missing or failed reads", () => {
        const existing = loadPlaylistLoggerModule();
        existing.existsSync.mockReturnValue(true);
        existing.readFileSync.mockReturnValue("session log text");

        const sessionPath = existing.mod.getSessionLogPath();
        expect(existing.mod.readSessionLog()).toBe("session log text");
        expect(existing.readFileSync).toHaveBeenCalledWith(sessionPath, "utf-8");

        const missing = loadPlaylistLoggerModule();
        missing.existsSync.mockReturnValue(false);
        expect(missing.mod.readSessionLog()).toBe("No session log found");

        const failedRead = loadPlaylistLoggerModule();
        failedRead.existsSync.mockReturnValue(true);
        failedRead.readFileSync.mockImplementation(() => {
            throw new Error("cannot read log file");
        });

        const errorMessage = failedRead.mod.readSessionLog();
        expect(errorMessage).toContain("Error reading session log:");
        expect(errorMessage).toContain("cannot read log file");
    });

    it("initializes session once and routes INFO/ERROR session logs", () => {
        const logDir = "/tmp/playlist-logger-session";
        const { mod, writeFileSync, appendFileSync, logger } =
            loadPlaylistLoggerModule({ playlistLogDir: logDir });
        const sessionPath = path.join(path.resolve(logDir), "session.log");

        mod.sessionLog("SLSKD", "ready");
        mod.sessionLog("SLSKD", "still ready");
        mod.sessionLog("IMPORT", "failed", "ERROR");

        expect(writeFileSync).toHaveBeenCalledTimes(1);
        expect(writeFileSync).toHaveBeenCalledWith(
            sessionPath,
            expect.stringContaining("SPOTIFY IMPORT SESSION LOG")
        );
        expect(appendFileSync).toHaveBeenCalledWith(
            sessionPath,
            expect.stringContaining("[SLSKD] [INFO] ready")
        );
        expect(appendFileSync).toHaveBeenCalledWith(
            sessionPath,
            expect.stringContaining("[IMPORT] [ERROR] failed")
        );
        expect(logger.debug).toHaveBeenCalledWith("[SLSKD]", "ready");
        expect(logger.error).toHaveBeenCalledWith("[IMPORT]", "failed");
    });

    it("logs session header initialization failures and swallows append failures", () => {
        const { mod, writeFileSync, appendFileSync, logger } = loadPlaylistLoggerModule();

        const initError = new Error("read-only filesystem");
        writeFileSync.mockImplementation(() => {
            throw initError;
        });
        appendFileSync.mockImplementation(() => {
            throw new Error("append failed");
        });

        expect(() => mod.sessionLog("IMPORT", "startup")).not.toThrow();
        expect(logger.error).toHaveBeenCalledWith(
            "Failed to initialize session log:",
            initError
        );
        expect(logger.debug).toHaveBeenCalledWith("[IMPORT]", "startup");
    });

    it("writes structured lifecycle messages to per-job logs", () => {
        const { mod, appendFileSync } = loadPlaylistLoggerModule({
            playlistLogDir: "/tmp/playlist-logger-structured",
        });

        const playlistLogger = mod.createPlaylistLogger("job-42");
        const logFile = playlistLogger.getLogFilePath();

        playlistLogger.logJobStart("Road Trip", 2, "user-1");
        playlistLogger.logTrackMatchingStart();
        playlistLogger.logTrackMatch(1, 2, "Song A", "Artist A", true, "track-1");
        playlistLogger.logTrackMatch(2, 2, "Song B", "Artist B", false);
        playlistLogger.logAlbumDownloadStart(2);
        playlistLogger.logAlbumQueued("Album A", "Artist A", "mbid-1", 123);
        playlistLogger.logAlbumQueued("Album B", "Artist B", "mbid-2");
        playlistLogger.logAlbumFailed("Album C", "Artist C", "timeout");
        playlistLogger.logSlskdFallbackStart("Album C", "Artist C");
        playlistLogger.logSlskdSearchResult(true, "FLAC", "peer1", 10, 320);
        playlistLogger.logSlskdSearchResult(false);
        playlistLogger.logSlskdDownloadQueued(8, "peer1");
        playlistLogger.logSlskdDownloadFailed("network error");
        playlistLogger.logDownloadProgress(4, 1, 3);
        playlistLogger.logPlaylistCreationStart();
        playlistLogger.logPlaylistCreated("playlist-7", 4, 5);
        playlistLogger.logJobComplete(4, 5, null);
        playlistLogger.logJobComplete(4, 5, "playlist-7");
        playlistLogger.logJobFailed("fatal");
        playlistLogger.warn("warning line");
        playlistLogger.debug("debug line");
        playlistLogger.error("error line");
        playlistLogger.log("alias line");

        expect(path.basename(logFile)).toMatch(/^import_job-42_.*\.log$/);

        const content = getAppendedContent(appendFileSync, logFile);
        expect(content).toContain('Playlist: "Road Trip" (2 tracks)');
        expect(content).toContain("MATCHED -> track-1");
        expect(content).toContain("NOT FOUND");
        expect(content).toContain("Lidarr ID: 123");
        expect(content).toContain("Soulseek match: FLAC from peer1");
        expect(content).toContain("Soulseek: No suitable results found");
        expect(content).toContain("Tracks added: 4/5");
        expect(content).toContain("Playlist ID: playlist-7");
        expect(content).toContain("=== JOB FAILED ===");
        expect(content).toContain("alias line");
    });

    it("logs directory and append failures for job and events files", () => {
        const logDir = "/tmp/playlist-logger-errors";
        const { mod, mkdirSync, appendFileSync, logger } = loadPlaylistLoggerModule({
            playlistLogDir: logDir,
        });

        const mkdirError = new Error("permission denied");
        mkdirSync.mockImplementation(() => {
            throw mkdirError;
        });
        mod.getSessionLogPath();
        expect(logger.error).toHaveBeenCalledWith(
            "Failed to create playlist logs directory:",
            expect.objectContaining({
                logsDir: path.resolve(logDir),
                error: mkdirError,
            })
        );

        appendFileSync.mockReset();
        const playlistLogger = mod.createPlaylistLogger("job-fail");
        const logFile = playlistLogger.getLogFilePath();
        const fileWriteError = new Error("disk full");
        appendFileSync.mockImplementation((targetPath: unknown) => {
            if (targetPath === logFile) {
                throw fileWriteError;
            }
        });

        playlistLogger.info("this write should fail");
        expect(logger.error).toHaveBeenCalledWith(
            `[Playlist Logger] Failed to write to ${logFile}:`,
            fileWriteError
        );

        const eventsFile = path.join(path.resolve(logDir), "events.log");
        const eventsWriteError = new Error("events file locked");
        appendFileSync.mockImplementation((targetPath: unknown) => {
            if (targetPath === eventsFile) {
                throw eventsWriteError;
            }
        });

        mod.logPlaylistEvent("one-off event");
        expect(logger.debug).toHaveBeenCalledWith("[Playlist] one-off event");
        expect(logger.error).toHaveBeenCalledWith(
            "Failed to write to events log:",
            eventsWriteError
        );
    });

    it("writes one-off playlist events to the events log", () => {
        const logDir = "/tmp/playlist-logger-events";
        const { mod, appendFileSync, logger } = loadPlaylistLoggerModule({
            playlistLogDir: logDir,
        });
        const eventsFile = path.join(path.resolve(logDir), "events.log");

        mod.logPlaylistEvent("queued import");

        expect(appendFileSync).toHaveBeenCalledWith(
            eventsFile,
            expect.stringContaining("[INFO] queued import")
        );
        expect(logger.debug).toHaveBeenCalledWith("[Playlist] queued import");
    });
});
