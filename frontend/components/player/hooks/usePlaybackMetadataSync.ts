import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { Audiobook, Podcast, Track } from "@/lib/audio-state-context";
import {
    fetchLyrics,
    lyricsQueryKeys,
    type LyricsLookupMetadata,
} from "@/hooks/useLyrics";
import { LYRICS_QUERY_STALE_TIME } from "@/lib/lyrics-cache-policy";

interface UsePlaybackMetadataSyncOptions {
    queryClient: QueryClient;
    playbackType: "track" | "audiobook" | "podcast" | null;
    currentTrack: Track | null;
    currentAudiobook: Audiobook | null;
    currentPodcast: Podcast | null;
    setDuration: (duration: number) => void;
}

/** Prefetches track lyrics and resets duration when media is cleared. */
export function usePlaybackMetadataSync({
    queryClient,
    playbackType,
    currentTrack,
    currentAudiobook,
    currentPodcast,
    setDuration,
}: UsePlaybackMetadataSyncOptions): void {
    // Prefetch lyrics in the background as soon as a track is loaded.
    useEffect(() => {
        if (playbackType !== "track" || !currentTrack?.id) return;

        const metadata: LyricsLookupMetadata = {
            artist: currentTrack.artist?.name,
            title: currentTrack.displayTitle || currentTrack.title,
            album: currentTrack.album?.title,
            duration: currentTrack.duration,
        };

        queryClient.prefetchQuery({
            queryKey: lyricsQueryKeys.lyrics(currentTrack.id, metadata),
            queryFn: () => fetchLyrics(currentTrack.id, metadata),
            staleTime: LYRICS_QUERY_STALE_TIME,
        });
    }, [
        queryClient,
        playbackType,
        currentTrack?.id,
        currentTrack?.artist?.name,
        currentTrack?.displayTitle,
        currentTrack?.title,
        currentTrack?.album?.title,
        currentTrack?.duration,
    ]);

    // Reset duration when nothing is playing
    useEffect(() => {
        if (!currentTrack && !currentAudiobook && !currentPodcast) {
            setDuration(0);
        }
    }, [currentTrack, currentAudiobook, currentPodcast, setDuration]);
}
