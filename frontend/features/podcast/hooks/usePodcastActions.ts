"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useAudio } from "@/lib/audio-context";
import { useAudioState } from "@/lib/audio-state-context";
import { api } from "@/lib/api";
import { Podcast, Episode, PodcastPreview } from "../types";
import { queryKeys } from "@/hooks/useQueries";
import { dispatchQueryEvent } from "@/lib/query-events";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

function buildForwardEpisodeQueue(
    selectedEpisode: Episode,
    podcast: Podcast
): Episode[] | null {
    const episodesByDate = [...podcast.episodes].sort((a, b) => {
        const timeA = new Date(a.publishedAt).getTime();
        const timeB = new Date(b.publishedAt).getTime();
        return timeA - timeB;
    });

    if (episodesByDate.length === 0) {
        return null;
    }

    const selectedIndex = episodesByDate.findIndex(
        (episode) => episode.id === selectedEpisode.id
    );

    if (selectedIndex === -1) {
        return null;
    }

    const latestEpisode = episodesByDate[episodesByDate.length - 1];
    if (latestEpisode?.id === selectedEpisode.id) {
        return null;
    }

    return episodesByDate.slice(selectedIndex);
}

export function usePodcastActions(podcastId: string) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const { playPodcast, currentPodcast, isPlaying, pause, resume } =
        useAudio();
    const { setPodcastEpisodeQueue } = useAudioState();

    const [isSubscribing, setIsSubscribing] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    const handleSubscribe = useCallback(
        async (previewData: PodcastPreview | null) => {
            if (!previewData) return;

            setIsSubscribing(true);
            try {
                const response = await api.subscribePodcast(
                    previewData.feedUrl!,
                    previewData.itunesId
                );

                if (response.success && response.podcast?.id) {
                    // Invalidate podcasts cache so the list refreshes
                    queryClient.invalidateQueries({ queryKey: queryKeys.podcasts() });
                    router.push(`/podcasts/${response.podcast.id}`);
                }
            } catch (error: unknown) {
                sharedFrontendLogger.error("Subscribe error:", error);
                alert(error instanceof Error ? error.message : "Failed to subscribe to podcast");
            } finally {
                setIsSubscribing(false);
            }
        },
        [router, queryClient]
    );

    const handleRemovePodcast = useCallback(async () => {
        try {
            await api.removePodcast(podcastId);
            // Invalidate podcasts cache so the list refreshes without the removed podcast
            queryClient.invalidateQueries({ queryKey: queryKeys.podcasts() });
            router.push("/podcasts");
        } catch (error) {
            sharedFrontendLogger.error("Failed to remove podcast:", error);
        }
    }, [podcastId, router, queryClient]);

    const handlePlayEpisode = useCallback(
        (episode: Episode, podcast: Podcast) => {
            const queue = buildForwardEpisodeQueue(episode, podcast);
            setPodcastEpisodeQueue(queue);

            playPodcast({
                id: `${podcastId}:${episode.id}`,
                title: episode.title,
                podcastTitle: podcast.title,
                coverUrl: podcast.coverUrl,
                duration: episode.duration,
                progress: episode.progress || null,
            });
        },
        [podcastId, playPodcast, setPodcastEpisodeQueue]
    );

    const handlePlayPauseEpisode = useCallback(
        (episode: Episode, podcast: Podcast) => {
            const isCurrentEpisode =
                currentPodcast?.id === `${podcastId}:${episode.id}`;

            if (isCurrentEpisode && isPlaying) {
                pause();
            } else if (isCurrentEpisode) {
                resume();
            } else {
                handlePlayEpisode(episode, podcast);
            }
        },
        [podcastId, currentPodcast, isPlaying, pause, resume, handlePlayEpisode]
    );

    const isEpisodePlaying = useCallback(
        (episodeId: string) => {
            return currentPodcast?.id === `${podcastId}:${episodeId}`;
        },
        [podcastId, currentPodcast]
    );

    const handleMarkEpisodeComplete = useCallback(
        async (episodeId: string, duration: number) => {
            try {
                // Mark episode as complete (set currentTime to duration and isFinished to true)
                await api.updatePodcastEpisodeProgress(
                    podcastId,
                    episodeId,
                    duration,
                    duration,
                    true
                );
                
                // Invalidate podcast query to refresh UI
                queryClient.invalidateQueries({
                    queryKey: queryKeys.podcast(podcastId)
                });
                
                // Dispatch event for real-time UI updates
                dispatchQueryEvent("podcast-progress-updated");
            } catch (error) {
                sharedFrontendLogger.error("Failed to mark episode as complete:", error);
                throw error;
            }
        },
        [podcastId, queryClient]
    );

    return {
        isSubscribing,
        showDeleteConfirm,
        setShowDeleteConfirm,
        handleSubscribe,
        handleRemovePodcast,
        handlePlayEpisode,
        handlePlayPauseEpisode,
        handleMarkEpisodeComplete,
        isEpisodePlaying,
        isPlaying,
        pause,
        resume,
    };
}
