interface SeekTimeOptions {
    currentTime: number;
    duration: number;
    step?: number;
    largeStep?: number;
}

/**
 * Resolves a slider keyboard command to a seek time clamped to the media duration.
 */
export function resolveSeekTime(
    key: string,
    { currentTime, duration, step = 5, largeStep = 10 }: SeekTimeOptions,
): number | null {
    if (!Number.isFinite(duration) || duration <= 0) return null;
    if (!Number.isFinite(currentTime)) return null;

    let nextTime: number;
    switch (key) {
        case "ArrowRight":
        case "ArrowUp":
            nextTime = currentTime + step;
            break;
        case "ArrowLeft":
        case "ArrowDown":
            nextTime = currentTime - step;
            break;
        case "PageUp":
            nextTime = currentTime + largeStep;
            break;
        case "PageDown":
            nextTime = currentTime - largeStep;
            break;
        case "Home":
            nextTime = 0;
            break;
        case "End":
            nextTime = duration;
            break;
        default:
            return null;
    }

    return Math.min(duration, Math.max(0, nextTime));
}
