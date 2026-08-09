import { test } from "node:test";
import assert from "node:assert/strict";

import { analyzeRouteErrorCanon, countPattern } from "../check-route-error-canon.mjs";

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
  assert.deepEqual(analyzeRouteErrorCanon({ "route.ts": 2 }, { "route.ts": 2 }), {
    ok: true,
    violations: [],
    tightenable: [],
  });
});

test("analyzeRouteErrorCanon reports a file over its baseline", () => {
  assert.deepEqual(analyzeRouteErrorCanon({ "route.ts": 3 }, { "route.ts": 2 }), {
    ok: false,
    violations: [{ file: "route.ts", count: 3, baseline: 2 }],
    tightenable: [],
  });
});

test("analyzeRouteErrorCanon treats a new file baseline as zero", () => {
  assert.deepEqual(analyzeRouteErrorCanon({ "new-route.ts": 1 }, {}), {
    ok: false,
    violations: [{ file: "new-route.ts", count: 1, baseline: 0 }],
    tightenable: [],
  });
});

test("analyzeRouteErrorCanon reports a lower count as tightenable", () => {
  assert.deepEqual(analyzeRouteErrorCanon({ "route.ts": 1 }, { "route.ts": 2 }), {
    ok: true,
    violations: [],
    tightenable: [{ file: "route.ts", count: 1, baseline: 2 }],
  });
});
