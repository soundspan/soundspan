import assert from "node:assert/strict";
import test from "node:test";
import {
    buildRuntimeConfigPayload,
    normalizeStreamingEngineMode,
} from "../../lib/runtime-config/normalization";

test("normalizeStreamingEngineMode trims, lowercases, and validates values", () => {
    assert.equal(normalizeStreamingEngineMode(" Howler "), "howler");
    assert.equal(normalizeStreamingEngineMode(" NATIVE "), "native");
    assert.equal(normalizeStreamingEngineMode("native"), "native");
    assert.equal(normalizeStreamingEngineMode(""), null);
    assert.equal(normalizeStreamingEngineMode("invalid"), null);
    // Removed with the Tauri desktop integration (issue #607) and segmented
    // streaming (issue #534): leftover env values must be ignored, never
    // honored.
    assert.equal(normalizeStreamingEngineMode("tauri-native"), null);
    assert.equal(normalizeStreamingEngineMode("videojs"), null);
    assert.equal(normalizeStreamingEngineMode(" VIDEOJS "), null);
});

test("buildRuntimeConfigPayload emits expected runtime JS for valid env values", () => {
    const payload = buildRuntimeConfigPayload({
        STREAMING_ENGINE_MODE: " HOWLER ",
    });

    assert.equal(
        payload,
        `window.__SOUNDSPAN_RUNTIME_CONFIG__ = Object.assign(
  {},
  window.__SOUNDSPAN_RUNTIME_CONFIG__ || {},
  {
    STREAMING_ENGINE_MODE: "howler",
  },
);
`,
    );
});

test("buildRuntimeConfigPayload fails closed for invalid env values", () => {
    const payload = buildRuntimeConfigPayload({
        STREAMING_ENGINE_MODE: "videojs",
        SEGMENTED_VHS_PROFILE: "balanced",
        SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS: "5000",
    });

    assert.equal(
        payload,
        `window.__SOUNDSPAN_RUNTIME_CONFIG__ = Object.assign(
  {},
  window.__SOUNDSPAN_RUNTIME_CONFIG__ || {},
  {
    STREAMING_ENGINE_MODE: null,
  },
);
`,
    );
    // Removed SEGMENTED_* env values never reach the runtime payload.
    assert.doesNotMatch(payload, /SEGMENTED_/);
});
