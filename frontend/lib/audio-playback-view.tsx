"use client";

import { memo, useEffect, type MutableRefObject } from "react";
import {
    usePlaybackProgress,
    usePlaybackStatus,
} from "./audio-playback-context";

/**
 * Live playback view for ref-based callback reads inside
 * AudioControlsProvider. Only the fields the provider's callbacks actually
 * use are exposed, and every read resolves at call time, so neither status
 * changes nor clock ticks re-render the provider body (GH #785).
 *
 * Status objects that still carry a currentTime (legacy test doubles) win
 * over the bridge ref; the production status context never includes it.
 */
export function buildPlaybackView(
    statusRef: MutableRefObject<ReturnType<typeof usePlaybackStatus>>,
    currentTimeRef: MutableRefObject<number>,
) {
    return {
        get currentTime(): number {
            const legacyCurrentTime = (
                statusRef.current as { currentTime?: number }
            ).currentTime;
            return legacyCurrentTime ?? currentTimeRef.current;
        },
        get duration() {
            return statusRef.current.duration;
        },
        get setCurrentTime() {
            return statusRef.current.setCurrentTime.bind(statusRef.current);
        },
        get setIsPlaying() {
            return statusRef.current.setIsPlaying.bind(statusRef.current);
        },
        get lockSeek() {
            return statusRef.current.lockSeek.bind(statusRef.current);
        },
    };
}

interface PlaybackClockBridgeProps {
    currentTimeRef: MutableRefObject<number>;
}

/** Null-rendering clock subscriber that isolates per-tick re-renders. */
export const PlaybackClockBridge = memo(function PlaybackClockBridge({
    currentTimeRef,
}: PlaybackClockBridgeProps) {
    const { currentTime } = usePlaybackProgress();
    useEffect(() => {
        currentTimeRef.current = currentTime;
    }, [currentTime, currentTimeRef]);
    return null;
});
