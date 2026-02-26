import type { StreamingEngineMode } from "../audio-engine/types";

const VALID_STREAMING_ENGINE_MODES = new Set<StreamingEngineMode>([
    "videojs",
    "howler-rollback",
]);
const VALID_SEGMENTED_VHS_PROFILES = new Set(["balanced", "legacy"]);
const SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MIN_MS = 1500;
const SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MAX_MS = 15000;

export type SegmentedVhsProfile = "balanced" | "legacy";
export type RuntimeConfigEnvironment = Record<string, string | undefined>;

const normalizeConfigString = (
    value: string | null | undefined
): string | null => {
    const normalized = value?.trim().toLowerCase();
    return normalized || null;
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

    return `window.__SOUNDSPAN_RUNTIME_CONFIG__ = Object.assign(
  {},
  window.__SOUNDSPAN_RUNTIME_CONFIG__ || {},
  {
    STREAMING_ENGINE_MODE: ${modeJson},
    SEGMENTED_VHS_PROFILE: ${segmentedVhsProfileJson},
    SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MS: ${segmentedStartupFallbackTimeoutJson},
    LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED: ${listenTogetherSegmentedPlaybackEnabledJson},
  },
);
`;
};
