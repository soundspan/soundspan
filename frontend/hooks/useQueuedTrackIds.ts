"use client";

import { useMemo } from "react";
import { useAudioState } from "@/lib/audio-state-context";
import { useListenTogether } from "@/lib/listen-together-context";

export function useQueuedTrackIds(): ReadonlySet<string> {
    const { queue } = useAudioState();
    const { isInGroup, activeGroup } = useListenTogether();

    return useMemo(() => {
        if (isInGroup) {
            const groupQueue = activeGroup?.playback?.queue ?? [];
            return new Set(groupQueue.map((track) => track.id));
        }

        return new Set(queue.map((track) => track.id));
    }, [isInGroup, activeGroup?.playback?.queue, queue]);
}
