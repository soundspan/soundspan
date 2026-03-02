import assert from "node:assert/strict";
import test from "node:test";
import { computePlayNowInsertion } from "../../lib/queue-utils.ts";

test("inserts track after current index in a non-shuffle queue", () => {
    const result = computePlayNowInsertion({
        queue: ["A", "B", "C"],
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
    });

    assert.deepEqual(result.insertAt, 1);
    assert.equal(result.newCurrentIndex, 1);
});

test("inserts track at the end when current is last in queue", () => {
    const result = computePlayNowInsertion({
        queue: ["A", "B", "C"],
        currentIndex: 2,
        isShuffle: false,
        shuffleIndices: [],
    });

    assert.equal(result.insertAt, 3);
    assert.equal(result.newCurrentIndex, 3);
});

test("inserts into a single-track queue", () => {
    const result = computePlayNowInsertion({
        queue: ["A"],
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
    });

    assert.equal(result.insertAt, 1);
    assert.equal(result.newCurrentIndex, 1);
});

test("shifts shuffle indices >= insertAt and splices new index after current", () => {
    // Queue: [A, B, C], shuffle order: [0, 2, 1] (play A, then C, then B)
    // Currently playing A (index 0). Insert at index 1.
    const result = computePlayNowInsertion({
        queue: ["A", "B", "C"],
        currentIndex: 0,
        isShuffle: true,
        shuffleIndices: [0, 2, 1],
    });

    assert.equal(result.insertAt, 1);
    assert.equal(result.newCurrentIndex, 1);

    // After shift: indices >= 1 get +1: [0, 3, 2]
    // Then splice new index (1) after current position in shuffle (pos 0): [0, 1, 3, 2]
    assert.deepEqual(result.newShuffleIndices, [0, 1, 3, 2]);
});

test("shuffle indices shift correctly when inserting in the middle", () => {
    // Queue: [A, B, C, D], shuffle: [0, 3, 1, 2], currently at index 1 (B)
    // Insert at index 2
    const result = computePlayNowInsertion({
        queue: ["A", "B", "C", "D"],
        currentIndex: 1,
        isShuffle: true,
        shuffleIndices: [0, 3, 1, 2],
    });

    assert.equal(result.insertAt, 2);
    assert.equal(result.newCurrentIndex, 2);

    // Shift: indices >= 2 get +1: [0, 4, 1, 3]
    // Current index (1) is at shuffle position 2. Insert new (2) at position 3: [0, 4, 1, 2, 3]
    assert.deepEqual(result.newShuffleIndices, [0, 4, 1, 2, 3]);
});

test("handles empty shuffle indices in shuffle mode gracefully", () => {
    const result = computePlayNowInsertion({
        queue: ["A", "B"],
        currentIndex: 0,
        isShuffle: true,
        shuffleIndices: [],
    });

    assert.equal(result.insertAt, 1);
    assert.equal(result.newCurrentIndex, 1);
    // With empty shuffle indices, should return empty (caller regenerates)
    assert.deepEqual(result.newShuffleIndices, []);
});

test("inserts at shuffle start when current index is absent from shuffle order", () => {
    const result = computePlayNowInsertion({
        queue: ["A", "B", "C", "D"],
        currentIndex: 2,
        isShuffle: true,
        shuffleIndices: [0, 1, 3],
    });

    assert.equal(result.insertAt, 3);
    assert.equal(result.newCurrentIndex, 3);
    assert.deepEqual(result.newShuffleIndices, [3, 0, 1, 4]);
});
