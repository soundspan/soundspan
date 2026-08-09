"use client";

import { memo, useEffect, type MutableRefObject } from "react";
import { usePlaybackProgress } from "@/lib/audio-playback-context";
import type { Track, useAudioState } from "@/lib/audio-state-context";

type PlaybackType = ReturnType<typeof useAudioState>["playbackType"];

interface PlaybackProgressSnapshotProps {
    snapshotRef: MutableRefObject<number>;
    snapshotTrackIdRef: MutableRefObject<string | null>;
    currentTrackRef: MutableRefObject<Track | null>;
    playbackType: PlaybackType;
}

/**
 * Keeps trusted playback snapshots current while isolating per-clock-tick
 * re-renders from the audio playback orchestrator body.
 */
export const PlaybackProgressSnapshot = memo(
    function PlaybackProgressSnapshot({
        snapshotRef,
        snapshotTrackIdRef,
        currentTrackRef,
        playbackType,
    }: PlaybackProgressSnapshotProps) {
        const { currentTime } = usePlaybackProgress();

        useEffect(() => {
            snapshotRef.current = currentTime;
            snapshotTrackIdRef.current =
                playbackType === "track"
                    ? currentTrackRef.current?.id ?? null
                    : null;
        }, [
            currentTime,
            playbackType,
            snapshotRef,
            snapshotTrackIdRef,
            currentTrackRef,
        ]);

        return null;
    },
);
