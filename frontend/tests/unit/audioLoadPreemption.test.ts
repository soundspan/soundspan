import assert from "node:assert/strict";
import test from "node:test";
import {
    shouldAllowInitialPersistedTrackResume,
    shouldPreemptInFlightAudioLoad,
} from "../../lib/audio-load-preemption.ts";

test("preempts when a different media selection arrives during loading", () => {
    assert.equal(
        shouldPreemptInFlightAudioLoad({
            currentMediaId: "track-b",
            previousMediaId: "track-a",
            isLoading: true,
        }),
        true,
    );
});

test("does not preempt when not loading", () => {
    assert.equal(
        shouldPreemptInFlightAudioLoad({
            currentMediaId: "track-b",
            previousMediaId: "track-a",
            isLoading: false,
        }),
        false,
    );
});

test("does not preempt when media id did not change", () => {
    assert.equal(
        shouldPreemptInFlightAudioLoad({
            currentMediaId: "track-a",
            previousMediaId: "track-a",
            isLoading: true,
        }),
        false,
    );
});

test("does not preempt when either id is missing", () => {
    assert.equal(
        shouldPreemptInFlightAudioLoad({
            currentMediaId: null,
            previousMediaId: "track-a",
            isLoading: true,
        }),
        false,
    );
    assert.equal(
        shouldPreemptInFlightAudioLoad({
            currentMediaId: "track-a",
            previousMediaId: null,
            isLoading: true,
        }),
        false,
    );
});

test("treats empty-string ids as present values for change detection", () => {
    assert.equal(
        shouldPreemptInFlightAudioLoad({
            currentMediaId: "",
            previousMediaId: "track-a",
            isLoading: true,
        }),
        true,
    );
    assert.equal(
        shouldPreemptInFlightAudioLoad({
            currentMediaId: "",
            previousMediaId: "",
            isLoading: true,
        }),
        false,
    );
});

test("only allows persisted resume on initial non-segmented track load", () => {
    assert.equal(
        shouldAllowInitialPersistedTrackResume({
            isInitialTrackLoad: true,
            segmentedStartupEligible: false,
            listenTogetherActiveOrPending: false,
        }),
        true,
    );
    assert.equal(
        shouldAllowInitialPersistedTrackResume({
            isInitialTrackLoad: false,
            segmentedStartupEligible: false,
            listenTogetherActiveOrPending: false,
        }),
        false,
    );
    assert.equal(
        shouldAllowInitialPersistedTrackResume({
            isInitialTrackLoad: true,
            segmentedStartupEligible: true,
            listenTogetherActiveOrPending: false,
        }),
        false,
    );
    assert.equal(
        shouldAllowInitialPersistedTrackResume({
            isInitialTrackLoad: true,
            segmentedStartupEligible: false,
            listenTogetherActiveOrPending: true,
        }),
        false,
    );
});
