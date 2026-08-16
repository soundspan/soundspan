import type { SegmentedStreamingSessionResponse } from "@/lib/api";
import {
    LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED_KEY,
    SEGMENTED_PREWARM_EXPIRY_GUARD_MS,
    SEGMENTED_SESSION_PREWARM_ENABLED_DEFAULT,
    SEGMENTED_SESSION_PREWARM_ENABLED_KEY,
    SEGMENTED_STARTUP_FALLBACK_TIMEOUT_DEFAULT_MS,
    SEGMENTED_STARTUP_FALLBACK_TIMEOUT_KEY,
    SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MAX_MS,
    SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MIN_MS,
    SEGMENTED_UNEXPECTED_STOP_STARTUP_GUARD_MAX_MS,
    SEGMENTED_UNEXPECTED_STOP_STARTUP_GUARD_MIN_MS,
    SOUNDSPAN_RUNTIME_CONFIG_KEY,
} from "./audioPlaybackOrchestratorConstants";
import type { SegmentedTrackContext } from "./audioPlaybackTrackPolicy";

/** Builds the stable key used to cache a segmented session. */
export const buildSegmentedSessionKey = (
    context: SegmentedTrackContext,
): string => `${context.sourceType}:${context.sessionTrackId}`;

/** Returns the remaining segmented-session lifetime in milliseconds. */
export const getSegmentedSessionRemainingMs = (
    session: Pick<SegmentedStreamingSessionResponse, "expiresAt">,
): number => {
    const expiresAtMs = Date.parse(session.expiresAt);
    if (!Number.isFinite(expiresAtMs)) {
        return Number.NEGATIVE_INFINITY;
    }
    return expiresAtMs - Date.now();
};

/** Reports whether a segmented session remains safe to consume. */
export const isSegmentedSessionUsable = (
    session: Pick<SegmentedStreamingSessionResponse, "expiresAt">,
): boolean => {
    return (
        getSegmentedSessionRemainingMs(session) >
        SEGMENTED_PREWARM_EXPIRY_GUARD_MS
    );
};

/** Clamps the segmented startup fallback to the supported bounds. */
export const clampSegmentedStartupFallbackTimeoutMs = (value: number): number =>
    Math.min(
        SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MAX_MS,
        Math.max(SEGMENTED_STARTUP_FALLBACK_TIMEOUT_MIN_MS, value),
    );

/** Reads one browser runtime-config value when a window is available. */
export const readRuntimeConfigValue = (key: string): unknown => {
    if (typeof window === "undefined") {
        return undefined;
    }

    const runtimeConfig = (
        window as Window & {
            [SOUNDSPAN_RUNTIME_CONFIG_KEY]?: Record<string, unknown>;
        }
    )[SOUNDSPAN_RUNTIME_CONFIG_KEY];
    return runtimeConfig?.[key];
};

/** Parses one runtime-config flag with an explicit fallback. */
export const resolveRuntimeConfigBoolean = (
    key: string,
    defaultValue: boolean = false,
): boolean => {
    const runtimeValue = readRuntimeConfigValue(key);
    if (typeof runtimeValue === "boolean") {
        return runtimeValue;
    }

    if (runtimeValue == null) {
        return defaultValue;
    }

    const normalized = String(runtimeValue).trim().toLowerCase();
    if (normalized === "true") {
        return true;
    }
    if (normalized === "false") {
        return false;
    }
    return defaultValue;
};

/** Reports whether Listen Together may use segmented playback. */
export const isListenTogetherSegmentedPlaybackEnabled = (): boolean =>
    resolveRuntimeConfigBoolean(
        LISTEN_TOGETHER_SEGMENTED_PLAYBACK_ENABLED_KEY,
        false,
    );

/** Reports whether background segmented-session prewarming is enabled. */
export const isSegmentedSessionPrewarmEnabled = (): boolean =>
    resolveRuntimeConfigBoolean(
        SEGMENTED_SESSION_PREWARM_ENABLED_KEY,
        SEGMENTED_SESSION_PREWARM_ENABLED_DEFAULT,
    );

/** Resolves the configured segmented startup fallback timeout. */
export const resolveSegmentedStartupFallbackTimeoutMs = (): number => {
    const runtimeValue = readRuntimeConfigValue(
        SEGMENTED_STARTUP_FALLBACK_TIMEOUT_KEY,
    );
    const parsedRuntimeValue =
        typeof runtimeValue === "number"
            ? runtimeValue
            : Number.parseInt(String(runtimeValue ?? ""), 10);

    if (!Number.isFinite(parsedRuntimeValue)) {
        return SEGMENTED_STARTUP_FALLBACK_TIMEOUT_DEFAULT_MS;
    }

    return clampSegmentedStartupFallbackTimeoutMs(parsedRuntimeValue);
};

/** Calculates a bounded duration between optional timestamps. */
export const durationBetweenMs = (
    startedAtMs: number | null,
    endedAtMs: number | null,
): number | null => {
    if (typeof startedAtMs !== "number" || typeof endedAtMs !== "number") {
        return null;
    }
    return Math.max(0, endedAtMs - startedAtMs);
};

/** Extracts the first two unique startup chunk names from a manifest. */
export const resolveStartupChunkNamesFromManifest = (
    manifestContents: string,
): string[] => {
    const matches = manifestContents.match(
        /chunk-[A-Za-z0-9_-]+\.(?:m4s|webm)/g,
    );
    if (!matches) {
        return [];
    }

    const uniqueMatches = new Set<string>();
    for (const match of matches) {
        uniqueMatches.add(match);
        if (uniqueMatches.size >= 2) {
            break;
        }
    }
    return [...uniqueMatches];
};

/** Builds the correlation identifier for one segmented startup load. */
export const resolveSegmentedStartupCorrelationId = (
    trackId: string,
    loadId: number,
): string => `segmented:${trackId}:${loadId}`;

/** Resolves the unexpected-stop guard window for segmented startup. */
export const resolveSegmentedUnexpectedStopStartupGuardMs = (): number => {
    const fallbackTimeoutMs = resolveSegmentedStartupFallbackTimeoutMs();
    const computedGuardMs = fallbackTimeoutMs + 4_000;
    return Math.min(
        SEGMENTED_UNEXPECTED_STOP_STARTUP_GUARD_MAX_MS,
        Math.max(
            SEGMENTED_UNEXPECTED_STOP_STARTUP_GUARD_MIN_MS,
            computedGuardMs,
        ),
    );
};
