"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { usePlaybackStatus } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { PlaybackProgressSnapshot } from "@/components/player/PlaybackProgressSnapshot";
import {
    shouldAllowInitialPersistedTrackResume,
    shouldPreemptInFlightAudioLoad,
} from "@/lib/audio-load-preemption";
import { api } from "@/lib/api";
import type { AudioEngineErrorPayload } from "@/lib/audio-engine/types";
import { resolveNextTrackPreloadDecision } from "@/lib/audio-engine/nextTrackPreloadPolicy";
import { resolveQueueAdvance } from "@/lib/audio/queue-advance-policy";
import {
    getListenTogetherSessionSnapshot,
    isListenTogetherActiveOrPending,
} from "@/lib/listen-together-session";
import { shouldAutoMatchVibeAtQueueEnd } from "./autoMatchVibePlayback";
import {
    isAdvancePlayIntentFresh,
    resolveLoadAutoplayDecision,
    resolvePlaybackDuration,
    resolveRemoteStreamFormat,
    shouldAttemptRecoveryOnUnexpectedPause,
} from "./audioPlaybackOrchestratorPolicy";
import { readMigratingStorageItem } from "@/lib/storage-migration";
import { playbackStateMachine } from "@/lib/audio";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, memo } from "react";
import { toast } from "sonner";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import {
    getNextTrackInfo,
    resolveDirectTrackSourceType,
} from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import {
    AUDIO_LOAD_RETRY_DELAY_MS,
    AUDIO_LOAD_TIMEOUT_MS,
    AUDIO_LOAD_TIMEOUT_RETRIES,
    CURRENT_TIME_KEY,
    CURRENT_TIME_TRACK_ID_KEY,
    FORMAT_TO_CODEC,
    STARTUP_AUDIBLE_THRESHOLD_SEC,
    TRACK_END_WATCHDOG_BOUNDARY_SEC,
    UNEXPECTED_PAUSE_RECOVERY_DEBOUNCE_MS,
    UNEXPECTED_PAUSE_RECOVERY_MAX_BUFFERED_AHEAD_SEC,
    UNEXPECTED_PAUSE_RECOVERY_MIN_SILENCE_MS,
} from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import {
    audioEngine,
    logPlaybackClientMetric,
    orchestratorLogger,
    podcastDebugLog,
} from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import type { DesiredLoadPlayIntent } from "./hooks";
import * as H from "./hooks";
/**
 * AudioPlaybackOrchestrator - Unified audio playback using runtime audio engines
 * Handles: web playback, progress saving for audiobooks/podcasts
 * Browser media controls are handled separately by useMediaSession hook
 */
