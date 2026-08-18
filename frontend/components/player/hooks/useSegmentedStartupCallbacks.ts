import { useCallback } from "react";
import type { AudioEngineVhsResponsePayload } from "@/lib/audio-engine/types";
import { getListenTogetherSessionSnapshot } from "@/lib/listen-together-session";
import {
    SEGMENTED_HANDOFF_PROGRESS_RESET_MIN_DELTA_SEC,
    SEGMENTED_HANDOFF_RESET_STABLE_PLAYBACK_MS,
    SEGMENTED_STARTUP_AUDIBLE_THRESHOLD_SEC,
    SEGMENTED_STARTUP_MAX_SESSION_RESETS,
    SEGMENTED_STARTUP_RECOVERY_WINDOW_MS,
    SEGMENTED_STARTUP_RETRY_BUDGET_MAX,
} from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import {
    audioEngine,
    logPlaybackClientMetric,
} from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import {
    durationBetweenMs,
    isListenTogetherSegmentedPlaybackEnabled,
    resolveSegmentedStartupCorrelationId,
    resolveSegmentedUnexpectedStopStartupGuardMs,
} from "@/lib/audio-engine/audioPlaybackRuntimePolicy";
import { resolveSegmentAssetNameFromUri } from "@/lib/audio-engine/segmentedRepresentationPolicy";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import type { SegmentedStartupTimelineSnapshot } from "./audioPlaybackOrchestratorTypes";

interface UseSegmentedStartupCallbacksOptions {
    refs: PlaybackOrchestratorRefs;
}

