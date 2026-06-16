/**
 * Pure queue-advance policy for the unified mixed-media play queue.
 *
 * Resolves next/previous navigation over a queue that may contain both
 * music tracks and podcast episodes. Episodes participate in queue order
 * (and in the shuffle pool) exactly like tracks; the caller dispatches the
 * resolved item to the appropriate playback path based on `kind`.
 */

/** Minimal structural shape of a queue entry the policy needs. */
export interface QueueAdvancePolicyItem {
    /** "episode" for podcast episodes; missing/"track" means music track. */
    itemType?: string;
}

/** Repeat mode shared with the player state. */
export type QueueAdvanceRepeatMode = "off" | "one" | "all";

/** Direction of queue navigation. */
export type QueueAdvanceAction = "next" | "previous";

/** Input for {@link resolveQueueAdvance}. */
export interface ResolveQueueAdvanceInput {
    action: QueueAdvanceAction;
    queue: readonly QueueAdvancePolicyItem[];
    currentIndex: number;
    isShuffle: boolean;
    shuffleIndices: readonly number[];
    repeatMode: QueueAdvanceRepeatMode;
}

/**
 * Result of resolving a queue advance: the target queue index plus the kind
 * of media at that index, or `stop` when there is nowhere to go.
 */
export type QueueAdvanceResolution =
    | { kind: "track"; index: number }
    | { kind: "episode"; index: number }
    | { kind: "stop" };

function resolveSequentialIndex(
    action: QueueAdvanceAction,
    queueLength: number,
    currentIndex: number,
    repeatMode: QueueAdvanceRepeatMode
): number | null {
    if (action === "next") {
        if (currentIndex < queueLength - 1 && currentIndex >= 0) {
            return currentIndex + 1;
        }
        if (repeatMode === "all") {
            return 0;
        }
        return null;
    }

    if (currentIndex > 0 && currentIndex <= queueLength - 1) {
        return currentIndex - 1;
    }
    return null;
}

function resolveShuffleIndex(
    action: QueueAdvanceAction,
    shuffleIndices: readonly number[],
    currentIndex: number,
    repeatMode: QueueAdvanceRepeatMode
): number | null {
    const currentShufflePos = shuffleIndices.indexOf(currentIndex);
    if (currentShufflePos < 0) {
        // Stale shuffle order (e.g. an item was inserted without refreshing
        // the order). Callers fall back to sequential resolution.
        return null;
    }

    if (action === "next") {
        if (currentShufflePos < shuffleIndices.length - 1) {
            return shuffleIndices[currentShufflePos + 1];
        }
        if (repeatMode === "all") {
            return shuffleIndices[0] ?? null;
        }
        return null;
    }

    if (currentShufflePos > 0) {
        return shuffleIndices[currentShufflePos - 1];
    }
    return null;
}

/**
 * Resolves the next/previous item over a mixed queue of tracks and podcast
 * episodes. Shuffle follows the provided shuffle order (episodes stay in the
 * pool); when the shuffle order does not contain the current index it falls
 * back to sequential order so playback never dead-ends on a stale order.
 */
export function resolveQueueAdvance(
    input: ResolveQueueAdvanceInput
): QueueAdvanceResolution {
    const { action, queue, currentIndex, isShuffle, shuffleIndices, repeatMode } =
        input;
    if (queue.length === 0) return { kind: "stop" };

    let targetIndex: number | null = null;
    if (isShuffle && shuffleIndices.includes(currentIndex)) {
        targetIndex = resolveShuffleIndex(
            action,
            shuffleIndices,
            currentIndex,
            repeatMode
        );
    } else {
        targetIndex = resolveSequentialIndex(
            action,
            queue.length,
            currentIndex,
            repeatMode
        );
    }

    if (
        targetIndex === null ||
        targetIndex < 0 ||
        targetIndex >= queue.length
    ) {
        return { kind: "stop" };
    }

    const target = queue[targetIndex];
    if (target?.itemType === "episode") {
        return { kind: "episode", index: targetIndex };
    }
    return { kind: "track", index: targetIndex };
}
