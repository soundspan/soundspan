import assert from "node:assert/strict";
import test from "node:test";
import {
    clampNonNegativePlaybackTime,
    clampPlaybackTimeToUpperBound,
    resolvePlaybackTimeUpperBound,
} from "../../lib/audio-playback-normalization.ts";

test("clampNonNegativePlaybackTime clamps values below zero", () => {
    assert.equal(clampNonNegativePlaybackTime(-12), 0);
    assert.equal(clampNonNegativePlaybackTime(42), 42);
});

test("resolvePlaybackTimeUpperBound keeps existing duration selection behavior", () => {
    assert.equal(resolvePlaybackTimeUpperBound(200, 180), 180);
    assert.equal(resolvePlaybackTimeUpperBound(200, 0), 200);
    assert.equal(resolvePlaybackTimeUpperBound(0, 180), 180);
    assert.equal(resolvePlaybackTimeUpperBound(0, 0), 0);
});

test("clampPlaybackTimeToUpperBound clamps to [0, upperBound] when bound is positive", () => {
    assert.equal(clampPlaybackTimeToUpperBound(-5, 180), 0);
    assert.equal(clampPlaybackTimeToUpperBound(40, 180), 40);
    assert.equal(clampPlaybackTimeToUpperBound(220, 180), 180);
});

test("clampPlaybackTimeToUpperBound keeps unbounded non-negative behavior when bound is non-positive", () => {
    assert.equal(clampPlaybackTimeToUpperBound(-5, 0), 0);
    assert.equal(clampPlaybackTimeToUpperBound(220, 0), 220);
});
