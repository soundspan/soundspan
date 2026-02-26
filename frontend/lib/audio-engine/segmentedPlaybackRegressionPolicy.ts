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

export interface StartupRetryDecisionInput {
    isLoading: boolean;
    sourceKind: "segmented" | "direct";
    requestLoadId: number;
    activeLoadId: number;
}

export interface StartupRetryDelayInput extends StartupRetryDecisionInput {
    startupAttemptStartedAtMs: number;
    retryTimeoutMs: number;
    nowMs?: number;
}

export interface BufferingRecoveryDecisionInput {
    machineIsBuffering: boolean;
    machineIsPlaying: boolean;
    engineIsPlaying: boolean;
}

export interface StartupGuardedRecoveryPositionInput {
    targetTrackId: string;
    trustedPositionSec: number;
    startupStabilityTrackId: string | null;
    startupFirstProgressAtMs: number | null;
}

export type BufferingRecoveryAction =
    | "transition_playing"
    | "force_playing"
    | "noop";

const DEFAULT_MAX_ENGINE_DRIFT_SEC = 15;
const DEFAULT_SEEK_TOLERANCE_SEC = 5;
const DEFAULT_STARTUP_PROGRESS_THRESHOLD_SEC = 0.25;

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
 * During startup failures, stale local timestamps can survive long enough to
 * trigger a large forward seek on recovery handoff. If we have not observed
 * any startup progress for the active track yet, force recovery anchor to 0s.
 */
export function resolveStartupGuardedRecoveryPositionSec(
    input: StartupGuardedRecoveryPositionInput,
): number {
    const trustedPositionSec = Math.max(0, input.trustedPositionSec || 0);
    const startupProgressThresholdSec = DEFAULT_STARTUP_PROGRESS_THRESHOLD_SEC;
    const startupTrackMatches = input.startupStabilityTrackId === input.targetTrackId;
    const startupProgressObserved =
        startupTrackMatches && input.startupFirstProgressAtMs !== null;

    if (
        startupTrackMatches &&
        !startupProgressObserved &&
        trustedPositionSec > startupProgressThresholdSec
    ) {
        return 0;
    }

    return trustedPositionSec;
}

/**
 * Decide whether the active load should run segmented startup timeout retry logic.
 * This keeps retry behavior deterministic when load attempts race.
 */
export function shouldRetrySegmentedStartupTimeout(
    input: StartupRetryDecisionInput,
): boolean {
    return (
        input.sourceKind === "segmented" &&
        input.isLoading &&
        input.requestLoadId === input.activeLoadId
    );
}

/**
 * Resolve remaining delay before a segmented startup timeout retry.
 * Returns null when retry no longer applies to the active load attempt.
 */
export function resolveSegmentedStartupRetryDelayMs(
    input: StartupRetryDelayInput,
): number | null {
    if (!shouldRetrySegmentedStartupTimeout(input)) {
        return null;
    }

    const timeoutMs = Math.max(0, input.retryTimeoutMs);
    const nowMs =
        typeof input.nowMs === "number" && Number.isFinite(input.nowMs)
            ? input.nowMs
            : Date.now();
    const startedAtMs = Number.isFinite(input.startupAttemptStartedAtMs)
        ? input.startupAttemptStartedAtMs
        : nowMs;
    const elapsedMs = Math.max(0, nowMs - startedAtMs);

    return Math.max(0, timeoutMs - elapsedMs);
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
