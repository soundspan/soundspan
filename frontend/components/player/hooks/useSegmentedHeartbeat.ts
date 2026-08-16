import { useEffect } from "react";
import { api } from "@/lib/api";
import { resolveHeartbeatGuardedRefreshDecision } from "@/lib/audio-engine/segmentedPlaybackRegressionPolicy";
import {
    SEGMENTED_HEARTBEAT_FAILURE_THRESHOLD,
    SEGMENTED_HEARTBEAT_GUARDED_REFRESH_COOLDOWN_MS,
    SEGMENTED_HEARTBEAT_INTERVAL_MS,
} from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import {
    audioEngine,
    logPlaybackClientMetric,
} from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { resolveSegmentedTrackContext } from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import type { Track } from "@/lib/audio-state-context";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import type { useSegmentedPrewarm } from "./useSegmentedPrewarm";
import type { useSegmentedHandoffRecovery } from "./useSegmentedHandoffRecovery";

interface UseSegmentedHeartbeatOptions {
    refs: PlaybackOrchestratorRefs;
    playbackType: "track" | "audiobook" | "podcast" | null;
    currentTrack: Track | null;
    ensureStartupSegmentedSession: ReturnType<
        typeof useSegmentedPrewarm
    >["ensureStartupSegmentedSession"];
    attemptSegmentedHandoffRecovery: ReturnType<
        typeof useSegmentedHandoffRecovery
    >["attemptSegmentedHandoffRecovery"];
}

