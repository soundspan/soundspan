import { useEffect, useLayoutEffect } from "react";
import { api } from "@/lib/api";
import type { Podcast, Track } from "@/lib/audio-state-context";
import { AUTOPLAY_INTENT_CONFLICT_WINDOW_MS } from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import {
    audioEngine,
    logPlaybackClientMetric,
} from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import { useLoudnessNormalization } from "./useLoudnessNormalization";

interface UsePlaybackControlSyncOptions {
    refs: PlaybackOrchestratorRefs;
    playbackType: "track" | "audiobook" | "podcast" | null;
    currentPodcast: Podcast | null;
    currentTrack: Track | null;
    isPlaying: boolean;
    repeatMode: "off" | "one" | "all";
    volume: number;
    isMuted: boolean;
    setCanSeek: (canSeek: boolean) => void;
    setDownloadProgress: (progress: number | null) => void;
    applyCurrentOutputState: () => void;
    scheduleStartupPlaybackRecovery: (
        trackId: string | null,
        recheckCount?: number,
    ) => void;
    clearStartupPlaybackRecovery: () => void;
}

/** Synchronizes cache, intent, and output controls with the audio engine. */
export function usePlaybackControlSync({
    refs,
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
}: UsePlaybackControlSyncOptions): void {
    const {
        cacheStatusPollingRef,
        lastPlayingStateRef,
        desiredLoadPlayRef,
        isLoadingRef,
        loadIdRef,
        cancelledLoadPlayIdRef,
        isUserInitiatedRef,
        trackErrorAdvanceFromTrackIdRef,
        consecutiveErrorBreakerRef,
        trackEndWatchdogRef,
        outputStateRef,
    } = refs;

    // Volume leveling (#526): keeps the gain factor applied by
    // applyCurrentOutputState in sync with the current track and user mode.
    useLoudnessNormalization({
        loudnessGainFactorRef: refs.loudnessGainFactorRef,
        applyCurrentOutputState,
    });

    // Check podcast cache status and control canSeek
    useEffect(() => {
        if (playbackType !== "podcast") {
            setCanSeek(true);
            setDownloadProgress(null);
            if (cacheStatusPollingRef.current) {
                clearInterval(cacheStatusPollingRef.current);
                cacheStatusPollingRef.current = null;
            }
            return;
        }

        if (!currentPodcast) {
            setCanSeek(true);
            return;
        }

        const [podcastId, episodeId] = currentPodcast.id.split(":");

        const checkCacheStatus = async () => {
            try {
                const status = await api.getPodcastEpisodeCacheStatus(
                    podcastId,
                    episodeId,
                );

                if (status.cached) {
                    setCanSeek(true);
                    setDownloadProgress(null);
                    if (cacheStatusPollingRef.current) {
                        clearInterval(cacheStatusPollingRef.current);
                        cacheStatusPollingRef.current = null;
                    }
                } else {
                    setCanSeek(false);
                    setDownloadProgress(
                        status.downloadProgress ??
                            (status.downloading ? 0 : null),
                    );
                }

                return status.cached;
            } catch (err) {
                sharedFrontendLogger.error(
                    "[AudioPlaybackOrchestrator] Failed to check cache status:",
                    err,
                );
                setCanSeek(true);
                return true;
            }
        };

        checkCacheStatus();

        cacheStatusPollingRef.current = setInterval(async () => {
            const isCached = await checkCacheStatus();
            if (isCached && cacheStatusPollingRef.current) {
                clearInterval(cacheStatusPollingRef.current);
                cacheStatusPollingRef.current = null;
            }
        }, 5000);

        return () => {
            if (cacheStatusPollingRef.current) {
                clearInterval(cacheStatusPollingRef.current);
                cacheStatusPollingRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [currentPodcast, playbackType, setCanSeek, setDownloadProgress]);

    // Keep lastPlayingStateRef always in sync
    useLayoutEffect(() => {
        lastPlayingStateRef.current = isPlaying;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [isPlaying]);

    // Handle play/pause changes from UI
    // Skip if a track change is in progress -- the track-change effect handles playback.
    // This prevents doubled audio when next() sets both currentTrack and isPlaying simultaneously.
    useEffect(() => {
        if (!isPlaying) {
            const desiredLoadPlay = desiredLoadPlayRef.current;
            const shouldReportAutoplayConflict = Boolean(
                !isLoadingRef.current &&
                audioEngine.isPlaying() &&
                desiredLoadPlay?.shouldPlay &&
                desiredLoadPlay.loadId === loadIdRef.current &&
                Date.now() - desiredLoadPlay.decidedAtMs <=
                    AUTOPLAY_INTENT_CONFLICT_WINDOW_MS,
            );
            if (shouldReportAutoplayConflict && desiredLoadPlay) {
                logPlaybackClientMetric("player.autoplay_intent_conflict", {
                    loadId: desiredLoadPlay.loadId,
                });
            }
            desiredLoadPlayRef.current = null;
            cancelledLoadPlayIdRef.current = loadIdRef.current;
        }

        if (isLoadingRef.current) return;

        isUserInitiatedRef.current = true;

        if (isPlaying) {
            const errorAdvanceFromTrackId =
                trackErrorAdvanceFromTrackIdRef.current;
            const isTrackErrorAdvance =
                playbackType === "track" &&
                errorAdvanceFromTrackId !== null &&
                (currentTrack?.id !== errorAdvanceFromTrackId ||
                    repeatMode === "one");
            trackErrorAdvanceFromTrackIdRef.current = null;
            if (!isTrackErrorAdvance) {
                consecutiveErrorBreakerRef.current.reset();
            }
            applyCurrentOutputState();
            audioEngine.play();
            if (playbackType === "track" && currentTrack?.id) {
                scheduleStartupPlaybackRecovery(currentTrack.id);
            }
        } else {
            trackEndWatchdogRef.current?.clear();
            clearStartupPlaybackRecovery();
            audioEngine.pause();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [
        isPlaying,
        playbackType,
        currentTrack?.id,
        repeatMode,
        applyCurrentOutputState,
        scheduleStartupPlaybackRecovery,
        clearStartupPlaybackRecovery,
    ]);

    // Keep audio engine output state aligned with UI controls.
    useEffect(() => {
        outputStateRef.current = { volume, isMuted };
        applyCurrentOutputState();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [volume, isMuted, applyCurrentOutputState]);
}
