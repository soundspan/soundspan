import assert from "node:assert/strict";
import test from "node:test";
import { getNextTrackPreferenceSignal } from "../../hooks/trackPreferenceSignals.ts";

test("like toggle sets thumbs_up for clear or thumbs_down state", () => {
    assert.equal(getNextTrackPreferenceSignal("clear"), "thumbs_up");
    assert.equal(getNextTrackPreferenceSignal("thumbs_down"), "thumbs_up");
});

test("like toggle clears when thumbs_up is already active", () => {
    assert.equal(getNextTrackPreferenceSignal("thumbs_up"), "clear");
});
