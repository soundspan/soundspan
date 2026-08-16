import assert from "node:assert/strict";
import test from "node:test";
import {
    clampSegmentedStartupFallbackTimeoutMs,
    durationBetweenMs,
    resolveSegmentedStartupCorrelationId,
    resolveStartupChunkNamesFromManifest,
} from "../../lib/audio-engine/audioPlaybackRuntimePolicy";

test("clamps segmented startup fallback timeouts to the existing bounds", () => {
    assert.equal(clampSegmentedStartupFallbackTimeoutMs(100), 1_500);
    assert.equal(clampSegmentedStartupFallbackTimeoutMs(8_000), 8_000);
    assert.equal(clampSegmentedStartupFallbackTimeoutMs(30_000), 22_000);
});

test("extracts at most two unique startup chunks from a manifest", () => {
    assert.deepEqual(
        resolveStartupChunkNamesFromManifest(
            "chunk-a.m4s chunk-a.m4s chunk-b.webm chunk-c.m4s",
        ),
        ["chunk-a.m4s", "chunk-b.webm"],
    );
});

test("keeps startup correlation and duration calculations stable", () => {
    assert.equal(
        resolveSegmentedStartupCorrelationId("track-7", 3),
        "segmented:track-7:3",
    );
    assert.equal(durationBetweenMs(10, 25), 15);
    assert.equal(durationBetweenMs(25, 10), 0);
    assert.equal(durationBetweenMs(null, 10), null);
});
