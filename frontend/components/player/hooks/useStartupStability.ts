import { useCallback } from "react";
import { UNEXPECTED_STOP_STARTUP_GUARD_MS } from "@/lib/audio-engine/audioPlaybackOrchestratorConstants";
import {
    createStartupStabilityWindow,
    noteStartupProgressTransition,
} from "@/lib/audio-engine/playbackRecoveryPolicy";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";

interface UseStartupStabilityOptions {
    refs: PlaybackOrchestratorRefs;
}

/**
 * Tracks whether the current track has produced real audible progress since
 * its load started. The startup watchdog and unexpected-stop suppression key
 * on this: an engine that claims isPlaying() while time stays frozen is a
 * startup failure, not healthy playback (GH #42 soak finding — applies to
 * the native and Howler engines alike).
 */
export function useStartupStability({ refs }: UseStartupStabilityOptions) {
    const { startupStabilityRef, unexpectedStopStartupGuardRef } = refs;

    const markStartupStabilityWindow = useCallback(
        (trackId: string | null, reason: string): void => {
            startupStabilityRef.current = createStartupStabilityWindow(trackId);
            unexpectedStopStartupGuardRef.current = {
                trackId,
                suppressUntilMs: trackId
                    ? Date.now() + UNEXPECTED_STOP_STARTUP_GUARD_MS
                    : 0,
                reason: trackId ? reason : null,
            };
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    const noteStartupProgress = useCallback(
        (trackId: string | null, timeSec: number): void => {
            startupStabilityRef.current = noteStartupProgressTransition(
                startupStabilityRef.current,
                trackId,
                timeSec,
                Date.now(),
            );
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
        [],
    );

    return { markStartupStabilityWindow, noteStartupProgress };
}
