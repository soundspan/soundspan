"use client";

import { useEffect, type MutableRefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useFeatures } from "@/lib/features-context";
import {
    LOUDNESS_MODES,
    isAlbumOrderedQueue,
    resolveLoudnessGain,
    type LoudnessMode,
} from "@/lib/audio-engine/loudnessGainPolicy";
import { useAudioState } from "@/lib/audio-state-context";
import { isEpisodeQueueItem } from "@/lib/queue-item";

function parseLoudnessMode(value: unknown): LoudnessMode | null {
    return LOUDNESS_MODES.includes(value as LoudnessMode)
        ? (value as LoudnessMode)
        : null;
}

interface UseLoudnessNormalizationOptions {
    loudnessGainFactorRef: MutableRefObject<number>;
    applyCurrentOutputState: () => void;
}

/**
 * Keeps the loudness-normalization gain factor in sync with the current
 * track, the user's mode (Settings → Playback), and the server target
 * (issue #526). The factor is composited with user volume inside
 * applyCurrentOutputState; this hook only recomputes it and re-applies the
 * output state when the applied gain actually changes.
 *
 * The mode stays "off" until the settings query resolves, so gain is never
 * applied speculatively; audiobooks and podcasts are never normalized.
 */
export function useLoudnessNormalization({
    loudnessGainFactorRef,
    applyCurrentOutputState,
}: UseLoudnessNormalizationOptions): void {
    const { currentTrack, playbackType, queue, isShuffle } = useAudioState();
    const { loudnessTargetLufs } = useFeatures();
    const { data, isFetched } = useQuery<{ loudnessMode?: string }>({
        queryKey: ["user-settings"],
        queryFn: () => api.getSettings(),
        staleTime: 5 * 60 * 1000,
    });
    const mode: LoudnessMode = isFetched
        ? (parseLoudnessMode(data?.loudnessMode) ?? "auto")
        : "off";

    useEffect(() => {
        // A queue containing podcast episodes is never an album context.
        const trackItems = queue.filter((item) => !isEpisodeQueueItem(item));
        const isAlbumContext =
            trackItems.length === queue.length &&
            isAlbumOrderedQueue(trackItems, isShuffle);
        const decision = resolveLoudnessGain({
            mode,
            targetLufs: loudnessTargetLufs,
            isAlbumContext,
            track: playbackType === "track" ? currentTrack : null,
        });
        if (loudnessGainFactorRef.current === decision.gainFactor) return;
        loudnessGainFactorRef.current = decision.gainFactor;
        applyCurrentOutputState();
    }, [
        mode,
        loudnessTargetLufs,
        currentTrack,
        playbackType,
        queue,
        isShuffle,
        loudnessGainFactorRef,
        applyCurrentOutputState,
    ]);
}
