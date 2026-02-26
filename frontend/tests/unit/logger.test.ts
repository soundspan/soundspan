import assert from "node:assert/strict";
import test from "node:test";

type ConsoleCallMap = Record<"debug" | "info" | "warn" | "error", unknown[][]>;

async function withMockedConsole(
    run: (calls: ConsoleCallMap) => Promise<void> | void
): Promise<void> {
    const calls: ConsoleCallMap = {
        debug: [],
        info: [],
        warn: [],
        error: [],
    };

    const original = {
        debug: console.debug,
        info: console.info,
        warn: console.warn,
        error: console.error,
    };

    console.debug = (...args: unknown[]) => {
        calls.debug.push(args);
    };
    console.info = (...args: unknown[]) => {
        calls.info.push(args);
    };
    console.warn = (...args: unknown[]) => {
        calls.warn.push(args);
    };
    console.error = (...args: unknown[]) => {
        calls.error.push(args);
    };

    try {
        await run(calls);
    } finally {
        console.debug = original.debug;
        console.info = original.info;
        console.warn = original.warn;
        console.error = original.error;
    }
}

async function withEnv(
    values: Record<string, string | undefined>,
    run: () => Promise<void> | void
): Promise<void> {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(values)) {
        previous.set(key, process.env[key]);
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }

    try {
        await run();
    } finally {
        for (const [key, value] of previous.entries()) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

async function loadLoggerModule() {
    return import(`../../lib/logger.ts?logger-test=${Date.now()}-${Math.random()}`);
}

test("frontend logger defaults to info in development", async () => {
    await withEnv(
        { NODE_ENV: "development", NEXT_PUBLIC_LOG_LEVEL: undefined },
        async () => {
            await withMockedConsole(async (calls) => {
                const { createFrontendLogger } = await loadLoggerModule();
                const logger = createFrontendLogger("Unit");

                logger.debug("debug");
                logger.info("info");
                logger.warn("warn");
                logger.error("error");

                assert.equal(calls.debug.length, 0);
                assert.equal(calls.info.length, 1);
                assert.equal(calls.warn.length, 1);
                assert.equal(calls.error.length, 1);
            });
        }
    );
});

test("frontend logger silences all levels when NEXT_PUBLIC_LOG_LEVEL is unknown", async () => {
    await withEnv(
        { NODE_ENV: "development", NEXT_PUBLIC_LOG_LEVEL: "noisy" },
        async () => {
            await withMockedConsole(async (calls) => {
                const { createFrontendLogger } = await loadLoggerModule();
                const logger = createFrontendLogger("Unit");

                logger.debug("debug");
                logger.info("info");
                logger.warn("warn");
                logger.error("error");

                assert.equal(calls.debug.length, 0);
                assert.equal(calls.info.length, 0);
                assert.equal(calls.warn.length, 0);
                assert.equal(calls.error.length, 0);
            });
        }
    );
});

test("frontend logger scopes messages and normalizes context errors", async () => {
    await withEnv(
        { NODE_ENV: "development", NEXT_PUBLIC_LOG_LEVEL: "debug" },
        async () => {
            await withMockedConsole(async (calls) => {
                const { createFrontendLogger } = await loadLoggerModule();
                const logger = createFrontendLogger("Parent").child("Child");

                logger.error("failed", {
                    requestId: "req-1",
                    error: new Error("boom"),
                });

                assert.equal(calls.error.length, 1);
                assert.equal(
                    calls.error[0][0],
                    "[ERROR] [Parent.Child] failed"
                );
                const context = calls.error[0][1] as {
                    requestId: string;
                    error: { name: string; message: string; stack?: string };
                };
                assert.equal(context.requestId, "req-1");
                assert.equal(context.error.name, "Error");
                assert.equal(context.error.message, "boom");
                assert.equal(typeof context.error.stack, "string");
            });
        }
    );
});

test("withFrontendLogTiming logs start and completion", async () => {
    await withEnv(
        { NODE_ENV: "development", NEXT_PUBLIC_LOG_LEVEL: "debug" },
        async () => {
            await withMockedConsole(async (calls) => {
                const { createFrontendLogger, withFrontendLogTiming } =
                    await loadLoggerModule();
                const logger = createFrontendLogger("Timing");

                const result = await withFrontendLogTiming(
                    logger,
                    "refresh",
                    async () => "ok",
                    { requestId: "req-2" }
                );

                assert.equal(result, "ok");
                assert.equal(calls.debug.length, 2);
                assert.equal(calls.debug[0][0], "[DEBUG] [Timing] refresh started");
                assert.equal(calls.debug[1][0], "[DEBUG] [Timing] refresh completed");
                assert.equal(calls.debug[1][1].requestId, "req-2");
                assert.equal(typeof calls.debug[1][1].durationMs, "number");
            });
        }
    );
});
