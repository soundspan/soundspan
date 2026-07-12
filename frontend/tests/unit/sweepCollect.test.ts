import assert from "node:assert/strict";
import test from "node:test";
import {
    collectHits,
    sampleSegment,
    SWEEP_CAP,
} from "../../components/vibe/sweepCollect";
import type { Viewport } from "../../components/vibe/mapViewport";

// Identity-ish viewport: world 0..1 -> screen 0..1000.
const VP: Viewport = { scale: 1000, tx: 0, ty: 0 };

function fixtures(coords: Array<[number, number]>, maskBits?: number[]) {
    const ids = coords.map((_, i) => ({ id: `t${i}` }));
    const positions = new Float32Array(coords.flat());
    const mask = new Uint8Array(
        maskBits ?? Array.from({ length: coords.length }, () => 1)
    );
    return { ids, positions, mask };
}

test("sampleSegment covers the segment without gaps and always ends at b", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    const pts = sampleSegment(a, b, 16);
    assert.deepEqual(pts[pts.length - 1], b);
    // No two consecutive samples (incl. the start) further apart than step.
    let prev = a;
    for (const p of pts) {
        assert.ok(Math.hypot(p.x - prev.x, p.y - prev.y) <= 16 + 1e-9);
        prev = p;
    }
    // Zero-length segment yields just b (so a stationary pointer still samples).
    assert.deepEqual(sampleSegment(a, a, 16), [a]);
});

test("collectHits collects only visible dots within the radius", () => {
    // Dots at screen (100,100), (110,100), (400,400); middle one filtered out.
    const { ids, positions, mask } = fixtures(
        [
            [0.1, 0.1],
            [0.11, 0.1],
            [0.4, 0.4],
        ],
        [1, 0, 1]
    );
    const seen = new Set<string>();
    const out: string[] = [];
    collectHits({
        cursor: { x: 100, y: 100 },
        ids,
        positions,
        mask,
        viewport: VP,
        radius: 24,
        seen,
        out,
    });
    // t0 in radius; t1 in radius but masked; t2 far away.
    assert.deepEqual(out, ["t0"]);
});

test("collectHits dedupes across calls and preserves first-touch order", () => {
    const { ids, positions, mask } = fixtures([
        [0.1, 0.1], // t0 @ (100,100)
        [0.2, 0.1], // t1 @ (200,100)
    ]);
    const seen = new Set<string>();
    const out: string[] = [];
    const args = { ids, positions, mask, viewport: VP, radius: 24, seen, out };
    collectHits({ ...args, cursor: { x: 100, y: 100 } }); // catches t0
    collectHits({ ...args, cursor: { x: 200, y: 100 } }); // catches t1
    collectHits({ ...args, cursor: { x: 100, y: 100 } }); // t0 again — deduped
    assert.deepEqual(out, ["t0", "t1"]);
});

test("collectHits stops at the cap", () => {
    // 150 dots stacked on the same spot.
    const coords = Array.from({ length: 150 }, () => [0.5, 0.5] as [number, number]);
    const { ids, positions, mask } = fixtures(coords);
    const seen = new Set<string>();
    const out: string[] = [];
    collectHits({
        cursor: { x: 500, y: 500 },
        ids,
        positions,
        mask,
        viewport: VP,
        seen,
        out,
    });
    assert.equal(out.length, SWEEP_CAP);
    // And a custom cap is honored too.
    const out2: string[] = [];
    collectHits({
        cursor: { x: 500, y: 500 },
        ids,
        positions,
        mask,
        viewport: VP,
        cap: 5,
        seen: new Set<string>(),
        out: out2,
    });
    assert.equal(out2.length, 5);
});
