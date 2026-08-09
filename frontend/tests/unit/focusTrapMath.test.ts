import assert from "node:assert/strict";
import test from "node:test";
import { nextFocusIndex } from "../../components/ui/focusTrapMath";

test("nextFocusIndex wraps forward from the final element", () => {
    assert.equal(nextFocusIndex(3, 2, false), 0);
});

test("nextFocusIndex wraps backward from the first element", () => {
    assert.equal(nextFocusIndex(3, 0, true), 2);
});

test("nextFocusIndex keeps a single element selected", () => {
    assert.equal(nextFocusIndex(1, 0, false), 0);
    assert.equal(nextFocusIndex(1, 0, true), 0);
});

test("nextFocusIndex returns -1 when no focusable elements exist", () => {
    assert.equal(nextFocusIndex(0, -1, false), -1);
});

test("nextFocusIndex enters from outside in the tab direction", () => {
    assert.equal(nextFocusIndex(3, -1, false), 0);
    assert.equal(nextFocusIndex(3, -1, true), 2);
});
