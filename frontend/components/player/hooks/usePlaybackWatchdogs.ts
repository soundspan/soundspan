import { useEffect } from "react";
import { HeartbeatMonitor, playbackStateMachine } from "@/lib/audio";
import {
    SEGMENTED_COLD_START_REBUFFER_MAX_DEFERRALS,
    SEGMENTED_COLD_START_REBUFFER_MAX_POSITION_SEC,
    SEGMENTED_COLD_START_REBUFFER_TIMEOUT_MS,
    SEGMENTED_HEARTBEAT_BUFFER_TIMEOUT_MS,
} from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import {
    audioEngine,
    logPlaybackClientMetric,
} from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { resolveSegmentedUnexpectedStopStartupGuardMs } from "@/lib/audio-engine/audioPlaybackRuntimePolicy";
import { resolveBufferingRecoveryAction } from "@/lib/audio-engine/segmentedPlaybackRegressionPolicy";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import type { useSegmentedHandoffRecovery } from "./useSegmentedHandoffRecovery";
import type { useTrackRecovery } from "./useTrackRecovery";

interface UsePlaybackWatchdogsOptions {
    refs: PlaybackOrchestratorRefs;
    trackRecovery: ReturnType<typeof useTrackRecovery>;
    attemptSegmentedHandoffRecovery: ReturnType<
        typeof useSegmentedHandoffRecovery
    >["attemptSegmentedHandoffRecovery"];
    isPlaying: boolean;
    isBuffering: boolean;
    setIsBuffering: (isBuffering: boolean) => void;
    setIsPlaying: (isPlaying: boolean) => void;
}

