import assert from "node:assert/strict";
import test from "node:test";
import { resolveHydratedPlaybackIntent } from "../../lib/playback-intent.ts";

test("resolveHydratedPlaybackIntent restores resumed and paused states from server", () => {
    assert.equal(resolveHydratedPlaybackIntent({ isPlaying: true }, false), true);
    assert.equal(resolveHydratedPlaybackIntent({ isPlaying: false }, true), false);
});

test("resolveHydratedPlaybackIntent falls back to local intent when server field is absent", () => {
    assert.equal(resolveHydratedPlaybackIntent(undefined, true), true);
    assert.equal(resolveHydratedPlaybackIntent(null, false), false);
    assert.equal(resolveHydratedPlaybackIntent({}, true), true);
});
