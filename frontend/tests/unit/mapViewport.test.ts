import assert from "node:assert/strict";
import test from "node:test";
import {
    clampViewport,
    fitBounds,
    FIT_BOUNDS_MAX_ZOOM,
    fitViewport,
    flyTo,
    interpolateViewport,
    MAX_SCALE,
    MIN_SCALE,
    screenToWorld,
    worldToScreen,
    zoomAt,
    type Viewport,
} from "../../components/vibe/mapViewport";

function approx(actual: number, expected: number, eps = 1e-6): void {
    assert.ok(
        Math.abs(actual - expected) <= eps,
        `expected ~${expected}, got ${actual}`
    );
}

test("worldToScreen and screenToWorld round-trip", () => {
    const vp: Viewport = { scale: 512, tx: 33, ty: 71 };
    for (const p of [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 1 },
        { x: 0.137, y: 0.884 },
    ]) {
        const back = screenToWorld(vp, worldToScreen(vp, p));
        approx(back.x, p.x);
        approx(back.y, p.y);
    }
});

test("fitViewport centers the 0..1 box inside the padded region", () => {
    const vp = fitViewport({ width: 800, height: 600 });
    // Uniform scale = min(width-80, height-80) = min(720, 520) = 520.
    approx(vp.scale, 520);
    const topLeft = worldToScreen(vp, { x: 0, y: 0 });
    const bottomRight = worldToScreen(vp, { x: 1, y: 1 });
    // Content is centered: equal slack on both sides of each axis.
    approx(topLeft.x, 800 - bottomRight.x);
    approx(topLeft.y, 600 - bottomRight.y);
    // Stays within the 40px padded region.
    assert.ok(topLeft.x >= 40 - 1e-6 && bottomRight.x <= 760 + 1e-6);
    assert.ok(topLeft.y >= 40 - 1e-6 && bottomRight.y <= 560 + 1e-6);
});

test("zoomAt keeps the world point under the cursor fixed", () => {
    const vp: Viewport = { scale: 600, tx: 25, ty: 40 };
    const cursors = [
        { x: 0, y: 0 },
        { x: 150, y: 320 },
        { x: 640, y: 480 },
        { x: 400, y: 300 },
    ];
    const factors = [1.3, 0.5, 2.5, 1 / 1.3, 4];
    for (const cursor of cursors) {
        const worldUnder = screenToWorld(vp, cursor);
        for (const factor of factors) {
            // No bounds -> exact transform (clamping can't perturb the invariant).
            const next = zoomAt(vp, cursor, factor);
            const projected = worldToScreen(next, worldUnder);
            approx(projected.x, cursor.x, 1e-6);
            approx(projected.y, cursor.y, 1e-6);
        }
    }
});

test("zoomAt clamps scale to [MIN_SCALE, MAX_SCALE]", () => {
    const vp: Viewport = { scale: 600, tx: 0, ty: 0 };
    assert.equal(zoomAt(vp, { x: 10, y: 10 }, 10_000).scale, MAX_SCALE);
    assert.equal(zoomAt(vp, { x: 10, y: 10 }, 0.00001).scale, MIN_SCALE);
});

test("flyTo centers the target world point on screen", () => {
    const vp: Viewport = { scale: 300, tx: 10, ty: 10 };
    const bounds = { width: 800, height: 600 };
    const worldPt = { x: 0.5, y: 0.5 };
    const result = flyTo(vp, worldPt, 500, bounds);
    approx(result.scale, 500);
    const screen = worldToScreen(result, worldPt);
    approx(screen.x, 400); // width / 2
    approx(screen.y, 300); // height / 2
});

test("flyTo falls back to current scale when targetScale is not finite", () => {
    const vp: Viewport = { scale: 321, tx: 0, ty: 0 };
    const result = flyTo(vp, { x: 0.5, y: 0.5 }, Number.NaN, {
        width: 800,
        height: 600,
    });
    approx(result.scale, 321);
});

