"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { usePlaybackStatus } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { PlaybackProgressSnapshot } from "@/components/player/PlaybackProgressSnapshot";
import {
    shouldAllowInitialPersistedTrackResume,
    shouldPreemptInFlightAudioLoad,
} from "@/lib/audio-load-preemption";
import { api, type SegmentedStreamingSessionResponse } from "@/lib/api";
import { isSegmentedModeEnabled } from "@/lib/audio-engine/engineMode";
import type {
    AudioEngineErrorPayload,
    AudioEngineManifestStallPayload,
    AudioEngineRepresentationFailoverResult,
    AudioEngineSource,
    AudioEngineVhsResponsePayload,
} from "@/lib/audio-engine/types";
import { resolveNextTrackPreloadDecision } from "@/lib/audio-engine/nextTrackPreloadPolicy";
import { resolveQueueAdvance } from "@/lib/audio/queue-advance-policy";
import {
    resolveSegmentedStartupRetryDelayMs,
    shouldRetrySegmentedStartupTimeout,
} from "@/lib/audio-engine/segmentedPlaybackRegressionPolicy";
import {
    resolveSegmentAssetNameFromUri,
    resolveSegmentRepresentationIdFromName,
} from "@/lib/audio-engine/segmentedRepresentationPolicy";
import {
    getListenTogetherSessionSnapshot,
    isListenTogetherActiveOrPending,
} from "@/lib/listen-together-session";
import { shouldAutoMatchVibeAtQueueEnd } from "./autoMatchVibePlayback";
import {
    createEmptySegmentedStartupRecoveryStageAttempts,
    isAdvancePlayIntentFresh,
    resolveLoadAutoplayDecision,
    resolvePlaybackDuration,
    resolveRemoteStreamFormat,
    resolveSegmentedStartupRecoveryDecision,
    type SegmentedStartupRecoveryStage,
    shouldAttemptSegmentedRecoveryOnUnexpectedPause,
} from "./audioPlaybackOrchestratorPolicy";
import {
    parseSegmentedStartupErrorHint,
    resolveConservativeSegmentedStartupRetryDelayMs,
} from "./segmentedStartupErrorContract";
import { readMigratingStorageItem } from "@/lib/storage-migration";
import { playbackStateMachine } from "@/lib/audio";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, memo } from "react";
import { toast } from "sonner";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import {
    getNextTrackInfo,
    isLikelyTransientStreamError,
    resolveDirectTrackSourceType,
    resolveSegmentedTrackContext,
} from "@/lib/audio-engine/audioPlaybackTrackPolicy";
import {
    buildSegmentedSessionKey,
    clampSegmentedStartupFallbackTimeoutMs,
    getSegmentedSessionRemainingMs,
    isSegmentedSessionUsable,
    resolveSegmentedStartupFallbackTimeoutMs,
} from "@/lib/audio-engine/audioPlaybackRuntimePolicy";
import {
    AUDIO_LOAD_RETRY_DELAY_MS,
    AUDIO_LOAD_TIMEOUT_ASSET_BUILD_INFLIGHT_MS,
    AUDIO_LOAD_TIMEOUT_MS,
    AUDIO_LOAD_TIMEOUT_RETRIES,
    CURRENT_TIME_KEY,
    CURRENT_TIME_TRACK_ID_KEY,
    FORMAT_TO_CODEC,
    SEGMENTED_CHUNK_QUARANTINE_MAX_ENTRIES,
    SEGMENTED_CHUNK_QUARANTINE_RECOVERY_COOLDOWN_MS,
    SEGMENTED_COLD_START_REBUFFER_MAX_POSITION_SEC,
    SEGMENTED_HANDOFF_CIRCUIT_WINDOW_MS,
    SEGMENTED_HEARTBEAT_BUFFER_TIMEOUT_MS,
    SEGMENTED_PAUSE_RECOVERY_DEBOUNCE_MS,
    SEGMENTED_PAUSE_RECOVERY_MAX_BUFFERED_AHEAD_SEC,
    SEGMENTED_PAUSE_RECOVERY_MIN_SILENCE_MS,
    SEGMENTED_REPRESENTATION_QUARANTINE_COOLDOWN_MS,
    SEGMENTED_STARTUP_ASSET_BUILD_TIMEOUT_BONUS_MS,
    SEGMENTED_STARTUP_ASSET_BUILD_TIMEOUT_FLOOR_MS,
    SEGMENTED_STARTUP_AUDIBLE_THRESHOLD_SEC,
    SEGMENTED_STARTUP_MANIFEST_READINESS_MAX_SESSION_RESETS,
    SEGMENTED_STARTUP_MAX_SESSION_RESETS,
    SEGMENTED_STARTUP_ON_DEMAND_TIMEOUT_BONUS_MS,
    SEGMENTED_STARTUP_RECOVERY_WINDOW_MS,
    SEGMENTED_STARTUP_RETRY_BACKOFF_MAX_MS,
    SEGMENTED_STARTUP_RETRY_DELAY_MS,
    SEGMENTED_STARTUP_RETRY_JITTER_RATIO,
    SEGMENTED_STARTUP_STAGE_MAX_ATTEMPTS,
    TRACK_END_WATCHDOG_BOUNDARY_SEC,
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
            segmentedStartupFallbackTimeoutRef,
            loadTimeoutRetryCountRef,
            seekReloadListenerRef,
            seekReloadInProgressRef,
            isSeekingRef,
            loadListenerRef,
            loadErrorListenerRef,
            lastPreloadedTrackIdRef,
            prewarmedSegmentedSessionRef,
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
            activeSegmentedSessionRef,
            activeSegmentedPlaybackTrackIdRef,
            segmentedHandoffInProgressRef,
            segmentedHandoffAttemptRef,
            segmentedHandoffLastAttemptAtRef,
            segmentedSessionCreateFallbackAttemptRef,
            segmentedSessionCreateFallbackLastAttemptAtRef,
            segmentedChunkQuarantineRef,
            segmentedChunkQuarantineLastRecoveryAtRef,
            segmentedLastFailedChunkRef,
            segmentedHandoffLastRecoveryRef,
            segmentedProactiveHandoffAttemptedTrackIdRef,
            segmentedProactiveHandoffAttemptCountRef,
            segmentedProactiveHandoffLastAttemptAtRef,
            segmentedProactiveHandoffCompletedTrackIdRef,
            segmentedProactiveHandoffLastSkipKeyRef,
            startupSegmentedSessionRef,
            startupSegmentedSessionInFlightRef,
            startupSegmentedSessionPromisesRef,
            segmentedStartupRetryCountRef,
            segmentedStartupStageAttemptsRef,
            segmentedStartupRecoveryWindowStartedAtMsRef,
            segmentedStartupSessionResetCountRef,
            segmentedStartupTimelineRef,
            segmentedColdStartRebufferDeferralRef,
            lastHandledTrackEndRef,
            trackEndWatchdogRef,
            howlerLoadStartMsRef,
            heartbeatRef,
        } = orchestratorRefs;
        const segmentedStartupCallbacks = H.useSegmentedStartupCallbacks({
            refs: orchestratorRefs,
        });
        const {
            isListenTogetherSegmentedPlaybackAllowed,
            ensureSegmentedStartupTimeline,
            emitSegmentedStartupTimeline,
            clearSegmentedStartupFallback,
            clearSegmentedManifestNudges,
            applyCurrentOutputState,
            markSegmentedStartupRampWindow,
            noteSegmentedStartupProgress,
            noteSegmentedStartupVhsResponse,
            hasStartupChunkResponseForTrack,
            noteSegmentedStartupAudible,
            clearSegmentedPrewarmRetry,
            abortSegmentedPrewarmValidation,
            abortAllSegmentedPrewarmValidations,
        } = segmentedStartupCallbacks;
        const playbackRecoveryHelpers = H.usePlaybackRecoveryHelpers({
            refs: orchestratorRefs,
        });
        const {
            clearPendingTrackErrorSkip,
            clearUnexpectedPauseRecoveryCheck,
            resetSegmentedHandoffCircuit,
            resolveBufferedAheadSec,
            clearStartupPlaybackRecovery,
            clearTransientTrackRecovery,
            clearSegmentedHandoffLoadListeners,
        } = playbackRecoveryHelpers;
        const { prewarmSegmentedSession, ensureStartupSegmentedSession } =
            H.useSegmentedPrewarm({
                refs: orchestratorRefs,
                abortSegmentedPrewarmValidation,
                clearSegmentedPrewarmRetry,
            });
        const {
            scheduleStartupPlaybackRecovery,
            handleStartupManifestStall,
            requestListenTogetherFollowerRecovery,
            scheduleTrackErrorSkip,
            attemptTransientTrackRecovery,
        } = H.useTrackRecovery({
            refs: orchestratorRefs,
            playbackRecoveryHelpers,
            segmentedStartupCallbacks,
            next,
            setCurrentTime,
            setIsBuffering,
        });
        const { attemptSegmentedSessionCreateRecovery } =
            H.useSegmentedSessionRecovery({
                refs: orchestratorRefs,
                playbackRecoveryHelpers,
                segmentedStartupCallbacks,
                setCurrentTime,
                setIsBuffering,
                setIsPlaying,
                setStreamProfile,
            });
        const { attemptSegmentedHandoffRecovery } =
            H.useSegmentedHandoffRecovery({
                refs: orchestratorRefs,
                playbackRecoveryHelpers,
                segmentedStartupCallbacks,
                trackRecovery: {
                    scheduleStartupPlaybackRecovery,
                    handleStartupManifestStall,
                    requestListenTogetherFollowerRecovery,
                    scheduleTrackErrorSkip,
                    attemptTransientTrackRecovery,
                },
                segmentedSessionRecovery: {
                    attemptSegmentedSessionCreateRecovery,
                },
                isPlaying,
                setCurrentTime,
                setIsBuffering,
                setIsPlaying,
                setStreamProfile,
            });
        H.useYtMusicAuth(ytMusicAuthenticatedRef);
        const requestAutoMatchVibe = H.useAutoMatchVibe({
            refs: orchestratorRefs,
            startVibeMode,
        });
        H.usePlaybackStateSync({
            refs: orchestratorRefs,
            playbackRecoveryHelpers,
            segmentedStartupCallbacks,
            currentTrack,
            playbackType,
            queueLength: queue.length,
            isPlaying,
            isBuffering,
            setStreamProfile,
        });
        H.useSegmentedHeartbeat({
            refs: orchestratorRefs,
            playbackType,
            currentTrack,
            ensureStartupSegmentedSession,
            attemptSegmentedHandoffRecovery,
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
                handleStartupManifestStall,
                requestListenTogetherFollowerRecovery,
                scheduleTrackErrorSkip,
                attemptTransientTrackRecovery,
            },
            attemptSegmentedHandoffRecovery,
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
                        currentTimeValue >=
                            SEGMENTED_STARTUP_AUDIBLE_THRESHOLD_SEC
                    ) {
                        clearSegmentedStartupFallback();
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
                                sourceType:
                                    activeSegmentedSessionRef.current
                                        ?.sourceType ??
                                    (currentTrackRef.current
                                        ? resolveDirectTrackSourceType(
                                              currentTrackRef.current,
                                          )
                                        : "unknown"),
                                reason: "progress_before_load_event",
                            },
                        );
                    }

                    lastTrackTimeUpdateAtMsRef.current = Date.now();
                    if (audioEngine.isPlaying()) {
                        clearUnexpectedPauseRecoveryCheck();
                    }
                    noteSegmentedStartupProgress(liveTrackId, currentTimeValue);
                    noteSegmentedStartupAudible(liveTrackId, currentTimeValue);

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

                const activeSession = activeSegmentedSessionRef.current;
                if (
                    activeSession?.assetBuildInFlight &&
                    currentTrackRef.current?.id === activeSession.trackId &&
                    currentTimeValue >
                        SEGMENTED_COLD_START_REBUFFER_MAX_POSITION_SEC
                ) {
                    activeSegmentedSessionRef.current = {
                        ...activeSession,
                        assetBuildInFlight: false,
                    };
                    segmentedColdStartRebufferDeferralRef.current = {
                        trackId: activeSession.trackId,
                        count: 0,
                    };
                    heartbeatRef.current?.updateConfig({
                        bufferTimeout: SEGMENTED_HEARTBEAT_BUFFER_TIMEOUT_MS,
                    });
                }
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
                clearTransientTrackRecovery(true);

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

                if (
                    howlerLoadStartMsRef.current > 0 &&
                    !activeSegmentedSessionRef.current
                ) {
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
                const initialActiveSession = activeSegmentedSessionRef.current;
                const initialSourceType =
                    initialActiveSession?.sourceType ??
                    (currentTrack
                        ? resolveDirectTrackSourceType(currentTrack)
                        : "unknown");
                const latestFailedChunk = segmentedLastFailedChunkRef.current;
                const failingChunkName =
                    playbackType === "track" &&
                    latestFailedChunk.trackId === currentTrack?.id
                        ? latestFailedChunk.chunkName
                        : null;

                if (playbackType === "track") {
                    if (segmentedHandoffInProgressRef.current) {
                        logPlaybackClientMetric("player.playback_error", {
                            trackId: currentTrack?.id ?? null,
                            sessionId: initialActiveSession?.sessionId ?? null,
                            sourceType: initialSourceType,
                            streamingMode: activeSegmentedSessionRef.current
                                ? "segmented"
                                : "direct",
                            error: errorMessage,
                            stage: "suppressed_handoff_in_progress",
                            chunkName: failingChunkName,
                        });
                        playbackStateMachine.forceTransition("LOADING");
                        setIsBuffering(true);
                        return;
                    }

                    logPlaybackClientMetric("player.playback_error", {
                        trackId: currentTrack?.id ?? null,
                        sessionId: initialActiveSession?.sessionId ?? null,
                        sourceType: initialSourceType,
                        streamingMode: activeSegmentedSessionRef.current
                            ? "segmented"
                            : "direct",
                        error: errorMessage,
                        stage: "pre_recovery",
                        chunkName: failingChunkName,
                    });
                    if (
                        currentTrack?.id &&
                        initialActiveSession?.trackId === currentTrack.id &&
                        !hasStartupChunkResponseForTrack(currentTrack.id)
                    ) {
                        handleStartupManifestStall({
                            trackId: currentTrack.id,
                            sessionId: initialActiveSession.sessionId,
                            reason: "load_error_before_first_chunk",
                        });
                        playbackStateMachine.forceTransition("LOADING");
                        setIsBuffering(true);
                        return;
                    }
                    const didRecoverWithHandoff =
                        await attemptSegmentedHandoffRecovery(data.error);
                    if (didRecoverWithHandoff) {
                        return;
                    }

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
                            sessionId:
                                activeSegmentedSessionRef.current?.sessionId ??
                                null,
                            sourceType:
                                activeSegmentedSessionRef.current?.sourceType ??
                                (currentTrack
                                    ? resolveDirectTrackSourceType(currentTrack)
                                    : "unknown"),
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
                    sessionId:
                        activeSegmentedSessionRef.current?.sessionId ?? null,
                    sourceType:
                        activeSegmentedSessionRef.current?.sourceType ??
                        (currentTrack
                            ? resolveDirectTrackSourceType(currentTrack)
                            : "unknown"),
                    streamingMode: activeSegmentedSessionRef.current
                        ? "segmented"
                        : "direct",
                    error: errorMessage,
                    stage:
                        playbackType === "track"
                            ? "fatal_after_recovery"
                            : "fatal",
                    chunkName: failingChunkName,
                });
                emitSegmentedStartupTimeline("playback_error", {
                    error: errorMessage,
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

            const handleVhsResponse = (data: AudioEngineVhsResponsePayload) => {
                noteSegmentedStartupVhsResponse(data);

                if (data.kind !== "segment") {
                    return;
                }

                const chunkName = resolveSegmentAssetNameFromUri(data.uri);
                if (!chunkName || !chunkName.startsWith("chunk-")) {
                    return;
                }

                const liveTrackId =
                    data.trackId ?? currentTrackRef.current?.id ?? null;
                const liveSessionId =
                    data.sessionId ??
                    activeSegmentedSessionRef.current?.sessionId ??
                    null;
                const statusCode = data.statusCode;
                const hasSegmentFetchError =
                    data.hasError ||
                    (typeof statusCode === "number" && statusCode >= 400);
                const quarantineKey = `${liveTrackId ?? "unknown"}:${liveSessionId ?? "unknown"}:${chunkName}`;

                if (!hasSegmentFetchError) {
                    segmentedChunkQuarantineRef.current.delete(quarantineKey);
                    return;
                }

                if (segmentedChunkQuarantineRef.current.has(quarantineKey)) {
                    return;
                }

                segmentedChunkQuarantineRef.current.set(
                    quarantineKey,
                    Date.now(),
                );
                if (
                    segmentedChunkQuarantineRef.current.size >
                    SEGMENTED_CHUNK_QUARANTINE_MAX_ENTRIES
                ) {
                    const oldestKey = segmentedChunkQuarantineRef.current
                        .keys()
                        .next().value;
                    if (typeof oldestKey === "string") {
                        segmentedChunkQuarantineRef.current.delete(oldestKey);
                    }
                }

                segmentedLastFailedChunkRef.current = {
                    trackId: liveTrackId,
                    sessionId: liveSessionId,
                    chunkName,
                    statusCode,
                    observedAtMs: Date.now(),
                };

                const representationId =
                    data.representationId ??
                    resolveSegmentRepresentationIdFromName(chunkName);
                let representationFailoverResult: AudioEngineRepresentationFailoverResult | null =
                    null;
                const isCurrentLiveTrackPlayback =
                    playbackTypeRef.current === "track" &&
                    !!liveTrackId &&
                    currentTrackRef.current?.id === liveTrackId &&
                    !segmentedHandoffInProgressRef.current;
                const canAttemptRepresentationFailover =
                    isCurrentLiveTrackPlayback &&
                    typeof representationId === "string" &&
                    typeof audioEngine.quarantineRepresentation === "function";

                if (canAttemptRepresentationFailover) {
                    representationFailoverResult =
                        audioEngine.quarantineRepresentation(
                            representationId,
                            SEGMENTED_REPRESENTATION_QUARANTINE_COOLDOWN_MS,
                        ) ?? null;
                }

                logPlaybackClientMetric("player.segment_quarantined", {
                    trackId: liveTrackId,
                    sessionId: liveSessionId,
                    sourceType:
                        activeSegmentedSessionRef.current?.sourceType ??
                        (currentTrackRef.current
                            ? resolveDirectTrackSourceType(
                                  currentTrackRef.current,
                              )
                            : "unknown"),
                    chunkName,
                    statusCode,
                    hasError: data.hasError,
                    uri: data.uri,
                    representationId: representationId ?? null,
                    representationFailoverAttempted:
                        canAttemptRepresentationFailover,
                    representationFailoverSwitched:
                        representationFailoverResult?.didSwitchRepresentation ??
                        null,
                    representationEnabledCount:
                        representationFailoverResult?.enabledRepresentationCount ??
                        null,
                    representationTotalCount:
                        representationFailoverResult?.totalRepresentationCount ??
                        null,
                    representationAllUnhealthy:
                        representationFailoverResult?.allRepresentationsUnhealthy ??
                        null,
                });

                if (playbackTypeRef.current !== "track") {
                    return;
                }

                if (
                    !liveTrackId ||
                    currentTrackRef.current?.id !== liveTrackId
                ) {
                    return;
                }
                if (segmentedHandoffInProgressRef.current) {
                    return;
                }
                if (
                    representationFailoverResult &&
                    !representationFailoverResult.allRepresentationsUnhealthy
                ) {
                    return;
                }

                const nowMs = Date.now();
                const isSegmentMissing404 = statusCode === 404;
                const activeSessionId =
                    activeSegmentedSessionRef.current?.sessionId ?? null;
                const activeSessionAssetBuildInFlight =
                    activeSegmentedSessionRef.current?.assetBuildInFlight ===
                    true;
                const isCurrentActiveSession =
                    !!liveSessionId &&
                    !!activeSessionId &&
                    liveSessionId === activeSessionId;
                const wasRecentHandoffAttempt =
                    segmentedHandoffLastAttemptAtRef.current > 0 &&
                    nowMs - segmentedHandoffLastAttemptAtRef.current <=
                        SEGMENTED_HANDOFF_CIRCUIT_WINDOW_MS;
                const shouldForceSessionCreateRecovery =
                    isSegmentMissing404 &&
                    isCurrentActiveSession &&
                    wasRecentHandoffAttempt &&
                    !activeSessionAssetBuildInFlight;

                if (
                    !shouldForceSessionCreateRecovery &&
                    nowMs - segmentedChunkQuarantineLastRecoveryAtRef.current <
                        SEGMENTED_CHUNK_QUARANTINE_RECOVERY_COOLDOWN_MS
                ) {
                    return;
                }
                segmentedChunkQuarantineLastRecoveryAtRef.current = nowMs;

                const quarantineError = new Error(
                    `Segment quarantined before hard-stop (${chunkName}, status=${statusCode ?? "unknown"})`,
                );
                void attemptSegmentedHandoffRecovery(quarantineError, {
                    forceSessionCreate: shouldForceSessionCreateRecovery,
                    forceSessionCreateReason: shouldForceSessionCreateRecovery
                        ? "segment_missing_404"
                        : undefined,
                }).then((didRecoverWithHandoff) => {
                    if (didRecoverWithHandoff) {
                        clearPendingTrackErrorSkip();
                    }
                });
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
                if (segmentedHandoffInProgressRef.current) {
                    // Pause can occur transiently while reloading source during handoff.
                    isUserInitiatedRef.current = false;
                    return;
                }
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
                            segmentedHandoffInProgressRef.current ||
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
                            SEGMENTED_PAUSE_RECOVERY_MIN_SILENCE_MS
                        ) {
                            const remainingSilenceMs =
                                SEGMENTED_PAUSE_RECOVERY_MIN_SILENCE_MS -
                                silenceSinceTimeUpdateMs;
                            unexpectedPauseRecoveryTimeoutRef.current =
                                setTimeout(
                                    runUnexpectedPauseRecoveryCheck,
                                    Math.min(
                                        SEGMENTED_PAUSE_RECOVERY_DEBOUNCE_MS,
                                        Math.max(remainingSilenceMs, 50),
                                    ),
                                );
                            return;
                        }

                        const bufferedAheadSec = resolveBufferedAheadSec();
                        const hasBufferedAheadMeasurement =
                            Number.isFinite(bufferedAheadSec);
                        const hasLowBufferedAhead =
                            shouldAttemptSegmentedRecoveryOnUnexpectedPause(
                                bufferedAheadSec,
                                SEGMENTED_PAUSE_RECOVERY_MAX_BUFFERED_AHEAD_SEC,
                            );

                        if (!hasBufferedAheadMeasurement) {
                            logPlaybackClientMetric("player.unexpected_pause", {
                                reason: "pause_without_buffered_ahead_measurement",
                                trackId: liveTrackId,
                                sessionId:
                                    activeSegmentedSessionRef.current
                                        ?.sessionId ?? null,
                                sourceType:
                                    activeSegmentedSessionRef.current
                                        ?.sourceType ??
                                    (currentTrackRef.current
                                        ? resolveDirectTrackSourceType(
                                              currentTrackRef.current,
                                          )
                                        : "unknown"),
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
                                sessionId:
                                    activeSegmentedSessionRef.current
                                        ?.sessionId ?? null,
                                sourceType:
                                    activeSegmentedSessionRef.current
                                        ?.sourceType ??
                                    (currentTrackRef.current
                                        ? resolveDirectTrackSourceType(
                                              currentTrackRef.current,
                                          )
                                        : "unknown"),
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
                            sessionId:
                                activeSegmentedSessionRef.current?.sessionId ??
                                null,
                            sourceType:
                                activeSegmentedSessionRef.current?.sourceType ??
                                (currentTrackRef.current
                                    ? resolveDirectTrackSourceType(
                                          currentTrackRef.current,
                                      )
                                    : "unknown"),
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
                        void attemptSegmentedHandoffRecovery(pauseError).then(
                            (didRecoverWithHandoff) => {
                                if (didRecoverWithHandoff) {
                                    return;
                                }

                                const didScheduleTransientRecovery =
                                    attemptTransientTrackRecovery(
                                        liveTrackId,
                                        pauseError,
                                    );
                                if (didScheduleTransientRecovery) {
                                    playbackStateMachine.forceTransition(
                                        "LOADING",
                                    );
                                    setIsBuffering(true);
                                    return;
                                }

                                setIsPlaying(false);
                                setIsBuffering(false);
                                playbackStateMachine.forceTransition("READY");
                            },
                        );
                    };

                    unexpectedPauseRecoveryTimeoutRef.current = setTimeout(
                        runUnexpectedPauseRecoveryCheck,
                        SEGMENTED_PAUSE_RECOVERY_DEBOUNCE_MS,
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
                        sessionId:
                            activeSegmentedSessionRef.current?.sessionId ??
                            null,
                        sourceType:
                            activeSegmentedSessionRef.current?.sourceType ??
                            (currentTrack
                                ? resolveDirectTrackSourceType(currentTrack)
                                : "unknown"),
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
            const handleManifestStall = (
                payload: AudioEngineManifestStallPayload,
            ) => {
                handleStartupManifestStall(payload);
            };
            engineEventHandlersRef.current = {
                handleTimeUpdate,
                handleLoad,
                handleEnd,
                handleError,
                handlePlay,
                handlePause,
                handleVhsResponse,
                handleManifestStall,
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
                markSegmentedStartupRampWindow(null, "media_cleared");
                setStreamProfile(null);
                segmentedStartupTimelineRef.current = null;
                clearPendingTrackErrorSkip();
                clearStartupPlaybackRecovery();
                clearTransientTrackRecovery(true);
                clearSegmentedStartupFallback();
                if (loadTimeoutRef.current) {
                    clearTimeout(loadTimeoutRef.current);
                    loadTimeoutRef.current = null;
                }
                loadTimeoutRetryCountRef.current = 0;
                activeEngineTrackIdRef.current = null;
                activeSegmentedPlaybackTrackIdRef.current = null;
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
                segmentedStartupTimelineRef.current = null;
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
                activeSegmentedPlaybackTrackIdRef.current = null;
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
                clearSegmentedStartupFallback();
                clearSegmentedManifestNudges();
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
                activeSegmentedPlaybackTrackIdRef.current = null;
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
            segmentedStartupRetryCountRef.current = 0;
            segmentedStartupStageAttemptsRef.current =
                createEmptySegmentedStartupRecoveryStageAttempts();
            segmentedStartupRecoveryWindowStartedAtMsRef.current = Date.now();
            segmentedStartupSessionResetCountRef.current = 0;
            if (playbackType === "track" && currentTrack) {
                markSegmentedStartupRampWindow(
                    currentTrack.id,
                    "track_load_started",
                );
            } else {
                markSegmentedStartupRampWindow(null, "non_track_load_started");
            }

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
                const segmentedStartupEligible =
                    isSegmentedModeEnabled() &&
                    isListenTogetherSegmentedPlaybackAllowed() &&
                    Boolean(resolveSegmentedTrackContext(currentTrack));
                const listenTogetherActiveOrPending =
                    isListenTogetherActiveOrPending();
                // Only restore persisted position on initial player boot when not
                // using segmented startup or active/pending Listen Together playback.
                // Segmented startup must begin at 0 unless a handoff recovery path
                // provides an explicit resume target.
                const allowPersistedResume =
                    shouldAllowInitialPersistedTrackResume({
                        isInitialTrackLoad,
                        segmentedStartupEligible,
                        listenTogetherActiveOrPending,
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

                let sourceForLoad: string | AudioEngineSource = streamUrl;
                let sourceRequestHeaders: Record<string, string> | undefined;
                let sourceResolved = false;
                let usingSegmentedSource = false;
                let segmentedAssetBuildInFlight = false;
                let segmentedInitSource:
                    | "prewarm"
                    | "startup"
                    | "on_demand"
                    | null = null;
                let forceFreshSegmentedSession = false;
                let capturedLoadPlayIntent: DesiredLoadPlayIntent | null = null;

                const resolveSourceForLoad = async (): Promise<void> => {
                    if (sourceResolved) {
                        return;
                    }
                    sourceResolved = true;

                    const segmentedTrackContext =
                        playbackType === "track"
                            ? resolveSegmentedTrackContext(currentTrack)
                            : null;

                    const shouldAttemptSegmentedSession =
                        playbackType === "track" &&
                        Boolean(currentTrack) &&
                        Boolean(segmentedTrackContext) &&
                        isListenTogetherSegmentedPlaybackAllowed() &&
                        isSegmentedModeEnabled();

                    if (
                        !shouldAttemptSegmentedSession ||
                        !currentTrack ||
                        !segmentedTrackContext
                    ) {
                        segmentedStartupTimelineRef.current = null;
                        activeSegmentedSessionRef.current = null;
                        segmentedHandoffAttemptRef.current = 0;
                        segmentedHandoffLastAttemptAtRef.current = 0;
                        segmentedSessionCreateFallbackAttemptRef.current = 0;
                        segmentedSessionCreateFallbackLastAttemptAtRef.current = 0;
                        segmentedChunkQuarantineRef.current.clear();
                        segmentedChunkQuarantineLastRecoveryAtRef.current = 0;
                        segmentedLastFailedChunkRef.current = {
                            trackId: null,
                            sessionId: null,
                            chunkName: null,
                            statusCode: null,
                            observedAtMs: 0,
                        };
                        resetSegmentedHandoffCircuit(null);
                        segmentedHandoffLastRecoveryRef.current = {
                            trackId: null,
                            resumeAtSec: 0,
                            recoveredAtMs: 0,
                        };
                        segmentedProactiveHandoffAttemptedTrackIdRef.current =
                            null;
                        segmentedProactiveHandoffAttemptCountRef.current = 0;
                        segmentedProactiveHandoffLastAttemptAtRef.current = 0;
                        segmentedProactiveHandoffCompletedTrackIdRef.current =
                            null;
                        segmentedProactiveHandoffLastSkipKeyRef.current = null;
                        startupSegmentedSessionRef.current = null;
                        return;
                    }

                    const segmentedInitStartedAtMs = Date.now();
                    const startupTimeline = ensureSegmentedStartupTimeline(
                        currentTrack.id,
                        thisLoadId,
                        segmentedInitStartedAtMs,
                    );
                    const startupCorrelationMetadata = {
                        startupLoadId: thisLoadId,
                        startupCorrelationId:
                            startupTimeline.startupCorrelationId,
                    };
                    const segmentedSessionKey = buildSegmentedSessionKey(
                        segmentedTrackContext,
                    );
                    if (forceFreshSegmentedSession) {
                        prewarmedSegmentedSessionRef.current.delete(
                            segmentedSessionKey,
                        );
                        startupSegmentedSessionRef.current = null;
                        startupSegmentedSessionInFlightRef.current.delete(
                            segmentedSessionKey,
                        );
                        startupSegmentedSessionPromisesRef.current.delete(
                            segmentedSessionKey,
                        );
                    }
                    const prewarmedSessionCandidate = forceFreshSegmentedSession
                        ? null
                        : prewarmedSegmentedSessionRef.current.get(
                              segmentedSessionKey,
                          );
                    const prewarmedSession =
                        prewarmedSessionCandidate &&
                        isSegmentedSessionUsable(prewarmedSessionCandidate)
                            ? prewarmedSessionCandidate
                            : null;
                    if (prewarmedSessionCandidate && !prewarmedSession) {
                        logPlaybackClientMetric("session.prewarm_discarded", {
                            trackId: currentTrack.id,
                            sourceType: segmentedTrackContext.sourceType,
                            reason: "insufficient_ttl",
                            remainingMs: getSegmentedSessionRemainingMs(
                                prewarmedSessionCandidate,
                            ),
                        });
                        prewarmedSegmentedSessionRef.current.delete(
                            segmentedSessionKey,
                        );
                    }

                    const startupSessionSnapshot =
                        startupSegmentedSessionRef.current;
                    const startupSession =
                        !forceFreshSegmentedSession &&
                        startupSessionSnapshot &&
                        startupSessionSnapshot.trackId === currentTrack.id &&
                        startupSessionSnapshot.sourceType ===
                            segmentedTrackContext.sourceType &&
                        isSegmentedSessionUsable(startupSessionSnapshot.session)
                            ? startupSessionSnapshot.session
                            : null;
                    if (
                        startupSessionSnapshot &&
                        startupSessionSnapshot.trackId === currentTrack.id &&
                        !startupSession
                    ) {
                        logPlaybackClientMetric("session.startup_discarded", {
                            trackId: currentTrack.id,
                            sourceType: segmentedTrackContext.sourceType,
                            reason: "insufficient_ttl",
                            remainingMs: getSegmentedSessionRemainingMs(
                                startupSessionSnapshot.session,
                            ),
                        });
                        startupSegmentedSessionRef.current = null;
                    }

                    let initSource: "prewarm" | "startup" | "on_demand" =
                        "on_demand";
                    let segmentedSession: SegmentedStreamingSessionResponse | null =
                        prewarmedSession;
                    if (segmentedSession) {
                        initSource = "prewarm";
                        prewarmedSegmentedSessionRef.current.delete(
                            segmentedSessionKey,
                        );
                    } else if (startupSession) {
                        segmentedSession = startupSession;
                        initSource = "startup";
                    } else {
                        const startupSessionFromRequest =
                            await ensureStartupSegmentedSession(
                                currentTrack.id,
                                segmentedTrackContext,
                                "load_segmented_startup",
                                startupCorrelationMetadata,
                            );
                        if (
                            startupSessionFromRequest &&
                            isSegmentedSessionUsable(startupSessionFromRequest)
                        ) {
                            segmentedSession = startupSessionFromRequest;
                            initSource = "startup";
                        } else {
                            startupTimeline.createRequestedAtMs ??= Date.now();
                            logPlaybackClientMetric("session.create_request", {
                                trackId: currentTrack.id,
                                sourceType: segmentedTrackContext.sourceType,
                                initSource: "on_demand",
                            });

                            const createdSession =
                                await api.createSegmentedStreamingSession({
                                    trackId:
                                        segmentedTrackContext.sessionTrackId,
                                    sourceType:
                                        segmentedTrackContext.sourceType,
                                    startupLoadId:
                                        startupCorrelationMetadata.startupLoadId,
                                    startupCorrelationId:
                                        startupCorrelationMetadata.startupCorrelationId,
                                    manifestProfile: "steady_state_dual",
                                });
                            startupTimeline.createResolvedAtMs = Date.now();
                            if (!isSegmentedSessionUsable(createdSession)) {
                                logPlaybackClientMetric(
                                    "session.create_failure",
                                    {
                                        trackId: currentTrack.id,
                                        sourceType:
                                            segmentedTrackContext.sourceType,
                                        reason: "created_session_not_usable",
                                    },
                                );
                                throw new Error(
                                    "Segmented startup session is not usable for playback",
                                );
                            }
                            segmentedSession = createdSession;
                        }
                        startupSegmentedSessionRef.current = {
                            trackId: currentTrack.id,
                            sourceType: segmentedTrackContext.sourceType,
                            session: segmentedSession,
                        };
                    }

                    if (!segmentedSession) {
                        throw new Error(
                            "Segmented startup session unavailable",
                        );
                    }

                    segmentedAssetBuildInFlight =
                        segmentedSession.engineHints?.assetBuildInFlight ===
                        true;

                    if (segmentedAssetBuildInFlight) {
                        logPlaybackClientMetric(
                            "session.create_asset_build_inflight_hint",
                            {
                                trackId: currentTrack.id,
                                sourceType:
                                    segmentedSession.playbackProfile
                                        ?.sourceType ??
                                    segmentedSession.engineHints?.sourceType ??
                                    segmentedTrackContext.sourceType,
                                sessionId: segmentedSession.sessionId,
                            },
                        );
                    }

                    if (
                        loadIdRef.current !== thisLoadId ||
                        !isLoadingRef.current
                    ) {
                        return;
                    }

                    sourceForLoad = {
                        url: segmentedSession.manifestUrl,
                        trackId: currentTrack.id,
                        sessionId: segmentedSession.sessionId,
                        sourceType:
                            segmentedSession.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        protocol: "dash",
                        mimeType: "application/dash+xml",
                    };
                    usingSegmentedSource = true;
                    segmentedInitSource = initSource;
                    format = "mp4";
                    startupTimeline.sessionId = segmentedSession.sessionId;
                    startupTimeline.sourceType =
                        segmentedSession.engineHints?.sourceType ??
                        segmentedSession.playbackProfile?.sourceType ??
                        segmentedTrackContext.sourceType;
                    startupTimeline.initSource = initSource;

                    sourceRequestHeaders = {
                        "x-streaming-session-token":
                            segmentedSession.sessionToken,
                    };
                    const authToken = api.getStreamingAuthToken();
                    if (authToken) {
                        sourceRequestHeaders.Authorization = `Bearer ${authToken}`;
                    }

                    activeSegmentedSessionRef.current = {
                        sessionId: segmentedSession.sessionId,
                        sessionToken: segmentedSession.sessionToken,
                        trackId: currentTrack.id,
                        sourceType:
                            segmentedSession.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        manifestUrl: segmentedSession.manifestUrl,
                        expiresAt: segmentedSession.expiresAt,
                        assetBuildInFlight:
                            segmentedSession.engineHints?.assetBuildInFlight ===
                            true,
                        manifestProfile:
                            segmentedSession.playbackProfile?.manifestProfile ??
                            null,
                    };
                    segmentedChunkQuarantineRef.current.clear();
                    segmentedChunkQuarantineLastRecoveryAtRef.current = 0;
                    segmentedLastFailedChunkRef.current = {
                        trackId: currentTrack.id,
                        sessionId: segmentedSession.sessionId,
                        chunkName: null,
                        statusCode: null,
                        observedAtMs: Date.now(),
                    };
                    segmentedColdStartRebufferDeferralRef.current = {
                        trackId: currentTrack.id,
                        count: 0,
                    };
                    startupSegmentedSessionRef.current = {
                        trackId: currentTrack.id,
                        sourceType:
                            segmentedSession.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        session: segmentedSession,
                    };
                    forceFreshSegmentedSession = false;
                    setStreamProfile({
                        mode: "dash",
                        sourceType:
                            segmentedSession.playbackProfile?.sourceType ??
                            segmentedSession.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        codec:
                            segmentedSession.playbackProfile?.codec?.toUpperCase() ??
                            "AAC",
                        bitrateKbps:
                            segmentedSession.playbackProfile?.bitrateKbps ??
                            null,
                    });
                    logPlaybackClientMetric("session.create_success", {
                        trackId: currentTrack.id,
                        sourceType:
                            segmentedSession.playbackProfile?.sourceType ??
                            segmentedSession.engineHints?.sourceType ??
                            segmentedTrackContext.sourceType,
                        sessionId: segmentedSession.sessionId,
                        initSource,
                        latencyMs: Math.max(
                            0,
                            Date.now() - segmentedInitStartedAtMs,
                        ),
                    });
                    segmentedHandoffAttemptRef.current = 0;
                    segmentedHandoffLastAttemptAtRef.current = 0;
                    segmentedSessionCreateFallbackAttemptRef.current = 0;
                    segmentedSessionCreateFallbackLastAttemptAtRef.current = 0;
                    segmentedChunkQuarantineRef.current.clear();
                    segmentedChunkQuarantineLastRecoveryAtRef.current = 0;
                    segmentedLastFailedChunkRef.current = {
                        trackId: currentTrack.id,
                        sessionId: segmentedSession.sessionId,
                        chunkName: null,
                        statusCode: null,
                        observedAtMs: Date.now(),
                    };
                    resetSegmentedHandoffCircuit(currentTrack.id);
                    segmentedHandoffLastRecoveryRef.current = {
                        trackId: currentTrack.id,
                        resumeAtSec: 0,
                        recoveredAtMs: Date.now(),
                    };
                    segmentedProactiveHandoffAttemptCountRef.current = 0;
                    segmentedProactiveHandoffCompletedTrackIdRef.current =
                        currentTrack.id;
                    segmentedProactiveHandoffLastSkipKeyRef.current = null;
                };

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
                const startLoadAttempt = async (
                    options: {
                        retryReason?:
                            | "segmented_session_create_error"
                            | "segmented_load_error"
                            | "segmented_startup_timeout";
                    } = {},
                ) => {
                    clearLoadListeners();
                    clearSegmentedStartupFallback();
                    clearSegmentedManifestNudges();
                    const startupAttemptStartedAtMs = Date.now();

                    if (loadTimeoutRef.current) {
                        clearTimeout(loadTimeoutRef.current);
                        loadTimeoutRef.current = null;
                    }

                    const scheduleSegmentedStartupRetry = (
                        stage: SegmentedStartupRecoveryStage,
                        reason:
                            | "segmented_session_create_error"
                            | "segmented_load_error"
                            | "segmented_startup_timeout",
                        retryDetails: {
                            isTransient: boolean;
                            errorMessage: string;
                            retryAfterMsHint?: number | null;
                        },
                    ): boolean => {
                        if (playbackType !== "track" || !currentTrack) {
                            return false;
                        }

                        if (
                            stage !== "session_create" &&
                            !usingSegmentedSource
                        ) {
                            return false;
                        }

                        if (!retryDetails.isTransient) {
                            return false;
                        }

                        const nowMs = Date.now();
                        if (
                            segmentedStartupRecoveryWindowStartedAtMsRef.current ===
                            null
                        ) {
                            segmentedStartupRecoveryWindowStartedAtMsRef.current =
                                nowMs;
                        }
                        const windowStartedAtMs =
                            segmentedStartupRecoveryWindowStartedAtMsRef.current;
                        const windowElapsedMs =
                            windowStartedAtMs === null
                                ? 0
                                : Math.max(0, nowMs - windowStartedAtMs);
                        const maxSessionResetsForStage =
                            stage === "manifest_readiness"
                                ? SEGMENTED_STARTUP_MANIFEST_READINESS_MAX_SESSION_RESETS
                                : SEGMENTED_STARTUP_MAX_SESSION_RESETS;

                        const decision =
                            resolveSegmentedStartupRecoveryDecision({
                                stage,
                                stageAttempts:
                                    segmentedStartupStageAttemptsRef.current,
                                stageLimits:
                                    SEGMENTED_STARTUP_STAGE_MAX_ATTEMPTS,
                                recoveryWindowStartedAtMs:
                                    segmentedStartupRecoveryWindowStartedAtMsRef.current,
                                recoveryWindowMaxMs:
                                    SEGMENTED_STARTUP_RECOVERY_WINDOW_MS,
                                sessionResetsUsed:
                                    segmentedStartupSessionResetCountRef.current,
                                maxSessionResets: maxSessionResetsForStage,
                                baseDelayMs: SEGMENTED_STARTUP_RETRY_DELAY_MS,
                                maxDelayMs:
                                    SEGMENTED_STARTUP_RETRY_BACKOFF_MAX_MS,
                                jitterRatio:
                                    SEGMENTED_STARTUP_RETRY_JITTER_RATIO,
                                nowMs,
                            });

                        segmentedStartupStageAttemptsRef.current =
                            decision.nextStageAttempts;
                        segmentedStartupSessionResetCountRef.current =
                            decision.nextSessionResetsUsed;

                        if (
                            decision.action === "exhausted_stage" ||
                            decision.action === "exhausted_window"
                        ) {
                            logPlaybackClientMetric(
                                "session.startup_retry_exhausted",
                                {
                                    trackId: currentTrack.id,
                                    sourceType:
                                        resolveDirectTrackSourceType(
                                            currentTrack,
                                        ),
                                    stage,
                                    reason,
                                    action: decision.action,
                                    errorMessage: retryDetails.errorMessage,
                                    attempts:
                                        segmentedStartupRetryCountRef.current,
                                    stageAttempts:
                                        segmentedStartupStageAttemptsRef
                                            .current[stage],
                                    windowElapsedMs,
                                    windowMaxMs:
                                        SEGMENTED_STARTUP_RECOVERY_WINDOW_MS,
                                    sessionResetsUsed:
                                        segmentedStartupSessionResetCountRef.current,
                                    maxSessionResets: maxSessionResetsForStage,
                                },
                            );
                            return false;
                        }

                        if (decision.action === "reset_session_and_retry") {
                            startupSegmentedSessionRef.current = null;
                            activeSegmentedSessionRef.current = null;
                            logPlaybackClientMetric(
                                "session.startup_stage_reset",
                                {
                                    trackId: currentTrack.id,
                                    sourceType:
                                        resolveDirectTrackSourceType(
                                            currentTrack,
                                        ),
                                    stage,
                                    reason,
                                    errorMessage: retryDetails.errorMessage,
                                    sessionResetsUsed:
                                        segmentedStartupSessionResetCountRef.current,
                                },
                            );
                        }

                        segmentedStartupRetryCountRef.current += 1;
                        const attempt = segmentedStartupRetryCountRef.current;
                        const startupTimeline =
                            segmentedStartupTimelineRef.current;
                        if (
                            startupTimeline &&
                            startupTimeline.trackId === currentTrack.id &&
                            startupTimeline.loadId === thisLoadId
                        ) {
                            startupTimeline.startupRetryCount = attempt;
                        }

                        const baseRetryDelayMs =
                            typeof decision.delayMs === "number"
                                ? decision.delayMs
                                : SEGMENTED_STARTUP_RETRY_DELAY_MS;
                        const retryDelayMs =
                            resolveConservativeSegmentedStartupRetryDelayMs({
                                computedDelayMs: baseRetryDelayMs,
                                retryAfterMsHint: retryDetails.retryAfterMsHint,
                                maxDelayMs:
                                    SEGMENTED_STARTUP_RECOVERY_WINDOW_MS,
                            });
                        logPlaybackClientMetric("session.startup_retry", {
                            trackId: currentTrack.id,
                            sourceType:
                                activeSegmentedSessionRef.current?.sourceType ??
                                resolveDirectTrackSourceType(currentTrack),
                            reason,
                            stage,
                            action: decision.action,
                            attempt,
                            stageAttempts:
                                segmentedStartupStageAttemptsRef.current[stage],
                            delayMs: retryDelayMs,
                            baseDelayMs: baseRetryDelayMs,
                            retryAfterMsHint:
                                retryDetails.retryAfterMsHint ?? null,
                            windowElapsedMs,
                            windowMaxMs: SEGMENTED_STARTUP_RECOVERY_WINDOW_MS,
                            sessionResetsUsed:
                                segmentedStartupSessionResetCountRef.current,
                            maxSessionResets: maxSessionResetsForStage,
                        });

                        clearLoadListeners();
                        clearSegmentedStartupFallback();
                        clearSegmentedManifestNudges();
                        if (loadTimeoutRef.current) {
                            clearTimeout(loadTimeoutRef.current);
                            loadTimeoutRef.current = null;
                        }

                        const retryTrackContext =
                            resolveSegmentedTrackContext(currentTrack);
                        if (retryTrackContext) {
                            const retrySessionKey =
                                buildSegmentedSessionKey(retryTrackContext);
                            prewarmedSegmentedSessionRef.current.delete(
                                retrySessionKey,
                            );
                            startupSegmentedSessionInFlightRef.current.delete(
                                retrySessionKey,
                            );
                            startupSegmentedSessionPromisesRef.current.delete(
                                retrySessionKey,
                            );
                        }
                        startupSegmentedSessionRef.current = null;
                        forceFreshSegmentedSession = true;
                        isLoadingRef.current = true;
                        activeEngineTrackIdRef.current = null;
                        sourceResolved = false;
                        sourceForLoad = streamUrl;
                        sourceRequestHeaders = undefined;
                        usingSegmentedSource = false;
                        segmentedAssetBuildInFlight = false;
                        segmentedInitSource = null;
                        activeSegmentedSessionRef.current = null;
                        markSegmentedStartupRampWindow(currentTrack.id, reason);
                        audioEngine.stop();
                        playbackStateMachine.forceTransition("RECOVERING");
                        setIsBuffering(true);

                        setTimeout(() => {
                            if (
                                loadIdRef.current !== thisLoadId ||
                                !isLoadingRef.current
                            ) {
                                return;
                            }
                            playbackStateMachine.forceTransition("LOADING");
                            void startLoadAttempt({
                                retryReason: reason,
                            });
                        }, retryDelayMs);

                        return true;
                    };

                    try {
                        await resolveSourceForLoad();
                    } catch (segmentedStartupError) {
                        const startupErrorMessage =
                            segmentedStartupError instanceof Error
                                ? segmentedStartupError.message
                                : String(segmentedStartupError ?? "unknown");
                        const startupErrorHint = parseSegmentedStartupErrorHint(
                            segmentedStartupError,
                        );
                        const isTransientCreateFailure =
                            startupErrorHint?.isTransient ??
                            isLikelyTransientStreamError(startupErrorMessage);
                        sharedFrontendLogger.error(
                            "[AudioPlaybackOrchestrator] Segmented startup session failed:",
                            segmentedStartupError,
                        );
                        logPlaybackClientMetric("session.create_failure", {
                            trackId: currentTrack?.id ?? null,
                            sourceType: currentTrack
                                ? resolveDirectTrackSourceType(currentTrack)
                                : "unknown",
                            reason: startupErrorMessage,
                            stage: "session_create",
                            isTransient: isTransientCreateFailure,
                            retryAfterMsHint:
                                startupErrorHint?.retryAfterMs ?? null,
                            backendHintTransient:
                                startupErrorHint?.isTransient ?? null,
                        });
                        if (
                            scheduleSegmentedStartupRetry(
                                "session_create",
                                "segmented_session_create_error",
                                {
                                    isTransient: isTransientCreateFailure,
                                    errorMessage: startupErrorMessage,
                                    retryAfterMsHint:
                                        startupErrorHint?.retryAfterMs ?? null,
                                },
                            )
                        ) {
                            return;
                        }
                        emitSegmentedStartupTimeline("playback_error", {
                            error: startupErrorMessage,
                        });
                        isLoadingRef.current = false;
                        activeEngineTrackIdRef.current = null;
                        lastTrackIdRef.current = null;
                        playbackStateMachine.forceTransition("ERROR", {
                            error:
                                startupErrorMessage ||
                                "Segmented startup failed",
                            errorCode: 500,
                        });
                        setIsPlaying(false);
                        setIsBuffering(false);
                        return;
                    }

                    if (
                        loadIdRef.current !== thisLoadId ||
                        !isLoadingRef.current
                    ) {
                        return;
                    }

                    const deferAutoplay =
                        typeof sourceForLoad === "string" && startTime > 0;
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

                    if (typeof sourceForLoad === "string") {
                        activeSegmentedPlaybackTrackIdRef.current = null;
                        howlerLoadStartMsRef.current = Date.now();
                        // When resuming from a non-zero position, defer autoplay to
                        // handleLoaded so the seek completes before playback starts.
                        // Passing autoplay=true here would cause Howler's onload to
                        // play() from position 0 before handleLoaded can seek,
                        // producing overlapping audio streams.
                        audioEngine.load(
                            sourceForLoad,
                            deferAutoplay ? false : shouldAutoPlayOnLoad,
                            format,
                        );
                    } else {
                        activeSegmentedPlaybackTrackIdRef.current =
                            sourceForLoad.protocol === "dash"
                                ? (sourceForLoad.trackId ?? null)
                                : null;
                        audioEngine.load(sourceForLoad, {
                            autoplay: shouldAutoPlayOnLoad,
                            format,
                            withCredentials: true,
                            requestHeaders: sourceRequestHeaders,
                        });
                    }
                    applyCurrentOutputState();
                    if (
                        options.retryReason &&
                        playbackType === "track" &&
                        currentTrack
                    ) {
                        logPlaybackClientMetric(
                            "session.startup_retry_attempt",
                            {
                                trackId: currentTrack.id,
                                sourceType:
                                    activeSegmentedSessionRef.current
                                        ?.sourceType ??
                                    resolveDirectTrackSourceType(currentTrack),
                                reason: options.retryReason,
                                attempt: segmentedStartupRetryCountRef.current,
                            },
                        );
                    }

                    if (playbackType === "podcast" && currentPodcast) {
                        podcastDebugLog("audioEngine.load()", {
                            url:
                                typeof sourceForLoad === "string"
                                    ? sourceForLoad
                                    : sourceForLoad.url,
                            format,
                            loadId: thisLoadId,
                            attempt: loadTimeoutRetryCountRef.current + 1,
                        });
                    }

                    const handleLoaded = () => {
                        if (loadIdRef.current !== thisLoadId) return;

                        clearSegmentedStartupFallback();
                        clearSegmentedManifestNudges();
                        if (loadTimeoutRef.current) {
                            clearTimeout(loadTimeoutRef.current);
                            loadTimeoutRef.current = null;
                        }
                        loadTimeoutRetryCountRef.current = 0;
                        segmentedStartupRetryCountRef.current = 0;
                        segmentedStartupStageAttemptsRef.current =
                            createEmptySegmentedStartupRecoveryStageAttempts();
                        segmentedStartupRecoveryWindowStartedAtMsRef.current =
                            null;
                        segmentedStartupSessionResetCountRef.current = 0;
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
                        clearSegmentedStartupFallback();
                        clearSegmentedManifestNudges();
                        if (loadTimeoutRef.current) {
                            clearTimeout(loadTimeoutRef.current);
                            loadTimeoutRef.current = null;
                        }
                        const loadErrorMessage =
                            loadError instanceof Error
                                ? loadError.message
                                : String(
                                      loadError ??
                                          "segmented engine load error",
                                  );
                        const isTransientLoadError =
                            loadError == null ||
                            isLikelyTransientStreamError(loadErrorMessage);
                        if (
                            scheduleSegmentedStartupRetry(
                                "engine_load",
                                "segmented_load_error",
                                {
                                    isTransient: isTransientLoadError,
                                    errorMessage: loadErrorMessage,
                                },
                            )
                        ) {
                            return;
                        }
                        loadTimeoutRetryCountRef.current = 0;
                        isLoadingRef.current = false;
                        activeEngineTrackIdRef.current = null;
                        lastTrackIdRef.current = null;
                        playbackStateMachine.forceTransition("ERROR", {
                            error:
                                loadErrorMessage ||
                                "Segmented audio failed while loading",
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

                    if (
                        usingSegmentedSource &&
                        playbackType === "track" &&
                        currentTrack &&
                        isListenTogetherSegmentedPlaybackAllowed()
                    ) {
                        const configuredFallbackTimeoutMs =
                            resolveSegmentedStartupFallbackTimeoutMs();
                        const startupRetryTimeoutMs =
                            segmentedInitSource === "on_demand"
                                ? clampSegmentedStartupFallbackTimeoutMs(
                                      configuredFallbackTimeoutMs +
                                          SEGMENTED_STARTUP_ON_DEMAND_TIMEOUT_BONUS_MS,
                                  )
                                : configuredFallbackTimeoutMs;
                        {
                            const effectiveRetryTimeoutMs =
                                segmentedAssetBuildInFlight
                                    ? Math.max(
                                          SEGMENTED_STARTUP_ASSET_BUILD_TIMEOUT_FLOOR_MS,
                                          clampSegmentedStartupFallbackTimeoutMs(
                                              startupRetryTimeoutMs +
                                                  SEGMENTED_STARTUP_ASSET_BUILD_TIMEOUT_BONUS_MS,
                                          ),
                                      )
                                    : startupRetryTimeoutMs;

                            if (segmentedAssetBuildInFlight) {
                                logPlaybackClientMetric(
                                    "session.startup_asset_build_retry_armed",
                                    {
                                        trackId: currentTrack.id,
                                        sourceType:
                                            activeSegmentedSessionRef.current
                                                ?.sourceType ??
                                            resolveDirectTrackSourceType(
                                                currentTrack,
                                            ),
                                        effectiveRetryTimeoutMs,
                                    },
                                );
                            }

                            const retryDelayMs =
                                resolveSegmentedStartupRetryDelayMs({
                                    isLoading: isLoadingRef.current,
                                    sourceKind: usingSegmentedSource
                                        ? "segmented"
                                        : "direct",
                                    requestLoadId: thisLoadId,
                                    activeLoadId: loadIdRef.current,
                                    startupAttemptStartedAtMs,
                                    retryTimeoutMs: effectiveRetryTimeoutMs,
                                });
                            const retrySegmentedStartup = () => {
                                if (
                                    !shouldRetrySegmentedStartupTimeout({
                                        isLoading: isLoadingRef.current,
                                        sourceKind: usingSegmentedSource
                                            ? "segmented"
                                            : "direct",
                                        requestLoadId: thisLoadId,
                                        activeLoadId: loadIdRef.current,
                                    })
                                ) {
                                    return;
                                }

                                const didScheduleRetry =
                                    scheduleSegmentedStartupRetry(
                                        "manifest_readiness",
                                        "segmented_startup_timeout",
                                        {
                                            isTransient: true,
                                            errorMessage:
                                                "Segmented startup readiness timeout",
                                        },
                                    );
                                if (!didScheduleRetry) {
                                    emitSegmentedStartupTimeline(
                                        "startup_timeout",
                                        {
                                            effectiveRetryTimeoutMs,
                                        },
                                    );
                                    sharedFrontendLogger.warn(
                                        `[AudioPlaybackOrchestrator] Segmented startup exceeded ${effectiveRetryTimeoutMs}ms and retry budget is exhausted.`,
                                    );
                                    playbackStateMachine.forceTransition(
                                        "ERROR",
                                        {
                                            error: "Segmented startup timed out after retry budget",
                                            errorCode: 408,
                                        },
                                    );
                                    setIsPlaying(false);
                                    setIsBuffering(false);
                                }
                            };

                            if (typeof retryDelayMs === "number") {
                                if (retryDelayMs === 0) {
                                    retrySegmentedStartup();
                                    return;
                                }
                                segmentedStartupFallbackTimeoutRef.current =
                                    setTimeout(
                                        retrySegmentedStartup,
                                        retryDelayMs,
                                    );
                            }
                        }
                    }

                    const loadTimeoutMs =
                        usingSegmentedSource && segmentedAssetBuildInFlight
                            ? AUDIO_LOAD_TIMEOUT_ASSET_BUILD_INFLIGHT_MS
                            : AUDIO_LOAD_TIMEOUT_MS;
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
                                `[AudioPlaybackOrchestrator] Audio load timed out after ${loadTimeoutMs}ms; retrying (${retryAttempt}/${AUDIO_LOAD_TIMEOUT_RETRIES})`,
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
                                void startLoadAttempt();
                            }, AUDIO_LOAD_RETRY_DELAY_MS);
                            return;
                        }

                        sharedFrontendLogger.error(
                            `[AudioPlaybackOrchestrator] Audio load timed out after ${AUDIO_LOAD_TIMEOUT_MS}ms`,
                        );
                        emitSegmentedStartupTimeline("startup_timeout", {
                            loadTimeoutMs,
                            reason: "audio_load_timeout",
                        });
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
                    }, loadTimeoutMs);
                };

                void startLoadAttempt();
            } else {
                markSegmentedStartupRampWindow(null, "no_stream_url");
                clearSegmentedStartupFallback();
                clearSegmentedManifestNudges();
                if (loadTimeoutRef.current) {
                    clearTimeout(loadTimeoutRef.current);
                    loadTimeoutRef.current = null;
                }
                loadTimeoutRetryCountRef.current = 0;
                segmentedStartupRetryCountRef.current = 0;
                segmentedStartupStageAttemptsRef.current =
                    createEmptySegmentedStartupRecoveryStageAttempts();
                segmentedStartupRecoveryWindowStartedAtMsRef.current = null;
                segmentedStartupSessionResetCountRef.current = 0;
                segmentedStartupTimelineRef.current = null;
                isLoadingRef.current = false;
                activeEngineTrackIdRef.current = null;
                activeSegmentedPlaybackTrackIdRef.current = null;
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
            clearSegmentedStartupFallback,
            clearSegmentedManifestNudges,
            clearTransientTrackRecovery,
            prewarmSegmentedSession,
            ensureStartupSegmentedSession,
            ensureSegmentedStartupTimeline,
            emitSegmentedStartupTimeline,
            markSegmentedStartupRampWindow,
            isListenTogetherSegmentedPlaybackAllowed,
            resetSegmentedHandoffCircuit,
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
            prewarmSegmentedSession,
            isListenTogetherSegmentedPlaybackAllowed,
            prewarmedSegmentedSessionRef,
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
            clearSegmentedStartupFallback,
            clearSegmentedManifestNudges,
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
            abortAllSegmentedPrewarmValidations,
            clearSegmentedStartupFallback,
            clearSegmentedManifestNudges,
            clearPendingTrackErrorSkip,
            clearStartupPlaybackRecovery,
            clearTransientTrackRecovery,
            clearSegmentedHandoffLoadListeners,
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
