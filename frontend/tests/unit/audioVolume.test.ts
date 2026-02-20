import assert from "node:assert/strict";
import test from "node:test";
import {
    DEFAULT_AUDIO_VOLUME,
    clampAudioVolume,
    resolveInitialAudioVolume,
} from "../../lib/audio-volume.ts";

test("clampAudioVolume bounds values to 0..1 with safe fallback", () => {
    assert.equal(clampAudioVolume(0.4), 0.4);
    assert.equal(clampAudioVolume(-1), 0);
    assert.equal(clampAudioVolume(5), 1);
    assert.equal(clampAudioVolume(Number.NaN), DEFAULT_AUDIO_VOLUME);
});

test("resolveInitialAudioVolume parses persisted values deterministically", () => {
    assert.equal(resolveInitialAudioVolume(undefined), DEFAULT_AUDIO_VOLUME);
    assert.equal(resolveInitialAudioVolume(null), DEFAULT_AUDIO_VOLUME);
    assert.equal(resolveInitialAudioVolume("0.75"), 0.75);
    assert.equal(resolveInitialAudioVolume("2.0"), 1);
    assert.equal(resolveInitialAudioVolume("-0.2"), 0);
    assert.equal(
        resolveInitialAudioVolume("not-a-number"),
        DEFAULT_AUDIO_VOLUME
    );
});
