import { useEffect } from "react";
import type { Track } from "@/lib/audio-state-context";
import { getListenTogetherSessionSnapshot } from "@/lib/listen-together-session";
import { shouldAutoMatchVibeAtQueueEnd } from "../autoMatchVibePlayback";
import type { PlaybackOrchestratorRefs } from "./usePlaybackOrchestratorRefs";

interface UseQueueRecoveryEffectsOptions {
    refs: PlaybackOrchestratorRefs;
    playbackType: "track" | "audiobook" | "podcast" | null;
    queueLength: number;
    currentIndex: number;
    repeatMode: "off" | "one" | "all";
    currentTrack: Track | null;
    requestAutoMatchVibe: (
        seedTrackId: string | null,
        options?: { force?: boolean },
    ) => Promise<boolean>;
    clearPendingTrackErrorSkip: () => void;
    clearStartupPlaybackRecovery: () => void;
    clearTransientTrackRecovery: (resetAttempts?: boolean) => void;
}

/** Preserves queue-end auto-match and pending recovery cleanup effects. */
export function useQueueRecoveryEffects({
    refs,
    playbackType,
    queueLength,
    currentIndex,
    repeatMode,
    currentTrack,
    requestAutoMatchVibe,
    clearPendingTrackErrorSkip,
    clearStartupPlaybackRecovery,
    clearTransientTrackRecovery,
}: UseQueueRecoveryEffectsOptions): void {
    const { pendingTrackErrorTrackIdRef } = refs;

    useEffect(() => {
        const shouldAutoMatchVibe = shouldAutoMatchVibeAtQueueEnd({
            playbackType,
            queueLength,
            currentIndex,
            repeatMode,
            isListenTogether: Boolean(
                getListenTogetherSessionSnapshot()?.groupId,
            ),
        });

        if (!shouldAutoMatchVibe || !currentTrack?.id) {
            return;
        }

        void requestAutoMatchVibe(currentTrack.id);
    }, [
        playbackType,
        queueLength,
        currentIndex,
        repeatMode,
        currentTrack?.id,
        requestAutoMatchVibe,
    ]);

    useEffect(() => {
        if (playbackType !== "track") {
            clearPendingTrackErrorSkip();
            clearStartupPlaybackRecovery();
            clearTransientTrackRecovery(true);
            return;
        }

        if (
            pendingTrackErrorTrackIdRef.current &&
            pendingTrackErrorTrackIdRef.current !== currentTrack?.id
        ) {
            clearPendingTrackErrorSkip();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- Preserve the relocated ref access and original hook scheduling.
    }, [
        playbackType,
        currentTrack?.id,
        clearPendingTrackErrorSkip,
        clearStartupPlaybackRecovery,
        clearTransientTrackRecovery,
    ]);
}
