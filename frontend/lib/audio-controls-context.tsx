"use client";

import {
    createContext,
    useContext,
    useCallback,
    useRef,
    useEffect,
    ReactNode,
    useMemo,
} from "react";
import {
    useAudioState,
    Track,
    Audiobook,
    Podcast,
    PlayerMode,
} from "./audio-state-context";
import { useAudioPlayback } from "./audio-playback-context";
import { api } from "@/lib/api";
import { audioSeekEmitter } from "./audio-seek-emitter";
import { listenTogetherSocket } from "./listen-together-socket";
import {
    enqueueLatestListenTogetherHostTrackOperation,
    getListenTogetherOptimisticTrackSelectionPolicy,
    getListenTogetherSessionSnapshot,
    type ListenTogetherSessionSnapshot,
} from "./listen-together-session";
import { toast } from "sonner";
import { computePlayNowInsertion } from "./queue-utils";
import { separateArtists } from "./separate-artists";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import { clampAudioVolume } from "@/lib/audio-volume";
import {
    clampPlaybackTimeToUpperBound,
    resolvePlaybackTimeUpperBound,
} from "@/lib/audio-playback-normalization";
import { resetPersistedTrackStartPosition } from "@/lib/persisted-playback-position";
import { resolveListenTogetherNavigationIndex } from "@/lib/listen-together-navigation";
import {
    createMigratingStorageKey,
    writeMigratingStorageItem,
} from "@/lib/storage-migration";
import {
    LAST_PLAYBACK_STATE_SAVE_AT_KEY_SUFFIX,
    QUEUE_CLEARED_AT_KEY_SUFFIX,
} from "@/lib/playback-state-cadence";

const LAST_PLAYBACK_STATE_SAVE_AT_KEY = createMigratingStorageKey(
    LAST_PLAYBACK_STATE_SAVE_AT_KEY_SUFFIX
);
const QUEUE_CLEARED_AT_KEY = createMigratingStorageKey(
    QUEUE_CLEARED_AT_KEY_SUFFIX
);

function queueDebugEnabled(): boolean {
    try {
        return (
            typeof window !== "undefined" &&
            window.localStorage?.getItem("soundspanQueueDebug") === "1"
        );
    } catch {
        // Intentionally ignored: localStorage may throw in SSR or restricted contexts
        return false;
    }
}

function queueDebugLog(message: string, data?: Record<string, unknown>) {
    if (!queueDebugEnabled()) return;
    sharedFrontendLogger.info(`[QueueDebug] ${message}`, data || {});
}

function isListenTogetherLocalTrack(track: Track | null | undefined): track is Track {
    if (!track?.id) return false;
    if (track.streamSource === "tidal" || track.streamSource === "youtube") {
        return false;
    }
    if (typeof track.filePath === "string" && track.filePath.trim().length > 0) {
        return true;
    }
    return Boolean(track.album?.id);
}

export type QueueNavigationAction = "next" | "previous";

export interface ResolveQueueNavigationIndexInput {
    action: QueueNavigationAction;
    queueLength: number;
    currentIndex: number;
    isShuffle: boolean;
    shuffleIndices: number[];
    repeatMode: "off" | "one" | "all";
}

export function resolveQueueNavigationIndex(
    input: ResolveQueueNavigationIndexInput,
): number | null {
    const {
        action,
        queueLength,
        currentIndex,
        isShuffle,
        shuffleIndices,
        repeatMode,
    } = input;
    if (queueLength === 0) return null;

    if (action === "next") {
        if (isShuffle) {
            const currentShufflePos = shuffleIndices.indexOf(currentIndex);
            if (currentShufflePos < 0) return null;
            if (currentShufflePos < shuffleIndices.length - 1) {
                return shuffleIndices[currentShufflePos + 1];
            }
            if (repeatMode === "all") {
                return shuffleIndices[0] ?? null;
            }
            return null;
        }

        if (currentIndex < queueLength - 1) {
            return currentIndex + 1;
        }
        if (repeatMode === "all") {
            return 0;
        }
        return null;
    }

    if (isShuffle) {
        const currentShufflePos = shuffleIndices.indexOf(currentIndex);
        if (currentShufflePos > 0) {
            return shuffleIndices[currentShufflePos - 1];
        }
        return null;
    }

    if (currentIndex > 0) {
        return currentIndex - 1;
    }
    return null;
}

export interface ResolveActiveListenTogetherSessionInput {
    hasActiveGroup: boolean;
    activeGroupId: string | null;
    snapshot: ListenTogetherSessionSnapshot | null;
    nowMs?: number;
}

export function resolveActiveListenTogetherSession(
    input: ResolveActiveListenTogetherSessionInput,
): ListenTogetherSessionSnapshot | null {
    if (!input.hasActiveGroup) return null;
    if (!input.activeGroupId) {
        return null;
    }
    if (!input.snapshot || input.snapshot.groupId !== input.activeGroupId) {
        return null;
    }
    return input.snapshot;
}

export interface GenerateSeparatedShuffleIndicesInput {
    length: number;
    currentIdx: number;
    queue: Array<Track | null | undefined>;
    random?: () => number;
}

export function generateSeparatedShuffleIndices(
    input: GenerateSeparatedShuffleIndicesInput,
): number[] {
    const { length, currentIdx, queue, random = Math.random } = input;
    const indices = Array.from({ length }, (_, i) => i).filter(
        (i) => i !== currentIdx,
    );
    for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const separated = separateArtists(indices, (idx) => {
        const t = queue[idx];
        return t?.artist?.id ?? t?.artist?.name ?? `unknown:${idx}`;
    });
    return [currentIdx, ...separated];
}

interface AudioControlsContextType {
    // Track methods
    playTrack: (track: Track) => void;
    playTracks: (tracks: Track[], startIndex?: number, isVibeQueue?: boolean) => void;

    // Audiobook methods
    playAudiobook: (audiobook: Audiobook) => void;

    // Podcast methods
    playPodcast: (podcast: Podcast) => void;
    nextPodcastEpisode: () => void;

    // Playback controls
    pause: (options?: { suppressListenTogetherBroadcast?: boolean }) => void;
    resume: (options?: {
        suppressListenTogetherBroadcast?: boolean;
        listenTogetherForceIsPlaying?: boolean;
        listenTogetherPositionMs?: number;
        listenTogetherServerTimeMs?: number;
    }) => void;
    play: () => void;
    next: () => void;
    previous: () => void;

