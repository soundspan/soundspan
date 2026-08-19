import assert from "node:assert/strict";
import test from "node:test";
import {
    TAURI_DEPRECATION_MESSAGE,
    resetTauriDeprecationWarningForTests,
    warnTauriDeprecationOnce,
} from "../../lib/audio-engine/tauriDeprecation";
import type { FrontendLogger } from "../../lib/logger";
import { buildRuntimeConfigPayload } from "../../lib/runtime-config/normalization";

const createRecordingLogger = (): {
    logger: FrontendLogger;
    warnings: string[];
} => {
    const warnings: string[] = [];
    const record = (message: string) => {
        warnings.push(message);
    };
    const logger: FrontendLogger = {
        debug: record,
        info: record,
        warn: (message: string) => {
            warnings.push(message);
        },
        error: record,
        child: () => logger,
    };
    return { logger, warnings };
};

test("warnTauriDeprecationOnce warns exactly once per process", () => {
    resetTauriDeprecationWarningForTests();
    const { logger, warnings } = createRecordingLogger();

    warnTauriDeprecationOnce("engine upgrade", logger);
    warnTauriDeprecationOnce("engine upgrade", logger);
    warnTauriDeprecationOnce("runtime config", logger);

    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("engine upgrade"));
    assert.ok(warnings[0].includes(TAURI_DEPRECATION_MESSAGE));
});

test("Tauri deprecation message states removal and migration", () => {
    assert.ok(TAURI_DEPRECATION_MESSAGE.includes("deprecated"));
    assert.ok(
        TAURI_DEPRECATION_MESSAGE.includes("removed in a future release"),
    );
});

test("buildRuntimeConfigPayload warns once when tauri-native is configured", (t) => {
    resetTauriDeprecationWarningForTests();
    const warn = t.mock.method(console, "warn");

    const first = buildRuntimeConfigPayload({
        STREAMING_ENGINE_MODE: "tauri-native",
    });
    const second = buildRuntimeConfigPayload({
        STREAMING_ENGINE_MODE: "tauri-native",
    });

    assert.ok(first.includes('STREAMING_ENGINE_MODE: "tauri-native"'));
    assert.equal(first, second);
    const deprecationWarnings = warn.mock.calls.filter((call) =>
        String(call.arguments[0]).includes(TAURI_DEPRECATION_MESSAGE),
    );
    assert.equal(deprecationWarnings.length, 1);

    resetTauriDeprecationWarningForTests();
});

test("buildRuntimeConfigPayload does not warn for non-Tauri modes", (t) => {
    resetTauriDeprecationWarningForTests();
    const warn = t.mock.method(console, "warn");

    buildRuntimeConfigPayload({ STREAMING_ENGINE_MODE: "native" });
    buildRuntimeConfigPayload({ STREAMING_ENGINE_MODE: "videojs" });
    buildRuntimeConfigPayload({});

    const deprecationWarnings = warn.mock.calls.filter((call) =>
        String(call.arguments[0]).includes(TAURI_DEPRECATION_MESSAGE),
    );
    assert.equal(deprecationWarnings.length, 0);
});
