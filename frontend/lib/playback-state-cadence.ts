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

/** Debounced flush handle returned by {@link createDebouncedStorageFlush}. */
export interface DebouncedStorageFlush {
    /** Schedule (or reschedule) a flush callback. Only the most recent callback fires. */
    schedule(fn: () => void): void;
    /** Cancel any pending flush without running it. */
    cancel(): void;
    /** Immediately run the pending flush (if any) and clear the timer. */
    flush(): void;
}

/**
 * Factory that creates a debounced flush handle for batching localStorage writes.
 * Successive `schedule()` calls within `delayMs` coalesce — only the last-scheduled
 * callback fires once the delay elapses.
 */
export function createDebouncedStorageFlush(delayMs: number): DebouncedStorageFlush {
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let pendingFn: (() => void) | null = null;

    return {
        schedule(fn: () => void) {
            pendingFn = fn;
            if (timerId !== null) {
                clearTimeout(timerId);
            }
            timerId = setTimeout(() => {
                timerId = null;
                const toRun = pendingFn;
                pendingFn = null;
                toRun?.();
            }, delayMs);
        },
        cancel() {
            if (timerId !== null) {
                clearTimeout(timerId);
                timerId = null;
            }
            pendingFn = null;
        },
        flush() {
            if (timerId !== null) {
                clearTimeout(timerId);
                timerId = null;
            }
            const toRun = pendingFn;
            pendingFn = null;
            toRun?.();
        },
    };
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
