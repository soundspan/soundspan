import assert from "node:assert/strict";
import test from "node:test";
import {
    createDebouncedStorageFlush,
} from "../../lib/playback-state-cadence";

test("schedule coalesces multiple calls into one flush", async () => {
    let flushCount = 0;
    const flush = createDebouncedStorageFlush(50);
    flush.schedule(() => { flushCount++; });
    flush.schedule(() => { flushCount++; });
    flush.schedule(() => { flushCount++; });

    // Only the last scheduled callback should fire
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(flushCount, 1, "should coalesce into a single flush");
});

test("cancel prevents pending flush from firing", async () => {
    let flushCount = 0;
    const flush = createDebouncedStorageFlush(50);
    flush.schedule(() => { flushCount++; });
    flush.cancel();

    await new Promise((r) => setTimeout(r, 80));
    assert.equal(flushCount, 0, "cancelled flush should not fire");
});

test("schedule fires after specified delay", async () => {
    let firedAt = 0;
    const scheduledAt = Date.now();
    const flush = createDebouncedStorageFlush(60);
    flush.schedule(() => { firedAt = Date.now(); });

    await new Promise((r) => setTimeout(r, 100));
    const elapsed = firedAt - scheduledAt;
    assert.ok(elapsed >= 55, `should fire after ~60ms, fired after ${elapsed}ms`);
});

test("schedule replaces previous callback with latest one", async () => {
    const calls: string[] = [];
    const flush = createDebouncedStorageFlush(50);
    flush.schedule(() => { calls.push("first"); });
    flush.schedule(() => { calls.push("second"); });

    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(calls, ["second"], "only the latest callback should fire");
});

test("flush immediately runs pending callback", () => {
    let flushCount = 0;
    const handle = createDebouncedStorageFlush(5000);
    handle.schedule(() => { flushCount++; });
    handle.flush();
    assert.equal(flushCount, 1, "flush should fire the pending callback immediately");
});

test("flush is a no-op when nothing is pending", () => {
    const handle = createDebouncedStorageFlush(50);
    // Should not throw
    handle.flush();
});

test("flush clears the timer so callback does not fire twice", async () => {
    let flushCount = 0;
    const handle = createDebouncedStorageFlush(50);
    handle.schedule(() => { flushCount++; });
    handle.flush();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(flushCount, 1, "callback should not fire again after flush");
});
