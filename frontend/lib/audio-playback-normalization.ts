export function clampNonNegativePlaybackTime(timeSec: number): number {
    return Math.max(0, timeSec);
}

export function resolvePlaybackTimeUpperBound(
    mediaDurationSec: number,
    engineDurationSec = 0
): number {
    return mediaDurationSec > 0 && engineDurationSec > 0
        ? Math.min(mediaDurationSec, engineDurationSec)
        : mediaDurationSec || engineDurationSec || 0;
}

export function clampPlaybackTimeToUpperBound(
    timeSec: number,
    upperBoundSec: number
): number {
    return upperBoundSec > 0
        ? Math.min(clampNonNegativePlaybackTime(timeSec), upperBoundSec)
        : clampNonNegativePlaybackTime(timeSec);
}
