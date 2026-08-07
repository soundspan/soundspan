import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MapOverlay } from "../../components/vibe/MapOverlay";

/**
 * Static render tests for MapOverlay's fade-segment rendering — in particular
 * the F1(W2) trail-alpha refactor (`buildFadeSegments`, shared by the session
 * trail and the flight plan) that multiplies the existing oldest->newest
 * ramp by each trail point's age-based `alpha` (VibeMap's "fade" trail mode).
 * Regression coverage for "Check ... any MapOverlay-adjacent tests for
 * breakage" — no test previously rendered MapOverlay directly.
 */

const viewport = { scale: 100, tx: 0, ty: 0 };

/** Same base-ramp formulas MapOverlay uses internally, recomputed here so the
 *  assertions don't hardcode a float literal subject to precision drift. */
function trailBase(i: number, denom: number): number {
    return 0.08 + 0.5 * (i / denom);
}
function planBase(i: number, denom: number): number {
    return 0.55 - 0.4 * ((i - 1) / denom);
}

function strokeOpacities(html: string): number[] {
    return [...html.matchAll(/stroke-opacity="([\d.]+)"/g)].map((m) =>
        Number(m[1])
    );
}

test("trail segment opacity multiplies the oldest->newest ramp by the average of its endpoints' alpha", () => {
    const trail = [
        { x: 0.1, y: 0.1, alpha: 1 },
        { x: 0.2, y: 0.2, alpha: 1 },
        { x: 0.3, y: 0.3, alpha: 0.25 },
    ];
    const html = renderToStaticMarkup(
        React.createElement(MapOverlay, {
            viewport,
            width: 400,
            height: 400,
            trail,
        })
    );

    const denom = Math.max(1, trail.length - 1); // 2
    const seg1Expected = trailBase(1, denom) * ((1 + 1) / 2); // both alpha 1
    const seg2Expected = trailBase(2, denom) * ((1 + 0.25) / 2); // fading in

    const opacities = strokeOpacities(html);
    assert.equal(opacities.length, 2, "two trail segments for 3 points");
    assert.ok(
        Math.abs(opacities[0] - seg1Expected) < 1e-9,
        `segment 1 opacity ${opacities[0]} !== expected ${seg1Expected}`
    );
    assert.ok(
        Math.abs(opacities[1] - seg2Expected) < 1e-9,
        `segment 2 opacity ${opacities[1]} !== expected ${seg2Expected}`
    );
    // The fade must actually reduce segment 2's opacity below what the same
    // ramp position would render at full (unfaded) alpha — i.e. the
    // multiplier is doing something, independent of the base ramp shape.
    assert.ok(opacities[1] < trailBase(2, denom));
});

test("averages a segment's two endpoint alphas — a single aged-out endpoint dims but does not zero the segment", () => {
    // MapOverlay multiplies by the AVERAGE of a segment's two endpoints, so a
    // lone alpha:0 endpoint (paired with an alpha:1 neighbour) halves that
    // segment rather than hiding it — VibeMap is the layer that drops a
    // fully aged-out entry from the array before it ever reaches MapOverlay
    // (trailPoints: `if (alpha <= 0) continue`), so in practice MapOverlay
    // never sees an isolated 0 next to older, still-visible neighbours.
    const trail = [
        { x: 0.1, y: 0.1, alpha: 1 },
        { x: 0.2, y: 0.2, alpha: 0 },
    ];
    const html = renderToStaticMarkup(
        React.createElement(MapOverlay, { viewport, width: 400, height: 400, trail })
    );
    const denom = Math.max(1, trail.length - 1); // 1
    const expected = trailBase(1, denom) * ((1 + 0) / 2);
    const opacities = strokeOpacities(html);
    assert.equal(opacities.length, 1);
    assert.ok(Math.abs(opacities[0] - expected) < 1e-9);
    assert.ok(opacities[0] < trailBase(1, denom));
});

test("trail mode 'on' (every point alpha 1) reproduces the original oldest->newest ramp unchanged", () => {
    const trail = [
        { x: 0.1, y: 0.1, alpha: 1 },
        { x: 0.2, y: 0.2, alpha: 1 },
        { x: 0.3, y: 0.3, alpha: 1 },
    ];
    const html = renderToStaticMarkup(
        React.createElement(MapOverlay, { viewport, width: 400, height: 400, trail })
    );
    const denom = Math.max(1, trail.length - 1);
    const opacities = strokeOpacities(html);
    assert.equal(opacities.length, 2);
    assert.ok(Math.abs(opacities[0] - trailBase(1, denom)) < 1e-9);
    assert.ok(Math.abs(opacities[1] - trailBase(2, denom)) < 1e-9);
    // Newer segment brighter than the older one (unfaded ramp direction).
    assert.ok(opacities[1] > opacities[0]);
});

test("flight-plan segments are unaffected by trail alpha (no alpha field on plan points)", () => {
    const plan = [
        { x: 0.1, y: 0.1 },
        { x: 0.2, y: 0.2 },
        { x: 0.3, y: 0.3 },
    ];
    const html = renderToStaticMarkup(
        React.createElement(MapOverlay, { viewport, width: 400, height: 400, plan })
    );
    const denom = Math.max(1, plan.length - 1);
    const opacities = strokeOpacities(html);
    assert.equal(opacities.length, 2);
    assert.ok(Math.abs(opacities[0] - planBase(1, denom)) < 1e-9);
    assert.ok(Math.abs(opacities[1] - planBase(2, denom)) < 1e-9);
    // Dashed, per the existing flight-plan styling.
    assert.match(html, /stroke-dasharray="3 5"/);
});

test("renders the beacon and no trail/plan lines when neither is provided", () => {
    const html = renderToStaticMarkup(
        React.createElement(MapOverlay, {
            viewport,
            width: 400,
            height: 400,
            beacon: { x: 0.5, y: 0.5 },
        })
    );
    assert.equal(strokeOpacities(html).length, 0);
    assert.match(html, /vibe-beacon/);
});
