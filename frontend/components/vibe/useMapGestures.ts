"use client";

/** Pointer, pinch, wheel, hover, and sweep intent plumbing for the vibe map. */

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { SweepPoint } from "./sweepCollect";
import type { UseMapCamera } from "./useMapCamera";

const CLICK_MOVE_THRESHOLD = 4;
/** A click this far (× hit radius) from every dot counts as empty canvas. */
export const EMPTY_CLICK_FORGIVENESS = 2;

interface DragState { active: boolean; lastX: number; lastY: number; moved: number }
interface PointerPoint { x: number; y: number }
interface PinchState { dist: number; mid: PointerPoint }
type Camera = Pick<UseMapCamera,
    "accumulatePan" | "accumulateZoom" | "cancelFlight" | "viewportRef">;

/** Sweep operations driven by map pointer gestures. */
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
    camera: Camera;
    hitTest: (clientX: number, clientY: number, radiusScale?: number) => string | null;
    sweep: GestureSweepController;
    onTap: (id: string, mods: { ctrlOrMeta: boolean; shift: boolean }) => void;
    onEmptyTap: () => void;
}

export interface UseMapGestures {
    hoveredId: string | null;
    handlePointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => void;
    handlePointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => void;
    handlePointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => void;
    handlePointerCancel: (event: React.PointerEvent<HTMLCanvasElement>) => void;
    endDrag: () => void;
    handleHaloPointerDown: (event: React.PointerEvent<SVGCircleElement>) => void;
    isGestureActive: () => boolean;
}

interface GestureState {
    drag: DragState;
    pointers: Map<number, PointerPoint>;
    pinch: PinchState | null;
}

function cursorFor(
    containerRef: UseMapGesturesArgs["containerRef"],
    clientX: number,
    clientY: number
): SweepPoint {
    const rect = containerRef.current?.getBoundingClientRect();
    return rect ? { x: clientX - rect.left, y: clientY - rect.top } : { x: 0, y: 0 };
}

function useWheelZoom(containerRef: UseMapGesturesArgs["containerRef"], camera: Camera): void {
    useEffect(() => {
        const element = containerRef.current;
        if (!element) return;
        const onWheel = (event: WheelEvent) => {
            event.preventDefault();
            camera.cancelFlight();
            const rect = element.getBoundingClientRect();
            const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1;
            camera.accumulateZoom(event.clientX - rect.left, event.clientY - rect.top,
                -event.deltaY * unit * 0.0015);
        };
        element.addEventListener("wheel", onWheel, { passive: false });
        return () => element.removeEventListener("wheel", onWheel);
    }, [containerRef, camera]);
}

