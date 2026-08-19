const CONFIRMED_PLAYBACK_PROGRESS_THRESHOLD_SECONDS = 0.5;

/**
 * Decides whether a time update proves playback for an unconfirmed media item.
 *
 * Engine time-update payloads do not identify seek-originated updates. A seek
 * can therefore confirm progress; manual play still resets the breaker.
 */
export function shouldConfirmPlaybackProgress(
    lastConfirmedMediaId: string | null,
    currentMediaId: string | null,
    currentTimeSeconds: number,
    isPlaying: boolean,
): boolean {
    if (!isPlaying || !currentMediaId) return false;
    if (lastConfirmedMediaId === currentMediaId) return false;
    return (
        Number.isFinite(currentTimeSeconds) &&
        currentTimeSeconds >= CONFIRMED_PLAYBACK_PROGRESS_THRESHOLD_SECONDS
    );
}
