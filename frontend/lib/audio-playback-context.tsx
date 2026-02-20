"use client";

import {
    createContext,
    useContext,
    useState,
    useEffect,
    useRef,
    useCallback,
    ReactNode,
    useMemo,
} from "react";
import { useAudioState } from "./audio-state-context";
import { playbackStateMachine, type PlaybackState } from "./audio";
import { api } from "@/lib/api";
import {
    createMigratingStorageKey,
    readMigratingStorageItem,
    writeMigratingStorageItem,
    type MigratingStorageKey,
} from "@/lib/storage-migration";
import {
    LAST_PLAYBACK_STATE_SAVE_AT_KEY_SUFFIX,
    PLAYBACK_PROGRESS_SAVE_INTERVAL_MS,
} from "@/lib/playback-state-cadence";
import { resolveHydratedPlaybackIntent } from "@/lib/playback-intent";

interface AudioPlaybackContextType {
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    isBuffering: boolean;
    targetSeekPosition: number | null;
    canSeek: boolean;
    downloadProgress: number | null; // 0-100 for downloading, null for not downloading
    isSeekLocked: boolean; // True when a seek operation is in progress
    audioError: string | null; // Error message from state machine
    playbackState: PlaybackState; // Raw state machine state for advanced use
    setIsPlaying: (playing: boolean) => void;
    setCurrentTime: (time: number) => void;
    setCurrentTimeFromEngine: (time: number) => void; // For timeupdate events - respects seek lock
    setDuration: (duration: number) => void;
    setIsBuffering: (buffering: boolean) => void;
    setTargetSeekPosition: (position: number | null) => void;
    setCanSeek: (canSeek: boolean) => void;
    setDownloadProgress: (progress: number | null) => void;
    lockSeek: (targetTime: number) => void; // Lock updates during seek
    unlockSeek: () => void; // Unlock after seek completes
    clearAudioError: () => void; // Clear the audio error state
}

const AudioPlaybackContext = createContext<
    AudioPlaybackContextType | undefined
>(undefined);

// LocalStorage keys
const STORAGE_KEYS = {
    IS_PLAYING: createMigratingStorageKey("is_playing"),
    CURRENT_TIME: createMigratingStorageKey("current_time"),
    CURRENT_TIME_TRACK_ID: createMigratingStorageKey("current_time_track_id"),
    LAST_PLAYBACK_STATE_SAVE_AT: createMigratingStorageKey(
        LAST_PLAYBACK_STATE_SAVE_AT_KEY_SUFFIX
    ),
};

function readStorage(key: MigratingStorageKey): string | null {
    return readMigratingStorageItem(key);
}

