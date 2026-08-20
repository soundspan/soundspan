import type {
    Audiobook,
    PlayerMode,
    Podcast,
    Track,
} from "./audio-state-context";
import type { PlaybackAdvanceOrigin } from "./audio-engine/playbackAdvanceOrigin";
import type { EpisodeQueueItem } from "./queue-item";
import type { Episode } from "@/features/podcast/types";

/** Public playback and queue actions provided by AudioControlsProvider. */
export interface AudioControlsContextType {
    playTrack: (track: Track) => void;
    playTracks: (
        tracks: Track[],
        startIndex?: number,
        isVibeQueue?: boolean,
    ) => void;
    playAudiobook: (audiobook: Audiobook) => void;
    playPodcast: (
        podcast: Podcast,
        options?: { episodeQueue?: EpisodeQueueItem[] },
    ) => void;
    addEpisodeToQueue: (
        episode: Episode,
        podcast: { id: string; title: string; coverUrl: string | null },
    ) => void;
    playEpisodeNext: (
        episode: Episode,
        podcast: { id: string; title: string; coverUrl: string | null },
    ) => void;
    pause: (options?: { suppressListenTogetherBroadcast?: boolean }) => void;
    resume: (options?: {
        suppressListenTogetherBroadcast?: boolean;
        listenTogetherForceIsPlaying?: boolean;
        listenTogetherPositionMs?: number;
        listenTogetherServerTimeMs?: number;
    }) => void;
    play: () => void;
    next: () => void;
    advanceQueue: (origin: PlaybackAdvanceOrigin) => void;
    previous: () => void;
    playNow: (track: Track) => void;
    playNext: (track: Track) => void;
    addToQueue: (track: Track, options?: { silent?: boolean }) => void;
    addTracksToQueue: (tracks: Track[], options?: { silent?: boolean }) => void;
    playQueueIndex: (index: number) => void;
    removeFromQueue: (index: number) => void;
    /**
     * Move an UPCOMING queue item (index > currentIndex) to another
     * upcoming position with splice semantics. No-op in Listen Together
     * sessions, for out-of-range indexes, and for history/current rows;
     * shuffle indices are remapped so the shuffle order keeps pointing
     * at the same items.
     */
    moveQueueItem: (fromIndex: number, toIndex: number) => void;
    clearQueue: () => void;
    setUpcoming: (tracks: Track[], preserveOrder?: boolean) => void;
    toggleShuffle: () => void;
    toggleRepeat: () => void;
    updateCurrentTime: (time: number) => void;
    seek: (
        time: number,
        options?: {
            allowListenTogetherFollower?: boolean;
            suppressListenTogetherBroadcast?: boolean;
        },
    ) => void;
    skipForward: (seconds?: number) => void;
    skipBackward: (seconds?: number) => void;
    setPlayerMode: (mode: PlayerMode) => void;
    returnToPreviousMode: () => void;
    setVolume: (volume: number) => void;
    toggleMute: () => void;
    startVibeMode: () => Promise<{ success: boolean; trackCount: number }>;
    stopVibeMode: () => void;
}
