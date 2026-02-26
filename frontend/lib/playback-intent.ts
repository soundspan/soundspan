/** Minimal server playback payload used to restore play/pause intent on startup. */
export interface PlaybackIntentSnapshot {
    isPlaying?: boolean;
}

export type PlaybackMachineState =
    | "IDLE"
    | "LOADING"
    | "RECOVERING"
    | "READY"
    | "PLAYING"
    | "SEEKING"
    | "BUFFERING"
    | "ERROR";

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

/**
 * Derive UI play intent from playback-state-machine state while preserving the
 * previous intent through transitional states.
 */
export function resolveMachinePlaybackIntent(
    machineState: PlaybackMachineState,
    previousIntent: boolean
): boolean {
    if (machineState === "PLAYING") {
        return true;
    }
    if (
        machineState === "IDLE" ||
        machineState === "READY" ||
        machineState === "ERROR"
    ) {
        return false;
    }
    return previousIntent;
}
