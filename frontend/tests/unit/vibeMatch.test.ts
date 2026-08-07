import assert from "node:assert/strict";
import test from "node:test";
import {
    calibratedMatch,
    featureMatchPercent,
    matchEdgeStyle,
} from "../../components/vibe/vibeMatch";

/**
 * A synthetic 101-point quantile ladder (p0..p100), evenly spaced from 0 to 2
 * (pgvector cosine distance's plausible range) — quantiles[i] = i/50, so
 * percentile rank i0..100 maps back onto i by construction, which keeps the
 * expected values in each test easy to hand-verify.
 */
const EVEN_QUANTILES: number[] = Array.from({ length: 101 }, (_, i) => i / 50);

test("calibratedMatch falls back to the old linear mapping when quantiles are null", () => {
    const { percent, label } = calibratedMatch(0.2, null);
    assert.equal(percent, Math.round(Math.max(0, 1 - 0.2 / 2) * 100));
    assert.equal(label, "");
});

test("calibratedMatch falls back to the old linear mapping when quantiles are empty", () => {
    const { percent, label } = calibratedMatch(1, []);
    assert.equal(percent, Math.round(Math.max(0, 1 - 1 / 2) * 100));
    assert.equal(label, "");
});

test("calibratedMatch fallback clamps at 0 for a distance beyond 2", () => {
    const { percent } = calibratedMatch(3, null);
    assert.equal(percent, 0);
});

test("calibratedMatch: an exact quantile hit maps to 100 minus its percentile index", () => {
    // EVEN_QUANTILES[9] === 0.18 -> percentile rank 9 -> 100 - 9 = 91.
    const { percent } = calibratedMatch(0.18, EVEN_QUANTILES);
    assert.equal(percent, 91);
});

test("calibratedMatch interpolates linearly between two straddling quantiles", () => {
    // Halfway between quantiles[9]=0.18 and quantiles[10]=0.2 -> rank 9.5 -> 90.5 -> rounds to 91 or 90.
    const { percent } = calibratedMatch(0.19, EVEN_QUANTILES);
    assert.ok(percent === 90 || percent === 91, `expected ~90.5, got ${percent}`);
});

test("calibratedMatch clamps a distance below the lowest quantile to 100%", () => {
    const { percent } = calibratedMatch(-1, EVEN_QUANTILES);
    assert.equal(percent, 100);
});

test("calibratedMatch clamps a distance above the highest quantile to 0%", () => {
    const { percent } = calibratedMatch(100, EVEN_QUANTILES);
    assert.equal(percent, 0);
});

test("calibratedMatch labels: nearly identical vibe >= 97", () => {
    // rank 2 -> percent 98
    assert.equal(calibratedMatch(EVEN_QUANTILES[2], EVEN_QUANTILES).label, "nearly identical vibe");
});

test("calibratedMatch labels: same vibe >= 90", () => {
    // rank 10 -> percent 90
    assert.equal(calibratedMatch(EVEN_QUANTILES[10], EVEN_QUANTILES).label, "same vibe");
});

test("calibratedMatch labels: close neighbors >= 75", () => {
    // rank 25 -> percent 75
    assert.equal(calibratedMatch(EVEN_QUANTILES[25], EVEN_QUANTILES).label, "close neighbors");
});

test("calibratedMatch labels: same neighborhood >= 50", () => {
    // rank 50 -> percent 50
    assert.equal(calibratedMatch(EVEN_QUANTILES[50], EVEN_QUANTILES).label, "same neighborhood");
});

test("calibratedMatch labels: distant relatives >= 25", () => {
    // rank 75 -> percent 25
    assert.equal(calibratedMatch(EVEN_QUANTILES[75], EVEN_QUANTILES).label, "distant relatives");
});

test("calibratedMatch labels: different worlds below 25", () => {
    // rank 76 -> percent 24
    assert.equal(calibratedMatch(EVEN_QUANTILES[76], EVEN_QUANTILES).label, "different worlds");
});

test("calibratedMatch treats a flat quantile segment by snapping to the upper percentile", () => {
    const flat = [...EVEN_QUANTILES];
    flat[10] = flat[9]; // p9 === p10, a degenerate flat run
    const { percent } = calibratedMatch(flat[9], flat);
    assert.ok(Number.isFinite(percent));
});

test("featureMatchPercent: identical values are a 100% match", () => {
    assert.equal(featureMatchPercent(0.5, 0.5), 100);
});

test("featureMatchPercent: maximal delta (0 vs 1) is a 0% match", () => {
    assert.equal(featureMatchPercent(0, 1), 0);
});

test("featureMatchPercent: partial delta rounds to the nearest percent", () => {
    assert.equal(featureMatchPercent(0.2, 0.5), 70); // 1 - 0.3 = 0.7
});

test("featureMatchPercent: null on either side yields null (skip the feature)", () => {
    assert.equal(featureMatchPercent(null, 0.5), null);
    assert.equal(featureMatchPercent(0.5, null), null);
    assert.equal(featureMatchPercent(null, null), null);
});

test("matchEdgeStyle: 75% is the anchor — unchanged current look", () => {
    const { opacity, width } = matchEdgeStyle(75);
    assert.equal(opacity, 0.5);
    assert.equal(width, 1.25);
});

test("matchEdgeStyle: higher percent widens/brightens the edge", () => {
    const anchor = matchEdgeStyle(75);
    const stronger = matchEdgeStyle(100);
    assert.ok(stronger.opacity > anchor.opacity);
    assert.ok(stronger.width > anchor.width);
});

test("matchEdgeStyle: lower percent thins/dims the edge, clamped to a sane floor", () => {
    const anchor = matchEdgeStyle(75);
    const weaker = matchEdgeStyle(0);
    assert.ok(weaker.opacity < anchor.opacity);
    assert.ok(weaker.width < anchor.width);
    assert.ok(weaker.opacity > 0, "opacity never fully disappears");
    assert.ok(weaker.width > 0, "width never collapses to 0 or negative");
});

test("matchEdgeStyle: width never strays more than ~0.5px from the anchor", () => {
    for (const p of [0, 25, 50, 75, 90, 100]) {
        const { width } = matchEdgeStyle(p);
        assert.ok(Math.abs(width - 1.25) <= 0.5 + 1e-9, `width ${width} at percent ${p} out of range`);
    }
});
