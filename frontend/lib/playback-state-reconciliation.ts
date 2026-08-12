export type PlaybackSnapshotType = "track" | "audiobook" | "podcast" | null;

export interface QueueTrackIdentity {
    id?: string | null;
}

/**
 * Queue item shape carrying enough provider identity to decide whether a
 * persisted current track can be restored straight from the queue snapshot.
 */
export interface RestorableQueueTrack extends QueueTrackIdentity {
    streamSource?: string | null;
    youtubeVideoId?: string | null;
    tidalTrackId?: number | string | null;
}

// Track-id shapes that the library track lookup can never resolve:
// "yt:<videoId>" / "tidal:<id>" provider composites and the synthetic
// "yt-<videoId>" ids of pasted youtube-direct tracks.
const NON_LIBRARY_TRACK_ID_PREFIXES = ["yt:", "yt-", "tidal:"];

/**
 * Returns whether a persisted current-track id refers to a non-library
 * (provider/synthetic) track that GET /api/library/tracks/:id cannot
 * resolve. Restore paths must never clear persisted playback state over a
 * 404 for such ids — the track exists, just not in the local library.
 */
export function isNonLibraryTrackId(
    trackId: string | null | undefined,
): boolean {
    if (typeof trackId !== "string") return false;
    return NON_LIBRARY_TRACK_ID_PREFIXES.some((prefix) =>
        trackId.startsWith(prefix),
    );
}

/**
 * Find the persisted server-queue item for a remote (non-library) current
 * track so restore paths can materialize it directly instead of calling the
 * library track lookup. Returns null for library tracks (which must keep
 * using the library lookup) and when the track id is absent from the queue.
 */
export function findRemoteQueueTrackForRestore<T extends RestorableQueueTrack>(
    trackId: string | null | undefined,
    serverQueue: readonly T[] | null | undefined,
): T | null {
    if (typeof trackId !== "string" || !trackId.trim()) return null;
    if (!Array.isArray(serverQueue) || serverQueue.length === 0) return null;

    const normalizedId = trackId.trim();
    for (const item of serverQueue) {
        const itemId = item?.id;
        if (itemId === null || itemId === undefined) continue;
        if (String(itemId).trim() !== normalizedId) continue;

        const streamSource = item.streamSource;
        const isRemote =
            isNonLibraryTrackId(normalizedId) ||
            streamSource === "tidal" ||
            streamSource === "youtube" ||
            streamSource === "youtube-direct" ||
            Boolean(item.youtubeVideoId) ||
            (item.tidalTrackId !== null && item.tidalTrackId !== undefined);
        return isRemote ? item : null;
    }
    return null;
}

export interface ServerPlaybackPollDecisionInput {
    localPlaybackType: PlaybackSnapshotType;
    localMediaId: string | null;
    localQueue: readonly QueueTrackIdentity[];
    localLastSaveAtMs: number;
    serverPlaybackType: PlaybackSnapshotType;
    serverMediaId: string | null;
    serverQueue: readonly QueueTrackIdentity[] | null | undefined;
    serverUpdatedAtMs: number;
}

export type ServerPlaybackPollDecisionReason =
    | "adopt_server"
    | "media_unchanged"
    | "server_older_than_local_save"
    | "local_track_queue_authoritative"
    | "server_queue_truncated_prefix"
    | "server_media_behind_local_queue";

export interface ServerPlaybackPollDecision {
    shouldApplyServerSnapshot: boolean;
    reason: ServerPlaybackPollDecisionReason;
}

function toQueueTrackIds(
    queue: readonly QueueTrackIdentity[] | null | undefined,
): string[] {
    if (!Array.isArray(queue) || queue.length === 0) {
        return [];
    }

    const ids: string[] = [];
    for (const item of queue) {
        const rawId = item?.id;
        if (rawId === null || rawId === undefined) {
            continue;
        }
        const normalizedId = String(rawId).trim();
        if (!normalizedId) {
            continue;
        }
        ids.push(normalizedId);
    }
    return ids;
}

