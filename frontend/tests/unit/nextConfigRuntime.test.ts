import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const frontendRoot = path.resolve(testDirectory, "../..");

test("production config loads without the dev-only bundle analyzer", () => {
    const result = spawnSync(
        process.execPath,
        [
            "--input-type=commonjs",
            "--eval",
            `
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request === "@next/bundle-analyzer") {
        const error = new Error("blocked dev-only dependency");
        error.code = "MODULE_NOT_FOUND";
        throw error;
    }
    return originalLoad.call(this, request, parent, isMain);
};
const loadConfig = require("next/dist/server/config").default;
const { PHASE_PRODUCTION_SERVER } = require("next/constants");
loadConfig(PHASE_PRODUCTION_SERVER, process.cwd())
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
`,
        ],
        {
            cwd: frontendRoot,
            encoding: "utf8",
            env: { ...process.env, ANALYZE: "false" },
            timeout: 10_000,
        },
    );

    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
});

test("analysis config still loads and applies the bundle analyzer", () => {
    const result = spawnSync(
        process.execPath,
        [
            "--input-type=commonjs",
            "--eval",
            `
const Module = require("node:module");
const originalLoad = Module._load;
let analyzerLoads = 0;
Module._load = function(request, parent, isMain) {
    if (request === "@next/bundle-analyzer") {
        analyzerLoads += 1;
        return () => (config) => ({ ...config, analyzerTestMarker: true });
    }
    return originalLoad.call(this, request, parent, isMain);
};
const loadConfig = require("next/dist/server/config").default;
const { PHASE_PRODUCTION_BUILD } = require("next/constants");
loadConfig(PHASE_PRODUCTION_BUILD, process.cwd())
    .then((config) => {
        if (analyzerLoads !== 1 || config.analyzerTestMarker !== true) {
            process.exit(2);
        }
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
`,
        ],
        {
            cwd: frontendRoot,
            encoding: "utf8",
            env: { ...process.env, ANALYZE: "true" },
            timeout: 10_000,
        },
    );

    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 0, result.stderr);
});
