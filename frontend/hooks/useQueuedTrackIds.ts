"use client";

import { useEffect, useMemo, useRef } from "react";
import { useAudioState } from "@/lib/audio-state-context";
import { useListenTogether } from "@/lib/listen-together-context";
import { resolveStableQueuedTrackIdSet } from "@/lib/queue-identity";

/**
 * Executes useQueuedTrackIds.
 */
export function useQueuedTrackIds(): ReadonlySet<string> {
    const { queue } = useAudioState();
    const { isInGroup, activeGroup } = useListenTogether();
    const previousSetRef = useRef<ReadonlySet<string> | null>(null);

    const result = useMemo(() => {
        let nextSet: ReadonlySet<string>;
        if (isInGroup) {
            const groupQueue = activeGroup?.playback?.queue ?? [];
            nextSet = new Set(groupQueue.map((track) => track.id));
        } else {
            nextSet = new Set(queue.map((track) => track.id));
        }

        return resolveStableQueuedTrackIdSet(nextSet, previousSetRef.current);
    }, [isInGroup, activeGroup?.playback?.queue, queue]);

    useEffect(() => { previousSetRef.current = result; });

    return result;
}
