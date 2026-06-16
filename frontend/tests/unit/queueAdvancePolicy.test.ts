import assert from "node:assert/strict";
import test from "node:test";
import {
    resolveQueueAdvance,
    type QueueAdvancePolicyItem,
} from "../../lib/audio/queue-advance-policy";

const track = (id: string): QueueAdvancePolicyItem & { id: string } => ({
    id,
    itemType: "track",
});
const legacyTrack = (id: string): QueueAdvancePolicyItem & { id: string } => ({
    id,
});
const episode = (id: string): QueueAdvancePolicyItem & { id: string } => ({
    id,
    itemType: "episode",
});

test("empty queue resolves to stop", () => {
    const result = resolveQueueAdvance({
        action: "next",
        queue: [],
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
        repeatMode: "off",
    });
    assert.deepEqual(result, { kind: "stop" });
});

test("next moves from track into episode", () => {
    const result = resolveQueueAdvance({
        action: "next",
        queue: [track("t1"), episode("p:e1"), track("t2")],
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
        repeatMode: "off",
    });
    assert.deepEqual(result, { kind: "episode", index: 1 });
});

test("next moves from episode into track", () => {
    const result = resolveQueueAdvance({
        action: "next",
        queue: [track("t1"), episode("p:e1"), track("t2")],
        currentIndex: 1,
        isShuffle: false,
        shuffleIndices: [],
        repeatMode: "off",
    });
    assert.deepEqual(result, { kind: "track", index: 2 });
});

test("items without itemType resolve as tracks", () => {
    const result = resolveQueueAdvance({
        action: "next",
        queue: [episode("p:e1"), legacyTrack("t1")],
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
        repeatMode: "off",
    });
    assert.deepEqual(result, { kind: "track", index: 1 });
});

test("next at end of queue stops when repeat is off", () => {
    const result = resolveQueueAdvance({
        action: "next",
        queue: [track("t1"), episode("p:e1")],
        currentIndex: 1,
        isShuffle: false,
        shuffleIndices: [],
        repeatMode: "off",
    });
    assert.deepEqual(result, { kind: "stop" });
});

test("next at end of queue stops when repeat is one", () => {
    const result = resolveQueueAdvance({
        action: "next",
        queue: [track("t1"), episode("p:e1")],
        currentIndex: 1,
        isShuffle: false,
        shuffleIndices: [],
        repeatMode: "one",
    });
    assert.deepEqual(result, { kind: "stop" });
});

test("next at end of queue wraps with repeat all and reports item kind", () => {
    const result = resolveQueueAdvance({
        action: "next",
        queue: [episode("p:e1"), track("t1")],
        currentIndex: 1,
        isShuffle: false,
        shuffleIndices: [],
        repeatMode: "all",
    });
    assert.deepEqual(result, { kind: "episode", index: 0 });
});

test("previous at start of queue stops", () => {
    const result = resolveQueueAdvance({
        action: "previous",
        queue: [episode("p:e1"), track("t1")],
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
        repeatMode: "off",
    });
    assert.deepEqual(result, { kind: "stop" });
});

test("previous lands on an episode item", () => {
    const result = resolveQueueAdvance({
        action: "previous",
        queue: [track("t1"), episode("p:e1"), track("t2")],
        currentIndex: 2,
        isShuffle: false,
        shuffleIndices: [],
        repeatMode: "off",
    });
    assert.deepEqual(result, { kind: "episode", index: 1 });
});

test("shuffle follows shuffle order and keeps episodes in the pool", () => {
    // Shuffle order: t1 (idx 0) -> episode (idx 2) -> t2 (idx 1)
    const queue = [track("t1"), track("t2"), episode("p:e1")];
    const shuffleIndices = [0, 2, 1];

    const first = resolveQueueAdvance({
        action: "next",
        queue,
        currentIndex: 0,
        isShuffle: true,
        shuffleIndices,
        repeatMode: "off",
    });
    assert.deepEqual(first, { kind: "episode", index: 2 });

    const second = resolveQueueAdvance({
        action: "next",
        queue,
        currentIndex: 2,
        isShuffle: true,
        shuffleIndices,
        repeatMode: "off",
    });
    assert.deepEqual(second, { kind: "track", index: 1 });
});

test("shuffle next at end of order stops unless repeat all", () => {
    const queue = [track("t1"), episode("p:e1")];
    const shuffleIndices = [1, 0];

    const stop = resolveQueueAdvance({
        action: "next",
        queue,
        currentIndex: 0,
        isShuffle: true,
        shuffleIndices,
        repeatMode: "off",
    });
    assert.deepEqual(stop, { kind: "stop" });

    const wrap = resolveQueueAdvance({
        action: "next",
        queue,
        currentIndex: 0,
        isShuffle: true,
        shuffleIndices,
        repeatMode: "all",
    });
    assert.deepEqual(wrap, { kind: "episode", index: 1 });
});

test("shuffle previous walks backwards through the order", () => {
    const queue = [track("t1"), episode("p:e1"), track("t2")];
    const shuffleIndices = [2, 1, 0];

    const result = resolveQueueAdvance({
        action: "previous",
        queue,
        currentIndex: 1,
        isShuffle: true,
        shuffleIndices,
        repeatMode: "off",
    });
    assert.deepEqual(result, { kind: "track", index: 2 });
});

test("stale shuffle order missing the current index falls back to sequential", () => {
    // Episode was inserted into the queue without refreshing the shuffle order
    // (e.g. playing a podcast while shuffle was enabled). Advancement must not
    // dead-end; it falls back to sequential queue order.
    const queue = [track("t1"), episode("p:e1"), track("t2")];

    const next = resolveQueueAdvance({
        action: "next",
        queue,
        currentIndex: 1,
        isShuffle: true,
        shuffleIndices: [0, 2],
        repeatMode: "off",
    });
    assert.deepEqual(next, { kind: "track", index: 2 });

    const previous = resolveQueueAdvance({
        action: "previous",
        queue,
        currentIndex: 1,
        isShuffle: true,
        shuffleIndices: [],
        repeatMode: "off",
    });
    assert.deepEqual(previous, { kind: "track", index: 0 });
});

test("out-of-range current index stops", () => {
    const result = resolveQueueAdvance({
        action: "next",
        queue: [track("t1")],
        currentIndex: 5,
        isShuffle: false,
        shuffleIndices: [],
        repeatMode: "off",
    });
    assert.deepEqual(result, { kind: "stop" });
});
