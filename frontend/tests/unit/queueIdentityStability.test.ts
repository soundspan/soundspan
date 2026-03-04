import assert from "node:assert/strict";
import test from "node:test";
import { resolveStableQueuedTrackIdSet } from "../../lib/queue-identity";

test("returns prevSet when contents are identical", () => {
    const prev = new Set(["a", "b", "c"]) as ReadonlySet<string>;
    const next = new Set(["a", "b", "c"]) as ReadonlySet<string>;
    const result = resolveStableQueuedTrackIdSet(next, prev);
    assert.equal(result, prev, "should return exact same reference");
});

test("returns nextSet when contents differ", () => {
    const prev = new Set(["a", "b", "c"]) as ReadonlySet<string>;
    const next = new Set(["a", "b", "d"]) as ReadonlySet<string>;
    const result = resolveStableQueuedTrackIdSet(next, prev);
    assert.equal(result, next, "should return new set reference");
});

test("returns nextSet when sizes differ", () => {
    const prev = new Set(["a", "b"]) as ReadonlySet<string>;
    const next = new Set(["a", "b", "c"]) as ReadonlySet<string>;
    const result = resolveStableQueuedTrackIdSet(next, prev);
    assert.equal(result, next, "should return new set for different sizes");
});

test("returns nextSet when prevSet is null", () => {
    const next = new Set(["a"]) as ReadonlySet<string>;
    const result = resolveStableQueuedTrackIdSet(next, null);
    assert.equal(result, next, "should return next when prev is null");
});

test("returns prevSet for two empty sets", () => {
    const prev = new Set<string>() as ReadonlySet<string>;
    const next = new Set<string>() as ReadonlySet<string>;
    const result = resolveStableQueuedTrackIdSet(next, prev);
    assert.equal(result, prev, "should return prev for two empty sets");
});
