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
