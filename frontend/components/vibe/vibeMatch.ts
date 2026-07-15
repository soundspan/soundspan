/**
 * vibeMatch — PURE library-calibrated similarity scoring for the vibe map's
 * user-facing match percentages.
 *
 * No React, no DOM. Replaces the old fixed `1 - distance/2` linear mapping
 * (which floors real-world unrelated pairs around ~50%, reading as inflated —
 * "skindred shares 50% of a vibe with panic at the disco?!") with a
 * library-calibrated score: `GET /api/vibe/calibration` samples pairwise CLAP
 * cosine distance across the library and returns its p0..p100 percentiles
 * (101 values, ascending). A candidate's match % is then "closer than N% of
 * random pairs in your library" — the percentile rank of its distance within
 * that sample, inverted.
 *
 * When calibration data isn't available yet (a fresh/small library —
 * `sampleSize: 0, quantiles: []`), every caller falls back to the old linear
 * mapping so the map never breaks; the empty `label` is the signal that a row
 * is showing the uncalibrated number.
 */

/** p0..p100 inclusive. */
const EXPECTED_QUANTILE_COUNT = 101;

export interface CalibratedMatch {
    /** 0..100, rounded. */
    percent: number;
    /** Human sentence fragment for the percent bucket, "" when uncalibrated. */
    label: string;
}

function clampPercent(p: number): number {
    return Math.max(0, Math.min(100, p));
}

/**
 * Percentile rank (0..100) of `distance` within the ascending `quantiles`
 * ladder, linearly interpolated between the two straddling quantile values.
 * Distances at or beyond the array's ends clamp to 0 / 100.
 */
function percentileRank(distance: number, quantiles: readonly number[]): number {
    const last = quantiles.length - 1;
    if (distance <= quantiles[0]) return 0;
    if (distance >= quantiles[last]) return last;
    for (let i = 1; i <= last; i++) {
        if (distance <= quantiles[i]) {
            const lo = quantiles[i - 1];
            const hi = quantiles[i];
            if (hi === lo) return i; // flat segment — snap to the upper percentile
            const frac = (distance - lo) / (hi - lo);
            return i - 1 + frac;
        }
    }
    return last;
}

function labelForPercent(percent: number): string {
    if (percent >= 97) return "nearly identical vibe";
    if (percent >= 90) return "same vibe";
    if (percent >= 75) return "close neighbors";
    if (percent >= 50) return "same neighborhood";
    if (percent >= 25) return "distant relatives";
    return "different worlds";
}

/**
 * Library-calibrated match percent + label for a pairwise CLAP cosine
 * `distance`, given the library's `quantiles` sample (`api.getVibeCalibration`,
 * null/[] when unavailable — the pre-calibration linear mapping is used
 * instead, with an empty label marking it uncalibrated).
 */
export function calibratedMatch(
    distance: number,
    quantiles: readonly number[] | null
): CalibratedMatch {
    if (!quantiles || quantiles.length !== EXPECTED_QUANTILE_COUNT) {
        const percent = clampPercent(
            Math.round(Math.max(0, 1 - distance / 2) * 100)
        );
        return { percent, label: "" };
    }
    const rank = percentileRank(distance, quantiles);
    const percent = clampPercent(Math.round(100 - rank));
    return { percent, label: labelForPercent(percent) };
}

/**
 * Per-feature "match %" between an origin and candidate value for the
 * Travel-mode explainability breakdown: `round((1 - |a - b|) * 100)`. Either
 * side null (unanalyzed) yields null — the caller skips that feature's bar
 * rather than showing a fake 0%/100%.
 */
export function featureMatchPercent(
    a: number | null,
    b: number | null
): number | null {
    if (a == null || b == null) return null;
    return Math.round((1 - Math.abs(a - b)) * 100);
}

/** The constellation-edge look at the ~75% anchor (today's fixed values). */
const EDGE_ANCHOR_PERCENT = 75;
const EDGE_ANCHOR_OPACITY = 0.5;
const EDGE_ANCHOR_WIDTH = 1.25;
const EDGE_OPACITY_SLOPE = 0.01; // per percent point away from the anchor
const EDGE_WIDTH_SLOPE = 0.01;
const EDGE_OPACITY_MIN = 0.15;
const EDGE_OPACITY_MAX = 0.85;
const EDGE_WIDTH_DELTA_MAX = 0.5; // px, either direction from the anchor

function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}

export interface MatchEdgeStyle {
    opacity: number;
    width: number;
}

/**
 * Travel-mode constellation edge strokeOpacity/width, scaled by a candidate's
 * calibrated match `percent` so on-map geometry visibly encodes true
 * similarity. 75% (the map's typical shown-neighbour strength) reproduces
 * today's fixed look exactly; stronger matches draw brighter/thicker, weaker
 * ones fainter/thinner, clamped to a sane range so an edge never disappears
 * or overwhelms the dots.
 */
export function matchEdgeStyle(percent: number): MatchEdgeStyle {
    const delta = percent - EDGE_ANCHOR_PERCENT;
    return {
        opacity: clamp(
            EDGE_ANCHOR_OPACITY + delta * EDGE_OPACITY_SLOPE,
            EDGE_OPACITY_MIN,
            EDGE_OPACITY_MAX
        ),
        width: clamp(
            EDGE_ANCHOR_WIDTH + delta * EDGE_WIDTH_SLOPE,
            EDGE_ANCHOR_WIDTH - EDGE_WIDTH_DELTA_MAX,
            EDGE_ANCHOR_WIDTH + EDGE_WIDTH_DELTA_MAX
        ),
    };
}
