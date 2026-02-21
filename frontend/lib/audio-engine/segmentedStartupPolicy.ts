export type SegmentedPrewarmReason = "startup_background" | "next_track";

const SEGMENTED_STARTUP_PREWARM_MAX_RETRIES = 12;
const SEGMENTED_NEXT_TRACK_PREWARM_MAX_RETRIES = 5;

interface ProactiveSegmentedHandoffEligibilityInput {
    playbackType: string;
    isListenTogether: boolean;
    currentTrackId: string | null;
    targetTrackId: string;
    activeSegmentedTrackId: string | null;
    attemptedTrackId: string | null;
    isCurrentlyPlaying: boolean;
}

export function resolveSegmentedPrewarmMaxRetries(
    reason: SegmentedPrewarmReason,
): number {
    return reason === "startup_background"
        ? SEGMENTED_STARTUP_PREWARM_MAX_RETRIES
        : SEGMENTED_NEXT_TRACK_PREWARM_MAX_RETRIES;
}

export function shouldAttemptProactiveSegmentedHandoff(
    input: ProactiveSegmentedHandoffEligibilityInput,
): boolean {
    if (input.playbackType !== "track") {
        return false;
    }
    if (input.isListenTogether) {
        return false;
    }
    if (!input.currentTrackId || input.currentTrackId !== input.targetTrackId) {
        return false;
    }
    if (input.activeSegmentedTrackId === input.targetTrackId) {
        return false;
    }
    if (input.attemptedTrackId === input.targetTrackId) {
        return false;
    }
    if (!input.isCurrentlyPlaying) {
        return false;
    }

    return true;
}
