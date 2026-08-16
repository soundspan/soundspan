import { useCallback } from "react";
import {
    resolveCorrelatedRecoveryResumeDecision,
    resolveStartupGuardedRecoveryPositionSec,
    resolveTrustedTrackPositionSec,
} from "@/lib/audio-engine/segmentedPlaybackRegressionPolicy";
import { SEGMENTED_HANDOFF_LISTENER_BACKSTOP_MS } from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import {
    audioEngine,
    logPlaybackClientMetric,
} from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import type { SegmentedHandoffListenerRegistration } from "./audioPlaybackOrchestratorTypes";

interface UsePlaybackRecoveryHelpersOptions {
    refs: PlaybackOrchestratorRefs;
}

/** Preserves recovery cleanup, position, and listener callbacks. */
export function usePlaybackRecoveryHelpers({
    refs,
}: UsePlaybackRecoveryHelpersOptions) {
    const {
        pendingTrackErrorSkipRef,
        pendingTrackErrorTrackIdRef,
        currentTimeSnapshotRef,
        currentTimeSnapshotTrackIdRef,
        playbackTypeRef,
        currentTrackRef,
        isLoadingRef,
        activeEngineTrackIdRef,
        segmentedStartupStabilityRef,
        activeSegmentedSessionRef,
        loadIdRef,
        unexpectedPauseRecoveryTimeoutRef,
        segmentedHandoffCircuitRef,
        startupRecoveryTimeoutRef,
        startupRecoveryLoadListenerRef,
        transientTrackRecoveryTimeoutRef,
        transientTrackRecoveryLoadListenerRef,
        transientTrackRecoveryTrackIdRef,
        transientTrackRecoveryAttemptRef,
        transientTrackRecoveryWindowStartedAtRef,
        segmentedHandoffListenerTimeoutRef,
        segmentedHandoffListenerCleanupRef,
        segmentedHandoffListenerContextRef,
    } = refs;

    const clearPendingTrackErrorSkip = useCallback(() => {
        if (pendingTrackErrorSkipRef.current) {
            clearTimeout(pendingTrackErrorSkipRef.current);
            pendingTrackErrorSkipRef.current = null;
        }
        pendingTrackErrorTrackIdRef.current = null;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, []);

    const readTrustedTrackPositionSec = useCallback(
        (trackId: string): number => {
            const enginePosition = Math.max(
                0,
                typeof audioEngine.getActualCurrentTime === "function"
                    ? audioEngine.getActualCurrentTime()
                    : audioEngine.getCurrentTime(),
            );

            return resolveTrustedTrackPositionSec({
                fallbackPositionSec: currentTimeSnapshotRef.current,
                fallbackTrackId: currentTimeSnapshotTrackIdRef.current,
                playbackType: playbackTypeRef.current,
                currentTrackId: currentTrackRef.current?.id ?? null,
                targetTrackId: trackId,
                isLoading: isLoadingRef.current,
                activeEngineTrackId: activeEngineTrackIdRef.current,
                enginePositionSec: enginePosition,
            });
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    const resolveStartupSafeTrackPositionSec = useCallback(
        (trackId: string): number => {
            const trustedPositionSec = readTrustedTrackPositionSec(trackId);
            const startupStability = segmentedStartupStabilityRef.current;
            return resolveStartupGuardedRecoveryPositionSec({
                targetTrackId: trackId,
                trustedPositionSec,
                startupStabilityTrackId: startupStability.trackId,
                startupFirstProgressAtMs: startupStability.firstProgressAtMs,
            });
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [readTrustedTrackPositionSec],
    );

    const resolveHandoffLocalPositionSec = useCallback(
        (trackId: string, anchorPositionSec: number): number => {
            const livePositionSec = resolveStartupSafeTrackPositionSec(trackId);
            if (livePositionSec > 0.25) {
                return livePositionSec;
            }
            return Math.max(0, anchorPositionSec);
        },
        [resolveStartupSafeTrackPositionSec],
    );

    const resolveCorrelatedRecoveryResume = useCallback(
        ({
            requestedResumeAtSec,
            expectedTrackId,
            expectedLoadId,
            expectedSessionId = null,
            sourceType,
            reason,
        }: {
            requestedResumeAtSec: number;
            expectedTrackId: string;
            expectedLoadId: number;
            expectedSessionId?: string | null;
            sourceType: "local" | "tidal" | "ytmusic";
            reason: string;
        }) => {
            const activeSessionSnapshot = activeSegmentedSessionRef.current;
            const activeTrackId =
                playbackTypeRef.current === "track"
                    ? (currentTrackRef.current?.id ?? null)
                    : null;
            const decision = resolveCorrelatedRecoveryResumeDecision({
                requestedResumeAtSec,
                expectedTrackId,
                activeTrackId,
                expectedLoadId,
                activeLoadId: loadIdRef.current,
                expectedSessionId,
                activeSessionTrackId: activeSessionSnapshot?.trackId ?? null,
                activeSessionId: activeSessionSnapshot?.sessionId ?? null,
            });
            if (!decision.matched) {
                logPlaybackClientMetric("session.handoff_skipped", {
                    trackId: expectedTrackId,
                    sourceType,
                    reason: `resume_correlation_${reason}_${decision.mismatchReason}`,
                    expectedLoadId,
                    activeLoadId: loadIdRef.current,
                    expectedSessionId: expectedSessionId ?? null,
                    activeSessionId: activeSessionSnapshot?.sessionId ?? null,
                    activeTrackId,
                });
            }
            return decision;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    const shouldForceCleanStartFromCorrelationMismatch = useCallback(
        (
            mismatchReason:
                | "none"
                | "track_mismatch"
                | "load_mismatch"
                | "session_mismatch",
        ): boolean => {
            return (
                mismatchReason === "track_mismatch" ||
                mismatchReason === "load_mismatch"
            );
        },
        [],
    );

    const clearUnexpectedPauseRecoveryCheck = useCallback(() => {
        if (unexpectedPauseRecoveryTimeoutRef.current) {
            clearTimeout(unexpectedPauseRecoveryTimeoutRef.current);
            unexpectedPauseRecoveryTimeoutRef.current = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, []);

    const resetSegmentedHandoffCircuit = useCallback(
        (trackId: string | null) => {
            segmentedHandoffCircuitRef.current = {
                trackId,
                windowStartedAtMs: trackId ? Date.now() : 0,
                attempts: 0,
            };
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    const resolveBufferedAheadSec = useCallback((): number | null => {
        if (typeof document === "undefined") {
            return null;
        }

        const mediaElement = document.querySelector(
            "video.vjs-tech, audio.vjs-tech, video, audio",
        ) as HTMLMediaElement | null;
        if (!mediaElement?.buffered) {
            return null;
        }

        const currentTimeSec = Number.isFinite(mediaElement.currentTime)
            ? mediaElement.currentTime
            : audioEngine.getCurrentTime();
        const buffered = mediaElement.buffered;
        if (buffered.length === 0) {
            return 0;
        }

        for (let index = 0; index < buffered.length; index += 1) {
            const rangeStart = buffered.start(index);
            const rangeEnd = buffered.end(index);
            if (currentTimeSec >= rangeStart && currentTimeSec <= rangeEnd) {
                return Math.max(0, rangeEnd - currentTimeSec);
            }
            if (rangeStart > currentTimeSec) {
                return Math.max(0, rangeStart - currentTimeSec);
            }
        }

        return 0;
    }, []);

    const clearStartupPlaybackRecovery = useCallback(() => {
        if (startupRecoveryTimeoutRef.current) {
            clearTimeout(startupRecoveryTimeoutRef.current);
            startupRecoveryTimeoutRef.current = null;
        }
        if (startupRecoveryLoadListenerRef.current) {
            audioEngine.off("load", startupRecoveryLoadListenerRef.current);
            startupRecoveryLoadListenerRef.current = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, []);

    const clearTransientTrackRecovery = useCallback(
        (resetAttempts: boolean = false) => {
            if (transientTrackRecoveryTimeoutRef.current) {
                clearTimeout(transientTrackRecoveryTimeoutRef.current);
                transientTrackRecoveryTimeoutRef.current = null;
            }

            if (transientTrackRecoveryLoadListenerRef.current) {
                audioEngine.off(
                    "load",
                    transientTrackRecoveryLoadListenerRef.current,
                );
                transientTrackRecoveryLoadListenerRef.current = null;
            }

            if (resetAttempts) {
                transientTrackRecoveryTrackIdRef.current = null;
                transientTrackRecoveryAttemptRef.current = 0;
                transientTrackRecoveryWindowStartedAtRef.current = 0;
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    const clearSegmentedHandoffLoadListeners = useCallback(
        (
            reason:
                | "load"
                | "loaderror"
                | "track_change"
                | "playback_type_change"
                | "unmount"
                | "replace"
                | "timeout"
                | "correlation_mismatch",
        ): void => {
            if (segmentedHandoffListenerTimeoutRef.current) {
                clearTimeout(segmentedHandoffListenerTimeoutRef.current);
                segmentedHandoffListenerTimeoutRef.current = null;
            }

            const cleanup = segmentedHandoffListenerCleanupRef.current;
            const listenerContext = segmentedHandoffListenerContextRef.current;
            segmentedHandoffListenerCleanupRef.current = null;
            segmentedHandoffListenerContextRef.current = null;

            if (!cleanup) {
                return;
            }

            cleanup();
            if (reason === "load" || reason === "loaderror") {
                return;
            }

            logPlaybackClientMetric("session.handoff_listener_cleanup", {
                reason,
                trackId: listenerContext?.trackId ?? null,
                sourceType: listenerContext?.sourceType ?? null,
                sessionId: listenerContext?.sessionId ?? null,
                expectedLoadId: listenerContext?.expectedLoadId ?? null,
                phase: listenerContext?.phase ?? null,
                activeTrackId: currentTrackRef.current?.id ?? null,
                activeLoadId: loadIdRef.current,
            });
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    const registerSegmentedHandoffLoadListeners = useCallback(
        (
            listenerRegistration: SegmentedHandoffListenerRegistration,
            onLoad: () => void,
            onLoadError: () => void,
        ): void => {
            clearSegmentedHandoffLoadListeners("replace");

            audioEngine.on("load", onLoad);
            audioEngine.on("loaderror", onLoadError);
            segmentedHandoffListenerCleanupRef.current = () => {
                audioEngine.off("load", onLoad);
                audioEngine.off("loaderror", onLoadError);
            };
            segmentedHandoffListenerContextRef.current = listenerRegistration;
            segmentedHandoffListenerTimeoutRef.current = setTimeout(() => {
                const listenerContext =
                    segmentedHandoffListenerContextRef.current;
                if (!listenerContext) {
                    return;
                }
                logPlaybackClientMetric("session.handoff_listener_timeout", {
                    trackId: listenerContext.trackId,
                    sourceType: listenerContext.sourceType,
                    sessionId: listenerContext.sessionId,
                    expectedLoadId: listenerContext.expectedLoadId,
                    phase: listenerContext.phase,
                    timeoutMs: SEGMENTED_HANDOFF_LISTENER_BACKSTOP_MS,
                    activeTrackId: currentTrackRef.current?.id ?? null,
                    activeLoadId: loadIdRef.current,
                });
                clearSegmentedHandoffLoadListeners("timeout");
            }, SEGMENTED_HANDOFF_LISTENER_BACKSTOP_MS);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [clearSegmentedHandoffLoadListeners],
    );

    return {
        clearPendingTrackErrorSkip,
        readTrustedTrackPositionSec,
        resolveStartupSafeTrackPositionSec,
        resolveHandoffLocalPositionSec,
        resolveCorrelatedRecoveryResume,
        shouldForceCleanStartFromCorrelationMismatch,
        clearUnexpectedPauseRecoveryCheck,
        resetSegmentedHandoffCircuit,
        resolveBufferedAheadSec,
        clearStartupPlaybackRecovery,
        clearTransientTrackRecovery,
        clearSegmentedHandoffLoadListeners,
        registerSegmentedHandoffLoadListeners,
    };
}
