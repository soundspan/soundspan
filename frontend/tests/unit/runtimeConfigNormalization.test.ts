import assert from "node:assert/strict";
import test from "node:test";
import {
    buildRuntimeConfigPayload,
    normalizeHowlerIosLockscreenWorkaroundsEnabled,
    normalizeListenTogetherSegmentedPlaybackEnabled,
    normalizeSegmentedEffectiveFragmentDurationSec,
    normalizeSegmentedSessionPrewarmEnabled,
    normalizeSegmentedStartupFallbackTimeoutMs,
    normalizeSegmentedVhsProfile,
    normalizeStreamingEngineMode,
} from "../../lib/runtime-config/normalization.ts";

test("normalizeStreamingEngineMode trims, lowercases, and validates values", () => {
    assert.equal(normalizeStreamingEngineMode(" VIDEOJS "), "videojs");
    assert.equal(
        normalizeStreamingEngineMode(" Howler "),
        "howler"
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
    assert.equal(normalizeSegmentedStartupFallbackTimeoutMs("60000"), 22000);
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

test("normalizeHowlerIosLockscreenWorkaroundsEnabled trims, lowercases, and validates values", () => {
    assert.equal(
        normalizeHowlerIosLockscreenWorkaroundsEnabled(" TRUE "),
        true
    );
    assert.equal(
        normalizeHowlerIosLockscreenWorkaroundsEnabled(" false "),
        false
    );
    assert.equal(normalizeHowlerIosLockscreenWorkaroundsEnabled(""), null);
    assert.equal(
        normalizeHowlerIosLockscreenWorkaroundsEnabled("enable"),
        null
    );
});

test("normalizeSegmentedSessionPrewarmEnabled trims, lowercases, and validates values", () => {
    assert.equal(normalizeSegmentedSessionPrewarmEnabled(" TRUE "), true);
    assert.equal(normalizeSegmentedSessionPrewarmEnabled(" false "), false);
    assert.equal(normalizeSegmentedSessionPrewarmEnabled(""), null);
    assert.equal(normalizeSegmentedSessionPrewarmEnabled("enable"), null);
});

test("normalizeSegmentedEffectiveFragmentDurationSec follows backend defaults and env override", () => {
    assert.equal(normalizeSegmentedEffectiveFragmentDurationSec({}), 0.2);
    assert.equal(
        normalizeSegmentedEffectiveFragmentDurationSec({
            SEGMENTED_LOCAL_SEG_DURATION_SEC: " 0.5 ",
        }),
        0.05
    );
    assert.equal(
        normalizeSegmentedEffectiveFragmentDurationSec({
            SEGMENTED_LOCAL_SEG_DURATION_SEC: " 0.5 ",
            SEGMENTED_DASH_FRAGMENT_DURATION_RATIO: "0.25",
        }),
        0.125
    );
    assert.equal(
        normalizeSegmentedEffectiveFragmentDurationSec({
            SEGMENTED_LOCAL_SEG_DURATION_SEC: "0",
        }),
        0.2
    );
    assert.equal(
        normalizeSegmentedEffectiveFragmentDurationSec({
            SEGMENTED_LOCAL_SEG_DURATION_SEC: "invalid",
        }),
        0.2
    );
});

test("normalizeSegmentedEffectiveFragmentDurationSec fails closed on non-positive values and preserves precision", () => {
    assert.equal(
        normalizeSegmentedEffectiveFragmentDurationSec({
            SEGMENTED_LOCAL_SEG_DURATION_SEC: "3",
            SEGMENTED_DASH_FRAGMENT_DURATION_RATIO: "-1",
        }),
        0.3
    );
    assert.equal(
        normalizeSegmentedEffectiveFragmentDurationSec({
            SEGMENTED_LOCAL_SEG_DURATION_SEC: "-2",
            SEGMENTED_DASH_FRAGMENT_DURATION_RATIO: "0.5",
        }),
        1
    );
    assert.equal(
        normalizeSegmentedEffectiveFragmentDurationSec({
            SEGMENTED_LOCAL_SEG_DURATION_SEC: "3.3333333",
            SEGMENTED_DASH_FRAGMENT_DURATION_RATIO: "0.3",
        }),
        1
    );
});

test("buildRuntimeConfigPayload emits expected runtime JS for valid env values", () => {
    const payload = buildRuntimeConfigPayload({
        STREAMING_ENGINE_MODE: " VIDEOJS ",
        SEGMENTED_VHS_PROFILE: " BALANCED ",
        SEGMENTED_LOCAL_SEG_DURATION_SEC: "0.5",
        SEGMENTED_DASH_FRAGMENT_DURATION_RATIO: "0.25",
        SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS: "1200",
        LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED: "true",
        HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED: " TRUE ",
        SEGMENTED_SESSION_PREWARM_ENABLED: "false",
    });

    assert.equal(
        payload,
        `window.__SOUNDSPAN_RUNTIME_CONFIG__ = Object.assign(
  {},
  window.__SOUNDSPAN_RUNTIME_CONFIG__ || {},
  {
    STREAMING_ENGINE_MODE: "videojs",
    SEGMENTED_VHS_PROFILE: "balanced",
    SEGMENTED_EFFECTIVE_FRAGMENT_DURATION_SEC: 0.125,
    SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS: 1500,
    LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED: true,
    HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED: true,
    SEGMENTED_SESSION_PREWARM_ENABLED: false,
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
        HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED: "not-a-bool",
        SEGMENTED_SESSION_PREWARM_ENABLED: "not-a-bool",
    });

    assert.equal(
        payload,
        `window.__SOUNDSPAN_RUNTIME_CONFIG__ = Object.assign(
  {},
  window.__SOUNDSPAN_RUNTIME_CONFIG__ || {},
  {
    STREAMING_ENGINE_MODE: null,
    SEGMENTED_VHS_PROFILE: null,
    SEGMENTED_EFFECTIVE_FRAGMENT_DURATION_SEC: 0.2,
    SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS: null,
    LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED: null,
    HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED: null,
    SEGMENTED_SESSION_PREWARM_ENABLED: null,
  },
);
`,
    );
});
