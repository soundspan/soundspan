import assert from "node:assert/strict";
import test from "node:test";
import {
    buildRuntimeConfigPayload,
    normalizeListenTogetherSegmentedPlaybackEnabled,
    normalizeSegmentedStartupFallbackTimeoutMs,
    normalizeSegmentedVhsProfile,
    normalizeStreamingEngineMode,
} from "../../lib/runtime-config/normalization.ts";

test("normalizeStreamingEngineMode trims, lowercases, and validates values", () => {
    assert.equal(normalizeStreamingEngineMode(" VIDEOJS "), "videojs");
    assert.equal(
        normalizeStreamingEngineMode(" Howler-Rollback "),
        "howler-rollback"
    );
    assert.equal(normalizeStreamingEngineMode(""), null);
    assert.equal(normalizeStreamingEngineMode("invalid"), null);
});

test("normalizeSegmentedVhsProfile trims, lowercases, and validates values", () => {
    assert.equal(normalizeSegmentedVhsProfile(" BALANCED "), "balanced");
    assert.equal(normalizeSegmentedVhsProfile(" LEGACY "), "legacy");
    assert.equal(normalizeSegmentedVhsProfile(""), null);
    assert.equal(normalizeSegmentedVhsProfile("fast"), null);
});

test("normalizeSegmentedStartupFallbackTimeoutMs clamps and rejects invalid values", () => {
    assert.equal(normalizeSegmentedStartupFallbackTimeoutMs("1000"), 1500);
    assert.equal(normalizeSegmentedStartupFallbackTimeoutMs("5000"), 5000);
    assert.equal(normalizeSegmentedStartupFallbackTimeoutMs("60000"), 15000);
    assert.equal(normalizeSegmentedStartupFallbackTimeoutMs(""), null);
    assert.equal(normalizeSegmentedStartupFallbackTimeoutMs("bogus"), null);
});

test("normalizeListenTogetherSegmentedPlaybackEnabled trims, lowercases, and validates values", () => {
    assert.equal(
        normalizeListenTogetherSegmentedPlaybackEnabled(" TRUE "),
        true
    );
    assert.equal(
        normalizeListenTogetherSegmentedPlaybackEnabled(" false "),
        false
    );
    assert.equal(normalizeListenTogetherSegmentedPlaybackEnabled(""), null);
    assert.equal(
        normalizeListenTogetherSegmentedPlaybackEnabled("enable"),
        null
    );
});

test("buildRuntimeConfigPayload emits expected runtime JS for valid env values", () => {
    const payload = buildRuntimeConfigPayload({
        STREAMING_ENGINE_MODE: " VIDEOJS ",
        SEGMENTED_VHS_PROFILE: " BALANCED ",
        SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS: "1200",
        LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED: "true",
    });

    assert.equal(
        payload,
        `window.__SOUNDSPAN_RUNTIME_CONFIG__ = Object.assign(
  {},
  window.__SOUNDSPAN_RUNTIME_CONFIG__ || {},
  {
    STREAMING_ENGINE_MODE: "videojs",
    SEGMENTED_VHS_PROFILE: "balanced",
    SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS: 1500,
    LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED: true,
  },
);
`,
    );
});

test("buildRuntimeConfigPayload fails closed for invalid env values", () => {
    const payload = buildRuntimeConfigPayload({
        STREAMING_ENGINE_MODE: "not-a-mode",
        SEGMENTED_VHS_PROFILE: "not-a-profile",
        SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS: "NaN",
        LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED: "not-a-bool",
    });

    assert.equal(
        payload,
        `window.__SOUNDSPAN_RUNTIME_CONFIG__ = Object.assign(
  {},
  window.__SOUNDSPAN_RUNTIME_CONFIG__ || {},
  {
    STREAMING_ENGINE_MODE: null,
    SEGMENTED_VHS_PROFILE: null,
    SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS: null,
    LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED: null,
  },
);
`,
    );
});
