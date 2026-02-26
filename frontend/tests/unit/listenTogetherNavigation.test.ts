import assert from "node:assert/strict";
import test from "node:test";
import { resolveListenTogetherNavigationIndex } from "../../lib/listen-together-navigation.ts";

test("next wraps to index 0 at queue end", () => {
    const index = resolveListenTogetherNavigationIndex({
        action: "next",
        queueLength: 4,
        currentIndex: 3,
        currentPositionMs: 0,
    });

    assert.equal(index, 0);
});

test("previous restarts current track when position exceeds 3 seconds", () => {
    const index = resolveListenTogetherNavigationIndex({
        action: "previous",
        queueLength: 4,
        currentIndex: 2,
        currentPositionMs: 3500,
    });

    assert.equal(index, 2);
});

test("previous wraps to queue end at index 0 when under restart threshold", () => {
    const index = resolveListenTogetherNavigationIndex({
        action: "previous",
        queueLength: 4,
        currentIndex: 0,
        currentPositionMs: 1200,
    });

    assert.equal(index, 3);
});

test("previous decrements index when under restart threshold away from start", () => {
    const index = resolveListenTogetherNavigationIndex({
        action: "previous",
        queueLength: 4,
        currentIndex: 2,
        currentPositionMs: 1200,
    });

    assert.equal(index, 1);
});

test("previous at exactly 3 seconds moves to prior track", () => {
    const index = resolveListenTogetherNavigationIndex({
        action: "previous",
        queueLength: 4,
        currentIndex: 2,
        currentPositionMs: 3000,
    });

    assert.equal(index, 1);
});

test("clamps out-of-range current index before navigation", () => {
    assert.equal(
        resolveListenTogetherNavigationIndex({
            action: "next",
            queueLength: 4,
            currentIndex: 99,
            currentPositionMs: 0,
        }),
        0,
    );
    assert.equal(
        resolveListenTogetherNavigationIndex({
            action: "previous",
            queueLength: 4,
            currentIndex: -5,
            currentPositionMs: 0,
        }),
        3,
    );
});

test("returns null for empty queues", () => {
    const index = resolveListenTogetherNavigationIndex({
        action: "next",
        queueLength: 0,
        currentIndex: 0,
        currentPositionMs: 0,
    });

    assert.equal(index, null);
});

test("returns null for negative queue lengths", () => {
    const index = resolveListenTogetherNavigationIndex({
        action: "previous",
        queueLength: -2,
        currentIndex: 0,
        currentPositionMs: 0,
    });

    assert.equal(index, null);
});
