import assert from "node:assert/strict";
import test from "node:test";
import { computePodcastContextPlacement } from "../../lib/queue-utils";

const track = (id: string) => ({ id, itemType: "track" });
const episode = (id: string) => ({ id, itemType: "episode" });

test("empty queue replaces with the episode context", () => {
    const result = computePodcastContextPlacement({
        queue: [],
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
        selected: episode("p:e2"),
        context: [episode("p:e1"), episode("p:e2"), episode("p:e3")],
    });
    assert.deepEqual(result, {
        action: "replace",
        items: [episode("p:e1"), episode("p:e2"), episode("p:e3")],
        startIndex: 1,
    });
});

test("empty queue without context seeds just the selected episode", () => {
    const result = computePodcastContextPlacement({
        queue: [],
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
        selected: episode("p:e1"),
        context: [],
    });
    assert.deepEqual(result, {
        action: "replace",
        items: [episode("p:e1")],
        startIndex: 0,
    });
});

test("selected episode already queued jumps without touching the queue", () => {
    const result = computePodcastContextPlacement({
        queue: [track("t1"), episode("p:e1"), track("t2")],
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
        selected: episode("p:e1"),
        context: [episode("p:e1"), episode("p:e2")],
    });
    assert.deepEqual(result, { action: "jump", index: 1 });
});

test("episode context merges after the current item and keeps queued music", () => {
    // Headline mixed-queue scenario: an episode is playing with music queued
    // behind it; tapping the next episode on the podcast page must not
    // replace the queue.
    const result = computePodcastContextPlacement({
        queue: [episode("p:e1"), track("t1"), track("t2")],
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
        selected: episode("p:e2"),
        context: [episode("p:e2"), episode("p:e3")],
    });
    assert.deepEqual(result, {
        action: "insert",
        items: [episode("p:e2"), episode("p:e3")],
        insertAt: 1,
        newCurrentIndex: 1,
        newShuffleIndices: [],
    });
});

test("context items already in the queue are not inserted twice", () => {
    const result = computePodcastContextPlacement({
        queue: [episode("p:e1"), episode("p:e3"), track("t1")],
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
        selected: episode("p:e2"),
        context: [episode("p:e2"), episode("p:e3")],
    });
    assert.deepEqual(result, {
        action: "insert",
        items: [episode("p:e2")],
        insertAt: 1,
        newCurrentIndex: 1,
        newShuffleIndices: [],
    });
});

test("context missing the selected episode still inserts it first", () => {
    const result = computePodcastContextPlacement({
        queue: [track("t1")],
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
        selected: episode("p:e2"),
        context: [episode("p:e3")],
    });
    assert.deepEqual(result, {
        action: "insert",
        items: [episode("p:e2"), episode("p:e3")],
        insertAt: 1,
        newCurrentIndex: 1,
        newShuffleIndices: [],
    });
});

test("music playing: episode inserts after the current track", () => {
    const result = computePodcastContextPlacement({
        queue: [track("t1"), track("t2")],
        currentIndex: 0,
        isShuffle: false,
        shuffleIndices: [],
        selected: episode("p:e1"),
        context: [episode("p:e1")],
    });
    assert.deepEqual(result, {
        action: "insert",
        items: [episode("p:e1")],
        insertAt: 1,
        newCurrentIndex: 1,
        newShuffleIndices: [],
    });
});

test("shuffle order shifts and slots inserted items after the current position", () => {
    const result = computePodcastContextPlacement({
        queue: [track("t1"), track("t2"), track("t3")],
        currentIndex: 0,
        isShuffle: true,
        shuffleIndices: [0, 2, 1],
        selected: episode("p:e1"),
        context: [episode("p:e1"), episode("p:e2")],
    });
    assert.equal(result.action, "insert");
    assert.deepEqual(
        result.action === "insert" ? result.newShuffleIndices : [],
        [0, 1, 2, 4, 3]
    );
});

test("currentIndex beyond queue bounds clamps insertion to the end", () => {
    const result = computePodcastContextPlacement({
        queue: [track("t1")],
        currentIndex: 5,
        isShuffle: false,
        shuffleIndices: [],
        selected: episode("p:e1"),
        context: [],
    });
    assert.equal(result.action, "insert");
    assert.equal(result.action === "insert" ? result.insertAt : -1, 1);
});
