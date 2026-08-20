/** Origin of a playback action that may change or retry the active track. */
export type PlaybackAdvanceOrigin = "error" | "manual" | null;

/** Pending origin consumed by the first breaker-reset decision. */
export interface PlaybackAdvanceOriginMarker {
    origin: Exclude<PlaybackAdvanceOrigin, null>;
    originatingTrackId: string | null;
}

/** Single player-wide origin ref shared by control and recovery dispatchers. */
export const playbackAdvanceOriginRef: {
    current: PlaybackAdvanceOriginMarker | null;
} = { current: null };

/** Replaces any pending origin, so manual actions clear stale error markers. */
export function writePlaybackAdvanceOrigin(
    origin: PlaybackAdvanceOrigin,
    originatingTrackId: string | null,
): void {
    playbackAdvanceOriginRef.current = origin
        ? { origin, originatingTrackId }
        : null;
}

/** Returns and clears the pending origin exactly once. */
export function consumePlaybackAdvanceOrigin(): PlaybackAdvanceOriginMarker | null {
    const marker = playbackAdvanceOriginRef.current;
    playbackAdvanceOriginRef.current = null;
    return marker;
}
