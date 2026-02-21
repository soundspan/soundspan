export interface TrustedTrackPositionInput {
    fallbackPositionSec: number;
    fallbackTrackId?: string | null;
    playbackType: string;
    currentTrackId: string | null;
    targetTrackId: string;
    isLoading: boolean;
    activeEngineTrackId: string | null;
    enginePositionSec: number;
    maxEngineDriftSec?: number;
}

export interface StartupFallbackDecisionInput {
    isLoading: boolean;
    sourceKind: "segmented" | "direct";
    requestLoadId: number;
    activeLoadId: number;
}

export interface BufferingRecoveryDecisionInput {
    machineIsBuffering: boolean;
    machineIsPlaying: boolean;
    engineIsPlaying: boolean;
}

export type BufferingRecoveryAction =
    | "transition_playing"
    | "force_playing"
    | "noop";

const DEFAULT_MAX_ENGINE_DRIFT_SEC = 15;
const DEFAULT_SEEK_TOLERANCE_SEC = 5;

/**
 * Resolve the safest trusted playback position for segmented handoff/recovery.
 * Falls back to local context time when engine position appears stale or invalid.
 */
export function resolveTrustedTrackPositionSec(
    input: TrustedTrackPositionInput,
): number {
    const fallbackPosition = Math.max(0, input.fallbackPositionSec || 0);
    if (input.playbackType !== "track") {
        return fallbackPosition;
    }
    if (
        input.fallbackTrackId &&
        input.fallbackTrackId !== input.targetTrackId
    ) {
        return 0;
    }
    if (input.currentTrackId !== input.targetTrackId) {
        return fallbackPosition;
    }
    if (input.isLoading) {
        return fallbackPosition;
    }
    if (input.activeEngineTrackId !== input.targetTrackId) {
        return fallbackPosition;
    }

    const enginePosition = Math.max(0, input.enginePositionSec);
    if (!Number.isFinite(enginePosition)) {
        return fallbackPosition;
    }

    const maxEngineDriftSec = Math.max(
        0,
        input.maxEngineDriftSec ?? DEFAULT_MAX_ENGINE_DRIFT_SEC,
    );
    if (Math.abs(enginePosition - fallbackPosition) > maxEngineDriftSec) {
        return fallbackPosition;
    }

    return enginePosition;
}

/**
 * Decide whether segmented startup should immediately fall back to direct mode.
 * This keeps fallback behavior deterministic when load attempts race.
 */
export function shouldFallbackSegmentedStartupToDirect(
    input: StartupFallbackDecisionInput,
): boolean {
    return (
        input.sourceKind === "segmented" &&
        input.isLoading &&
        input.requestLoadId === input.activeLoadId
    );
}

/**
 * Decide how buffering recovery should reconcile state-machine and engine state.
 */
export function resolveBufferingRecoveryAction(
    input: BufferingRecoveryDecisionInput,
): BufferingRecoveryAction {
    if (input.machineIsBuffering) {
        return "transition_playing";
    }
    if (!input.machineIsPlaying && input.engineIsPlaying) {
        return "force_playing";
    }
    return "noop";
}

/**
 * Seek continuity tolerance check used by podcast/direct seek verification paths.
 */
export function isSeekWithinTolerance(
    actualPositionSec: number,
    requestedPositionSec: number,
    toleranceSec: number = DEFAULT_SEEK_TOLERANCE_SEC,
): boolean {
    if (!Number.isFinite(actualPositionSec) || !Number.isFinite(requestedPositionSec)) {
        return false;
    }

    const normalizedTolerance = Math.max(0, toleranceSec);
    return (
        Math.abs(actualPositionSec - requestedPositionSec) <= normalizedTolerance
    );
}
