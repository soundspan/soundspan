import * as path from "path";

describe("discoverLogger utilities", () => {
    const FIXED_CWD = "/tmp/discover-logger-tests";

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
        jest.resetModules();
        jest.clearAllMocks();
    });

    function expectedLogPath(isoTimestamp: string): string {
        const filenameTimestamp = isoTimestamp.replace(/[:.]/g, "-").slice(0, -5);
        return path.join(FIXED_CWD, "logs", `discover-${filenameTimestamp}.log`);
    }

    function expectedHeader(userId: string, startedAt: Date): string {
        return `
========================================
Discover Weekly Generation Log
User ID: ${userId}
Started: ${startedAt.toISOString()}
========================================

`;
    }

    function expectedFooter(endedAt: Date): string {
        return `
========================================
Generation Complete
Ended: ${endedAt.toISOString()}
========================================
`;
    }

    function loadDiscoverLoggerModule(
        initialNow: Date = new Date("2026-02-17T10:11:12.345Z")
    ) {
        jest.resetModules();
        jest.useFakeTimers();
        jest.setSystemTime(initialNow);

        const writeFileSync = jest.fn();
        const appendFileSync = jest.fn();

        const logger = {
            debug: jest.fn(),
            info: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };

        jest.doMock("fs", () => ({
            writeFileSync,
            appendFileSync,
        }));
        jest.doMock("../logger", () => ({ logger }));

        jest.spyOn(process, "cwd").mockReturnValue(FIXED_CWD);

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require("../discoverLogger") as typeof import("../discoverLogger");

        return {
            mod,
            writeFileSync,
            appendFileSync,
            logger,
        };
    }

    it("returns a singleton instance from getDiscoverLogger", () => {
        const { mod } = loadDiscoverLoggerModule();

        const first = mod.getDiscoverLogger();
        const second = mod.getDiscoverLogger();

        expect(second).toBe(first);

        mod.resetDiscoverLogger();
        jest.setSystemTime(new Date("2026-02-17T11:00:00.000Z"));

        const third = mod.getDiscoverLogger();
        expect(third).not.toBe(first);
    });

    it("start writes a header and monkey-patches logger debug/error", () => {
        const constructorTime = new Date("2026-02-17T10:11:12.345Z");
        const startTime = new Date("2026-02-17T10:12:13.456Z");
        const { mod, writeFileSync, logger } = loadDiscoverLoggerModule(constructorTime);

        const discoverLogger = mod.getDiscoverLogger();
        const originalDebug = logger.debug;
        const originalError = logger.error;
        const logPath = expectedLogPath(constructorTime.toISOString());

        jest.setSystemTime(startTime);
        discoverLogger.start("user-42");

        expect(writeFileSync).toHaveBeenCalledWith(
            logPath,
            expectedHeader("user-42", startTime),
            "utf-8"
        );
        expect(originalDebug).toHaveBeenCalledWith(` Logging to: ${logPath}`);
        expect(logger.debug).not.toBe(originalDebug);
        expect(logger.error).not.toBe(originalError);
    });

    it("appends formatted debug and error lines while active", () => {
        const constructorTime = new Date("2026-02-17T10:11:12.345Z");
        const startTime = new Date("2026-02-17T10:12:13.000Z");
        const debugTime = new Date("2026-02-17T10:13:14.999Z");
        const errorTime = new Date("2026-02-17T10:14:15.000Z");
        const { mod, appendFileSync, logger } = loadDiscoverLoggerModule(constructorTime);

        const discoverLogger = mod.getDiscoverLogger();
        const originalDebug = logger.debug;
        const originalError = logger.error;
        const logPath = expectedLogPath(constructorTime.toISOString());

        jest.setSystemTime(startTime);
        discoverLogger.start("user-99");

        jest.setSystemTime(debugTime);
        logger.debug("processing", { step: 1 }, 7);

        jest.setSystemTime(errorTime);
        logger.error("failed", { code: "E1" });

        expect(originalDebug).toHaveBeenCalledWith("processing", { step: 1 }, 7);
        expect(originalError).toHaveBeenCalledWith("failed", { code: "E1" });
        expect(appendFileSync.mock.calls).toEqual([
            [logPath, "[10:13:14] processing {\"step\":1} 7\n", "utf-8"],
            [logPath, "[10:14:15] ERROR: failed {\"code\":\"E1\"}\n", "utf-8"],
        ]);
    });

    it("end writes footer and restores original logger methods", () => {
        const constructorTime = new Date("2026-02-17T10:11:12.345Z");
        const startTime = new Date("2026-02-17T10:12:13.000Z");
        const endTime = new Date("2026-02-17T10:15:16.000Z");
        const { mod, appendFileSync, logger } = loadDiscoverLoggerModule(constructorTime);

        const discoverLogger = mod.getDiscoverLogger();
        const originalDebug = logger.debug;
        const originalError = logger.error;
        const logPath = expectedLogPath(constructorTime.toISOString());

        jest.setSystemTime(startTime);
        discoverLogger.start("user-7");

        const patchedDebug = logger.debug;
        const patchedError = logger.error;
        expect(patchedDebug).not.toBe(originalDebug);
        expect(patchedError).not.toBe(originalError);

        jest.setSystemTime(endTime);
        discoverLogger.end();

        expect(appendFileSync).toHaveBeenCalledWith(
            logPath,
            expectedFooter(endTime),
            "utf-8"
        );
        expect(logger.debug).toBe(originalDebug);
        expect(logger.error).toBe(originalError);
        expect(originalDebug).toHaveBeenCalledWith(`\nFull log saved to: ${logPath}`);

        logger.debug("after end");
        expect(originalDebug).toHaveBeenCalledWith("after end");
        expect(appendFileSync).toHaveBeenCalledTimes(1);
    });

    it("resetDiscoverLogger ends active logger and clears singleton", () => {
        const constructorTime = new Date("2026-02-17T10:11:12.345Z");
        const startTime = new Date("2026-02-17T10:12:13.000Z");
        const resetTime = new Date("2026-02-17T10:20:00.000Z");
        const nextConstructorTime = new Date("2026-02-17T10:30:00.000Z");
        const { mod, appendFileSync, logger } = loadDiscoverLoggerModule(constructorTime);

        const first = mod.getDiscoverLogger();
        const originalDebug = logger.debug;
        const originalError = logger.error;
        const firstLogPath = expectedLogPath(constructorTime.toISOString());

        jest.setSystemTime(startTime);
        first.start("user-reset");
        expect(logger.debug).not.toBe(originalDebug);
        expect(logger.error).not.toBe(originalError);

        jest.setSystemTime(resetTime);
        mod.resetDiscoverLogger();

        expect(appendFileSync).toHaveBeenCalledWith(
            firstLogPath,
            expectedFooter(resetTime),
            "utf-8"
        );
        expect(logger.debug).toBe(originalDebug);
        expect(logger.error).toBe(originalError);

        jest.setSystemTime(nextConstructorTime);
        const second = mod.getDiscoverLogger();
        expect(second).not.toBe(first);
        expect(second.getLogPath()).toBe(
            expectedLogPath(nextConstructorTime.toISOString())
        );
    });
});
