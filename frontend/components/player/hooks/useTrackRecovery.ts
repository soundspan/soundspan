import { useCallback } from "react";
import type { AudioEngineManifestStallPayload } from "@/lib/audio-engine/types";
import { playbackStateMachine } from "@/lib/audio";
import {
    getListenTogetherSessionSnapshot,
    resolveListenTogetherFollowerGroupId,
    requestListenTogetherGroupResync,
    enqueueLatestListenTogetherHostTrackOperation,
} from "@/lib/listen-together-session";
import {
    LISTEN_TOGETHER_FOLLOWER_RECOVERY_COOLDOWN_MS,
    STARTUP_PLAYBACK_RECOVERY_DELAY_MS,
    STARTUP_PLAYBACK_RECOVERY_MAX_RECHECKS,
    STARTUP_PLAYBACK_RECOVERY_RECHECK_DELAY_MS,
    TRACK_ERROR_SKIP_DELAY_MS,
    TRANSIENT_TRACK_ERROR_RECOVERY_DELAY_MS,
    TRANSIENT_TRACK_ERROR_RECOVERY_MAX_ATTEMPTS,
    TRANSIENT_TRACK_ERROR_RECOVERY_WINDOW_MS,
} from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import {
    audioEngine,
    logPlaybackClientMetric,
} from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import {
    isLikelyTransientStreamError,
    resolveDirectTrackSourceType,
} from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { toast } from "sonner";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import type { usePlaybackRecoveryHelpers } from "./usePlaybackRecoveryHelpers";
import type { useSegmentedStartupCallbacks } from "./useSegmentedStartupCallbacks";

interface UseTrackRecoveryOptions {
    refs: PlaybackOrchestratorRefs;
    playbackRecoveryHelpers: ReturnType<typeof usePlaybackRecoveryHelpers>;
    segmentedStartupCallbacks: ReturnType<typeof useSegmentedStartupCallbacks>;
    next: () => void;
    setCurrentTime: (time: number) => void;
    setIsBuffering: (isBuffering: boolean) => void;
}

