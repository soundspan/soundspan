"use client";

/**
 * useMapGestures — raw pointer/wheel input plumbing for the vibe map.
 *
 * Owns the pointer bookkeeping (drag pan, two-finger pinch, click-vs-drag
 * threshold, hover) and the native non-passive wheel listener, and routes the
 * interpreted intents outward: continuous pan/zoom deltas into the camera's
 * per-frame accumulators, stroke samples into the sweep controller, and
 * clean clicks into `onTap` / `onEmptyTap`. No mode logic, no rendering —
 * the container decides what a tap means.
 *
 * The wheel listener is attached natively with `{ passive: false }` —
 * React's synthetic onWheel is passive, which made preventDefault a silent
 * no-op (page scroll + ctrl-wheel browser zoom underneath the map zoom).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SweepPoint } from "./sweepCollect";
import type { UseMapCamera } from "./useMapCamera";

const CLICK_MOVE_THRESHOLD = 4; // px between down/up to still count as a click
/** A click this far (× hit radius) from every dot counts as "empty canvas". */
export const EMPTY_CLICK_FORGIVENESS = 2;

interface DragState {
    active: boolean;
    lastX: number;
    lastY: number;
    moved: number;
}

/** The sweep surface the gesture layer drives (a subset of UseMapSweep). */
export interface GestureSweepController {
    eligible: (mods: { shiftKey: boolean }) => boolean;
    active: () => boolean;
    begin: (cursor: SweepPoint) => void;
    extend: (cursor: SweepPoint) => void;
    finish: (wasClick: boolean) => boolean;
    discard: () => void;
}

export interface UseMapGesturesArgs {
    containerRef: React.RefObject<HTMLDivElement | null>;
    camera: Pick<
        UseMapCamera,
        "accumulatePan" | "accumulateZoom" | "cancelFlight" | "viewportRef"
    >;
    /** Transform-aware hit test (client coords → dot id or null). */
    hitTest: (clientX: number, clientY: number, radiusScale?: number) => string | null;
    sweep: GestureSweepController;
    /** A clean click landed on a dot. */
    onTap: (id: string, mods: { ctrlOrMeta: boolean; shift: boolean }) => void;
    /** A clean click landed on clearly-empty canvas (beyond the forgiveness radius). */
    onEmptyTap: () => void;
}

export interface UseMapGestures {
    hoveredId: string | null;
    handlePointerDown: (e: React.PointerEvent<HTMLCanvasElement>) => void;
    handlePointerMove: (e: React.PointerEvent<HTMLCanvasElement>) => void;
    handlePointerUp: (e: React.PointerEvent<HTMLCanvasElement>) => void;
    handlePointerCancel: (e: React.PointerEvent<HTMLCanvasElement>) => void;
    /** onPointerLeave — end any drag and clear hover. */
    endDrag: () => void;
    /**
     * A neighbour halo (MapDecorations) opts into pointer events so it can be
     * clicked, which means a drag that *starts* on a halo never reaches the
     * canvas's own onPointerDown. This arms the same drag state directly so
     * panning can still begin from a halo.
     */
    handleHaloPointerDown: (e: React.PointerEvent<SVGCircleElement>) => void;
    /** True while a drag or pinch is in progress (camera-follow guards). */
    isGestureActive: () => boolean;
}

