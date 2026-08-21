import type { GroupPlayback } from "./listenTogetherManager";

/** Return the active track duration in milliseconds when it is valid. */
export function currentTrackDurationMs(pb: GroupPlayback): number | null {
    const durationSeconds = pb.queue[pb.currentIndex]?.duration;
    if (
        typeof durationSeconds !== "number" ||
        !Number.isFinite(durationSeconds) ||
        durationSeconds < 0
    ) {
        return null;
    }
    const durationMs = durationSeconds * 1000;
    return Number.isFinite(durationMs) ? durationMs : null;
}

/** Compute playback position without applying the current-track duration. */
export function computeUnclampedPosition(pb: GroupPlayback): number {
    if (!pb.isPlaying) return pb.positionMs;
    return pb.positionMs + Math.max(Date.now() - pb.lastPositionUpdate, 0);
}

/** Compute playback position clamped to zero and the current track duration. */
export function computePosition(pb: GroupPlayback): number {
    const positionMs = Math.max(0, computeUnclampedPosition(pb));
    const durationMs = currentTrackDurationMs(pb);
    return durationMs === null
        ? positionMs
        : Math.min(Math.max(positionMs, 0), durationMs);
}

/** Return the active queue item's stable ID. */
export function currentTrackId(pb: GroupPlayback): string | null {
    return pb.queue[pb.currentIndex]?.id ?? null;
}
