import { useCallback } from "react";
import { useAudio } from "@/lib/audio-context";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { DiscoverPlaylist } from "../types";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";

interface PlaybackQueueTrack {
    id: string;
    title: string;
    artist: { name: string };
    album: {
        id: string;
        title: string;
        coverArt?: string;
    };
    duration: number;
    streamSource?: "tidal" | "youtube";
    tidalTrackId?: number;
    youtubeVideoId?: string;
}

export function mapDiscoverTrackToPlaybackTrack(
    track: DiscoverPlaylist["tracks"][number]
): PlaybackQueueTrack {
    return {
        id: track.id,
        title: track.title,
        artist: { name: track.artist },
        album: {
            id: track.albumId,
            title: track.album,
            coverArt: track.coverUrl || undefined,
        },
        duration: track.duration || 0,
        ...(track.streamSource === "tidal" &&
            track.tidalTrackId && {
                streamSource: "tidal" as const,
                tidalTrackId: track.tidalTrackId,
            }),
        ...(track.streamSource === "youtube" &&
            track.youtubeVideoId && {
                streamSource: "youtube" as const,
                youtubeVideoId: track.youtubeVideoId,
            }),
    };
}

export function useDiscoverActions(
    playlist: DiscoverPlaylist | null,
    isGenerating?: boolean,
    refreshBatchStatus?: () => Promise<unknown>,
    setPendingGeneration?: (pending: boolean) => void
) {
    const { playTracks, playNow, isPlaying, pause, resume } = useAudio();

    const handleGenerate = useCallback(async () => {
        if (isGenerating) {
            sharedFrontendLogger.warn("Generation already in progress, ignoring request");
            toast.warning("Generation already in progress...");
            return;
        }

        // Set optimistic state immediately to prevent double-clicks
        setPendingGeneration?.(true);

        try {
            toast.info("Generating your Discover Weekly playlist...");
            await api.generateDiscoverWeekly();
            
            // Immediately refresh batch status to start polling
            if (refreshBatchStatus) {
                await refreshBatchStatus();
            }
            
            toast.success("Generation started! Refreshing recommendations...");
        } catch (error: unknown) {
            sharedFrontendLogger.error("Generation failed:", error);
            // Clear pending state on error
            setPendingGeneration?.(false);
            const err = error as Error & { status?: number };
            if (err.status === 409) {
                toast.warning("A playlist is already being generated...");
                // Refresh status in case UI is out of sync
                if (refreshBatchStatus) {
                    await refreshBatchStatus();
                }
            } else {
                toast.error(err.message || "Failed to generate playlist");
            }
        }
    }, [isGenerating, refreshBatchStatus, setPendingGeneration]);

    const handlePlayPlaylist = useCallback(() => {
        if (!playlist || playlist.tracks.length === 0) return;

        const formattedTracks = playlist.tracks.map(
            mapDiscoverTrackToPlaybackTrack
        );

        playTracks(formattedTracks, 0);
    }, [playlist, playTracks]);

    const handlePlayTrack = useCallback(
        (index: number) => {
            if (!playlist || playlist.tracks.length === 0) return;
            if (index < 0 || index >= playlist.tracks.length) return;

            const formattedTrack = mapDiscoverTrackToPlaybackTrack(
                playlist.tracks[index]
            );

            playNow(formattedTrack);
        },
        [playlist, playNow]
    );

    const handleTogglePlay = useCallback(() => {
        if (isPlaying) {
            pause();
        } else {
            resume();
        }
    }, [isPlaying, pause, resume]);

    return {
        handleGenerate,
        handlePlayPlaylist,
        handlePlayTrack,
        handleTogglePlay,
    };
}
