export type PlaybackSnapshotType = "track" | "audiobook" | "podcast" | null;

export interface QueueTrackIdentity {
    id?: string | null;
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

function toQueueTrackIds(queue: readonly QueueTrackIdentity[] | null | undefined): string[] {
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

export function queuesMatchByTrackId(
    localQueue: readonly QueueTrackIdentity[] | null | undefined,
    serverQueue: readonly QueueTrackIdentity[] | null | undefined
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

export function isServerQueueTruncatedPrefix(
    localQueue: readonly QueueTrackIdentity[] | null | undefined,
    serverQueue: readonly QueueTrackIdentity[] | null | undefined
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

export function normalizeQueueIndex(
    index: unknown,
    queueLength: number
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
    const safeIndex = Number.isFinite(parsedIndex) ? Math.trunc(parsedIndex) : 0;

    return Math.min(Math.max(0, safeIndex), safeQueueLength - 1);
}

export function resolveServerPlaybackPollDecision(
    input: ServerPlaybackPollDecisionInput
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
    const hasActiveLocalTrackQueue =
        Boolean(localActiveTrackId) && input.localQueue.length > 0;

    if (hasActiveLocalTrackQueue) {
        if (isServerQueueTruncatedPrefix(input.localQueue, input.serverQueue)) {
            return {
                shouldApplyServerSnapshot: false,
                reason: "server_queue_truncated_prefix",
            };
        }

        if (input.serverPlaybackType === "track" && input.serverMediaId) {
            const localQueueIds = toQueueTrackIds(input.localQueue);
            const localCurrentPosition = localQueueIds.indexOf(localActiveTrackId);
            const serverMediaPosition = localQueueIds.indexOf(input.serverMediaId);

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
