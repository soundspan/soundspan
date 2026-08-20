import { useCallback } from "react";
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
import { audioEngine } from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { isLikelyTransientStreamError } from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import { rearmPlaybackProgressConfirmationOnError } from "@/lib/audio-engine/playbackProgressConfirmation";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { toast } from "sonner";
import {
    resolveCorrelatedRecoveryResumeDecision,
    resolveStartupGuardedRecoveryPositionSec,
} from "@/lib/audio-engine/playbackRecoveryPolicy";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import type { usePlaybackRecoveryHelpers } from "./usePlaybackRecoveryHelpers";
import {
    isPlaybackAutoRestartSuppressed,
    setPlaybackAutoRestartSuppressed,
    type PlaybackAdvanceOrigin,
    writePlaybackAdvanceOrigin,
} from "@/lib/audio-engine/playbackAdvanceOrigin";

interface UseTrackRecoveryOptions {
    refs: PlaybackOrchestratorRefs;
    playbackRecoveryHelpers: ReturnType<typeof usePlaybackRecoveryHelpers>;
    next: (origin: PlaybackAdvanceOrigin) => void;
    setCurrentTime: (time: number) => void;
    setIsBuffering: (isBuffering: boolean) => void;
}

/** Preserves startup, transient-error, and queue-skip recovery callbacks. */
export function useTrackRecovery({
    refs,
    playbackRecoveryHelpers,
    next,
    setCurrentTime,
    setIsBuffering,
}: UseTrackRecoveryOptions) {
    const {
        clearStartupPlaybackRecovery,
        clearPendingTrackErrorSkip,
        clearTransientTrackRecovery,
        readTrustedTrackPositionSec,
    } = playbackRecoveryHelpers;
    const {
        startupRecoveryAttemptedTrackIdRef,
        startupRecoveryTimeoutRef,
        playbackTypeRef,
        desiredLoadPlayRef,
        loadIdRef,
        lastPlayingStateRef,
        currentTrackRef,
        startupStabilityRef,
        isLoadingRef,
        startupRecoveryLoadListenerRef,
        listenTogetherFollowerRecoveryRef,
        pendingTrackErrorSkipRef,
        pendingTrackErrorTrackIdRef,
        consecutiveErrorBreakerRef,
        playbackProgressConfirmationRef,
        queueLengthRef,
        lastTrackIdRef,
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

                const startupStability = startupStabilityRef.current;
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

    const stopAutomaticPlaybackRestarts = useCallback((): void => {
        setPlaybackAutoRestartSuppressed(true);
        isLoadingRef.current = false;
        playbackStateMachine.forceTransition("READY");
        setIsBuffering(false);
    }, [isLoadingRef, setIsBuffering]);

    const scheduleTrackErrorSkip = useCallback(
        (failedTrackId: string | null): boolean => {
            if (
                pendingTrackErrorSkipRef.current &&
                pendingTrackErrorTrackIdRef.current === failedTrackId
            ) {
                return false;
            }
            if (isPlaybackAutoRestartSuppressed()) {
                stopAutomaticPlaybackRestarts();
                return true;
            }

            // Record the error in the circuit breaker. If it trips (3 consecutive
            // errors without a successful play), halt auto-advance to prevent
            // infinite rapid error loops.
            // Error-driven repeat-one and unchanged-track LT recovery must prove
            // progress again. Non-error LT resyncs leave the breaker unchanged,
            // so they need no second confirmation; podcast seek-reload does not
            // participate in the track breaker.
            playbackProgressConfirmationRef.current =
                rearmPlaybackProgressConfirmationOnError(
                    playbackProgressConfirmationRef.current,
                    failedTrackId,
                );
            const justTripped =
                consecutiveErrorBreakerRef.current.recordError();
            if (consecutiveErrorBreakerRef.current.isTripped()) {
                stopAutomaticPlaybackRestarts();
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
                return true;
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
                    writePlaybackAdvanceOrigin("error", failedTrackId);
                    advancePlayIntentAtMsRef.current = Date.now();
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
                advancePlayIntentAtMsRef.current = Date.now();
                next("error");
            }, TRACK_ERROR_SKIP_DELAY_MS);
            return false;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [clearPendingTrackErrorSkip, next, stopAutomaticPlaybackRestarts],
    );

    const attemptTransientTrackRecovery = useCallback(
        (failedTrackId: string | null, error: unknown): boolean => {
            if (playbackTypeRef.current !== "track") return false;
            if (!failedTrackId) return false;
            if (!lastPlayingStateRef.current) return false;
            if (!isLikelyTransientStreamError(error)) return false;
            if (
                requestListenTogetherFollowerRecovery("transient_track_error")
            ) {
                return true;
            }

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
            const startupStabilityAtFailure = startupStabilityRef.current;
            const resumeAtSec = resolveStartupGuardedRecoveryPositionSec({
                targetTrackId: failedTrackId,
                trustedPositionSec: readTrustedTrackPositionSec(failedTrackId),
                startupStabilityTrackId: startupStabilityAtFailure.trackId,
                startupFirstProgressAtMs:
                    startupStabilityAtFailure.firstProgressAtMs,
            });
            const recoveryLoadId = loadIdRef.current;

            const onRecoveredLoad = () => {
                clearTransientTrackRecovery(false);
                if (playbackTypeRef.current !== "track") return;
                if (!lastPlayingStateRef.current) return;
                const correlatedResumeDecision =
                    resolveCorrelatedRecoveryResumeDecision({
                        requestedResumeAtSec: resumeAtSec,
                        expectedTrackId: failedTrackId,
                        activeTrackId: currentTrackRef.current?.id ?? null,
                        expectedLoadId: recoveryLoadId,
                        activeLoadId: loadIdRef.current,
                    });
                if (!correlatedResumeDecision.matched) {
                    if (
                        correlatedResumeDecision.mismatchReason ===
                            "track_mismatch" ||
                        correlatedResumeDecision.mismatchReason ===
                            "load_mismatch"
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
            readTrustedTrackPositionSec,
            setCurrentTime,
        ],
    );

    return {
        scheduleStartupPlaybackRecovery,
        requestListenTogetherFollowerRecovery,
        scheduleTrackErrorSkip,
        attemptTransientTrackRecovery,
    };
}