/** Preserves the segmented startup callback sequence used by the orchestrator. */
export function useSegmentedStartupCallbacks({
    refs,
}: UseSegmentedStartupCallbacksOptions) {
    const {
        segmentedHandoffLastRecoveryRef,
        segmentedStartupTimelineRef,
        segmentedStartupSessionResetCountRef,
        segmentedStartupFallbackTimeoutRef,
        segmentedManifestNudgeTimeoutsRef,
        outputStateRef,
        loudnessGainFactorRef,
        segmentedStartupStabilityRef,
        segmentedUnexpectedStopStartupGuardRef,
        segmentedPrewarmRetryTimeoutsRef,
        segmentedPrewarmValidationAbortControllersRef,
        segmentedPrewarmValidationSessionByKeyRef,
    } = refs;

    const isListenTogetherSegmentedPlaybackAllowed =
        useCallback((): boolean => {
            const hasActiveListenTogetherGroup = Boolean(
                getListenTogetherSessionSnapshot()?.groupId,
            );
            if (!hasActiveListenTogetherGroup) {
                return true;
            }
            return isListenTogetherSegmentedPlaybackEnabled();
        }, []);

    const shouldResetHandoffBudgetAfterRecovery = useCallback(
        (trackId: string, resumeAtSec: number): boolean => {
            const normalizedResumeAtSec = Math.max(0, resumeAtSec);
            const previousRecovery = segmentedHandoffLastRecoveryRef.current;
            const now = Date.now();
            const elapsedSincePreviousRecoveryMs =
                previousRecovery.recoveredAtMs > 0
                    ? Math.max(0, now - previousRecovery.recoveredAtMs)
                    : Number.POSITIVE_INFINITY;
            const progressedSincePreviousRecoverySec =
                normalizedResumeAtSec - previousRecovery.resumeAtSec;
            const shouldReset =
                previousRecovery.trackId !== trackId ||
                (elapsedSincePreviousRecoveryMs >=
                    SEGMENTED_HANDOFF_RESET_STABLE_PLAYBACK_MS &&
                    progressedSincePreviousRecoverySec >=
                        SEGMENTED_HANDOFF_PROGRESS_RESET_MIN_DELTA_SEC);
            segmentedHandoffLastRecoveryRef.current = {
                trackId,
                resumeAtSec: normalizedResumeAtSec,
                recoveredAtMs: now,
            };
            return shouldReset;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    const ensureSegmentedStartupTimeline = useCallback(
        (
            trackId: string,
            loadId: number,
            loadAttemptStartedAtMs: number,
        ): SegmentedStartupTimelineSnapshot => {
            const existing = segmentedStartupTimelineRef.current;
            if (
                existing &&
                existing.trackId === trackId &&
                existing.loadId === loadId
            ) {
                return existing;
            }

            const created: SegmentedStartupTimelineSnapshot = {
                trackId,
                loadId,
                startupCorrelationId: resolveSegmentedStartupCorrelationId(
                    trackId,
                    loadId,
                ),
                sessionId: null,
                sourceType: "unknown",
                initSource: null,
                loadAttemptStartedAtMs,
                createRequestedAtMs: null,
                createResolvedAtMs: null,
                manifestFirstResponseAtMs: null,
                firstChunkResponseAtMs: null,
                firstChunkName: null,
                audibleAtMs: null,
                startupRetryCount: 0,
                emitted: false,
            };
            segmentedStartupTimelineRef.current = created;
            return created;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    const emitSegmentedStartupTimeline = useCallback(
        (
            outcome:
                | "audible"
                | "playback_error"
                | "unexpected_stop"
                | "startup_timeout",
            fields: Record<string, unknown> = {},
        ): void => {
            const current = segmentedStartupTimelineRef.current;
            if (!current || current.emitted) {
                return;
            }

            current.emitted = true;
            const timelineAnchorMs =
                current.createRequestedAtMs ?? current.loadAttemptStartedAtMs;
            const createToManifestMs = durationBetweenMs(
                timelineAnchorMs,
                current.manifestFirstResponseAtMs,
            );
            const manifestToFirstChunkMs = durationBetweenMs(
                current.manifestFirstResponseAtMs,
                current.firstChunkResponseAtMs,
            );
            const firstChunkToAudibleMs = durationBetweenMs(
                current.firstChunkResponseAtMs,
                current.audibleAtMs,
            );
            const totalToAudibleMs = durationBetweenMs(
                timelineAnchorMs,
                current.audibleAtMs,
            );

            logPlaybackClientMetric("player.startup_timeline", {
                outcome,
                trackId: current.trackId,
                sessionId: current.sessionId,
                sourceType: current.sourceType,
                initSource: current.initSource,
                loadId: current.loadId,
                startupCorrelationId: current.startupCorrelationId,
                cmcdObjectType: "a",
                startupRetryCount: current.startupRetryCount,
                retryBudgetMax: SEGMENTED_STARTUP_RETRY_BUDGET_MAX,
                retryBudgetRemaining: Math.max(
                    0,
                    SEGMENTED_STARTUP_RETRY_BUDGET_MAX -
                        current.startupRetryCount,
                ),
                startupRecoveryWindowMs: SEGMENTED_STARTUP_RECOVERY_WINDOW_MS,
                startupSessionResetsUsed:
                    segmentedStartupSessionResetCountRef.current,
                startupSessionResetsMax: SEGMENTED_STARTUP_MAX_SESSION_RESETS,
                hadCreateRequest: current.createRequestedAtMs !== null,
                createLatencyMs: durationBetweenMs(
                    current.createRequestedAtMs,
                    current.createResolvedAtMs,
                ),
                createToManifestMs,
                manifestToFirstChunkMs,
                firstChunkToAudibleMs,
                totalToAudibleMs,
                firstChunkName: current.firstChunkName,
                loadAttemptStartedAtMs: current.loadAttemptStartedAtMs,
                createRequestedAtMs: current.createRequestedAtMs,
                createResolvedAtMs: current.createResolvedAtMs,
                manifestFirstResponseAtMs: current.manifestFirstResponseAtMs,
                firstChunkResponseAtMs: current.firstChunkResponseAtMs,
                audibleAtMs: current.audibleAtMs,
                ...fields,
            });
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    const clearSegmentedStartupFallback = useCallback(() => {
        if (segmentedStartupFallbackTimeoutRef.current) {
            clearTimeout(segmentedStartupFallbackTimeoutRef.current);
            segmentedStartupFallbackTimeoutRef.current = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, []);

    const clearSegmentedManifestNudges = useCallback(() => {
        const nudgeTimeouts = segmentedManifestNudgeTimeoutsRef.current;
        if (nudgeTimeouts.length === 0) {
            return;
        }
        for (const timeout of nudgeTimeouts) {
            clearTimeout(timeout);
        }
        segmentedManifestNudgeTimeoutsRef.current = [];
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, []);

    const applyCurrentOutputState = useCallback(() => {
        const { volume: currentVolume, isMuted: currentMuted } =
            outputStateRef.current;
        // User volume and loudness-normalization gain form one multiplicative
        // chain; the engine clamps the composite into its 0..1 range.
        audioEngine.setVolume(currentVolume * loudnessGainFactorRef.current);
        audioEngine.setMuted(currentMuted);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, []);

    const markSegmentedStartupRampWindow = useCallback(
        (trackId: string | null, reason: string): void => {
            segmentedStartupStabilityRef.current = {
                trackId,
                firstProgressAtMs: null,
                lastObservedProgressSec: 0,
            };
            segmentedUnexpectedStopStartupGuardRef.current = {
                trackId,
                suppressUntilMs: trackId
                    ? Date.now() +
                      resolveSegmentedUnexpectedStopStartupGuardMs()
                    : 0,
                reason: trackId ? reason : null,
            };
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    const noteSegmentedStartupProgress = useCallback(
        (trackId: string | null, timeSec: number): void => {
            if (!trackId || !Number.isFinite(timeSec)) {
                return;
            }

            const current = segmentedStartupStabilityRef.current;
            if (current.trackId !== trackId) {
                segmentedStartupStabilityRef.current = {
                    trackId,
                    firstProgressAtMs: null,
                    lastObservedProgressSec: Math.max(0, timeSec),
                };
                return;
            }

            const normalizedTimeSec = Math.max(0, timeSec);
            const progressed =
                normalizedTimeSec > current.lastObservedProgressSec + 0.15;
            if (progressed && normalizedTimeSec >= 0.2) {
                segmentedStartupStabilityRef.current = {
                    ...current,
                    firstProgressAtMs: current.firstProgressAtMs ?? Date.now(),
                    lastObservedProgressSec: normalizedTimeSec,
                };
                return;
            }

            if (normalizedTimeSec > current.lastObservedProgressSec) {
                segmentedStartupStabilityRef.current = {
                    ...current,
                    lastObservedProgressSec: normalizedTimeSec,
                };
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    const noteSegmentedStartupVhsResponse = useCallback(
        (payload: AudioEngineVhsResponsePayload): void => {
            const current = segmentedStartupTimelineRef.current;
            if (!current || current.emitted) {
                return;
            }

            if (payload.trackId && payload.trackId !== current.trackId) {
                return;
            }
            if (
                payload.sessionId &&
                current.sessionId &&
                payload.sessionId !== current.sessionId
            ) {
                return;
            }
            if (payload.hasError) {
                return;
            }

            if (
                payload.kind === "manifest" &&
                current.manifestFirstResponseAtMs === null
            ) {
                current.manifestFirstResponseAtMs = payload.timestampMs;
                return;
            }

            if (
                payload.kind === "segment" &&
                current.firstChunkResponseAtMs === null
            ) {
                current.firstChunkResponseAtMs = payload.timestampMs;
                current.firstChunkName = resolveSegmentAssetNameFromUri(
                    payload.uri,
                );
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    const hasStartupChunkResponseForTrack = useCallback(
        (trackId: string): boolean => {
            const startupTimeline = segmentedStartupTimelineRef.current;
            if (!startupTimeline || startupTimeline.trackId !== trackId) {
                return false;
            }
            return startupTimeline.firstChunkResponseAtMs !== null;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    const hasStartupAudibleForTrack = useCallback(
        (trackId: string): boolean => {
            const startupTimeline = segmentedStartupTimelineRef.current;
            if (!startupTimeline || startupTimeline.trackId !== trackId) {
                return false;
            }
            return startupTimeline.audibleAtMs !== null;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    const noteSegmentedStartupAudible = useCallback(
        (trackId: string | null, currentTimeSec: number): void => {
            if (
                !trackId ||
                currentTimeSec < SEGMENTED_STARTUP_AUDIBLE_THRESHOLD_SEC
            ) {
                return;
            }

            const current = segmentedStartupTimelineRef.current;
            if (
                !current ||
                current.emitted ||
                current.trackId !== trackId ||
                !current.sessionId
            ) {
                return;
            }

            if (current.audibleAtMs === null) {
                current.audibleAtMs = Date.now();
            }
            emitSegmentedStartupTimeline("audible");
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [emitSegmentedStartupTimeline],
    );

    const clearSegmentedPrewarmRetry = useCallback((sessionKey: string) => {
        const existingTimeout =
            segmentedPrewarmRetryTimeoutsRef.current.get(sessionKey);
        if (!existingTimeout) {
            return;
        }
        clearTimeout(existingTimeout);
        segmentedPrewarmRetryTimeoutsRef.current.delete(sessionKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, []);

    const abortSegmentedPrewarmValidation = useCallback(
        (
            sessionId: string,
            reason: "superseded" | "track_change" | "unmount",
        ): void => {
            const controller =
                segmentedPrewarmValidationAbortControllersRef.current.get(
                    sessionId,
                );
            if (!controller) {
                return;
            }
            controller.abort(reason);
            segmentedPrewarmValidationAbortControllersRef.current.delete(
                sessionId,
            );
            for (const [
                sessionKey,
                activeSessionId,
            ] of segmentedPrewarmValidationSessionByKeyRef.current) {
                if (activeSessionId === sessionId) {
                    segmentedPrewarmValidationSessionByKeyRef.current.delete(
                        sessionKey,
                    );
                }
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    const abortAllSegmentedPrewarmValidations = useCallback(
        (reason: "track_change" | "unmount"): void => {
            const controllers =
                segmentedPrewarmValidationAbortControllersRef.current;
            for (const controller of controllers.values()) {
                controller.abort(reason);
            }
            controllers.clear();
            segmentedPrewarmValidationSessionByKeyRef.current.clear();
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    return {
        isListenTogetherSegmentedPlaybackAllowed,
        shouldResetHandoffBudgetAfterRecovery,
        ensureSegmentedStartupTimeline,
        emitSegmentedStartupTimeline,
        clearSegmentedStartupFallback,
        clearSegmentedManifestNudges,
        applyCurrentOutputState,
        markSegmentedStartupRampWindow,
        noteSegmentedStartupProgress,
        noteSegmentedStartupVhsResponse,
        hasStartupChunkResponseForTrack,
        hasStartupAudibleForTrack,
        noteSegmentedStartupAudible,
        clearSegmentedPrewarmRetry,
        abortSegmentedPrewarmValidation,
        abortAllSegmentedPrewarmValidations,
    };
}
