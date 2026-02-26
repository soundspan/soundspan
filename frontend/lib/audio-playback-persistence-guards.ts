/**
 * Pure guard functions extracted from AudioPlaybackProvider for testability.
 * These functions encapsulate the core persistence-snapshot and engine-time-update
 * validation logic without React hook dependencies.
 */

export interface ActivePlaybackSelection {
    playbackType: "track" | "audiobook" | "podcast" | null;
    trackId: string | null;
    audiobookId: string | null;
    podcastId: string | null;
    trackEpoch: number;
}

export interface PlaybackPersistenceSnapshot {
    playbackType: "track" | "audiobook" | "podcast";
    trackId: string | null;
    audiobookId: string | null;
    podcastId: string | null;
    trackEpoch: number;
}

export interface SeekState {
    isSeekLocked: boolean;
    seekTarget: number | null;
}

/**
 * During hydration transitions, layout effects can advance the ref-backed epoch
 * one render earlier than the state-backed epoch. Use the higher value to avoid
 * transiently classifying current updates as stale.
 */
export function resolveTrackPersistenceEpoch(
    stateEpoch: number,
    refEpoch: number,
): number {
    return refEpoch > stateEpoch ? refEpoch : stateEpoch;
}

/**
 * Determines whether a persistence snapshot still represents the active playback
 * selection. Used to prevent stale persisted state from being applied after a
 * track/audiobook/podcast transition.
 */
export function isPlaybackSelectionMatch(
    snapshot: PlaybackPersistenceSnapshot,
    activeSelection: ActivePlaybackSelection,
): boolean {
    if (snapshot.playbackType !== activeSelection.playbackType) {
        return false;
    }

    if (snapshot.playbackType === "track") {
        return (
            Boolean(snapshot.trackId) &&
            snapshot.trackId === activeSelection.trackId &&
            snapshot.trackEpoch === activeSelection.trackEpoch
        );
    }
    if (snapshot.playbackType === "audiobook") {
        return (
            Boolean(snapshot.audiobookId) &&
            snapshot.audiobookId === activeSelection.audiobookId
        );
    }
    return (
        Boolean(snapshot.podcastId) &&
        snapshot.podcastId === activeSelection.podcastId
    );
}

export type EngineTimeUpdateDecision = "accept" | "reject" | "unlock-accept";

/**
 * Decides whether an incoming engine time-update should be accepted, rejected,
 * or accepted with a seek-unlock side-effect.
 *
 * - For track playback, the invocation must carry a trackId matching the active
 *   selection; otherwise it is rejected as stale.
 * - During a seek lock, only updates within 2 seconds of the seek target are
 *   accepted (with unlock), all others are rejected.
 */
export function shouldAcceptEngineTimeUpdate(
    invocationTrackId: string | null,
    activeSelection: ActivePlaybackSelection,
    seekState: SeekState,
    time: number,
): EngineTimeUpdateDecision {
    if (activeSelection.playbackType === "track") {
        if (
            !invocationTrackId ||
            invocationTrackId !== activeSelection.trackId
        ) {
            return "reject";
        }
    }

    if (seekState.isSeekLocked && seekState.seekTarget !== null) {
        const isNearTarget = Math.abs(time - seekState.seekTarget) < 2;
        if (!isNearTarget) {
            return "reject";
        }
        return "unlock-accept";
    }

    return "accept";
}
