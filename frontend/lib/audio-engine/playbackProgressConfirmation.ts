const CONFIRMED_PLAYBACK_PROGRESS_THRESHOLD_SECONDS = 0.5;

/** Maximum backward engine wobble ignored without re-baselining progress. */
export const JITTER_TOLERANCE_SECONDS = 0.25;

/** Movement tracked for one media item until playback is confirmed. */
export interface PlaybackProgressConfirmationState {
    mediaId: string | null;
    baselineTimeSeconds: number | null;
    lastTimeSeconds: number | null;
    cumulativeAdvancementSeconds: number;
    confirmed: boolean;
}

/** A position observation or an explicit seek discontinuity. */
export interface PlaybackProgressConfirmationEvent {
    type: "position" | "seek";
    mediaId: string | null;
    currentTimeSeconds: number;
    isPlaying: boolean;
}

/** Result of applying one playback-progress event. */
export interface PlaybackProgressConfirmationResult {
    nextState: PlaybackProgressConfirmationState;
    confirmed: boolean;
}

/** Creates an unarmed playback-progress confirmation state. */
export function createPlaybackProgressConfirmationState(): PlaybackProgressConfirmationState {
    return {
        mediaId: null,
        baselineTimeSeconds: null,
        lastTimeSeconds: null,
        cumulativeAdvancementSeconds: 0,
        confirmed: false,
    };
}

const createBaselineState = (
    mediaId: string,
    currentTimeSeconds: number | null,
): PlaybackProgressConfirmationState => ({
    mediaId,
    baselineTimeSeconds: currentTimeSeconds,
    lastTimeSeconds: currentTimeSeconds,
    cumulativeAdvancementSeconds: 0,
    confirmed: false,
});

/** Re-arms confirmation when runtime restarts the current media item. */
export function restartPlaybackProgressConfirmation(
    mediaId: string | null,
): PlaybackProgressConfirmationState {
    return mediaId
        ? createBaselineState(mediaId, null)
        : createPlaybackProgressConfirmationState();
}

/** Re-arms only the failed media item's previously established state. */
export function rearmPlaybackProgressConfirmationOnError(
    previousState: PlaybackProgressConfirmationState,
    failedMediaId: string | null,
): PlaybackProgressConfirmationState {
    if (!failedMediaId || previousState.mediaId !== failedMediaId) {
        return previousState;
    }
    return restartPlaybackProgressConfirmation(failedMediaId);
}

/**
 * Advances confirmation state from one engine position event.
 *
 * The first valid position establishes a baseline. Only later, strictly
 * increasing positions observed while playing contribute toward confirmation.
 * Seek discontinuities and backward movement beyond the jitter tolerance
 * establish a new baseline.
 */
export function transitionPlaybackProgressConfirmation(
    previousState: PlaybackProgressConfirmationState,
    event: PlaybackProgressConfirmationEvent,
): PlaybackProgressConfirmationResult {
    if (!event.mediaId) {
        return {
            nextState: createPlaybackProgressConfirmationState(),
            confirmed: false,
        };
    }

    const hasValidPosition =
        Number.isFinite(event.currentTimeSeconds) &&
        event.currentTimeSeconds >= 0;
    if (previousState.mediaId !== event.mediaId) {
        return {
            nextState: createBaselineState(
                event.mediaId,
                hasValidPosition ? event.currentTimeSeconds : null,
            ),
            confirmed: false,
        };
    }
    if (!hasValidPosition || previousState.confirmed) {
        return { nextState: previousState, confirmed: false };
    }
    if (
        event.type === "seek" ||
        previousState.lastTimeSeconds === null ||
        !event.isPlaying
    ) {
        return {
            nextState: createBaselineState(
                event.mediaId,
                event.currentTimeSeconds,
            ),
            confirmed: false,
        };
    }
    if (event.currentTimeSeconds < previousState.lastTimeSeconds) {
        const backwardMovementSeconds =
            previousState.lastTimeSeconds - event.currentTimeSeconds;
        if (backwardMovementSeconds <= JITTER_TOLERANCE_SECONDS) {
            return { nextState: previousState, confirmed: false };
        }
        return {
            nextState: createBaselineState(
                event.mediaId,
                event.currentTimeSeconds,
            ),
            confirmed: false,
        };
    }
    if (event.currentTimeSeconds === previousState.lastTimeSeconds) {
        return { nextState: previousState, confirmed: false };
    }

    const cumulativeAdvancementSeconds =
        previousState.cumulativeAdvancementSeconds +
        (event.currentTimeSeconds - previousState.lastTimeSeconds);
    const confirmed =
        cumulativeAdvancementSeconds >=
        CONFIRMED_PLAYBACK_PROGRESS_THRESHOLD_SECONDS;
    return {
        nextState: {
            ...previousState,
            lastTimeSeconds: event.currentTimeSeconds,
            cumulativeAdvancementSeconds,
            confirmed,
        },
        confirmed,
    };
}
