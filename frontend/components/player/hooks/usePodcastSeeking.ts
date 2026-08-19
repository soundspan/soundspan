import { useCallback, useEffect } from "react";
import { api } from "@/lib/api";
import type { Podcast } from "@/lib/audio-state-context";
import { audioSeekEmitter } from "@/lib/audio-seek-emitter";
import { isSeekWithinTolerance } from "@/lib/audio-engine/playbackRecoveryPolicy";
import {
    audioEngine,
    podcastDebugLog,
} from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";

interface UsePodcastSeekingOptions {
    refs: PlaybackOrchestratorRefs;
    playbackType: "track" | "audiobook" | "podcast" | null;
    currentPodcast: Podcast | null;
    setCurrentTime: (time: number) => void;
    setIsBuffering: (isBuffering: boolean) => void;
    setTargetSeekPosition: (position: number | null) => void;
    setIsPlaying: (isPlaying: boolean) => void;
}

/** Preserves podcast cache polling and seek/reload orchestration. */
export function usePodcastSeeking({
    refs,
    playbackType,
    currentPodcast,
    setCurrentTime,
    setIsBuffering,
    setTargetSeekPosition,
    setIsPlaying,
}: UsePodcastSeekingOptions): void {
    const {
        seekOperationIdRef,
        cachePollingRef,
        cachePollingLoadListenerRef,
        seekCheckTimeoutRef,
        seekReloadListenerRef,
        seekReloadInProgressRef,
        seekDebounceRef,
        pendingSeekTimeRef,
        isSeekingRef,
    } = refs;

    // Poll for podcast cache and reload when ready
    const startCachePolling = useCallback(
        (podcastId: string, episodeId: string, targetTime: number) => {
            // Capture the current seek operation ID
            const pollingSeekId = seekOperationIdRef.current;

            if (cachePollingRef.current) {
                clearInterval(cachePollingRef.current);
            }

            let pollCount = 0;
            const maxPolls = 60;

            cachePollingRef.current = setInterval(async () => {
                // Check if a newer seek operation has started
                if (seekOperationIdRef.current !== pollingSeekId) {
                    if (cachePollingRef.current) {
                        clearInterval(cachePollingRef.current);
                        cachePollingRef.current = null;
                    }
                    podcastDebugLog("cache polling aborted (stale)", {
                        pollingSeekId,
                        currentId: seekOperationIdRef.current,
                    });
                    return;
                }

                pollCount++;

                try {
                    const status = await api.getPodcastEpisodeCacheStatus(
                        podcastId,
                        episodeId,
                    );

                    // Re-check after async operation
                    if (seekOperationIdRef.current !== pollingSeekId) {
                        if (cachePollingRef.current) {
                            clearInterval(cachePollingRef.current);
                            cachePollingRef.current = null;
                        }
                        return;
                    }

                    podcastDebugLog("cache poll", {
                        podcastId,
                        episodeId,
                        pollCount,
                        cached: status.cached,
                        downloading: status.downloading,
                        downloadProgress: status.downloadProgress,
                        targetTime,
                    });

                    if (status.cached) {
                        if (cachePollingRef.current) {
                            clearInterval(cachePollingRef.current);
                            cachePollingRef.current = null;
                        }

                        podcastDebugLog("cache ready -> audioEngine.reload()", {
                            podcastId,
                            episodeId,
                            targetTime,
                        });
                        // Clean up any previous cache polling load listener
                        if (cachePollingLoadListenerRef.current) {
                            audioEngine.off(
                                "load",
                                cachePollingLoadListenerRef.current,
                            );
                            cachePollingLoadListenerRef.current = null;
                        }

                        audioEngine.reload();

                        const onLoad = () => {
                            audioEngine.off("load", onLoad);
                            cachePollingLoadListenerRef.current = null;

                            // Check if still current before acting
                            if (seekOperationIdRef.current !== pollingSeekId) {
                                podcastDebugLog(
                                    "cache polling load callback aborted (stale)",
                                    { pollingSeekId },
                                );
                                return;
                            }

                            audioEngine.seek(targetTime);
                            setCurrentTime(targetTime);
                            audioEngine.play();
                            podcastDebugLog("post-reload seek+play", {
                                podcastId,
                                episodeId,
                                targetTime,
                                engineTime: audioEngine.getCurrentTime(),
                                actualTime: audioEngine.getActualCurrentTime(),
                            });

                            setIsBuffering(false);
                            setTargetSeekPosition(null);
                            setIsPlaying(true);
                        };

                        cachePollingLoadListenerRef.current = onLoad;
                        audioEngine.on("load", onLoad);
                    } else if (pollCount >= maxPolls) {
                        if (cachePollingRef.current) {
                            clearInterval(cachePollingRef.current);
                            cachePollingRef.current = null;
                        }

                        sharedFrontendLogger.warn(
                            "[AudioPlaybackOrchestrator] Cache polling timeout",
                        );
                        setIsBuffering(false);
                        setTargetSeekPosition(null);
                    }
                } catch (error) {
                    sharedFrontendLogger.error(
                        "[AudioPlaybackOrchestrator] Cache polling error:",
                        error,
                    );
                }
            }, 2000);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [setCurrentTime, setIsBuffering, setTargetSeekPosition, setIsPlaying],
    );

    // Handle seeking via event emitter
    useEffect(() => {
        // Store previous time to detect large skips vs fine scrubbing
        let previousTime = audioEngine.getCurrentTime();

        const handleSeek = async (time: number) => {
            // Increment seek operation ID to track this specific seek
            seekOperationIdRef.current += 1;
            const thisSeekId = seekOperationIdRef.current;

            const wasPlayingAtSeekStart = audioEngine.isPlaying();

            // Detect if this is a large skip (like 30s buttons) vs fine scrubbing
            const timeDelta = Math.abs(time - previousTime);
            const isLargeSkip = timeDelta >= 10; // 10+ seconds = large skip (30s, 15s buttons)
            previousTime = time;

            // DON'T set currentTime here for podcasts - the seek() in audio-controls-context
            // already did it optimistically. Setting it again causes a race condition.
            // We only update it after the seek actually completes.

            if (playbackType === "podcast" && currentPodcast) {
                // Cancel any previous seek-related operations
                if (seekCheckTimeoutRef.current) {
                    clearTimeout(seekCheckTimeoutRef.current);
                    seekCheckTimeoutRef.current = null;
                }

                // Cancel any pending cache polling from previous seek
                if (cachePollingRef.current) {
                    clearInterval(cachePollingRef.current);
                    cachePollingRef.current = null;
                }

                // Cancel previous reload listener
                if (seekReloadListenerRef.current) {
                    audioEngine.off("load", seekReloadListenerRef.current);
                    seekReloadListenerRef.current = null;
                }

                // Cancel previous cache polling load listener
                if (cachePollingLoadListenerRef.current) {
                    audioEngine.off(
                        "load",
                        cachePollingLoadListenerRef.current,
                    );
                    cachePollingLoadListenerRef.current = null;
                }

                // Cancel any pending debounced seek
                if (seekDebounceRef.current) {
                    clearTimeout(seekDebounceRef.current);
                    seekDebounceRef.current = null;
                }

                // Store the pending seek time - debounce will use the latest value
                pendingSeekTimeRef.current = time;

                const [podcastId, episodeId] = currentPodcast.id.split(":");

                // Execute the seek logic - immediately for large skips, debounced for fine scrubbing
                const executeSeek = async () => {
                    const seekTime = pendingSeekTimeRef.current ?? time;
                    pendingSeekTimeRef.current = null;

                    // Check if this seek is still current
                    if (seekOperationIdRef.current !== thisSeekId) {
                        return;
                    }

                    try {
                        const status = await api.getPodcastEpisodeCacheStatus(
                            podcastId,
                            episodeId,
                        );

                        // Check if this seek operation is still current
                        if (seekOperationIdRef.current !== thisSeekId) {
                            podcastDebugLog("seek: aborted (stale operation)", {
                                thisSeekId,
                                currentId: seekOperationIdRef.current,
                            });
                            return;
                        }

                        if (status.cached) {
                            // For cached podcasts, try direct seek first (faster than reload)
                            podcastDebugLog(
                                "seek: cached=true, trying direct seek first",
                                {
                                    time: seekTime,
                                    podcastId,
                                    episodeId,
                                },
                            );

                            // Direct seek - audioEngine now handles seek locking internally
                            audioEngine.seek(seekTime);

                            // Verify seek succeeded after a short delay
                            setTimeout(() => {
                                if (seekOperationIdRef.current !== thisSeekId) {
                                    return;
                                }

                                const actualPos =
                                    audioEngine.getActualCurrentTime();
                                const seekSucceeded = isSeekWithinTolerance(
                                    actualPos,
                                    seekTime,
                                );

                                podcastDebugLog("seek: direct seek result", {
                                    seekTime,
                                    actualPos,
                                    seekSucceeded,
                                });

                                if (!seekSucceeded) {
                                    // Direct seek failed, fall back to reload pattern
                                    podcastDebugLog(
                                        "seek: direct seek failed, falling back to reload",
                                    );
                                    seekReloadInProgressRef.current = true;

                                    audioEngine.reload();

                                    const onLoad = () => {
                                        audioEngine.off("load", onLoad);
                                        seekReloadListenerRef.current = null;
                                        seekReloadInProgressRef.current = false;

                                        if (
                                            seekOperationIdRef.current !==
                                            thisSeekId
                                        ) {
                                            return;
                                        }

                                        audioEngine.seek(seekTime);

                                        if (wasPlayingAtSeekStart) {
                                            audioEngine.play();
                                            setIsPlaying(true);
                                        }
                                    };

                                    seekReloadListenerRef.current = onLoad;
                                    audioEngine.on("load", onLoad);
                                } else {
                                    // Seek succeeded - resume playback if needed
                                    if (
                                        wasPlayingAtSeekStart &&
                                        !audioEngine.isPlaying()
                                    ) {
                                        audioEngine.play();
                                    }
                                }
                            }, 150);

                            return;
                        }
                    } catch (e) {
                        sharedFrontendLogger.warn(
                            "[AudioPlaybackOrchestrator] Could not check cache status:",
                            e,
                        );
                    }

                    // Check if still current after async operation
                    if (seekOperationIdRef.current !== thisSeekId) {
                        return;
                    }

                    // Not cached - try direct seek
                    audioEngine.seek(seekTime);

                    // For non-cached streams, we rely on the browser's ability to seek via Range requests.
                    // If that fails, we shouldn't stop playback. We'll just let it try to buffer.
                    // We only check for success to log debug info, but we won't force a pause/poll loop
                    // which caused playback to stop completely in some cases.

                    seekCheckTimeoutRef.current = setTimeout(() => {
                        // Check if this seek is still current
                        if (seekOperationIdRef.current !== thisSeekId) {
                            return;
                        }

                        try {
                            const actualPos =
                                audioEngine.getActualCurrentTime();
                            const seekFailed = !isSeekWithinTolerance(
                                actualPos,
                                seekTime,
                            );

                            podcastDebugLog("seek check (streaming)", {
                                time: seekTime,
                                actualPos,
                                seekFailed,
                                podcastId,
                                episodeId,
                            });

                            // If seek failed during streaming, we don't pause.
                            // We assume the browser is buffering or the stream doesn't support seeking.
                            // Pausing here would break playback if the seek just takes a while.
                        } catch (e) {
                            sharedFrontendLogger.error(
                                "[AudioPlaybackOrchestrator] Seek check error:",
                                e,
                            );
                        }
                    }, 2000);
                };

                // For large skips (30s buttons), execute immediately for responsive feel
                // For fine scrubbing (progress bar), debounce to prevent spamming
                if (isLargeSkip) {
                    podcastDebugLog("seek: large skip, executing immediately", {
                        timeDelta,
                        time,
                    });
                    executeSeek();
                } else {
                    podcastDebugLog("seek: fine scrub, debouncing", {
                        timeDelta,
                        time,
                    });
                    seekDebounceRef.current = setTimeout(executeSeek, 150);
                }

                return;
            }

            // For audiobooks and tracks, set seeking flag to prevent load effect interference
            isSeekingRef.current = true;
            audioEngine.seek(time);

            // Reset seeking flag after a short delay to allow seek to complete
            setTimeout(() => {
                isSeekingRef.current = false;
            }, 100);
        };

        const unsubscribe = audioSeekEmitter.subscribe(handleSeek);
        return unsubscribe;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [
        playbackType,
        currentPodcast,
        setIsBuffering,
        setTargetSeekPosition,
        setIsPlaying,
        startCachePolling,
    ]);

    // Cleanup cache polling, seek timeout, and seek-reload listener on unmount
    useEffect(() => {
        return () => {
            if (cachePollingRef.current) {
                clearInterval(cachePollingRef.current);
            }
            if (seekCheckTimeoutRef.current) {
                clearTimeout(seekCheckTimeoutRef.current);
            }
            if (seekReloadListenerRef.current) {
                audioEngine.off("load", seekReloadListenerRef.current);
                seekReloadListenerRef.current = null;
            }
            if (seekDebounceRef.current) {
                clearTimeout(seekDebounceRef.current);
                seekDebounceRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, []);
}
