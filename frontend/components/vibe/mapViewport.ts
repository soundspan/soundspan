/**
 * mapViewport — pure 2D viewport math for the vibe map.
 *
 * No React, no DOM. World space is the map payload's normalised 0..1 x/y.
 * A viewport is a uniform-scale affine transform from world space to screen
 * (CSS-pixel) space:  screen = world * scale + t.
 *
 * The renderer (canvas) and the overlay (DOM/SVG beacon + trail) both project
 * through `worldToScreen`, so they always share one coordinate system.
 */

export interface Point {
    x: number;
    y: number;
}

/** Uniform-scale affine transform: screen = world * scale + (tx, ty). */
export interface Viewport {
    scale: number;
    tx: number;
    ty: number;
}

/** Screen dimensions in CSS pixels; used for fit, centering and clamping. */
export interface MapDims {
    width: number;
    height: number;
}

/** Padding (px) kept between the fitted 0..1 world box and the canvas edge. */
export const MAP_PADDING = 40;

/** Absolute scale clamp (world 0..1 -> px). Generous, decoupled from dims. */
export const MIN_SCALE = 40;
export const MAX_SCALE = 24000;

/** Minimum px of the world content kept on-screen so the map can't be lost. */
const KEEP_VISIBLE = MAP_PADDING;

export function clampScale(scale: number): number {
    if (!Number.isFinite(scale)) return MIN_SCALE;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Identity fit: map the 0..1 world box into the padded content region with a
 * single uniform scale, centered (letterboxed — never distorted).
 */
export function fitViewport(dims: MapDims): Viewport {
    const boxW = Math.max(1, dims.width - 2 * MAP_PADDING);
    const boxH = Math.max(1, dims.height - 2 * MAP_PADDING);
    const scale = clampScale(Math.min(boxW, boxH));
    const tx = MAP_PADDING + (boxW - scale) / 2;
    const ty = MAP_PADDING + (boxH - scale) / 2;
    return { scale, tx, ty };
}

export function worldToScreen(vp: Viewport, p: Point): Point {
    return { x: p.x * vp.scale + vp.tx, y: p.y * vp.scale + vp.ty };
}

export function screenToWorld(vp: Viewport, s: Point): Point {
    return { x: (s.x - vp.tx) / vp.scale, y: (s.y - vp.ty) / vp.scale };
}

/**
 * Clamp translation so at least KEEP_VISIBLE px of the world content box stays
 * inside the viewport on both axes. Scale is untouched.
 */
export function clampViewport(vp: Viewport, bounds: MapDims): Viewport {
    const content = vp.scale; // world spans 0..1, so screen content size == scale
    const keep = Math.min(KEEP_VISIBLE, content);
    const tx = Math.min(bounds.width - keep, Math.max(-content + keep, vp.tx));
    const ty = Math.min(bounds.height - keep, Math.max(-content + keep, vp.ty));
    return { scale: vp.scale, tx, ty };
}

/**
 * Zoom by `factor` about a screen-space cursor point, preserving the world
 * point currently under the cursor. When `bounds` is given the result is
 * translation-clamped; omit it (e.g. in the zoom-invariant test) for the exact
 * transform.
 */
export function zoomAt(
    vp: Viewport,
    cursor: Point,
    factor: number,
    bounds?: MapDims
): Viewport {
    const newScale = clampScale(vp.scale * factor);
    // World point under the cursor before zooming.
    const world = screenToWorld(vp, cursor);
    // Solve tx/ty so that worldToScreen(next, world) === cursor at newScale.
    const next: Viewport = {
        scale: newScale,
        tx: cursor.x - world.x * newScale,
        ty: cursor.y - world.y * newScale,
    };
    return bounds ? clampViewport(next, bounds) : next;
}

/** Dot radius bounds (px) for `computeDotRadius`. */
export const MIN_DOT_RADIUS = 2.2;
export const MAX_DOT_RADIUS = 9;

/**
 * Dot radius that scales gently with zoom relative to the fitted ("whole
 * map visible") scale, so zooming in reveals bigger, more comfortable dots
 * instead of a swarm of pinpricks. `fitScale` is the current dims' fit
 * scale (`fitViewport(dims).scale`); at that scale the ratio is 1 and the
 * radius is the base 3.5px.
 */
export function computeDotRadius(scale: number, fitScale: number): number {
    const ratio = fitScale > 0 ? scale / fitScale : 1;
    const r = 3.5 * Math.pow(ratio, 0.3);
    return Math.min(MAX_DOT_RADIUS, Math.max(MIN_DOT_RADIUS, r));
}

/**
 * Return a viewport that centers `worldPt` on the screen at `targetScale`
 * (falling back to the current scale when `targetScale` is not finite), clamped
 * to `bounds`.
 */
export function flyTo(
    vp: Viewport,
    worldPt: Point,
    targetScale: number,
    bounds: MapDims
): Viewport {
    const newScale = clampScale(
        Number.isFinite(targetScale) ? targetScale : vp.scale
    );
    const next: Viewport = {
        scale: newScale,
        tx: bounds.width / 2 - worldPt.x * newScale,
        ty: bounds.height / 2 - worldPt.y * newScale,
    };
    return clampViewport(next, bounds);
}
