import assert from "node:assert/strict";
import test from "node:test";
import { isHowlerModeEnabled } from "../../lib/audio-engine/engineMode";
import { DEFAULT_STREAMING_ENGINE_MODE } from "../../lib/audio-engine/types";

test("isHowlerModeEnabled stays strict equality on howler", () => {
    assert.equal(isHowlerModeEnabled("howler"), true);
    assert.equal(isHowlerModeEnabled("native"), false);
    // Removed with segmented streaming (issue #534): a leftover videojs
    // value must never select the howler slot via loose comparison.
    assert.equal(isHowlerModeEnabled("videojs"), false);
});

test("the native element engine is the default mode (1.7.x flip)", () => {
    // No runtime config in unit tests → resolveStreamingEngineMode falls
    // back to the compiled default, which is now "native". Howler remains
    // selectable (STREAMING_ENGINE_MODE=howler) as the gated fallback.
    assert.equal(DEFAULT_STREAMING_ENGINE_MODE, "native");
    assert.equal(isHowlerModeEnabled(), false);
});
