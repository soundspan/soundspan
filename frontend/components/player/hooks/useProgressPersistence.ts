import { useCallback, useEffect, type MutableRefObject } from "react";
import { api } from "@/lib/api";
import type { Audiobook, Podcast } from "@/lib/audio-state-context";
import { dispatchQueryEvent } from "@/lib/query-events";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { audioEngine } from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";

interface UseProgressSaveCallbacksOptions {
    currentAudiobook: Audiobook | null;
    currentPodcast: Podcast | null;
    isBuffering: boolean;
    setCurrentAudiobook: (
        audiobook:
            | Audiobook
            | null
            | ((previous: Audiobook | null) => Audiobook | null),
    ) => void;
    lastProgressSaveRef: MutableRefObject<number>;
}

/** Returns the existing audiobook and podcast progress writers. */
export function useProgressSaveCallbacks({
    currentAudiobook,
    currentPodcast,
    isBuffering,
    setCurrentAudiobook,
    lastProgressSaveRef,
}: UseProgressSaveCallbacksOptions): {
    saveAudiobookProgress: (isFinished?: boolean) => Promise<void>;
    savePodcastProgress: (isFinished?: boolean) => Promise<void>;
} {
    // Save audiobook progress
    const saveAudiobookProgress = useCallback(
        async (isFinished: boolean = false) => {
            if (!currentAudiobook) return;

            const currentTime = audioEngine.getCurrentTime();
            const duration =
                audioEngine.getDuration() || currentAudiobook.duration;

            if (currentTime === lastProgressSaveRef.current && !isFinished)
                return;
            lastProgressSaveRef.current = currentTime;

            try {
                await api.updateAudiobookProgress(
                    currentAudiobook.id,
                    isFinished ? duration : currentTime,
                    duration,
                    isFinished,
                );

                setCurrentAudiobook({
                    ...currentAudiobook,
                    progress: {
                        currentTime: isFinished ? duration : currentTime,
                        progress:
                            duration > 0
                                ? ((isFinished ? duration : currentTime) /
                                      duration) *
                                  100
                                : 0,
                        isFinished,
                        lastPlayedAt: new Date(),
                    },
                });

                dispatchQueryEvent("audiobook-progress-updated");
            } catch (err) {
                sharedFrontendLogger.error(
                    "[AudioPlaybackOrchestrator] Failed to save audiobook progress:",
                    err,
                );
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [currentAudiobook, setCurrentAudiobook],
    );

    // Save podcast progress
    const savePodcastProgress = useCallback(
        async (isFinished: boolean = false) => {
            if (!currentPodcast) return;

            if (isBuffering && !isFinished) return;

            const currentTime = audioEngine.getCurrentTime();
            const duration =
                audioEngine.getDuration() || currentPodcast.duration;

            if (currentTime <= 0 && !isFinished) return;

            try {
                const [podcastId, episodeId] = currentPodcast.id.split(":");
                await api.updatePodcastProgress(
                    podcastId,
                    episodeId,
                    isFinished ? duration : currentTime,
                    duration,
                    isFinished,
                );

                dispatchQueryEvent("podcast-progress-updated");
            } catch (err) {
                sharedFrontendLogger.error(
                    "[AudioPlaybackOrchestrator] Failed to save podcast progress:",
                    err,
                );
            }
        },
        [currentPodcast, isBuffering],
    );

    return { saveAudiobookProgress, savePodcastProgress };
}

interface UseProgressPersistenceOptions {
    playbackType: "track" | "audiobook" | "podcast" | null;
    isPlaying: boolean;
    saveAudiobookProgress: (isFinished?: boolean) => Promise<void>;
    savePodcastProgress: (isFinished?: boolean) => Promise<void>;
    progressSaveIntervalRef: MutableRefObject<NodeJS.Timeout | null>;
}

/** Runs the existing periodic progress persistence effect. */
export function useProgressPersistence({
    playbackType,
    isPlaying,
    saveAudiobookProgress,
    savePodcastProgress,
    progressSaveIntervalRef,
}: UseProgressPersistenceOptions): void {
    // Periodic progress saving for audiobooks and podcasts
    useEffect(() => {
        if (playbackType !== "audiobook" && playbackType !== "podcast") {
            if (progressSaveIntervalRef.current) {
                clearInterval(progressSaveIntervalRef.current);
                progressSaveIntervalRef.current = null;
            }
            return;
        }

        if (!isPlaying) {
            if (playbackType === "audiobook") {
                saveAudiobookProgress();
            } else if (playbackType === "podcast") {
                savePodcastProgress();
            }
        }

        if (isPlaying) {
            // Clear any existing interval before creating a new one
            if (progressSaveIntervalRef.current) {
                clearInterval(progressSaveIntervalRef.current);
            }
            progressSaveIntervalRef.current = setInterval(() => {
                if (playbackType === "audiobook") {
                    saveAudiobookProgress();
                } else if (playbackType === "podcast") {
                    savePodcastProgress();
                }
            }, 30000);
        }

        return () => {
            if (progressSaveIntervalRef.current) {
                clearInterval(progressSaveIntervalRef.current);
                progressSaveIntervalRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [playbackType, isPlaying, saveAudiobookProgress, savePodcastProgress]);
}
