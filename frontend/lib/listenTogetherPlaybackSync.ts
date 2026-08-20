/**
 * Compute a server-timeline playback target with bounded transport latency.
 */
export function computeCompensatedTargetMs(
    positionMs: number,
    serverTimeMs: number,
    nowMs: number,
    clientClockOffsetMs: number,
    maxCompensationMs: number,
): number {
    const ageMs = nowMs - clientClockOffsetMs - serverTimeMs;
    const compensationMs = Math.min(
        Math.max(ageMs, 0),
        Math.max(maxCompensationMs, 0),
    );
    return Math.max(positionMs, 0) + compensationMs;
}