export const AudioPlaybackOrchestrator = memo(
    function AudioPlaybackOrchestrator() {
        const {
            currentTrack,
            currentAudiobook,
            currentPodcast,
            playbackType,
            volume,
            isMuted,
            repeatMode,
            setCurrentAudiobook,
            setCurrentTrack,
            setCurrentPodcast,
            setPlaybackType,
            queue,
            currentIndex,
            isShuffle,
            shuffleIndices,
        } = useAudioState();
        // Playback context
        const {
            isPlaying,
            setCurrentTime,
            setCurrentTimeFromEngine,
            setDuration,
            setIsPlaying,
            isBuffering,
            setIsBuffering,
            setTargetSeekPosition,
            canSeek,
            setCanSeek,
            setDownloadProgress,
            setStreamProfile,
        } = usePlaybackStatus();
        // Controls context
        const { pause, next, startVibeMode } = useAudioControls();
        const queryClient = useQueryClient();
        const orchestratorRefs = H.usePlaybackOrchestratorRefs({
            currentTrack,
            playbackType,
            queueLength: queue.length,
            isPlaying,
            volume,
            isMuted,
        });
        const {
            lastTrackIdRef,
            hasSeenTrackLoadRef,
            lastPlayingStateRef,
            advancePlayIntentAtMsRef,
            progressSaveIntervalRef,
            lastProgressSaveRef,
            isUserInitiatedRef,
            isLoadingRef,
            outputStateRef,
            loadIdRef,
            desiredLoadPlayRef,
            cancelledLoadPlayIdRef,
            loadTimeoutRef,
            loadTimeoutRetryCountRef,
            seekReloadListenerRef,
            seekReloadInProgressRef,
            isSeekingRef,
            loadListenerRef,
            loadErrorListenerRef,
            lastPreloadedTrackIdRef,
            consecutiveErrorBreakerRef,
            wasPlayingWhenHiddenRef,
            currentTrackRef,
            currentTimeSnapshotRef,
            currentTimeSnapshotTrackIdRef,
            playbackTypeRef,
            activeEngineTrackIdRef,
            activeEngineLoadIdRef,
            engineEventHandlersRef,
            recoverablePlayErrorPendingRef,
            unexpectedPauseRecoveryTimeoutRef,
            lastTrackTimeUpdateAtMsRef,
            ytMusicAuthenticatedRef,
            lastHandledTrackEndRef,
            trackEndWatchdogRef,
            howlerLoadStartMsRef,
            heartbeatRef,
        } = orchestratorRefs;
        const applyCurrentOutputState = H.useApplyCurrentOutputState({
            refs: orchestratorRefs,
        });
        const { markStartupStabilityWindow, noteStartupProgress } =
            H.useStartupStability({ refs: orchestratorRefs });
        const playbackRecoveryHelpers = H.usePlaybackRecoveryHelpers({
            refs: orchestratorRefs,
        });
        const {
            clearPendingTrackErrorSkip,
            clearUnexpectedPauseRecoveryCheck,
            resolveBufferedAheadSec,
            clearStartupPlaybackRecovery,
            clearTransientTrackRecovery,
            settleTransientRecoveryAfterLoad,
        } = playbackRecoveryHelpers;
        const {
            scheduleStartupPlaybackRecovery,
            requestListenTogetherFollowerRecovery,
            scheduleTrackErrorSkip,
            attemptTransientTrackRecovery,
        } = H.useTrackRecovery({
            refs: orchestratorRefs,
            playbackRecoveryHelpers,
            next,
            setCurrentTime,
            setIsBuffering,
        });
        H.useYtMusicAuth(ytMusicAuthenticatedRef);
        const requestAutoMatchVibe = H.useAutoMatchVibe({
            refs: orchestratorRefs,
            startVibeMode,
        });
        H.usePlaybackStateSync({
            refs: orchestratorRefs,
            playbackRecoveryHelpers,
            currentTrack,
            playbackType,
            queueLength: queue.length,
            isPlaying,
            isBuffering,
            setStreamProfile,
        });
        H.useQueueRecoveryEffects({
            refs: orchestratorRefs,
            playbackType,
            queueLength: queue.length,
            currentIndex,
            repeatMode,
            currentTrack,
            requestAutoMatchVibe,
            clearPendingTrackErrorSkip,
            clearStartupPlaybackRecovery,
            clearTransientTrackRecovery,
        });
        H.usePlaybackWatchdogs({
            refs: orchestratorRefs,
            trackRecovery: {
                scheduleStartupPlaybackRecovery,
                requestListenTogetherFollowerRecovery,
                scheduleTrackErrorSkip,
                attemptTransientTrackRecovery,
            },
            isPlaying,
            isBuffering,
            setIsBuffering,
            setIsPlaying,
        });
        H.usePlaybackMetadataSync({
            queryClient,
            playbackType,
            currentTrack,
            currentAudiobook,
            currentPodcast,
            setDuration,
        });
        const { saveAudiobookProgress, savePodcastProgress } =
            H.useProgressSaveCallbacks({
                currentAudiobook,
                currentPodcast,
                isBuffering,
                setCurrentAudiobook,
                lastProgressSaveRef,
            });
        // Refresh event behavior after every render without detaching listeners.
        useLayoutEffect(() => {
            const handleTimeUpdate = (data: {
                timeSec: number;
                time?: number;
            }) => {
                const currentTimeValue =
                    typeof data.timeSec === "number"
                        ? data.timeSec
                        : (data.time ?? 0);
                const invocationTrackId =
                    playbackType === "track"
                        ? (currentTrack?.id ?? null)
                        : null;
                // Use setCurrentTimeFromEngine to respect seek lock
                // This prevents stale timeupdate events from overwriting optimistic seek updates
                // and blocks stale callbacks from a prior track listener closure.
                // Skip during loading: the engine may still report the previous track's position
                // after React refreshes this delegated closure with the new track's ID but before
                // audioEngine.load() replaces the source.
                if (!isLoadingRef.current) {
                    setCurrentTimeFromEngine(
                        currentTimeValue,
                        invocationTrackId,
                    );
                }
                if (playbackTypeRef.current === "track") {
                    const liveTrackId = currentTrackRef.current?.id ?? null;

                    // Some engine/runtime combinations can emit audible progress before
                    // the synthetic "load" callback. Treat first real progress as loaded
                    // to avoid startup timeout retries that restart healthy playback.
                    if (
                        isLoadingRef.current &&
                        liveTrackId &&
                        currentTimeValue >= STARTUP_AUDIBLE_THRESHOLD_SEC
                    ) {
                        if (loadTimeoutRef.current) {
                            clearTimeout(loadTimeoutRef.current);
                            loadTimeoutRef.current = null;
                        }
                        loadTimeoutRetryCountRef.current = 0;
                        isLoadingRef.current = false;
                        activeEngineTrackIdRef.current = liveTrackId;
                        activeEngineLoadIdRef.current = loadIdRef.current;
                        logPlaybackClientMetric(
                            "session.startup_timeout_skip",
                            {
                                trackId: liveTrackId,
                                sourceType: currentTrackRef.current
                                    ? resolveDirectTrackSourceType(
                                          currentTrackRef.current,
                                      )
                                    : "unknown",
                                reason: "progress_before_load_event",
                            },
                        );
                    }

                    lastTrackTimeUpdateAtMsRef.current = Date.now();
                    if (audioEngine.isPlaying()) {
                        clearUnexpectedPauseRecoveryCheck();
                    }
                    noteStartupProgress(liveTrackId, currentTimeValue);

                    const durationSec = audioEngine.getDuration();
                    const isEndAdjacent =
                        !isLoadingRef.current &&
                        Boolean(liveTrackId) &&
                        Number.isFinite(durationSec) &&
                        durationSec > 0 &&
                        durationSec - currentTimeValue <=
                            TRACK_END_WATCHDOG_BOUNDARY_SEC;
                    if (isEndAdjacent && liveTrackId) {
                        trackEndWatchdogRef.current?.arm({
                            trackId: liveTrackId,
                            loadId: loadIdRef.current,
                            statusWasPlaying:
                                audioEngine.isPlaying() ||
                                playbackStateMachine.isPlaying ||
                                isPlaying ||
                                lastPlayingStateRef.current,
                        });
                    } else {
                        trackEndWatchdogRef.current?.clear();
                    }
                }

                // Notify heartbeat of progress to detect stalls
                heartbeatRef.current?.notifyProgress(currentTimeValue);
            };

            const handleLoad = (data: {
                durationSec: number;
                duration?: number;
            }) => {
                trackEndWatchdogRef.current?.clear();
                const loadedDuration =
                    typeof data.durationSec === "number"
                        ? data.durationSec
                        : (data.duration ?? 0);
                const metadataDuration =
                    currentTrack?.duration ||
                    currentAudiobook?.duration ||
                    currentPodcast?.duration ||
                    0;
                const isRemote =
                    currentTrack?.streamSource === "tidal" ||
                    currentTrack?.streamSource === "youtube";
                setDuration(
                    resolvePlaybackDuration({
                        loadedDurationSec: loadedDuration,
                        metadataDurationSec: metadataDuration,
                        isRemoteStream: isRemote,
                    }),
                );
                settleTransientRecoveryAfterLoad();

                const desiredLoadPlay = desiredLoadPlayRef.current;
                const shouldPlayAfterLoad = Boolean(
                    desiredLoadPlay?.shouldPlay &&
                    desiredLoadPlay.loadId === loadIdRef.current,
                );

                // Autoplaying loads remain transitional until the engine's play
                // event lands. READY deliberately means the load should stay paused.
                if (
                    playbackStateMachine.getState() === "LOADING" &&
                    !shouldPlayAfterLoad
                ) {
                    playbackStateMachine.transition("READY");
                }

                if (
                    playbackType === "track" &&
                    currentTrack?.id &&
                    (lastPlayingStateRef.current ||
                        isPlaying ||
                        shouldPlayAfterLoad)
                ) {
                    scheduleStartupPlaybackRecovery(currentTrack.id);
                }

                if (howlerLoadStartMsRef.current > 0) {
                    const durationMs =
                        Date.now() - howlerLoadStartMsRef.current;
                    howlerLoadStartMsRef.current = 0;
                    logPlaybackClientMetric("player.engine_startup", {
                        durationMs,
                        trackId: currentTrack?.id ?? null,
                        sourceType: currentTrack
                            ? resolveDirectTrackSourceType(currentTrack)
                            : "unknown",
                        playbackType,
                    });
                }
            };

            const rejectTrackEnd = (
                reason:
                    | "engine_source_loading"
                    | "stale_engine_load"
                    | "stale_engine_track"
                    | "duplicate_end",
                details: Record<string, unknown> = {},
            ): void => {
                const fields = {
                    reason,
                    currentTrackId: currentTrackRef.current?.id ?? null,
                    activeEngineTrackId: activeEngineTrackIdRef.current,
                    activeLoadId: activeEngineLoadIdRef.current,
                };
                orchestratorLogger.warn("Rejected track end event", {
                    ...fields,
                    ...details,
                });
                logPlaybackClientMetric("player.track_end_rejected", fields);
            };

            const handleEnd = (viaWatchdog: boolean = false) => {
                const isListenTogether = Boolean(
                    getListenTogetherSessionSnapshot()?.groupId,
                );
                const currentTrackId = currentTrackRef.current?.id ?? null;
                const advanceEndedTrack = (): void => {
                    advancePlayIntentAtMsRef.current = Date.now();
                    logPlaybackClientMetric("player.track_end_advanced", {
                        trackId: currentTrackId,
                        viaWatchdog,
                    });
                    next();
                };
                if (playbackType === "track") {
                    if (isLoadingRef.current) {
                        rejectTrackEnd("engine_source_loading", {
                            currentLoadId: loadIdRef.current,
                        });
                        return;
                    }

                    // Guard: stale end event from a previous load cycle
                    if (activeEngineLoadIdRef.current !== loadIdRef.current) {
                        rejectTrackEnd("stale_engine_load", {
                            currentLoadId: loadIdRef.current,
                        });
                        return;
                    }
                    const activeEngineTrackId = activeEngineTrackIdRef.current;
                    if (
                        currentTrackId &&
                        activeEngineTrackId &&
                        currentTrackId !== activeEngineTrackId
                    ) {
                        rejectTrackEnd("stale_engine_track");
                        return;
                    }

                    const activeLoadId = loadIdRef.current;
                    const now = Date.now();
                    const lastHandled = lastHandledTrackEndRef.current;
                    if (repeatMode !== "one") {
                        if (
                            currentTrackId &&
                            lastHandled.trackId === currentTrackId &&
                            lastHandled.loadId === activeLoadId &&
                            now - lastHandled.handledAtMs < 1500
                        ) {
                            rejectTrackEnd("duplicate_end", {
                                sinceLastHandledMs:
                                    now - lastHandled.handledAtMs,
                            });
                            return;
                        }
                        lastHandledTrackEndRef.current = {
                            trackId: currentTrackId,
                            loadId: activeLoadId,
                            handledAtMs: now,
                        };
                    }
                    trackEndWatchdogRef.current?.clear();
                }

                // Save final progress for audiobooks/podcasts
                if (playbackType === "audiobook" && currentAudiobook) {
                    saveAudiobookProgress(true);
                } else if (playbackType === "podcast" && currentPodcast) {
                    savePodcastProgress(true);
                }

                // Handle track advancement based on playback type
                if (playbackType === "podcast") {
                    // Episodes advance through the same unified mixed-media queue
                    // as tracks; pause when the queue has nowhere left to go.
                    const podcastAdvance = resolveQueueAdvance({
                        action: "next",
                        queue,
                        currentIndex,
                        isShuffle,
                        shuffleIndices,
                        repeatMode,
                    });
                    if (podcastAdvance.kind === "stop") {
                        pause();
                    } else {
                        advancePlayIntentAtMsRef.current = Date.now();
                        next();
                    }
                } else if (playbackType === "audiobook") {
                    pause();
                } else if (playbackType === "track") {
                    if (repeatMode === "one" && !isListenTogether) {
                        audioEngine.seek(0);
                        audioEngine.play();
                    } else {
                        // Eagerly preload the next track's audio before the React
                        // state update cycle to eliminate the silence gap on iOS
                        // where the OS reclaims the audio session between tracks.
                        // Uses preload() (not load()) so the subsequent track-change
                        // effect's load() call promotes the preloaded instance
                        // instantly instead of creating a redundant new one.
                        const preloadDecision = resolveNextTrackPreloadDecision(
                            {
                                playbackType,
                                repeatMode,
                                isListenTogether,
                                isLoading: isLoadingRef.current,
                            },
                        );
                        if (preloadDecision.shouldPreload) {
                            const nextTrack = getNextTrackInfo(
                                queue,
                                currentIndex,
                                isShuffle,
                                shuffleIndices,
                                repeatMode,
                            );
                            if (nextTrack) {
                                let preloadUrl: string;
                                let preloadFormat: string | undefined = "mp3";
                                if (
                                    nextTrack.streamSource === "tidal" &&
                                    nextTrack.tidalTrackId
                                ) {
                                    preloadUrl = api.getTidalStreamUrl(
                                        nextTrack.tidalTrackId,
                                    );
                                    preloadFormat =
                                        resolveRemoteStreamFormat("tidal");
                                } else if (
                                    nextTrack.streamSource === "youtube" &&
                                    nextTrack.youtubeVideoId
                                ) {
                                    preloadUrl = api.getYtMusicStreamUrl(
                                        nextTrack.youtubeVideoId,
                                        undefined,
                                        !ytMusicAuthenticatedRef.current,
                                    );
                                    preloadFormat =
                                        resolveRemoteStreamFormat("youtube");
                                } else if (
                                    nextTrack.streamSource ===
                                        "youtube-direct" &&
                                    nextTrack.youtubeVideoId
                                ) {
                                    preloadUrl = api.getYouTubeStreamUrl(
                                        nextTrack.youtubeVideoId,
                                    );
                                    preloadFormat =
                                        nextTrack.youtubeAudioFormat === "webm"
                                            ? "webm"
                                            : "mp4";
                                } else {
                                    preloadUrl = api.getStreamUrl(nextTrack.id);
                                    const ext = (nextTrack.filePath || "")
                                        .split(".")
                                        .pop()
                                        ?.toLowerCase();
                                    if (ext === "flac") preloadFormat = "flac";
                                    else if (ext === "m4a" || ext === "aac")
                                        preloadFormat = "mp4";
                                    else if (ext === "ogg" || ext === "opus")
                                        preloadFormat = "webm";
                                    else if (ext === "wav")
                                        preloadFormat = "wav";
                                }
                                audioEngine.preload(preloadUrl, {
                                    format: preloadFormat,
                                });
                            }
                        }

                        const shouldAutoMatchVibe =
                            shouldAutoMatchVibeAtQueueEnd({
                                playbackType,
                                queueLength: queue.length,
                                currentIndex,
                                repeatMode,
                                isListenTogether,
                            });

                        if (!shouldAutoMatchVibe || !currentTrack?.id) {
                            advanceEndedTrack();
                            return;
                        }

                        const endedTrackId = currentTrack.id;
                        void requestAutoMatchVibe(endedTrackId, {
                            force: true,
                        }).finally(() => {
                            if (currentTrackRef.current?.id !== endedTrackId)
                                return;
                            advanceEndedTrack();
                        });
                    }
                } else {
                    pause();
                }
            };

            const handleError = async (data: AudioEngineErrorPayload) => {
                const isRecoverablePlayError =
                    data.code === "NotAllowedError" ||
                    data.recoverable === true;
                if (isRecoverablePlayError) {
                    orchestratorLogger.warn(
                        "Playback deferred for browser-owned recovery",
                        {
                            code: data.code ?? null,
                            recoverable: data.recoverable === true,
                            trackId: currentTrackRef.current?.id ?? null,
                        },
                    );
                    howlerLoadStartMsRef.current = 0;
                    recoverablePlayErrorPendingRef.current = true;
                    isUserInitiatedRef.current = false;
                    playbackStateMachine.forceTransition("LOADING");
                    setIsPlaying(false);
                    setIsBuffering(true);
                    return;
                }

                sharedFrontendLogger.error(
                    "[AudioPlaybackOrchestrator] Playback error:",
                    data.error,
                );
                howlerLoadStartMsRef.current = 0;

                const errorMessage =
                    data.error instanceof Error
                        ? data.error.message
                        : String(data.error);
                const errorSourceType = currentTrack
                    ? resolveDirectTrackSourceType(currentTrack)
                    : "unknown";

                if (playbackType === "track") {
                    logPlaybackClientMetric("player.playback_error", {
                        trackId: currentTrack?.id ?? null,
                        sourceType: errorSourceType,
                        error: errorMessage,
                        stage: "pre_recovery",
                    });
                    const failedTrackId = currentTrack?.id ?? null;
                    const isTransientRecoveryScheduled =
                        attemptTransientTrackRecovery(
                            failedTrackId,
                            data.error,
                        );

                    if (isTransientRecoveryScheduled) {
                        logPlaybackClientMetric("player.rebuffer", {
                            reason: "transient_track_recovery",
                            trackId: failedTrackId,
                            sourceType: errorSourceType,
                        });
                        playbackStateMachine.forceTransition("LOADING");
                        setIsBuffering(true);
                        return;
                    }
                }

                // Transition state machine to ERROR
                playbackStateMachine.forceTransition("ERROR", {
                    error: errorMessage,
                });

                // Show a descriptive toast for YouTube-sourced tracks that fail
                if (
                    playbackType === "track" &&
                    (currentTrack?.streamSource === "youtube" ||
                        currentTrack?.streamSource === "youtube-direct")
                ) {
                    const source =
                        currentTrack.streamSource === "youtube-direct"
                            ? "YouTube"
                            : "YouTube Music";
                    toast.error(
                        `Couldn't stream "${currentTrack.title}" from ${source} — it may be age-restricted or unavailable.`,
                        { duration: 5000 },
                    );
                }

                setIsPlaying(false);
                setIsBuffering(false);
                logPlaybackClientMetric("player.playback_error", {
                    trackId: currentTrack?.id ?? null,
                    sourceType: errorSourceType,
                    error: errorMessage,
                    stage:
                        playbackType === "track"
                            ? "fatal_after_recovery"
                            : "fatal",
                });
                recoverablePlayErrorPendingRef.current = false;
                isUserInitiatedRef.current = false;
                heartbeatRef.current?.stop();
                clearTransientTrackRecovery(true);

                if (playbackType === "track") {
                    const failedTrackId = currentTrack?.id ?? null;
                    const listenTogetherSession =
                        getListenTogetherSessionSnapshot();
                    if (listenTogetherSession?.groupId) {
                        scheduleTrackErrorSkip(failedTrackId);
                        playbackStateMachine.forceTransition("LOADING");
                        setIsBuffering(true);
                        return;
                    }

                    if (queue.length > 1) {
                        scheduleTrackErrorSkip(failedTrackId);
                    } else {
                        clearPendingTrackErrorSkip();
                        // Preserve the current track on network errors so iOS
                        // foreground recovery can retry playback when the user
                        // returns to the app (MEDIA_ERR_NETWORK = code 2).
                        // AudioEngineErrorPayload.code is always string (adapters
                        // convert numeric MediaError codes to strings).
                        const errorPayload = data as {
                            error: unknown;
                            code?: string;
                        };
                        const isNetworkError =
                            errorMessage.includes("network") ||
                            errorMessage.includes("MEDIA_ERR_NETWORK") ||
                            errorPayload.code === "2";
                        if (!isNetworkError) {
                            lastTrackIdRef.current = null;
                            isLoadingRef.current = false;
                            setCurrentTrack(null);
                            setPlaybackType(null);
                        }
                    }
                } else if (playbackType === "audiobook") {
                    clearPendingTrackErrorSkip();
                    setCurrentAudiobook(null);
                    setPlaybackType(null);
                } else if (playbackType === "podcast") {
                    clearPendingTrackErrorSkip();
                    setCurrentPodcast(null);
                    setPlaybackType(null);
                }
            };

            const handlePlay = () => {
                // Transition state machine to PLAYING
                playbackStateMachine.transition("PLAYING");
                consecutiveErrorBreakerRef.current.recordSuccess();
                clearUnexpectedPauseRecoveryCheck();
                clearPendingTrackErrorSkip();
                clearStartupPlaybackRecovery();
                clearTransientTrackRecovery(true);
                if (recoverablePlayErrorPendingRef.current) {
                    recoverablePlayErrorPendingRef.current = false;
                    setIsBuffering(false);
                }
                if (playbackTypeRef.current === "track") {
                    lastTrackTimeUpdateAtMsRef.current = Date.now();
                }

                if (!isUserInitiatedRef.current) {
                    setIsPlaying(true);
                }
                isUserInitiatedRef.current = false;
            };

            const handlePause = () => {
                trackEndWatchdogRef.current?.clear();
                if (isLoadingRef.current) return;
                if (seekReloadInProgressRef.current) return;
                clearUnexpectedPauseRecoveryCheck();

                const currentPositionSec = Math.max(
                    0,
                    typeof audioEngine.getActualCurrentTime === "function"
                        ? audioEngine.getActualCurrentTime()
                        : audioEngine.getCurrentTime(),
                );
                const durationSec = audioEngine.getDuration();
                const nearTrackEnd =
                    Number.isFinite(durationSec) &&
                    durationSec > 0 &&
                    durationSec - currentPositionSec <= 0.75;
                const hasPlayIntent =
                    playbackStateMachine.isPlaying ||
                    isPlaying ||
                    lastPlayingStateRef.current;
                const isNonUserPause = !isUserInitiatedRef.current;

                // In a listen-together session as a follower, the host heartbeat
                // mechanism handles playback recovery. Independent pause recovery
                // would race with it and cause overlapping audio.
                const ltSession = getListenTogetherSessionSnapshot();
                const isListenTogetherFollower = Boolean(
                    ltSession?.groupId && !ltSession.isHost,
                );

                const shouldAttemptUnexpectedPauseRecovery =
                    playbackType === "track" &&
                    isNonUserPause &&
                    hasPlayIntent &&
                    !nearTrackEnd &&
                    !isListenTogetherFollower;

                if (shouldAttemptUnexpectedPauseRecovery) {
                    const pauseObservedAtMs = Date.now();
                    const pausedTrackId = currentTrack?.id ?? null;

                    const finalizeAsRegularPause = () => {
                        if (playbackStateMachine.isPlaying) {
                            playbackStateMachine.transition("READY");
                        }
                        if (!isUserInitiatedRef.current) {
                            setIsPlaying(false);
                        }
                    };

                    const runUnexpectedPauseRecoveryCheck = () => {
                        unexpectedPauseRecoveryTimeoutRef.current = null;

                        if (
                            playbackTypeRef.current !== "track" ||
                            seekReloadInProgressRef.current ||
                            isLoadingRef.current
                        ) {
                            return;
                        }

                        const liveTrackId = currentTrackRef.current?.id ?? null;
                        if (!liveTrackId || liveTrackId !== pausedTrackId) {
                            return;
                        }

                        const stillPaused = !audioEngine.isPlaying();
                        if (!stillPaused) {
                            return;
                        }

                        const silenceSinceTimeUpdateMs = Math.max(
                            0,
                            Date.now() - lastTrackTimeUpdateAtMsRef.current,
                        );
                        if (
                            silenceSinceTimeUpdateMs <
                            UNEXPECTED_PAUSE_RECOVERY_MIN_SILENCE_MS
                        ) {
                            const remainingSilenceMs =
                                UNEXPECTED_PAUSE_RECOVERY_MIN_SILENCE_MS -
                                silenceSinceTimeUpdateMs;
                            unexpectedPauseRecoveryTimeoutRef.current =
                                setTimeout(
                                    runUnexpectedPauseRecoveryCheck,
                                    Math.min(
                                        UNEXPECTED_PAUSE_RECOVERY_DEBOUNCE_MS,
                                        Math.max(remainingSilenceMs, 50),
                                    ),
                                );
                            return;
                        }

                        const bufferedAheadSec = resolveBufferedAheadSec();
                        const hasBufferedAheadMeasurement =
                            Number.isFinite(bufferedAheadSec);
                        const hasLowBufferedAhead =
                            shouldAttemptRecoveryOnUnexpectedPause(
                                bufferedAheadSec,
                                UNEXPECTED_PAUSE_RECOVERY_MAX_BUFFERED_AHEAD_SEC,
                            );

                        if (!hasBufferedAheadMeasurement) {
                            logPlaybackClientMetric("player.unexpected_pause", {
                                reason: "pause_without_buffered_ahead_measurement",
                                trackId: liveTrackId,
                                sourceType: currentTrackRef.current
                                    ? resolveDirectTrackSourceType(
                                          currentTrackRef.current,
                                      )
                                    : "unknown",
                                hasPlayIntent,
                                nearTrackEnd,
                                bufferedAheadSec,
                                silenceSinceTimeUpdateMs,
                            });
                            finalizeAsRegularPause();
                            return;
                        }

                        if (!hasLowBufferedAhead) {
                            logPlaybackClientMetric("player.unexpected_pause", {
                                reason: "pause_with_buffered_ahead",
                                trackId: liveTrackId,
                                sourceType: currentTrackRef.current
                                    ? resolveDirectTrackSourceType(
                                          currentTrackRef.current,
                                      )
                                    : "unknown",
                                hasPlayIntent,
                                nearTrackEnd,
                                bufferedAheadSec,
                                silenceSinceTimeUpdateMs,
                            });
                            finalizeAsRegularPause();
                            return;
                        }

                        const pauseError = new Error(
                            "Playback paused unexpectedly while track intent is playing",
                        );
                        logPlaybackClientMetric("player.unexpected_pause", {
                            reason: "engine_pause_while_play_intent_stall_confirmed",
                            trackId: liveTrackId,
                            sourceType: currentTrackRef.current
                                ? resolveDirectTrackSourceType(
                                      currentTrackRef.current,
                                  )
                                : "unknown",
                            hasPlayIntent,
                            nearTrackEnd,
                            bufferedAheadSec,
                            silenceSinceTimeUpdateMs,
                            debounceElapsedMs: Math.max(
                                0,
                                Date.now() - pauseObservedAtMs,
                            ),
                            stateMachineState: playbackStateMachine.getState(),
                            uiIsPlaying: isPlaying,
                        });
                        setIsBuffering(true);
                        playbackStateMachine.forceTransition("LOADING");
                        const didScheduleTransientRecovery =
                            attemptTransientTrackRecovery(
                                liveTrackId,
                                pauseError,
                            );
                        if (didScheduleTransientRecovery) {
                            return;
                        }

                        setIsPlaying(false);
                        setIsBuffering(false);
                        playbackStateMachine.forceTransition("READY");
                    };

                    unexpectedPauseRecoveryTimeoutRef.current = setTimeout(
                        runUnexpectedPauseRecoveryCheck,
                        UNEXPECTED_PAUSE_RECOVERY_DEBOUNCE_MS,
                    );
                    isUserInitiatedRef.current = false;
                    return;
                }
                if (isNonUserPause && playbackType === "track") {
                    logPlaybackClientMetric("player.unexpected_pause", {
                        reason: nearTrackEnd
                            ? "pause_near_track_end"
                            : "pause_without_play_intent",
                        trackId: currentTrack?.id ?? null,
                        sourceType: currentTrack
                            ? resolveDirectTrackSourceType(currentTrack)
                            : "unknown",
                        hasPlayIntent,
                        nearTrackEnd,
                        stateMachineState: playbackStateMachine.getState(),
                        uiIsPlaying: isPlaying,
                    });
                }

                // Transition state machine to READY (paused)
                if (playbackStateMachine.isPlaying) {
                    playbackStateMachine.transition("READY");
                }

                if (!isUserInitiatedRef.current) {
                    setIsPlaying(false);
                }
                isUserInitiatedRef.current = false;
            };
            engineEventHandlersRef.current = {
                handleTimeUpdate,
                handleLoad,
                handleEnd,
                handleError,
                handlePlay,
                handlePause,
                cleanup: clearUnexpectedPauseRecoveryCheck,
            };
        });
        H.useAudioEngineBindings({ refs: orchestratorRefs });
        H.useForegroundRecovery({
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
        });
        // Load and play audio when track changes
        useEffect(() => {
            // Keep queue-triggered loads aligned with the latest UI output state,
            // even when track and volume updates are committed in the same render.
            outputStateRef.current = { volume, isMuted };

            const currentMediaId =
                currentTrack?.id ||
                currentAudiobook?.id ||
                currentPodcast?.id ||
                null;

            if (!currentMediaId) {
                trackEndWatchdogRef.current?.clear();
                desiredLoadPlayRef.current = null;
                cancelledLoadPlayIdRef.current = null;
                wasPlayingWhenHiddenRef.current = false;
                markStartupStabilityWindow(null, "media_cleared");
                setStreamProfile(null);
                clearPendingTrackErrorSkip();
                clearStartupPlaybackRecovery();
                clearTransientTrackRecovery(true);
                if (loadTimeoutRef.current) {
                    clearTimeout(loadTimeoutRef.current);
                    loadTimeoutRef.current = null;
                }
                loadTimeoutRetryCountRef.current = 0;
                activeEngineTrackIdRef.current = null;
                audioEngine.stop();
                lastTrackIdRef.current = null;
                isLoadingRef.current = false;
                playbackStateMachine.forceTransition("IDLE");
                heartbeatRef.current?.stop();
                return;
            }

            const previousMediaId = lastTrackIdRef.current;
            if (currentMediaId !== previousMediaId) {
                trackEndWatchdogRef.current?.clear();
            }

            if (currentMediaId === previousMediaId) {
                // Skip if a seek operation is in progress - the seek handler will manage playback
                if (isSeekingRef.current) {
                    return;
                }

                // Skip if the track is still loading — the load-complete handler
                // will start playback.  Without this guard, a second play click
                // during loading can race with the load callback and produce
                // overlapping audio streams.
                if (isLoadingRef.current) {
                    return;
                }

                const shouldPlay = lastPlayingStateRef.current || isPlaying;
                const isCurrentlyPlaying = audioEngine.isPlaying();

                if (shouldPlay && !isCurrentlyPlaying) {
                    applyCurrentOutputState();
                    audioEngine.play();
                }
                return;
            }

            if (previousMediaId !== null) {
                // Selection changed: stop any audible tail from the previous source
                // while startup/session resolution for the next track is in-flight.
                audioEngine.stop();
                activeEngineTrackIdRef.current = null;
            }

            if (
                shouldPreemptInFlightAudioLoad({
                    currentMediaId,
                    previousMediaId,
                    isLoading: isLoadingRef.current,
                })
            ) {
                // Track switches must preempt in-flight loads; otherwise the new
                // selection can be dropped and old audio continues playing.
                clearPendingTrackErrorSkip();
                clearStartupPlaybackRecovery();
                clearTransientTrackRecovery(true);
                if (loadTimeoutRef.current) {
                    clearTimeout(loadTimeoutRef.current);
                    loadTimeoutRef.current = null;
                }
                if (loadListenerRef.current) {
                    audioEngine.off("load", loadListenerRef.current);
                    loadListenerRef.current = null;
                }
                if (loadErrorListenerRef.current) {
                    audioEngine.off("loaderror", loadErrorListenerRef.current);
                    loadErrorListenerRef.current = null;
                }
                if (seekReloadListenerRef.current) {
                    audioEngine.off("load", seekReloadListenerRef.current);
                    seekReloadListenerRef.current = null;
                }
                seekReloadInProgressRef.current = false;
                activeEngineTrackIdRef.current = null;
                audioEngine.stop();
                isLoadingRef.current = false;
            }

            if (isLoadingRef.current) return;

            isLoadingRef.current = true;
            activeEngineTrackIdRef.current = null;
            activeEngineLoadIdRef.current = -1;
            lastTrackIdRef.current = currentMediaId;
            loadIdRef.current += 1;
            const thisLoadId = loadIdRef.current;
            desiredLoadPlayRef.current = null;
            cancelledLoadPlayIdRef.current = null;
            const hasAdvancePlayIntent = isAdvancePlayIntentFresh(
                advancePlayIntentAtMsRef.current,
                Date.now(),
            );
            advancePlayIntentAtMsRef.current = null;
            if (
                playbackType === "track" &&
                previousMediaId !== null &&
                !hasAdvancePlayIntent
            ) {
                consecutiveErrorBreakerRef.current.reset();
            }
            loadTimeoutRetryCountRef.current = 0;
            markStartupStabilityWindow(
                playbackType === "track" ? (currentTrack?.id ?? null) : null,
                "track_load_started",
            );

            if (loadTimeoutRef.current) {
                clearTimeout(loadTimeoutRef.current);
                loadTimeoutRef.current = null;
            }

            // Transition state machine to LOADING
            playbackStateMachine.forceTransition("LOADING");

            let streamUrl: string | null = null;
            let startTime = 0;

            if (playbackType === "track" && currentTrack) {
                const isInitialTrackLoad = !hasSeenTrackLoadRef.current;
                if (isInitialTrackLoad) {
                    hasSeenTrackLoadRef.current = true;
                }

                // TIDAL streaming takes priority
                if (
                    currentTrack.streamSource === "tidal" &&
                    currentTrack.tidalTrackId
                ) {
                    streamUrl = api.getTidalStreamUrl(
                        currentTrack.tidalTrackId,
                    );
                } else if (
                    currentTrack.streamSource === "youtube" &&
                    currentTrack.youtubeVideoId
                ) {
                    // Prefer authenticated endpoint when user has YT Music OAuth, else public
                    streamUrl = api.getYtMusicStreamUrl(
                        currentTrack.youtubeVideoId,
                        undefined,
                        !ytMusicAuthenticatedRef.current,
                    );
                } else if (
                    currentTrack.streamSource === "youtube-direct" &&
                    currentTrack.youtubeVideoId
                ) {
                    streamUrl = api.getYouTubeStreamUrl(
                        currentTrack.youtubeVideoId,
                    );
                } else {
                    streamUrl = api.getStreamUrl(currentTrack.id);
                }
                // Only restore persisted position on initial player boot when
                // Listen Together playback is not active or pending.
                const allowPersistedResume =
                    shouldAllowInitialPersistedTrackResume({
                        isInitialTrackLoad,
                        listenTogetherActiveOrPending:
                            isListenTogetherActiveOrPending(),
                    });
                if (allowPersistedResume && typeof window !== "undefined") {
                    let resumeTrackId: string | null = null;
                    let persistedCurrentTime = 0;
                    try {
                        resumeTrackId = readMigratingStorageItem(
                            CURRENT_TIME_TRACK_ID_KEY,
                        );
                        const persistedRaw =
                            readMigratingStorageItem(CURRENT_TIME_KEY);
                        const parsed = Number.parseFloat(
                            String(persistedRaw ?? "0"),
                        );
                        persistedCurrentTime = Number.isFinite(parsed)
                            ? Math.max(0, parsed)
                            : 0;
                    } catch {
                        resumeTrackId = null;
                        persistedCurrentTime = 0;
                    }

                    if (
                        resumeTrackId === currentTrack.id &&
                        persistedCurrentTime > 0
                    ) {
                        startTime = persistedCurrentTime;
                    }
                }
            } else if (playbackType === "audiobook" && currentAudiobook) {
                streamUrl = api.getAudiobookStreamUrl(currentAudiobook.id);
                startTime = currentAudiobook.progress?.currentTime || 0;
            } else if (playbackType === "podcast" && currentPodcast) {
                const [podcastId, episodeId] = currentPodcast.id.split(":");
                streamUrl = api.getPodcastEpisodeStreamUrl(
                    podcastId,
                    episodeId,
                );
                startTime = currentPodcast.progress?.currentTime || 0;
                podcastDebugLog("load podcast", {
                    currentPodcastId: currentPodcast.id,
                    podcastId,
                    episodeId,
                    title: currentPodcast.title,
                    podcastTitle: currentPodcast.podcastTitle,
                    startTime,
                    loadId: thisLoadId,
                });
            }

            if (streamUrl) {
                setCurrentTime(Math.max(0, startTime));
                const wasEnginePlayingBeforeLoad = audioEngine.isPlaying();
                const fallbackDuration =
                    currentTrack?.duration ||
                    currentAudiobook?.duration ||
                    currentPodcast?.duration ||
                    0;
                setDuration(fallbackDuration);

                let format: string | undefined = "mp3";
                if (currentTrack?.streamSource === "youtube-direct") {
                    // Direct YouTube audio is opus-in-webm or AAC-in-mp4
                    // depending on the source video; /api/youtube/info reports
                    // the container as audioFormat.
                    format =
                        currentTrack.youtubeAudioFormat === "webm"
                            ? "webm"
                            : "mp4";
                } else if (
                    currentTrack?.streamSource === "tidal" ||
                    currentTrack?.streamSource === "youtube"
                ) {
                    format = resolveRemoteStreamFormat(
                        currentTrack.streamSource,
                    );
                } else {
                    const filePath = currentTrack?.filePath || "";
                    if (filePath) {
                        const ext = filePath.split(".").pop()?.toLowerCase();
                        if (ext === "flac") format = "flac";
                        else if (ext === "m4a" || ext === "aac") format = "mp4";
                        else if (ext === "ogg" || ext === "opus")
                            format = "webm";
                        else if (ext === "wav") format = "wav";
                    }
                }

                if (playbackType === "track" && currentTrack) {
                    setStreamProfile({
                        mode: "direct",
                        sourceType: resolveDirectTrackSourceType(currentTrack),
                        codec:
                            (format ? FORMAT_TO_CODEC[format] : null) ?? null,
                        bitrateKbps: null,
                    });
                } else {
                    setStreamProfile(null);
                }

                const clearLoadListeners = () => {
                    if (loadListenerRef.current) {
                        audioEngine.off("load", loadListenerRef.current);
                        loadListenerRef.current = null;
                    }
                    if (loadErrorListenerRef.current) {
                        audioEngine.off(
                            "loaderror",
                            loadErrorListenerRef.current,
                        );
                        loadErrorListenerRef.current = null;
                    }
                };

                let capturedLoadPlayIntent: DesiredLoadPlayIntent | null = null;

                const startLoadAttempt = () => {
                    clearLoadListeners();

                    if (loadTimeoutRef.current) {
                        clearTimeout(loadTimeoutRef.current);
                        loadTimeoutRef.current = null;
                    }

                    if (
                        loadIdRef.current !== thisLoadId ||
                        !isLoadingRef.current
                    ) {
                        return;
                    }

                    const deferAutoplay = startTime > 0;
                    if (!capturedLoadPlayIntent) {
                        const listenTogetherSnapshotForLoad =
                            getListenTogetherSessionSnapshot();
                        const wasPlayingBeforeLoad =
                            lastPlayingStateRef.current ||
                            wasEnginePlayingBeforeLoad;
                        const resolvedShouldAutoPlay =
                            resolveLoadAutoplayDecision({
                                wasPlayingBeforeLoad,
                                hasAdvancePlayIntent,
                                // Followers start playback via the LT play-at/delta
                                // resume, never from local state (audible-blip fix).
                                isListenTogetherFollower: Boolean(
                                    listenTogetherSnapshotForLoad?.groupId &&
                                    !listenTogetherSnapshotForLoad.isHost,
                                ),
                            });
                        const shouldAutoPlayOnLoad =
                            cancelledLoadPlayIdRef.current === thisLoadId
                                ? false
                                : resolvedShouldAutoPlay;
                        capturedLoadPlayIntent = {
                            loadId: thisLoadId,
                            shouldPlay: shouldAutoPlayOnLoad,
                            decidedAtMs: Date.now(),
                        };
                        desiredLoadPlayRef.current = capturedLoadPlayIntent;
                        logPlaybackClientMetric(
                            "player.load_autoplay_decision",
                            {
                                loadId: thisLoadId,
                                shouldAutoPlayOnLoad,
                                deferAutoplay,
                                hasAdvancePlayIntent,
                                wasPlayingBeforeLoad,
                                startTime,
                            },
                        );
                    }
                    const desiredLoadPlay = desiredLoadPlayRef.current;
                    const shouldAutoPlayOnLoad = Boolean(
                        desiredLoadPlay?.shouldPlay &&
                        desiredLoadPlay.loadId === thisLoadId,
                    );

                    howlerLoadStartMsRef.current = Date.now();
                    // When resuming from a non-zero position, defer autoplay to
                    // handleLoaded so the seek completes before playback starts.
                    // Passing autoplay=true here would cause Howler's onload to
                    // play() from position 0 before handleLoaded can seek,
                    // producing overlapping audio streams.
                    audioEngine.load(
                        streamUrl,
                        deferAutoplay ? false : shouldAutoPlayOnLoad,
                        format,
                    );
                    applyCurrentOutputState();

                    if (playbackType === "podcast" && currentPodcast) {
                        podcastDebugLog("audioEngine.load()", {
                            url: streamUrl,
                            format,
                            loadId: thisLoadId,
                            attempt: loadTimeoutRetryCountRef.current + 1,
                        });
                    }

                    const handleLoaded = () => {
                        if (loadIdRef.current !== thisLoadId) return;

                        if (loadTimeoutRef.current) {
                            clearTimeout(loadTimeoutRef.current);
                            loadTimeoutRef.current = null;
                        }
                        loadTimeoutRetryCountRef.current = 0;
                        isLoadingRef.current = false;
                        activeEngineTrackIdRef.current =
                            playbackType === "track" && currentTrack
                                ? currentTrack.id
                                : null;
                        activeEngineLoadIdRef.current =
                            playbackType === "track" && currentTrack
                                ? thisLoadId
                                : -1;

                        if (startTime > 0) {
                            audioEngine.seek(startTime);
                            setCurrentTime(startTime);
                        }

                        applyCurrentOutputState();
                        if (playbackType === "podcast" && currentPodcast) {
                            podcastDebugLog("loaded", {
                                loadId: thisLoadId,
                                durationEngine: audioEngine.getDuration(),
                                engineTime: audioEngine.getCurrentTime(),
                                actualTime: audioEngine.getActualCurrentTime(),
                                startTime,
                                canSeek,
                            });
                        }

                        const listenTogetherSnapshotAtLoaded =
                            getListenTogetherSessionSnapshot();
                        const desiredLoadPlay = desiredLoadPlayRef.current;
                        const shouldAutoPlay = Boolean(
                            desiredLoadPlay?.shouldPlay &&
                            desiredLoadPlay.loadId === thisLoadId &&
                            // Same follower rule as the load-time decision: the
                            // deferred (seek-then-play) path must not start
                            // follower playback from local state either.
                            !(
                                listenTogetherSnapshotAtLoaded?.groupId &&
                                !listenTogetherSnapshotAtLoaded.isHost
                            ),
                        );

                        if (shouldAutoPlay) {
                            setIsPlaying(true);
                            if (!audioEngine.isPlaying()) {
                                applyCurrentOutputState();
                                audioEngine.play();
                            }
                        }

                        clearLoadListeners();
                    };

                    const handleLoadError = (loadError?: unknown) => {
                        if (loadTimeoutRef.current) {
                            clearTimeout(loadTimeoutRef.current);
                            loadTimeoutRef.current = null;
                        }
                        const loadErrorMessage =
                            loadError instanceof Error
                                ? loadError.message
                                : String(loadError ?? "engine load error");
                        loadTimeoutRetryCountRef.current = 0;
                        isLoadingRef.current = false;
                        activeEngineTrackIdRef.current = null;
                        lastTrackIdRef.current = null;
                        playbackStateMachine.forceTransition("ERROR", {
                            error:
                                loadErrorMessage ||
                                "Audio failed while loading",
                            errorCode: 502,
                        });
                        setIsPlaying(false);
                        setIsBuffering(false);

                        // Show a descriptive toast for YouTube-sourced tracks that fail to load
                        if (
                            playbackType === "track" &&
                            (currentTrack?.streamSource === "youtube" ||
                                currentTrack?.streamSource === "youtube-direct")
                        ) {
                            const source =
                                currentTrack.streamSource === "youtube-direct"
                                    ? "YouTube"
                                    : "YouTube Music";
                            toast.error(
                                `Couldn't stream "${currentTrack.title}" from ${source} — it may be age-restricted or unavailable.`,
                                { duration: 5000 },
                            );
                        }

                        clearLoadListeners();
                    };

                    loadListenerRef.current = handleLoaded;
                    loadErrorListenerRef.current = handleLoadError;

                    audioEngine.on("load", handleLoaded);
                    audioEngine.on("loaderror", handleLoadError);

                    loadTimeoutRef.current = setTimeout(() => {
                        if (
                            loadIdRef.current !== thisLoadId ||
                            !isLoadingRef.current
                        ) {
                            return;
                        }

                        const retryAttempt =
                            loadTimeoutRetryCountRef.current + 1;
                        if (retryAttempt <= AUDIO_LOAD_TIMEOUT_RETRIES) {
                            loadTimeoutRetryCountRef.current = retryAttempt;
                            sharedFrontendLogger.warn(
                                `[AudioPlaybackOrchestrator] Audio load timed out after ${AUDIO_LOAD_TIMEOUT_MS}ms; retrying (${retryAttempt}/${AUDIO_LOAD_TIMEOUT_RETRIES})`,
                            );
                            clearLoadListeners();
                            if (loadTimeoutRef.current) {
                                clearTimeout(loadTimeoutRef.current);
                                loadTimeoutRef.current = null;
                            }
                            audioEngine.stop();
                            playbackStateMachine.forceTransition("LOADING");
                            setTimeout(() => {
                                if (
                                    loadIdRef.current !== thisLoadId ||
                                    !isLoadingRef.current
                                ) {
                                    return;
                                }
                                startLoadAttempt();
                            }, AUDIO_LOAD_RETRY_DELAY_MS);
                            return;
                        }

                        sharedFrontendLogger.error(
                            `[AudioPlaybackOrchestrator] Audio load timed out after ${AUDIO_LOAD_TIMEOUT_MS}ms`,
                        );
                        loadTimeoutRetryCountRef.current = 0;
                        isLoadingRef.current = false;
                        activeEngineTrackIdRef.current = null;
                        lastTrackIdRef.current = null;
                        playbackStateMachine.forceTransition("ERROR", {
                            error: "Audio stream timed out while loading",
                            errorCode: 408,
                        });
                        setIsPlaying(false);
                        setIsBuffering(false);
                        clearLoadListeners();
                        loadTimeoutRef.current = null;
                    }, AUDIO_LOAD_TIMEOUT_MS);
                };

                startLoadAttempt();
            } else {
                if (loadTimeoutRef.current) {
                    clearTimeout(loadTimeoutRef.current);
                    loadTimeoutRef.current = null;
                }
                loadTimeoutRetryCountRef.current = 0;
                isLoadingRef.current = false;
                activeEngineTrackIdRef.current = null;
            }
            // eslint-disable-next-line react-hooks/exhaustive-deps -- canSeek/isPlaying/setIsPlaying intentionally excluded: adding them would re-trigger audio loading on play/pause or seek state changes, breaking playback
        }, [
            currentTrack,
            currentAudiobook,
            currentPodcast,
            playbackType,
            setDuration,
            setStreamProfile,
            clearPendingTrackErrorSkip,
            clearStartupPlaybackRecovery,
            clearTransientTrackRecovery,
            applyCurrentOutputState,
            markStartupStabilityWindow,
        ]);
        H.useNextTrackPreload({
            playbackType,
            currentTrack,
            currentPodcast,
            isPlaying,
            queue,
            currentIndex,
            isShuffle,
            shuffleIndices,
            repeatMode,
            lastPreloadedTrackIdRef,
            ytMusicAuthenticatedRef,
        });
        H.usePlaybackControlSync({
            refs: orchestratorRefs,
            playbackType,
            currentPodcast,
            currentTrack,
            isPlaying,
            repeatMode,
            volume,
            isMuted,
            setCanSeek,
            setDownloadProgress,
            applyCurrentOutputState,
            scheduleStartupPlaybackRecovery,
            clearStartupPlaybackRecovery,
        });
        H.usePodcastSeeking({
            refs: orchestratorRefs,
            playbackType,
            currentPodcast,
            setCurrentTime,
            setIsBuffering,
            setTargetSeekPosition,
            setIsPlaying,
        });
        H.useProgressPersistence({
            playbackType,
            isPlaying,
            saveAudiobookProgress,
            savePodcastProgress,
            progressSaveIntervalRef,
        });
        H.usePlaybackUnmountCleanup({
            refs: orchestratorRefs,
            clearPendingTrackErrorSkip,
            clearStartupPlaybackRecovery,
            clearTransientTrackRecovery,
        });
        return (
            <PlaybackProgressSnapshot
                snapshotRef={currentTimeSnapshotRef}
                snapshotTrackIdRef={currentTimeSnapshotTrackIdRef}
                currentTrackRef={currentTrackRef}
                playbackType={playbackType}
            />
        );
    },
);
