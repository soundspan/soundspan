/**
 * Pure decision math for centering the overlay queue on the playing row
 * (GH #787). Kept free of React so the reveal/track-change scroll behaviors
 * are unit-testable.
 */

export interface QueueCenteringInput {
    /** The queue panel just became visible (first pass after reveal). */
    isFirstReveal: boolean;
    /** The playing index changed while the panel stayed visible. */
    indexChanged: boolean;
    shouldReduceMotion: boolean;
    queueLength: number;
}

export type QueueCenteringBehavior = "auto" | "smooth";

/**
 * Scroll behavior for a queue centering pass, or null to leave the list
 * alone. Reveals jump instantly; track changes glide unless the user asked
 * for reduced motion.
 */
export function resolveQueueCenteringBehavior({
    isFirstReveal,
    indexChanged,
    shouldReduceMotion,
    queueLength,
}: QueueCenteringInput): QueueCenteringBehavior | null {
    if (queueLength === 0) return null;
    if (isFirstReveal) return "auto";
    if (!indexChanged) return null;
    return shouldReduceMotion ? "auto" : "smooth";
}

/** The row a centering pass targets: the playing row, or the top row. */
export function resolveQueueCenteringIndex(
    currentIndex: number,
    queueLength: number,
): number {
    if (currentIndex >= 0 && currentIndex < queueLength) return currentIndex;
    return 0;
}
