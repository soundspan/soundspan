import assert from "node:assert/strict";
import test from "node:test";
import {
    PLAYBACK_POLL_AFTER_LOCAL_SAVE_COOLDOWN_MS,
    parsePlaybackStateSaveTimestamp,
    shouldSkipPlaybackStatePoll,
} from "../../lib/playback-state-cadence.ts";

test("parsePlaybackStateSaveTimestamp normalizes invalid values to zero", () => {
    assert.equal(parsePlaybackStateSaveTimestamp(null), 0);
    assert.equal(parsePlaybackStateSaveTimestamp(""), 0);
    assert.equal(parsePlaybackStateSaveTimestamp("not-a-number"), 0);
    assert.equal(parsePlaybackStateSaveTimestamp("-10"), 0);
});

test("parsePlaybackStateSaveTimestamp keeps valid positive timestamps", () => {
    assert.equal(parsePlaybackStateSaveTimestamp("12345"), 12345);
});

test("shouldSkipPlaybackStatePoll enforces cooldown window", () => {
    const nowMs = 1_000_000;
    const insideCooldown =
        nowMs - (PLAYBACK_POLL_AFTER_LOCAL_SAVE_COOLDOWN_MS - 1);
    const outsideCooldown =
        nowMs - PLAYBACK_POLL_AFTER_LOCAL_SAVE_COOLDOWN_MS;

    assert.equal(shouldSkipPlaybackStatePoll(insideCooldown, nowMs), true);
    assert.equal(shouldSkipPlaybackStatePoll(outsideCooldown, nowMs), false);
    assert.equal(shouldSkipPlaybackStatePoll(0, nowMs), false);
});