/**
 * Executes queuesMatchByTrackId.
 */
export function queuesMatchByTrackId(
    localQueue: readonly QueueTrackIdentity[] | null | undefined,
    serverQueue: readonly QueueTrackIdentity[] | null | undefined,
): boolean {
    const localIds = toQueueTrackIds(localQueue);
    const serverIds = toQueueTrackIds(serverQueue);

    if (localIds.length !== serverIds.length) {
        return false;
    }

    for (let index = 0; index < localIds.length; index += 1) {
        if (localIds[index] !== serverIds[index]) {
            return false;
        }
    }

    return true;
}

/**
 * Executes isServerQueueTruncatedPrefix.
 */
export function isServerQueueTruncatedPrefix(
    localQueue: readonly QueueTrackIdentity[] | null | undefined,
    serverQueue: readonly QueueTrackIdentity[] | null | undefined,
): boolean {
    const localIds = toQueueTrackIds(localQueue);
    const serverIds = toQueueTrackIds(serverQueue);

    if (
        localIds.length === 0 ||
        serverIds.length === 0 ||
        serverIds.length >= localIds.length
    ) {
        return false;
    }

    for (let index = 0; index < serverIds.length; index += 1) {
        if (localIds[index] !== serverIds[index]) {
            return false;
        }
    }

    return true;
}

/**
 * Executes normalizeQueueIndex.
 */
export function normalizeQueueIndex(
    index: unknown,
    queueLength: number,
): number {
    const safeQueueLength = Number.isFinite(queueLength)
        ? Math.max(0, Math.trunc(queueLength))
        : 0;

    if (safeQueueLength <= 0) {
        return 0;
    }

    const parsedIndex =
        typeof index === "number"
            ? index
            : Number.parseInt(String(index ?? "0"), 10);
    const safeIndex = Number.isFinite(parsedIndex)
        ? Math.trunc(parsedIndex)
        : 0;

    return Math.min(Math.max(0, safeIndex), safeQueueLength - 1);
}

/**
 * Executes resolveServerPlaybackPollDecision.
 */
export function resolveServerPlaybackPollDecision(
    input: ServerPlaybackPollDecisionInput,
): ServerPlaybackPollDecision {
    if (
        input.localLastSaveAtMs > 0 &&
        input.serverUpdatedAtMs > 0 &&
        input.serverUpdatedAtMs <= input.localLastSaveAtMs
    ) {
        return {
            shouldApplyServerSnapshot: false,
            reason: "server_older_than_local_save",
        };
    }

    if (
        input.localPlaybackType === input.serverPlaybackType &&
        input.localMediaId === input.serverMediaId
    ) {
        return {
            shouldApplyServerSnapshot: false,
            reason: "media_unchanged",
        };
    }

    const localActiveTrackId =
        input.localPlaybackType === "track" && input.localMediaId
            ? input.localMediaId
            : null;
    if (localActiveTrackId && input.localQueue.length > 0) {
        if (isServerQueueTruncatedPrefix(input.localQueue, input.serverQueue)) {
            return {
                shouldApplyServerSnapshot: false,
                reason: "server_queue_truncated_prefix",
            };
        }

        if (input.serverPlaybackType === "track" && input.serverMediaId) {
            const localQueueIds = toQueueTrackIds(input.localQueue);
            const localCurrentPosition =
                localQueueIds.indexOf(localActiveTrackId);
            const serverMediaPosition = localQueueIds.indexOf(
                input.serverMediaId,
            );

            if (
                localCurrentPosition >= 0 &&
                serverMediaPosition >= 0 &&
                serverMediaPosition < localCurrentPosition
            ) {
                return {
                    shouldApplyServerSnapshot: false,
                    reason: "server_media_behind_local_queue",
                };
            }
        }

        return {
            shouldApplyServerSnapshot: false,
            reason: "local_track_queue_authoritative",
        };
    }

    return {
        shouldApplyServerSnapshot: true,
        reason: "adopt_server",
    };
}
