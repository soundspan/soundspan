"use client";

import {
    useAudioControls,
    useAudioState,
    usePlaybackStatus,
} from "@/lib/audio-context";
import { usePlaybackProgress } from "@/lib/audio-playback-context";

/**
 * The overlay player's audio-context wiring: narrow subscriptions only
 * (GH #785). The overlay renders the seek slider and time, so it is a
 * legitimate clock consumer via usePlaybackProgress.
 */
export function useOverlayPlayerAudio() {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isShuffle,
        repeatMode,
        vibeMode,
        queue,
        currentIndex,
    } = useAudioState();
    const {
        isPlaying,
        isBuffering,
        canSeek,
        downloadProgress,
        audioError,
        clearAudioError,
        duration: playbackDuration,
    } = usePlaybackStatus();
    const { currentTime } = usePlaybackProgress();
    const controls = useAudioControls();

    return {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isShuffle,
        repeatMode,
        vibeMode,
        queue,
        currentIndex,
        isPlaying,
        isBuffering,
        canSeek,
        downloadProgress,
        audioError,
        clearAudioError,
        playbackDuration,
        currentTime,
        pause: controls.pause,
        resume: controls.resume,
        next: controls.next,
        previous: controls.previous,
        returnToPreviousMode: controls.returnToPreviousMode,
        seek: controls.seek,
        toggleShuffle: controls.toggleShuffle,
        toggleRepeat: controls.toggleRepeat,
        startVibeMode: controls.startVibeMode,
        stopVibeMode: controls.stopVibeMode,
        playTrack: controls.playTrack,
        playQueueIndex: controls.playQueueIndex,
        setUpcoming: controls.setUpcoming,
        removeFromQueue: controls.removeFromQueue,
        clearQueue: controls.clearQueue,
        skipForward: controls.skipForward,
        skipBackward: controls.skipBackward,
    };
}
