import assert from "node:assert/strict";
import test from "node:test";
import {
    ADVANCE_PLAY_INTENT_TTL_MS,
    isAdvancePlayIntentFresh,
    resolveLoadAutoplayDecision,
} from "../../components/player/audioPlaybackOrchestratorPolicy";

test("solo/host loads autoplay from local playing state (existing behavior)", () => {
    assert.equal(
        resolveLoadAutoplayDecision({
            wasPlayingBeforeLoad: true,
            isListenTogetherFollower: false,
        }),
        true,
    );
    assert.equal(
        resolveLoadAutoplayDecision({
            wasPlayingBeforeLoad: false,
            isListenTogetherFollower: false,
        }),
        false,
    );
});

test("Listen Together follower loads never autoplay from local state", () => {
    // The follower's playback starts are owned by the LT protocol: the
    // synchronized play-at (and delta resumes) call resume() explicitly.
    // Local wasPlaying leaking into the load caused an audible blip of
    // track-start audio before the ready gate paused it.
    assert.equal(
        resolveLoadAutoplayDecision({
            wasPlayingBeforeLoad: true,
            isListenTogetherFollower: true,
        }),
        false,
    );
    assert.equal(
        resolveLoadAutoplayDecision({
            wasPlayingBeforeLoad: false,
            isListenTogetherFollower: true,
        }),
        false,
    );
});

test("a declared queue-advance intent forces autoplay even when playing state reads false", () => {
    // Under the native engine the element's pause fires before ended, so
    // both the isPlaying mirror and engine.isPlaying() can be false by the
    // time the advanced track loads (GH #53).
    assert.equal(
        resolveLoadAutoplayDecision({
            wasPlayingBeforeLoad: false,
            isListenTogetherFollower: false,
            hasAdvancePlayIntent: true,
        }),
        true,
    );
});

test("advance intent never overrides the Listen Together follower rule", () => {
    assert.equal(
        resolveLoadAutoplayDecision({
            wasPlayingBeforeLoad: false,
            isListenTogetherFollower: true,
            hasAdvancePlayIntent: true,
        }),
        false,
    );
});

test("advance play intent freshness is bounded by the TTL", () => {
    assert.equal(isAdvancePlayIntentFresh(null, 10_000), false);
    assert.equal(isAdvancePlayIntentFresh(10_000, 10_001), true);
    assert.equal(
        isAdvancePlayIntentFresh(10_000, 10_000 + ADVANCE_PLAY_INTENT_TTL_MS - 1),
        true,
    );
    assert.equal(
        isAdvancePlayIntentFresh(10_000, 10_000 + ADVANCE_PLAY_INTENT_TTL_MS),
        false,
    );
    // A clock that moved backwards must not validate a future stamp.
    assert.equal(isAdvancePlayIntentFresh(10_000, 9_000), false);
});
