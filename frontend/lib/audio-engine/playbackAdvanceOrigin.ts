/** Origin of a playback action that may change or retry the active track. */
export type PlaybackAdvanceOrigin = "error" | "manual" | null;

/** Pending origin consumed by the first breaker-reset decision. */
export interface PlaybackAdvanceOriginMarker {
    origin: Exclude<PlaybackAdvanceOrigin, null>;
    originatingTrackId: string | null;
}

/** Classification applied when a remote consumer selects another track. */
export type RemoteTrackChangeDecision =
    | "unchanged"
    | "media-cleared"
    | "error-resync"
    | "fresh-media";

/** Single player-wide origin ref shared by control and recovery dispatchers. */
export const playbackAdvanceOriginRef: {
    current: PlaybackAdvanceOriginMarker | null;
} = { current: null };

const playbackAutoRestartSuppressedRef: { current: boolean } = {
    current: false,
};

/** Replaces any pending origin, so manual actions clear stale error markers. */
export function writePlaybackAdvanceOrigin(
    origin: PlaybackAdvanceOrigin,
    originatingTrackId: string | null,
): void {
    playbackAdvanceOriginRef.current = origin
        ? { origin, originatingTrackId }
        : null;
}

/** Consumes the pending origin and re-enables restarts for a manual action. */
export function consumePlaybackAdvanceOrigin(): PlaybackAdvanceOriginMarker | null {
    const marker = playbackAdvanceOriginRef.current;
    playbackAdvanceOriginRef.current = null;
    if (marker?.origin === "manual") {
        playbackAutoRestartSuppressedRef.current = false;
    }
    return marker;
}

/** Returns whether automatic playback restarts are currently suppressed. */
export function isPlaybackAutoRestartSuppressed(): boolean {
    return playbackAutoRestartSuppressedRef.current;
}

/** Updates automatic-restart suppression to match the player breaker. */
export function setPlaybackAutoRestartSuppressed(suppressed: boolean): void {
    playbackAutoRestartSuppressedRef.current = suppressed;
}

/**
 * Marks a remote track selection as fresh media unless it is the one-shot
 * result of this player's own error recovery.
 */
export function markRemoteTrackChange(
    originatingTrackId: string | null,
    newTrackId: string | null,
): RemoteTrackChangeDecision {
    if (originatingTrackId === newTrackId) return "unchanged";
    if (!newTrackId) return "media-cleared";

    const marker = playbackAdvanceOriginRef.current;
    if (
        marker?.origin === "error" &&
        marker.originatingTrackId === originatingTrackId
    ) {
        playbackAdvanceOriginRef.current = null;
        return "error-resync";
    }

    writePlaybackAdvanceOrigin("manual", originatingTrackId);
    setPlaybackAutoRestartSuppressed(false);
    return "fresh-media";
}
