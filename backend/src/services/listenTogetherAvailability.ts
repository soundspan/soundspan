import type { GroupSnapshot, SyncQueueItem } from "./listenTogetherTypes";

const MAX_QUEUE_IDENTITY_ITEMS = 500;

/** Captured playback boundary used to reject late availability resolution. */
export interface AvailabilityIdentity {
    readonly queueIdentity: string;
    readonly currentIndex: number;
    readonly stateVersion: number;
}

function queueItemIdentity(item: SyncQueueItem): readonly unknown[] {
    return [
        item.id,
        item.localTrackId ?? null,
        item.trackMappingId ?? null,
        item.trackTidalId ?? null,
        item.trackYtMusicId ?? null,
        item.tidalTrackId ?? null,
        item.youtubeVideoId ?? null,
    ];
}

function queueIdentity(queue: SyncQueueItem[]): string {
    if (queue.length > MAX_QUEUE_IDENTITY_ITEMS) return "oversized";
    const identity: Array<readonly unknown[]> = [];
    for (let index = 0; index < MAX_QUEUE_IDENTITY_ITEMS; index += 1) {
        const item = queue[index];
        if (!item) break;
        identity.push(queueItemIdentity(item));
    }
    return JSON.stringify(identity);
}

/** Capture the queue, index, and version that one resolution operation used. */
export function captureAvailabilityIdentity(
    snapshot: GroupSnapshot,
): AvailabilityIdentity {
    return {
        queueIdentity: queueIdentity(snapshot.playback.queue),
        currentIndex: snapshot.playback.currentIndex,
        stateVersion: snapshot.playback.stateVersion,
    };
}

/** Validate that availability still targets the exact captured playback boundary. */
export function matchesAvailabilityIdentity(
    snapshot: GroupSnapshot,
    expected: AvailabilityIdentity,
): boolean {
    return (
        snapshot.playback.currentIndex === expected.currentIndex &&
        snapshot.playback.stateVersion === expected.stateVersion &&
        queueIdentity(snapshot.playback.queue) === expected.queueIdentity
    );
}
