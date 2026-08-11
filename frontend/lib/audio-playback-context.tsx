"use client";

import {
    createContext,
    useContext,
    useState,
    useEffect,
    useLayoutEffect,
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
import {
    resolveHydratedPlaybackIntent,
    resolveMachinePlaybackIntent,
} from "@/lib/playback-intent";
import { clampNonNegativePlaybackTime } from "@/lib/audio-playback-normalization";
import { frontendLogger as sharedFrontendLogger } from "@/lib/logger";
import {
    isPlaybackSelectionMatch,
    resolveTrackPersistenceEpoch,
    shouldAcceptEngineTimeUpdate,
    type ActivePlaybackSelection,
    type PlaybackPersistenceSnapshot,
} from "@/lib/audio-playback-persistence-guards";
import {
    isEngineTickDiscontinuity,
    shouldPublishClockTime,
} from "@/lib/audio-clock-policy";

export interface PlaybackStreamProfile {
    mode: "direct" | "dash";
    sourceType: "local" | "tidal" | "ytmusic" | "unknown";
    codec: string | null;
    bitrateKbps: number | null;
}

/** Composite playback state retained for backward-compatible consumers. */
export interface AudioPlaybackContextType {
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
    streamProfile: PlaybackStreamProfile | null;
    setIsPlaying: (playing: boolean) => void;
    setCurrentTime: (time: number) => void;
    setCurrentTimeFromEngine: (
        time: number,
        invocationTrackId?: string | null,
    ) => void; // For timeupdate events - respects seek lock and active track guards
    setDuration: (duration: number) => void;
    setIsBuffering: (buffering: boolean) => void;
    setTargetSeekPosition: (position: number | null) => void;
    setCanSeek: (canSeek: boolean) => void;
    setDownloadProgress: (progress: number | null) => void;
    setStreamProfile: (profile: PlaybackStreamProfile | null) => void;
    lockSeek: (targetTime: number) => void; // Lock updates during seek
    unlockSeek: () => void; // Unlock after seek completes
    clearAudioError: () => void; // Clear the audio error state
}

/** Playback progress values that change on published clock ticks. */
export interface PlaybackProgressContextType {
    currentTime: number;
}

/** Playback status values and setters that do not depend on currentTime. */
export interface PlaybackStatusContextType {
    isPlaying: boolean;
    duration: number;
    isBuffering: boolean;
    targetSeekPosition: number | null;
    canSeek: boolean;
    downloadProgress: number | null;
    isSeekLocked: boolean;
    audioError: string | null;
    playbackState: PlaybackState;
    streamProfile: PlaybackStreamProfile | null;
    setIsPlaying: (playing: boolean) => void;
    setCurrentTime: (time: number) => void;
    setCurrentTimeFromEngine: (
        time: number,
        invocationTrackId?: string | null,
    ) => void;
    setDuration: (duration: number) => void;
    setIsBuffering: (buffering: boolean) => void;
    setTargetSeekPosition: (position: number | null) => void;
    setCanSeek: (canSeek: boolean) => void;
    setDownloadProgress: (progress: number | null) => void;
    setStreamProfile: (profile: PlaybackStreamProfile | null) => void;
    lockSeek: (targetTime: number) => void;
    unlockSeek: () => void;
    clearAudioError: () => void;
}

const PlaybackProgressContext = createContext<
    PlaybackProgressContextType | undefined
>(undefined);
const PlaybackStatusContext = createContext<
    PlaybackStatusContextType | undefined
>(undefined);

// LocalStorage keys
const STORAGE_KEYS = {
    IS_PLAYING: createMigratingStorageKey("is_playing"),
    CURRENT_TIME: createMigratingStorageKey("current_time"),
    CURRENT_TIME_TRACK_ID: createMigratingStorageKey("current_time_track_id"),
    LAST_PLAYBACK_STATE_SAVE_AT: createMigratingStorageKey(
        LAST_PLAYBACK_STATE_SAVE_AT_KEY_SUFFIX,
    ),
};

function readStorage(key: MigratingStorageKey): string | null {
    return readMigratingStorageItem(key);
}

// ActivePlaybackSelection and PlaybackPersistenceSnapshot are imported from
// @/lib/audio-playback-persistence-guards

/**
 * Renders the AudioPlaybackProvider component.
 */
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
        } catch {
            return 0;
        }
    });
    const [duration, setDuration] = useState(0);
    const [isBuffering, setIsBuffering] = useState(false);
    const [targetSeekPosition, setTargetSeekPosition] = useState<number | null>(
        null,
    );
    const [canSeek, setCanSeek] = useState(true); // Default true for music, false for uncached podcasts
    const [downloadProgress, setDownloadProgress] = useState<number | null>(
        null,
    );
    const [audioError, setAudioError] = useState<string | null>(null);
    const [playbackState, setPlaybackState] = useState<PlaybackState>("IDLE");
    const [streamProfile, setStreamProfile] =
        useState<PlaybackStreamProfile | null>(null);
    const [isHydrated] = useState(() => typeof window !== "undefined");
    const lastSaveTimeRef = useRef<number>(0);
    const lastServerProgressSaveRef = useRef<number>(0);
    const initialIsPlayingRef = useRef(isPlaying);
    // Authoritative FULL-PRECISION clock. Written on every accepted engine tick
    // and by every discontinuity publish; read by server-progress persistence
    // (savePlaybackProgressToServer) and seek-target matching. This must NEVER be
    // regressed to the coarser published state value (roadmap F12 ref-sync trap).
    const currentTimeRef = useRef<number>(currentTime);
    // Last value published to React state, tracked at full precision so the
    // publish gate can compare display-second (Math.floor) boundaries without
    // reading the (intentionally stale, up-to-1s-behind) currentTime state.
    const lastPublishedTimeRef = useRef<number>(currentTime);
    const state = useAudioState();
    const initialTrackId =
        state.playbackType === "track"
            ? (state.currentTrack?.id ?? null)
            : null;
    const lastTrackIdentityRef = useRef<{
        playbackType: "track" | "audiobook" | "podcast" | null;
        trackId: string | null;
    }>({
        playbackType: state.playbackType,
        trackId: initialTrackId,
    });
    const trackPersistenceEpochRef = useRef<number>(0);
    const [trackPersistenceEpoch, setTrackPersistenceEpoch] = useState(0);
    const activePlaybackSelectionRef = useRef<ActivePlaybackSelection>({
        playbackType: state.playbackType,
        trackId: initialTrackId,
        audiobookId: state.currentAudiobook?.id ?? null,
        podcastId: state.currentPodcast?.id ?? null,
        trackEpoch: 0,
    });
    const lastTrackResetEpochRef = useRef<number>(0);

    useLayoutEffect(() => {
        const activeTrackId =
            state.playbackType === "track"
                ? (state.currentTrack?.id ?? null)
                : null;
        const previousTrackIdentity = lastTrackIdentityRef.current;
        let nextTrackEpoch = trackPersistenceEpochRef.current;

        if (
            previousTrackIdentity.playbackType !== state.playbackType ||
            previousTrackIdentity.trackId !== activeTrackId
        ) {
            if (
                previousTrackIdentity.playbackType === "track" ||
                state.playbackType === "track"
            ) {
                nextTrackEpoch += 1;
                trackPersistenceEpochRef.current = nextTrackEpoch;
                setTrackPersistenceEpoch(nextTrackEpoch);
            }
            lastTrackIdentityRef.current = {
                playbackType: state.playbackType,
                trackId: activeTrackId,
            };
        }

        activePlaybackSelectionRef.current = {
            playbackType: state.playbackType,
            trackId: activeTrackId,
            audiobookId: state.currentAudiobook?.id ?? null,
            podcastId: state.currentPodcast?.id ?? null,
            trackEpoch: nextTrackEpoch,
        };
    }, [
        state.playbackType,
        state.currentTrack?.id,
        state.currentAudiobook?.id,
        state.currentPodcast?.id,
    ]);

    const isPersistenceSnapshotActive = useCallback(
        (snapshot: PlaybackPersistenceSnapshot): boolean => {
            return isPlaybackSelectionMatch(
                snapshot,
                activePlaybackSelectionRef.current,
            );
        },
        [],
    );

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

            // Derive playback flags from state machine. Transitional states
            // preserve prior play intent to avoid pause/reload loops.
            const machineIsBuffering =
                ctx.state === "BUFFERING" ||
                ctx.state === "LOADING" ||
                ctx.state === "RECOVERING";

            setIsPlaying((prev) => {
                const nextIsPlaying = resolveMachinePlaybackIntent(
                    ctx.state,
                    prev,
                );
                return prev !== nextIsPlaying ? nextIsPlaying : prev;
            });
            setIsBuffering((prev) =>
                prev !== machineIsBuffering ? machineIsBuffering : prev,
            );

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

    // publishCurrentTime - the discontinuity clock setter exposed to the rest of
    // the app (seek, updateCurrentTime, track-start / resume in the controls
    // context and orchestrator). It writes the full-precision ref FIRST (so a
    // concurrent progress save reads the correct value) and then publishes to
    // state. Every non-engine setCurrentTime call is a discontinuity, so these
    // always publish. This replaces the removed state->ref sync effect for all
    // external callers (roadmap F12 ref-sync trap).
    const publishCurrentTime = useCallback((time: number) => {
        currentTimeRef.current = time;
        lastPublishedTimeRef.current = time;
        setCurrentTime(time);
    }, []);

    // setCurrentTimeFromEngine - for timeupdate events from Howler (4x/sec).
    // Three ORDERED stages (order is correctness-critical, roadmap F12):
    //   (i)  guard on RAW engine time — a rejected tick writes NEITHER ref NOR
    //        state (prevents seek-lock flap and post-track-change stale writes);
    //   (ii) any non-rejected tick (accept OR unlock-accept) updates the
    //        full-precision ref unconditionally;
    //   (iii) publish to state only when the displayed second changes, or when a
    //        discontinuity (seek unlock) forces it — quantizing the 4Hz clock to
    //        ~1Hz of setState churn while keeping the ref continuously fresh.
    const setCurrentTimeFromEngine = useCallback(
        (time: number, invocationTrackId: string | null = null) => {
            // Stage (i): reject on RAW time before any write.
            const decision = shouldAcceptEngineTimeUpdate(
                invocationTrackId,
                activePlaybackSelectionRef.current,
                { isSeekLocked, seekTarget: seekTargetRef.current },
                time,
            );
            if (decision === "reject") {
                return;
            }
            if (decision === "unlock-accept") {
                setIsSeekLocked(false);
                seekTargetRef.current = null;
                if (seekLockTimeoutRef.current) {
                    clearTimeout(seekLockTimeoutRef.current);
                    seekLockTimeoutRef.current = null;
                }
            }
            // Stage (ii): full-precision ref tracks every accepted tick.
            currentTimeRef.current = time;
            // Stage (iii): gated state publish (display-second granularity).
            if (
                shouldPublishClockTime({
                    time,
                    lastPublishedTime: lastPublishedTimeRef.current,
                    forcePublish: isEngineTickDiscontinuity(decision),
                })
            ) {
                lastPublishedTimeRef.current = time;
                setCurrentTime(time);
            }
        },
        [isSeekLocked],
    );

    // currentTime and isHydrated are initialized via lazy useState from localStorage.
    // NOTE: the former `currentTimeRef.current = currentTime` sync effect was
    // removed — it clobbered the fresh full-precision ref with the quantized
    // (up-to-1s-stale) published state. The ref is now written directly at every
    // authoritative point instead: init, accepted engine ticks (stage ii),
    // publishCurrentTime (all discontinuity/external setters), and the
    // track-change reset below.

    useEffect(() => {
        if (!isHydrated || typeof window === "undefined") return;
        try {
            writeMigratingStorageItem(
                STORAGE_KEYS.IS_PLAYING,
                isPlaying ? "true" : "false",
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
                    initialIsPlayingRef.current,
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
            // Discontinuity (resume-from-restore): publishCurrentTime forces the
            // publish AND keeps the full-precision ref in sync (React bails out of
            // the state update when the value is unchanged).
            publishCurrentTime(audiobookProgress);
            return;
        }

        const podcastProgress =
            state.playbackType === "podcast"
                ? state.currentPodcast?.progress?.currentTime
                : null;
        if (podcastProgress) {
            publishCurrentTime(podcastProgress);
        }
    }, [
        isHydrated,
        isPlaying,
        state.playbackType,
        state.currentAudiobook?.progress?.currentTime,
        state.currentPodcast?.progress?.currentTime,
        publishCurrentTime,
    ]);

    // Cleanup seek lock timeout on unmount
    useEffect(() => {
        return () => {
            if (seekLockTimeoutRef.current) {
                clearTimeout(seekLockTimeoutRef.current);
            }
        };
    }, []);

    // Strictly invalidate persisted track position as soon as active track changes.
    useEffect(() => {
        if (!isHydrated || typeof window === "undefined") return;
        if (state.playbackType !== "track" || !state.currentTrack?.id) return;

        const currentTrackEpoch = resolveTrackPersistenceEpoch(
            trackPersistenceEpoch,
            trackPersistenceEpochRef.current,
        );
        if (currentTrackEpoch === lastTrackResetEpochRef.current) return;
        lastTrackResetEpochRef.current = currentTrackEpoch;
        currentTimeRef.current = 0;
        lastPublishedTimeRef.current = 0;
        setCurrentTime((prev) => (prev === 0 ? prev : 0));
        lastSaveTimeRef.current = 0;

        try {
            writeMigratingStorageItem(STORAGE_KEYS.CURRENT_TIME, "0");
            writeMigratingStorageItem(
                STORAGE_KEYS.CURRENT_TIME_TRACK_ID,
                state.currentTrack.id,
            );
        } catch {
            // Ignore storage failures (private mode/quota/etc.)
        }
    }, [
        isHydrated,
        state.playbackType,
        state.currentTrack?.id,
        trackPersistenceEpoch,
    ]);

    // Save currentTime to localStorage (throttled to avoid excessive writes)
    useEffect(() => {
        if (!isHydrated || typeof window === "undefined") return;
        const invocationTrackId =
            state.playbackType === "track"
                ? (state.currentTrack?.id ?? null)
                : null;
        const invocationTrackEpoch = resolveTrackPersistenceEpoch(
            trackPersistenceEpoch,
            trackPersistenceEpochRef.current,
        );
        const activeSelection = activePlaybackSelectionRef.current;
        if (state.playbackType === "track") {
            if (
                !invocationTrackId ||
                activeSelection.playbackType !== "track" ||
                activeSelection.trackId !== invocationTrackId ||
                activeSelection.trackEpoch !== invocationTrackEpoch
            ) {
                return;
            }
        }

        // Throttle saves to every 5 seconds using timestamp comparison
        const now = Date.now();
        if (now - lastSaveTimeRef.current < 5000) return;

        lastSaveTimeRef.current = now;
        try {
            // Write the FULL-PRECISION ref, not the quantized `currentTime`
            // state: AudioPlaybackOrchestrator reads this key on initial track
            // load to compute the engine's resume startTime, so writing the
            // published state would regress resume-after-reload precision from
            // ~250ms to ~1s. `currentTime` stays in the dep array purely as the
            // ~1Hz re-check trigger; the ref is fresh at write time. Mirrors
            // savePlaybackProgressToServer, which reads the same ref.
            writeMigratingStorageItem(
                STORAGE_KEYS.CURRENT_TIME,
                currentTimeRef.current.toString(),
            );
            if (state.playbackType === "track" && invocationTrackId) {
                writeMigratingStorageItem(
                    STORAGE_KEYS.CURRENT_TIME_TRACK_ID,
                    invocationTrackId,
                );
            }
        } catch (error) {
            sharedFrontendLogger.error(
                "[AudioPlayback] Failed to save currentTime:",
                error,
            );
        }
    }, [
        currentTime,
        isHydrated,
        state.playbackType,
        state.currentTrack?.id,
        trackPersistenceEpoch,
    ]);

    // Ref for reading audio state inside the stable savePlaybackProgressToServer callback.
    const audioStateRef = useRef(state);
    useEffect(() => {
        audioStateRef.current = state;
    }, [state]);
    const progressSaveInFlightRef = useRef(false);

    const savePlaybackProgressToServer = useCallback(
        async (force = false) => {
            if (!isHydrated || !state.playbackType) return;
            if (progressSaveInFlightRef.current) return;

            const invocationSnapshot: PlaybackPersistenceSnapshot = {
                playbackType: state.playbackType,
                trackId: state.currentTrack?.id ?? null,
                audiobookId: state.currentAudiobook?.id ?? null,
                podcastId: state.currentPodcast?.id ?? null,
                trackEpoch: resolveTrackPersistenceEpoch(
                    trackPersistenceEpoch,
                    trackPersistenceEpochRef.current,
                ),
            };
            if (
                invocationSnapshot.playbackType === "track" &&
                !invocationSnapshot.trackId
            ) {
                return;
            }
            if (!isPersistenceSnapshotActive(invocationSnapshot)) return;

            const now = Date.now();
            if (
                !force &&
                now - lastServerProgressSaveRef.current <
                    PLAYBACK_PROGRESS_SAVE_INTERVAL_MS
            ) {
                return;
            }

            // Read queue/currentIndex/isShuffle from ref for stable callback identity
            const currentAudioState = audioStateRef.current;
            const queueWindowStart = Math.max(
                0,
                currentAudioState.currentIndex - 10,
            );
            const limitedQueue =
                currentAudioState.queue?.slice(
                    queueWindowStart,
                    queueWindowStart + 100,
                ) || [];
            const adjustedIndex =
                currentAudioState.currentIndex - queueWindowStart;
            const hasConsistentQueuePosition =
                invocationSnapshot.playbackType !== "track" ||
                limitedQueue[adjustedIndex]?.id === invocationSnapshot.trackId;

            const queuePositionPayload = hasConsistentQueuePosition
                ? {
                      queue: limitedQueue,
                      currentIndex: adjustedIndex,
                  }
                : {};

            progressSaveInFlightRef.current = true;
            try {
                if (!isPersistenceSnapshotActive(invocationSnapshot)) return;
                await api.savePlaybackState({
                    playbackType: invocationSnapshot.playbackType,
                    trackId: invocationSnapshot.trackId ?? undefined,
                    audiobookId: invocationSnapshot.audiobookId ?? undefined,
                    podcastId: invocationSnapshot.podcastId ?? undefined,
                    ...queuePositionPayload,
                    isShuffle: currentAudioState.isShuffle,
                    isPlaying,
                    currentTime: clampNonNegativePlaybackTime(
                        currentTimeRef.current,
                    ),
                });
                if (!isPersistenceSnapshotActive(invocationSnapshot)) return;
                lastServerProgressSaveRef.current = now;
                writeMigratingStorageItem(
                    STORAGE_KEYS.LAST_PLAYBACK_STATE_SAVE_AT,
                    now.toString(),
                );
            } catch (err) {
                // Ignore auth/state sync failures to avoid disrupting playback.
                if (
                    err instanceof Error &&
                    err.message !== "Not authenticated"
                ) {
                    sharedFrontendLogger.warn(
                        "[AudioPlayback] Failed to save playback progress:",
                        err,
                    );
                }
            } finally {
                progressSaveInFlightRef.current = false;
            }
        },
        [
            isHydrated,
            state.playbackType,
            state.currentTrack?.id,
            state.currentAudiobook?.id,
            state.currentPodcast?.id,
            isPlaying,
            trackPersistenceEpoch,
            isPersistenceSnapshotActive,
        ],
    );

    // Persist playback position periodically while playing.
    useEffect(() => {
        if (!isHydrated || !isPlaying || !state.playbackType) return;

        const intervalId = window.setInterval(() => {
            void savePlaybackProgressToServer(false);
        }, PLAYBACK_PROGRESS_SAVE_INTERVAL_MS);

        return () => window.clearInterval(intervalId);
    }, [
        isHydrated,
        isPlaying,
        state.playbackType,
        savePlaybackProgressToServer,
    ]);

    // Persist immediately when paused/stopped on a selected item.
    useEffect(() => {
        if (!isHydrated || !state.playbackType) return;
        if (isPlaying) return;
        void savePlaybackProgressToServer(true);
    }, [
        isHydrated,
        state.playbackType,
        isPlaying,
        savePlaybackProgressToServer,
    ]);

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

    const progressValue = useMemo(() => ({ currentTime }), [currentTime]);

    // Memoize to prevent re-renders when values haven't changed
    const statusValue = useMemo(
        () => ({
            isPlaying,
            duration,
            isBuffering,
            targetSeekPosition,
            canSeek,
            downloadProgress,
            isSeekLocked,
            audioError,
            playbackState,
            streamProfile,
            setIsPlaying,
            // Exposed under the stable public name; routes every external setter
            // through the ref-syncing full-precision publisher (roadmap F12).
            setCurrentTime: publishCurrentTime,
            setCurrentTimeFromEngine,
            setDuration,
            setIsBuffering,
            setTargetSeekPosition,
            setCanSeek,
            setDownloadProgress,
            setStreamProfile,
            lockSeek,
            unlockSeek,
            clearAudioError,
        }),
        [
            isPlaying,
            duration,
            isBuffering,
            targetSeekPosition,
            canSeek,
            downloadProgress,
            isSeekLocked,
            audioError,
            playbackState,
            streamProfile,
            publishCurrentTime,
            setCurrentTimeFromEngine,
            lockSeek,
            unlockSeek,
            clearAudioError,
        ],
    );

    return (
        <PlaybackStatusContext.Provider value={statusValue}>
            <PlaybackProgressContext.Provider value={progressValue}>
                {children}
            </PlaybackProgressContext.Provider>
        </PlaybackStatusContext.Provider>
    );
}

/**
 * Reads playback status and playback setter state.
 */
export function usePlaybackStatus(): PlaybackStatusContextType {
    const context = useContext(PlaybackStatusContext);
    if (!context) {
        throw new Error(
            "usePlaybackStatus must be used within AudioPlaybackProvider",
        );
    }
    return context;
}

/**
 * Reads the current playback progress.
 */
export function usePlaybackProgress(): PlaybackProgressContextType {
    const context = useContext(PlaybackProgressContext);
    if (!context) {
        throw new Error(
            "usePlaybackProgress must be used within AudioPlaybackProvider",
        );
    }
    return context;
}

/**
 * Reads the composite playback context.
 *
 * @deprecated Use usePlaybackStatus and usePlaybackProgress instead.
 */
export function useAudioPlayback(): AudioPlaybackContextType {
    const status = useContext(PlaybackStatusContext);
    const progress = useContext(PlaybackProgressContext);
    const composite = useMemo(
        () =>
            status && progress
                ? { ...status, currentTime: progress.currentTime }
                : null,
        [status, progress],
    );
    if (!composite) {
        throw new Error(
            "useAudioPlayback must be used within AudioPlaybackProvider",
        );
    }
    return composite;
}