    // Queue controls
    playNow: (track: Track) => void;
    playNext: (track: Track) => void;
    addToQueue: (track: Track, options?: { silent?: boolean }) => void;
    addTracksToQueue: (tracks: Track[], options?: { silent?: boolean }) => void;
    removeFromQueue: (index: number) => void;
    clearQueue: () => void;
    setUpcoming: (tracks: Track[], preserveOrder?: boolean) => void; // Replace queue after current track

    // Playback modes
    toggleShuffle: () => void;
    toggleRepeat: () => void;

    // Time controls
    updateCurrentTime: (time: number) => void;
    seek: (
        time: number,
        options?: {
            allowListenTogetherFollower?: boolean;
            suppressListenTogetherBroadcast?: boolean;
        }
    ) => void;
    skipForward: (seconds?: number) => void;
    skipBackward: (seconds?: number) => void;

    // Player mode controls
    setPlayerMode: (mode: PlayerMode) => void;
    returnToPreviousMode: () => void;

    // Volume controls
    setVolume: (volume: number) => void;
    toggleMute: () => void;

    // Vibe mode controls
    startVibeMode: () => Promise<{ success: boolean; trackCount: number }>;
    stopVibeMode: () => void;
}

const AudioControlsContext = createContext<
    AudioControlsContextType | undefined
>(undefined);

