"use client";

/** Single-owner, frame-batched camera state for the vibe map. */

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useLatest } from "./useLatest";
import {
    clampViewport, fitViewport, interpolateViewport, zoomAt,
    type MapDims, type Viewport,
} from "./mapViewport";

/** Cubic easing shared by camera and layout transitions. */
export function easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

interface CameraFlight { from: Viewport; to: Viewport; start: number; dur: number }
interface CameraRefs {
    pan: React.MutableRefObject<{ dx: number; dy: number }>;
    zoom: React.MutableRefObject<{ cx: number; cy: number; logf: number } | null>;
    flight: React.MutableRefObject<CameraFlight | null>;
    raf: React.MutableRefObject<number | null>;
}

export interface UseMapCamera {
    viewport: Viewport | null;
    viewportRef: React.RefObject<Viewport | null>;
    accumulatePan: (dx: number, dy: number) => void;
    accumulateZoom: (cx: number, cy: number, logf: number) => void;
    cancelFlight: () => void;
    animateCameraTo: (target: Viewport, dur?: number) => void;
    zoomByCenter: (factor: number) => void;
    resetView: () => void;
}

export interface UseMapCameraArgs { dims: MapDims; reducedMotion: boolean }

interface FrameResult { viewport: Viewport; continueFlight: boolean }

function applyCameraFrame(
    now: number,
    viewport: Viewport,
    dims: MapDims,
    refs: CameraRefs
): FrameResult {
    let next = viewport;
    let dirty = false;
    const zoom = refs.zoom.current;
    if (zoom) {
        next = zoomAt(next, { x: zoom.cx, y: zoom.cy }, Math.exp(zoom.logf), dims);
        refs.zoom.current = null;
        dirty = true;
    }
    const pan = refs.pan.current;
    if (pan.dx !== 0 || pan.dy !== 0) {
        next = clampViewport({ scale: next.scale, tx: next.tx + pan.dx,
            ty: next.ty + pan.dy }, dims);
        refs.pan.current = { dx: 0, dy: 0 };
        dirty = true;
    }
    const flight = refs.flight.current;
    let continueFlight = false;
    if (!dirty && flight) {
        const progress = Math.min(1, (now - flight.start) / flight.dur);
        next = interpolateViewport(flight.from, flight.to, easeInOutCubic(progress), dims);
        if (progress >= 1) refs.flight.current = null;
        else continueFlight = true;
    }
    return { viewport: next, continueFlight };
}

function useViewportState(dims: MapDims): [Viewport | null,
    Dispatch<SetStateAction<Viewport | null>>, React.MutableRefObject<Viewport | null>] {
    const [viewport, setViewport] = useState<Viewport | null>(null);
    const viewportRef = useLatest(viewport);
    useEffect(() => {
        if (dims.width > 0 && dims.height > 0) {
            setViewport((current) => current ?? fitViewport(dims));
        }
    }, [dims]);
    return [viewport, setViewport, viewportRef];
}

function useCameraEngine(
    dimsRef: React.MutableRefObject<MapDims>,
    viewportRef: React.MutableRefObject<Viewport | null>,
    setViewport: Dispatch<SetStateAction<Viewport | null>>
): CameraRefs & { schedule: () => void } {
    const refs: CameraRefs = {
        pan: useRef({ dx: 0, dy: 0 }),
        zoom: useRef(null), flight: useRef(null), raf: useRef(null),
    };
    const tick = useCallback(function cameraTick(now: number) {
        refs.raf.current = null;
        const dims = dimsRef.current;
        const current = viewportRef.current;
        if (!current || dims.width <= 0 || dims.height <= 0) return;
        const result = applyCameraFrame(now, current, dims, refs);
        viewportRef.current = result.viewport;
        setViewport(result.viewport);
        if (result.continueFlight) refs.raf.current = requestAnimationFrame(cameraTick);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- all captured refs are stable.
    }, []);
    const schedule = useCallback(() => {
        if (refs.raf.current == null) refs.raf.current = requestAnimationFrame(tick);
    }, [refs.raf, tick]);
    useEffect(() => () => {
        if (refs.raf.current != null) cancelAnimationFrame(refs.raf.current);
    }, [refs.raf]);
    return { ...refs, schedule };
}

function useContinuousActions(engine: CameraRefs & { schedule: () => void }) {
    const accumulatePan = useCallback((dx: number, dy: number) => {
        engine.pan.current.dx += dx;
        engine.pan.current.dy += dy;
        engine.schedule();
    }, [engine]);
    const accumulateZoom = useCallback((cx: number, cy: number, logf: number) => {
        const previous = engine.zoom.current;
        engine.zoom.current = { cx, cy, logf: (previous?.logf ?? 0) + logf };
        engine.schedule();
    }, [engine]);
    const cancelFlight = useCallback(() => {
        engine.flight.current = null;
    }, [engine.flight]);
    return { accumulatePan, accumulateZoom, cancelFlight };
}

function useProgrammaticActions(args: {
    engine: CameraRefs & { schedule: () => void };
    dimsRef: React.MutableRefObject<MapDims>;
    viewportRef: React.MutableRefObject<Viewport | null>;
    reducedMotionRef: React.MutableRefObject<boolean>;
    setViewport: Dispatch<SetStateAction<Viewport | null>>;
}) {
    const animateCameraTo = useCallback((target: Viewport, dur = 500) => {
        const dims = args.dimsRef.current;
        const from = args.viewportRef.current;
        if (!from || dims.width <= 0) return;
        const to = clampViewport(target, dims);
        if (args.reducedMotionRef.current || dur <= 0) {
            args.engine.flight.current = null;
            args.viewportRef.current = to;
            args.setViewport(to);
            return;
        }
        args.engine.flight.current = { from, to, start: performance.now(), dur };
        args.engine.schedule();
    }, [args]);
    const zoomByCenter = useCallback((factor: number) => {
        const viewport = args.viewportRef.current;
        const dims = args.dimsRef.current;
        if (viewport) {
            animateCameraTo(zoomAt(viewport,
                { x: dims.width / 2, y: dims.height / 2 }, factor, dims), 220);
        }
    }, [args.dimsRef, args.viewportRef, animateCameraTo]);
    const resetView = useCallback(() => {
        const dims = args.dimsRef.current;
        if (dims.width > 0) animateCameraTo(fitViewport(dims), 500);
    }, [args.dimsRef, animateCameraTo]);
    return { animateCameraTo, zoomByCenter, resetView };
}

/** Own and expose all map viewport mutations. */
export function useMapCamera({ dims, reducedMotion }: UseMapCameraArgs): UseMapCamera {
    const [viewport, setViewport, viewportRef] = useViewportState(dims);
    const dimsRef = useLatest(dims);
    const reducedMotionRef = useLatest(reducedMotion);
    const engine = useCameraEngine(dimsRef, viewportRef, setViewport);
    const continuous = useContinuousActions(engine);
    const programmatic = useProgrammaticActions({
        engine, dimsRef, viewportRef, reducedMotionRef, setViewport,
    });
    return { viewport, viewportRef, ...continuous, ...programmatic };
}
