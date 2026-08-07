/**
 * sweepCollect — PURE stroke→dots collection for the sweep-to-queue brush.
 *
 * Sweeping is the map-native "draw your own playlist": the pointer becomes a
 * brush and visible dots within the brush radius of the stroke are collected
 * in first-touch order. This module owns the geometry: segment sampling (so a
 * fast stroke can't skip over dots between two pointer events) and the
 * per-sample hit collection with dedupe and a hard cap.
 *
 * No React, no DOM. Screen-space cursor points; world-space positions
 * projected through the shared viewport transform — the same buffer + mask
 * MapCanvas renders from, so the brush collects exactly what the user sees.
 */

import type { Viewport } from "./mapViewport";
import { worldToScreen } from "./mapViewport";

export interface SweepPoint {
    x: number;
    y: number;
}

/** Brush radius in screen px (also the stroke's rendered half-width). */
export const SWEEP_BRUSH_RADIUS = 24;
/** Sampling step along the stroke; ≤ radius so coverage has no gaps. */
export const SWEEP_SAMPLE_STEP = 16;
/** Hard cap on collected tracks per sweep. */
export const SWEEP_CAP = 100;
/**
 * Hard cap on samples per segment. A pointer event pair should never be more
 * than a screenful apart, so a segment needing more samples than this is a
 * corrupted/hostile input (teleporting coordinates, a near-zero step) — cap
 * the allocation instead of trusting `dist / step`. Beyond the cap the brush
 * may skip dots along the (pathological) segment; that beats an unbounded
 * loop on the pointer-event hot path.
 */
export const MAX_SEGMENT_SAMPLES = 512;

function isFinitePoint(p: SweepPoint): boolean {
    return Number.isFinite(p.x) && Number.isFinite(p.y);
}

/**
 * Points along the segment a→b every `step` px — excluding `a` (the previous
 * sample), always including `b`. A zero-length segment yields just `b`.
 *
 * Defensive geometry: a non-finite endpoint yields `[]` (a poisoned
 * coordinate must never enter the stroke), a non-positive or non-finite
 * `step` falls back to SWEEP_SAMPLE_STEP, and the sample count is capped at
 * MAX_SEGMENT_SAMPLES so `dist / step` can never drive an unbounded loop.
 */
export function sampleSegment(
    a: SweepPoint,
    b: SweepPoint,
    step: number = SWEEP_SAMPLE_STEP
): SweepPoint[] {
    if (!isFinitePoint(a) || !isFinitePoint(b)) return [];
    const effectiveStep =
        Number.isFinite(step) && step > 0 ? step : SWEEP_SAMPLE_STEP;
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    if (dist === 0) return [b];
    const n = Math.min(
        MAX_SEGMENT_SAMPLES,
        Math.max(1, Math.ceil(dist / effectiveStep))
    );
    const out: SweepPoint[] = [];
    for (let i = 1; i <= n; i++) {
        out.push({
            x: a.x + ((b.x - a.x) * i) / n,
            y: a.y + ((b.y - a.y) * i) / n,
        });
    }
    return out;
}

export interface CollectHitsArgs {
    /** Brush sample point in screen px. */
    cursor: SweepPoint;
    /** Index-aligned track ids (parallel to `positions` / `mask`). */
    ids: readonly { id: string }[];
    /** Flat [x0,y0,x1,y1,...] world positions (the live layout buffer). */
    positions: Float32Array;
    /** Visibility mask — filtered-out dots are never collected. */
    mask: Uint8Array;
    viewport: Viewport;
    radius?: number;
    cap?: number;
    /** Dedupe set, shared across the whole stroke (mutated). */
    seen: Set<string>;
    /** Ordered collection, first-touch order (mutated, capped). */
    out: string[];
}

/**
 * Collect every visible, not-yet-seen dot within `radius` px of `cursor` into
 * `out` (mutating `seen`/`out`), stopping at `cap` total.
 *
 * `radius` falls back to SWEEP_BRUSH_RADIUS unless it is a positive finite
 * number, and `cap` is clamped into [1, SWEEP_CAP] — SWEEP_CAP is the hard
 * per-sweep collection bound, so a caller-supplied cap can only tighten it,
 * never widen it. A non-finite cursor collects nothing (each distance check
 * is NaN-safe by comparison).
 */
export function collectHits(args: CollectHitsArgs): void {
    const { cursor, ids, positions, mask, viewport, seen, out } = args;
    const radius =
        args.radius !== undefined &&
        Number.isFinite(args.radius) &&
        args.radius > 0
            ? args.radius
            : SWEEP_BRUSH_RADIUS;
    const cap =
        args.cap !== undefined && Number.isFinite(args.cap) && args.cap >= 1
            ? Math.min(args.cap, SWEEP_CAP)
            : SWEEP_CAP;
    for (let i = 0; i < ids.length && out.length < cap; i++) {
        if (mask[i] === 0) continue;
        const id = ids[i].id;
        if (seen.has(id)) continue;
        const s = worldToScreen(viewport, {
            x: positions[i * 2],
            y: positions[i * 2 + 1],
        });
        if (Math.hypot(cursor.x - s.x, cursor.y - s.y) <= radius) {
            seen.add(id);
            out.push(id);
        }
    }
}