/** Runs the existing heartbeat stall and unexpected-stop watchdogs. */
export function usePlaybackWatchdogs({
    refs,
    trackRecovery,
    attemptSegmentedHandoffRecovery,
    isPlaying,
    isBuffering,
    setIsBuffering,
    setIsPlaying,
}: UsePlaybackWatchdogsOptions): void {
    const { scheduleStartupPlaybackRecovery, attemptTransientTrackRecovery } =
        trackRecovery;
    const {
        heartbeatRef,
        currentTrackRef,
        activeSegmentedSessionRef,
        segmentedStartupStabilityRef,
        playbackTypeRef,
        segmentedHandoffInProgressRef,
        seekReloadInProgressRef,
        isLoadingRef,
        segmentedUnexpectedStopStartupGuardRef,
        lastPlayingStateRef,
        segmentedColdStartRebufferDeferralRef,
    } = refs;

    // Initialize heartbeat monitor
    useEffect(() => {
        heartbeatRef.current = new HeartbeatMonitor(
            {
                onStall: () => {
                    // Playback stalled - time not moving while the engine reports playing
                    sharedFrontendLogger.warn(
                        "[AudioPlaybackOrchestrator] Heartbeat detected stall",
                    );
                    logPlaybackClientMetric("player.rebuffer", {
                        reason: "heartbeat_stall",
                        trackId: currentTrackRef.current?.id ?? null,
                        sessionId:
                            activeSegmentedSessionRef.current?.sessionId ??
                            null,
                        sourceType:
                            activeSegmentedSessionRef.current?.sourceType ??
                            "direct",
                    });
                    const transitionedToBuffering =
                        playbackStateMachine.transition("BUFFERING");
                    if (
                        !transitionedToBuffering &&
                        !playbackStateMachine.isBuffering
                    ) {
                        // Keep machine + React state aligned even after event-race transitions.
                        playbackStateMachine.forceTransition("BUFFERING");
                    }
                    setIsBuffering(true);
                    heartbeatRef.current?.startBufferTimeout();
                },
                onUnexpectedStop: () => {
                    // Engine stopped without an explicit stop/end event
                    const trackId = currentTrackRef.current?.id ?? null;
                    const startupStability =
                        segmentedStartupStabilityRef.current;
                    const startupNoProgress =
                        playbackTypeRef.current === "track" &&
                        Boolean(trackId) &&
                        startupStability.trackId === trackId &&
                        startupStability.firstProgressAtMs === null;
                    const suppressionReason =
                        segmentedHandoffInProgressRef.current
                            ? "handoff_in_progress"
                            : seekReloadInProgressRef.current
                              ? "seek_reload_in_progress"
                              : isLoadingRef.current
                                ? "load_in_progress"
                                : startupNoProgress
                                  ? "startup_no_progress"
                                  : null;
                    if (suppressionReason) {
                        if (trackId && startupNoProgress) {
                            segmentedUnexpectedStopStartupGuardRef.current = {
                                trackId,
                                suppressUntilMs:
                                    Date.now() +
                                    resolveSegmentedUnexpectedStopStartupGuardMs(),
                                reason: "startup_no_progress",
                            };
                            scheduleStartupPlaybackRecovery(trackId);
                        }
                        logPlaybackClientMetric(
                            "player.unexpected_stop_suppressed",
                            {
                                reason: suppressionReason,
                                trackId,
                                sessionId:
                                    activeSegmentedSessionRef.current
                                        ?.sessionId ?? null,
                                sourceType:
                                    activeSegmentedSessionRef.current
                                        ?.sourceType ?? "direct",
                            },
                        );
                        return;
                    }

                    const startupGuard =
                        segmentedUnexpectedStopStartupGuardRef.current;
                    const startupGuardActive =
                        playbackTypeRef.current === "track" &&
                        Boolean(trackId) &&
                        startupGuard.trackId === trackId &&
                        Date.now() < startupGuard.suppressUntilMs;
                    if (startupGuardActive) {
                        logPlaybackClientMetric(
                            "player.unexpected_stop_suppressed",
                            {
                                reason: "startup_guard_active",
                                trackId,
                                sessionId:
                                    activeSegmentedSessionRef.current
                                        ?.sessionId ?? null,
                                sourceType:
                                    activeSegmentedSessionRef.current
                                        ?.sourceType ?? "direct",
                                guardReason: startupGuard.reason,
                                guardRemainingMs: Math.max(
                                    0,
                                    startupGuard.suppressUntilMs - Date.now(),
                                ),
                            },
                        );
                        return;
                    }

                    sharedFrontendLogger.warn(
                        "[AudioPlaybackOrchestrator] Heartbeat detected unexpected stop",
                    );
                    logPlaybackClientMetric("player.unexpected_stop", {
                        reason: "heartbeat_unexpected_stop",
                        trackId,
                        sessionId:
                            activeSegmentedSessionRef.current?.sessionId ??
                            null,
                        sourceType:
                            activeSegmentedSessionRef.current?.sourceType ??
                            "direct",
                    });

                    if (!lastPlayingStateRef.current) {
                        if (playbackStateMachine.isPlaying) {
                            // User intent is paused; align machine state only.
                            playbackStateMachine.forceTransition("READY");
                        }
                        return;
                    }

                    if (playbackTypeRef.current !== "track") {
                        setIsPlaying(false);
                        setIsBuffering(false);
                        playbackStateMachine.forceTransition("READY");
                        return;
                    }

                    const stopError = new Error(
                        "Playback stopped unexpectedly during heartbeat monitoring",
                    );
                    const failedTrackId = currentTrackRef.current?.id ?? null;
                    setIsBuffering(true);
                    playbackStateMachine.forceTransition("LOADING");

                    void attemptSegmentedHandoffRecovery(stopError).then(
                        (didRecoverWithHandoff) => {
                            if (didRecoverWithHandoff) {
                                return;
                            }

                            const didScheduleTransientRecovery =
                                attemptTransientTrackRecovery(
                                    failedTrackId,
                                    stopError,
                                );
                            if (didScheduleTransientRecovery) {
                                playbackStateMachine.forceTransition("LOADING");
                                setIsBuffering(true);
                                return;
                            }

                            setIsPlaying(false);
                            setIsBuffering(false);
                            playbackStateMachine.forceTransition("READY");
                        },
                    );
                },
                onBufferTimeout: () => {
                    const activeSession = activeSegmentedSessionRef.current;
                    const activeTrackId = currentTrackRef.current?.id ?? null;
                    if (
                        playbackTypeRef.current === "track" &&
                        activeSession?.assetBuildInFlight &&
                        activeTrackId &&
                        activeSession.trackId === activeTrackId
                    ) {
                        const currentPositionSec = Math.max(
                            0,
                            typeof audioEngine.getActualCurrentTime ===
                                "function"
                                ? audioEngine.getActualCurrentTime()
                                : audioEngine.getCurrentTime(),
                        );
                        if (
                            currentPositionSec <=
                            SEGMENTED_COLD_START_REBUFFER_MAX_POSITION_SEC
                        ) {
                            const deferralState =
                                segmentedColdStartRebufferDeferralRef.current;
                            if (deferralState.trackId !== activeTrackId) {
                                deferralState.trackId = activeTrackId;
                                deferralState.count = 0;
                            }

                            if (
                                deferralState.count <
                                SEGMENTED_COLD_START_REBUFFER_MAX_DEFERRALS
                            ) {
                                deferralState.count += 1;
                                heartbeatRef.current?.updateConfig({
                                    bufferTimeout:
                                        SEGMENTED_COLD_START_REBUFFER_TIMEOUT_MS,
                                });
                                heartbeatRef.current?.startBufferTimeout();
                                logPlaybackClientMetric(
                                    "player.rebuffer_timeout_deferred",
                                    {
                                        reason: "asset_build_inflight_cold_start",
                                        trackId: activeTrackId,
                                        sessionId: activeSession.sessionId,
                                        sourceType: activeSession.sourceType,
                                        deferCount: deferralState.count,
                                        maxDeferrals:
                                            SEGMENTED_COLD_START_REBUFFER_MAX_DEFERRALS,
                                        currentPositionSec,
                                        nextTimeoutMs:
                                            SEGMENTED_COLD_START_REBUFFER_TIMEOUT_MS,
                                    },
                                );
                                return;
                            }
                        }
                    }

                    // Been buffering too long - likely connection lost
                    heartbeatRef.current?.updateConfig({
                        bufferTimeout: SEGMENTED_HEARTBEAT_BUFFER_TIMEOUT_MS,
                    });
                    sharedFrontendLogger.error(
                        "[AudioPlaybackOrchestrator] Buffer timeout - connection may be lost",
                    );
                    logPlaybackClientMetric("player.rebuffer_timeout", {
                        reason: "heartbeat_buffer_timeout",
                        trackId: currentTrackRef.current?.id ?? null,
                        sessionId:
                            activeSegmentedSessionRef.current?.sessionId ??
                            null,
                        sourceType:
                            activeSegmentedSessionRef.current?.sourceType ??
                            "direct",
                    });
                    const timeoutError = new Error(
                        "Connection lost - audio stream timed out",
                    );
                    const failPlayback = () => {
                        if (audioEngine.isPlaying()) {
                            audioEngine.pause();
                        }
                        playbackStateMachine.transition("ERROR", {
                            error: timeoutError.message,
                            errorCode: 408,
                        });
                        setIsPlaying(false);
                        setIsBuffering(false);
                        heartbeatRef.current?.stop();
                    };

                    if (playbackTypeRef.current !== "track") {
                        failPlayback();
                        return;
                    }

                    const failedTrackId = currentTrackRef.current?.id ?? null;
                    void attemptSegmentedHandoffRecovery(timeoutError).then(
                        (didRecoverWithHandoff) => {
                            if (didRecoverWithHandoff) {
                                return;
                            }

                            const didScheduleTransientRecovery =
                                attemptTransientTrackRecovery(
                                    failedTrackId,
                                    timeoutError,
                                );
                            if (didScheduleTransientRecovery) {
                                playbackStateMachine.forceTransition("LOADING");
                                setIsBuffering(true);
                                return;
                            }

                            failPlayback();
                        },
                    );
                },
                onRecovery: () => {
                    // Recovered from stall
                    heartbeatRef.current?.updateConfig({
                        bufferTimeout: SEGMENTED_HEARTBEAT_BUFFER_TIMEOUT_MS,
                    });
                    sharedFrontendLogger.info(
                        "[AudioPlaybackOrchestrator] Recovered from stall",
                    );
                    logPlaybackClientMetric("player.rebuffer_recovered", {
                        reason: "heartbeat_recovery",
                        trackId: currentTrackRef.current?.id ?? null,
                        sessionId:
                            activeSegmentedSessionRef.current?.sessionId ??
                            null,
                        sourceType:
                            activeSegmentedSessionRef.current?.sourceType ??
                            "direct",
                    });
                    const enginePlaying = audioEngine.isPlaying();
                    const recoveryAction = resolveBufferingRecoveryAction({
                        machineIsBuffering: playbackStateMachine.isBuffering,
                        machineIsPlaying: playbackStateMachine.isPlaying,
                        engineIsPlaying: enginePlaying,
                    });
                    if (recoveryAction === "transition_playing") {
                        playbackStateMachine.transition("PLAYING");
                    } else if (recoveryAction === "force_playing") {
                        playbackStateMachine.forceTransition("PLAYING");
                    }
                    setIsBuffering(false);
                    setIsPlaying(enginePlaying);
                },
                getCurrentTime: () => audioEngine.getCurrentTime(),
                isActuallyPlaying: () => audioEngine.isPlaying(),
            },
            {
                bufferTimeout: SEGMENTED_HEARTBEAT_BUFFER_TIMEOUT_MS,
            },
        );

        return () => {
            heartbeatRef.current?.destroy();
            heartbeatRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [
        attemptSegmentedHandoffRecovery,
        attemptTransientTrackRecovery,
        scheduleStartupPlaybackRecovery,
        setIsBuffering,
        setIsPlaying,
    ]);

    // Keep heartbeat active while buffering so stall timeouts can still fire.
    useEffect(() => {
        if (isPlaying || isBuffering) {
            heartbeatRef.current?.start();
        } else {
            heartbeatRef.current?.stop();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [isPlaying, isBuffering]);
}
