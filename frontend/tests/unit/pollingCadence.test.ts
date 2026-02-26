import assert from "node:assert/strict";
import test from "node:test";
import {
    resolveAdaptivePollingInterval,
    resolveFixedPollingInterval,
    resolvePollingEnabled,
} from "../../hooks/pollingCadence.ts";

test("resolvePollingEnabled defaults to true and preserves explicit false", () => {
    assert.equal(resolvePollingEnabled(undefined), true);
    assert.equal(resolvePollingEnabled(true), true);
    assert.equal(resolvePollingEnabled(false), false);
});

test("resolveFixedPollingInterval disables polling when not enabled", () => {
    assert.equal(resolveFixedPollingInterval(true, 30_000), 30_000);
    assert.equal(resolveFixedPollingInterval(false, 30_000), false);
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
