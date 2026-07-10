/**
 * Pure utility functions for queue manipulation logic.
 * Extracted so core algorithms can be unit-tested without React context.
 */

export interface PlayNowInsertionInput {
    queue: unknown[];
    currentIndex: number;
    isShuffle: boolean;
    shuffleIndices: number[];
}

export interface PlayNowInsertionResult {
    insertAt: number;
    newCurrentIndex: number;
    newShuffleIndices: number[];
}

/**
 * Computes where to insert a "play now" track and how to update indices.
 * Does NOT mutate any arrays — returns new values for the caller to apply.
 */
export function computePlayNowInsertion(
    input: PlayNowInsertionInput
): PlayNowInsertionResult {
    const { currentIndex, isShuffle, shuffleIndices } = input;
    const insertAt = currentIndex + 1;

    let newShuffleIndices: number[] = [];

    if (isShuffle && shuffleIndices.length > 0) {
        // Shift all indices >= insertAt up by 1
        const shifted = shuffleIndices.map((i) =>
            i >= insertAt ? i + 1 : i
        );
        // Find current track's position in shuffle order and insert right after it
        const currentShufflePos = shifted.indexOf(currentIndex);
        const shuffleInsertPos =
            currentShufflePos >= 0 ? currentShufflePos + 1 : 0;
        newShuffleIndices = [...shifted];
        newShuffleIndices.splice(shuffleInsertPos, 0, insertAt);
    }

    return {
        insertAt,
        newCurrentIndex: insertAt,
        newShuffleIndices,
    };
}

/** Minimal queue entry shape used for podcast context placement. */
export interface PodcastPlacementQueueEntry {
    id: string;
    itemType?: string;
}

/** Input for {@link computePodcastContextPlacement}. */
export interface PodcastContextPlacementInput<T extends { id: string }> {
    queue: ReadonlyArray<PodcastPlacementQueueEntry>;
    currentIndex: number;
    isShuffle: boolean;
    shuffleIndices: readonly number[];
    /** Episode queue entry the user chose to play. */
    selected: T;
    /** Episode context (e.g. forward episodes from the podcast page). */
    context: readonly T[];
}

/** How a chosen podcast episode (plus optional context) joins the queue. */
export type PodcastContextPlacement<T> =
    | { action: "replace"; items: T[]; startIndex: number }
    | { action: "jump"; index: number }
    | {
          action: "insert";
          items: T[];
          insertAt: number;
          newCurrentIndex: number;
          newShuffleIndices: number[];
      };

/**
 * Computes how a podcast episode (with optional episode context) is placed
 * into the play queue without clearing items the user has queued:
 * - empty queue: replace with the episode context (or just the episode),
 * - episode already queued: jump to it,
 * - otherwise: insert the episode plus not-yet-queued context items right
 *   after the current item, so the rest of the mixed queue survives.
 * Does NOT mutate any arrays — returns new values for the caller to apply.
 */
export function computePodcastContextPlacement<T extends { id: string }>(
    input: PodcastContextPlacementInput<T>
): PodcastContextPlacement<T> {
    const {
        queue,
        currentIndex,
        isShuffle,
        shuffleIndices,
        selected,
        context,
    } = input;
    const contextItems: T[] = context.some((item) => item.id === selected.id)
        ? [...context]
        : [selected, ...context];

    if (queue.length === 0) {
        return {
            action: "replace",
            items: contextItems,
            startIndex: Math.max(
                0,
                contextItems.findIndex((item) => item.id === selected.id)
            ),
        };
    }

    const existingIndex = queue.findIndex(
        (entry) => entry.itemType === "episode" && entry.id === selected.id
    );
    if (existingIndex >= 0) {
        return { action: "jump", index: existingIndex };
    }

    const queuedIds = new Set(queue.map((entry) => entry.id));
    const items = contextItems.filter(
        (item) => item.id === selected.id || !queuedIds.has(item.id)
    );
    const insertAt = Math.min(Math.max(currentIndex + 1, 0), queue.length);

    let newShuffleIndices: number[] = [];
    if (isShuffle && shuffleIndices.length > 0) {
        // Shift all indices >= insertAt up by the inserted count, then slot
        // the inserted items right after the current shuffle position.
        const shifted = shuffleIndices.map((i) =>
            i >= insertAt ? i + items.length : i
        );
        const currentShufflePos = shifted.indexOf(currentIndex);
        const shuffleInsertPos =
            currentShufflePos >= 0 ? currentShufflePos + 1 : 0;
        newShuffleIndices = [...shifted];
        newShuffleIndices.splice(
            shuffleInsertPos,
            0,
            ...items.map((_, offset) => insertAt + offset)
        );
    }

    return {
        action: "insert",
        items,
        insertAt,
        newCurrentIndex:
            insertAt +
            Math.max(
                0,
                items.findIndex((item) => item.id === selected.id)
            ),
        newShuffleIndices,
    };
}

/**
 * Move one item to a new index with splice semantics (remove `fromIndex`,
 * insert at `toIndex`). Returns the input unchanged (same reference) for
 * no-op moves or out-of-range indexes; never mutates the input.
 */
export function moveItemInList<T>(
    list: T[],
    fromIndex: number,
    toIndex: number,
): T[] {
    if (
        fromIndex === toIndex ||
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= list.length ||
        toIndex >= list.length
    ) {
        return list;
    }
    const next = [...list];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next;
}

/**
 * Remap shuffle indices after a queue move so every shuffle entry keeps
 * pointing at the same item it referenced before the move (GH queue
 * reorder; the pre-existing move handlers skipped this, silently
 * corrupting the shuffle order). Returns the input unchanged for no-ops.
 */
export function remapShuffleIndicesForMove(
    indices: number[],
    fromIndex: number,
    toIndex: number,
): number[] {
    if (fromIndex === toIndex) {
        return indices;
    }
    return indices.map((position) => {
        if (position === fromIndex) return toIndex;
        if (fromIndex < toIndex) {
            // Positions between the old and new slots shift down by one.
            return position > fromIndex && position <= toIndex
                ? position - 1
                : position;
        }
        // Backward move: positions between the new and old slots shift up.
        return position >= toIndex && position < fromIndex
            ? position + 1
            : position;
    });
}