test("clampViewport keeps the content from being lost off-screen", () => {
    const bounds = { width: 800, height: 600 };
    const scale = 400;
    // Pushed far past the right/bottom edge.
    const clampedFar = clampViewport({ scale, tx: 100000, ty: 100000 }, bounds);
    assert.ok(clampedFar.tx <= 800 - 40 + 1e-6);
    assert.ok(clampedFar.ty <= 600 - 40 + 1e-6);
    // Pushed far past the left/top edge.
    const clampedNeg = clampViewport({ scale, tx: -100000, ty: -100000 }, bounds);
    assert.ok(clampedNeg.tx >= -scale + 40 - 1e-6);
    assert.ok(clampedNeg.ty >= -scale + 40 - 1e-6);
    // A viewport already on-screen is untouched.
    const ok: Viewport = { scale, tx: 50, ty: 50 };
    assert.deepEqual(clampViewport(ok, bounds), ok);
});

test("zoomAt with bounds still clamps translation", () => {
    const bounds = { width: 800, height: 600 };
    // Zoom out hard at a corner; result must remain on-screen.
    const next = zoomAt({ scale: 4000, tx: -3000, ty: -3000 }, { x: 0, y: 0 }, 0.1, bounds);
    assert.ok(next.tx <= 800 - 40 + 1e-6 && next.tx >= -next.scale + 40 - 1e-6);
    assert.ok(next.ty <= 600 - 40 + 1e-6 && next.ty >= -next.scale + 40 - 1e-6);
});

test("fitBounds centers the box and keeps it inside the padding", () => {
    const bounds = { width: 800, height: 600 };
    const box = { minX: 0.2, minY: 0.4, maxX: 0.6, maxY: 0.6 };
    const vp = fitBounds(box, bounds);
    // Box center lands on screen center.
    const center = worldToScreen(vp, { x: 0.4, y: 0.5 });
    approx(center.x, 400);
    approx(center.y, 300);
    // The whole box fits within the 80px padded region.
    const tl = worldToScreen(vp, { x: box.minX, y: box.minY });
    const br = worldToScreen(vp, { x: box.maxX, y: box.maxY });
    assert.ok(tl.x >= 80 - 1e-6 && br.x <= 720 + 1e-6);
    assert.ok(tl.y >= 80 - 1e-6 && br.y <= 520 + 1e-6);
});

test("fitBounds caps a degenerate (single-point) box at the max-zoom multiple", () => {
    const bounds = { width: 800, height: 600 };
    const vp = fitBounds({ minX: 0.5, minY: 0.5, maxX: 0.5, maxY: 0.5 }, bounds);
    const cap = fitViewport(bounds).scale * FIT_BOUNDS_MAX_ZOOM;
    assert.ok(vp.scale <= cap + 1e-6, `scale ${vp.scale} exceeds cap ${cap}`);
});

test("interpolateViewport returns exact endpoints and a stable focus path", () => {
    const bounds = { width: 800, height: 600 };
    const from: Viewport = { scale: 520, tx: 140, ty: 40 };
    const to: Viewport = { scale: 2600, tx: -900, ty: -700 };
    assert.deepEqual(interpolateViewport(from, to, 0, bounds), from);
    assert.deepEqual(interpolateViewport(from, to, 1, bounds), to);

    // The world point at screen center travels monotonically from the from-
    // center to the to-center while scale grows monotonically (log-lerped).
    const center = { x: 400, y: 300 };
    const c0 = screenToWorld(from, center);
    const c1 = screenToWorld(to, center);
    let prevScale = from.scale;
    let prevX = c0.x;
    for (const t of [0.25, 0.5, 0.75]) {
        const mid = interpolateViewport(from, to, t, bounds);
        assert.ok(mid.scale > prevScale, "scale must grow monotonically");
        prevScale = mid.scale;
        const cMid = screenToWorld(mid, center);
        // Center-x moves toward c1 without overshooting.
        const dir = Math.sign(c1.x - c0.x);
        assert.ok(cMid.x * dir >= prevX * dir - 1e-9);
        assert.ok(cMid.x * dir <= c1.x * dir + 1e-9);
        prevX = cMid.x;
        // And the mid-flight center is the exact linear blend.
        approx(cMid.x, c0.x + (c1.x - c0.x) * t, 1e-9);
        approx(cMid.y, c0.y + (c1.y - c0.y) * t, 1e-9);
    }
});
