/** Playback identity captured when progress first reaches the end boundary. */
export interface TrackEndWatchdogSnapshot {
    trackId: string;
    loadId: number;
    statusWasPlaying: boolean;
}

interface TrackEndWatchdogOptions {
    timeoutMs: number;
    shouldHandle: (snapshot: TrackEndWatchdogSnapshot) => boolean;
    onUnhandledEnd: (snapshot: TrackEndWatchdogSnapshot) => void;
}

/** One-shot end watchdog owned and cancelled by the playback orchestrator. */
export interface TrackEndWatchdog {
    arm(snapshot: TrackEndWatchdogSnapshot): void;
    clear(): void;
}

/**
 * Creates a bounded one-shot watchdog without polling while playback is idle.
 * Repeated arms for the same track/load retain the original deadline.
 */
export function createTrackEndWatchdog({
    timeoutMs,
    shouldHandle,
    onUnhandledEnd,
}: TrackEndWatchdogOptions): TrackEndWatchdog {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let pendingSnapshot: TrackEndWatchdogSnapshot | null = null;

    const clear = (): void => {
        if (timeoutId !== null) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        pendingSnapshot = null;
    };

    const arm = (snapshot: TrackEndWatchdogSnapshot): void => {
        if (!snapshot.trackId || !snapshot.statusWasPlaying) {
            clear();
            return;
        }
        if (
            pendingSnapshot?.trackId === snapshot.trackId &&
            pendingSnapshot.loadId === snapshot.loadId
        ) {
            return;
        }

        clear();
        pendingSnapshot = snapshot;
        timeoutId = setTimeout(() => {
            const expiredSnapshot = pendingSnapshot;
            timeoutId = null;
            pendingSnapshot = null;
            if (expiredSnapshot && shouldHandle(expiredSnapshot)) {
                onUnhandledEnd(expiredSnapshot);
            }
        }, timeoutMs);
    };

    return { arm, clear };
}