export function AudioPlaybackProvider({ children }: { children: ReactNode }) {
    const [isPlaying, setIsPlaying] = useState(() => {
        if (typeof window === "undefined") return false;
        try {
            return readStorage(STORAGE_KEYS.IS_PLAYING) === "true";
        } catch {
            return false;
        }
    });
    const [currentTime, setCurrentTime] = useState(() => {
        if (typeof window === "undefined") return 0;
        try {
            const saved = readStorage(STORAGE_KEYS.CURRENT_TIME);
            return saved ? parseFloat(saved) : 0;
        } catch { return 0; }
    });
    const [duration, setDuration] = useState(0);
    const [isBuffering, setIsBuffering] = useState(false);
    const [targetSeekPosition, setTargetSeekPosition] = useState<number | null>(
        null
    );
    const [canSeek, setCanSeek] = useState(true); // Default true for music, false for uncached podcasts
    const [downloadProgress, setDownloadProgress] = useState<number | null>(
        null
    );
    const [audioError, setAudioError] = useState<string | null>(null);
    const [playbackState, setPlaybackState] = useState<PlaybackState>("IDLE");
    const [isHydrated] = useState(() => typeof window !== "undefined");
    const lastSaveTimeRef = useRef<number>(0);
    const lastServerProgressSaveRef = useRef<number>(0);
    const initialIsPlayingRef = useRef(isPlaying);
    const currentTimeRef = useRef<number>(currentTime);

    // Clear audio error
    const clearAudioError = useCallback(() => {
        setAudioError(null);
        // Also reset state machine if in error state
        if (playbackStateMachine.hasError) {
            playbackStateMachine.forceTransition("IDLE");
        }
    }, []);

    // Subscribe to state machine changes
    useEffect(() => {
        const unsubscribe = playbackStateMachine.subscribe((ctx) => {
            setPlaybackState(ctx.state);

            // Derive isPlaying and isBuffering from state machine
            // This creates a single source of truth
            const machineIsPlaying = ctx.state === "PLAYING";
            const machineIsBuffering = ctx.state === "BUFFERING" || ctx.state === "LOADING";

            // During LOADING, don't override isPlaying — preserve the play
            // intent that playTracks()/playTrack() set so the load-complete
            // handler knows to auto-play.  Without this guard the subscriber
            // forces isPlaying=false (LOADING ≠ PLAYING), which causes the
            // "click play twice" bug: the first click loads but never plays.
            if (ctx.state !== "LOADING") {
                setIsPlaying((prev) => prev !== machineIsPlaying ? machineIsPlaying : prev);
            }
            setIsBuffering((prev) => prev !== machineIsBuffering ? machineIsBuffering : prev);

            // Update error state
            if (ctx.state === "ERROR" && ctx.error) {
                setAudioError(ctx.error);
            } else if (ctx.state !== "ERROR" && audioError) {
                // Clear error when leaving error state
                setAudioError(null);
            }
        });

        return unsubscribe;
    }, [audioError]);

    // Seek lock state - prevents stale timeupdate events from overwriting optimistic UI updates
    const [isSeekLocked, setIsSeekLocked] = useState(false);
    const seekTargetRef = useRef<number | null>(null);
    const seekLockTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Lock the seek state - ignores timeupdate events until audio catches up or timeout
    const lockSeek = useCallback((targetTime: number) => {
        setIsSeekLocked(true);
        seekTargetRef.current = targetTime;

        // Clear any existing timeout
        if (seekLockTimeoutRef.current) {
            clearTimeout(seekLockTimeoutRef.current);
        }

        // Auto-unlock after 500ms as a safety measure
        seekLockTimeoutRef.current = setTimeout(() => {
            setIsSeekLocked(false);
            seekTargetRef.current = null;
            seekLockTimeoutRef.current = null;
        }, 500);
    }, []);

    // Unlock the seek state
    const unlockSeek = useCallback(() => {
        setIsSeekLocked(false);
        seekTargetRef.current = null;
        if (seekLockTimeoutRef.current) {
            clearTimeout(seekLockTimeoutRef.current);
            seekLockTimeoutRef.current = null;
        }
    }, []);

    // setCurrentTimeFromEngine - for timeupdate events from Howler
    // Respects seek lock to prevent stale updates causing flicker
    const setCurrentTimeFromEngine = useCallback(
        (time: number) => {
            if (isSeekLocked && seekTargetRef.current !== null) {
                // During seek, only accept updates that are close to our target
                // This prevents old positions from briefly showing during seek
                const isNearTarget = Math.abs(time - seekTargetRef.current) < 2;
                if (!isNearTarget) {
                    return; // Ignore stale position update
                }
                // Position is near target - seek completed, unlock
                setIsSeekLocked(false);
                seekTargetRef.current = null;
                if (seekLockTimeoutRef.current) {
                    clearTimeout(seekLockTimeoutRef.current);
                    seekLockTimeoutRef.current = null;
                }
            }
            setCurrentTime(time);
        },
        [isSeekLocked]
    );

    // currentTime and isHydrated are initialized via lazy useState from localStorage

    // Get state from AudioStateContext for position sync
    const state = useAudioState();

    useEffect(() => {
        currentTimeRef.current = currentTime;
    }, [currentTime]);

    useEffect(() => {
        if (!isHydrated || typeof window === "undefined") return;
        try {
            writeMigratingStorageItem(
                STORAGE_KEYS.IS_PLAYING,
                isPlaying ? "true" : "false"
            );
        } catch {
            // Ignore storage failures (private mode/quota/etc.)
        }
    }, [isHydrated, isPlaying]);

    // Restore explicit play/pause intent from persisted backend playback state.
    useEffect(() => {
        if (!isHydrated) return;

        let cancelled = false;
        void api
            .getPlaybackState()
            .then((serverState) => {
                if (cancelled) return;
                const resolvedIntent = resolveHydratedPlaybackIntent(
                    serverState,
                    initialIsPlayingRef.current
                );
                if (resolvedIntent !== initialIsPlayingRef.current) {
                    setIsPlaying(resolvedIntent);
                }
            })
            .catch(() => {
                // Best-effort startup hydration only.
            });

        return () => {
            cancelled = true;
        };
    }, [isHydrated]);

    // Sync currentTime from audiobook/podcast progress when not playing.
    useEffect(() => {
        if (!isHydrated || isPlaying) {
            return;
        }

        const audiobookProgress =
            state.playbackType === "audiobook"
                ? state.currentAudiobook?.progress?.currentTime
                : null;
        if (audiobookProgress) {
            setCurrentTime((prev) =>
                prev === audiobookProgress ? prev : audiobookProgress
            );
            return;
        }

        const podcastProgress =
            state.playbackType === "podcast"
                ? state.currentPodcast?.progress?.currentTime
                : null;
        if (podcastProgress) {
            setCurrentTime((prev) =>
                prev === podcastProgress ? prev : podcastProgress
            );
        }
    }, [
        isHydrated,
        isPlaying,
        state.playbackType,
        state.currentAudiobook?.progress?.currentTime,
        state.currentPodcast?.progress?.currentTime,
    ]);

    // Cleanup seek lock timeout on unmount
    useEffect(() => {
        return () => {
            if (seekLockTimeoutRef.current) {
                clearTimeout(seekLockTimeoutRef.current);
            }
        };
    }, []);

    // Save currentTime to localStorage (throttled to avoid excessive writes)
    useEffect(() => {
        if (!isHydrated || typeof window === "undefined") return;

        // Throttle saves to every 5 seconds using timestamp comparison
        const now = Date.now();
        if (now - lastSaveTimeRef.current < 5000) return;

        lastSaveTimeRef.current = now;
        try {
            writeMigratingStorageItem(
                STORAGE_KEYS.CURRENT_TIME,
                currentTime.toString()
            );
            if (state.playbackType === "track" && state.currentTrack?.id) {
                writeMigratingStorageItem(
                    STORAGE_KEYS.CURRENT_TIME_TRACK_ID,
                    state.currentTrack.id
                );
            }
        } catch (error) {
            console.error("[AudioPlayback] Failed to save currentTime:", error);
        }
    }, [
        currentTime,
        isHydrated,
        state.playbackType,
        state.currentTrack?.id,
    ]);

    // Reset persisted session time when switching tracks.
    useEffect(() => {
        if (!isHydrated || typeof window === "undefined") return;
        if (state.playbackType !== "track" || !state.currentTrack?.id) return;

        let storedTrackId: string | null = null;
        try {
            storedTrackId = readStorage(STORAGE_KEYS.CURRENT_TIME_TRACK_ID);
        } catch {
            storedTrackId = null;
        }

        if (storedTrackId !== state.currentTrack.id) {
            try {
                writeMigratingStorageItem(STORAGE_KEYS.CURRENT_TIME, "0");
                writeMigratingStorageItem(
                    STORAGE_KEYS.CURRENT_TIME_TRACK_ID,
                    state.currentTrack.id
                );
            } catch {
                // Ignore storage failures (private mode/quota/etc.)
            }
        }
    }, [isHydrated, state.playbackType, state.currentTrack?.id]);

    const savePlaybackProgressToServer = useCallback(
        async (force = false) => {
            if (!isHydrated || !state.playbackType) return;

            const now = Date.now();
            if (
                !force &&
                now - lastServerProgressSaveRef.current <
                    PLAYBACK_PROGRESS_SAVE_INTERVAL_MS
            ) {
                return;
            }

            const limitedQueue = state.queue?.slice(0, 100) || [];
            const adjustedIndex = Math.min(
                state.currentIndex,
                limitedQueue.length > 0 ? limitedQueue.length - 1 : 0
            );

            try {
                await api.savePlaybackState({
                    playbackType: state.playbackType,
                    trackId: state.currentTrack?.id,
                    audiobookId: state.currentAudiobook?.id,
                    podcastId: state.currentPodcast?.id,
                    queue: limitedQueue,
                    currentIndex: adjustedIndex,
                    isShuffle: state.isShuffle,
                    isPlaying,
                    currentTime: Math.max(0, currentTimeRef.current),
                });
                lastServerProgressSaveRef.current = now;
                writeMigratingStorageItem(
                    STORAGE_KEYS.LAST_PLAYBACK_STATE_SAVE_AT,
                    now.toString()
                );
            } catch (err) {
                // Ignore auth/state sync failures to avoid disrupting playback.
                if (err instanceof Error && err.message !== "Not authenticated") {
                    console.warn("[AudioPlayback] Failed to save playback progress:", err);
                }
            }
        },
        [
            isHydrated,
            state.playbackType,
            state.currentTrack?.id,
            state.currentAudiobook?.id,
            state.currentPodcast?.id,
            state.queue,
            state.currentIndex,
            state.isShuffle,
            isPlaying,
        ]
    );

    // Persist playback position periodically while playing.
    useEffect(() => {
        if (!isHydrated || !isPlaying || !state.playbackType) return;

        const intervalId = window.setInterval(() => {
            void savePlaybackProgressToServer(false);
        }, PLAYBACK_PROGRESS_SAVE_INTERVAL_MS);

        return () => window.clearInterval(intervalId);
    }, [isHydrated, isPlaying, state.playbackType, savePlaybackProgressToServer]);

    // Persist immediately when paused/stopped on a selected item.
    useEffect(() => {
        if (!isHydrated || !state.playbackType) return;
        if (isPlaying) return;
        void savePlaybackProgressToServer(true);
    }, [isHydrated, state.playbackType, isPlaying, savePlaybackProgressToServer]);

    // Best-effort persistence on tab close/navigation.
    useEffect(() => {
        if (!isHydrated) return;
        const handlePageHide = () => {
            void savePlaybackProgressToServer(true);
        };
        window.addEventListener("pagehide", handlePageHide);
        return () => {
            window.removeEventListener("pagehide", handlePageHide);
        };
    }, [isHydrated, savePlaybackProgressToServer]);

    // Memoize to prevent re-renders when values haven't changed
    const value = useMemo(
        () => ({
            isPlaying,
            currentTime,
            duration,
            isBuffering,
            targetSeekPosition,
            canSeek,
            downloadProgress,
            isSeekLocked,
            audioError,
            playbackState,
            setIsPlaying,
            setCurrentTime,
            setCurrentTimeFromEngine,
            setDuration,
            setIsBuffering,
            setTargetSeekPosition,
            setCanSeek,
            setDownloadProgress,
            lockSeek,
            unlockSeek,
            clearAudioError,
        }),
        [
            isPlaying,
            currentTime,
            duration,
            isBuffering,
            targetSeekPosition,
            canSeek,
            downloadProgress,
            isSeekLocked,
            audioError,
            playbackState,
            setCurrentTimeFromEngine,
            lockSeek,
            unlockSeek,
            clearAudioError,
        ]
    );

    return (
        <AudioPlaybackContext.Provider value={value}>
            {children}
        </AudioPlaybackContext.Provider>
    );
}

export function useAudioPlayback() {
    const context = useContext(AudioPlaybackContext);
    if (!context) {
        throw new Error(
            "useAudioPlayback must be used within AudioPlaybackProvider"
        );
    }
    return context;
}
