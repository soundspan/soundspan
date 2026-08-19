import { useCallback } from "react";
import { resolveTrustedTrackPositionSec } from "@/lib/audio-engine/playbackRecoveryPolicy";
import { audioEngine } from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";

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
        unexpectedPauseRecoveryTimeoutRef,
        startupRecoveryTimeoutRef,
        startupRecoveryLoadListenerRef,
        transientTrackRecoveryTimeoutRef,
        transientTrackRecoveryLoadListenerRef,
        transientTrackRecoveryTrackIdRef,
        transientTrackRecoveryAttemptRef,
        transientTrackRecoveryWindowStartedAtRef,
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

    const clearUnexpectedPauseRecoveryCheck = useCallback(() => {
        if (unexpectedPauseRecoveryTimeoutRef.current) {
            clearTimeout(unexpectedPauseRecoveryTimeoutRef.current);
            unexpectedPauseRecoveryTimeoutRef.current = null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, []);

    const resolveBufferedAheadSec = useCallback((): number | null => {
        if (typeof document === "undefined") {
            return null;
        }

        const mediaElement = document.querySelector(
            "video, audio",
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

    /**
     * Settles transient-recovery state when a load completes. While a
     * correlated-resume listener is pending it must survive this call: it
     * is registered after the stable load handler on the same live
     * listener set, and a full clear would delete it before it runs (Set
     * entries removed mid-iteration are never visited). Only the attempt
     * budget resets; the listener applies the guarded resume position and
     * cleans itself up.
     */
    const settleTransientRecoveryAfterLoad = useCallback(() => {
        if (transientTrackRecoveryLoadListenerRef.current) {
            transientTrackRecoveryTrackIdRef.current = null;
            transientTrackRecoveryAttemptRef.current = 0;
            transientTrackRecoveryWindowStartedAtRef.current = 0;
            return;
        }
        clearTransientTrackRecovery(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [clearTransientTrackRecovery]);

    return {
        clearPendingTrackErrorSkip,
        readTrustedTrackPositionSec,
        clearUnexpectedPauseRecoveryCheck,
        resolveBufferedAheadSec,
        clearStartupPlaybackRecovery,
        clearTransientTrackRecovery,
        settleTransientRecoveryAfterLoad,
    };
}
