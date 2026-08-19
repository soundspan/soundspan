import { useCallback } from "react";
import { audioEngine } from "@/lib/audio-engine/audioPlaybackOrchestratorRuntime";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";

interface UseApplyCurrentOutputStateOptions {
    refs: PlaybackOrchestratorRefs;
}

/** Applies the latest UI volume/mute state (with loudness gain) to the engine. */
export function useApplyCurrentOutputState({
    refs,
}: UseApplyCurrentOutputStateOptions): () => void {
    const { outputStateRef, loudnessGainFactorRef } = refs;

    return useCallback(() => {
        const { volume: currentVolume, isMuted: currentMuted } =
            outputStateRef.current;
        // User volume and loudness-normalization gain form one multiplicative
        // chain; the engine clamps the composite into its 0..1 range.
        audioEngine.setVolume(currentVolume * loudnessGainFactorRef.current);
        audioEngine.setMuted(currentMuted);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, []);
}
