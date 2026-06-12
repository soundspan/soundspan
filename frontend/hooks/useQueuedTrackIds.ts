"use client";

import { useMemo } from "react";
import { useAudioState } from "@/lib/audio-state-context";
import { useListenTogether } from "@/lib/listen-together-context";

function serializeQueuedTrackIds(trackIds: readonly string[]): string {
    return JSON.stringify(Array.from(new Set(trackIds)).sort());
}

/**
 * Executes useQueuedTrackIds.
 */
export function useQueuedTrackIds(): ReadonlySet<string> {
    const { queue } = useAudioState();
    const { isInGroup, activeGroup } = useListenTogether();

    const queuedTrackIdSignature = useMemo(() => {
        const activeQueue = isInGroup ? activeGroup?.playback?.queue ?? [] : queue;
        return serializeQueuedTrackIds(activeQueue.map((track) => track.id));
    }, [isInGroup, activeGroup?.playback?.queue, queue]);

    return useMemo(
        () =>
            new Set(JSON.parse(queuedTrackIdSignature) as string[]) as ReadonlySet<string>,
        [queuedTrackIdSignature]
    );
}
