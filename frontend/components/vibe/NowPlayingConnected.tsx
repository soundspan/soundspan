"use client";

import { useCallback } from "react";
import { useAudioState, type Track } from "@/lib/audio-state-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { buildPreferenceMetadata } from "@/hooks/useTrackPreference";
import { NowPlayingCard } from "./NowPlayingCard";

/**
 * Thin connected wrapper for the now-playing card. It isolates the
 * frequently-changing `isPlaying` subscription (the audio playback clock ticks
 * several times a second) to just the card, so VibeMap — the 15k-dot canvas
 * host — never re-renders on the playback clock. Play/pause uses the verified
 * real controls (`pause()` / `play()`, matching the MiniPlayer toggle).
 *
 * Also wires the like heart: `track` is the full audio-state `Track` (a
 * superset of `NowPlayingCardTrack`, which stays narrow so NowPlayingCard's
 * own tests don't need the whole Track shape), and `preferenceTrackId`
 * mirrors FullPlayer/MiniPlayer's own `playbackType === "track"` gate so a
 * podcast/audiobook episode (which can be "now playing" here too, just
 * off-map) disables the heart via TrackPreferenceButtons' existing
 * `canSetTrackPreference` rather than adding bespoke podcast detection.
 */
export function NowPlayingConnected({
    track,
    onMapPresent,
    moodColor,
    onFlyTo,
}: {
    track: Track | null;
    onMapPresent: boolean;
    moodColor: string | null;
    onFlyTo: () => void;
}) {
    const { isPlaying, currentTime, duration } = useAudioPlayback();
    const { pause, play } = useAudioControls();
    const { playbackType } = useAudioState();
    const onTogglePlay = useCallback(
        () => (isPlaying ? pause() : play()),
        [isPlaying, pause, play]
    );
    const preferenceTrackId = playbackType === "track" ? track?.id : undefined;
    return (
        <NowPlayingCard
            track={track}
            isPlaying={isPlaying}
            onMapPresent={onMapPresent}
            moodColor={moodColor}
            onFlyTo={onFlyTo}
            onTogglePlay={onTogglePlay}
            currentTime={currentTime}
            duration={duration}
            likeSlot={
                <TrackPreferenceButtons
                    trackId={preferenceTrackId}
                    mode="up-only"
                    resolveFromQuery
                    buttonSizeClassName="h-10 w-10"
                    iconSizeClassName="w-5 h-5"
                    metadata={buildPreferenceMetadata(track)}
                />
            }
        />
    );
}
