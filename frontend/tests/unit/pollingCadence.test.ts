import assert from "node:assert/strict";
import test from "node:test";
import {
    resolveAdaptivePollingInterval,
    resolveFixedPollingInterval,
    resolvePollingEnabled,
    resolvePollingJitter,
} from "../../hooks/pollingCadence";

test("resolvePollingEnabled defaults to true and preserves explicit false", () => {
    assert.equal(resolvePollingEnabled(undefined), true);
    assert.equal(resolvePollingEnabled(true), true);
    assert.equal(resolvePollingEnabled(false), false);
});

test("resolveFixedPollingInterval disables polling when not enabled", () => {
    assert.equal(resolveFixedPollingInterval(true, 30_000), 30_000);
    assert.equal(resolveFixedPollingInterval(false, 30_000), false);
});

test("resolvePollingJitter returns value within [0, maxJitterMs)", () => {
    for (let i = 0; i < 100; i++) {
        const jitter = resolvePollingJitter(5000);
        assert.ok(jitter >= 0, `jitter ${jitter} should be >= 0`);
        assert.ok(jitter < 5000, `jitter ${jitter} should be < 5000`);
        assert.equal(jitter, Math.floor(jitter), "jitter should be an integer");
    }
});

test("resolvePollingJitter returns 0 for maxJitterMs of 0", () => {
    assert.equal(resolvePollingJitter(0), 0);
});

test("resolveAdaptivePollingInterval switches between active and idle cadences", () => {
    assert.equal(
        resolveAdaptivePollingInterval({
            enabled: true,
            hasActiveItems: true,
            activeIntervalMs: 10_000,
            idleIntervalMs: 30_000,
        }),
        10_000
    );
    assert.equal(
        resolveAdaptivePollingInterval({
            enabled: true,
            hasActiveItems: false,
            activeIntervalMs: 10_000,
            idleIntervalMs: 30_000,
        }),
        30_000
    );
    assert.equal(
        resolveAdaptivePollingInterval({
            enabled: false,
            hasActiveItems: true,
            activeIntervalMs: 10_000,
            idleIntervalMs: 30_000,
        }),
        false
    );
});