/** Preserves startup, transient-error, and queue-skip recovery callbacks. */
export function useTrackRecovery({
    refs,
    playbackRecoveryHelpers,
    segmentedStartupCallbacks,
    next,
    setCurrentTime,
    setIsBuffering,
}: UseTrackRecoveryOptions) {
    const {
        clearStartupPlaybackRecovery,
        clearPendingTrackErrorSkip,
        clearTransientTrackRecovery,
        resolveStartupSafeTrackPositionSec,
        resolveCorrelatedRecoveryResume,
        shouldForceCleanStartFromCorrelationMismatch,
    } = playbackRecoveryHelpers;
    const { hasStartupChunkResponseForTrack } = segmentedStartupCallbacks;
    const {
        startupRecoveryAttemptedTrackIdRef,
        startupRecoveryTimeoutRef,
        playbackTypeRef,
        desiredLoadPlayRef,
        loadIdRef,
        lastPlayingStateRef,
        currentTrackRef,
        segmentedStartupStabilityRef,
        isLoadingRef,
        startupRecoveryLoadListenerRef,
        activeSegmentedSessionRef,
        listenTogetherFollowerRecoveryRef,
        pendingTrackErrorSkipRef,
        pendingTrackErrorTrackIdRef,
        consecutiveErrorBreakerRef,
        queueLengthRef,
        lastTrackIdRef,
        trackErrorAdvanceFromTrackIdRef,
        advancePlayIntentAtMsRef,
        transientTrackRecoveryTrackIdRef,
        transientTrackRecoveryWindowStartedAtRef,
        transientTrackRecoveryAttemptRef,
        transientTrackRecoveryLoadListenerRef,
        transientTrackRecoveryTimeoutRef,
    } = refs;

    const scheduleStartupPlaybackRecovery = useCallback(
        (trackId: string | null, recheckCount: number = 0) => {
            if (!trackId) return;
            if (
                startupRecoveryAttemptedTrackIdRef.current === trackId &&
                recheckCount === 0
            ) {
                return;
            }

            const delayMs =
                recheckCount === 0
                    ? STARTUP_PLAYBACK_RECOVERY_DELAY_MS
                    : STARTUP_PLAYBACK_RECOVERY_RECHECK_DELAY_MS;

            clearStartupPlaybackRecovery();
            startupRecoveryTimeoutRef.current = setTimeout(() => {
                startupRecoveryTimeoutRef.current = null;

                if (playbackTypeRef.current !== "track") return;
                const desiredLoadPlay = desiredLoadPlayRef.current;
                const hasDesiredLoadPlay = Boolean(
                    desiredLoadPlay?.shouldPlay &&
                    desiredLoadPlay.loadId === loadIdRef.current,
                );
                if (!lastPlayingStateRef.current && !hasDesiredLoadPlay) return;
                if (currentTrackRef.current?.id !== trackId) return;
                const listenTogetherSession =
                    getListenTogetherSessionSnapshot();
                if (
                    listenTogetherSession?.groupId &&
                    !listenTogetherSession.isHost
                ) {
                    return;
                }

                const startupStability = segmentedStartupStabilityRef.current;
                const hasStartupProgress =
                    startupStability.trackId === trackId &&
                    startupStability.firstProgressAtMs !== null;
                const startupPlayingWithoutProgress =
                    audioEngine.isPlaying() && !hasStartupProgress;

                if (audioEngine.isPlaying() && hasStartupProgress) {
                    return;
                }

                if (isLoadingRef.current) {
                    if (recheckCount < STARTUP_PLAYBACK_RECOVERY_MAX_RECHECKS) {
                        // eslint-disable-next-line react-hooks/immutability -- Preserve the relocated bounded recursive retry callback.
                        scheduleStartupPlaybackRecovery(
                            trackId,
                            recheckCount + 1,
                        );
                    }
                    return;
                }

                if (
                    startupPlayingWithoutProgress &&
                    recheckCount < STARTUP_PLAYBACK_RECOVERY_MAX_RECHECKS
                ) {
                    scheduleStartupPlaybackRecovery(trackId, recheckCount + 1);
                    return;
                }

                if (startupRecoveryAttemptedTrackIdRef.current === trackId)
                    return;
                startupRecoveryAttemptedTrackIdRef.current = trackId;

                sharedFrontendLogger.warn(
                    "[AudioPlaybackOrchestrator] Startup playback watchdog triggered reload+retry",
                    {
                        startupPlayingWithoutProgress,
                        recheckCount,
                    },
                );

                const onReloaded = () => {
                    audioEngine.off("load", onReloaded);
                    startupRecoveryLoadListenerRef.current = null;

                    if (playbackTypeRef.current !== "track") return;
                    const desiredLoadPlay = desiredLoadPlayRef.current;
                    const hasDesiredLoadPlay = Boolean(
                        desiredLoadPlay?.shouldPlay &&
                        desiredLoadPlay.loadId === loadIdRef.current,
                    );
                    if (!lastPlayingStateRef.current && !hasDesiredLoadPlay)
                        return;
                    if (currentTrackRef.current?.id !== trackId) return;
                    if (audioEngine.isPlaying()) return;
                    const listenTogetherSession =
                        getListenTogetherSessionSnapshot();
                    if (
                        listenTogetherSession?.groupId &&
                        !listenTogetherSession.isHost
                    ) {
                        return;
                    }

                    audioEngine.play();
                };

                startupRecoveryLoadListenerRef.current = onReloaded;
                audioEngine.on("load", onReloaded);
                audioEngine.reload();
            }, delayMs);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [clearStartupPlaybackRecovery],
    );

    const handleStartupManifestStall = useCallback(
        (payload?: Partial<AudioEngineManifestStallPayload>): void => {
            if (playbackTypeRef.current !== "track") return;

            const trackId = currentTrackRef.current?.id ?? null;
            if (!trackId) return;
            if (payload?.trackId && payload.trackId !== trackId) return;

            const activeSession = activeSegmentedSessionRef.current;
            if (!activeSession || activeSession.trackId !== trackId) {
                return;
            }
            if (
                payload?.sessionId &&
                payload.sessionId !== activeSession.sessionId
            ) {
                return;
            }
            if (hasStartupChunkResponseForTrack(trackId)) {
                return;
            }

            logPlaybackClientMetric("player.rebuffer", {
                reason: "manifest_stall_startup_recovery",
                trackId,
                sessionId: activeSession.sessionId,
                sourceType: activeSession.sourceType,
                manifestStallReason:
                    typeof payload?.reason === "string" ? payload.reason : null,
            });
            scheduleStartupPlaybackRecovery(trackId);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [hasStartupChunkResponseForTrack, scheduleStartupPlaybackRecovery],
    );

    const requestListenTogetherFollowerRecovery = useCallback(
        (reason: string): boolean => {
            const listenTogetherGroupId = resolveListenTogetherFollowerGroupId(
                getListenTogetherSessionSnapshot(),
            );
            if (!listenTogetherGroupId) {
                return false;
            }

            playbackStateMachine.forceTransition("LOADING");
            setIsBuffering(true);

            const recoveryState = listenTogetherFollowerRecoveryRef.current;
            const now = Date.now();
            if (
                recoveryState.groupId === listenTogetherGroupId &&
                (recoveryState.inFlight ||
                    now - recoveryState.lastRequestedAtMs <
                        LISTEN_TOGETHER_FOLLOWER_RECOVERY_COOLDOWN_MS)
            ) {
                return true;
            }

            recoveryState.groupId = listenTogetherGroupId;
            recoveryState.inFlight = true;
            recoveryState.lastRequestedAtMs = now;

            sharedFrontendLogger.warn(
                "[AudioPlaybackOrchestrator] Delegating follower recovery to Listen Together resync",
                {
                    groupId: listenTogetherGroupId,
                    reason,
                    trackId: currentTrackRef.current?.id ?? null,
                    sessionId:
                        activeSegmentedSessionRef.current?.sessionId ?? null,
                },
            );

            void requestListenTogetherGroupResync(listenTogetherGroupId)
                .catch((error) => {
                    sharedFrontendLogger.warn(
                        "[AudioPlaybackOrchestrator] Listen Together follower resync failed",
                        {
                            groupId: listenTogetherGroupId,
                            reason,
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        },
                    );
                })
                .finally(() => {
                    const currentRecoveryState =
                        listenTogetherFollowerRecoveryRef.current;
                    if (
                        currentRecoveryState.groupId === listenTogetherGroupId
                    ) {
                        currentRecoveryState.inFlight = false;
                    }
                });

            return true;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [setIsBuffering],
    );

    const scheduleTrackErrorSkip = useCallback(
        (failedTrackId: string | null) => {
            if (
                pendingTrackErrorSkipRef.current &&
                pendingTrackErrorTrackIdRef.current === failedTrackId
            ) {
                return;
            }

            // Record the error in the circuit breaker. If it trips (3 consecutive
            // errors without a successful play), halt auto-advance to prevent
            // infinite rapid error loops.
            const justTripped =
                consecutiveErrorBreakerRef.current.recordError();
            if (consecutiveErrorBreakerRef.current.isTripped()) {
                if (justTripped) {
                    sharedFrontendLogger.warn(
                        "[AudioPlaybackOrchestrator] Consecutive error circuit breaker tripped — stopping auto-advance",
                        {
                            consecutiveErrors:
                                consecutiveErrorBreakerRef.current.getErrorCount(),
                        },
                    );
                    toast.error(
                        "Playback stopped — multiple tracks failed in a row. Check your connection or try again.",
                        { duration: 6000 },
                    );
                }
                return;
            }

            clearPendingTrackErrorSkip();
            pendingTrackErrorTrackIdRef.current = failedTrackId;
            pendingTrackErrorSkipRef.current = setTimeout(() => {
                pendingTrackErrorSkipRef.current = null;
                pendingTrackErrorTrackIdRef.current = null;

                if (playbackTypeRef.current !== "track") return;
                if (
                    failedTrackId &&
                    currentTrackRef.current?.id !== failedTrackId
                )
                    return;

                const ltSession = getListenTogetherSessionSnapshot();
                if (ltSession?.groupId) {
                    if (ltSession.isHost && queueLengthRef.current > 1) {
                        enqueueLatestListenTogetherHostTrackOperation({
                            action: "next",
                        });
                        return;
                    }

                    void requestListenTogetherGroupResync(
                        ltSession.groupId,
                    ).catch(() => undefined);
                    return;
                }

                if (queueLengthRef.current <= 1) return;

                lastTrackIdRef.current = null;
                isLoadingRef.current = false;
                trackErrorAdvanceFromTrackIdRef.current = failedTrackId;
                advancePlayIntentAtMsRef.current = Date.now();
                next();
            }, TRACK_ERROR_SKIP_DELAY_MS);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [clearPendingTrackErrorSkip, next],
    );

    const attemptTransientTrackRecovery = useCallback(
        (failedTrackId: string | null, error: unknown): boolean => {
            if (playbackTypeRef.current !== "track") return false;
            if (!failedTrackId) return false;
            if (
                requestListenTogetherFollowerRecovery("transient_track_error")
            ) {
                return true;
            }
            if (!lastPlayingStateRef.current) return false;
            if (!isLikelyTransientStreamError(error)) return false;

            const now = Date.now();
            const isNewTrack =
                transientTrackRecoveryTrackIdRef.current !== failedTrackId;
            const isOutsideRecoveryWindow =
                now - transientTrackRecoveryWindowStartedAtRef.current >
                TRANSIENT_TRACK_ERROR_RECOVERY_WINDOW_MS;

            if (isNewTrack || isOutsideRecoveryWindow) {
                transientTrackRecoveryTrackIdRef.current = failedTrackId;
                transientTrackRecoveryAttemptRef.current = 0;
                transientTrackRecoveryWindowStartedAtRef.current = now;
            }

            if (
                transientTrackRecoveryAttemptRef.current >=
                TRANSIENT_TRACK_ERROR_RECOVERY_MAX_ATTEMPTS
            ) {
                return false;
            }

            transientTrackRecoveryAttemptRef.current += 1;
            const attemptNumber = transientTrackRecoveryAttemptRef.current;
            clearPendingTrackErrorSkip();
            clearTransientTrackRecovery(false);
            const resumeAtSec =
                resolveStartupSafeTrackPositionSec(failedTrackId);
            const recoveryLoadId = loadIdRef.current;
            const failedTrackSnapshot = currentTrackRef.current;
            const recoverySourceType = failedTrackSnapshot
                ? resolveDirectTrackSourceType(failedTrackSnapshot)
                : "local";

            const onRecoveredLoad = () => {
                clearTransientTrackRecovery(false);
                if (playbackTypeRef.current !== "track") return;
                if (!lastPlayingStateRef.current) return;
                const correlatedResumeDecision =
                    resolveCorrelatedRecoveryResume({
                        requestedResumeAtSec: resumeAtSec,
                        expectedTrackId: failedTrackId,
                        expectedLoadId: recoveryLoadId,
                        sourceType: recoverySourceType,
                        reason: "transient_track_recovery",
                    });
                if (!correlatedResumeDecision.matched) {
                    if (
                        shouldForceCleanStartFromCorrelationMismatch(
                            correlatedResumeDecision.mismatchReason,
                        )
                    ) {
                        audioEngine.seek(0);
                        setCurrentTime(0);
                    }
                    return;
                }
                const correlatedResumeAtSec =
                    correlatedResumeDecision.resumeAtSec;
                if (correlatedResumeAtSec > 0) {
                    audioEngine.seek(correlatedResumeAtSec);
                    setCurrentTime(correlatedResumeAtSec);
                }
                if (!audioEngine.isPlaying()) {
                    audioEngine.play();
                }
            };

            transientTrackRecoveryLoadListenerRef.current = onRecoveredLoad;
            audioEngine.on("load", onRecoveredLoad);

            transientTrackRecoveryTimeoutRef.current = setTimeout(() => {
                transientTrackRecoveryTimeoutRef.current = null;

                if (playbackTypeRef.current !== "track") return;
                if (currentTrackRef.current?.id !== failedTrackId) return;
                if (loadIdRef.current !== recoveryLoadId) return;
                if (!lastPlayingStateRef.current) return;

                sharedFrontendLogger.warn(
                    `[AudioPlaybackOrchestrator] Transient stream error recovery ${attemptNumber}/${TRANSIENT_TRACK_ERROR_RECOVERY_MAX_ATTEMPTS}: reload and retry current track`,
                );
                audioEngine.reload();
            }, TRANSIENT_TRACK_ERROR_RECOVERY_DELAY_MS);

            return true;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [
            requestListenTogetherFollowerRecovery,
            clearPendingTrackErrorSkip,
            clearTransientTrackRecovery,
            resolveStartupSafeTrackPositionSec,
            resolveCorrelatedRecoveryResume,
            shouldForceCleanStartFromCorrelationMismatch,
            setCurrentTime,
        ],
    );

    return {
        scheduleStartupPlaybackRecovery,
        handleStartupManifestStall,
        requestListenTogetherFollowerRecovery,
        scheduleTrackErrorSkip,
        attemptTransientTrackRecovery,
    };
}
