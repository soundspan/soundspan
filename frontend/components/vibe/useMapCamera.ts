"use client";

/**
 * useMapCamera — SINGLE CAMERA OWNER for the vibe map.
 *
 * Every viewport write goes through one rAF loop: continuous inputs (wheel
 * zoom, drag pan, pinch — fed in by `useMapGestures`) accumulate into pending
 * refs via `accumulatePan`/`accumulateZoom` and are flushed at most once per
 * frame; programmatic moves (locate, reset, zoom buttons, travel auto-follow,
 * journey framing) run as a cancellable eased flight via `animateCameraTo`.
 * Any direct input should call `cancelFlight()` first so the camera never
 * fights the user's hands.
 *
 * Owns the viewport state itself (initialised to the whole-map fit once the
 * container has real dimensions) and exposes a live `viewportRef` for
 * rAF-loop/native-listener consumers that must read the latest transform
 * without re-subscribing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLatest } from "./useLatest";
import {
    clampViewport,
    fitViewport,
    interpolateViewport,
    zoomAt,
    type MapDims,
    type Viewport,
} from "./mapViewport";

export function easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

interface CameraFlight {
    from: Viewport;
    to: Viewport;
    start: number;
    dur: number;
}

export interface UseMapCamera {
    /** The committed viewport (null until the container has been measured). */
    viewport: Viewport | null;
    /** Live mirror of `viewport` for rAF loops / native listeners. */
    viewportRef: React.RefObject<Viewport | null>;
    /** Accumulate a pan delta (px); flushed on the next camera frame. */
    accumulatePan: (dx: number, dy: number) => void;
    /**
     * Accumulate a zoom about a screen-space cursor; `logf` is the log of the
     * zoom factor so successive inputs compose additively.
     */
    accumulateZoom: (cx: number, cy: number, logf: number) => void;
    /** Cancel an in-flight eased camera animation (direct input wins). */
    cancelFlight: () => void;
    /** Eased flight to `target` (clamped). Reduced motion → snap. */
    animateCameraTo: (target: Viewport, dur?: number) => void;
    /** Animated zoom by `factor` about the screen center. */
    zoomByCenter: (factor: number) => void;
    /** Animated reset to the whole-map fit. */
    resetView: () => void;
}

export interface UseMapCameraArgs {
    dims: MapDims;
    reducedMotion: boolean;
}

export function useMapCamera({
    dims,
    reducedMotion,
}: UseMapCameraArgs): UseMapCamera {
    const [viewport, setViewport] = useState<Viewport | null>(null);
    const viewportRef = useLatest(viewport);
    const dimsRef = useLatest(dims);
    const reducedMotionRef = useLatest(reducedMotion);

    // First real measurement initialises the viewport to the whole-map fit.
    useEffect(() => {
        if (dims.width > 0 && dims.height > 0) {
            setViewport((vp) => vp ?? fitViewport(dims));
        }
    }, [dims]);

    const panPendingRef = useRef({ dx: 0, dy: 0 });
    const zoomPendingRef = useRef<{ cx: number; cy: number; logf: number } | null>(
        null
    );
    const cameraAnimRef = useRef<CameraFlight | null>(null);
    const cameraRafRef = useRef<number | null>(null);

    const cameraTick = useCallback(function tick(now: number) {
        cameraRafRef.current = null;
        const d = dimsRef.current;
        let vp = viewportRef.current;
        if (!vp || d.width <= 0 || d.height <= 0) return;

        let dirty = false;
        const zoom = zoomPendingRef.current;
        if (zoom) {
            vp = zoomAt(vp, { x: zoom.cx, y: zoom.cy }, Math.exp(zoom.logf), d);
            zoomPendingRef.current = null;
            dirty = true;
        }
        const pan = panPendingRef.current;
        if (pan.dx !== 0 || pan.dy !== 0) {
            vp = clampViewport(
                { scale: vp.scale, tx: vp.tx + pan.dx, ty: vp.ty + pan.dy },
                d
            );
            panPendingRef.current = { dx: 0, dy: 0 };
            dirty = true;
        }
        const anim = cameraAnimRef.current;
        if (!dirty && anim) {
            const t = Math.min(1, (now - anim.start) / anim.dur);
            vp = interpolateViewport(anim.from, anim.to, easeInOutCubic(t), d);
            if (t >= 1) {
                cameraAnimRef.current = null;
            } else {
                cameraRafRef.current = requestAnimationFrame(tick);
            }
            dirty = true;
        }
        if (dirty) {
            viewportRef.current = vp;
            setViewport(vp);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dimsRef/viewportRef come from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this camera rAF tick does not re-subscribe.
    }, []);

    const scheduleCamera = useCallback(() => {
        if (cameraRafRef.current == null) {
            cameraRafRef.current = requestAnimationFrame(cameraTick);
        }
    }, [cameraTick]);

    useEffect(() => {
        return () => {
            if (cameraRafRef.current != null) {
                cancelAnimationFrame(cameraRafRef.current);
            }
        };
    }, []);

    const accumulatePan = useCallback(
        (dx: number, dy: number) => {
            panPendingRef.current.dx += dx;
            panPendingRef.current.dy += dy;
            scheduleCamera();
        },
        [scheduleCamera]
    );

    const accumulateZoom = useCallback(
        (cx: number, cy: number, logf: number) => {
            const prev = zoomPendingRef.current;
            zoomPendingRef.current = {
                cx,
                cy,
                logf: (prev?.logf ?? 0) + logf,
            };
            scheduleCamera();
        },
        [scheduleCamera]
    );

    const cancelFlight = useCallback(() => {
        cameraAnimRef.current = null;
    }, []);

    const animateCameraTo = useCallback(
        (target: Viewport, dur = 500) => {
            const d = dimsRef.current;
            const from = viewportRef.current;
            if (!from || d.width <= 0) return;
            const to = clampViewport(target, d);
            if (reducedMotionRef.current || dur <= 0) {
                cameraAnimRef.current = null;
                viewportRef.current = to;
                setViewport(to);
                return;
            }
            cameraAnimRef.current = {
                from,
                to,
                start: performance.now(),
                dur,
            };
            scheduleCamera();
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- dimsRef/reducedMotionRef/viewportRef come from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this callback is not re-created every render.
        [scheduleCamera]
    );

    const zoomByCenter = useCallback(
        (factor: number) => {
            const vp = viewportRef.current;
            const d = dimsRef.current;
            if (!vp) return;
            animateCameraTo(
                zoomAt(vp, { x: d.width / 2, y: d.height / 2 }, factor, d),
                220
            );
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps -- dimsRef/viewportRef come from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this callback is not re-created every render.
        [animateCameraTo]
    );

    const resetView = useCallback(() => {
        const d = dimsRef.current;
        if (d.width > 0) animateCameraTo(fitViewport(d), 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dimsRef comes from useLatest(), a stable ref identity (same guarantee useRef gets automatically); intentionally excluded so this callback is not re-created every render.
    }, [animateCameraTo]);

    return {
        viewport,
        viewportRef,
        accumulatePan,
        accumulateZoom,
        cancelFlight,
        animateCameraTo,
        zoomByCenter,
        resetView,
    };
}
