const originalEnv = { ...process.env };

describe("logger", () => {
    afterEach(() => {
        process.env = originalEnv;
        jest.resetModules();
        jest.restoreAllMocks();
    });

    function loadLoggerModule(options?: {
        logLevel?: string;
        nodeEnv?: string;
    }) {
        jest.resetModules();
        jest.restoreAllMocks();
        process.env = { ...originalEnv };

        if (options?.logLevel === undefined) {
            delete process.env.LOG_LEVEL;
        } else {
            process.env.LOG_LEVEL = options.logLevel;
        }

        if (options?.nodeEnv === undefined) {
            delete process.env.NODE_ENV;
        } else {
            process.env.NODE_ENV = options.nodeEnv;
        }

        const consoleDebug = jest
            .spyOn(console, "debug")
            .mockImplementation(() => {});
        const consoleInfo = jest
            .spyOn(console, "info")
            .mockImplementation(() => {});
        const consoleWarn = jest
            .spyOn(console, "warn")
            .mockImplementation(() => {});
        const consoleError = jest
            .spyOn(console, "error")
            .mockImplementation(() => {});

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const loggerModule = require("../logger") as typeof import("../logger");

        return {
            logger: loggerModule.logger,
            consoleDebug,
            consoleInfo,
            consoleWarn,
            consoleError,
        };
    }

    it("gates logs based on LOG_LEVEL ordering", () => {
        const cases = [
            {
                level: "debug",
                expected: { debug: true, info: true, warn: true, error: true },
            },
            {
                level: "info",
                expected: { debug: false, info: true, warn: true, error: true },
            },
            {
                level: "warn",
                expected: { debug: false, info: false, warn: true, error: true },
            },
            {
                level: "error",
                expected: { debug: false, info: false, warn: false, error: true },
            },
            {
                level: "silent",
                expected: { debug: false, info: false, warn: false, error: false },
            },
        ] as const;

        for (const scenario of cases) {
            const { logger, consoleDebug, consoleInfo, consoleWarn, consoleError } =
                loadLoggerModule({ logLevel: scenario.level });

            logger.debug("debug call");
            logger.info("info call");
            logger.warn("warn call");
            logger.error("error call");

            expect(consoleDebug.mock.calls.length).toBe(
                scenario.expected.debug ? 1 : 0
            );
            expect(consoleInfo.mock.calls.length).toBe(scenario.expected.info ? 1 : 0);
            expect(consoleWarn.mock.calls.length).toBe(scenario.expected.warn ? 1 : 0);
            expect(consoleError.mock.calls.length).toBe(
                scenario.expected.error ? 1 : 0
            );
        }
    });

    it("uses production defaults when LOG_LEVEL is unset and NODE_ENV is production", () => {
        const { logger, consoleDebug, consoleInfo, consoleWarn, consoleError } =
            loadLoggerModule({ nodeEnv: "production" });

        logger.debug("debug call");
        logger.info("info call");
        logger.warn("warn call");
        logger.error("error call");

        expect(consoleDebug).not.toHaveBeenCalled();
        expect(consoleInfo).not.toHaveBeenCalled();
        expect(consoleWarn).toHaveBeenCalledWith("[WARN] warn call");
        expect(consoleError).toHaveBeenCalledWith("[ERROR] error call");
    });

    it("uses development defaults when LOG_LEVEL is unset and NODE_ENV is not production", () => {
        const { logger, consoleDebug, consoleInfo, consoleWarn, consoleError } =
            loadLoggerModule({ nodeEnv: "development" });

        logger.debug("debug call");
        logger.info("info call");
        logger.warn("warn call");
        logger.error("error call");

        expect(consoleDebug).toHaveBeenCalledWith("[DEBUG] debug call");
        expect(consoleInfo).toHaveBeenCalledWith("[INFO] info call");
        expect(consoleWarn).toHaveBeenCalledWith("[WARN] warn call");
        expect(consoleError).toHaveBeenCalledWith("[ERROR] error call");
    });

    it("silences all levels when LOG_LEVEL is unknown", () => {
        const { logger, consoleDebug, consoleInfo, consoleWarn, consoleError } =
            loadLoggerModule({ logLevel: "noisy" });

        logger.debug("debug call");
        logger.info("info call");
        logger.warn("warn call");
        logger.error("error call");

        expect(consoleDebug).not.toHaveBeenCalled();
        expect(consoleInfo).not.toHaveBeenCalled();
        expect(consoleWarn).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
    });

    it("forwards message and variadic arguments unchanged", () => {
        const { logger, consoleDebug, consoleInfo, consoleWarn, consoleError } =
            loadLoggerModule({ logLevel: "debug" });

        const context = { trace: "abc" };
        const payload = ["x", 7];

        logger.debug("starting", context, payload);
        logger.info("running", 1, "two", context);
        logger.warn("almost", payload);
        logger.error("failed", new Error("nope"));

        expect(consoleDebug).toHaveBeenCalledWith("[DEBUG] starting", context, payload);
        expect(consoleInfo).toHaveBeenCalledWith("[INFO] running", 1, "two", context);
        expect(consoleWarn).toHaveBeenCalledWith("[WARN] almost", payload);
        expect(consoleError).toHaveBeenCalledWith(
            "[ERROR] failed",
            expect.any(Error)
        );
        expect(consoleError.mock.calls[0][1]).toBeInstanceOf(Error);
        expect((consoleError.mock.calls[0][1] as Error).message).toBe("nope");
    });
});
