import assert from "node:assert/strict";
import { test } from "node:test";
import {
    clampTrackSwipeOffset,
    resolveTrackSwipeAction,
    resolveVerticalDragOffset,
    shouldCloseFromVerticalSwipe,
} from "../../lib/overlay-gesture-policy";

test("track swipe offset clamps to the visual travel range", () => {
    assert.equal(clampTrackSwipeOffset(250), 100);
    assert.equal(clampTrackSwipeOffset(-250), -100);
    assert.equal(clampTrackSwipeOffset(42), 42);
});

test("track swipe action requires the threshold and skip permission", () => {
    assert.equal(resolveTrackSwipeAction(61, true), "previous");
    assert.equal(resolveTrackSwipeAction(-61, true), "next");
    assert.equal(resolveTrackSwipeAction(60, true), null);
    assert.equal(resolveTrackSwipeAction(-60, true), null);
    assert.equal(resolveTrackSwipeAction(100, false), null);
});

test("vertical drag offset tracks downward-dominant movement only", () => {
    assert.equal(resolveVerticalDragOffset(100, 10, 240), 100);
    assert.equal(resolveVerticalDragOffset(400, 10, 240), 240);
    assert.equal(resolveVerticalDragOffset(-5, 0, 240), 0);
    // Horizontal-dominant drags leave the offset untouched.
    assert.equal(resolveVerticalDragOffset(50, 100, 240), null);
});

test("swipe close fires on distance or flick velocity, downward only", () => {
    const base = { deltaX: 0 };
    assert.equal(
        shouldCloseFromVerticalSwipe({ ...base, deltaY: 45, elapsedMs: 1000 }),
        true,
        "distance close",
    );
    assert.equal(
        shouldCloseFromVerticalSwipe({ ...base, deltaY: 30, elapsedMs: 50 }),
        true,
        "velocity close",
    );
    assert.equal(
        shouldCloseFromVerticalSwipe({ ...base, deltaY: 30, elapsedMs: 1000 }),
        false,
        "slow short drag stays open",
    );
    assert.equal(
        shouldCloseFromVerticalSwipe({
            deltaY: 45,
            deltaX: 60,
            elapsedMs: 100,
        }),
        false,
        "diagonal swipe stays open",
    );
    assert.equal(
        shouldCloseFromVerticalSwipe({ ...base, deltaY: -45, elapsedMs: 10 }),
        false,
        "upward swipe stays open",
    );
});
