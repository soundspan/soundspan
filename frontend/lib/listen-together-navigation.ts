export type ListenTogetherNavigationAction = "next" | "previous";

export interface ResolveListenTogetherNavigationIndexInput {
    action: ListenTogetherNavigationAction;
    queueLength: number;
    currentIndex: number;
    currentPositionMs: number;
}

export function resolveListenTogetherNavigationIndex(
    input: ResolveListenTogetherNavigationIndexInput,
): number | null {
    const { action, queueLength, currentIndex, currentPositionMs } = input;
    if (queueLength <= 0) return null;

    const safeCurrentIndex = Math.min(
        Math.max(currentIndex, 0),
        queueLength - 1,
    );

    if (action === "next") {
        return (safeCurrentIndex + 1) % queueLength;
    }

    // Match backend Listen Together behavior: previous restarts current track
    // when the host is beyond 3 seconds.
    if (currentPositionMs > 3000) {
        return safeCurrentIndex;
    }

    if (safeCurrentIndex > 0) {
        return safeCurrentIndex - 1;
    }
    return queueLength - 1;
}
