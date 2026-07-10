import assert from "node:assert/strict";
import test from "node:test";
import {
    moveItemInList,
    remapShuffleIndicesForMove,
} from "../../lib/queue-utils";

const list = () => ["a", "b", "c", "d", "e"];

test("moveItemInList moves forward and backward with splice semantics", () => {
    assert.deepEqual(moveItemInList(list(), 1, 3), ["a", "c", "d", "b", "e"]);
    assert.deepEqual(moveItemInList(list(), 3, 1), ["a", "d", "b", "c", "e"]);
    assert.deepEqual(moveItemInList(list(), 0, 4), ["b", "c", "d", "e", "a"]);
});

test("moveItemInList returns the same reference for no-ops and invalid indexes", () => {
    const input = list();
    assert.equal(moveItemInList(input, 2, 2), input);
    assert.equal(moveItemInList(input, -1, 2), input);
    assert.equal(moveItemInList(input, 2, 5), input);
    assert.equal(moveItemInList(input, 5, 2), input);
});

test("moveItemInList never mutates its input", () => {
    const input = list();
    moveItemInList(input, 1, 3);
    assert.deepEqual(input, list());
});

test("remapShuffleIndicesForMove keeps every index pointing at the same item", () => {
    // Items at positions [0..4]; shuffle order references positions.
    // Move position 1 -> 3: old positions map 0->0, 1->3, 2->1, 3->2, 4->4.
    assert.deepEqual(
        remapShuffleIndicesForMove([4, 1, 0, 3, 2], 1, 3),
        [4, 3, 0, 2, 1],
    );
    // Move position 3 -> 1: old positions map 0->0, 1->2, 2->3, 3->1, 4->4.
    assert.deepEqual(
        remapShuffleIndicesForMove([4, 1, 0, 3, 2], 3, 1),
        [4, 2, 0, 1, 3],
    );
});

test("remapShuffleIndicesForMove is identity for no-op moves", () => {
    const indices = [2, 0, 1];
    assert.equal(remapShuffleIndicesForMove(indices, 1, 1), indices);
});
