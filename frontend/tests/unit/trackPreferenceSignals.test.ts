import assert from "node:assert/strict";
import test from "node:test";
import { getNextTrackPreferenceSignal } from "../../hooks/trackPreferenceSignals.ts";

test("thumbs up toggles to clear when already active", () => {
    assert.equal(getNextTrackPreferenceSignal("clear", "thumbs_up"), "thumbs_up");
    assert.equal(
        getNextTrackPreferenceSignal("thumbs_up", "thumbs_up"),
        "clear"
    );
});

test("thumbs down toggles to clear when already active", () => {
    assert.equal(
        getNextTrackPreferenceSignal("clear", "thumbs_down"),
        "thumbs_down"
    );
    assert.equal(
        getNextTrackPreferenceSignal("thumbs_down", "thumbs_down"),
        "clear"
    );
});

test("switching between up and down replaces prior state", () => {
    assert.equal(
        getNextTrackPreferenceSignal("thumbs_down", "thumbs_up"),
        "thumbs_up"
    );
    assert.equal(
        getNextTrackPreferenceSignal("thumbs_up", "thumbs_down"),
        "thumbs_down"
    );
});