function beginPointer(
    event: React.PointerEvent<HTMLCanvasElement>,
    state: GestureState,
    args: UseMapGesturesArgs
): void {
    args.camera.cancelFlight();
    state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (state.pointers.size === 2) {
        args.sweep.discard();
        const [first, second] = [...state.pointers.values()];
        state.pinch = {
            dist: Math.hypot(second.x - first.x, second.y - first.y),
            mid: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
        };
        state.drag.active = false;
        state.drag.moved = Number.POSITIVE_INFINITY;
    } else if (state.pointers.size === 1) {
        state.drag = { active: true, lastX: event.clientX, lastY: event.clientY, moved: 0 };
        if (args.sweep.eligible({ shiftKey: event.shiftKey })) {
            args.sweep.begin(cursorFor(args.containerRef, event.clientX, event.clientY));
        }
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
}

function movePinch(event: React.PointerEvent<HTMLCanvasElement>, state: GestureState,
    args: UseMapGesturesArgs): boolean {
    if (!state.pinch || state.pointers.size < 2) return false;
    const [first, second] = [...state.pointers.values()];
    const dist = Math.hypot(second.x - first.x, second.y - first.y);
    const mid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    const previous = state.pinch;
    if (previous.dist > 0 && dist > 0) {
        const cursor = cursorFor(args.containerRef, mid.x, mid.y);
        args.camera.accumulateZoom(cursor.x, cursor.y, Math.log(dist / previous.dist));
        args.camera.accumulatePan(mid.x - previous.mid.x, mid.y - previous.mid.y);
    }
    state.pinch = { dist, mid };
    return true;
}

function moveSweep(event: React.PointerEvent<HTMLCanvasElement>, state: GestureState,
    args: UseMapGesturesArgs): boolean {
    if (!args.sweep.active() || !state.drag.active) return false;
    const drag = state.drag;
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.moved += Math.hypot(dx, dy);
    args.sweep.extend(cursorFor(args.containerRef, event.clientX, event.clientY));
    return true;
}

function moveDrag(event: React.PointerEvent<HTMLCanvasElement>, state: GestureState,
    camera: Camera): boolean {
    const drag = state.drag;
    if (!drag.active) return false;
    if (event.pointerType === "mouse" && event.buttons === 0) {
        drag.active = false;
        return false;
    }
    const dx = event.clientX - drag.lastX;
    const dy = event.clientY - drag.lastY;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    drag.moved += Math.hypot(dx, dy);
    camera.accumulatePan(dx, dy);
    return true;
}

function movePointer(event: React.PointerEvent<HTMLCanvasElement>, state: GestureState,
    args: UseMapGesturesArgs, setHovered: Dispatch<SetStateAction<string | null>>): void {
    if (!args.camera.viewportRef.current) return;
    const tracked = state.pointers.get(event.pointerId);
    if (tracked) {
        tracked.x = event.clientX;
        tracked.y = event.clientY;
    }
    if (movePinch(event, state, args)) return;
    if (moveSweep(event, state, args)) return;
    if (moveDrag(event, state, args.camera)) return;
    setHovered(args.hitTest(event.clientX, event.clientY));
}

function releasePointer(event: React.PointerEvent<HTMLCanvasElement>, state: GestureState): boolean {
    state.pointers.delete(event.pointerId);
    const wasClick = state.drag.active && state.drag.moved < CLICK_MOVE_THRESHOLD;
    state.drag.active = false;
    if (state.pointers.size < 2) state.pinch = null;
    const remaining = state.pointers.values().next().value;
    if (remaining) {
        state.drag = { active: true, lastX: remaining.x, lastY: remaining.y,
            moved: Number.POSITIVE_INFINITY };
    }
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    return wasClick;
}

function finishPointer(event: React.PointerEvent<HTMLCanvasElement>, state: GestureState,
    args: UseMapGesturesArgs, hoveredId: string | null): void {
    const wasClick = releasePointer(event, state);
    if (args.sweep.active() && args.sweep.finish(wasClick)) return;
    if (!wasClick) return;
    const clickedId = hoveredId ?? args.hitTest(event.clientX, event.clientY);
    if (clickedId) {
        args.onTap(clickedId, {
            ctrlOrMeta: event.ctrlKey || event.metaKey,
            shift: event.shiftKey,
        });
    } else if (!args.hitTest(event.clientX, event.clientY, EMPTY_CLICK_FORGIVENESS)) {
        args.onEmptyTap();
    }
}

/** Bind raw map input to camera, sweep, and semantic tap callbacks. */
export function useMapGestures(args: UseMapGesturesArgs): UseMapGestures {
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const stateRef = useRef<GestureState>({
        drag: { active: false, lastX: 0, lastY: 0, moved: 0 },
        pointers: new Map(), pinch: null,
    });
    useWheelZoom(args.containerRef, args.camera);
    const handlePointerDown = useCallback(
        (event: React.PointerEvent<HTMLCanvasElement>) => beginPointer(event, stateRef.current, args),
        [args]
    );
    const handlePointerMove = useCallback(
        (event: React.PointerEvent<HTMLCanvasElement>) => movePointer(event, stateRef.current, args, setHoveredId),
        [args]
    );
    const handlePointerUp = useCallback(
        (event: React.PointerEvent<HTMLCanvasElement>) => finishPointer(event, stateRef.current, args, hoveredId),
        [args, hoveredId]
    );
    const handlePointerCancel = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
        releasePointer(event, stateRef.current);
        args.sweep.discard();
    }, [args.sweep]);
    const endDrag = useCallback(() => {
        stateRef.current.drag.active = false;
        setHoveredId(null);
    }, []);
    const handleHaloPointerDown = useCallback((event: React.PointerEvent<SVGCircleElement>) => {
        stateRef.current.drag = { active: true, lastX: event.clientX, lastY: event.clientY, moved: 0 };
    }, []);
    const isGestureActive = useCallback(
        () => stateRef.current.drag.active || stateRef.current.pinch !== null,
        []
    );
    return { hoveredId, handlePointerDown, handlePointerMove, handlePointerUp,
        handlePointerCancel, endDrag, handleHaloPointerDown, isGestureActive };
}
