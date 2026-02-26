import type { StreamingEngineMode } from "../audio-engine/types";

const VALID_STREAMING_ENGINE_MODES = new Set<StreamingEngineMode>([
    "videojs",
    "howler",
]);
const VALID_SEGMENTED_VHS_PROFILES = new Set(["balanced", "legacy"]);
const SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MIN_MS = 1500;
const SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MAX_MS = 22000;
const DEFAULT_SEGMENTED_LOCAL_SEG_DURATION_SEC = 2;
const DEFAULT_DASH_FRAGMENT_DURATION_RATIO = 0.1;
const DASH_FRAGMENT_DURATION_PRECISION_DIGITS = 6;

export type SegmentedVhsProfile = "balanced" | "legacy";
export type RuntimeConfigEnvironment = Record<string, string | undefined>;

const normalizeConfigString = (
    value: string | null | undefined
): string | null => {
    const normalized = value?.trim().toLowerCase();
    return normalized || null;
};

const normalizeBooleanConfig = (
    value: string | null | undefined
): boolean | null => {
    const normalized = normalizeConfigString(value);
    if (!normalized) {
        return null;
    }
    if (normalized === "true") {
        return true;
    }
    if (normalized === "false") {
        return false;
    }
    return null;
};

export const normalizeStreamingEngineMode = (
    value: string | null | undefined
): StreamingEngineMode | null => {
    const normalized = normalizeConfigString(value);
    if (!normalized) {
        return null;
    }

    return VALID_STREAMING_ENGINE_MODES.has(normalized as StreamingEngineMode)
        ? (normalized as StreamingEngineMode)
        : null;
};

export const normalizeSegmentedVhsProfile = (
    value: string | null | undefined
): SegmentedVhsProfile | null => {
    const normalized = normalizeConfigString(value);
    if (!normalized) {
        return null;
    }

    return VALID_SEGMENTED_VHS_PROFILES.has(normalized)
        ? (normalized as SegmentedVhsProfile)
        : null;
};

export const normalizeSegmentedStartupFallbackTimeoutMs = (
    value: string | null | undefined
): number | null => {
    const normalized = normalizeConfigString(value);
    if (!normalized) {
        return null;
    }

    const parsed = Number.parseInt(normalized, 10);
    if (!Number.isFinite(parsed)) {
        return null;
    }

    return Math.min(
        SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MAX_MS,
        Math.max(SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MIN_MS, parsed)
    );
};

export const normalizeListenTogetherSegmentedPlaybackEnabled = (
    value: string | null | undefined
): boolean | null => {
    return normalizeBooleanConfig(value);
};

export const normalizeHowlerIosLockscreenWorkaroundsEnabled = (
    value: string | null | undefined
): boolean | null => {
    return normalizeBooleanConfig(value);
};

export const normalizeSegmentedSessionPrewarmEnabled = (
    value: string | null | undefined
): boolean | null => {
    return normalizeBooleanConfig(value);
};

const normalizePositiveNumber = (
    value: string | null | undefined
): number | null => {
    if (value == null) {
        return null;
    }

    const parsed = Number.parseFloat(value.trim());
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return null;
    }

    return parsed;
};

export const normalizeSegmentedEffectiveFragmentDurationSec = (
    env: RuntimeConfigEnvironment
): number => {
    const segmentDurationSec =
        normalizePositiveNumber(env.SEGMENTED_LOCAL_SEG_DURATION_SEC) ??
        DEFAULT_SEGMENTED_LOCAL_SEG_DURATION_SEC;
    const fragmentDurationRatio =
        normalizePositiveNumber(env.SEGMENTED_DASH_FRAGMENT_DURATION_RATIO) ??
        DEFAULT_DASH_FRAGMENT_DURATION_RATIO;

    return Number.parseFloat(
        (segmentDurationSec * fragmentDurationRatio).toFixed(
            DASH_FRAGMENT_DURATION_PRECISION_DIGITS
        )
    );
};

export const buildRuntimeConfigPayload = (
    env: RuntimeConfigEnvironment
): string => {
    const mode = normalizeStreamingEngineMode(env.STREAMING_ENGINE_MODE);
    const modeJson = mode ? JSON.stringify(mode) : "null";
    const segmentedVhsProfile = normalizeSegmentedVhsProfile(
        env.SEGMENTED_VHS_PROFILE
    );
    const segmentedVhsProfileJson = segmentedVhsProfile
        ? JSON.stringify(segmentedVhsProfile)
        : "null";
    const segmentedStartupFallbackTimeoutMs =
        normalizeSegmentedStartupFallbackTimeoutMs(
            env.SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS
        );
    const segmentedStartupFallbackTimeoutJson =
        segmentedStartupFallbackTimeoutMs !== null
            ? String(segmentedStartupFallbackTimeoutMs)
            : "null";
    const listenTogetherSegmentedPlaybackEnabled =
        normalizeListenTogetherSegmentedPlaybackEnabled(
            env.LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED
        );
    const listenTogetherSegmentedPlaybackEnabledJson =
        listenTogetherSegmentedPlaybackEnabled !== null
            ? String(listenTogetherSegmentedPlaybackEnabled)
            : "null";
    const howlerIosLockscreenWorkaroundsEnabled =
        normalizeHowlerIosLockscreenWorkaroundsEnabled(
            env.HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED
        );
    const howlerIosLockscreenWorkaroundsEnabledJson =
        howlerIosLockscreenWorkaroundsEnabled !== null
            ? String(howlerIosLockscreenWorkaroundsEnabled)
            : "null";
    const segmentedSessionPrewarmEnabled =
        normalizeSegmentedSessionPrewarmEnabled(
            env.SEGMENTED_SESSION_PREWARM_ENABLED
        );
    const segmentedSessionPrewarmEnabledJson =
        segmentedSessionPrewarmEnabled !== null
            ? String(segmentedSessionPrewarmEnabled)
            : "null";
    const segmentedEffectiveFragmentDurationSec =
        normalizeSegmentedEffectiveFragmentDurationSec(env);
    const segmentedEffectiveFragmentDurationSecJson = String(
        segmentedEffectiveFragmentDurationSec
    );

    return `window.__SOUNDSPAN_RUNTIME_CONFIG__ = Object.assign(
  {},
  window.__SOUNDSPAN_RUNTIME_CONFIG__ || {},
  {
    STREAMING_ENGINE_MODE: ${modeJson},
    SEGMENTED_VHS_PROFILE: ${segmentedVhsProfileJson},
    SEGMENTED_EFFECTIVE_FRAGMENT_DURATION_SEC: ${segmentedEffectiveFragmentDurationSecJson},
    SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS: ${segmentedStartupFallbackTimeoutJson},
    LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED: ${listenTogetherSegmentedPlaybackEnabledJson},
    HOWLER_IOS_LOCKSCREEN_WORKAROUNDS_ENABLED: ${howlerIosLockscreenWorkaroundsEnabledJson},
    SEGMENTED_SESSION_PREWARM_ENABLED: ${segmentedSessionPrewarmEnabledJson},
  },
);
`;
};
