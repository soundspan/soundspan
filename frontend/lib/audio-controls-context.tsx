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
} from "./audio-state-context";
import type { AudioControlsContextType } from "./audio-controls-types";
import { usePlaybackStatus } from "./audio-playback-context";
import { buildPlaybackView, PlaybackClockBridge } from "./audio-playback-view";
import { useAudioVolumeMode } from "./audio-volume-mode-context";
import { useVolumeModeControls } from "./audio-volume-controls";
import { api } from "@/lib/api";
import { audioSeekEmitter } from "./audio-seek-emitter";
import {
    getServerClockOffsetMs,
    listenTogetherSocket,
    type QueueTrackInput,
} from "./listen-together-socket";
import {
    enqueueLatestListenTogetherHostTrackOperation,
    getListenTogetherOptimisticTrackSelectionPolicy,
    getListenTogetherSessionSnapshot,
    type ListenTogetherSessionSnapshot,
} from "./listen-together-session";
import { toast } from "sonner";
import {
    computePlayNowInsertion,
    computePodcastContextPlacement,
    moveItemInList,
    remapShuffleIndicesForMove,
} from "./queue-utils";
import {
    resolveEpisodeProgressSaveOnSwitch,
    resolveEpisodeStartPosition,
} from "./audio/episode-resume";
import { dispatchQueryEvent } from "./query-events";
import {
    buildEpisodeQueueItem,
    episodeQueueItemFromPodcast,
    isEpisodeQueueItem,
    type EpisodeQueueItem,
    type QueueItem,
} from "./queue-item";
import { resolveQueueAdvance } from "./audio/queue-advance-policy";
import type { Episode } from "@/features/podcast/types";
import { separateArtists } from "./separate-artists";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import {
    clampPlaybackTimeToUpperBound,
    resolvePlaybackTimeUpperBound,
} from "@/lib/audio-playback-normalization";
import { resetPersistedTrackStartPosition } from "@/lib/persisted-playback-position";
import { resolveListenTogetherNavigationIndex } from "@/lib/listen-together-navigation";
import { writePlaybackAdvanceOrigin } from "@/lib/audio-engine/playbackAdvanceOrigin";
import type { PlaybackAdvanceOrigin } from "@/lib/audio-engine/playbackAdvanceOrigin";
import { toAddToPlaylistRef } from "@/lib/trackRef";
import {
    createMigratingStorageKey,
    writeMigratingStorageItem,
} from "@/lib/storage-migration";
import {
    LAST_PLAYBACK_STATE_SAVE_AT_KEY_SUFFIX,
    QUEUE_CLEARED_AT_KEY_SUFFIX,
} from "@/lib/playback-state-cadence";

const LAST_PLAYBACK_STATE_SAVE_AT_KEY = createMigratingStorageKey(
    LAST_PLAYBACK_STATE_SAVE_AT_KEY_SUFFIX,
);
const QUEUE_CLEARED_AT_KEY = createMigratingStorageKey(
    QUEUE_CLEARED_AT_KEY_SUFFIX,
);

// How long queue dispatch waits for an episode's saved-progress lookup
// before starting the episode from the beginning. The lookup result is
// baked into the media state before the audio load, so resume positions
// are applied deterministically instead of racing a post-load seek.
const EPISODE_PROGRESS_LOOKUP_TIMEOUT_MS = 2000;

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

function toListenTogetherQueueTrack(
    track: Track | null | undefined,
): QueueTrackInput | null {
    if (!track) return null;
    try {
        return toAddToPlaylistRef(track);
    } catch {
        return null;
    }
}

function showListenTogetherQueueMutationToasts(
    result: { acceptedCount: number; skippedCount: number; truncated: boolean },
    messages: {
        singleAccepted: string;
        multiAccepted: (acceptedCount: number) => string;
        noneAccepted?: string;
    },
): void {
    if (result.acceptedCount > 0) {
        toast.success(
            result.acceptedCount === 1
                ? messages.singleAccepted
                : messages.multiAccepted(result.acceptedCount),
        );
    } else {
        toast.info(
            messages.noneAccepted ??
                "Group queue is already at the 500-track cap",
        );
    }

    if (result.truncated && result.skippedCount > 0) {
        toast.info(
            result.acceptedCount > 0
                ? `${result.skippedCount} track${result.skippedCount === 1 ? " was" : "s were"} skipped because Listen Together queues keep only the first 500 tracks`
                : "Listen Together queues keep only the first 500 tracks. The group queue is already full.",
        );
        return;
    }

    if (result.skippedCount > 0) {
        toast.info(
            `Skipped ${result.skippedCount} track${result.skippedCount === 1 ? "" : "s"} while updating the group queue`,
        );
    }
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

/**
 * Executes resolveQueueNavigationIndex.
 */
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

/**
 * Executes resolveActiveListenTogetherSession.
 */
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
    /** Queue items; episode entries have no artist and shuffle independently. */
    queue: Array<
        | {
              id?: string;
              title?: string;
              duration?: number;
              artist?: { id?: string; name?: string };
              album?: { id?: string; title?: string };
          }
        | null
        | undefined
    >;
    random?: () => number;
}

/**
 * Executes generateSeparatedShuffleIndices.
 */
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

const AudioControlsContext = createContext<
    AudioControlsContextType | undefined
>(undefined);

/**
 * Renders the AudioControlsProvider component.
 */
