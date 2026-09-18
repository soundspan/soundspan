import assert from "node:assert/strict";
import test from "node:test";
import { placeByAnchors } from "../../components/vibe/mapPlacement";

const positions: Record<string, { x: number; y: number }> = {
    a: { x: 0, y: 0 },
    b: { x: 1, y: 0 },
    c: { x: 0, y: 1 },
};
const posOf = (id: string) => positions[id] ?? null;

function close(actual: number, expected: number): void {
    assert.ok(
        Math.abs(actual - expected) < 1e-6,
        `${actual} is not close to ${expected}`,
    );
}

test("equal distances give the plain centroid", () => {
    const point = placeByAnchors(
        [
            { id: "a", distance: 0.5 },
            { id: "b", distance: 0.5 },
        ],
        posOf,
    );
    assert.ok(point);
    close(point.x, 0.5);
    close(point.y, 0);
});

test("closer anchors pull harder", () => {
    const point = placeByAnchors(
        [
            { id: "a", distance: 0.1 },
            { id: "b", distance: 0.9 },
        ],
        posOf,
    );
    assert.ok(point);
    assert.ok(point.x < 0.2, `expected to sit near a, got x=${point.x}`);
});

test("a zero-distance anchor dominates without producing infinity", () => {
    const point = placeByAnchors(
        [
            { id: "c", distance: 0 },
            { id: "b", distance: 1 },
        ],
        posOf,
    );
    assert.ok(point);
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    assert.ok(point.y > 0.99);
});

test("anchors without a layout position are skipped", () => {
    const point = placeByAnchors(
        [
            { id: "gone", distance: 0.01 },
            { id: "b", distance: 0.5 },
        ],
        posOf,
    );
    assert.deepEqual(point, { x: 1, y: 0 });
});

test("returns null when nothing can be placed", () => {
    assert.equal(placeByAnchors([], posOf), null);
    assert.equal(placeByAnchors([{ id: "gone", distance: 0.1 }], posOf), null);
    assert.equal(
        placeByAnchors([{ id: "a", distance: Number.NaN }], posOf),
        null,
    );
    assert.equal(placeByAnchors([{ id: "a", distance: -1 }], posOf), null);
});
