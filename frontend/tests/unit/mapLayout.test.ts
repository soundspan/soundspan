import assert from "node:assert/strict";
import test from "node:test";
import {
    buildPositions,
    computeSpreadPositions,
    lerpPositions,
    type PositionableTrack,
} from "../../components/vibe/mapLayout";

test("buildPositions is the identity natural layout, index-aligned", () => {
    const tracks: PositionableTrack[] = [
        { x: 0.1, y: 0.2 },
        { x: 0.9, y: 0.4 },
    ];
    const out = buildPositions(tracks);
    const expected = new Float32Array([0.1, 0.2, 0.9, 0.4]);
    assert.deepEqual(Array.from(out), Array.from(expected));
});

test("buildPositions on an empty track list returns an empty buffer", () => {
    assert.equal(buildPositions([]).length, 0);
});

test("spread output is bounded 0..1 for every coordinate", () => {
    const tracks: PositionableTrack[] = Array.from({ length: 12 }, (_, i) => ({
        x: Math.sin(i * 12.9898) * 0.5 + 0.5,
        y: Math.cos(i * 78.233) * 0.5 + 0.5,
    }));
    const out = computeSpreadPositions(tracks);
    assert.equal(out.length, tracks.length * 2);
    for (const v of out) {
        assert.ok(v >= 0 && v <= 1, `expected 0..1, got ${v}`);
    }
});

test("spread rank correctness on a known small set, including a tie", () => {
    // x values are all distinct (0, 10, 5); y values are all tied (5, 5, 5).
    const tracks: PositionableTrack[] = [
        { x: 0, y: 5 }, // idx 0
        { x: 10, y: 5 }, // idx 1
        { x: 5, y: 5 }, // idx 2
    ];
    const out = computeSpreadPositions(tracks);
    // x: idx0 (0) -> rank0 -> 0; idx2 (5) -> rank1 -> 0.5; idx1 (10) -> rank2 -> 1
    // y: all tied -> stable tie-break by original index -> idx0=0, idx1=0.5, idx2=1
    assert.deepEqual(Array.from(out), [0, 0, 1, 0.5, 0.5, 1]);
});

test("spread positions for a single track centers at (0.5, 0.5)", () => {
    const out = computeSpreadPositions([{ x: 0.1, y: 0.9 }]);
    assert.deepEqual(Array.from(out), [0.5, 0.5]);
});

test("spread positions for zero tracks is an empty buffer", () => {
    assert.equal(computeSpreadPositions([]).length, 0);
});

test("lerpPositions endpoints are exact: t<=0 copies a, t>=1 copies b", () => {
    const a = new Float32Array([0, 0, 1, 1, 0.25, 0.75]);
    const b = new Float32Array([1, 1, 0, 0, 0.9, 0.1]);
    const out = new Float32Array(6);

    const r0 = lerpPositions(a, b, 0, out);
    assert.equal(r0, out);
    assert.deepEqual(Array.from(out), Array.from(a));

    const r1 = lerpPositions(a, b, 1, out);
    assert.equal(r1, out);
    assert.deepEqual(Array.from(out), Array.from(b));

    // Overshoot beyond [0,1] (an eased animation frame can round past 1)
    // still clamps to the exact endpoint copy.
    const rNeg = lerpPositions(a, b, -0.2, out);
    assert.deepEqual(Array.from(rNeg), Array.from(a));
    const rOver = lerpPositions(a, b, 1.2, out);
    assert.deepEqual(Array.from(rOver), Array.from(b));
});

test("lerpPositions at the midpoint averages each coordinate", () => {
    const a = new Float32Array([0, 0]);
    const b = new Float32Array([1, 1]);
    const out = new Float32Array(2);
    lerpPositions(a, b, 0.5, out);
    assert.deepEqual(Array.from(out), [0.5, 0.5]);
});

test("lerpPositions reuses the out-buffer: no per-frame allocation", () => {
    const a = new Float32Array([0, 0]);
    const b = new Float32Array([1, 1]);
    const out = new Float32Array(2);

    const frame1 = lerpPositions(a, b, 0.25, out);
    const frame2 = lerpPositions(a, b, 0.5, out);
    const frame3 = lerpPositions(a, b, 0.75, out);

    // Every call returns the SAME buffer reference — the caller can drive an
    // animation loop off one allocated buffer.
    assert.equal(frame1, out);
    assert.equal(frame2, out);
    assert.equal(frame3, out);
    assert.equal(frame1, frame2);
    assert.equal(frame2, frame3);
});
