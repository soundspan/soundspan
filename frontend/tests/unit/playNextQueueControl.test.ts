import assert from "node:assert/strict";
import test from "node:test";

/**
 * Unit tests for playNext queue insertion logic.
 *
 * playNext inserts a track at currentIndex + 1 (immediately after the
 * currently playing track), before any other Up-Next items.
 * This is distinct from addToQueue which uses a cursor that advances.
 *
 * Since playNext lives inside a React context callback with complex
 * dependencies, we test the core queue manipulation logic in isolation.
 */

interface Track {
    id: string;
    title: string;
    artist?: { name: string; id?: string };
    album?: { title: string; id?: string };
    duration?: number;
}

/** Simulate the queue splice that playNext performs */
function simulatePlayNextInsert(
    queue: Track[],
    currentIndex: number,
    newTrack: Track
): { newQueue: Track[]; insertAt: number } {
    const insertAt = currentIndex + 1;
    const newQueue = [...queue];
    newQueue.splice(insertAt, 0, newTrack);
    return { newQueue, insertAt };
}

/** Simulate shuffle index update after playNext insert */
function simulateShuffleIndexUpdate(
    prevIndices: number[],
    insertAt: number,
    currentIndex: number
): number[] {
    if (prevIndices.length === 0) return prevIndices;
    // Shift indices >= insertAt up by 1
    const shifted = prevIndices.map((i) => (i >= insertAt ? i + 1 : i));
    // Insert new track right after current in shuffle order
    const currentShufflePos = shifted.indexOf(currentIndex);
    const shuffleInsertPos = currentShufflePos >= 0 ? currentShufflePos + 1 : 0;
    const newIndices = [...shifted];
    newIndices.splice(shuffleInsertPos, 0, insertAt);
    return newIndices;
}

/** Simulate upNextInsertRef cursor bump after playNext */
function simulateUpNextCursorBump(
    currentCursor: number,
    insertAt: number
): number {
    return Math.max(currentCursor, insertAt) + 1;
}

const trackA: Track = { id: "a", title: "Track A" };
const trackB: Track = { id: "b", title: "Track B" };
const trackC: Track = { id: "c", title: "Track C" };
const trackD: Track = { id: "d", title: "Track D" };
const trackNew: Track = { id: "new", title: "New Track" };

test("playNext inserts track at currentIndex + 1", () => {
    const queue = [trackA, trackB, trackC];
    const currentIndex = 0;
    const { newQueue, insertAt } = simulatePlayNextInsert(queue, currentIndex, trackNew);

    assert.equal(insertAt, 1);
    assert.equal(newQueue.length, 4);
    assert.equal(newQueue[0].id, "a"); // current stays
    assert.equal(newQueue[1].id, "new"); // inserted here
    assert.equal(newQueue[2].id, "b"); // shifted
    assert.equal(newQueue[3].id, "c"); // shifted
});

test("playNext inserts after middle track", () => {
    const queue = [trackA, trackB, trackC, trackD];
    const currentIndex = 2; // playing trackC
    const { newQueue, insertAt } = simulatePlayNextInsert(queue, currentIndex, trackNew);

    assert.equal(insertAt, 3);
    assert.equal(newQueue.length, 5);
    assert.equal(newQueue[2].id, "c"); // current stays
    assert.equal(newQueue[3].id, "new"); // inserted after current
    assert.equal(newQueue[4].id, "d"); // shifted
});

test("playNext inserts at end when playing last track", () => {
    const queue = [trackA, trackB, trackC];
    const currentIndex = 2; // playing last track
    const { newQueue, insertAt } = simulatePlayNextInsert(queue, currentIndex, trackNew);

    assert.equal(insertAt, 3);
    assert.equal(newQueue.length, 4);
    assert.equal(newQueue[2].id, "c"); // current stays
    assert.equal(newQueue[3].id, "new"); // appended
});

test("playNext into single-track queue inserts at position 1", () => {
    const queue = [trackA];
    const currentIndex = 0;
    const { newQueue, insertAt } = simulatePlayNextInsert(queue, currentIndex, trackNew);

    assert.equal(insertAt, 1);
    assert.equal(newQueue.length, 2);
    assert.equal(newQueue[0].id, "a");
    assert.equal(newQueue[1].id, "new");
});

test("upNextInsertRef cursor bumps past inserted track", () => {
    // Cursor was at 1 (right after current at index 0)
    const cursor = simulateUpNextCursorBump(1, 1);
    assert.equal(cursor, 2); // now points past the inserted track

    // Cursor was already further out (e.g., after previous addToQueue calls)
    const cursor2 = simulateUpNextCursorBump(3, 1);
    assert.equal(cursor2, 4); // bumped by 1 since we inserted before cursor
});

test("shuffle indices shift correctly after playNext insert", () => {
    // Queue: [A=0, B=1, C=2], shuffle order: [0, 2, 1] (A, C, B)
    // Playing A (index 0), insert new track at index 1
    const prevIndices = [0, 2, 1];
    const insertAt = 1;
    const currentIndex = 0;

    const newIndices = simulateShuffleIndexUpdate(prevIndices, insertAt, currentIndex);

    // After shift: indices >= 1 get +1, so [0, 3, 2]
    // Insert new track (index 1) after current (pos 0 in shuffle)
    // Result: [0, 1, 3, 2]
    assert.equal(newIndices.length, 4);
    assert.equal(newIndices[0], 0); // current track
    assert.equal(newIndices[1], 1); // newly inserted
    assert.equal(newIndices[2], 3); // was C (shifted from 2 to 3)
    assert.equal(newIndices[3], 2); // was B (shifted from 1 to 2)
});

test("shuffle indices handle empty array", () => {
    const newIndices = simulateShuffleIndexUpdate([], 1, 0);
    assert.deepEqual(newIndices, []);
});

test("multiple playNext calls insert in LIFO order (most recent plays first)", () => {
    let queue = [trackA, trackB, trackC];
    let currentIndex = 0;

    // First playNext: insert trackNew
    const result1 = simulatePlayNextInsert(queue, currentIndex, trackNew);
    queue = result1.newQueue;

    // Second playNext: insert trackD (should go at index 1 again, pushing trackNew to 2)
    const result2 = simulatePlayNextInsert(queue, currentIndex, trackD);
    queue = result2.newQueue;

    assert.equal(queue.length, 5);
    assert.equal(queue[0].id, "a"); // current
    assert.equal(queue[1].id, "d"); // most recent playNext (plays first)
    assert.equal(queue[2].id, "new"); // earlier playNext
    assert.equal(queue[3].id, "b");
    assert.equal(queue[4].id, "c");
});
