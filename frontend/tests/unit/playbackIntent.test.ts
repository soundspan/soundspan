import assert from "node:assert/strict";
import test from "node:test";
import {
    resolveHydratedPlaybackIntent,
    resolveMachinePlaybackIntent,
} from "../../lib/playback-intent.ts";

test("resolveHydratedPlaybackIntent restores resumed and paused states from server", () => {
    assert.equal(resolveHydratedPlaybackIntent({ isPlaying: true }, false), true);
    assert.equal(resolveHydratedPlaybackIntent({ isPlaying: false }, true), false);
});

test("resolveHydratedPlaybackIntent falls back to local intent when server field is absent", () => {
    assert.equal(resolveHydratedPlaybackIntent(undefined, true), true);
    assert.equal(resolveHydratedPlaybackIntent(null, false), false);
    assert.equal(resolveHydratedPlaybackIntent({}, true), true);
});

test("resolveMachinePlaybackIntent preserves prior intent through transitional states", () => {
    assert.equal(resolveMachinePlaybackIntent("LOADING", true), true);
    assert.equal(resolveMachinePlaybackIntent("RECOVERING", true), true);
    assert.equal(resolveMachinePlaybackIntent("BUFFERING", true), true);
    assert.equal(resolveMachinePlaybackIntent("SEEKING", true), true);

    assert.equal(resolveMachinePlaybackIntent("LOADING", false), false);
    assert.equal(resolveMachinePlaybackIntent("RECOVERING", false), false);
    assert.equal(resolveMachinePlaybackIntent("BUFFERING", false), false);
    assert.equal(resolveMachinePlaybackIntent("SEEKING", false), false);
});

test("resolveMachinePlaybackIntent reflects stable machine states", () => {
    assert.equal(resolveMachinePlaybackIntent("PLAYING", false), true);
    assert.equal(resolveMachinePlaybackIntent("READY", true), false);
    assert.equal(resolveMachinePlaybackIntent("IDLE", true), false);
    assert.equal(resolveMachinePlaybackIntent("ERROR", true), false);
});
