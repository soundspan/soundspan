import { useEffect } from "react";
import { audioEngine } from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";

interface UsePlaybackUnmountCleanupOptions {
    refs: PlaybackOrchestratorRefs;
    abortAllSegmentedPrewarmValidations: (
        reason: "track_change" | "unmount",
    ) => void;
    clearSegmentedStartupFallback: () => void;
    clearSegmentedManifestNudges: () => void;
    clearPendingTrackErrorSkip: () => void;
    clearStartupPlaybackRecovery: () => void;
    clearTransientTrackRecovery: (resetAttempts?: boolean) => void;
    clearSegmentedHandoffLoadListeners: (
        reason:
            | "load"
            | "loaderror"
            | "track_change"
            | "playback_type_change"
            | "unmount"
            | "replace"
            | "timeout"
            | "correlation_mismatch",
    ) => void;
}

/** Releases every orchestrator-owned timer, listener, and prewarm snapshot. */
export function usePlaybackUnmountCleanup({
    refs,
    abortAllSegmentedPrewarmValidations,
    clearSegmentedStartupFallback,
    clearSegmentedManifestNudges,
    clearPendingTrackErrorSkip,
    clearStartupPlaybackRecovery,
    clearTransientTrackRecovery,
    clearSegmentedHandoffLoadListeners,
}: UsePlaybackUnmountCleanupOptions): void {
    const {
        prewarmedSegmentedSessionRef,
        segmentedPrewarmInFlightRef,
        segmentedPrewarmValidationInFlightRef,
        segmentedPrewarmValidatedSessionIdsRef,
        startupSegmentedSessionInFlightRef,
        startupSegmentedSessionPromisesRef,
        segmentedPrewarmRetryTimeoutsRef,
        desiredLoadPlayRef,
        cancelledLoadPlayIdRef,
        progressSaveIntervalRef,
        loadTimeoutRef,
        segmentedHeartbeatConsecutiveFailureCountRef,
        segmentedHeartbeatLastGuardedRefreshAtMsRef,
        segmentedHeartbeatSessionIdRef,
        loadListenerRef,
        loadErrorListenerRef,
        cachePollingLoadListenerRef,
        lastPreloadedTrackIdRef,
        activeSegmentedPlaybackTrackIdRef,
        startupSegmentedSessionRef,
        segmentedStartupTimelineRef,
    } = refs;

    // Cleanup on unmount
    useEffect(() => {
        const prewarmedSegmentedSessions = prewarmedSegmentedSessionRef.current;
        const segmentedPrewarmInFlight = segmentedPrewarmInFlightRef.current;
        const segmentedPrewarmValidationInFlight =
            segmentedPrewarmValidationInFlightRef.current;
        const segmentedPrewarmValidatedSessionIds =
            segmentedPrewarmValidatedSessionIdsRef.current;
        const startupSegmentedSessionInFlight =
            startupSegmentedSessionInFlightRef.current;
        const startupSegmentedSessionPromises =
            startupSegmentedSessionPromisesRef.current;
        const segmentedPrewarmRetryTimeouts =
            segmentedPrewarmRetryTimeoutsRef.current;
        return () => {
            desiredLoadPlayRef.current = null;
            cancelledLoadPlayIdRef.current = null;
            audioEngine.stop();

            if (progressSaveIntervalRef.current) {
                // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
                clearInterval(progressSaveIntervalRef.current);
            }
            if (loadTimeoutRef.current) {
                clearTimeout(loadTimeoutRef.current);
                loadTimeoutRef.current = null;
            }
            clearSegmentedStartupFallback();
            clearSegmentedManifestNudges();
            clearPendingTrackErrorSkip();
            clearStartupPlaybackRecovery();
            clearTransientTrackRecovery(true);
            clearSegmentedHandoffLoadListeners("unmount");
            segmentedHeartbeatConsecutiveFailureCountRef.current = 0;
            segmentedHeartbeatLastGuardedRefreshAtMsRef.current = 0;
            segmentedHeartbeatSessionIdRef.current = null;
            // Clean up all listener refs to prevent memory leaks
            if (loadListenerRef.current) {
                audioEngine.off("load", loadListenerRef.current);
                loadListenerRef.current = null;
            }
            if (loadErrorListenerRef.current) {
                audioEngine.off("loaderror", loadErrorListenerRef.current);
                loadErrorListenerRef.current = null;
            }
            if (cachePollingLoadListenerRef.current) {
                audioEngine.off("load", cachePollingLoadListenerRef.current);
                cachePollingLoadListenerRef.current = null;
            }
            // Clean up preload refs
            lastPreloadedTrackIdRef.current = null;
            activeSegmentedPlaybackTrackIdRef.current = null;
            abortAllSegmentedPrewarmValidations("unmount");
            prewarmedSegmentedSessions.clear();
            segmentedPrewarmInFlight.clear();
            segmentedPrewarmValidationInFlight.clear();
            segmentedPrewarmValidatedSessionIds.clear();
            startupSegmentedSessionRef.current = null;
            segmentedStartupTimelineRef.current = null;
            startupSegmentedSessionInFlight.clear();
            startupSegmentedSessionPromises.clear();
            for (const timeout of segmentedPrewarmRetryTimeouts.values()) {
                clearTimeout(timeout);
            }
            segmentedPrewarmRetryTimeouts.clear();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [
        abortAllSegmentedPrewarmValidations,
        clearSegmentedStartupFallback,
        clearSegmentedManifestNudges,
        clearPendingTrackErrorSkip,
        clearStartupPlaybackRecovery,
        clearTransientTrackRecovery,
        clearSegmentedHandoffLoadListeners,
    ]);
}
