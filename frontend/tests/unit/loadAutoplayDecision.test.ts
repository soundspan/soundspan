import assert from "node:assert/strict";
import test from "node:test";
import { resolveLoadAutoplayDecision } from "../../components/player/audioPlaybackOrchestratorPolicy";

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