/** Sends the existing segmented-session heartbeat and guarded refresh. */
export function useSegmentedHeartbeat({
    refs,
    playbackType,
    currentTrack,
    ensureStartupSegmentedSession,
    attemptSegmentedHandoffRecovery,
}: UseSegmentedHeartbeatOptions): void {
    const {
        activeSegmentedSessionRef,
        segmentedHeartbeatConsecutiveFailureCountRef,
        segmentedHeartbeatLastGuardedRefreshAtMsRef,
        segmentedHeartbeatSessionIdRef,
        segmentedHandoffInProgressRef,
        currentTrackRef,
        lastPlayingStateRef,
    } = refs;

    useEffect(() => {
        if (playbackType !== "track") {
            return;
        }

        const heartbeatInterval = setInterval(() => {
            const activeSession = activeSegmentedSessionRef.current;
            if (!activeSession) {
                segmentedHeartbeatConsecutiveFailureCountRef.current = 0;
                segmentedHeartbeatLastGuardedRefreshAtMsRef.current = 0;
                segmentedHeartbeatSessionIdRef.current = null;
                return;
            }
            if (
                segmentedHeartbeatSessionIdRef.current !==
                activeSession.sessionId
            ) {
                segmentedHeartbeatConsecutiveFailureCountRef.current = 0;
                segmentedHeartbeatLastGuardedRefreshAtMsRef.current = 0;
                segmentedHeartbeatSessionIdRef.current =
                    activeSession.sessionId;
            }
            if (segmentedHandoffInProgressRef.current) return;
            if (currentTrackRef.current?.id !== activeSession.trackId) return;

            const positionSec = Math.max(
                0,
                typeof audioEngine.getActualCurrentTime === "function"
                    ? audioEngine.getActualCurrentTime()
                    : audioEngine.getCurrentTime(),
            );
            const currentlyPlaying =
                audioEngine.isPlaying() || lastPlayingStateRef.current;

            void api
                .heartbeatSegmentedStreamingSession(
                    activeSession.sessionId,
                    activeSession.sessionToken,
                    {
                        positionSec,
                        isPlaying: currentlyPlaying,
                    },
                )
                .then((heartbeat) => {
                    const sessionSnapshot = activeSegmentedSessionRef.current;
                    if (
                        !sessionSnapshot ||
                        sessionSnapshot.sessionId !== activeSession.sessionId
                    ) {
                        return;
                    }

                    activeSegmentedSessionRef.current = {
                        ...sessionSnapshot,
                        sessionToken: heartbeat.sessionToken,
                        expiresAt: heartbeat.expiresAt,
                    };
                    segmentedHeartbeatConsecutiveFailureCountRef.current = 0;
                })
                .catch((error) => {
                    sharedFrontendLogger.warn(
                        "[AudioPlaybackOrchestrator] Segmented heartbeat failed:",
                        error,
                    );
                    const errorMessage =
                        error instanceof Error
                            ? error.message
                            : String(error ?? "unknown");
                    const sessionMissing =
                        /session not found/i.test(errorMessage) ||
                        /session_not_found/i.test(errorMessage) ||
                        /404/.test(errorMessage);
                    if (sessionMissing) {
                        segmentedHeartbeatConsecutiveFailureCountRef.current = 0;
                        segmentedHeartbeatLastGuardedRefreshAtMsRef.current = 0;
                        segmentedHeartbeatSessionIdRef.current = null;

                        const latestSession = activeSegmentedSessionRef.current;
                        if (
                            latestSession &&
                            latestSession.sessionId === activeSession.sessionId
                        ) {
                            activeSegmentedSessionRef.current = null;
                        }
                        segmentedHandoffInProgressRef.current = false;
                        logPlaybackClientMetric("session.heartbeat_missing", {
                            trackId: activeSession.trackId,
                            sourceType: activeSession.sourceType,
                            sessionId: activeSession.sessionId,
                            error: errorMessage,
                        });

                        const trackSnapshot = currentTrackRef.current;
                        const segmentedTrackContext =
                            resolveSegmentedTrackContext(trackSnapshot);
                        if (
                            trackSnapshot &&
                            trackSnapshot.id === activeSession.trackId &&
                            segmentedTrackContext
                        ) {
                            void ensureStartupSegmentedSession(
                                trackSnapshot.id,
                                segmentedTrackContext,
                                "prewarm_asset_build_inflight",
                            );
                        }
                        return;
                    }

                    const nextFailureCount =
                        segmentedHeartbeatConsecutiveFailureCountRef.current +
                        1;
                    segmentedHeartbeatConsecutiveFailureCountRef.current =
                        nextFailureCount;
                    const nowMs = Date.now();
                    const guardedRefreshDecision =
                        resolveHeartbeatGuardedRefreshDecision({
                            consecutiveFailureCount: nextFailureCount,
                            failureThreshold:
                                SEGMENTED_HEARTBEAT_FAILURE_THRESHOLD,
                            lastRefreshAtMs:
                                segmentedHeartbeatLastGuardedRefreshAtMsRef.current,
                            refreshCooldownMs:
                                SEGMENTED_HEARTBEAT_GUARDED_REFRESH_COOLDOWN_MS,
                            nowMs,
                        });
                    if (!guardedRefreshDecision.shouldTriggerRefresh) {
                        logPlaybackClientMetric("session.heartbeat_failure", {
                            trackId: activeSession.trackId,
                            sourceType: activeSession.sourceType,
                            sessionId: activeSession.sessionId,
                            error: errorMessage,
                            consecutiveFailures: nextFailureCount,
                            failureThreshold:
                                SEGMENTED_HEARTBEAT_FAILURE_THRESHOLD,
                            guardedRefreshReason: guardedRefreshDecision.reason,
                            guardedRefreshCooldownRemainingMs:
                                guardedRefreshDecision.remainingCooldownMs,
                        });
                        return;
                    }

                    segmentedHeartbeatLastGuardedRefreshAtMsRef.current = nowMs;
                    logPlaybackClientMetric(
                        "session.heartbeat_guarded_refresh",
                        {
                            trackId: activeSession.trackId,
                            sourceType: activeSession.sourceType,
                            sessionId: activeSession.sessionId,
                            consecutiveFailures: nextFailureCount,
                            failureThreshold:
                                SEGMENTED_HEARTBEAT_FAILURE_THRESHOLD,
                            cooldownMs:
                                SEGMENTED_HEARTBEAT_GUARDED_REFRESH_COOLDOWN_MS,
                            error: errorMessage,
                        },
                    );
                    void attemptSegmentedHandoffRecovery(error, {
                        forceSessionCreate: true,
                        forceSessionCreateReason:
                            "heartbeat_consecutive_failures",
                    })
                        .then((recovered) => {
                            logPlaybackClientMetric(
                                "session.heartbeat_guarded_refresh_result",
                                {
                                    trackId: activeSession.trackId,
                                    sourceType: activeSession.sourceType,
                                    sessionId: activeSession.sessionId,
                                    recovered,
                                    consecutiveFailures:
                                        segmentedHeartbeatConsecutiveFailureCountRef.current,
                                },
                            );
                        })
                        .catch((recoveryError) => {
                            logPlaybackClientMetric(
                                "session.heartbeat_guarded_refresh_error",
                                {
                                    trackId: activeSession.trackId,
                                    sourceType: activeSession.sourceType,
                                    sessionId: activeSession.sessionId,
                                    error:
                                        recoveryError instanceof Error
                                            ? recoveryError.message
                                            : String(recoveryError),
                                },
                            );
                        });
                });
        }, SEGMENTED_HEARTBEAT_INTERVAL_MS);

        return () => {
            clearInterval(heartbeatInterval);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [
        playbackType,
        currentTrack?.id,
        ensureStartupSegmentedSession,
        attemptSegmentedHandoffRecovery,
    ]);
}