export function useMapGestures({
    containerRef,
    camera,
    hitTest,
    sweep,
    onTap,
    onEmptyTap,
}: UseMapGesturesArgs): UseMapGestures {
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const drag = useRef<DragState>({ active: false, lastX: 0, lastY: 0, moved: 0 });
    // Pinch state: every active canvas pointer is tracked by id; two or more
    // switches to pinch (zoom about the midpoint + pan by its drift) and
    // poisons the click threshold for the whole gesture.
    const activePointersRef = useRef(new Map<number, { x: number; y: number }>());
    const pinchRef = useRef<{ dist: number; mid: { x: number; y: number } } | null>(
        null
    );

    const cursorFromEvent = useCallback(
        (clientX: number, clientY: number) => {
            const container = containerRef.current;
            if (!container) return { x: 0, y: 0 };
            const rect = container.getBoundingClientRect();
            return { x: clientX - rect.left, y: clientY - rect.top };
        },
        [containerRef]
    );

    // Native non-passive wheel listener: deltas accumulate in log space and
    // flush once per frame through the camera tick.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            camera.cancelFlight();
            const rect = el.getBoundingClientRect();
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 120 : 1;
            camera.accumulateZoom(
                e.clientX - rect.left,
                e.clientY - rect.top,
                -e.deltaY * unit * 0.0015
            );
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [containerRef, camera]);

    const handlePointerDown = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>) => {
            camera.cancelFlight();
            activePointersRef.current.set(e.pointerId, {
                x: e.clientX,
                y: e.clientY,
            });
            if (activePointersRef.current.size === 2) {
                // A second finger always means pinch — discard a live sweep.
                sweep.discard();
                const [p1, p2] = [...activePointersRef.current.values()];
                pinchRef.current = {
                    dist: Math.hypot(p2.x - p1.x, p2.y - p1.y),
                    mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
                };
                drag.current.active = false;
                drag.current.moved = Number.POSITIVE_INFINITY; // never a click
            } else if (activePointersRef.current.size === 1) {
                drag.current = {
                    active: true,
                    lastX: e.clientX,
                    lastY: e.clientY,
                    moved: 0,
                };
                if (sweep.eligible({ shiftKey: e.shiftKey })) {
                    // Arm a sweep. The drag state still tracks `moved`, so a
                    // stationary shift-click falls through to normal click
                    // semantics on pointerup instead of producing an empty
                    // sweep.
                    sweep.begin(cursorFromEvent(e.clientX, e.clientY));
                }
            }
            e.currentTarget.setPointerCapture?.(e.pointerId);
        },
        [camera, sweep, cursorFromEvent]
    );

    const handleHaloPointerDown = useCallback(
        (e: React.PointerEvent<SVGCircleElement>) => {
            // Deliberately does not call setPointerCapture (that belongs to
            // the canvas, not this SVG circle).
            drag.current = {
                active: true,
                lastX: e.clientX,
                lastY: e.clientY,
                moved: 0,
            };
        },
        []
    );

    const handlePointerMove = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>) => {
            if (!camera.viewportRef.current) return;

            const tracked = activePointersRef.current.get(e.pointerId);
            if (tracked) {
                tracked.x = e.clientX;
                tracked.y = e.clientY;
            }

            // Two-finger pinch: zoom about the midpoint, pan by its drift.
            // Deltas accumulate and flush on the camera tick like all input.
            if (pinchRef.current && activePointersRef.current.size >= 2) {
                const [p1, p2] = [...activePointersRef.current.values()];
                const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
                const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
                const prev = pinchRef.current;
                if (prev.dist > 0 && dist > 0) {
                    const cursor = cursorFromEvent(mid.x, mid.y);
                    camera.accumulateZoom(
                        cursor.x,
                        cursor.y,
                        Math.log(dist / prev.dist)
                    );
                    camera.accumulatePan(mid.x - prev.mid.x, mid.y - prev.mid.y);
                }
                pinchRef.current = { dist, mid };
                return;
            }

            // Live sweep: the stroke collects instead of panning.
            if (sweep.active() && drag.current.active) {
                const d = drag.current;
                const dx = e.clientX - d.lastX;
                const dy = e.clientY - d.lastY;
                d.lastX = e.clientX;
                d.lastY = e.clientY;
                d.moved += Math.hypot(dx, dy);
                sweep.extend(cursorFromEvent(e.clientX, e.clientY));
                return;
            }

            const d = drag.current;
            if (d.active) {
                // Self-heal a drag armed by a halo pointerdown whose matching
                // pointerup landed on the halo itself (stationary tap — the
                // halo has no pointerup wiring back to this canvas): once no
                // mouse button is actually down, stop treating hover as a pan.
                // Mouse-only: touch contacts report buttons in ways that must
                // not cancel a live pinch/pan.
                if (e.pointerType === "mouse" && e.buttons === 0) {
                    d.active = false;
                } else {
                    const dx = e.clientX - d.lastX;
                    const dy = e.clientY - d.lastY;
                    d.lastX = e.clientX;
                    d.lastY = e.clientY;
                    d.moved += Math.hypot(dx, dy);
                    camera.accumulatePan(dx, dy);
                    return;
                }
            }

            setHoveredId(hitTest(e.clientX, e.clientY));
        },
        [camera, sweep, cursorFromEvent, hitTest]
    );

    const endDrag = useCallback(() => {
        drag.current.active = false;
        setHoveredId(null);
    }, []);

    /** Shared up/cancel bookkeeping; returns true when this was a clean click. */
    const releasePointer = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>): boolean => {
            activePointersRef.current.delete(e.pointerId);
            const wasClick =
                drag.current.active && drag.current.moved < CLICK_MOVE_THRESHOLD;
            drag.current.active = false;
            if (activePointersRef.current.size < 2) pinchRef.current = null;
            // Hand the pan to a remaining finger (still never a click).
            const rest = activePointersRef.current.values().next().value;
            if (rest) {
                drag.current = {
                    active: true,
                    lastX: rest.x,
                    lastY: rest.y,
                    moved: Number.POSITIVE_INFINITY,
                };
            }
            e.currentTarget.releasePointerCapture?.(e.pointerId);
            return wasClick;
        },
        []
    );

    const handlePointerUp = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>) => {
            const wasClick = releasePointer(e);

            // A live sweep ends here: a real stroke freezes into the action
            // chip (consuming the pointer-up); a stationary tap falls through
            // to click semantics.
            if (sweep.active() && sweep.finish(wasClick)) return;

            if (!wasClick) return;
            // Touch taps never set hoveredId (no hover concept on touch, and
            // pointermove during the tap takes the drag branch above), so
            // fall back to hit-testing at the pointerup coordinates.
            const clickedId = hoveredId ?? hitTest(e.clientX, e.clientY);
            if (clickedId) {
                onTap(clickedId, {
                    ctrlOrMeta: e.ctrlKey || e.metaKey,
                    shift: e.shiftKey,
                });
            } else if (
                !hitTest(e.clientX, e.clientY, EMPTY_CLICK_FORGIVENESS)
            ) {
                // Clearly-empty canvas: nothing even within the forgiveness
                // multiple of the hit radius — a near-miss on a small dot
                // must not count as an empty click.
                onEmptyTap();
            }
        },
        [releasePointer, sweep, hoveredId, hitTest, onTap, onEmptyTap]
    );

    const handlePointerCancel = useCallback(
        (e: React.PointerEvent<HTMLCanvasElement>) => {
            releasePointer(e);
            sweep.discard();
        },
        [releasePointer, sweep]
    );

    const isGestureActive = useCallback(
        () => drag.current.active || pinchRef.current !== null,
        []
    );

    return {
        hoveredId,
        handlePointerDown,
        handlePointerMove,
        handlePointerUp,
        handlePointerCancel,
        endDrag,
        handleHaloPointerDown,
        isGestureActive,
    };
}
