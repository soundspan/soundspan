import { useCallback } from "react";
import { api } from "@/lib/api";
import { playbackStateMachine } from "@/lib/audio";
import { resolveLocalAuthoritativeRecovery } from "@/lib/audio-engine/recoveryPolicy";
import {
    SEGMENTED_HANDOFF_CIRCUIT_MAX_ATTEMPTS,
    SEGMENTED_HANDOFF_CIRCUIT_WINDOW_MS,
    SEGMENTED_HANDOFF_COOLDOWN_MS,
    SEGMENTED_HANDOFF_MAX_ATTEMPTS,
    SEGMENTED_HANDOFF_SESSION_CREATE_FALLBACK_COOLDOWN_MS,
    SEGMENTED_HANDOFF_SESSION_CREATE_FALLBACK_MAX_ATTEMPTS,
    SEGMENTED_STARTUP_AUDIBLE_THRESHOLD_SEC,
} from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import {
    audioEngine,
    logPlaybackClientMetric,
} from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import {
    isLikelyTransientStreamError,
    resolveSegmentedTrackContext,
} from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import type { PlaybackStreamProfile } from "@/lib/audio-playback-context";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import type { usePlaybackRecoveryHelpers } from "./usePlaybackRecoveryHelpers";
import type { useSegmentedStartupCallbacks } from "./useSegmentedStartupCallbacks";
import type { useTrackRecovery } from "./useTrackRecovery";
import type { useSegmentedSessionRecovery } from "./useSegmentedSessionRecovery";

interface UseSegmentedHandoffRecoveryOptions {
    refs: PlaybackOrchestratorRefs;
    playbackRecoveryHelpers: ReturnType<typeof usePlaybackRecoveryHelpers>;
    segmentedStartupCallbacks: ReturnType<typeof useSegmentedStartupCallbacks>;
    trackRecovery: ReturnType<typeof useTrackRecovery>;
    segmentedSessionRecovery: ReturnType<typeof useSegmentedSessionRecovery>;
    isPlaying: boolean;
    setCurrentTime: (time: number) => void;
    setIsBuffering: (isBuffering: boolean) => void;
    setIsPlaying: (isPlaying: boolean) => void;
    setStreamProfile: (profile: PlaybackStreamProfile | null) => void;
}

