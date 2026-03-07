import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    clampTime,
    formatDuration,
    formatTime,
    formatTimeRemaining,
} from "../../utils/formatTime";

describe("formatTime", () => {
    test("formats mm:ss and hh:mm:ss values", () => {
        assert.equal(formatTime(0), "0:00");
        assert.equal(formatTime(30), "0:30");
        assert.equal(formatTime(125), "2:05");
        assert.equal(formatTime(3600), "1:00:00");
        assert.equal(formatTime(7325), "2:02:05");
    });

    test("fails closed for invalid values", () => {
        assert.equal(formatTime(-1), "0:00");
        assert.equal(formatTime(Number.NaN), "0:00");
        assert.equal(formatTime(Number.POSITIVE_INFINITY), "0:00");
    });
});

describe("clampTime", () => {
    test("clamps values into the duration range", () => {
        assert.equal(clampTime(0, 100), 0);
        assert.equal(clampTime(50, 100), 50);
        assert.equal(clampTime(100, 100), 100);
        assert.equal(clampTime(150, 100), 100);
        assert.equal(clampTime(3480, 3274), 3274);
    });

    test("handles zero and negative durations safely", () => {
        assert.equal(clampTime(-5, 100), 0);
        assert.equal(clampTime(50, 0), 50);
        assert.equal(clampTime(-10, 0), 0);
    });
});

describe("formatTimeRemaining", () => {
    test("formats remaining time with a negative prefix", () => {
        assert.equal(formatTimeRemaining(0), "0:00");
        assert.equal(formatTimeRemaining(30), "-0:30");
        assert.equal(formatTimeRemaining(125), "-2:05");
        assert.equal(formatTimeRemaining(3600), "-1:00:00");
        assert.equal(formatTimeRemaining(7325), "-2:02:05");
    });

    test("fails closed for invalid values", () => {
        assert.equal(formatTimeRemaining(-5), "0:00");
        assert.equal(formatTimeRemaining(Number.NaN), "0:00");
    });
});

describe("formatDuration", () => {
    test("formats short and long durations", () => {
        assert.equal(formatDuration(0), "0m");
        assert.equal(formatDuration(60), "1m");
        assert.equal(formatDuration(3600), "1h");
        assert.equal(formatDuration(5400), "1h 30m");
    });
});

test("podcast overflow values stay clamped to duration", () => {
    const podcastCurrentTime = 3480;
    const podcastDuration = 3274;
    const clampedTime = clampTime(podcastCurrentTime, podcastDuration);
    const remaining = Math.max(0, podcastDuration - clampedTime);
    const progress = Math.min(
        100,
        Math.max(0, (clampedTime / podcastDuration) * 100)
    );

    assert.equal(clampedTime, podcastDuration);
    assert.equal(formatTime(clampedTime), "54:34");
    assert.equal(formatTimeRemaining(remaining), "0:00");
    assert.equal(progress, 100);
});

test("in-progress podcast still shows remaining time", () => {
    const remaining = Math.max(0, 3274 - clampTime(1000, 3274));
    assert.equal(formatTimeRemaining(remaining), "-37:54");
});
