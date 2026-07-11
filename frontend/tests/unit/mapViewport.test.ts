import assert from "node:assert/strict";
import test from "node:test";
import {
    clampViewport,
    fitViewport,
    flyTo,
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
