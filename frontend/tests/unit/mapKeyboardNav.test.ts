import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveMapKeyNav } from "../../components/vibe/mapKeyboardNav";

// `order` is the list of navigable track indices (e.g. the visible dots) in
// traversal order; `focusedIndex` is the currently focused track index.

test("returns none when there is nothing navigable", () => {
    assert.deepEqual(
        resolveMapKeyNav("ArrowRight", { order: [], focusedIndex: null }),
        { type: "none" },
    );
});

test("first arrow focuses the first navigable node when nothing is focused", () => {
    assert.deepEqual(
        resolveMapKeyNav("ArrowRight", {
            order: [2, 5, 9],
            focusedIndex: null,
        }),
        { type: "move", index: 2 },
    );
    assert.deepEqual(
        resolveMapKeyNav("ArrowLeft", { order: [2, 5, 9], focusedIndex: null }),
        { type: "move", index: 2 },
    );
});

test("forward keys advance and clamp at the last node", () => {
    assert.deepEqual(
        resolveMapKeyNav("ArrowRight", { order: [2, 5, 9], focusedIndex: 2 }),
        { type: "move", index: 5 },
    );
    assert.deepEqual(
        resolveMapKeyNav("ArrowDown", { order: [2, 5, 9], focusedIndex: 9 }),
        { type: "move", index: 9 },
    );
});

test("backward keys retreat and clamp at the first node", () => {
    assert.deepEqual(
        resolveMapKeyNav("ArrowLeft", { order: [2, 5, 9], focusedIndex: 5 }),
        { type: "move", index: 2 },
    );
    assert.deepEqual(
        resolveMapKeyNav("ArrowUp", { order: [2, 5, 9], focusedIndex: 2 }),
        { type: "move", index: 2 },
    );
});

test("Home and End jump to the ends of the navigable list", () => {
    assert.deepEqual(
        resolveMapKeyNav("Home", { order: [2, 5, 9], focusedIndex: 9 }),
        { type: "move", index: 2 },
    );
    assert.deepEqual(
        resolveMapKeyNav("End", { order: [2, 5, 9], focusedIndex: 2 }),
        { type: "move", index: 9 },
    );
});

test("Enter and Space select the focused node", () => {
    for (const key of ["Enter", " ", "Spacebar"]) {
        assert.deepEqual(
            resolveMapKeyNav(key, { order: [2, 5, 9], focusedIndex: 5 }),
            { type: "select", index: 5 },
        );
    }
});

test("selection keys do nothing without a focused node", () => {
    assert.deepEqual(
        resolveMapKeyNav("Enter", { order: [2, 5, 9], focusedIndex: null }),
        { type: "none" },
    );
});

test("a focused index that is no longer navigable is treated as unfocused", () => {
    // index 7 is not in `order`; a forward key should focus the first node.
    assert.deepEqual(
        resolveMapKeyNav("ArrowRight", { order: [2, 5, 9], focusedIndex: 7 }),
        { type: "move", index: 2 },
    );
    assert.deepEqual(
        resolveMapKeyNav("Enter", { order: [2, 5, 9], focusedIndex: 7 }),
        { type: "none" },
    );
});

test("unrelated keys yield none", () => {
    assert.deepEqual(
        resolveMapKeyNav("Tab", { order: [2, 5, 9], focusedIndex: 5 }),
        { type: "none" },
    );
});
