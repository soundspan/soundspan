/** Minimal server playback payload used to restore play/pause intent on startup. */
export interface PlaybackIntentSnapshot {
    isPlaying?: boolean;
}

/**
 * Resolves startup play intent from server state when present, otherwise falls
 * back to the local persisted value for backward compatibility.
 */
export function resolveHydratedPlaybackIntent(
    serverState: PlaybackIntentSnapshot | null | undefined,
    fallbackIsPlaying: boolean
): boolean {
    if (typeof serverState?.isPlaying === "boolean") {
        return serverState.isPlaying;
    }
    return fallbackIsPlaying;
}
