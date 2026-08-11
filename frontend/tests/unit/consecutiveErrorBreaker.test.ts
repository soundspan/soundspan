import assert from "node:assert/strict";
import test from "node:test";
import {
    createConsecutiveErrorBreaker,
    DEFAULT_CONSECUTIVE_ERROR_THRESHOLD,
} from "../../lib/audio-engine/consecutiveErrorBreaker";

function createBreakerHarness(cooldownMs: number = 60_000) {
    let nowMs = 0;
    return {
        breaker: createConsecutiveErrorBreaker(3, cooldownMs, () => nowMs),
        advanceBy(ms: number): void {
            nowMs += ms;
        },
    };
}

test("default threshold is 3", () => {
    assert.equal(DEFAULT_CONSECUTIVE_ERROR_THRESHOLD, 3);
});

test("starts with zero errors and not tripped", () => {
    const breaker = createConsecutiveErrorBreaker();
    assert.equal(breaker.getErrorCount(), 0);
    assert.equal(breaker.isTripped(), false);
});

test("does not trip before reaching threshold", () => {
    const breaker = createConsecutiveErrorBreaker(3);
    assert.equal(breaker.recordError(), false); // 1
    assert.equal(breaker.recordError(), false); // 2
    assert.equal(breaker.isTripped(), false);
    assert.equal(breaker.getErrorCount(), 2);
});

test("trips exactly at threshold and returns true once", () => {
    const breaker = createConsecutiveErrorBreaker(3);
    breaker.recordError(); // 1
    breaker.recordError(); // 2
    const justTripped = breaker.recordError(); // 3 — should trip
    assert.equal(justTripped, true);
    assert.equal(breaker.isTripped(), true);
    assert.equal(breaker.getErrorCount(), 3);
});

test("subsequent errors after trip return false (already tripped)", () => {
    const breaker = createConsecutiveErrorBreaker(3);
    breaker.recordError();
    breaker.recordError();
    breaker.recordError(); // trips
    const subsequent = breaker.recordError(); // 4 — already tripped
    assert.equal(subsequent, false);
    assert.equal(breaker.isTripped(), true);
    assert.equal(breaker.getErrorCount(), 4);
});

test("successful play resets counter and un-trips breaker", () => {
    const breaker = createConsecutiveErrorBreaker(3);
    breaker.recordError();
    breaker.recordError();
    breaker.recordError(); // tripped
    assert.equal(breaker.isTripped(), true);

    breaker.recordSuccess();
    assert.equal(breaker.getErrorCount(), 0);
    assert.equal(breaker.isTripped(), false);
});

test("breaker can trip again after reset via success", () => {
    const breaker = createConsecutiveErrorBreaker(2);
    breaker.recordError();
    breaker.recordError(); // tripped
    assert.equal(breaker.isTripped(), true);

    breaker.recordSuccess(); // reset
    assert.equal(breaker.isTripped(), false);

    breaker.recordError();
    const trippedAgain = breaker.recordError(); // tripped again
    assert.equal(trippedAgain, true);
    assert.equal(breaker.isTripped(), true);
});

test("manual reset clears counter and trip state", () => {
    const breaker = createConsecutiveErrorBreaker(2);
    breaker.recordError();
    breaker.recordError(); // tripped
    assert.equal(breaker.isTripped(), true);

    breaker.reset();
    assert.equal(breaker.getErrorCount(), 0);
    assert.equal(breaker.isTripped(), false);
});

test("custom threshold of 1 trips on first error", () => {
    const breaker = createConsecutiveErrorBreaker(1);
    const tripped = breaker.recordError();
    assert.equal(tripped, true);
    assert.equal(breaker.isTripped(), true);
});

test("success between errors prevents tripping", () => {
    const breaker = createConsecutiveErrorBreaker(3);
    breaker.recordError(); // 1
    breaker.recordError(); // 2
    breaker.recordSuccess(); // reset
    breaker.recordError(); // 1 again
    breaker.recordError(); // 2 again
    assert.equal(breaker.isTripped(), false);
    assert.equal(breaker.getErrorCount(), 2);
});

test("half-opens for one probe after the cooldown elapses", () => {
    const harness = createBreakerHarness();
    harness.breaker.recordError();
    harness.breaker.recordError();
    harness.breaker.recordError();

    assert.equal(harness.breaker.isTripped(), true);
    harness.advanceBy(59_000);
    assert.equal(harness.breaker.isTripped(), true);
    harness.advanceBy(1_001);
    assert.equal(harness.breaker.isTripped(), false);
    assert.equal(harness.breaker.isTripped(), true);
});

test("one error during the half-open probe immediately re-trips", () => {
    const harness = createBreakerHarness();
    harness.breaker.recordError();
    harness.breaker.recordError();
    harness.breaker.recordError();
    harness.advanceBy(60_000);
    assert.equal(harness.breaker.isTripped(), false);

    assert.equal(harness.breaker.recordError(), true);
    assert.equal(harness.breaker.isTripped(), true);
});

test("success during the half-open probe fully resets the breaker", () => {
    const harness = createBreakerHarness();
    harness.breaker.recordError();
    harness.breaker.recordError();
    harness.breaker.recordError();
    harness.advanceBy(60_000);
    assert.equal(harness.breaker.isTripped(), false);

    harness.breaker.recordSuccess();
    assert.equal(harness.breaker.getErrorCount(), 0);
    assert.equal(harness.breaker.recordError(), false);
    assert.equal(harness.breaker.recordError(), false);
    assert.equal(harness.breaker.isTripped(), false);
});

test("error count remains consecutive across the half-open transition", () => {
    const harness = createBreakerHarness();
    harness.breaker.recordError();
    harness.breaker.recordError();
    harness.breaker.recordError();
    assert.equal(harness.breaker.getErrorCount(), 3);

    harness.advanceBy(60_000);
    assert.equal(harness.breaker.isTripped(), false);
    assert.equal(harness.breaker.getErrorCount(), 3);

    harness.breaker.recordError();
    assert.equal(harness.breaker.getErrorCount(), 4);
});
