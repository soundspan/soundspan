import { useEffect } from "react";
import { HeartbeatMonitor, playbackStateMachine } from "@/lib/audio";
import {
    HEARTBEAT_BUFFER_TIMEOUT_MS,
    UNEXPECTED_STOP_STARTUP_GUARD_MS,
} from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import {
    audioEngine,
    logPlaybackClientMetric,
} from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { resolveBufferingRecoveryAction } from "@/lib/audio-engine/playbackRecoveryPolicy";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import type { useTrackRecovery } from "./useTrackRecovery";

interface UsePlaybackWatchdogsOptions {
    refs: PlaybackOrchestratorRefs;
    trackRecovery: ReturnType<typeof useTrackRecovery>;
    isPlaying: boolean;

    isBuffering: boolean;
    setIsBuffering: (isBuffering: boolean) => void;
    setIsPlaying: (isPlaying: boolean) => void;
}

/** Runs the existing heartbeat stall and unexpected-stop watchdogs. */
export function usePlaybackWatchdogs({
    refs,
    trackRecovery,
    isPlaying,
    isBuffering,
    setIsBuffering,
    setIsPlaying,
}: UsePlaybackWatchdogsOptions): void {
    const { attemptTransientTrackRecovery, scheduleStartupPlaybackRecovery } =
        trackRecovery;
    const {
        heartbeatRef,
        currentTrackRef,
        playbackTypeRef,
        seekReloadInProgressRef,
        isLoadingRef,
        lastPlayingStateRef,
        startupStabilityRef,
        unexpectedStopStartupGuardRef,
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
                        sourceType: "direct",
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
                    const startupStability = startupStabilityRef.current;
                    const startupNoProgress =
                        playbackTypeRef.current === "track" &&
                        Boolean(trackId) &&
                        startupStability.trackId === trackId &&
                        startupStability.firstProgressAtMs === null;
                    const suppressionReason = seekReloadInProgressRef.current
                        ? "seek_reload_in_progress"
                        : isLoadingRef.current
                          ? "load_in_progress"
                          : startupNoProgress
                            ? "startup_no_progress"
                            : null;
                    if (suppressionReason) {
                        if (trackId && startupNoProgress) {
                            unexpectedStopStartupGuardRef.current = {
                                trackId,
                                suppressUntilMs:
                                    Date.now() +
                                    UNEXPECTED_STOP_STARTUP_GUARD_MS,
                                reason: "startup_no_progress",
                            };
                            scheduleStartupPlaybackRecovery(trackId);
                        }
                        logPlaybackClientMetric(
                            "player.unexpected_stop_suppressed",
                            {
                                reason: suppressionReason,
                                trackId,
                                sourceType: "direct",
                            },
                        );
                        return;
                    }

                    const startupGuard = unexpectedStopStartupGuardRef.current;
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
                                sourceType: "direct",
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
                        sourceType: "direct",
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

                    const didScheduleTransientRecovery =
                        attemptTransientTrackRecovery(failedTrackId, stopError);
                    if (didScheduleTransientRecovery) {
                        return;
                    }

                    setIsPlaying(false);
                    setIsBuffering(false);
                    playbackStateMachine.forceTransition("READY");
                },
                onBufferTimeout: () => {
                    // Been buffering too long - likely connection lost
                    sharedFrontendLogger.error(
                        "[AudioPlaybackOrchestrator] Buffer timeout - connection may be lost",
                    );
                    logPlaybackClientMetric("player.rebuffer_timeout", {
                        reason: "heartbeat_buffer_timeout",
                        trackId: currentTrackRef.current?.id ?? null,
                        sourceType: "direct",
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
                onRecovery: () => {
                    // Recovered from stall
                    sharedFrontendLogger.info(
                        "[AudioPlaybackOrchestrator] Recovered from stall",
                    );
                    logPlaybackClientMetric("player.rebuffer_recovered", {
                        reason: "heartbeat_recovery",
                        trackId: currentTrackRef.current?.id ?? null,
                        sourceType: "direct",
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
                bufferTimeout: HEARTBEAT_BUFFER_TIMEOUT_MS,
            },
        );

        return () => {
            heartbeatRef.current?.destroy();
            heartbeatRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [
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
