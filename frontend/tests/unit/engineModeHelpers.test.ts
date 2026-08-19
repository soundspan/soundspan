import assert from "node:assert/strict";
import test from "node:test";
import {
    isHowlerModeEnabled,
    isSegmentedModeEnabled,
} from "../../lib/audio-engine/engineMode";
import { DEFAULT_STREAMING_ENGINE_MODE } from "../../lib/audio-engine/types";

test("isSegmentedModeEnabled is true only for videojs mode", () => {
    assert.equal(isSegmentedModeEnabled("videojs"), true);
    assert.equal(isSegmentedModeEnabled("howler"), false);
    // The native element engine is a DIRECT playback mode: it must never
    // activate segmented startup/prewarm/session paths (a bare <audio>
    // element cannot play DASH manifests).
    assert.equal(isSegmentedModeEnabled("native"), false);
    assert.equal(isSegmentedModeEnabled("not-a-mode"), false);
    // No runtime config in unit tests → default howler → not segmented.
    assert.equal(isSegmentedModeEnabled(), false);
});

test("isHowlerModeEnabled stays strict equality on howler", () => {
    assert.equal(isHowlerModeEnabled("howler"), true);
    assert.equal(isHowlerModeEnabled("native"), false);
    assert.equal(isHowlerModeEnabled("videojs"), false);
});

test("the native element engine is the default mode (1.7.x flip)", () => {
    // No runtime config in unit tests → resolveStreamingEngineMode falls
    // back to the compiled default, which is now "native". Howler remains
    // selectable (STREAMING_ENGINE_MODE=howler) as the gated fallback.
    assert.equal(DEFAULT_STREAMING_ENGINE_MODE, "native");
    assert.equal(isHowlerModeEnabled(), false);
    assert.equal(isSegmentedModeEnabled(), false);
});