export function AudioControlsProvider({ children }: { children: ReactNode }) {
    const state = useAudioState();
    const playback = useAudioPlayback();
    const playbackRef = useRef(playback);
    const upNextInsertRef = useRef<number>(0);
    const shuffleInsertPosRef = useRef<number>(0);
    const lastQueueInsertAtRef = useRef<number | null>(null);
    const lastCursorTrackIndexRef = useRef<number | null>(null);
    const lastCursorIsShuffleRef = useRef<boolean | null>(null);

    const queueRef = useRef(state.queue);

    useEffect(() => {
        queueRef.current = state.queue;
    }, [state.queue]);

    // Ref to track repeat-one timeout for cleanup
    const repeatTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Cleanup timeout on unmount
    useEffect(() => {
        queueDebugLog("AudioControlsProvider mounted");
        return () => {
            if (repeatTimeoutRef.current) {
                clearTimeout(repeatTimeoutRef.current);
            }
            queueDebugLog("AudioControlsProvider unmounted");
        };
    }, []);

    useEffect(() => {
        playbackRef.current = playback;
    }, [playback]);

    // Keep a stable "Up Next" insertion cursor like Spotify:
    // - When the current track changes, reset to "right after current"
    // - Each addToQueue inserts at the cursor and advances it
    useEffect(() => {
        if (state.playbackType !== "track") {
            upNextInsertRef.current = 0;
            shuffleInsertPosRef.current = 0;
            lastCursorTrackIndexRef.current = null;
            lastCursorIsShuffleRef.current = null;
            return;
        }
        const prevIdx = lastCursorTrackIndexRef.current;
        const prevShuffle = lastCursorIsShuffleRef.current;
        const trackChanged = prevIdx !== state.currentIndex;
        const shuffleToggled = prevShuffle !== state.isShuffle;

        // Up-next cursor should never move backwards unless track changes / shuffle toggles
        const baseUpNext = state.currentIndex + 1;
        upNextInsertRef.current =
            trackChanged || shuffleToggled
                ? baseUpNext
                : Math.max(upNextInsertRef.current, baseUpNext);

        if (state.isShuffle) {
            const currentShufflePos = state.shuffleIndices.indexOf(
                state.currentIndex
            );
            const baseShufflePos =
                currentShufflePos >= 0 ? currentShufflePos + 1 : 0;
            // Do NOT reset to base on every shuffleIndices update; only move forward.
            shuffleInsertPosRef.current =
                trackChanged || shuffleToggled
                    ? baseShufflePos
                    : Math.max(shuffleInsertPosRef.current, baseShufflePos);
        } else {
            shuffleInsertPosRef.current = 0;
        }

        lastCursorTrackIndexRef.current = state.currentIndex;
        lastCursorIsShuffleRef.current = state.isShuffle;
        queueDebugLog("Cursor updated", {
            currentIndex: state.currentIndex,
            isShuffle: state.isShuffle,
            upNextCursor: upNextInsertRef.current,
            shuffleCursor: shuffleInsertPosRef.current,
            shuffleIndicesLen: state.shuffleIndices?.length || 0,
            queueLen: state.queue?.length || 0,
        });
    }, [
        state.currentIndex,
        state.playbackType,
        state.isShuffle,
        state.shuffleIndices,
        state.queue.length,
    ]);

    // Generate shuffled indices with artist separation
    const generateShuffleIndices = useCallback(
        (length: number, currentIdx: number) => {
            return generateSeparatedShuffleIndices({
                length,
                currentIdx,
                queue: queueRef.current,
            });
        },
        []
    );

    const getActiveListenTogetherSession = useCallback(() => {
        return resolveActiveListenTogetherSession({
            hasActiveGroup: listenTogetherSocket.hasActiveGroup,
            activeGroupId: listenTogetherSocket.activeGroupId,
            snapshot: getListenTogetherSessionSnapshot(),
        });
    }, []);

    const emitListenTogetherHostTrackOperation = useCallback(
        (action: QueueNavigationAction): void => {
            enqueueLatestListenTogetherHostTrackOperation({ action });
        },
        [],
    );

    const applyOptimisticListenTogetherTrackSelection = useCallback(
        (targetIndex: number): void => {
            const playbackState = playbackRef.current;
            const targetTrack = state.queue[targetIndex];
            if (!targetTrack) return;
            const optimisticSelectionPolicy =
                getListenTogetherOptimisticTrackSelectionPolicy();
            if (
                targetTrack.id &&
                optimisticSelectionPolicy.resetPersistedTrackStartPosition
            ) {
                resetPersistedTrackStartPosition(targetTrack.id);
            }

            // Stop the current audible source immediately while the host emit
            // is still in-flight so stale audio cannot leak through, then
            // re-assert playing so the load effect auto-plays the new track.
            // Without the restore, both lastPlayingStateRef and
            // wasEnginePlayingBeforeLoad are false when the load effect
            // captures them, leaving the player paused after the track loads.
            playbackState.setIsPlaying(false);
            state.setRepeatOneCount(0);
            state.setCurrentIndex(targetIndex);
            state.setCurrentTrack(targetTrack);
            playbackState.setCurrentTime(0);
            playbackState.setIsPlaying(true);
        },
        [state],
    );

    const playTrack = useCallback(
        (track: Track) => {
            const playbackState = playbackRef.current;
            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                if (!isListenTogetherLocalTrack(track)) {
                    toast.error("Listen Together only supports local library tracks");
                    return;
                }

                void listenTogetherSocket
                    .addToQueue([track.id])
                    .then(() => toast.success(`Added "${track.title}" to group queue`))
                    .catch((err) => {
                        toast.error(err?.message || "Failed to add track to Listen Together queue");
                    });
                return;
            }

            // If vibe mode is on and this track isn't in the vibe queue, disable vibe mode
            if (state.vibeMode && !state.vibeQueueIds.includes(track.id)) {
                state.setVibeMode(false);
                state.setVibeSourceFeatures(null);
                state.setVibeQueueIds([]);
            }

            resetPersistedTrackStartPosition(track.id);
            state.setPlaybackType("track");
            state.setCurrentTrack(track);
            state.setCurrentAudiobook(null);
            state.setCurrentPodcast(null);
            state.setPodcastEpisodeQueue(null); // Clear podcast queue when playing tracks
            state.setQueue([track]);
            state.setCurrentIndex(0);
            playbackState.setIsPlaying(true);
            playbackState.setCurrentTime(0);
            state.setShuffleIndices([0]);
            state.setRepeatOneCount(0);
        },
        [state, getActiveListenTogetherSession]
    );

    const playTracks = useCallback(
        (tracks: Track[], startIndex = 0, isVibeQueue = false) => {
            const playbackState = playbackRef.current;
            if (tracks.length === 0) {
                return;
            }

            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                const safeStartIndex = Math.min(Math.max(startIndex, 0), tracks.length - 1);
                const selectedSlice = tracks.slice(safeStartIndex);
                const eligibleTracks = selectedSlice.filter(isListenTogetherLocalTrack);
                const rejectedCount = selectedSlice.length - eligibleTracks.length;

                if (eligibleTracks.length === 0) {
                    toast.error("No local library tracks to add to Listen Together queue");
                    return;
                }

                if (rejectedCount > 0) {
                    toast.error("Some tracks were skipped: only local library tracks can be queued in Listen Together");
                }

                const trackIds = eligibleTracks.map((track) => track.id);
                void listenTogetherSocket
                    .addToQueue(trackIds)
                    .then(() => {
                        const count = trackIds.length;
                        toast.success(
                            count === 1
                                ? `Added "${eligibleTracks[0].title}" to group queue`
                                : `Added ${count} tracks to group queue`
                        );
                    })
                    .catch((err) => {
                        toast.error(err?.message || "Failed to add tracks to Listen Together queue");
                    });
                return;
            }

            queueDebugLog("playTracks()", {
                tracksLen: tracks.length,
                startIndex,
                firstTrackId: tracks[0]?.id,
                startTrackId: tracks[startIndex]?.id,
                isVibeQueue,
            });

            const normalizedStartIndex = Math.min(
                Math.max(startIndex, 0),
                tracks.length - 1
            );
            const startTrack = tracks[normalizedStartIndex];
            if (!startTrack?.id) {
                return;
            }

            // If not a vibe queue and vibe mode is on, disable it
            if (!isVibeQueue && state.vibeMode) {
                state.setVibeMode(false);
                state.setVibeSourceFeatures(null);
                state.setVibeQueueIds([]);
            }

            resetPersistedTrackStartPosition(startTrack.id);
            state.setPlaybackType("track");
            state.setCurrentAudiobook(null);
            state.setCurrentPodcast(null);
            state.setPodcastEpisodeQueue(null); // Clear podcast queue when playing tracks
            state.setQueue(tracks);
            state.setCurrentIndex(normalizedStartIndex);
            state.setCurrentTrack(startTrack);
            playbackState.setIsPlaying(true);
            playbackState.setCurrentTime(0);
            state.setRepeatOneCount(0);
            state.setShuffleIndices(
                generateShuffleIndices(tracks.length, normalizedStartIndex)
            );
        },
        [state, generateShuffleIndices, getActiveListenTogetherSession]
    );

    const playAudiobook = useCallback(
        (audiobook: Audiobook) => {
            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                toast.error("Audiobooks are not supported in Listen Together");
                return;
            }

            const playbackState = playbackRef.current;
            state.setPlaybackType("audiobook");
            state.setCurrentAudiobook(audiobook);
            state.setCurrentTrack(null);
            state.setCurrentPodcast(null);
            state.setPodcastEpisodeQueue(null); // Clear podcast queue when playing audiobooks
            state.setQueue([]);
            state.setCurrentIndex(0);
            playbackState.setIsPlaying(true);
            state.setShuffleIndices([]);

            if (audiobook.progress?.currentTime) {
                playbackState.setCurrentTime(audiobook.progress.currentTime);
            } else {
                playbackState.setCurrentTime(0);
            }
        },
        [state, getActiveListenTogetherSession]
    );

    const playPodcast = useCallback(
        (podcast: Podcast) => {
            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                toast.error("Podcasts are not supported in Listen Together");
                return;
            }

            const playbackState = playbackRef.current;
            state.setPlaybackType("podcast");
            state.setCurrentPodcast(podcast);
            state.setCurrentTrack(null);
            state.setCurrentAudiobook(null);
            state.setQueue([]);
            state.setCurrentIndex(0);
            playbackState.setIsPlaying(true);
            state.setShuffleIndices([]);

            if (podcast.progress?.currentTime) {
                playbackState.setCurrentTime(podcast.progress.currentTime);
            } else {
                playbackState.setCurrentTime(0);
            }
        },
        [state, getActiveListenTogetherSession]
    );

    const pause = useCallback((options?: { suppressListenTogetherBroadcast?: boolean }) => {
        const playbackState = playbackRef.current;
        const ltSession = getActiveListenTogetherSession();
        playbackState.setIsPlaying(false);
        if (ltSession?.isHost && !options?.suppressListenTogetherBroadcast) {
            listenTogetherSocket.pause().catch(() => {});
        }
    }, [getActiveListenTogetherSession]);

    const nextPodcastEpisode = useCallback(() => {
        if (!state.podcastEpisodeQueue || state.podcastEpisodeQueue.length === 0) {
            pause();
            return;
        }

        if (!state.currentPodcast) {
            pause();
            return;
        }

        // Extract episodeId from currentPodcast.id (format: "podcastId:episodeId")
        const [podcastId, currentEpisodeId] = state.currentPodcast.id.split(":");
        
        // Find current episode index
        const currentIndex = state.podcastEpisodeQueue.findIndex(
            (ep) => ep.id === currentEpisodeId
        );

        // If there's a next episode, play it
        if (currentIndex >= 0 && currentIndex < state.podcastEpisodeQueue.length - 1) {
            const nextEpisode = state.podcastEpisodeQueue[currentIndex + 1];
            // Build the podcast object for playback
            playPodcast({
                id: `${podcastId}:${nextEpisode.id}`,
                title: nextEpisode.title,
                podcastTitle: state.currentPodcast.podcastTitle,
                coverUrl: state.currentPodcast.coverUrl,
                duration: nextEpisode.duration,
                progress: nextEpisode.progress || null,
            });
        } else {
            // Last episode, pause and clear queue
            pause();
            state.setPodcastEpisodeQueue(null);
        }
    }, [state, playPodcast, pause]);

    const resume = useCallback((options?: {
        suppressListenTogetherBroadcast?: boolean;
        listenTogetherForceIsPlaying?: boolean;
        listenTogetherPositionMs?: number;
        listenTogetherServerTimeMs?: number;
    }) => {
        const playbackState = playbackRef.current;
        const ltSession = getActiveListenTogetherSession();
        if (ltSession) {
            if (ltSession.isHost) {
                playbackState.setIsPlaying(true);
                if (!options?.suppressListenTogetherBroadcast) {
                    listenTogetherSocket.play().catch(() => {});
                }
                return;
            }

            const syncIsPlaying =
                options?.listenTogetherForceIsPlaying ??
                ltSession.playback.isPlaying;
            const syncPositionMs =
                options?.listenTogetherPositionMs ??
                ltSession.playback.positionMs;
            const syncServerTimeMs =
                options?.listenTogetherServerTimeMs ??
                ltSession.playback.serverTime;

            const elapsedMs = syncIsPlaying
                ? Math.max(0, Date.now() - syncServerTimeMs)
                : 0;
            const targetSec = (syncPositionMs + elapsedMs) / 1000;
            const mediaDuration =
                state.playbackType === "podcast"
                    ? state.currentPodcast?.duration || 0
                    : state.playbackType === "audiobook"
                    ? state.currentAudiobook?.duration || 0
                    : state.currentTrack?.duration || 0;
            const clampedTarget = clampPlaybackTimeToUpperBound(
                targetSec,
                mediaDuration
            );

            playbackState.lockSeek(clampedTarget);
            playbackState.setCurrentTime(clampedTarget);
            audioSeekEmitter.emit(clampedTarget);
            playbackState.setIsPlaying(syncIsPlaying);
            return;
        }

        playbackState.setIsPlaying(true);
    }, [state, getActiveListenTogetherSession]);

    const play = useCallback(() => {
        resume();
    }, [resume]);

    const next = useCallback(() => {
        const playbackState = playbackRef.current;
        const ltSession = getActiveListenTogetherSession();
        if (ltSession) {
            if (!ltSession.isHost) return;
            const nextIndex = resolveListenTogetherNavigationIndex({
                action: "next",
                queueLength:
                    state.queue.length > 0 ? state.queue.length : 0,
                currentIndex: state.currentIndex,
                currentPositionMs: Math.max(
                    0,
                    playbackState.currentTime * 1000,
                ),
            });
            if (nextIndex === null) return;

            emitListenTogetherHostTrackOperation("next");
            applyOptimisticListenTogetherTrackSelection(nextIndex);
            return;
        }

        if (state.queue.length === 0) return;

        // Handle repeat one
        if (state.repeatMode === "one" && state.repeatOneCount === 0) {
            state.setRepeatOneCount(1);
            playbackState.setCurrentTime(0);
            playbackState.setIsPlaying(false);
            // Clear any existing timeout before setting a new one
            if (repeatTimeoutRef.current) {
                clearTimeout(repeatTimeoutRef.current);
            }
            // Short delay for audio element state synchronization
            repeatTimeoutRef.current = setTimeout(
                () => playbackRef.current.setIsPlaying(true),
                10
            );
            return;
        }

        state.setRepeatOneCount(0);

        if (state.isShuffle) {
            const currentShufflePos =
                state.shuffleIndices.indexOf(state.currentIndex);
            queueDebugLog("next() shuffle", {
                currentIndex: state.currentIndex,
                currentShufflePos,
                shuffleIndicesLen: state.shuffleIndices.length,
            });
        }
        const nextIndex = resolveQueueNavigationIndex({
            action: "next",
            queueLength: state.queue.length,
            currentIndex: state.currentIndex,
            isShuffle: state.isShuffle,
            shuffleIndices: state.shuffleIndices,
            repeatMode: state.repeatMode,
        });
        if (nextIndex === null) {
            return;
        }

        queueDebugLog("next() chosen", {
            isShuffle: state.isShuffle,
            nextIndex,
            nextTrackId: state.queue[nextIndex]?.id,
            queueLen: state.queue.length,
        });
        const nextTrack = state.queue[nextIndex];
        if (nextTrack?.id) {
            resetPersistedTrackStartPosition(nextTrack.id);
        }
        state.setCurrentIndex(nextIndex);
        state.setCurrentTrack(nextTrack);
        playbackState.setCurrentTime(0);
        playbackState.setIsPlaying(true);
    }, [
        state,
        getActiveListenTogetherSession,
        emitListenTogetherHostTrackOperation,
        applyOptimisticListenTogetherTrackSelection,
    ]);

    const previous = useCallback(() => {
        const playbackState = playbackRef.current;
        const ltSession = getActiveListenTogetherSession();
        if (ltSession) {
            if (!ltSession.isHost) return;
            const prevIndex = resolveListenTogetherNavigationIndex({
                action: "previous",
                queueLength:
                    state.queue.length > 0 ? state.queue.length : 0,
                currentIndex: state.currentIndex,
                currentPositionMs: Math.max(
                    0,
                    playbackState.currentTime * 1000,
                ),
            });
            if (prevIndex === null) return;

            emitListenTogetherHostTrackOperation("previous");
            applyOptimisticListenTogetherTrackSelection(prevIndex);
            return;
        }

        if (state.queue.length === 0) return;

        state.setRepeatOneCount(0);

        const prevIndex = resolveQueueNavigationIndex({
            action: "previous",
            queueLength: state.queue.length,
            currentIndex: state.currentIndex,
            isShuffle: state.isShuffle,
            shuffleIndices: state.shuffleIndices,
            repeatMode: state.repeatMode,
        });
        if (prevIndex === null) {
            return;
        }

        const prevTrack = state.queue[prevIndex];
        if (prevTrack?.id) {
            resetPersistedTrackStartPosition(prevTrack.id);
        }
        state.setCurrentIndex(prevIndex);
        state.setCurrentTrack(prevTrack);
        playbackState.setCurrentTime(0);
        playbackState.setIsPlaying(true);
    }, [
        state,
        getActiveListenTogetherSession,
        emitListenTogetherHostTrackOperation,
        applyOptimisticListenTogetherTrackSelection,
    ]);

    const addTracksToQueue = useCallback(
        (tracks: Track[], options?: { silent?: boolean }) => {
            const playbackState = playbackRef.current;
            const shouldToastSuccess = !options?.silent;
            const validTracks = tracks.filter((track) => Boolean(track?.id));
            if (validTracks.length === 0) {
                return;
            }

            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                const eligibleTracks = validTracks.filter(isListenTogetherLocalTrack);
                const rejectedCount = validTracks.length - eligibleTracks.length;

                if (eligibleTracks.length === 0) {
                    toast.error("Listen Together only supports local library tracks");
                    return;
                }
                if (rejectedCount > 0) {
                    toast.error("Some tracks were skipped: only local library tracks can be queued in Listen Together");
                }

                const trackIds = eligibleTracks.map((track) => track.id);
                listenTogetherSocket
                    .addToQueue(trackIds)
                    .then(() => {
                        if (!shouldToastSuccess) return;
                        if (eligibleTracks.length === 1) {
                            toast.success(`Added "${eligibleTracks[0].title}" to group queue`);
                        } else {
                            toast.success(`Added ${eligibleTracks.length} tracks to group queue`);
                        }
                    })
                    .catch((err) => {
                        toast.error(err?.message || "Failed to add track to Listen Together queue");
                    });
                return;
            }

            queueDebugLog("addTracksToQueue() entry", {
                count: validTracks.length,
                firstTrackId: validTracks[0]?.id,
                queueLen: state.queue.length,
                currentIndex: state.currentIndex,
                playbackType: state.playbackType,
                isShuffle: state.isShuffle,
                upNextCursor: upNextInsertRef.current,
                shuffleCursor: shuffleInsertPosRef.current,
            });

            // If no tracks are playing (empty queue or non-track playback), start fresh
            if (state.queue.length === 0 || state.playbackType !== "track") {
                resetPersistedTrackStartPosition(validTracks[0].id);
                state.setPlaybackType("track");
                state.setQueue(validTracks);
                state.setCurrentIndex(0);
                state.setCurrentTrack(validTracks[0]);
                state.setCurrentAudiobook(null);
                state.setCurrentPodcast(null);
                playbackState.setIsPlaying(true);
                playbackState.setCurrentTime(0);
                state.setRepeatOneCount(0);
                state.setShuffleIndices(
                    generateShuffleIndices(validTracks.length, 0)
                );
                queueDebugLog("addTracksToQueue() started fresh queue", {
                    count: validTracks.length,
                    firstTrackId: validTracks[0]?.id,
                });

                if (shouldToastSuccess) {
                    if (validTracks.length === 1) {
                        toast.success(`Added "${validTracks[0].title}" to queue`);
                    } else {
                        toast.success(`Added ${validTracks.length} tracks to queue`);
                    }
                }
                return;
            }

            // "Add to queue" appends to the END of the queue (after all existing tracks).
            // "Play Next" (separate action) inserts immediately after the current track.
            const insertCount = validTracks.length;

            state.setQueue((prevQueue) => {
                const insertAt = prevQueue.length;
                const newQueue = [...prevQueue, ...validTracks];
                lastQueueInsertAtRef.current = insertAt + insertCount - 1;
                queueDebugLog("addTracksToQueue() appended to end", {
                    insertAt,
                    insertCount,
                    prevLen: prevQueue.length,
                    newLen: newQueue.length,
                    insertedTrackIds: validTracks.map((t) => t.id),
                });

                return newQueue;
            });

            // Update shuffle indices if shuffle is on — append new indices at end of shuffle order
            if (state.isShuffle) {
                state.setShuffleIndices((prevIndices) => {
                    if (prevIndices.length === 0) return prevIndices;

                    const queueLen = state.queue.length; // length before append
                    const insertedIndices = Array.from(
                        { length: insertCount },
                        (_, offset) => queueLen + offset
                    );
                    const newIndices = [...prevIndices, ...insertedIndices];
                    queueDebugLog("addTracksToQueue() shuffleIndices appended", {
                        insertCount,
                        prevIndicesLen: prevIndices.length,
                        newIndicesLen: newIndices.length,
                        insertedIndices,
                    });

                    return newIndices;
                });
            }

            if (shouldToastSuccess) {
                if (validTracks.length === 1) {
                    toast.success(`Added "${validTracks[0].title}" to queue`);
                } else {
                    toast.success(`Added ${validTracks.length} tracks to queue`);
                }
            }
        },
        [state, generateShuffleIndices, getActiveListenTogetherSession]
    );

    const addToQueue = useCallback(
        (track: Track, options?: { silent?: boolean }) => {
            addTracksToQueue([track], options);
        },
        [addTracksToQueue]
    );

    const playNext = useCallback(
        (track: Track) => {
            if (!track?.id) return;
            const playbackState = playbackRef.current;

            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                if (!isListenTogetherLocalTrack(track)) {
                    toast.error("Listen Together only supports local library tracks");
                    return;
                }
                void listenTogetherSocket
                    .insertNext([track.id])
                    .then(() => toast.success(`Playing "${track.title}" next in group queue`))
                    .catch((err) => {
                        toast.error(err?.message || "Failed to add track to Listen Together queue");
                    });
                return;
            }

            // If nothing is playing, just start the track
            if (state.queue.length === 0 || state.playbackType !== "track") {
                resetPersistedTrackStartPosition(track.id);
                state.setPlaybackType("track");
                state.setQueue([track]);
                state.setCurrentIndex(0);
                state.setCurrentTrack(track);
                state.setCurrentAudiobook(null);
                state.setCurrentPodcast(null);
                playbackState.setIsPlaying(true);
                playbackState.setCurrentTime(0);
                state.setRepeatOneCount(0);
                state.setShuffleIndices(generateShuffleIndices(1, 0));
                toast.success(`Playing "${track.title}" next`);
                return;
            }

            // Insert immediately after the currently playing track (before any Up Next items)
            const insertAt = state.currentIndex + 1;

            state.setQueue((prevQueue) => {
                const newQueue = [...prevQueue];
                newQueue.splice(insertAt, 0, track);
                return newQueue;
            });

            // Bump the Up Next cursor to account for the newly inserted track
            upNextInsertRef.current = Math.max(upNextInsertRef.current, insertAt) + 1;

            // Update shuffle indices if shuffle is on
            if (state.isShuffle) {
                state.setShuffleIndices((prevIndices) => {
                    if (prevIndices.length === 0) return prevIndices;
                    // Shift all indices >= insertAt up by 1
                    const shifted = prevIndices.map((i) =>
                        i >= insertAt ? i + 1 : i
                    );
                    // Insert the new track index right after the current track in shuffle order
                    const currentShufflePos = shifted.indexOf(state.currentIndex);
                    const shuffleInsertPos = currentShufflePos >= 0 ? currentShufflePos + 1 : 0;
                    const newIndices = [...shifted];
                    newIndices.splice(shuffleInsertPos, 0, insertAt);
                    return newIndices;
                });
            }

            toast.success(`Playing "${track.title}" next`);
            queueDebugLog("playNext()", {
                trackId: track.id,
                insertAt,
                queueLen: state.queue.length + 1,
            });
        },
        [state, generateShuffleIndices, getActiveListenTogetherSession]
    );

    const playNow = useCallback(
        (track: Track) => {
            if (!track?.id) return;

            const playbackState = playbackRef.current;
            const ltSession = getActiveListenTogetherSession();

            // Listen Together: add only this single track to the shared queue
            if (ltSession) {
                if (!isListenTogetherLocalTrack(track)) {
                    toast.error("Listen Together only supports local library tracks");
                    return;
                }
                void listenTogetherSocket
                    .addToQueue([track.id])
                    .then(() => toast.success(`Added "${track.title}" to group queue`))
                    .catch((err) => {
                        toast.error(err?.message || "Failed to add track to Listen Together queue");
                    });
                return;
            }

            // If vibe mode is on and this track isn't in the vibe queue, disable vibe mode
            if (state.vibeMode && !state.vibeQueueIds.includes(track.id)) {
                state.setVibeMode(false);
                state.setVibeSourceFeatures(null);
                state.setVibeQueueIds([]);
            }

            // Empty queue or non-track playback: start fresh with just this track
            if (state.queue.length === 0 || state.playbackType !== "track") {
                resetPersistedTrackStartPosition(track.id);
                state.setPlaybackType("track");
                state.setCurrentTrack(track);
                state.setCurrentAudiobook(null);
                state.setCurrentPodcast(null);
                state.setPodcastEpisodeQueue(null);
                state.setQueue([track]);
                state.setCurrentIndex(0);
                playbackState.setIsPlaying(true);
                playbackState.setCurrentTime(0);
                state.setShuffleIndices([0]);
                state.setRepeatOneCount(0);
                return;
            }

            // Active queue: insert after current position and jump to it
            const { insertAt, newShuffleIndices: computedShuffleIndices } =
                computePlayNowInsertion({
                    queue: state.queue,
                    currentIndex: state.currentIndex,
                    isShuffle: state.isShuffle,
                    shuffleIndices: state.shuffleIndices,
                });

            const newQueue = [...state.queue];
            newQueue.splice(insertAt, 0, track);

            const newShuffleIndices =
                state.isShuffle && computedShuffleIndices.length > 0
                    ? computedShuffleIndices
                    : generateShuffleIndices(newQueue.length, insertAt);

            // Bump upNextInsertRef to account for the inserted track
            upNextInsertRef.current = Math.max(upNextInsertRef.current, insertAt) + 1;

            // Atomically commit all state together so React batches the update
            resetPersistedTrackStartPosition(track.id);
            state.setQueue(newQueue);
            state.setShuffleIndices(newShuffleIndices);
            state.setCurrentIndex(insertAt);
            state.setCurrentTrack(track);
            state.setRepeatOneCount(0);
            playbackState.setCurrentTime(0);
            playbackState.setIsPlaying(true);
        },
        [state, generateShuffleIndices, getActiveListenTogetherSession]
    );

    const removeFromQueue = useCallback(
        (index: number) => {
            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                listenTogetherSocket.removeFromQueue(index).catch(() => {});
                return;
            }

            state.setQueue((prev) => {
                const newQueue = [...prev];
                newQueue.splice(index, 1);

                if (index < state.currentIndex) {
                    state.setCurrentIndex((prevIndex) => prevIndex - 1);
                } else if (
                    index === state.currentIndex &&
                    index === newQueue.length
                ) {
                    state.setCurrentIndex(0);
                    if (newQueue.length > 0) {
                        state.setCurrentTrack(newQueue[0]);
                    } else {
                        state.setCurrentTrack(null);
                        playbackRef.current.setIsPlaying(false);
                    }
                }

                return newQueue;
            });

            // Update shuffle indices: remove the index and shift remaining
            if (state.isShuffle) {
                state.setShuffleIndices((prev) => {
                    return prev
                        .filter((i) => i !== index)
                        .map((i) => (i > index ? i - 1 : i));
                });
            }
        },
        [state, getActiveListenTogetherSession]
    );

    const clearQueue = useCallback(() => {
        const ltSession = getActiveListenTogetherSession();
        if (ltSession) {
            listenTogetherSocket.clearQueue().catch(() => {});
            return;
        }

        state.setQueue([]);
        state.setCurrentIndex(0);
        state.setCurrentTrack(null);
        state.setPlaybackType(null);
        playbackRef.current.setIsPlaying(false);
        state.setShuffleIndices([]);

        // Persist to server so the next playback-state poll sees an empty
        // queue and doesn't restore stale data.  Also stamp the local save
        // timestamp to activate the 25 s poll cooldown, and the cleared-at
        // timestamp so the poll ignores stale server state for 60 s.
        const now = Date.now().toString();
        writeMigratingStorageItem(LAST_PLAYBACK_STATE_SAVE_AT_KEY, now);
        writeMigratingStorageItem(QUEUE_CLEARED_AT_KEY, now);
        void api.clearPlaybackState().catch(() => undefined);
    }, [state, getActiveListenTogetherSession]);

    // Set upcoming tracks without interrupting current playback
    // preserveOrder=true will skip shuffle index generation (used for vibe mode)
    const setUpcoming = useCallback(
        (tracks: Track[], preserveOrder = false) => {
            const playbackState = playbackRef.current;
            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                // Avoid large synchronous queue mutations through global controls.
                // Listen Together queue should be edited through explicit queue actions.
                return;
            }

            if (!state.currentTrack || state.playbackType !== "track") {
                // No current track, just start playing the new tracks
                if (tracks.length > 0) {
                    if (!tracks[0]?.id) {
                        return;
                    }
                    resetPersistedTrackStartPosition(tracks[0].id);
                    state.setQueue(tracks);
                    state.setCurrentIndex(0);
                    state.setCurrentTrack(tracks[0]);
                    state.setPlaybackType("track");
                    playbackState.setIsPlaying(true);
                    playbackState.setCurrentTime(0);
                    // Don't generate shuffle indices if preserving order (vibe mode)
                    if (!preserveOrder && !state.vibeMode) {
                        state.setShuffleIndices(
                            generateShuffleIndices(tracks.length, 0)
                        );
                    } else {
                        state.setShuffleIndices([]);
                    }
                }
                return;
            }

            // Keep current track, replace everything after it
            state.setQueue((prev) => {
                const currentTrack = prev[state.currentIndex];
                if (!currentTrack) return tracks;

                // New queue: current track + new tracks
                return [currentTrack, ...tracks];
            });

            // Reset index to 0 (current track is now at index 0)
            state.setCurrentIndex(0);

            // Update shuffle indices for new queue
            // Skip if preserveOrder=true (vibe mode) or already in vibe mode
            if (state.isShuffle && !preserveOrder && !state.vibeMode) {
                state.setShuffleIndices(
                    generateShuffleIndices(tracks.length + 1, 0)
                );
            } else {
                // Clear shuffle indices for vibe mode or non-shuffle
                state.setShuffleIndices([]);
            }
        },
        [state, generateShuffleIndices, getActiveListenTogetherSession]
    );

    const toggleShuffle = useCallback(() => {
        const ltSession = getActiveListenTogetherSession();
        if (ltSession) return;

        // Don't allow shuffle to be enabled while in vibe mode
        // Vibe queue is sorted by match %, shuffle would break that order
        if (state.vibeMode) {
            return;
        }
        
        state.setIsShuffle((prev) => {
            const newShuffle = !prev;
            if (newShuffle && state.queue.length > 0) {
                state.setShuffleIndices(
                    generateShuffleIndices(
                        state.queue.length,
                        state.currentIndex
                    )
                );
            }
            return newShuffle;
        });
    }, [state, generateShuffleIndices, getActiveListenTogetherSession]);

    const toggleRepeat = useCallback(() => {
        const ltSession = getActiveListenTogetherSession();
        if (ltSession) return;

        state.setRepeatMode((prev) => {
            if (prev === "off") return "all";
            if (prev === "all") return "one";
            return "off";
        });
        state.setRepeatOneCount(0);
    }, [state, getActiveListenTogetherSession]);

    const updateCurrentTime = useCallback(
        (time: number) => {
            playbackRef.current.setCurrentTime(time);
        },
        []
    );

    const seek = useCallback(
        (
            time: number,
            options?: {
                allowListenTogetherFollower?: boolean;
                suppressListenTogetherBroadcast?: boolean;
            }
        ) => {
            const playbackState = playbackRef.current;
            const ltSession = getActiveListenTogetherSession();
            if (ltSession && !ltSession.isHost && !options?.allowListenTogetherFollower) {
                return;
            }

            // Prefer canonical durations for long-form media. If both exist, take the safer minimum.
            const mediaDuration =
                state.playbackType === "podcast"
                    ? state.currentPodcast?.duration || 0
                    : state.playbackType === "audiobook"
                    ? state.currentAudiobook?.duration || 0
                    : state.currentTrack?.duration || 0;
            const maxDuration = resolvePlaybackTimeUpperBound(
                mediaDuration,
                playbackState.duration
            );
            const clampedTime = clampPlaybackTimeToUpperBound(
                time,
                maxDuration
            );

            // Lock seek to prevent stale timeupdate events from overwriting optimistic update
            // This is especially important for podcasts where seeking may require audio reload
            playbackState.lockSeek(clampedTime);

            // Optimistically update local playback time for instant UI feedback
            playbackState.setCurrentTime(clampedTime);

            // Keep audiobook/podcast progress in sync locally so detail pages reflect scrubs
            if (state.playbackType === "audiobook" && state.currentAudiobook) {
                // IMPORTANT: use functional update to avoid stale-closure overwrites
                // (seeking must never be able to swap the currently-playing audiobook)
                state.setCurrentAudiobook((prev) => {
                    if (!prev) return prev;
                    const duration = prev.duration || 0;
                    const progressPercent =
                        duration > 0 ? (clampedTime / duration) * 100 : 0;
                    return {
                        ...prev,
                        progress: {
                            currentTime: clampedTime,
                            progress: progressPercent,
                            isFinished: false,
                            lastPlayedAt: new Date(),
                        },
                    };
                });
            } else if (
                state.playbackType === "podcast" &&
                state.currentPodcast
            ) {
                // IMPORTANT: use functional update to avoid stale-closure overwrites
                // (seeking must never be able to swap the currently-playing episode)
                state.setCurrentPodcast((prev) => {
                    if (!prev) return prev;
                    const duration = prev.duration || 0;
                    const progressPercent =
                        duration > 0 ? (clampedTime / duration) * 100 : 0;
                    return {
                        ...prev,
                        progress: {
                            currentTime: clampedTime,
                            progress: progressPercent,
                            isFinished: false,
                            lastPlayedAt: new Date(),
                        },
                    };
                });
            }

            audioSeekEmitter.emit(clampedTime);

            if (ltSession?.isHost && !options?.suppressListenTogetherBroadcast) {
                listenTogetherSocket.seek(clampedTime * 1000).catch(() => {});
            }
        },
        [state, getActiveListenTogetherSession]
    );

    const skipForward = useCallback(
        (seconds: number = 30) => {
            seek(playbackRef.current.currentTime + seconds);
        },
        [seek]
    );

    const skipBackward = useCallback(
        (seconds: number = 30) => {
            seek(playbackRef.current.currentTime - seconds);
        },
        [seek]
    );

    const setPlayerModeWithHistory = useCallback(
        (mode: PlayerMode) => {
            state.setPreviousPlayerMode(state.playerMode);
            state.setPlayerMode(mode);
        },
        [state]
    );

    const returnToPreviousMode = useCallback(() => {
        // Closing overlay should restore the platform-appropriate compact mode.
        // Mobile/tablet => mini, desktop => full.
        const deviceDefaultMode: PlayerMode =
            typeof window !== "undefined" &&
            window.matchMedia("(max-width: 1024px)").matches
                ? "mini"
                : "full";
        const targetMode =
            state.playerMode === "overlay"
                ? deviceDefaultMode
                : state.previousPlayerMode;
        const temp = state.playerMode;
        state.setPlayerMode(targetMode);
        state.setPreviousPlayerMode(temp);
    }, [state]);

    const setVolumeControl = useCallback(
        (newVolume: number) => {
            const clampedVolume = clampAudioVolume(newVolume);
            state.setVolume(clampedVolume);
            if (clampedVolume > 0) {
                state.setIsMuted(false);
            }
        },
        [state]
    );

    const toggleMute = useCallback(() => {
        state.setIsMuted((prev) => !prev);
    }, [state]);

    // Vibe mode controls - uses CLAP similarity API
    const startVibeMode = useCallback(async (): Promise<{
        success: boolean;
        trackCount: number;
    }> => {
        const currentTrack = state.currentTrack;
        if (!currentTrack?.id) {
            return { success: false, trackCount: 0 };
        }

        try {
            const response = await api.getVibeSimilarTracks(currentTrack.id, 50);

            if (!response.tracks || response.tracks.length === 0) {
                return { success: false, trackCount: 0 };
            }

            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                const queueIds = [currentTrack.id, ...response.tracks.map((t) => t.id)];
                const uniqueQueueIds = Array.from(new Set(queueIds));

                if (uniqueQueueIds.length === 0) {
                    return { success: false, trackCount: 0 };
                }

                if (typeof window !== "undefined") {
                    const trackLabel =
                        uniqueQueueIds.length === 1
                            ? "1 song"
                            : `${uniqueQueueIds.length} songs`;
                    const confirmed = window.confirm(
                        `You're in a Listen Together group. Match Vibe will add ${trackLabel} to the shared queue. Continue?`
                    );
                    if (!confirmed) {
                        toast.info("Match Vibe cancelled");
                        return { success: false, trackCount: 0 };
                    }
                }

                await listenTogetherSocket.addToQueue(uniqueQueueIds);
                toast.success(
                    uniqueQueueIds.length === 1
                        ? "Added 1 track to group queue"
                        : `Added ${uniqueQueueIds.length} tracks to group queue`
                );
                return { success: true, trackCount: uniqueQueueIds.length };
            }

            // Disable shuffle when vibe mode starts - vibe queue is sorted by similarity
            state.setIsShuffle(false);
            state.setShuffleIndices([]);

            // Build queue IDs including current track
            const queueIds = [
                currentTrack.id,
                ...response.tracks.map((t) => t.id),
            ];

            // Map API response to Track format for the queue (with audio features for vibe badge)
            const vibeTracks: Track[] = response.tracks.map((t) => ({
                id: t.id,
                title: t.title,
                duration: t.duration,
                artist: { name: t.artist.name, id: t.artist.id },
                album: {
                    title: t.album.title,
                    coverArt: t.album.coverUrl || undefined,
                    id: t.album.id,
                },
                audioFeatures: t.audioFeatures,
            }));

            // Set vibe mode state — use source features from the API response
            state.setVibeMode(true);
            state.setVibeSourceFeatures(response.sourceFeatures || currentTrack.audioFeatures || null);
            state.setVibeQueueIds(queueIds);

            // Build new queue: current track (with source features) + similar tracks
            state.setQueue((prev) => {
                const current = prev[state.currentIndex];
                const base = current || currentTrack;
                const enriched = response.sourceFeatures
                    ? { ...base, audioFeatures: { ...base.audioFeatures, ...response.sourceFeatures } }
                    : base;
                return [enriched, ...vibeTracks];
            });

            // Reset index to 0 (current track is now at index 0)
            state.setCurrentIndex(0);

            return { success: true, trackCount: response.tracks.length };
        } catch (error) {
            sharedFrontendLogger.error("[Vibe] Failed to get similar tracks:", error);
            if (error instanceof Error) {
                toast.error(error.message);
            }
            return { success: false, trackCount: 0 };
        }
    }, [state, getActiveListenTogetherSession]);

    const stopVibeMode = useCallback(() => {
        state.setVibeMode(false);
        state.setVibeSourceFeatures(null);
        state.setVibeQueueIds([]);
    }, [state]);

    // Memoize the entire context value
    const value = useMemo(
        () => ({
            playTrack,
            playTracks,
            playAudiobook,
            playPodcast,
            nextPodcastEpisode,
            pause,
            resume,
            play,
            next,
            previous,
            playNow,
            playNext,
            addToQueue,
            addTracksToQueue,
            removeFromQueue,
            clearQueue,
            setUpcoming,
            toggleShuffle,
            toggleRepeat,
            updateCurrentTime,
            seek,
            skipForward,
            skipBackward,
            setPlayerMode: setPlayerModeWithHistory,
            returnToPreviousMode,
            setVolume: setVolumeControl,
            toggleMute,
            startVibeMode,
            stopVibeMode,
        }),
        [
            playTrack,
            playTracks,
            playAudiobook,
            playPodcast,
            nextPodcastEpisode,
            pause,
            resume,
            play,
            next,
            previous,
            playNow,
            playNext,
            addToQueue,
            addTracksToQueue,
            removeFromQueue,
            clearQueue,
            setUpcoming,
            toggleShuffle,
            toggleRepeat,
            updateCurrentTime,
            seek,
            skipForward,
            skipBackward,
            setPlayerModeWithHistory,
            returnToPreviousMode,
            setVolumeControl,
            toggleMute,
            startVibeMode,
            stopVibeMode,
        ]
    );

    return (
        <AudioControlsContext.Provider value={value}>
            {children}
        </AudioControlsContext.Provider>
    );
}

export function useAudioControls() {
    const context = useContext(AudioControlsContext);
    if (!context) {
        throw new Error(
            "useAudioControls must be used within AudioControlsProvider"
        );
    }
    return context;
}
