/**
 * Pure decision helpers for direct-playback recovery: trusted-position
 * resolution, startup-guarded recovery anchoring, resume correlation,
 * buffering reconciliation, and seek-continuity tolerance.
 */

export interface TrustedTrackPositionInput {
    fallbackPositionSec: number;
    fallbackTrackId?: string | null;
    playbackType: string | null;
    currentTrackId: string | null;
    targetTrackId: string;
    isLoading: boolean;
    activeEngineTrackId: string | null;
    enginePositionSec: number;
    maxEngineDriftSec?: number;
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

export interface CorrelatedRecoveryResumeInput {
    requestedResumeAtSec: number;
    expectedTrackId: string;
    activeTrackId: string | null;
    expectedLoadId: number;
    activeLoadId: number;
    expectedSessionId?: string | null;
    activeSessionTrackId?: string | null;
    activeSessionId?: string | null;
}

export type CorrelatedRecoveryResumeMismatchReason =
    | "none"
    | "track_mismatch"
    | "load_mismatch"
    | "session_mismatch";

export interface CorrelatedRecoveryResumeDecision {
    resumeAtSec: number;
    matched: boolean;
    mismatchReason: CorrelatedRecoveryResumeMismatchReason;
}

export type BufferingRecoveryAction =
    | "transition_playing"
    | "force_playing"
    | "noop";

const DEFAULT_MAX_ENGINE_DRIFT_SEC = 15;
const DEFAULT_SEEK_TOLERANCE_SEC = 5;
const DEFAULT_STARTUP_PROGRESS_THRESHOLD_SEC = 0.25;

/**
 * Resolve the safest trusted playback position for handoff/recovery.
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
    const startupTrackMatches =
        input.startupStabilityTrackId === input.targetTrackId;
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
 * Enforce resume/handoff correlation so stale offsets cannot bleed into a
 * newer track/load/session transition.
 */
export function resolveCorrelatedRecoveryResumeDecision(
    input: CorrelatedRecoveryResumeInput,
): CorrelatedRecoveryResumeDecision {
    const requestedResumeAtSec =
        Number.isFinite(input.requestedResumeAtSec) &&
        typeof input.requestedResumeAtSec === "number"
            ? Math.max(0, input.requestedResumeAtSec)
            : 0;

    if (input.activeTrackId !== input.expectedTrackId) {
        return {
            resumeAtSec: 0,
            matched: false,
            mismatchReason: "track_mismatch",
        };
    }

    if (input.activeLoadId !== input.expectedLoadId) {
        return {
            resumeAtSec: 0,
            matched: false,
            mismatchReason: "load_mismatch",
        };
    }

    const expectedSessionId = input.expectedSessionId ?? null;
    if (expectedSessionId !== null) {
        if (
            input.activeSessionTrackId !== input.expectedTrackId ||
            input.activeSessionId !== expectedSessionId
        ) {
            return {
                resumeAtSec: 0,
                matched: false,
                mismatchReason: "session_mismatch",
            };
        }
    }

    return {
        resumeAtSec: requestedResumeAtSec,
        matched: true,
        mismatchReason: "none",
    };
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
    if (
        !Number.isFinite(actualPositionSec) ||
        !Number.isFinite(requestedPositionSec)
    ) {
        return false;
    }

    const normalizedTolerance = Math.max(0, toleranceSec);
    return (
        Math.abs(actualPositionSec - requestedPositionSec) <=
        normalizedTolerance
    );
}

export interface StartupStabilitySnapshot {
    trackId: string | null;
    firstProgressAtMs: number | null;
    lastObservedProgressSec: number;
}

/** Fresh stability window for a (re)started track load. */
export function createStartupStabilityWindow(
    trackId: string | null,
): StartupStabilitySnapshot {
    return {
        trackId,
        firstProgressAtMs: null,
        lastObservedProgressSec: 0,
    };
}

/**
 * Advances the startup-stability snapshot for one timeupdate. Real progress
 * (>= 0.2 s position, moving by more than 0.15 s) stamps firstProgressAtMs;
 * an engine that "plays" with frozen time never earns the stamp, which is
 * what the startup watchdog keys on.
 */
export function noteStartupProgressTransition(
    current: StartupStabilitySnapshot,
    trackId: string | null,
    timeSec: number,
    nowMs: number,
): StartupStabilitySnapshot {
    if (!trackId || !Number.isFinite(timeSec)) {
        return current;
    }

    if (current.trackId !== trackId) {
        return {
            trackId,
            firstProgressAtMs: null,
            lastObservedProgressSec: Math.max(0, timeSec),
        };
    }

    const normalizedTimeSec = Math.max(0, timeSec);
    const progressed =
        normalizedTimeSec > current.lastObservedProgressSec + 0.15;
    if (progressed && normalizedTimeSec >= 0.2) {
        return {
            ...current,
            firstProgressAtMs: current.firstProgressAtMs ?? nowMs,
            lastObservedProgressSec: normalizedTimeSec,
        };
    }

    if (normalizedTimeSec > current.lastObservedProgressSec) {
        return {
            ...current,
            lastObservedProgressSec: normalizedTimeSec,
        };
    }

    return current;
}