/** Preserves segmented handoff recovery without changing its experimental flow. */
export function useSegmentedHandoffRecovery({
    refs,
    playbackRecoveryHelpers,
    segmentedStartupCallbacks,
    trackRecovery,
    segmentedSessionRecovery,
    isPlaying,
    setCurrentTime,
    setIsBuffering,
    setIsPlaying,
    setStreamProfile,
}: UseSegmentedHandoffRecoveryOptions) {
    const {
        resolveStartupSafeTrackPositionSec,
        resolveHandoffLocalPositionSec,
        resolveCorrelatedRecoveryResume,
        shouldForceCleanStartFromCorrelationMismatch,
        resetSegmentedHandoffCircuit,
        clearSegmentedHandoffLoadListeners,
        registerSegmentedHandoffLoadListeners,
    } = playbackRecoveryHelpers;
    const {
        markSegmentedStartupRampWindow,
        shouldResetHandoffBudgetAfterRecovery,
        hasStartupChunkResponseForTrack,
        hasStartupAudibleForTrack,
    } = segmentedStartupCallbacks;
    const { requestListenTogetherFollowerRecovery } = trackRecovery;
    const { attemptSegmentedSessionCreateRecovery } = segmentedSessionRecovery;
    const {
        playbackTypeRef,
        currentTrackRef,
        activeSegmentedSessionRef,
        segmentedHandoffInProgressRef,
        lastPlayingStateRef,
        loadIdRef,
        segmentedSessionCreateFallbackAttemptRef,
        segmentedSessionCreateFallbackLastAttemptAtRef,
        segmentedHandoffAttemptRef,
        segmentedHandoffLastAttemptAtRef,
        segmentedHandoffCircuitRef,
        segmentedChunkQuarantineRef,
        segmentedChunkQuarantineLastRecoveryAtRef,
        segmentedLastFailedChunkRef,
        segmentedColdStartRebufferDeferralRef,
        activeSegmentedPlaybackTrackIdRef,
    } = refs;

    const attemptSegmentedHandoffRecovery = useCallback(
        async (
            error: unknown,
            options?: {
                forceSessionCreate?: boolean;
                forceSessionCreateReason?: string;
            },
        ): Promise<boolean> => {
            if (playbackTypeRef.current !== "track") return false;
            if (
                requestListenTogetherFollowerRecovery(
                    "segmented_handoff_recovery",
                )
            ) {
                return true;
            }

            const currentTrackSnapshot = currentTrackRef.current;
            const segmentedTrackContext =
                resolveSegmentedTrackContext(currentTrackSnapshot);
            if (!currentTrackSnapshot || !segmentedTrackContext) {
                return false;
            }

            const activeSession = activeSegmentedSessionRef.current;
            if (
                !activeSession ||
                activeSession.trackId !== currentTrackSnapshot.id
            ) {
                return false;
            }

            if (segmentedHandoffInProgressRef.current) return false;
            const now = Date.now();
            const reason =
                error instanceof Error
                    ? error.message
                    : String(error ?? "unknown");
            const isTransientError = isLikelyTransientStreamError(error);
            const shouldForceSessionCreate =
                options?.forceSessionCreate === true;
            const forceSessionCreateReason =
                options?.forceSessionCreateReason?.trim() ||
                "forced_session_create";
            const currentPositionSec = resolveStartupSafeTrackPositionSec(
                currentTrackSnapshot.id,
            );
            const shouldPlayIntent =
                lastPlayingStateRef.current ||
                audioEngine.isPlaying() ||
                isPlaying;
            const recoveryLoadId = loadIdRef.current;

            const hasStartupChunk = hasStartupChunkResponseForTrack(
                currentTrackSnapshot.id,
            );
            const hasStartupAudibleMarker = hasStartupAudibleForTrack(
                currentTrackSnapshot.id,
            );
            const hasStartupAudibleProgress =
                hasStartupAudibleMarker ||
                currentPositionSec >= SEGMENTED_STARTUP_AUDIBLE_THRESHOLD_SEC;
            if (
                !shouldForceSessionCreate &&
                (!hasStartupChunk || !hasStartupAudibleProgress)
            ) {
                logPlaybackClientMetric("session.handoff_skipped", {
                    trackId: currentTrackSnapshot.id,
                    sourceType: segmentedTrackContext.sourceType,
                    sessionId: activeSession.sessionId,
                    reason: hasStartupChunk
                        ? "startup_not_audible_yet"
                        : "startup_first_chunk_unavailable",
                });
                return false;
            }

            const attemptSessionCreateFallback = async (
                blockedReason:
                    | "handoff_cooldown_active"
                    | "handoff_max_attempts_reached"
                    | "segment_missing_404",
            ): Promise<boolean> => {
                if (isTransientError && !shouldForceSessionCreate) {
                    return false;
                }

                const fallbackNow = Date.now();
                if (
                    segmentedSessionCreateFallbackAttemptRef.current >=
                    SEGMENTED_HANDOFF_SESSION_CREATE_FALLBACK_MAX_ATTEMPTS
                ) {
                    logPlaybackClientMetric("session.handoff_skipped", {
                        trackId: currentTrackSnapshot.id,
                        sourceType: segmentedTrackContext.sourceType,
                        reason: "session_create_fallback_max_attempts_reached",
                        maxAttempts:
                            SEGMENTED_HANDOFF_SESSION_CREATE_FALLBACK_MAX_ATTEMPTS,
                    });
                    return false;
                }

                if (
                    segmentedSessionCreateFallbackLastAttemptAtRef.current >
                        0 &&
                    fallbackNow -
                        segmentedSessionCreateFallbackLastAttemptAtRef.current <
                        SEGMENTED_HANDOFF_SESSION_CREATE_FALLBACK_COOLDOWN_MS
                ) {
                    logPlaybackClientMetric("session.handoff_skipped", {
                        trackId: currentTrackSnapshot.id,
                        sourceType: segmentedTrackContext.sourceType,
                        reason: "session_create_fallback_cooldown_active",
                        cooldownMs:
                            SEGMENTED_HANDOFF_SESSION_CREATE_FALLBACK_COOLDOWN_MS,
                        elapsedMs:
                            fallbackNow -
                            segmentedSessionCreateFallbackLastAttemptAtRef.current,
                    });
                    return false;
                }

                segmentedSessionCreateFallbackAttemptRef.current += 1;
                segmentedSessionCreateFallbackLastAttemptAtRef.current =
                    fallbackNow;
                segmentedHandoffInProgressRef.current = true;
                setIsBuffering(true);
                playbackStateMachine.forceTransition("LOADING");
                try {
                    return await attemptSegmentedSessionCreateRecovery({
                        trackId: currentTrackSnapshot.id,
                        segmentedTrackContext,
                        currentPositionSec,
                        shouldPlayIntent,
                        recoveryStartedAtMs: fallbackNow,
                        previousSessionId: activeSession.sessionId,
                        triggerReason: blockedReason,
                    });
                } finally {
                    segmentedHandoffInProgressRef.current = false;
                }
            };

            if (shouldForceSessionCreate) {
                logPlaybackClientMetric("session.handoff_skipped", {
                    trackId: currentTrackSnapshot.id,
                    sourceType: segmentedTrackContext.sourceType,
                    reason: forceSessionCreateReason,
                    sessionId: activeSession.sessionId,
                });

                segmentedHandoffInProgressRef.current = true;
                setIsBuffering(true);
                playbackStateMachine.forceTransition("LOADING");
                try {
                    return await attemptSegmentedSessionCreateRecovery({
                        trackId: currentTrackSnapshot.id,
                        segmentedTrackContext,
                        currentPositionSec,
                        shouldPlayIntent,
                        recoveryStartedAtMs: now,
                        previousSessionId: activeSession.sessionId,
                        triggerReason: forceSessionCreateReason,
                    });
                } finally {
                    segmentedHandoffInProgressRef.current = false;
                }
            }

            if (
                segmentedHandoffAttemptRef.current >=
                SEGMENTED_HANDOFF_MAX_ATTEMPTS
            ) {
                logPlaybackClientMetric("session.handoff_skipped", {
                    trackId: currentTrackSnapshot.id,
                    sourceType: segmentedTrackContext.sourceType,
                    reason: "max_attempts_reached",
                    maxAttempts: SEGMENTED_HANDOFF_MAX_ATTEMPTS,
                });
                return attemptSessionCreateFallback(
                    "handoff_max_attempts_reached",
                );
            }
            if (
                segmentedHandoffLastAttemptAtRef.current > 0 &&
                now - segmentedHandoffLastAttemptAtRef.current <
                    SEGMENTED_HANDOFF_COOLDOWN_MS
            ) {
                logPlaybackClientMetric("session.handoff_skipped", {
                    trackId: currentTrackSnapshot.id,
                    sourceType: segmentedTrackContext.sourceType,
                    reason: "cooldown_active",
                    cooldownMs: SEGMENTED_HANDOFF_COOLDOWN_MS,
                    elapsedMs: now - segmentedHandoffLastAttemptAtRef.current,
                });
                return attemptSessionCreateFallback("handoff_cooldown_active");
            }

            segmentedHandoffInProgressRef.current = true;
            const handoffStartedAtMs = Date.now();

            const existingCircuitState = segmentedHandoffCircuitRef.current;
            const shouldStartNewCircuitWindow =
                existingCircuitState.trackId !== currentTrackSnapshot.id ||
                existingCircuitState.windowStartedAtMs <= 0 ||
                now - existingCircuitState.windowStartedAtMs >
                    SEGMENTED_HANDOFF_CIRCUIT_WINDOW_MS;
            if (shouldStartNewCircuitWindow) {
                segmentedHandoffCircuitRef.current = {
                    trackId: currentTrackSnapshot.id,
                    windowStartedAtMs: now,
                    attempts: 0,
                };
            }
            segmentedHandoffCircuitRef.current.attempts += 1;
            const circuitAttempt = segmentedHandoffCircuitRef.current.attempts;
            setIsBuffering(true);
            playbackStateMachine.forceTransition("LOADING");

            if (circuitAttempt > SEGMENTED_HANDOFF_CIRCUIT_MAX_ATTEMPTS) {
                logPlaybackClientMetric("session.handoff_circuit_open", {
                    trackId: currentTrackSnapshot.id,
                    sourceType: segmentedTrackContext.sourceType,
                    sessionId: activeSession.sessionId,
                    attemptsInWindow: circuitAttempt,
                    maxAttempts: SEGMENTED_HANDOFF_CIRCUIT_MAX_ATTEMPTS,
                    windowMs: SEGMENTED_HANDOFF_CIRCUIT_WINDOW_MS,
                    triggerReason: reason,
                });
                try {
                    return await attemptSegmentedSessionCreateRecovery({
                        trackId: currentTrackSnapshot.id,
                        segmentedTrackContext,
                        currentPositionSec,
                        shouldPlayIntent,
                        recoveryStartedAtMs: handoffStartedAtMs,
                        previousSessionId: activeSession.sessionId,
                        triggerReason: "handoff_circuit_open",
                    });
                } finally {
                    segmentedHandoffInProgressRef.current = false;
                }
            }

            segmentedHandoffAttemptRef.current += 1;
            segmentedHandoffLastAttemptAtRef.current = now;
            logPlaybackClientMetric("session.handoff_attempt", {
                trackId: currentTrackSnapshot.id,
                sourceType: segmentedTrackContext.sourceType,
                sessionId: activeSession.sessionId,
                attempt: segmentedHandoffAttemptRef.current,
                circuitAttempt,
                reason,
            });

            try {
                const handoff = await api.handoffSegmentedStreamingSession(
                    activeSession.sessionId,
                    activeSession.sessionToken,
                    {
                        positionSec: currentPositionSec,
                        isPlaying: shouldPlayIntent,
                    },
                );

                if (
                    playbackTypeRef.current !== "track" ||
                    currentTrackRef.current?.id !== currentTrackSnapshot.id ||
                    loadIdRef.current !== recoveryLoadId
                ) {
                    if (
                        playbackTypeRef.current === "track" &&
                        currentTrackRef.current?.id
                    ) {
                        setCurrentTime(0);
                    }
                    return false;
                }

                const requestHeaders: Record<string, string> = {
                    "x-streaming-session-token": handoff.sessionToken,
                };
                const authToken = api.getStreamingAuthToken();
                if (authToken) {
                    requestHeaders.Authorization = `Bearer ${authToken}`;
                }

                activeSegmentedSessionRef.current = {
                    sessionId: handoff.sessionId,
                    sessionToken: handoff.sessionToken,
                    trackId: currentTrackSnapshot.id,
                    sourceType:
                        handoff.engineHints?.sourceType ??
                        segmentedTrackContext.sourceType,
                    manifestUrl: handoff.manifestUrl,
                    expiresAt: handoff.expiresAt,
                    assetBuildInFlight:
                        handoff.engineHints?.assetBuildInFlight === true,
                    manifestProfile:
                        handoff.playbackProfile?.manifestProfile ?? null,
                };
                segmentedChunkQuarantineRef.current.clear();
                segmentedChunkQuarantineLastRecoveryAtRef.current = 0;
                segmentedLastFailedChunkRef.current = {
                    trackId: currentTrackSnapshot.id,
                    sessionId: handoff.sessionId,
                    chunkName: null,
                    statusCode: null,
                    observedAtMs: Date.now(),
                };
                segmentedColdStartRebufferDeferralRef.current = {
                    trackId: currentTrackSnapshot.id,
                    count: 0,
                };
                setStreamProfile({
                    mode: "dash",
                    sourceType:
                        handoff.playbackProfile?.sourceType ??
                        handoff.engineHints?.sourceType ??
                        segmentedTrackContext.sourceType,
                    codec:
                        handoff.playbackProfile?.codec?.toUpperCase() ?? "AAC",
                    bitrateKbps: handoff.playbackProfile?.bitrateKbps ?? null,
                });
                logPlaybackClientMetric("session.handoff_api_success", {
                    trackId: currentTrackSnapshot.id,
                    sourceType:
                        handoff.playbackProfile?.sourceType ??
                        handoff.engineHints?.sourceType ??
                        segmentedTrackContext.sourceType,
                    previousSessionId: activeSession.sessionId,
                    sessionId: handoff.sessionId,
                    requestedPositionSec: currentPositionSec,
                    serverResumeAtSec: handoff.resumeAtSec,
                    resumeDeltaSec: Math.abs(
                        currentPositionSec - handoff.resumeAtSec,
                    ),
                    latencyMs: Math.max(0, Date.now() - handoffStartedAtMs),
                });

                const onHandoffLoad = () => {
                    clearSegmentedHandoffLoadListeners("load");

                    if (playbackTypeRef.current !== "track") {
                        setIsBuffering(false);
                        return;
                    }

                    const localPositionBeforeRecovery =
                        resolveHandoffLocalPositionSec(
                            currentTrackSnapshot.id,
                            currentPositionSec,
                        );
                    const recoveryDecision = resolveLocalAuthoritativeRecovery(
                        {
                            positionSec: localPositionBeforeRecovery,
                            shouldPlay: shouldPlayIntent,
                        },
                        {
                            resumeAtSec: handoff.resumeAtSec,
                            shouldPlay: handoff.shouldPlay,
                        },
                    );
                    const correlatedResumeDecision =
                        resolveCorrelatedRecoveryResume({
                            requestedResumeAtSec: recoveryDecision.resumeAtSec,
                            expectedTrackId: currentTrackSnapshot.id,
                            expectedLoadId: recoveryLoadId,
                            expectedSessionId: handoff.sessionId,
                            sourceType: segmentedTrackContext.sourceType,
                            reason: "handoff_recovery_resume",
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
                        setIsBuffering(false);
                        return;
                    }
                    const resumeAt = correlatedResumeDecision.resumeAtSec;
                    const shouldResumePlayback = recoveryDecision.shouldPlay;
                    audioEngine.seek(resumeAt);
                    setCurrentTime(resumeAt);

                    if (shouldResumePlayback) {
                        const playResult = audioEngine.play();
                        if (
                            playResult &&
                            typeof (playResult as Promise<void>).catch ===
                                "function"
                        ) {
                            void (playResult as Promise<void>).catch(
                                (playError) => {
                                    logPlaybackClientMetric(
                                        "session.handoff_resume_play_failure",
                                        {
                                            trackId: currentTrackSnapshot.id,
                                            sourceType:
                                                segmentedTrackContext.sourceType,
                                            sessionId: handoff.sessionId,
                                            error:
                                                playError instanceof Error
                                                    ? playError.message
                                                    : String(
                                                          playError ??
                                                              "unknown",
                                                      ),
                                        },
                                    );
                                },
                            );
                        }
                        setIsPlaying(true);
                    } else {
                        setIsPlaying(false);
                    }

                    setIsBuffering(false);
                    const resetHandoffBudget =
                        shouldResetHandoffBudgetAfterRecovery(
                            currentTrackSnapshot.id,
                            resumeAt,
                        );
                    if (resetHandoffBudget) {
                        segmentedHandoffAttemptRef.current = 0;
                        segmentedHandoffLastAttemptAtRef.current = 0;
                        segmentedSessionCreateFallbackAttemptRef.current = 0;
                        segmentedSessionCreateFallbackLastAttemptAtRef.current = 0;
                        resetSegmentedHandoffCircuit(currentTrackSnapshot.id);
                    }
                    logPlaybackClientMetric("session.handoff_recovered", {
                        trackId: currentTrackSnapshot.id,
                        sourceType:
                            handoff.playbackProfile?.sourceType ??
                            handoff.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        sessionId: handoff.sessionId,
                        resumeAtSec: resumeAt,
                        shouldResumePlayback,
                        authority: recoveryDecision.authority,
                        localPositionSec: localPositionBeforeRecovery,
                        serverResumeAtSec: handoff.resumeAtSec,
                        resumeDeltaSec: Math.abs(
                            localPositionBeforeRecovery - handoff.resumeAtSec,
                        ),
                        latencyMs: Math.max(0, Date.now() - handoffStartedAtMs),
                    });
                };

                const onHandoffLoadError = () => {
                    clearSegmentedHandoffLoadListeners("loaderror");
                    setIsBuffering(false);
                    logPlaybackClientMetric("session.handoff_load_error", {
                        trackId: currentTrackSnapshot.id,
                        sourceType:
                            handoff.playbackProfile?.sourceType ??
                            handoff.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        sessionId: handoff.sessionId,
                        latencyMs: Math.max(0, Date.now() - handoffStartedAtMs),
                    });
                };

                registerSegmentedHandoffLoadListeners(
                    {
                        trackId: currentTrackSnapshot.id,
                        sourceType:
                            handoff.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        sessionId: handoff.sessionId,
                        expectedLoadId: recoveryLoadId,
                        phase: "handoff_recovery",
                    },
                    onHandoffLoad,
                    onHandoffLoadError,
                );
                markSegmentedStartupRampWindow(
                    currentTrackSnapshot.id,
                    "handoff_recovery_load",
                );
                const correlatedStartTimeDecision =
                    resolveCorrelatedRecoveryResume({
                        requestedResumeAtSec: currentPositionSec,
                        expectedTrackId: currentTrackSnapshot.id,
                        expectedLoadId: recoveryLoadId,
                        expectedSessionId: handoff.sessionId,
                        sourceType: segmentedTrackContext.sourceType,
                        reason: "handoff_recovery_start_time",
                    });
                if (!correlatedStartTimeDecision.matched) {
                    if (
                        shouldForceCleanStartFromCorrelationMismatch(
                            correlatedStartTimeDecision.mismatchReason,
                        )
                    ) {
                        setCurrentTime(0);
                    }
                    clearSegmentedHandoffLoadListeners("correlation_mismatch");
                    setIsBuffering(false);
                    return false;
                }
                activeSegmentedPlaybackTrackIdRef.current =
                    currentTrackSnapshot.id;
                audioEngine.load(
                    {
                        url: handoff.manifestUrl,
                        trackId: currentTrackSnapshot.id,
                        sessionId: handoff.sessionId,
                        sourceType:
                            handoff.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        protocol: "dash",
                        mimeType: "application/dash+xml",
                    },
                    {
                        autoplay: false,
                        format: "mp4",
                        startTimeSec: correlatedStartTimeDecision.resumeAtSec,
                        withCredentials: true,
                        requestHeaders,
                    },
                );

                sharedFrontendLogger.warn(
                    "[AudioPlaybackOrchestrator] Segmented handoff recovery succeeded after playback error:",
                    error,
                );
                return true;
            } catch (handoffError) {
                sharedFrontendLogger.error(
                    "[AudioPlaybackOrchestrator] Segmented handoff recovery failed:",
                    handoffError,
                );
                logPlaybackClientMetric("session.handoff_failure", {
                    trackId: currentTrackSnapshot.id,
                    sourceType: segmentedTrackContext.sourceType,
                    sessionId: activeSession.sessionId,
                    error:
                        handoffError instanceof Error
                            ? handoffError.message
                            : String(handoffError ?? "unknown"),
                    latencyMs: Math.max(0, Date.now() - handoffStartedAtMs),
                });
                setIsBuffering(false);
                return false;
            } finally {
                segmentedHandoffInProgressRef.current = false;
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [
            isPlaying,
            requestListenTogetherFollowerRecovery,
            resolveStartupSafeTrackPositionSec,
            resolveHandoffLocalPositionSec,
            setCurrentTime,
            setIsBuffering,
            setIsPlaying,
            setStreamProfile,
            markSegmentedStartupRampWindow,
            shouldResetHandoffBudgetAfterRecovery,
            attemptSegmentedSessionCreateRecovery,
            hasStartupChunkResponseForTrack,
            hasStartupAudibleForTrack,
            resolveCorrelatedRecoveryResume,
            shouldForceCleanStartFromCorrelationMismatch,
            resetSegmentedHandoffCircuit,
            clearSegmentedHandoffLoadListeners,
            registerSegmentedHandoffLoadListeners,
        ],
    );

    return { attemptSegmentedHandoffRecovery };
}
