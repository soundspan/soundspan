import assert from "node:assert/strict";
import test from "node:test";
import {
    resolveDropPosition,
    resolveDropTargetIndex,
    resolveKeyboardReorderTarget,
} from "../../components/track/reorderDnd";

test("resolveDropPosition splits a row at its vertical midpoint", () => {
    assert.equal(resolveDropPosition(10, 64), "before");
    assert.equal(resolveDropPosition(31, 64), "before");
    assert.equal(resolveDropPosition(32, 64), "after");
    assert.equal(resolveDropPosition(60, 64), "after");
    // Degenerate row height never crashes.
    assert.equal(resolveDropPosition(0, 0), "after");
});

test("dropping after a later row lands just after it (splice semantics)", () => {
    // Move row 0 to after row 2 → final index 2.
    assert.equal(resolveDropTargetIndex(0, 2, "after"), 2);
    // Move row 0 to before row 2 → final index 1.
    assert.equal(resolveDropTargetIndex(0, 2, "before"), 1);
});

test("dropping before an earlier row lands exactly there", () => {
    // Move row 3 to before row 1 → final index 1.
    assert.equal(resolveDropTargetIndex(3, 1, "before"), 1);
    // Move row 3 to after row 1 → final index 2.
    assert.equal(resolveDropTargetIndex(3, 1, "after"), 2);
});

test("dropping onto the dragged row's own position is a no-op", () => {
    assert.equal(resolveDropTargetIndex(2, 2, "before"), 2);
    assert.equal(resolveDropTargetIndex(2, 2, "after"), 2);
    // Adjacent no-ops: before the next row / after the previous row.
    assert.equal(resolveDropTargetIndex(2, 3, "before"), 2);
    assert.equal(resolveDropTargetIndex(2, 1, "after"), 2);
});

test("boundaries: drop before first and after last", () => {
    assert.equal(resolveDropTargetIndex(5, 0, "before"), 0);
    assert.equal(resolveDropTargetIndex(0, 9, "after"), 9);
});

test("keyboard ArrowUp and ArrowDown reorder an item in the middle", () => {
    assert.equal(resolveKeyboardReorderTarget("ArrowUp", 1, 3), 0);
    assert.equal(resolveKeyboardReorderTarget("ArrowDown", 1, 3), 2);
});

test("keyboard arrow reordering stops at list boundaries", () => {
    assert.equal(resolveKeyboardReorderTarget("ArrowUp", 0, 3), null);
    assert.equal(resolveKeyboardReorderTarget("ArrowDown", 2, 3), null);
});

test("keyboard Home and End reorder to the list boundaries", () => {
    assert.equal(resolveKeyboardReorderTarget("Home", 2, 4), 0);
    assert.equal(resolveKeyboardReorderTarget("End", 1, 4), 3);
});

test("keyboard reordering is disabled for a single-item list", () => {
    assert.equal(resolveKeyboardReorderTarget("ArrowDown", 0, 1), null);
});

test("keyboard reordering ignores unknown keys", () => {
    assert.equal(resolveKeyboardReorderTarget("Enter", 1, 3), null);
});
