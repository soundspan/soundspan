"use client";

import { useRef, useState } from "react";
import {
    clampTrackSwipeOffset,
    resolveTrackSwipeAction,
    resolveVerticalDragOffset,
    shouldCloseFromVerticalSwipe,
} from "@/lib/overlay-gesture-policy";

interface OverlayGestureOptions {
    canSkip: boolean;
    onPrevious: () => void;
    onNext: () => void;
    /** Close the whole overlay (header swipe-down). */
    onCloseOverlay: () => void;
    /** Close the bottom drawer (drawer-handle swipe-down). */
    onCloseDrawer: () => void;
}

export interface TouchHandlerSet {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
}

interface VerticalDragMachine {
    dragOffset: number;
    isDragActive: boolean;
    handlers: TouchHandlerSet;
    /** Clears drag state when the surface is closed externally. */
    resetDrag: () => void;
}

/**
 * One vertical swipe-to-close state machine (shared by the overlay header
 * and the drawer handle — identical thresholds, different close targets).
 */
function useVerticalCloseGesture(
    maxOffset: number,
    onClose: () => void,
    preventDefaultOnClose: boolean,
): VerticalDragMachine {
    const startY = useRef<number | null>(null);
    const startX = useRef<number | null>(null);
    const startTime = useRef<number | null>(null);
    const [dragOffset, setDragOffset] = useState(0);
    const [isDragActive, setIsDragActive] = useState(false);

    const reset = () => {
        startY.current = null;
        startX.current = null;
        startTime.current = null;
    };

    return {
        dragOffset,
        isDragActive,
        resetDrag: () => {
            setDragOffset(0);
            setIsDragActive(false);
            reset();
        },
        handlers: {
            onTouchStart: (e) => {
                startY.current = e.touches[0].clientY;
                startX.current = e.touches[0].clientX;
                startTime.current = Date.now();
                setDragOffset(0);
                setIsDragActive(true);
                e.stopPropagation();
            },
            onTouchMove: (e) => {
                if (startY.current === null || startX.current === null) return;
                const offset = resolveVerticalDragOffset(
                    e.touches[0].clientY - startY.current,
                    e.touches[0].clientX - startX.current,
                    maxOffset,
                );
                if (offset !== null) {
                    setDragOffset(offset);
                    if (offset > 0) e.preventDefault();
                }
                e.stopPropagation();
            },
            onTouchEnd: (e) => {
                if (startY.current === null || startX.current === null) {
                    setDragOffset(0);
                    setIsDragActive(false);
                    return;
                }
                const closes = shouldCloseFromVerticalSwipe({
                    deltaY: e.changedTouches[0].clientY - startY.current,
                    deltaX: e.changedTouches[0].clientX - startX.current,
                    elapsedMs: Math.max(
                        1,
                        Date.now() - (startTime.current ?? Date.now()),
                    ),
                });
                if (closes) {
                    setDragOffset((prev) => Math.max(prev, 140));
                    setIsDragActive(false);
                    if (preventDefaultOnClose) e.preventDefault();
                    onClose();
                } else {
                    setDragOffset(0);
                    setIsDragActive(false);
                }
                reset();
                e.stopPropagation();
            },
        },
    };
}

/**
 * The overlay player's three touch gestures (GH #787): horizontal track
 * swipe, header swipe-down to close the overlay, and drawer-handle
 * swipe-down to close the drawer. Threshold math lives in
 * lib/overlay-gesture-policy.
 */
export function useOverlayGestures({
    canSkip,
    onPrevious,
    onNext,
    onCloseOverlay,
    onCloseDrawer,
}: OverlayGestureOptions) {
    const touchStartX = useRef<number | null>(null);
    const [swipeOffset, setSwipeOffset] = useState(0);

    const trackSwipeHandlers: TouchHandlerSet = {
        onTouchStart: (e) => {
            touchStartX.current = e.touches[0].clientX;
        },
        onTouchMove: (e) => {
            if (touchStartX.current === null) return;
            setSwipeOffset(
                clampTrackSwipeOffset(
                    e.touches[0].clientX - touchStartX.current,
                ),
            );
        },
        onTouchEnd: () => {
            if (touchStartX.current === null) return;
            const action = resolveTrackSwipeAction(swipeOffset, canSkip);
            if (action === "previous") onPrevious();
            if (action === "next") onNext();
            setSwipeOffset(0);
            touchStartX.current = null;
        },
    };

    const overlayClose = useVerticalCloseGesture(220, onCloseOverlay, true);
    const drawerClose = useVerticalCloseGesture(240, onCloseDrawer, false);

    return {
        swipeOffset,
        overlayDragOffset: overlayClose.dragOffset,
        isOverlayDragActive: overlayClose.isDragActive,
        overlayHeaderHandlers: overlayClose.handlers,
        drawerDragOffset: drawerClose.dragOffset,
        isDrawerDragActive: drawerClose.isDragActive,
        drawerHandleHandlers: drawerClose.handlers,
        resetDrawerDrag: drawerClose.resetDrag,
        trackSwipeHandlers,
    };
}
