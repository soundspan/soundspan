/** Shared storage key suffix used to mark the most recent local playback-state write time. */
export const LAST_PLAYBACK_STATE_SAVE_AT_KEY_SUFFIX =
    "last_playback_state_save_at";

/** Shared storage key suffix stamped when the user clears the queue.
 *  Used to prevent the server poll from re-adopting stale state after a clear. */
export const QUEUE_CLEARED_AT_KEY_SUFFIX = "queue_cleared_at";

/** Periodic write cadence for playback progress persistence. */
export const PLAYBACK_PROGRESS_SAVE_INTERVAL_MS = 15000;
/** Poll cooldown window after a local write to avoid immediate redundant playback-state reads. */
export const PLAYBACK_POLL_AFTER_LOCAL_SAVE_COOLDOWN_MS = 25000;

/** Parses a persisted local write timestamp and normalizes invalid values to zero. */
export function parsePlaybackStateSaveTimestamp(raw: string | null): number {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return 0;
    }
    return parsed;
}

/** Returns true when playback-state polling should be skipped due to a recent local save. */
export function shouldSkipPlaybackStatePoll(
    lastLocalSaveAtMs: number,
    nowMs = Date.now()
): boolean {
    return (
        lastLocalSaveAtMs > 0 &&
        nowMs - lastLocalSaveAtMs <
            PLAYBACK_POLL_AFTER_LOCAL_SAVE_COOLDOWN_MS
    );
}
