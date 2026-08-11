import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    analyzeRouteErrorCanon,
    collectCounts,
    countPattern,
    countLeakPattern,
    stripLoggerCalls,
} from "../check-route-error-canon.mjs";

test("collectCounts recurses into services while excluding test files", () => {
    const fixtureRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "route-error-canon-"),
    );
    const serviceDirectory = path.join(fixtureRoot, "backend/src/services/sub");
    const nestedTestDirectory = path.join(serviceDirectory, "__tests__");

    try {
        fs.mkdirSync(nestedTestDirectory, { recursive: true });
        fs.writeFileSync(
            path.join(serviceDirectory, "leaky.ts"),
            "const detail = err.message;\n",
        );
        fs.writeFileSync(
            path.join(nestedTestDirectory, "x.test.ts"),
            "const detail = err.message;\n",
        );
        fs.writeFileSync(
            path.join(serviceDirectory, "thing.test.ts"),
            "const detail = err.message;\n",
        );

        assert.deepEqual(
            collectCounts(
                fixtureRoot,
                countLeakPattern,
                "backend/src/services",
            ),
            {
                "backend/src/services/sub/leaky.ts": 1,
            },
        );
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

test("countPattern counts occurrences and tolerates whitespace", () => {
    const source = `
    res.status(500).json({ error: "first" });
    res . status ( 500 ) . json ( { error: "second" } );
  `;

    assert.equal(countPattern(source), 2);
});

test("countPattern ignores the canonical internal-error helper", () => {
    assert.equal(countPattern('sendInternalRouteError(res, "x");'), 0);
});

test("analyzeRouteErrorCanon accepts a file at its baseline", () => {
    assert.deepEqual(
        analyzeRouteErrorCanon({ "route.ts": 2 }, { "route.ts": 2 }),
        {
            ok: true,
            violations: [],
            tightenable: [],
        },
    );
});

test("analyzeRouteErrorCanon reports a file over its baseline", () => {
    assert.deepEqual(
        analyzeRouteErrorCanon({ "route.ts": 3 }, { "route.ts": 2 }),
        {
            ok: false,
            violations: [{ file: "route.ts", count: 3, baseline: 2 }],
            tightenable: [],
        },
    );
});

test("analyzeRouteErrorCanon treats a new file baseline as zero", () => {
    assert.deepEqual(analyzeRouteErrorCanon({ "new-route.ts": 1 }, {}), {
        ok: false,
        violations: [{ file: "new-route.ts", count: 1, baseline: 0 }],
        tightenable: [],
    });
});

test("analyzeRouteErrorCanon reports a lower count as tightenable", () => {
    assert.deepEqual(
        analyzeRouteErrorCanon({ "route.ts": 1 }, { "route.ts": 2 }),
        {
            ok: true,
            violations: [],
            tightenable: [{ file: "route.ts", count: 1, baseline: 2 }],
        },
    );
});

test("countLeakPattern counts raw caught-error message/stack echoed into a body", () => {
    const source = `
        res.status(500).json({ error: "Failed", details: error?.message });
        res.status(400).json({ error: error.message || "x" });
        res.status(500).json({ error: error?.stack });
    `;

    assert.equal(countLeakPattern(source), 3);
});

test("countLeakPattern tolerates whitespace variations", () => {
    assert.equal(countLeakPattern("details :  error ?. message"), 1);
    assert.equal(countLeakPattern("error:error.stack"), 1);
});

test("countLeakPattern ignores static curated messages", () => {
    const source = `
        res.status(500).json({ error: "Failed to fetch artists" });
        sendInternalRouteError(res, "Failed to fetch albums");
        logger.error("boom", error);
    `;

    assert.equal(countLeakPattern(source), 0);
});

test("analyzeRouteErrorCanon ratchets leak counts the same way", () => {
    assert.deepEqual(
        analyzeRouteErrorCanon({ "leaky.ts": 3 }, { "leaky.ts": 2 }),
        {
            ok: false,
            violations: [{ file: "leaky.ts", count: 3, baseline: 2 }],
            tightenable: [],
        },
    );
});

test("countLeakPattern flags a template-literal interpolation of error.message", () => {
    const source =
        "const msg = `Failed to process ${artistName}: ${error.message}`;";
    assert.equal(countLeakPattern(source), 1);
});

test("countLeakPattern flags an intermediate const assigned from error.message", () => {
    const source = "const detail = error.message; return res.json({ detail });";
    assert.equal(countLeakPattern(source), 1);
});

test("countLeakPattern flags suffixed-error optional message access", () => {
    assert.equal(
        countLeakPattern("res.json({ error: scanError?.message })"),
        1,
    );
});

test("countLeakPattern flags cast-wrapped suffixed-error message access", () => {
    const source = 'sessionLog("X", `boom: ${(scanError as any)?.message}`)';
    assert.equal(countLeakPattern(source), 1);
});

test("countLeakPattern flags a suffixed-error intermediate assignment", () => {
    assert.equal(countLeakPattern("const detail = fetchError.message;"), 1);
});

test("countLeakPattern flags a template-literal error.stack interpolation", () => {
    assert.equal(countLeakPattern("res.send(`trace: ${error?.stack}`);"), 1);
});

test("countLeakPattern exempts raw errors logged server-side via logger.*", () => {
    const source =
        "logger.error(`[CLEANUP] ${artistName}: ${error.message}`);\n" +
        "logger.error('boom', error?.message || error);";
    assert.equal(countLeakPattern(source), 0);
});

test("countLeakPattern exempts suffixed-error details logged server-side", () => {
    assert.equal(countLeakPattern("logger.error(`x ${scanError.message}`)"), 0);
});

test("countLeakPattern ignores message access on non-error identifiers", () => {
    assert.equal(countLeakPattern("res.json({ msg: payload.message })"), 0);
});

test("countLeakPattern flags bare err response leaks", () => {
    const source =
        'res.status(500).json({ status: "error", error: err.message });';
    assert.equal(countLeakPattern(source), 1);
});

test("countLeakPattern flags bare e and ex response leaks", () => {
    assert.equal(countLeakPattern("res.json({ error: e.message })"), 1);
    assert.equal(countLeakPattern("res.send(`x: ${ex.message}`);"), 1);
});

test("countLeakPattern exempts bare err details logged server-side", () => {
    const source =
        'logger.error("[TIDAL-STREAM] Poll auth failed:", err.message);';
    assert.equal(countLeakPattern(source), 0);
});

test("countLeakPattern ignores identifiers ending in e", () => {
    assert.equal(countLeakPattern("res.json({ detail: response.message })"), 0);
    assert.equal(countLeakPattern("res.send(`${resource.message}`);"), 0);
});

test("countLeakPattern flags result.error forwarded in a response body", () => {
    assert.equal(
        countLeakPattern(
            "res.json({ success: result.success, error: result.error });",
        ),
        1,
    );
});

test("countLeakPattern flags result.error interpolated into a session log push", () => {
    const source =
        'sessionLog("PENDING-RETRY", `Download failed: ${result.error || "unknown error"}`, "WARN");';
    assert.equal(countLeakPattern(source), 1);
});

test("countLeakPattern flags chained optional sidecar detail in a response", () => {
    assert.equal(
        countLeakPattern(
            'res.status(502).json({ error: err.response?.data?.detail || "Download failed" });',
        ),
        1,
    );
});

test("countLeakPattern exempts result.error inside logger calls", () => {
    const source =
        'logger.warn("retry failed:", result.error);\n' +
        "logger.debug(`[Retry] Download failed: ${result.error}`);";
    assert.equal(countLeakPattern(source), 0);
});

test("countLeakPattern ignores derived access on .error", () => {
    const source =
        "res.status(400).json({ details: parsedBody.error.issues });\n" +
        "res.status(400).json({ details: parsedBody.error.flatten() });";
    assert.equal(countLeakPattern(source), 0);
});

test("countLeakPattern flags an intermediate const assigned from a result error", () => {
    assert.equal(
        countLeakPattern(
            'const errorMsg = downloadResult.error || "Unknown error";',
        ),
        1,
    );
});

test("countLeakPattern flags terminal plural errors in a response value", () => {
    const source =
        "res.status(400).json({ errors: result.errors, details: parsed.error.errors });";
    assert.equal(countLeakPattern(source), 2);
});

test("countLeakPattern exempts terminal plural errors inside logger calls", () => {
    assert.equal(
        countLeakPattern("logger.warn('invalid', parsed.error.errors)"),
        0,
    );
});

test("countLeakPattern flags String called with an error identifier", () => {
    assert.equal(
        countLeakPattern("const detail = failed ? fallback : String(error);"),
        1,
    );
});

test("countLeakPattern exempts String error conversion inside logger calls", () => {
    assert.equal(countLeakPattern("logger.warn('failed', String(err))"), 0);
});

test("countLeakPattern flags a bare error template interpolation", () => {
    assert.equal(countLeakPattern('sessionLog("X", `failed: ${err}`)'), 1);
});

test("countLeakPattern exempts a bare error interpolation inside logger calls", () => {
    assert.equal(countLeakPattern("logger?.error(`failed: ${error}`)"), 0);
});

test("countLeakPattern flags error toString calls in value contexts", () => {
    assert.equal(countLeakPattern("res.json({ error: err?.toString() })"), 1);
});

test("countLeakPattern exempts error toString calls inside logger calls", () => {
    assert.equal(countLeakPattern("logger.error(error.toString())"), 0);
});

test("countLeakPattern flags error names in value contexts", () => {
    assert.equal(countLeakPattern("res.json({ detail: error ?. name })"), 1);
});

test("countLeakPattern exempts error names inside logger calls", () => {
    assert.equal(countLeakPattern("logger.warn('type', err.name)"), 0);
});

test("countLeakPattern flags terminal axios response data in value contexts", () => {
    assert.equal(
        countLeakPattern("res.json({ error: err.response?.data })"),
        1,
    );
});

test("countLeakPattern exempts terminal axios response data inside logger calls", () => {
    assert.equal(
        countLeakPattern("logger.error('axios', err.response.data)"),
        0,
    );
});

test("countLeakPattern flags JSON.stringify called with an error first argument", () => {
    const source =
        "const detail = JSON.stringify(error, Object.getOwnPropertyNames(error));";
    assert.equal(countLeakPattern(source), 1);
});

test("countLeakPattern exempts JSON.stringify errors inside logger calls", () => {
    assert.equal(countLeakPattern("logger.error(JSON.stringify(err))"), 0);
});

test("countLeakPattern ignores error name comparisons", () => {
    assert.equal(
        countLeakPattern('if (error.name === "ZodError") handle();'),
        0,
    );
});

test("countLeakPattern ignores String calls with non-error identifiers", () => {
    assert.equal(countLeakPattern("res.json({ id: String(someId) })"), 0);
});

test("countLeakPattern counts an axios detail chain exactly once", () => {
    assert.equal(
        countLeakPattern("res.json({ error: err.response?.data?.detail })"),
        1,
    );
});

test("countLeakPattern flags sidecar detail in a ternary consequent", () => {
    const source =
        'res.status(400).json({ error: typeof error?.response?.data?.detail === "string" ? error.response.data.detail : "static" })';
    assert.ok(countLeakPattern(source) >= 1);
});

test("countLeakPattern flags terminal plural details in a response value", () => {
    assert.equal(countLeakPattern("res.json({ error: result.details })"), 1);
});

test("countLeakPattern flags Err-suffixed identifier properties", () => {
    assert.equal(countLeakPattern("res.json({ error: fetchErr.message })"), 1);
});

test("countLeakPattern does not treat optional or nullish operators as ternaries", () => {
    const source = `
        const optional = a?.b;
        const fallback = x ?? y;
        res.json({ error: "static" });
    `;
    assert.equal(countLeakPattern(source), 0);
});

test("countLeakPattern counts nested String interpolation exactly once", () => {
    assert.equal(countLeakPattern("res.send(`failed: ${String(err)}`)"), 1);
});
