import { useEffect, type MutableRefObject } from "react";
import type { Audiobook, Podcast, Track } from "@/lib/audio-state-context";
import { playbackStateMachine } from "@/lib/audio";
import {
    resolveForegroundRecoveryDecision,
    shouldThrottleForegroundRecovery,
} from "@/lib/audio-engine/foregroundRecoveryPolicy";
import {
    audioEngine,
    logPlaybackClientMetric,
    orchestratorLogger,
} from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import type { createConsecutiveErrorBreaker } from "@/lib/audio-engine/consecutiveErrorBreaker";
import type { TrackEndWatchdog } from "../trackEndWatchdog";

interface UseForegroundRecoveryOptions {
    currentAudiobook: Audiobook | null;
    currentPodcast: Podcast | null;
    next: () => void;
    setIsBuffering: (isBuffering: boolean) => void;
    wasPlayingWhenHiddenRef: MutableRefObject<boolean>;
    consecutiveErrorBreakerRef: MutableRefObject<
        ReturnType<typeof createConsecutiveErrorBreaker>
    >;
    currentTrackRef: MutableRefObject<Track | null>;
    playbackTypeRef: MutableRefObject<"track" | "audiobook" | "podcast" | null>;
    loadIdRef: MutableRefObject<number>;
    lastHandledTrackEndRef: MutableRefObject<{
        trackId: string | null;
        loadId: number;
        handledAtMs: number;
    }>;
    activeEngineTrackIdRef: MutableRefObject<string | null>;
    activeEngineLoadIdRef: MutableRefObject<number>;
    advancePlayIntentAtMsRef: MutableRefObject<number | null>;
    trackEndWatchdogRef: MutableRefObject<TrackEndWatchdog | null>;
}

/** Keeps the existing foreground audio-session recovery effect isolated. */
export function useForegroundRecovery({
    currentAudiobook,
    currentPodcast,
    next,
    setIsBuffering,
    wasPlayingWhenHiddenRef,
    consecutiveErrorBreakerRef,
    currentTrackRef,
    playbackTypeRef,
    loadIdRef,
    lastHandledTrackEndRef,
    activeEngineTrackIdRef,
    activeEngineLoadIdRef,
    advancePlayIntentAtMsRef,
    trackEndWatchdogRef,
}: UseForegroundRecoveryOptions): void {
    // Foreground recovery: when the page returns from background and
    // audio was playing when it went hidden but the engine is no longer
    // playing (OS reclaimed the audio session, or track ended while
    // backgrounded), either advance to the next track or retry playback.
    // The playing state is snapshotted at the "hidden" transition — not from
    // a persistent "ever played" flag — to prevent spurious recovery on
    // desktop when a user pauses then switches tabs.
    useEffect(() => {
        if (typeof document === "undefined") return;

        let recoveryTimeoutId: ReturnType<typeof setTimeout> | null = null;

        const handleVisibilityChange = () => {
            // On hidden: snapshot whether the engine is currently playing.
            // This snapshot is used on the subsequent visible transition to
            // decide if recovery is needed.
            if (document.visibilityState === "hidden") {
                wasPlayingWhenHiddenRef.current = audioEngine.isPlaying();
                return;
            }

            consecutiveErrorBreakerRef.current.reset();

            const decision = resolveForegroundRecoveryDecision({
                isVisible: true,
                wasPlayingWhenHidden: wasPlayingWhenHiddenRef.current,
                engineIsPlaying: audioEngine.isPlaying(),
                machineState: playbackStateMachine.getState(),
            });

            if (!decision.shouldRecover) return;

            const currentMediaId =
                currentTrackRef.current?.id ??
                currentAudiobook?.id ??
                currentPodcast?.id ??
                null;
            if (!currentMediaId) return;

            // Detect whether the track finished while backgrounded.
            // This check runs before the throttle gate so that a
            // completed track is never suppressed by cooldown timing.
            if (playbackTypeRef.current === "track") {
                const trackEnded =
                    typeof audioEngine.hasTrackEnded === "function"
                        ? audioEngine.hasTrackEnded()
                        : (() => {
                              const d = audioEngine.getDuration();
                              const p = audioEngine.getCurrentTime();
                              return d > 0 && p >= d - 0.1;
                          })();
                if (trackEnded) {
                    const currentLoadId = loadIdRef.current;
                    const lastHandled = lastHandledTrackEndRef.current;
                    const endWasAlreadyHandled =
                        lastHandled.trackId === currentMediaId &&
                        lastHandled.loadId === currentLoadId;
                    const engineSourceMatchesCurrentTrack =
                        activeEngineTrackIdRef.current === currentMediaId &&
                        activeEngineLoadIdRef.current === currentLoadId;
                    if (
                        !endWasAlreadyHandled &&
                        engineSourceMatchesCurrentTrack
                    ) {
                        const now = Date.now();
                        lastHandledTrackEndRef.current = {
                            trackId: currentMediaId,
                            loadId: currentLoadId,
                            handledAtMs: now,
                        };
                        advancePlayIntentAtMsRef.current = now;
                        orchestratorLogger.info(
                            "Foreground recovery advancing ended track",
                            {
                                trackId: currentMediaId,
                                loadId: currentLoadId,
                            },
                        );
                        trackEndWatchdogRef.current?.clear();
                        logPlaybackClientMetric("player.track_end_advanced", {
                            trackId: currentMediaId,
                            viaWatchdog: false,
                        });
                        next();
                        return;
                    }
                }
            }

            if (shouldThrottleForegroundRecovery()) return;

            sharedFrontendLogger.info(
                "[AudioPlaybackOrchestrator] Foreground recovery: retrying playback after app resume",
                { reason: decision.reason, trackId: currentMediaId },
            );

            playbackStateMachine.forceTransition("RECOVERING");
            setIsBuffering(true);

            // Small delay to let the audio session re-establish.
            // Guarded by machine state: if something else transitions the
            // machine during the delay (user pause, media clear), recovery
            // is aborted.
            recoveryTimeoutId = setTimeout(() => {
                recoveryTimeoutId = null;
                if (playbackStateMachine.getState() !== "RECOVERING") return;
                playbackStateMachine.forceTransition("LOADING");
                audioEngine.play();
            }, 300);
        };

        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            document.removeEventListener(
                "visibilitychange",
                handleVisibilityChange,
            );
            if (recoveryTimeoutId !== null) {
                clearTimeout(recoveryTimeoutId);
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [currentAudiobook?.id, currentPodcast?.id, next, setIsBuffering]);
}
