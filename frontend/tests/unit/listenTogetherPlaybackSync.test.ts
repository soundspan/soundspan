import assert from "node:assert/strict";
import { test } from "node:test";
import {
    computeCompensatedTargetMs,
    resolveFollowerSeekTarget,
} from "../../lib/listenTogetherPlaybackSync";

test("compensation subtracts positive client clock skew", () => {
    const targetMs = computeCompensatedTargetMs(
        2_000,
        9_000,
        13_000,
        3_000,
        5_000,
    );

    assert.equal(targetMs, 3_000);
});

test("compensation floors negative age and caps network delay", () => {
    assert.equal(
        computeCompensatedTargetMs(2_000, 10_000, 9_000, 0, 5_000),
        2_000,
    );
    assert.equal(
        computeCompensatedTargetMs(2_000, 1_000, 10_000, 0, 5_000),
        7_000,
    );
});

test("follower seek target clamps to track duration and flags real drift", () => {
    const { targetSec, drifted } = resolveFollowerSeekTarget({
        positionMs: 200_000,
        serverTimeMs: 1_000,
        isPlaying: true,
        trackDurationSec: 180,
        currentTimeSec: 10,
        nowMs: 2_000,
        clockOffsetMs: 0,
    });

    assert.equal(targetSec, 180);
    assert.equal(drifted, true);
});

test("follower seek target reports no drift within the 1.5s threshold", () => {
    const paused = resolveFollowerSeekTarget({
        positionMs: 30_000,
        serverTimeMs: 9_000,
        isPlaying: false,
        trackDurationSec: 240,
        currentTimeSec: 31.0,
        nowMs: 50_000,
        clockOffsetMs: 0,
    });

    assert.equal(paused.targetSec, 30);
    assert.equal(paused.drifted, false);
});
