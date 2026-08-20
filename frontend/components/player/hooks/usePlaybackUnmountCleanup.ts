import { useEffect } from "react";
import { audioEngine } from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";
import { setPlaybackAutoRestartSuppressed } from "@/lib/audio-engine/playbackAdvanceOrigin";

interface UsePlaybackUnmountCleanupOptions {
    refs: PlaybackOrchestratorRefs;
    clearPendingTrackErrorSkip: () => void;
    clearStartupPlaybackRecovery: () => void;
    clearTransientTrackRecovery: (resetAttempts?: boolean) => void;
}

/** Releases every orchestrator-owned timer and listener. */
export function usePlaybackUnmountCleanup({
    refs,
    clearPendingTrackErrorSkip,
    clearStartupPlaybackRecovery,
    clearTransientTrackRecovery,
}: UsePlaybackUnmountCleanupOptions): void {
    const {
        desiredLoadPlayRef,
        cancelledLoadPlayIdRef,
        progressSaveIntervalRef,
        loadTimeoutRef,
        loadListenerRef,
        loadErrorListenerRef,
        cachePollingLoadListenerRef,
        lastPreloadedTrackIdRef,
    } = refs;

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            desiredLoadPlayRef.current = null;
            cancelledLoadPlayIdRef.current = null;
            setPlaybackAutoRestartSuppressed(false);
            audioEngine.stop();

            if (progressSaveIntervalRef.current) {
                // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
                clearInterval(progressSaveIntervalRef.current);
            }
            if (loadTimeoutRef.current) {
                clearTimeout(loadTimeoutRef.current);
                loadTimeoutRef.current = null;
            }
            clearPendingTrackErrorSkip();
            clearStartupPlaybackRecovery();
            clearTransientTrackRecovery(true);
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
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [
        clearPendingTrackErrorSkip,
        clearStartupPlaybackRecovery,
        clearTransientTrackRecovery,
    ]);
}
