import { useRef } from "react";
import type { SegmentedStreamingSessionResponse } from "@/lib/api";
import type { Track } from "@/lib/audio-state-context";
import { HeartbeatMonitor } from "@/lib/audio";
import { createConsecutiveErrorBreaker } from "@/lib/audio-engine/consecutiveErrorBreaker";
import { audioEngine } from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import { TRACK_END_WATCHDOG_TIMEOUT_MS } from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import { createEmptySegmentedStartupRecoveryStageAttempts } from "../audioPlaybackOrchestratorPolicy";
import {
    createTrackEndWatchdog,
    type TrackEndWatchdog,
} from "../trackEndWatchdog";
import type {
    ActiveSegmentedSessionSnapshot,
    DesiredLoadPlayIntent,
    OrchestratorEngineEventHandlers,
    SegmentedHandoffListenerRegistration,
    SegmentedStartupTimelineSnapshot,
    StartupSegmentedSessionSnapshot,
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
    const loadIdRef = useRef<number>(0);
    const desiredLoadPlayRef = useRef<DesiredLoadPlayIntent | null>(null);
    const cancelledLoadPlayIdRef = useRef<number | null>(null);
    const cachePollingRef = useRef<NodeJS.Timeout | null>(null);
    const seekCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const cacheStatusPollingRef = useRef<NodeJS.Timeout | null>(null);
    const loadTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const segmentedStartupFallbackTimeoutRef = useRef<NodeJS.Timeout | null>(
        null,
    );
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
    const prewarmedSegmentedSessionRef = useRef<
        Map<string, SegmentedStreamingSessionResponse>
    >(new Map());
    const segmentedPrewarmInFlightRef = useRef<Set<string>>(new Set());
    const segmentedPrewarmRetryTimeoutsRef = useRef<
        Map<string, NodeJS.Timeout>
    >(new Map());
    const segmentedPrewarmValidationInFlightRef = useRef<Set<string>>(
        new Set(),
    );
    const segmentedPrewarmValidationAbortControllersRef = useRef<
        Map<string, AbortController>
    >(new Map());
    const segmentedPrewarmValidationSessionByKeyRef = useRef<
        Map<string, string>
    >(new Map());
    const segmentedPrewarmValidatedSessionIdsRef = useRef<Set<string>>(
        new Set(),
    );
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
    const segmentedManifestNudgeTimeoutsRef = useRef<NodeJS.Timeout[]>([]);
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
    const activeSegmentedSessionRef =
        useRef<ActiveSegmentedSessionSnapshot | null>(null);
    const activeSegmentedPlaybackTrackIdRef = useRef<string | null>(null);
    const segmentedHandoffInProgressRef = useRef<boolean>(false);
    const segmentedHandoffAttemptRef = useRef<number>(0);
    const segmentedHandoffLastAttemptAtRef = useRef<number>(0);
    const segmentedSessionCreateFallbackAttemptRef = useRef<number>(0);
    const segmentedSessionCreateFallbackLastAttemptAtRef = useRef<number>(0);
    const segmentedChunkQuarantineRef = useRef<Map<string, number>>(new Map());
    const segmentedChunkQuarantineLastRecoveryAtRef = useRef<number>(0);
    const segmentedLastFailedChunkRef = useRef<{
        trackId: string | null;
        sessionId: string | null;
        chunkName: string | null;
        statusCode: number | null;
        observedAtMs: number;
    }>({
        trackId: null,
        sessionId: null,
        chunkName: null,
        statusCode: null,
        observedAtMs: 0,
    });
    const segmentedHandoffCircuitRef = useRef<{
        trackId: string | null;
        windowStartedAtMs: number;
        attempts: number;
    }>({
        trackId: null,
        windowStartedAtMs: 0,
        attempts: 0,
    });
    const segmentedHandoffLastRecoveryRef = useRef<{
        trackId: string | null;
        resumeAtSec: number;
        recoveredAtMs: number;
    }>({
        trackId: null,
        resumeAtSec: 0,
        recoveredAtMs: 0,
    });
    const segmentedProactiveHandoffAttemptedTrackIdRef = useRef<string | null>(
        null,
    );
    const segmentedProactiveHandoffAttemptCountRef = useRef<number>(0);
    const segmentedProactiveHandoffLastAttemptAtRef = useRef<number>(0);
    const segmentedProactiveHandoffCompletedTrackIdRef = useRef<string | null>(
        null,
    );
    const segmentedProactiveHandoffLastSkipKeyRef = useRef<string | null>(null);
    const startupSegmentedSessionRef =
        useRef<StartupSegmentedSessionSnapshot | null>(null);
    const startupSegmentedSessionInFlightRef = useRef<Set<string>>(new Set());
    const startupSegmentedSessionPromisesRef = useRef<
        Map<string, Promise<SegmentedStreamingSessionResponse | null>>
    >(new Map());
    const segmentedStartupRetryCountRef = useRef<number>(0);
    const segmentedStartupStageAttemptsRef = useRef(
        createEmptySegmentedStartupRecoveryStageAttempts(),
    );
    const segmentedStartupRecoveryWindowStartedAtMsRef = useRef<number | null>(
        null,
    );
    const segmentedStartupSessionResetCountRef = useRef<number>(0);
    const segmentedStartupTimelineRef =
        useRef<SegmentedStartupTimelineSnapshot | null>(null);
    const segmentedStartupStabilityRef = useRef<{
        trackId: string | null;
        firstProgressAtMs: number | null;
        lastObservedProgressSec: number;
    }>({
        trackId: null,
        firstProgressAtMs: null,
        lastObservedProgressSec: 0,
    });
    const segmentedUnexpectedStopStartupGuardRef = useRef<{
        trackId: string | null;
        suppressUntilMs: number;
        reason: string | null;
    }>({
        trackId: null,
        suppressUntilMs: 0,
        reason: null,
    });
    const segmentedColdStartRebufferDeferralRef = useRef<{
        trackId: string | null;
        count: number;
    }>({
        trackId: null,
        count: 0,
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
    const segmentedHeartbeatConsecutiveFailureCountRef = useRef<number>(0);
    const segmentedHeartbeatLastGuardedRefreshAtMsRef = useRef<number>(0);
    const segmentedHeartbeatSessionIdRef = useRef<string | null>(null);
    const listenTogetherFollowerRecoveryRef = useRef<{
        groupId: string | null;
        inFlight: boolean;
        lastRequestedAtMs: number;
    }>({
        groupId: null,
        inFlight: false,
        lastRequestedAtMs: 0,
    });
    const segmentedHandoffListenerCleanupRef = useRef<(() => void) | null>(
        null,
    );
    const segmentedHandoffListenerTimeoutRef = useRef<NodeJS.Timeout | null>(
        null,
    );
    const segmentedHandoffListenerContextRef =
        useRef<SegmentedHandoffListenerRegistration | null>(null);

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
        loadIdRef,
        desiredLoadPlayRef,
        cancelledLoadPlayIdRef,
        cachePollingRef,
        seekCheckTimeoutRef,
        cacheStatusPollingRef,
        loadTimeoutRef,
        segmentedStartupFallbackTimeoutRef,
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
        prewarmedSegmentedSessionRef,
        segmentedPrewarmInFlightRef,
        segmentedPrewarmRetryTimeoutsRef,
        segmentedPrewarmValidationInFlightRef,
        segmentedPrewarmValidationAbortControllersRef,
        segmentedPrewarmValidationSessionByKeyRef,
        segmentedPrewarmValidatedSessionIdsRef,
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
        segmentedManifestNudgeTimeoutsRef,
        transientTrackRecoveryTimeoutRef,
        transientTrackRecoveryLoadListenerRef,
        transientTrackRecoveryTrackIdRef,
        transientTrackRecoveryAttemptRef,
        transientTrackRecoveryWindowStartedAtRef,
        autoMatchVibePromiseRef,
        autoMatchVibeTrackIdRef,
        autoMatchVibeLastAttemptAtRef,
        ytMusicAuthenticatedRef,
        activeSegmentedSessionRef,
        activeSegmentedPlaybackTrackIdRef,
        segmentedHandoffInProgressRef,
        segmentedHandoffAttemptRef,
        segmentedHandoffLastAttemptAtRef,
        segmentedSessionCreateFallbackAttemptRef,
        segmentedSessionCreateFallbackLastAttemptAtRef,
        segmentedChunkQuarantineRef,
        segmentedChunkQuarantineLastRecoveryAtRef,
        segmentedLastFailedChunkRef,
        segmentedHandoffCircuitRef,
        segmentedHandoffLastRecoveryRef,
        segmentedProactiveHandoffAttemptedTrackIdRef,
        segmentedProactiveHandoffAttemptCountRef,
        segmentedProactiveHandoffLastAttemptAtRef,
        segmentedProactiveHandoffCompletedTrackIdRef,
        segmentedProactiveHandoffLastSkipKeyRef,
        startupSegmentedSessionRef,
        startupSegmentedSessionInFlightRef,
        startupSegmentedSessionPromisesRef,
        segmentedStartupRetryCountRef,
        segmentedStartupStageAttemptsRef,
        segmentedStartupRecoveryWindowStartedAtMsRef,
        segmentedStartupSessionResetCountRef,
        segmentedStartupTimelineRef,
        segmentedStartupStabilityRef,
        segmentedUnexpectedStopStartupGuardRef,
        segmentedColdStartRebufferDeferralRef,
        lastHandledTrackEndRef,
        trackEndWatchdogRef,
        howlerLoadStartMsRef,
        heartbeatRef,
        segmentedHeartbeatConsecutiveFailureCountRef,
        segmentedHeartbeatLastGuardedRefreshAtMsRef,
        segmentedHeartbeatSessionIdRef,
        listenTogetherFollowerRecoveryRef,
        segmentedHandoffListenerCleanupRef,
        segmentedHandoffListenerTimeoutRef,
        segmentedHandoffListenerContextRef,
    };
}

export type PlaybackOrchestratorRefs = ReturnType<
    typeof usePlaybackOrchestratorRefs
>;
