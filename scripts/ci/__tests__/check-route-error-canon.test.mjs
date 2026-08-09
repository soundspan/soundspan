import { test } from "node:test";
import assert from "node:assert/strict";

import {
    analyzeRouteErrorCanon,
    countPattern,
    countLeakPattern,
} from "../check-route-error-canon.mjs";

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
