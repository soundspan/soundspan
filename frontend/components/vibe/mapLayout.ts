/**
 * mapLayout — pure position-buffer builders for the vibe map's natural vs
 * spread layout toggle.
 *
 * "Natural" positions are the raw UMAP projection (`track.x`/`track.y`,
 * already 0..1). "Spread" positions rank each track along each axis
 * independently and place it at `rank / (n - 1)`, which uniformly
 * redistributes the same points across the 0..1 box — dense clusters spread
 * out while each axis's relative ordering (neighbourhood) is preserved.
 *
 * All three builders operate on a flat, index-aligned Float32Array of
 * `[x0, y0, x1, y1, ...]` pairs so the map can interpolate one buffer per
 * animation frame without allocating.
 */

/** Minimal shape the pure layout core needs. */
export interface PositionableTrack {
    x: number;
    y: number;
}

/** Natural layout: the raw projection coordinates, index-aligned. */
export function buildPositions(
    tracks: readonly PositionableTrack[]
): Float32Array {
    const out = new Float32Array(tracks.length * 2);
    for (let i = 0; i < tracks.length; i++) {
        out[i * 2] = tracks[i].x;
        out[i * 2 + 1] = tracks[i].y;
    }
    return out;
}

/**
 * Spread layout: per axis, rank tracks by that axis's value (ties broken by
 * original index, for a stable deterministic order) and place each at
 * `rank / (n - 1)`. A single track centers at (0.5, 0.5); zero tracks yields
 * an empty buffer.
 */
export function computeSpreadPositions(
    tracks: readonly PositionableTrack[]
): Float32Array {
    const n = tracks.length;
    const out = new Float32Array(n * 2);
    if (n === 0) return out;
    if (n === 1) {
        out[0] = 0.5;
        out[1] = 0.5;
        return out;
    }

    const denom = n - 1;
    const order = new Array<number>(n);
    for (let i = 0; i < n; i++) order[i] = i;

    for (let axis = 0; axis < 2; axis++) {
        const valueAt = (i: number) => (axis === 0 ? tracks[i].x : tracks[i].y);
        order.sort((a, b) => valueAt(a) - valueAt(b) || a - b);
        for (let rank = 0; rank < n; rank++) {
            out[order[rank] * 2 + axis] = rank / denom;
        }
    }
    return out;
}

/**
 * Linearly interpolate from `a` to `b` by `t`, writing into (and returning)
 * `out` — no allocation. Endpoints are exact: `t <= 0` copies `a` verbatim
 * and `t >= 1` copies `b` verbatim, so an animation's first/last frame never
 * drifts from the source buffers due to float rounding.
 */
export function lerpPositions(
    a: Float32Array,
    b: Float32Array,
    t: number,
    out: Float32Array
): Float32Array {
    const n = Math.min(a.length, b.length, out.length);
    if (t <= 0) {
        for (let i = 0; i < n; i++) out[i] = a[i];
        return out;
    }
    if (t >= 1) {
        for (let i = 0; i < n; i++) out[i] = b[i];
        return out;
    }
    for (let i = 0; i < n; i++) out[i] = a[i] + (b[i] - a[i]) * t;
    return out;
}
