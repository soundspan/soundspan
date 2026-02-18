import * as path from "path";

describe("discoveryLogger", () => {
    const originalEnv = process.env;
    const fixedNow = new Date("2026-01-15T10:11:12.345Z");

    afterEach(() => {
        process.env = originalEnv;
        jest.useRealTimers();
        jest.resetModules();
        jest.clearAllMocks();
    });

    function loadDiscoveryLoggerModule(options?: { nodeEnv?: string }) {
        jest.resetModules();
        process.env = { ...originalEnv };

        if (options?.nodeEnv) {
            process.env.NODE_ENV = options.nodeEnv;
        }

        jest.useFakeTimers();
        jest.setSystemTime(fixedNow);

        const existsSync = jest.fn();
        const mkdirSync = jest.fn();
        const readdirSync = jest.fn();
        const readFileSync = jest.fn();
        const statSync = jest.fn();
        const unlinkSync = jest.fn();
        const streamWrite = jest.fn();
        const streamEnd = jest.fn();
        const createWriteStream = jest.fn().mockReturnValue({
            write: streamWrite,
            end: streamEnd,
        });

        const logger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };

        jest.doMock("fs", () => ({
            existsSync,
            mkdirSync,
            readdirSync,
            readFileSync,
            statSync,
            unlinkSync,
            createWriteStream,
        }));

        jest.doMock("../../utils/logger", () => ({ logger }));

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require("../discoveryLogger") as typeof import("../discoveryLogger");

        return {
            mod,
            existsSync,
            mkdirSync,
            readdirSync,
            readFileSync,
            statSync,
            unlinkSync,
            createWriteStream,
            streamWrite,
            streamEnd,
            logger,
        };
    }

    it("starts a local log file, creates the directory, and writes timestamped output", () => {
        const {
            mod,
            existsSync,
            mkdirSync,
            createWriteStream,
            streamWrite,
            logger,
        } = loadDiscoveryLoggerModule({ nodeEnv: "test" });

        existsSync.mockReturnValue(false);

        const expectedPath = path.join(
            process.cwd(),
            "data",
            "logs",
            "discovery",
            "discovery-2026-01-15T10-11-12-345Z-jobmanual.log"
        );

        const logPath = mod.discoveryLogger.start("user-1");

        expect(logPath).toBe(expectedPath);
        expect(mod.discoveryLogger.getCurrentLogPath()).toBe(expectedPath);
        expect(mkdirSync).toHaveBeenCalledWith(
            path.join(process.cwd(), "data", "logs", "discovery"),
            { recursive: true }
        );
        expect(createWriteStream).toHaveBeenCalledWith(expectedPath, {
            flags: "a",
        });
        expect(logger.debug).toHaveBeenCalledWith("Job ID: manual");

        mod.discoveryLogger.write("nested message", 2);

        expect(streamWrite).toHaveBeenLastCalledWith("[10:11:12]     nested message\n");
        expect(logger.debug).toHaveBeenCalledWith("nested message");
    });

    it("uses production log directory and includes the numeric job id in the filename", () => {
        const { mod, existsSync, mkdirSync, createWriteStream } =
            loadDiscoveryLoggerModule({ nodeEnv: "production" });

        existsSync.mockReturnValue(true);

        const logPath = mod.discoveryLogger.start("user-2", 77);

        expect(logPath).toBe(
            "/app/logs/discovery/discovery-2026-01-15T10-11-12-345Z-job77.log"
        );
        expect(mkdirSync).not.toHaveBeenCalled();
        expect(createWriteStream).toHaveBeenCalledWith(logPath, { flags: "a" });
    });

    it("writes section and convenience helper messages with expected prefixes", () => {
        const { mod, existsSync, logger } = loadDiscoveryLoggerModule();
        existsSync.mockReturnValue(true);

        mod.discoveryLogger.start("user-3");
        jest.clearAllMocks();

        mod.discoveryLogger.section("STEP ONE");
        mod.discoveryLogger.success("completed", 1);
        mod.discoveryLogger.error("failed", 2);
        mod.discoveryLogger.warn("slow response", 1);
        mod.discoveryLogger.info("queued");
        mod.discoveryLogger.table({ artists: 5, tracks: 30 }, 1);
        mod.discoveryLogger.list(["Artist A", "Artist B"], 1);

        expect(logger.debug).toHaveBeenCalledWith("> STEP ONE");
        expect(logger.debug).toHaveBeenCalledWith("✓ completed");
        expect(logger.debug).toHaveBeenCalledWith("✗ failed");
        expect(logger.debug).toHaveBeenCalledWith("[WARN] slow response");
        expect(logger.debug).toHaveBeenCalledWith("ℹ queued");
        expect(logger.debug).toHaveBeenCalledWith("artists: 5");
        expect(logger.debug).toHaveBeenCalledWith("tracks: 30");
        expect(logger.debug).toHaveBeenCalledWith("• Artist A");
        expect(logger.debug).toHaveBeenCalledWith("• Artist B");
    });

    it("ends logs, includes optional summary, and safely handles missing streams", () => {
        const { mod, existsSync, streamEnd, logger } = loadDiscoveryLoggerModule();
        existsSync.mockReturnValue(true);

        mod.discoveryLogger.start("user-4", 5);
        jest.clearAllMocks();

        mod.discoveryLogger.end(false, "Partial failure");

        expect(logger.debug).toHaveBeenCalledWith("GENERATION FAILED");
        expect(logger.debug).toHaveBeenCalledWith("Partial failure");
        expect(streamEnd).toHaveBeenCalledTimes(1);

        jest.clearAllMocks();
        mod.discoveryLogger.end(true);

        expect(logger.debug).toHaveBeenCalledWith("GENERATION COMPLETED");
        expect(logger.debug).not.toHaveBeenCalledWith("Partial failure");
        expect(streamEnd).not.toHaveBeenCalled();
    });

    it("logs to console even when no stream is active", () => {
        const { mod, streamWrite, logger } = loadDiscoveryLoggerModule();

        mod.discoveryLogger.write("console only");

        expect(streamWrite).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith("console only");
    });

    it("returns null for latest log when directory is missing or has no log files", () => {
        const { mod, existsSync, readdirSync } = loadDiscoveryLoggerModule();

        existsSync.mockReturnValue(false);
        expect(mod.discoveryLogger.getLatestLog()).toBeNull();

        existsSync.mockReturnValue(true);
        readdirSync.mockReturnValue(["notes.txt", "debug.json"]);
        expect(mod.discoveryLogger.getLatestLog()).toBeNull();
    });

    it("returns the lexically newest discovery log and its content", () => {
        const { mod, existsSync, readdirSync, readFileSync } = loadDiscoveryLoggerModule();

        existsSync.mockReturnValue(true);
        readdirSync.mockReturnValue([
            "notes.txt",
            "discovery-2025-12-31T23-59-59-999Z-job1.log",
            "discovery-2026-01-01T00-00-00-000Z-job2.log",
        ]);
        readFileSync.mockReturnValue("latest discovery log content");

        const result = mod.discoveryLogger.getLatestLog();
        const expectedPath = path.join(
            process.cwd(),
            "data",
            "logs",
            "discovery",
            "discovery-2026-01-01T00-00-00-000Z-job2.log"
        );

        expect(result).toEqual({
            path: expectedPath,
            content: "latest discovery log content",
        });
        expect(readFileSync).toHaveBeenCalledWith(expectedPath, "utf-8");
    });

    it("lists all logs sorted by mtime descending and excludes non-discovery files", () => {
        const { mod, existsSync, readdirSync, statSync } = loadDiscoveryLoggerModule();

        existsSync.mockReturnValue(true);
        readdirSync.mockReturnValue([
            "discovery-old.log",
            "discovery-new.log",
            "random.txt",
        ]);
        statSync.mockImplementation((filePath: string) => {
            if (filePath.endsWith("discovery-new.log")) {
                return {
                    mtime: new Date("2026-01-15T10:00:00.000Z"),
                    size: 300,
                };
            }

            return {
                mtime: new Date("2026-01-15T09:00:00.000Z"),
                size: 100,
            };
        });

        expect(mod.discoveryLogger.getAllLogs()).toEqual([
            {
                filename: "discovery-new.log",
                date: new Date("2026-01-15T10:00:00.000Z"),
                size: 300,
            },
            {
                filename: "discovery-old.log",
                date: new Date("2026-01-15T09:00:00.000Z"),
                size: 100,
            },
        ]);
    });

    it("returns empty log list when directory does not exist", () => {
        const { mod, existsSync } = loadDiscoveryLoggerModule();
        existsSync.mockReturnValue(false);

        expect(mod.discoveryLogger.getAllLogs()).toEqual([]);
    });

    it("reads specific log content and returns null for missing files", () => {
        const { mod, existsSync, readFileSync } = loadDiscoveryLoggerModule();

        existsSync.mockReturnValue(false);
        expect(mod.discoveryLogger.getLogContent("missing.log")).toBeNull();

        existsSync.mockReturnValue(true);
        readFileSync.mockReturnValue("requested log content");
        expect(mod.discoveryLogger.getLogContent("present.log")).toBe(
            "requested log content"
        );
    });

    it("removes logs older than keepCount and returns the number deleted", () => {
        const { mod, existsSync, readdirSync, statSync, unlinkSync } =
            loadDiscoveryLoggerModule();

        existsSync.mockReturnValue(true);
        readdirSync.mockReturnValue([
            "discovery-new.log",
            "discovery-mid.log",
            "discovery-old.log",
        ]);
        statSync.mockImplementation((filePath: string) => {
            if (filePath.endsWith("discovery-new.log")) {
                return {
                    mtime: new Date("2026-01-15T10:00:00.000Z"),
                    size: 300,
                };
            }
            if (filePath.endsWith("discovery-mid.log")) {
                return {
                    mtime: new Date("2026-01-15T09:30:00.000Z"),
                    size: 200,
                };
            }
            return {
                mtime: new Date("2026-01-15T09:00:00.000Z"),
                size: 100,
            };
        });

        const deleted = mod.discoveryLogger.cleanup(2);

        expect(deleted).toBe(1);
        expect(unlinkSync).toHaveBeenCalledWith(
            path.join(
                process.cwd(),
                "data",
                "logs",
                "discovery",
                "discovery-old.log"
            )
        );
    });
});
