import { useCallback } from "react";
import { api } from "@/lib/api";
import { resolveLocalAuthoritativeRecovery } from "@/lib/audio-engine/recoveryPolicy";
import type { SegmentedTrackContext } from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import {
    audioEngine,
    logPlaybackClientMetric,
} from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import type { PlaybackStreamProfile } from "@/lib/audio-playback-context";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import type { usePlaybackRecoveryHelpers } from "./usePlaybackRecoveryHelpers";
import type { useSegmentedStartupCallbacks } from "./useSegmentedStartupCallbacks";

interface UseSegmentedSessionRecoveryOptions {
    refs: PlaybackOrchestratorRefs;
    playbackRecoveryHelpers: ReturnType<typeof usePlaybackRecoveryHelpers>;
    segmentedStartupCallbacks: ReturnType<typeof useSegmentedStartupCallbacks>;
    setCurrentTime: (time: number) => void;
    setIsBuffering: (isBuffering: boolean) => void;
    setIsPlaying: (isPlaying: boolean) => void;
    setStreamProfile: (profile: PlaybackStreamProfile | null) => void;
}

/** Preserves fresh-session recovery for segmented playback. */
export function useSegmentedSessionRecovery({
    refs,
    playbackRecoveryHelpers,
    segmentedStartupCallbacks,
    setCurrentTime,
    setIsBuffering,
    setIsPlaying,
    setStreamProfile,
}: UseSegmentedSessionRecoveryOptions) {
    const {
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
    } = segmentedStartupCallbacks;
    const {
        loadIdRef,
        playbackTypeRef,
        currentTrackRef,
        activeSegmentedSessionRef,
        segmentedChunkQuarantineRef,
        segmentedChunkQuarantineLastRecoveryAtRef,
        segmentedLastFailedChunkRef,
        segmentedColdStartRebufferDeferralRef,
        segmentedHandoffAttemptRef,
        segmentedHandoffLastAttemptAtRef,
        segmentedSessionCreateFallbackAttemptRef,
        segmentedSessionCreateFallbackLastAttemptAtRef,
        activeSegmentedPlaybackTrackIdRef,
    } = refs;

    const attemptSegmentedSessionCreateRecovery = useCallback(
        async ({
            trackId,
            segmentedTrackContext,
            currentPositionSec,
            shouldPlayIntent,
            recoveryStartedAtMs,
            previousSessionId,
            triggerReason,
        }: {
            trackId: string;
            segmentedTrackContext: SegmentedTrackContext;
            currentPositionSec: number;
            shouldPlayIntent: boolean;
            recoveryStartedAtMs: number;
            previousSessionId: string;
            triggerReason: string;
        }): Promise<boolean> => {
            const recoveryLoadId = loadIdRef.current;
            logPlaybackClientMetric(
                "session.handoff_circuit_recovery_attempt",
                {
                    trackId,
                    sourceType: segmentedTrackContext.sourceType,
                    previousSessionId,
                    triggerReason,
                },
            );

            try {
                const refreshedSession =
                    await api.createSegmentedStreamingSession({
                        trackId: segmentedTrackContext.sessionTrackId,
                        sourceType: segmentedTrackContext.sourceType,
                        manifestProfile: "steady_state_dual",
                    });

                if (
                    playbackTypeRef.current !== "track" ||
                    currentTrackRef.current?.id !== trackId ||
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
                    "x-streaming-session-token": refreshedSession.sessionToken,
                };
                const authToken = api.getStreamingAuthToken();
                if (authToken) {
                    requestHeaders.Authorization = `Bearer ${authToken}`;
                }

                activeSegmentedSessionRef.current = {
                    sessionId: refreshedSession.sessionId,
                    sessionToken: refreshedSession.sessionToken,
                    trackId,
                    sourceType:
                        refreshedSession.engineHints?.sourceType ??
                        segmentedTrackContext.sourceType,
                    manifestUrl: refreshedSession.manifestUrl,
                    expiresAt: refreshedSession.expiresAt,
                    assetBuildInFlight:
                        refreshedSession.engineHints?.assetBuildInFlight ===
                        true,
                    manifestProfile:
                        refreshedSession.playbackProfile?.manifestProfile ??
                        null,
                };
                segmentedChunkQuarantineRef.current.clear();
                segmentedChunkQuarantineLastRecoveryAtRef.current = 0;
                segmentedLastFailedChunkRef.current = {
                    trackId,
                    sessionId: refreshedSession.sessionId,
                    chunkName: null,
                    statusCode: null,
                    observedAtMs: Date.now(),
                };
                segmentedColdStartRebufferDeferralRef.current = {
                    trackId,
                    count: 0,
                };
                setStreamProfile({
                    mode: "dash",
                    sourceType:
                        refreshedSession.playbackProfile?.sourceType ??
                        refreshedSession.engineHints?.sourceType ??
                        segmentedTrackContext.sourceType,
                    codec:
                        refreshedSession.playbackProfile?.codec?.toUpperCase() ??
                        "AAC",
                    bitrateKbps:
                        refreshedSession.playbackProfile?.bitrateKbps ?? null,
                });

                logPlaybackClientMetric(
                    "session.handoff_circuit_recovery_api_success",
                    {
                        trackId,
                        sourceType:
                            refreshedSession.playbackProfile?.sourceType ??
                            refreshedSession.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        previousSessionId,
                        sessionId: refreshedSession.sessionId,
                        requestedPositionSec: currentPositionSec,
                        latencyMs: Math.max(
                            0,
                            Date.now() - recoveryStartedAtMs,
                        ),
                    },
                );

                const onRecoveryLoad = () => {
                    clearSegmentedHandoffLoadListeners("load");
                    if (playbackTypeRef.current !== "track") {
                        setIsBuffering(false);
                        return;
                    }

                    const localPositionBeforeRecovery =
                        resolveHandoffLocalPositionSec(
                            trackId,
                            currentPositionSec,
                        );
                    const recoveryDecision = resolveLocalAuthoritativeRecovery(
                        {
                            positionSec: localPositionBeforeRecovery,
                            shouldPlay: shouldPlayIntent,
                        },
                        {
                            resumeAtSec: currentPositionSec,
                            shouldPlay: shouldPlayIntent,
                        },
                    );
                    const correlatedResumeDecision =
                        resolveCorrelatedRecoveryResume({
                            requestedResumeAtSec: recoveryDecision.resumeAtSec,
                            expectedTrackId: trackId,
                            expectedLoadId: recoveryLoadId,
                            expectedSessionId: refreshedSession.sessionId,
                            sourceType: segmentedTrackContext.sourceType,
                            reason: "handoff_circuit_recovery_resume",
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
                                        "session.handoff_circuit_recovery_resume_play_failure",
                                        {
                                            trackId,
                                            sourceType:
                                                segmentedTrackContext.sourceType,
                                            sessionId:
                                                refreshedSession.sessionId,
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
                            trackId,
                            resumeAt,
                        );
                    if (resetHandoffBudget) {
                        segmentedHandoffAttemptRef.current = 0;
                        segmentedHandoffLastAttemptAtRef.current = 0;
                        segmentedSessionCreateFallbackAttemptRef.current = 0;
                        segmentedSessionCreateFallbackLastAttemptAtRef.current = 0;
                        resetSegmentedHandoffCircuit(trackId);
                    }
                    logPlaybackClientMetric(
                        "session.handoff_circuit_recovered",
                        {
                            trackId,
                            sourceType:
                                refreshedSession.playbackProfile?.sourceType ??
                                refreshedSession.engineHints?.sourceType ??
                                segmentedTrackContext.sourceType,
                            previousSessionId,
                            sessionId: refreshedSession.sessionId,
                            resumeAtSec: resumeAt,
                            shouldResumePlayback,
                            authority: recoveryDecision.authority,
                            latencyMs: Math.max(
                                0,
                                Date.now() - recoveryStartedAtMs,
                            ),
                        },
                    );
                };

                const onRecoveryLoadError = () => {
                    clearSegmentedHandoffLoadListeners("loaderror");
                    setIsBuffering(false);
                    logPlaybackClientMetric(
                        "session.handoff_circuit_recovery_load_error",
                        {
                            trackId,
                            sourceType:
                                refreshedSession.playbackProfile?.sourceType ??
                                refreshedSession.engineHints?.sourceType ??
                                segmentedTrackContext.sourceType,
                            previousSessionId,
                            sessionId: refreshedSession.sessionId,
                            latencyMs: Math.max(
                                0,
                                Date.now() - recoveryStartedAtMs,
                            ),
                        },
                    );
                };

                registerSegmentedHandoffLoadListeners(
                    {
                        trackId,
                        sourceType:
                            refreshedSession.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        sessionId: refreshedSession.sessionId,
                        expectedLoadId: recoveryLoadId,
                        phase: "session_create_recovery",
                    },
                    onRecoveryLoad,
                    onRecoveryLoadError,
                );
                markSegmentedStartupRampWindow(
                    trackId,
                    "handoff_circuit_recovery_load",
                );
                const correlatedStartTimeDecision =
                    resolveCorrelatedRecoveryResume({
                        requestedResumeAtSec: currentPositionSec,
                        expectedTrackId: trackId,
                        expectedLoadId: recoveryLoadId,
                        expectedSessionId: refreshedSession.sessionId,
                        sourceType: segmentedTrackContext.sourceType,
                        reason: "handoff_circuit_recovery_start_time",
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
                activeSegmentedPlaybackTrackIdRef.current = trackId;
                audioEngine.load(
                    {
                        url: refreshedSession.manifestUrl,
                        trackId,
                        sessionId: refreshedSession.sessionId,
                        sourceType:
                            refreshedSession.engineHints?.sourceType ??
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

                return true;
            } catch (sessionCreateError) {
                logPlaybackClientMetric(
                    "session.handoff_circuit_recovery_failure",
                    {
                        trackId,
                        sourceType: segmentedTrackContext.sourceType,
                        previousSessionId,
                        error:
                            sessionCreateError instanceof Error
                                ? sessionCreateError.message
                                : String(sessionCreateError ?? "unknown"),
                        latencyMs: Math.max(
                            0,
                            Date.now() - recoveryStartedAtMs,
                        ),
                    },
                );
                setIsBuffering(false);
                return false;
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [
            resolveHandoffLocalPositionSec,
            setCurrentTime,
            setIsBuffering,
            setIsPlaying,
            setStreamProfile,
            markSegmentedStartupRampWindow,
            shouldResetHandoffBudgetAfterRecovery,
            resolveCorrelatedRecoveryResume,
            shouldForceCleanStartFromCorrelationMismatch,
            resetSegmentedHandoffCircuit,
            clearSegmentedHandoffLoadListeners,
            registerSegmentedHandoffLoadListeners,
        ],
    );

    return { attemptSegmentedSessionCreateRecovery };
}
