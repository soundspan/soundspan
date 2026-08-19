import { useRef } from "react";
import type { Track } from "@/lib/audio-state-context";
import { HeartbeatMonitor } from "@/lib/audio";
import { createConsecutiveErrorBreaker } from "@/lib/audio-engine/consecutiveErrorBreaker";
import { audioEngine } from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { TRACK_END_WATCHDOG_TIMEOUT_MS } from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import {
    createTrackEndWatchdog,
    type TrackEndWatchdog,
} from "../trackEndWatchdog";
import type {
    DesiredLoadPlayIntent,
    OrchestratorEngineEventHandlers,
} from "./audioPlaybackOrchestratorTypes";

interface UsePlaybackOrchestratorRefsOptions {
    currentTrack: Track | null;
    playbackType: "track" | "audiobook" | "podcast" | null;
    queueLength: number;
    isPlaying: boolean;
    volume: number;
    isMuted: boolean;
}

/** Owns the orchestrator's existing mutable refs in their original call order. */
export function usePlaybackOrchestratorRefs({
    currentTrack,
    playbackType,
    queueLength,
    isPlaying,
    volume,
    isMuted,
}: UsePlaybackOrchestratorRefsOptions) {
    // Refs
    const lastTrackIdRef = useRef<string | null>(null);
    const hasSeenTrackLoadRef = useRef<boolean>(false);
    const lastPlayingStateRef = useRef<boolean>(isPlaying);
    // Timestamp of the last track-end auto-advance. Declares that the next
    // load must autoplay regardless of transient isPlaying commits between
    // the element's pause/ended pair and the load effect (GH #53).
    const advancePlayIntentAtMsRef = useRef<number | null>(null);
    const progressSaveIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const lastProgressSaveRef = useRef<number>(0);
    const isUserInitiatedRef = useRef<boolean>(false);
    const isLoadingRef = useRef<boolean>(false);
    const outputStateRef = useRef<{ volume: number; isMuted: boolean }>({
        volume,
        isMuted,
    });
    // Loudness-normalization factor composited into the engine volume by
    // applyCurrentOutputState. Kept separate from outputStateRef because
    // that object is replaced wholesale by its writers.
    const loudnessGainFactorRef = useRef<number>(1);
    const loadIdRef = useRef<number>(0);
    const desiredLoadPlayRef = useRef<DesiredLoadPlayIntent | null>(null);
    const cancelledLoadPlayIdRef = useRef<number | null>(null);
    const cachePollingRef = useRef<NodeJS.Timeout | null>(null);
    const seekCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const cacheStatusPollingRef = useRef<NodeJS.Timeout | null>(null);
    const loadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const loadTimeoutRetryCountRef = useRef<number>(0);
    const seekReloadListenerRef = useRef<(() => void) | null>(null);
    const seekReloadInProgressRef = useRef<boolean>(false);
    // Track when a seek operation is in progress to prevent load effect from interfering
    const isSeekingRef = useRef<boolean>(false);
    // Track load listeners for cleanup to prevent memory leaks
    const loadListenerRef = useRef<(() => void) | null>(null);
    const loadErrorListenerRef = useRef<(() => void) | null>(null);
    const cachePollingLoadListenerRef = useRef<(() => void) | null>(null);
    // Counter to track seek operations and abort stale ones
    const seekOperationIdRef = useRef<number>(0);
    // Debounce timer for rapid podcast seeks
    const seekDebounceRef = useRef<NodeJS.Timeout | null>(null);
    const pendingSeekTimeRef = useRef<number | null>(null);
    // Preload management
    const lastPreloadedTrackIdRef = useRef<string | null>(null);
    const pendingTrackErrorSkipRef = useRef<NodeJS.Timeout | null>(null);
    const pendingTrackErrorTrackIdRef = useRef<string | null>(null);
    const trackErrorAdvanceFromTrackIdRef = useRef<string | null>(null);
    const consecutiveErrorBreakerRef = useRef(createConsecutiveErrorBreaker());
    // Snapshot of whether the audio engine was playing at the moment the page
    // went hidden (visibilitychange → "hidden"). Used by foreground recovery
    // to decide if playback should be retried on return to visible.
    // This prevents spurious recovery on desktop when a user pauses then
    // switches tabs (the old hadPlayIntent ref was never cleared on pause).
    const wasPlayingWhenHiddenRef = useRef(false);
    const currentTrackRef = useRef(currentTrack);
    const currentTimeSnapshotRef = useRef<number>(0);
    const currentTimeSnapshotTrackIdRef = useRef<string | null>(
        playbackType === "track" ? (currentTrack?.id ?? null) : null,
    );
    const queueLengthRef = useRef(queueLength);
    const playbackTypeRef = useRef(playbackType);
    const lastLoggedRemotePlayKeyRef = useRef<string | null>(null);
    const activeEngineTrackIdRef = useRef<string | null>(null);
    const activeEngineLoadIdRef = useRef<number>(-1);
    const engineEventHandlersRef =
        useRef<OrchestratorEngineEventHandlers | null>(null);
    const recoverablePlayErrorPendingRef = useRef<boolean>(false);
    const startupRecoveryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const startupRecoveryLoadListenerRef = useRef<(() => void) | null>(null);
    const startupRecoveryAttemptedTrackIdRef = useRef<string | null>(null);
    const unexpectedPauseRecoveryTimeoutRef = useRef<NodeJS.Timeout | null>(
        null,
    );
    // eslint-disable-next-line react-hooks/purity -- Preserve the relocated timestamp ref initialization.
    const lastTrackTimeUpdateAtMsRef = useRef<number>(Date.now());
    const transientTrackRecoveryTimeoutRef = useRef<NodeJS.Timeout | null>(
        null,
    );
    const transientTrackRecoveryLoadListenerRef = useRef<(() => void) | null>(
        null,
    );
    const transientTrackRecoveryTrackIdRef = useRef<string | null>(null);
    const transientTrackRecoveryAttemptRef = useRef<number>(0);
    const transientTrackRecoveryWindowStartedAtRef = useRef<number>(0);
    const autoMatchVibePromiseRef = useRef<Promise<boolean> | null>(null);
    const autoMatchVibeTrackIdRef = useRef<string | null>(null);
    const autoMatchVibeLastAttemptAtRef = useRef<number>(0);
    // YouTube Music: prefer authenticated stream when user has OAuth,
    // fall back to public stream otherwise.
    const ytMusicAuthenticatedRef = useRef<boolean>(false);
    const startupStabilityRef = useRef<{
        trackId: string | null;
        firstProgressAtMs: number | null;
        lastObservedProgressSec: number;
    }>({
        trackId: null,
        firstProgressAtMs: null,
        lastObservedProgressSec: 0,
    });
    const unexpectedStopStartupGuardRef = useRef<{
        trackId: string | null;
        suppressUntilMs: number;
        reason: string | null;
    }>({
        trackId: null,
        suppressUntilMs: 0,
        reason: null,
    });
    const lastHandledTrackEndRef = useRef<{
        trackId: string | null;
        loadId: number;
        handledAtMs: number;
    }>({
        trackId: null,
        loadId: -1,
        handledAtMs: 0,
    });
    const trackEndWatchdogRef = useRef<TrackEndWatchdog | null>(null);
    // eslint-disable-next-line react-hooks/refs -- Preserve the relocated one-time watchdog initialization.
    if (!trackEndWatchdogRef.current) {
        // eslint-disable-next-line react-hooks/refs -- Preserve the relocated one-time watchdog initialization.
        trackEndWatchdogRef.current = createTrackEndWatchdog({
            timeoutMs: TRACK_END_WATCHDOG_TIMEOUT_MS,
            shouldHandle: (snapshot) => {
                const lastHandled = lastHandledTrackEndRef.current;
                const endWasAlreadyHandled =
                    lastHandled.trackId === snapshot.trackId &&
                    lastHandled.loadId === snapshot.loadId;
                const sourceStillMatches =
                    currentTrackRef.current?.id === snapshot.trackId &&
                    loadIdRef.current === snapshot.loadId &&
                    activeEngineTrackIdRef.current === snapshot.trackId &&
                    activeEngineLoadIdRef.current === snapshot.loadId;
                return (
                    snapshot.statusWasPlaying &&
                    playbackTypeRef.current === "track" &&
                    !isLoadingRef.current &&
                    !endWasAlreadyHandled &&
                    sourceStillMatches &&
                    audioEngine.hasTrackEnded()
                );
            },
            onUnhandledEnd: () => {
                engineEventHandlersRef.current?.handleEnd(true);
            },
        });
    }
    const howlerLoadStartMsRef = useRef<number>(0);

    // Heartbeat monitor for detecting stalled playback
    const heartbeatRef = useRef<HeartbeatMonitor | null>(null);
    const listenTogetherFollowerRecoveryRef = useRef<{
        groupId: string | null;
        inFlight: boolean;
        lastRequestedAtMs: number;
    }>({
        groupId: null,
        inFlight: false,
        lastRequestedAtMs: 0,
    });

    return {
        lastTrackIdRef,
        hasSeenTrackLoadRef,
        lastPlayingStateRef,
        advancePlayIntentAtMsRef,
        progressSaveIntervalRef,
        lastProgressSaveRef,
        isUserInitiatedRef,
        isLoadingRef,
        outputStateRef,
        loudnessGainFactorRef,
        loadIdRef,
        desiredLoadPlayRef,
        cancelledLoadPlayIdRef,
        cachePollingRef,
        seekCheckTimeoutRef,
        cacheStatusPollingRef,
        loadTimeoutRef,
        loadTimeoutRetryCountRef,
        seekReloadListenerRef,
        seekReloadInProgressRef,
        isSeekingRef,
        loadListenerRef,
        loadErrorListenerRef,
        cachePollingLoadListenerRef,
        seekOperationIdRef,
        seekDebounceRef,
        pendingSeekTimeRef,
        lastPreloadedTrackIdRef,
        pendingTrackErrorSkipRef,
        pendingTrackErrorTrackIdRef,
        trackErrorAdvanceFromTrackIdRef,
        consecutiveErrorBreakerRef,
        wasPlayingWhenHiddenRef,
        currentTrackRef,
        currentTimeSnapshotRef,
        currentTimeSnapshotTrackIdRef,
        queueLengthRef,
        playbackTypeRef,
        lastLoggedRemotePlayKeyRef,
        activeEngineTrackIdRef,
        activeEngineLoadIdRef,
        engineEventHandlersRef,
        recoverablePlayErrorPendingRef,
        startupRecoveryTimeoutRef,
        startupRecoveryLoadListenerRef,
        startupRecoveryAttemptedTrackIdRef,
        unexpectedPauseRecoveryTimeoutRef,
        lastTrackTimeUpdateAtMsRef,
        transientTrackRecoveryTimeoutRef,
        transientTrackRecoveryLoadListenerRef,
        transientTrackRecoveryTrackIdRef,
        transientTrackRecoveryAttemptRef,
        transientTrackRecoveryWindowStartedAtRef,
        autoMatchVibePromiseRef,
        autoMatchVibeTrackIdRef,
        autoMatchVibeLastAttemptAtRef,
        ytMusicAuthenticatedRef,
        startupStabilityRef,
        unexpectedStopStartupGuardRef,
        lastHandledTrackEndRef,
        trackEndWatchdogRef,
        howlerLoadStartMsRef,
        heartbeatRef,
        listenTogetherFollowerRecoveryRef,
    };
}

export type PlaybackOrchestratorRefs = ReturnType<
    typeof usePlaybackOrchestratorRefs
>;