export function AudioControlsProvider({ children }: { children: ReactNode }) {
    const state = useAudioState();
    const volumeMode = useAudioVolumeMode();
    // Non-ticking status subscription; the clock reaches callbacks through
    // currentTimeRef via the bridge below, so the 2,000-line provider body no
    // longer re-renders 4x/second during playback (GH #785).
    const playbackStatus = usePlaybackStatus();
    const statusRef = useRef(playbackStatus);
    const currentTimeRef = useRef(0);
    // Built lazily in the sync effect below: the react-hooks compiler forbids
    // touching refs during render, and callbacks only run after mount.
    const playbackRef = useRef<ReturnType<typeof buildPlaybackView> | null>(
        null,
    );
    const upNextInsertRef = useRef<number>(0);
    const shuffleInsertPosRef = useRef<number>(0);
    const lastQueueInsertAtRef = useRef<number | null>(null);
    const lastCursorTrackIndexRef = useRef<number | null>(null);
    const lastCursorIsShuffleRef = useRef<boolean | null>(null);

    const queueRef = useRef(state.queue);

    useEffect(() => {
        queueRef.current = state.queue;
    }, [state.queue]);

    // Identity of the media the player is currently on, readable from async
    // callbacks. Guards late progress-fetch resolutions (see
    // startQueueItemAtIndex) so they can never seek media the user has
    // already skipped away from.
    const activeQueueMediaIdRef = useRef<string | null>(null);

    useEffect(() => {
        activeQueueMediaIdRef.current =
            state.playbackType === "podcast"
                ? (state.currentPodcast?.id ?? null)
                : state.playbackType === "track"
                  ? (state.currentTrack?.id ?? null)
                  : null;
    }, [state.playbackType, state.currentPodcast, state.currentTrack]);

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
        statusRef.current = playbackStatus;
    }, [playbackStatus]);

    // Built on first use: refs are only touched at call time, which both
    // satisfies the react-hooks compiler and keeps static test renders
    // (no effects) working.
    const getPlaybackView = useCallback(() => {
        playbackRef.current ??= buildPlaybackView(statusRef, currentTimeRef);
        return playbackRef.current;
    }, []);

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
                state.currentIndex,
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
        [],
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
            const playbackState = getPlaybackView();
            const targetTrack = state.queue[targetIndex];
            // Listen Together queues are music-only; ignore episode entries.
            if (!targetTrack || isEpisodeQueueItem(targetTrack)) return;
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
        [state, getPlaybackView],
    );

    const playTrack = useCallback(
        (track: Track) => {
            writePlaybackAdvanceOrigin(
                "manual",
                state.currentTrack?.id ?? null,
            );
            const playbackState = getPlaybackView();
            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                const queueTrack = toListenTogetherQueueTrack(track);
                if (!queueTrack) {
                    toast.error("Failed to prepare track for Listen Together");
                    return;
                }

                void listenTogetherSocket
                    .addToQueue([queueTrack])
                    .then((result) => {
                        showListenTogetherQueueMutationToasts(result, {
                            singleAccepted: `Added "${track.title}" to group queue`,
                            multiAccepted: (acceptedCount) =>
                                acceptedCount === 1
                                    ? `Added "${track.title}" to group queue`
                                    : `Added ${acceptedCount} tracks to group queue`,
                        });
                    })
                    .catch((err) => {
                        toast.error(
                            err?.message ||
                                "Failed to add track to Listen Together queue",
                        );
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
            state.setQueue([track]);
            state.setCurrentIndex(0);
            playbackState.setIsPlaying(true);
            playbackState.setCurrentTime(0);
            state.setShuffleIndices([0]);
            state.setRepeatOneCount(0);
        },
        [state, getActiveListenTogetherSession, getPlaybackView],
    );

    const playTracks = useCallback(
        (tracks: Track[], startIndex = 0, isVibeQueue = false) => {
            writePlaybackAdvanceOrigin(
                "manual",
                state.currentTrack?.id ?? null,
            );
            const playbackState = getPlaybackView();
            if (tracks.length === 0) {
                return;
            }

            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                const safeStartIndex = Math.min(
                    Math.max(startIndex, 0),
                    tracks.length - 1,
                );
                const selectedSlice = tracks.slice(safeStartIndex);
                const queueTracks = selectedSlice
                    .map((track) => ({
                        track,
                        queueTrack: toListenTogetherQueueTrack(track),
                    }))
                    .filter(
                        (
                            entry,
                        ): entry is {
                            track: Track;
                            queueTrack: QueueTrackInput;
                        } => entry.queueTrack !== null,
                    );
                const rejectedCount = selectedSlice.length - queueTracks.length;

                if (queueTracks.length === 0) {
                    toast.error(
                        "No valid tracks to add to Listen Together queue",
                    );
                    return;
                }

                if (rejectedCount > 0) {
                    toast.error(
                        "Some tracks were skipped while preparing group queue items",
                    );
                }

                const trackPayloads = queueTracks.map(
                    (entry) => entry.queueTrack,
                );
                void listenTogetherSocket
                    .addToQueue(trackPayloads)
                    .then((result) => {
                        showListenTogetherQueueMutationToasts(result, {
                            singleAccepted: `Added "${queueTracks[0].track.title}" to group queue`,
                            multiAccepted: (acceptedCount) =>
                                `Added ${acceptedCount} tracks to group queue`,
                        });
                    })
                    .catch((err) => {
                        toast.error(
                            err?.message ||
                                "Failed to add tracks to Listen Together queue",
                        );
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
                tracks.length - 1,
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
            state.setQueue(tracks);
            state.setCurrentIndex(normalizedStartIndex);
            state.setCurrentTrack(startTrack);
            playbackState.setIsPlaying(true);
            playbackState.setCurrentTime(0);
            state.setRepeatOneCount(0);
            state.setShuffleIndices(
                generateShuffleIndices(tracks.length, normalizedStartIndex),
            );
        },
        [
            state,
            generateShuffleIndices,
            getActiveListenTogetherSession,
            getPlaybackView,
        ],
    );

    const playAudiobook = useCallback(
        (audiobook: Audiobook) => {
            writePlaybackAdvanceOrigin(
                "manual",
                state.currentTrack?.id ?? null,
            );
            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                toast.error("Audiobooks are not supported in Listen Together");
                return;
            }

            const playbackState = getPlaybackView();
            state.setPlaybackType("audiobook");
            state.setCurrentAudiobook(audiobook);
            state.setCurrentTrack(null);
            state.setCurrentPodcast(null);
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
        [state, getActiveListenTogetherSession, getPlaybackView],
    );

    // Persists the playing episode's listening position before the player
    // switches to other media. The orchestrator only saves podcast progress
    // on pause, natural end, and a 30s interval, so without this save every
    // manual skip away from an episode would silently lose up to ~30s of
    // position (and later resumes would restart from the stale point).
    const persistEpisodeProgressBeforeSwitch = useCallback(
        (nextMediaId: string | null) => {
            const playbackState = getPlaybackView();
            const save = resolveEpisodeProgressSaveOnSwitch({
                playbackType: state.playbackType,
                currentPodcastId: state.currentPodcast?.id ?? null,
                nextMediaId,
                currentTime: playbackState.currentTime,
                engineDuration: playbackState.duration,
                episodeDuration: state.currentPodcast?.duration ?? 0,
            });
            if (!save) return;
            void api
                .updatePodcastProgress(
                    save.podcastId,
                    save.episodeId,
                    save.currentTime,
                    save.duration,
                    false,
                )
                .then(() => {
                    dispatchQueryEvent("podcast-progress-updated");
                })
                .catch((err) => {
                    sharedFrontendLogger.error(
                        "[AudioControls] Failed to save episode progress before media switch:",
                        err,
                    );
                });
        },
        [state, getPlaybackView],
    );

    const playPodcast = useCallback(
        (podcast: Podcast, options?: { episodeQueue?: EpisodeQueueItem[] }) => {
            writePlaybackAdvanceOrigin(
                "manual",
                state.currentTrack?.id ?? null,
            );
            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                toast.error("Podcasts are not supported in Listen Together");
                return;
            }

            // Selecting an episode from the podcast page replaces the playing
            // media; keep the outgoing episode's position first.
            persistEpisodeProgressBeforeSwitch(podcast.id);

            const playbackState = getPlaybackView();
            const episodeItem = episodeQueueItemFromPodcast(podcast);
            state.setPlaybackType("podcast");
            state.setCurrentPodcast(podcast);
            state.setCurrentTrack(null);
            state.setCurrentAudiobook(null);
            state.setRepeatOneCount(0);

            // The episode joins the existing mixed queue instead of clearing
            // it: replace only when the queue is empty, jump to the episode
            // when it is already queued, otherwise insert the episode plus
            // any not-yet-queued context episodes right after the current
            // item so music queued behind it survives.
            const placement = computePodcastContextPlacement({
                queue: state.queue,
                currentIndex: state.currentIndex,
                isShuffle: state.isShuffle,
                shuffleIndices: state.shuffleIndices,
                selected: episodeItem,
                context: options?.episodeQueue ?? [],
            });
            if (placement.action === "replace") {
                state.setQueue(placement.items);
                state.setCurrentIndex(placement.startIndex);
                state.setShuffleIndices(
                    state.isShuffle
                        ? generateShuffleIndices(
                              placement.items.length,
                              placement.startIndex,
                          )
                        : [],
                );
            } else if (placement.action === "jump") {
                state.setCurrentIndex(placement.index);
            } else {
                const { insertAt, items, newCurrentIndex, newShuffleIndices } =
                    placement;
                state.setQueue((prev) => {
                    const newQueue = [...prev];
                    newQueue.splice(insertAt, 0, ...items);
                    return newQueue;
                });
                state.setCurrentIndex(newCurrentIndex);
                if (state.isShuffle && newShuffleIndices.length > 0) {
                    state.setShuffleIndices(newShuffleIndices);
                }
            }

            playbackState.setIsPlaying(true);

            if (podcast.progress?.currentTime) {
                playbackState.setCurrentTime(podcast.progress.currentTime);
            } else {
                playbackState.setCurrentTime(0);
            }
        },
        [
            state,
            generateShuffleIndices,
            getActiveListenTogetherSession,
            persistEpisodeProgressBeforeSwitch,
            getPlaybackView,
        ],
    );

    const pause = useCallback(
        (options?: { suppressListenTogetherBroadcast?: boolean }) => {
            const playbackState = getPlaybackView();
            const ltSession = getActiveListenTogetherSession();
            playbackState.setIsPlaying(false);
            if (
                ltSession?.isHost &&
                !options?.suppressListenTogetherBroadcast
            ) {
                listenTogetherSocket.pause().catch(() => {});
            }
        },
        [getActiveListenTogetherSession, getPlaybackView],
    );

    // Makes the queue item at `index` the current media and starts playback,
    // dispatching to the track or podcast playback path by item type.
    const startQueueItemAtIndex = useCallback(
        (index: number, item: QueueItem) => {
            const playbackState = getPlaybackView();
            // Skipping away from a playing episode must keep its position.
            persistEpisodeProgressBeforeSwitch(item.id);
            // Record the new active media synchronously so any in-flight
            // progress lookup from a previous episode resolves as stale.
            activeQueueMediaIdRef.current = item.id;
            state.setRepeatOneCount(0);

            if (isEpisodeQueueItem(item)) {
                // Advance the queue cursor immediately so a rapid second
                // skip resolves from the episode's index instead of the
                // stale one (which would land on the same episode and make
                // it impossible to skip past). Stop the audible source
                // right away, then flip the media state only once the
                // episode's saved progress is known (or the lookup timed
                // out). The progress is baked into currentPodcast BEFORE
                // the audio load, so the load effect starts the stream at
                // the resume position deterministically instead of racing
                // a post-load seek whose lock expires.
                state.setCurrentIndex(index);
                playbackState.setIsPlaying(false);

                let started = false;
                let lookupTimeoutId: ReturnType<typeof setTimeout> | null =
                    null;
                const startEpisode = (progress: Episode["progress"] | null) => {
                    if (started) return;
                    started = true;
                    if (lookupTimeoutId !== null) {
                        clearTimeout(lookupTimeoutId);
                        lookupTimeoutId = null;
                    }
                    // The lookup may settle after the user skipped to other
                    // media; never (re)start an episode the player has
                    // already moved away from.
                    const start = resolveEpisodeStartPosition({
                        itemId: item.id,
                        activeMediaId: activeQueueMediaIdRef.current,
                        progress: progress ?? null,
                        duration: item.duration,
                    });
                    if (!start) return;
                    const currentPlayback = getPlaybackView();
                    state.setCurrentTrack(null);
                    state.setCurrentAudiobook(null);
                    state.setPlaybackType("podcast");
                    state.setCurrentPodcast({
                        id: item.id,
                        title: item.title,
                        podcastTitle: item.podcastTitle,
                        coverUrl: item.coverUrl,
                        duration: item.duration,
                        progress:
                            progress && start.startAt > 0
                                ? { ...progress, currentTime: start.startAt }
                                : null,
                    });
                    currentPlayback.setCurrentTime(start.startAt);
                    currentPlayback.setIsPlaying(true);
                };

                // Resume saved progress via the existing podcast lookup
                // path, bounded so playback never stalls on a slow fetch.
                lookupTimeoutId = setTimeout(
                    () => startEpisode(null),
                    EPISODE_PROGRESS_LOOKUP_TIMEOUT_MS,
                );
                void api
                    .getPodcast(item.podcastId)
                    .then((podcast: { episodes?: Episode[] }) => {
                        const episode = podcast.episodes?.find(
                            (ep: Episode) => ep.id === item.episodeId,
                        );
                        startEpisode(episode?.progress ?? null);
                    })
                    .catch(() => {
                        // Progress lookup is best-effort; play from start.
                        startEpisode(null);
                    });
                return;
            }

            resetPersistedTrackStartPosition(item.id);
            state.setCurrentIndex(index);
            state.setCurrentAudiobook(null);
            state.setCurrentPodcast(null);
            state.setPlaybackType("track");
            state.setCurrentTrack(item);
            playbackState.setCurrentTime(0);
            playbackState.setIsPlaying(true);
        },
        [state, persistEpisodeProgressBeforeSwitch, getPlaybackView],
    );

    const resume = useCallback(
        (options?: {
            suppressListenTogetherBroadcast?: boolean;
            listenTogetherForceIsPlaying?: boolean;
            listenTogetherPositionMs?: number;
            listenTogetherServerTimeMs?: number;
        }) => {
            const playbackState = getPlaybackView();
            if (!options?.suppressListenTogetherBroadcast) {
                writePlaybackAdvanceOrigin(
                    "manual",
                    state.currentTrack?.id ?? null,
                );
            }
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
                    ? Math.max(
                          0,
                          Date.now() -
                              getServerClockOffsetMs() -
                              syncServerTimeMs,
                      )
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
                    mediaDuration,
                );

                playbackState.lockSeek(clampedTarget);
                playbackState.setCurrentTime(clampedTarget);
                audioSeekEmitter.emit(clampedTarget);
                playbackState.setIsPlaying(syncIsPlaying);
                return;
            }

            playbackState.setIsPlaying(true);
        },
        [state, getActiveListenTogetherSession, getPlaybackView],
    );

    const play = useCallback(() => {
        resume();
    }, [resume]);

    const advanceQueue = useCallback(
        (origin: PlaybackAdvanceOrigin) => {
            writePlaybackAdvanceOrigin(origin, state.currentTrack?.id ?? null);
            const playbackState = getPlaybackView();
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
                    () => getPlaybackView().setIsPlaying(true),
                    10,
                );
                return;
            }

            state.setRepeatOneCount(0);

            if (state.isShuffle) {
                const currentShufflePos = state.shuffleIndices.indexOf(
                    state.currentIndex,
                );
                queueDebugLog("next() shuffle", {
                    currentIndex: state.currentIndex,
                    currentShufflePos,
                    shuffleIndicesLen: state.shuffleIndices.length,
                });
            }
            const advance = resolveQueueAdvance({
                action: "next",
                queue: state.queue,
                currentIndex: state.currentIndex,
                isShuffle: state.isShuffle,
                shuffleIndices: state.shuffleIndices,
                repeatMode: state.repeatMode,
            });
            if (advance.kind === "stop") {
                return;
            }

            queueDebugLog("next() chosen", {
                isShuffle: state.isShuffle,
                nextIndex: advance.index,
                nextItemKind: advance.kind,
                nextItemId: state.queue[advance.index]?.id,
                queueLen: state.queue.length,
            });
            const nextItem = state.queue[advance.index];
            if (!nextItem) {
                return;
            }
            startQueueItemAtIndex(advance.index, nextItem);
        },
        [
            state,
            startQueueItemAtIndex,
            getActiveListenTogetherSession,
            emitListenTogetherHostTrackOperation,
            applyOptimisticListenTogetherTrackSelection,
            getPlaybackView,
        ],
    );
    const next = useCallback(() => advanceQueue("manual"), [advanceQueue]);

    const previous = useCallback(() => {
        writePlaybackAdvanceOrigin("manual", state.currentTrack?.id ?? null);
        const playbackState = getPlaybackView();
        const ltSession = getActiveListenTogetherSession();
        if (ltSession) {
            if (!ltSession.isHost) return;
            const prevIndex = resolveListenTogetherNavigationIndex({
                action: "previous",
                queueLength: state.queue.length > 0 ? state.queue.length : 0,
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

        const advance = resolveQueueAdvance({
            action: "previous",
            queue: state.queue,
            currentIndex: state.currentIndex,
            isShuffle: state.isShuffle,
            shuffleIndices: state.shuffleIndices,
            repeatMode: state.repeatMode,
        });
        if (advance.kind === "stop") {
            return;
        }

        const prevItem = state.queue[advance.index];
        if (!prevItem) {
            return;
        }
        startQueueItemAtIndex(advance.index, prevItem);
    }, [
        state,
        startQueueItemAtIndex,
        getActiveListenTogetherSession,
        emitListenTogetherHostTrackOperation,
        applyOptimisticListenTogetherTrackSelection,
        getPlaybackView,
    ]);

    const addTracksToQueue = useCallback(
        (tracks: Track[], options?: { silent?: boolean }) => {
            writePlaybackAdvanceOrigin(
                "manual",
                state.currentTrack?.id ?? null,
            );
            const playbackState = getPlaybackView();
            const shouldToastSuccess = !options?.silent;
            const validTracks = tracks.filter((track) => Boolean(track?.id));
            if (validTracks.length === 0) {
                return;
            }

            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                const queueTracks = validTracks
                    .map((track) => ({
                        track,
                        queueTrack: toListenTogetherQueueTrack(track),
                    }))
                    .filter(
                        (
                            entry,
                        ): entry is {
                            track: Track;
                            queueTrack: QueueTrackInput;
                        } => entry.queueTrack !== null,
                    );
                const rejectedCount = validTracks.length - queueTracks.length;

                if (queueTracks.length === 0) {
                    toast.error("Failed to prepare tracks for Listen Together");
                    return;
                }
                if (rejectedCount > 0) {
                    toast.error(
                        "Some tracks were skipped while preparing group queue items",
                    );
                }

                const trackPayloads = queueTracks.map(
                    (entry) => entry.queueTrack,
                );
                listenTogetherSocket
                    .addToQueue(trackPayloads)
                    .then((result) => {
                        if (!shouldToastSuccess) return;
                        showListenTogetherQueueMutationToasts(result, {
                            singleAccepted: `Added "${queueTracks[0].track.title}" to group queue`,
                            multiAccepted: (acceptedCount) =>
                                `Added ${acceptedCount} tracks to group queue`,
                        });
                    })
                    .catch((err) => {
                        toast.error(
                            err?.message ||
                                "Failed to add track to Listen Together queue",
                        );
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

            // Start a fresh queue only when it is empty and no podcast episode
            // is playing. Episodes and tracks share one queue, so queueing
            // music must never interrupt the playing episode (and vice versa).
            if (state.queue.length === 0 && state.playbackType !== "podcast") {
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
                    generateShuffleIndices(validTracks.length, 0),
                );
                queueDebugLog("addTracksToQueue() started fresh queue", {
                    count: validTracks.length,
                    firstTrackId: validTracks[0]?.id,
                });

                if (shouldToastSuccess) {
                    if (validTracks.length === 1) {
                        toast.success(
                            `Added "${validTracks[0].title}" to queue`,
                        );
                    } else {
                        toast.success(
                            `Added ${validTracks.length} tracks to queue`,
                        );
                    }
                }
                return;
            }

            // Legacy state: an episode is playing but is not represented in
            // the queue yet. Seed the queue with the current episode so it
            // keeps its place, then append the tracks behind it.
            if (state.queue.length === 0 && state.currentPodcast) {
                const episodeItem = episodeQueueItemFromPodcast(
                    state.currentPodcast,
                );
                state.setQueue([episodeItem, ...validTracks]);
                state.setCurrentIndex(0);
                if (state.isShuffle) {
                    // Seed a real shuffle order (the playing episode keeps
                    // position 0); identity indices would silently play the
                    // "shuffled" queue sequentially.
                    state.setShuffleIndices(
                        generateShuffleIndices(validTracks.length + 1, 0),
                    );
                }
                if (shouldToastSuccess) {
                    if (validTracks.length === 1) {
                        toast.success(
                            `Added "${validTracks[0].title}" to queue`,
                        );
                    } else {
                        toast.success(
                            `Added ${validTracks.length} tracks to queue`,
                        );
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

                    // Non-empty shuffle indices cover every queue position,
                    // so the pre-append queue length equals
                    // prevIndices.length. Deriving it inside the functional
                    // updater keeps rapid back-to-back adds from stamping
                    // overlapping indices off a stale queue snapshot.
                    const insertedIndices = Array.from(
                        { length: insertCount },
                        (_, offset) => prevIndices.length + offset,
                    );
                    const newIndices = [...prevIndices, ...insertedIndices];
                    queueDebugLog(
                        "addTracksToQueue() shuffleIndices appended",
                        {
                            insertCount,
                            prevIndicesLen: prevIndices.length,
                            newIndicesLen: newIndices.length,
                            insertedIndices,
                        },
                    );

                    return newIndices;
                });
            }

            if (shouldToastSuccess) {
                if (validTracks.length === 1) {
                    toast.success(`Added "${validTracks[0].title}" to queue`);
                } else {
                    toast.success(
                        `Added ${validTracks.length} tracks to queue`,
                    );
                }
            }
        },
        [
            state,
            generateShuffleIndices,
            getActiveListenTogetherSession,
            getPlaybackView,
        ],
    );

    const addToQueue = useCallback(
        (track: Track, options?: { silent?: boolean }) => {
            addTracksToQueue([track], options);
        },
        [addTracksToQueue],
    );

    const playNext = useCallback(
        (track: Track) => {
            writePlaybackAdvanceOrigin(
                "manual",
                state.currentTrack?.id ?? null,
            );
            if (!track?.id) return;
            const playbackState = getPlaybackView();

            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                const queueTrack = toListenTogetherQueueTrack(track);
                if (!queueTrack) {
                    toast.error("Failed to prepare track for Listen Together");
                    return;
                }
                void listenTogetherSocket
                    .insertNext([queueTrack])
                    .then((result) => {
                        showListenTogetherQueueMutationToasts(result, {
                            singleAccepted: `Playing "${track.title}" next in group queue`,
                            multiAccepted: (acceptedCount) =>
                                acceptedCount === 1
                                    ? `Playing "${track.title}" next in group queue`
                                    : `Added ${acceptedCount} tracks to group queue`,
                        });
                    })
                    .catch((err) => {
                        toast.error(
                            err?.message ||
                                "Failed to add track to Listen Together queue",
                        );
                    });
                return;
            }

            // If nothing is playing (empty queue, no episode), just start the track
            if (state.queue.length === 0 && state.playbackType !== "podcast") {
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

            // Legacy state: an episode is playing but not in the queue yet.
            // Seed the queue with the episode, then queue the track after it.
            if (state.queue.length === 0 && state.currentPodcast) {
                const episodeItem = episodeQueueItemFromPodcast(
                    state.currentPodcast,
                );
                state.setQueue([episodeItem, track]);
                state.setCurrentIndex(0);
                if (state.isShuffle) {
                    state.setShuffleIndices([0, 1]);
                }
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
            upNextInsertRef.current =
                Math.max(upNextInsertRef.current, insertAt) + 1;

            // Update shuffle indices if shuffle is on
            if (state.isShuffle) {
                state.setShuffleIndices((prevIndices) => {
                    if (prevIndices.length === 0) return prevIndices;
                    // Shift all indices >= insertAt up by 1
                    const shifted = prevIndices.map((i) =>
                        i >= insertAt ? i + 1 : i,
                    );
                    // Insert the new track index right after the current track in shuffle order
                    const currentShufflePos = shifted.indexOf(
                        state.currentIndex,
                    );
                    const shuffleInsertPos =
                        currentShufflePos >= 0 ? currentShufflePos + 1 : 0;
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
        [
            state,
            generateShuffleIndices,
            getActiveListenTogetherSession,
            getPlaybackView,
        ],
    );

    const playNow = useCallback(
        (track: Track) => {
            writePlaybackAdvanceOrigin(
                "manual",
                state.currentTrack?.id ?? null,
            );
            if (!track?.id) return;

            const playbackState = getPlaybackView();
            const ltSession = getActiveListenTogetherSession();

            // Listen Together: add only this single track to the shared queue
            if (ltSession) {
                const queueTrack = toListenTogetherQueueTrack(track);
                if (!queueTrack) {
                    toast.error("Failed to prepare track for Listen Together");
                    return;
                }
                void listenTogetherSocket
                    .addToQueue([queueTrack])
                    .then((result) => {
                        showListenTogetherQueueMutationToasts(result, {
                            singleAccepted: `Added "${track.title}" to group queue`,
                            multiAccepted: (acceptedCount) =>
                                acceptedCount === 1
                                    ? `Added "${track.title}" to group queue`
                                    : `Added ${acceptedCount} tracks to group queue`,
                        });
                    })
                    .catch((err) => {
                        toast.error(
                            err?.message ||
                                "Failed to add track to Listen Together queue",
                        );
                    });
                return;
            }

            // If vibe mode is on and this track isn't in the vibe queue, disable vibe mode
            if (state.vibeMode && !state.vibeQueueIds.includes(track.id)) {
                state.setVibeMode(false);
                state.setVibeSourceFeatures(null);
                state.setVibeQueueIds([]);
            }

            // Play-now over a playing episode must keep its position.
            persistEpisodeProgressBeforeSwitch(track.id);

            // Empty queue or audiobook playback: start fresh with just this track.
            // With a non-empty mixed queue (including podcast playback) the
            // track is inserted after the current item instead, so the rest
            // of the queue survives.
            if (
                state.queue.length === 0 ||
                state.playbackType === "audiobook"
            ) {
                resetPersistedTrackStartPosition(track.id);
                state.setPlaybackType("track");
                state.setCurrentTrack(track);
                state.setCurrentAudiobook(null);
                state.setCurrentPodcast(null);
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
            upNextInsertRef.current =
                Math.max(upNextInsertRef.current, insertAt) + 1;

            // Atomically commit all state together so React batches the update
            resetPersistedTrackStartPosition(track.id);
            state.setQueue(newQueue);
            state.setShuffleIndices(newShuffleIndices);
            state.setCurrentIndex(insertAt);
            state.setCurrentTrack(track);
            state.setCurrentPodcast(null);
            state.setPlaybackType("track");
            state.setRepeatOneCount(0);
            playbackState.setCurrentTime(0);
            playbackState.setIsPlaying(true);
        },
        [
            state,
            generateShuffleIndices,
            getActiveListenTogetherSession,
            persistEpisodeProgressBeforeSwitch,
            getPlaybackView,
        ],
    );

    // Builds an episode queue entry from podcast-page data.
    const toEpisodeQueueItem = useCallback(
        (
            episode: Episode,
            podcast: { id: string; title: string; coverUrl: string | null },
        ): EpisodeQueueItem =>
            buildEpisodeQueueItem({
                podcastId: podcast.id,
                episodeId: episode.id,
                title: episode.title,
                podcastTitle: podcast.title,
                coverUrl: podcast.coverUrl ?? null,
                duration: episode.duration,
            }),
        [],
    );

    const addEpisodeToQueue = useCallback(
        (
            episode: Episode,
            podcast: { id: string; title: string; coverUrl: string | null },
        ) => {
            writePlaybackAdvanceOrigin(
                "manual",
                state.currentTrack?.id ?? null,
            );
            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                toast.error("Podcasts are not supported in Listen Together");
                return;
            }

            const item = toEpisodeQueueItem(episode, podcast);

            // Nothing playing and empty queue: play the episode immediately,
            // mirroring addTracksToQueue behavior for tracks.
            if (
                state.queue.length === 0 &&
                !state.currentTrack &&
                !state.currentPodcast &&
                !state.currentAudiobook
            ) {
                playPodcast({
                    id: item.id,
                    title: item.title,
                    podcastTitle: item.podcastTitle,
                    coverUrl: item.coverUrl,
                    duration: item.duration,
                    progress: episode.progress || null,
                });
                return;
            }

            // Legacy state: current episode playing but not in the queue yet.
            if (state.queue.length === 0 && state.currentPodcast) {
                const currentItem = episodeQueueItemFromPodcast(
                    state.currentPodcast,
                );
                state.setQueue([currentItem, item]);
                state.setCurrentIndex(0);
                toast.success(`Added "${episode.title}" to queue`);
                return;
            }

            state.setQueue((prev) => [...prev, item]);
            if (state.isShuffle) {
                // Compute the appended queue index inside the functional
                // updater: non-empty shuffle indices cover every queue
                // position, so the new item's index is prevIndices.length.
                // A snapshot taken outside the updater goes stale when two
                // adds land before a re-render, stamping the same index
                // twice (one queue position would then never play).
                state.setShuffleIndices((prevIndices) =>
                    prevIndices.length === 0
                        ? prevIndices
                        : [...prevIndices, prevIndices.length],
                );
            }
            toast.success(`Added "${episode.title}" to queue`);
        },
        [
            state,
            playPodcast,
            toEpisodeQueueItem,
            getActiveListenTogetherSession,
        ],
    );

    const playEpisodeNext = useCallback(
        (
            episode: Episode,
            podcast: { id: string; title: string; coverUrl: string | null },
        ) => {
            writePlaybackAdvanceOrigin(
                "manual",
                state.currentTrack?.id ?? null,
            );
            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                toast.error("Podcasts are not supported in Listen Together");
                return;
            }

            const item = toEpisodeQueueItem(episode, podcast);

            if (
                state.queue.length === 0 &&
                !state.currentTrack &&
                !state.currentPodcast &&
                !state.currentAudiobook
            ) {
                playPodcast({
                    id: item.id,
                    title: item.title,
                    podcastTitle: item.podcastTitle,
                    coverUrl: item.coverUrl,
                    duration: item.duration,
                    progress: episode.progress || null,
                });
                return;
            }

            // Legacy state: current episode playing but not in the queue yet.
            if (state.queue.length === 0 && state.currentPodcast) {
                const currentItem = episodeQueueItemFromPodcast(
                    state.currentPodcast,
                );
                state.setQueue([currentItem, item]);
                state.setCurrentIndex(0);
                toast.success(`Playing "${episode.title}" next`);
                return;
            }

            // Insert immediately after the currently playing item
            const insertAt = Math.min(
                state.currentIndex + 1,
                state.queue.length,
            );
            state.setQueue((prevQueue) => {
                const newQueue = [...prevQueue];
                newQueue.splice(insertAt, 0, item);
                return newQueue;
            });
            upNextInsertRef.current =
                Math.max(upNextInsertRef.current, insertAt) + 1;
            if (state.isShuffle) {
                state.setShuffleIndices((prevIndices) => {
                    if (prevIndices.length === 0) return prevIndices;
                    const shifted = prevIndices.map((i) =>
                        i >= insertAt ? i + 1 : i,
                    );
                    const currentShufflePos = shifted.indexOf(
                        state.currentIndex,
                    );
                    const shuffleInsertPos =
                        currentShufflePos >= 0 ? currentShufflePos + 1 : 0;
                    const newIndices = [...shifted];
                    newIndices.splice(shuffleInsertPos, 0, insertAt);
                    return newIndices;
                });
            }
            toast.success(`Playing "${episode.title}" next`);
        },
        [
            state,
            playPodcast,
            toEpisodeQueueItem,
            getActiveListenTogetherSession,
        ],
    );

    // Jump to an arbitrary queue position without rebuilding the queue.
    const playQueueIndex = useCallback(
        (index: number) => {
            writePlaybackAdvanceOrigin(
                "manual",
                state.currentTrack?.id ?? null,
            );
            const item = state.queue[index];
            if (!item) return;
            startQueueItemAtIndex(index, item);
        },
        [state, startQueueItemAtIndex],
    );

    const removeFromQueue = useCallback(
        (index: number) => {
            writePlaybackAdvanceOrigin(
                "manual",
                state.currentTrack?.id ?? null,
            );
            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                listenTogetherSocket.removeFromQueue(index).catch(() => {});
                return;
            }

            const newQueue = state.queue.filter((_, i) => i !== index);
            state.setQueue(newQueue);

            if (index < state.currentIndex) {
                state.setCurrentIndex((prevIndex) => prevIndex - 1);
            } else if (
                index === state.currentIndex &&
                index === newQueue.length
            ) {
                const first = newQueue[0];
                if (!first) {
                    // The queue emptied out: keep a playing episode's
                    // position before playback stops.
                    persistEpisodeProgressBeforeSwitch(null);
                    state.setCurrentIndex(0);
                    state.setCurrentTrack(null);
                    state.setCurrentPodcast(null);
                    getPlaybackView().setIsPlaying(false);
                } else {
                    // Removing the currently playing LAST item: hand off to
                    // the shared start path so the outgoing episode's
                    // progress is persisted and the new current item (track
                    // or episode) resumes from its saved progress instead
                    // of restarting at 0:00.
                    startQueueItemAtIndex(0, first);
                }
            }

            // Update shuffle indices: remove the index and shift remaining
            if (state.isShuffle) {
                state.setShuffleIndices((prev) => {
                    return prev
                        .filter((i) => i !== index)
                        .map((i) => (i > index ? i - 1 : i));
                });
            }
        },
        [
            state,
            getActiveListenTogetherSession,
            persistEpisodeProgressBeforeSwitch,
            startQueueItemAtIndex,
            getPlaybackView,
        ],
    );

    const moveQueueItem = useCallback(
        (fromIndex: number, toIndex: number) => {
            // Listen Together queues are server-owned; local reorder would
            // desync (matches the existing move-up/down behavior).
            if (getActiveListenTogetherSession()) {
                return;
            }
            // Only upcoming items move; the current row and history are
            // fixed, so currentIndex never needs adjustment.
            if (
                fromIndex <= state.currentIndex ||
                toIndex <= state.currentIndex
            ) {
                return;
            }
            const nextQueue = moveItemInList(state.queue, fromIndex, toIndex);
            if (nextQueue === state.queue) {
                return;
            }
            state.setQueue(nextQueue);
            if (state.isShuffle) {
                state.setShuffleIndices((prev) =>
                    remapShuffleIndicesForMove(prev, fromIndex, toIndex),
                );
            }
        },
        [state, getActiveListenTogetherSession],
    );

    const clearQueue = useCallback(() => {
        writePlaybackAdvanceOrigin("manual", state.currentTrack?.id ?? null);
        const ltSession = getActiveListenTogetherSession();
        if (ltSession) {
            listenTogetherSocket.clearQueue().catch(() => {});
            return;
        }

        state.setQueue([]);
        state.setCurrentIndex(0);
        state.setCurrentTrack(null);
        state.setCurrentPodcast(null);
        state.setPlaybackType(null);
        getPlaybackView().setIsPlaying(false);
        state.setShuffleIndices([]);

        // Persist to server so the next playback-state poll sees an empty
        // queue and doesn't restore stale data.  Also stamp the local save
        // timestamp to activate the 25 s poll cooldown, and the cleared-at
        // timestamp so the poll ignores stale server state for 60 s.
        const now = Date.now().toString();
        writeMigratingStorageItem(LAST_PLAYBACK_STATE_SAVE_AT_KEY, now);
        writeMigratingStorageItem(QUEUE_CLEARED_AT_KEY, now);
        void api.clearPlaybackState().catch(() => undefined);
    }, [state, getActiveListenTogetherSession, getPlaybackView]);

    // Set upcoming tracks without interrupting current playback
    // preserveOrder=true will skip shuffle index generation (used for vibe mode)
    const setUpcoming = useCallback(
        (tracks: Track[], preserveOrder = false) => {
            const playbackState = getPlaybackView();
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
                            generateShuffleIndices(tracks.length, 0),
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
                    generateShuffleIndices(tracks.length + 1, 0),
                );
            } else {
                // Clear shuffle indices for vibe mode or non-shuffle
                state.setShuffleIndices([]);
            }
        },
        [
            state,
            generateShuffleIndices,
            getActiveListenTogetherSession,
            getPlaybackView,
        ],
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
                        state.currentIndex,
                    ),
                );
            }
            return newShuffle;
        });
    }, [state, generateShuffleIndices, getActiveListenTogetherSession]);

    const toggleRepeat = useCallback(() => {
        const ltSession = getActiveListenTogetherSession();
        if (ltSession) return;

        writePlaybackAdvanceOrigin("manual", state.currentTrack?.id ?? null);
        state.setRepeatMode((prev) => {
            if (prev === "off") return "all";
            if (prev === "all") return "one";
            return "off";
        });
        state.setRepeatOneCount(0);
    }, [state, getActiveListenTogetherSession]);

    const updateCurrentTime = useCallback(
        (time: number) => {
            getPlaybackView().setCurrentTime(time);
        },
        [getPlaybackView],
    );

    const seek = useCallback(
        (
            time: number,
            options?: {
                allowListenTogetherFollower?: boolean;
                suppressListenTogetherBroadcast?: boolean;
            },
        ) => {
            const playbackState = getPlaybackView();
            const ltSession = getActiveListenTogetherSession();
            if (
                ltSession &&
                !ltSession.isHost &&
                !options?.allowListenTogetherFollower
            ) {
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
                playbackState.duration,
            );
            const clampedTime = clampPlaybackTimeToUpperBound(
                time,
                maxDuration,
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

            if (
                ltSession?.isHost &&
                !options?.suppressListenTogetherBroadcast
            ) {
                listenTogetherSocket.seek(clampedTime * 1000).catch(() => {});
            }
        },
        [state, getActiveListenTogetherSession, getPlaybackView],
    );

    const skipForward = useCallback(
        (seconds: number = 30) => {
            seek(getPlaybackView().currentTime + seconds);
        },
        [seek, getPlaybackView],
    );

    const skipBackward = useCallback(
        (seconds: number = 30) => {
            seek(getPlaybackView().currentTime - seconds);
        },
        [seek, getPlaybackView],
    );

    const {
        setPlayerModeWithHistory,
        returnToPreviousMode,
        setVolumeControl,
        toggleMute,
    } = useVolumeModeControls(volumeMode);

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
            const response = await api.getVibeSimilarTracks(
                currentTrack.id,
                50,
            );

            if (!response.tracks || response.tracks.length === 0) {
                return { success: false, trackCount: 0 };
            }

            const ltSession = getActiveListenTogetherSession();
            if (ltSession) {
                const queueIds = [
                    currentTrack.id,
                    ...response.tracks.map((t) => t.id),
                ];
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
                        `You're in a Listen Together group. Match Vibe will add ${trackLabel} to the shared queue. Continue?`,
                    );
                    if (!confirmed) {
                        toast.info("Match Vibe cancelled");
                        return { success: false, trackCount: 0 };
                    }
                }

                const queueResult =
                    await listenTogetherSocket.addToQueue(uniqueQueueIds);
                showListenTogetherQueueMutationToasts(queueResult, {
                    singleAccepted: "Added 1 track to group queue",
                    multiAccepted: (acceptedCount) =>
                        `Added ${acceptedCount} tracks to group queue`,
                });
                return {
                    success: queueResult.acceptedCount > 0,
                    trackCount: queueResult.acceptedCount,
                };
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
            state.setVibeSourceFeatures(
                response.sourceFeatures || currentTrack.audioFeatures || null,
            );
            state.setVibeQueueIds(queueIds);

            // Build new queue: current track (with source features) + similar tracks
            state.setQueue((prev) => {
                const current = prev[state.currentIndex];
                const base =
                    current && !isEpisodeQueueItem(current)
                        ? current
                        : currentTrack;
                const enriched = response.sourceFeatures
                    ? {
                          ...base,
                          audioFeatures: {
                              ...base.audioFeatures,
                              ...response.sourceFeatures,
                          },
                      }
                    : base;
                return [enriched, ...vibeTracks];
            });

            // Reset index to 0 (current track is now at index 0)
            state.setCurrentIndex(0);

            return { success: true, trackCount: response.tracks.length };
        } catch (error) {
            sharedFrontendLogger.error(
                "[Vibe] Failed to get similar tracks:",
                error,
            );
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
            addEpisodeToQueue,
            playEpisodeNext,
            pause,
            resume,
            play,
            next,
            advanceQueue,
            previous,
            playNow,
            playNext,
            addToQueue,
            addTracksToQueue,
            playQueueIndex,
            removeFromQueue,
            moveQueueItem,
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
            addEpisodeToQueue,
            playEpisodeNext,
            pause,
            resume,
            play,
            next,
            advanceQueue,
            previous,
            playNow,
            playNext,
            addToQueue,
            addTracksToQueue,
            playQueueIndex,
            removeFromQueue,
            moveQueueItem,
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
        ],
    );

    return (
        <AudioControlsContext.Provider value={value}>
            <PlaybackClockBridge currentTimeRef={currentTimeRef} />
            {children}
        </AudioControlsContext.Provider>
    );
}

/**
 * Executes useAudioControls.
 */
export function useAudioControls() {
    const context = useContext(AudioControlsContext);
    if (!context) {
        throw new Error(
            "useAudioControls must be used within AudioControlsProvider",
        );
    }
    return context;
}
