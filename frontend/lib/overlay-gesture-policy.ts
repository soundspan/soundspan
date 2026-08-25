/**
 * Pure decision math for the overlay player's touch gestures (GH #787).
 * Kept free of React so the swipe/close thresholds are unit-testable.
 */

/** Horizontal track-swipe offset, clamped to the visual travel range. */
export function clampTrackSwipeOffset(deltaX: number): number {
    return Math.max(-100, Math.min(100, deltaX));
}

/** Which skip a completed horizontal swipe requests, if any. */
export function resolveTrackSwipeAction(
    swipeOffset: number,
    canSkip: boolean,
): "previous" | "next" | null {
    if (!canSkip) return null;
    if (swipeOffset > 60) return "previous";
    if (swipeOffset < -60) return "next";
    return null;
}

/**
 * Live drag offset for a downward close gesture. Returns null when the
 * movement is not a predominantly-vertical downward drag.
 */
export function resolveVerticalDragOffset(
    deltaY: number,
    deltaX: number,
    maxOffset: number,
): number | null {
    if (deltaY > 0 && deltaY > Math.abs(deltaX) * 0.9) {
        return Math.min(maxOffset, deltaY);
    }
    if (deltaY <= 0) return 0;
    return null;
}

export interface VerticalSwipeInput {
    deltaY: number;
    deltaX: number;
    elapsedMs: number;
}

/** Whether a finished downward swipe closes the surface (distance or flick). */
export function shouldCloseFromVerticalSwipe({
    deltaY,
    deltaX,
    elapsedMs,
}: VerticalSwipeInput): boolean {
    const velocityY = deltaY / Math.max(1, elapsedMs);
    const isVerticalSwipe = deltaY > 0 && deltaY > Math.abs(deltaX) * 1.2;
    const isDistanceClose = deltaY > 44;
    const isVelocityClose = deltaY > 20 && velocityY > 0.25;
    return isVerticalSwipe && (isDistanceClose || isVelocityClose);
}
