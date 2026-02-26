export type SegmentedPrewarmReason = "startup_background" | "next_track";

const SEGMENTED_STARTUP_PREWARM_MAX_RETRIES = 12;
const SEGMENTED_NEXT_TRACK_PREWARM_MAX_RETRIES = 2;

interface ProactiveSegmentedHandoffEligibilityInput {
    playbackType: string;
    isListenTogether: boolean;
    currentTrackId: string | null;
    targetTrackId: string;
    activeSegmentedTrackId: string | null;
    attemptedTrackId: string | null;
}

export type ProactiveSegmentedHandoffSkipReason =
    | "eligible"
    | "playback_not_track"
    | "listen_together_active"
    | "track_mismatch"
    | "already_segmented_active"
    | "already_attempted_this_track";

export function resolveSegmentedPrewarmMaxRetries(
    reason: SegmentedPrewarmReason,
): number {
    return reason === "startup_background"
        ? SEGMENTED_STARTUP_PREWARM_MAX_RETRIES
        : SEGMENTED_NEXT_TRACK_PREWARM_MAX_RETRIES;
}

export function resolveProactiveSegmentedHandoffEligibility(
    input: ProactiveSegmentedHandoffEligibilityInput,
): { eligible: boolean; reason: ProactiveSegmentedHandoffSkipReason } {
    if (input.playbackType !== "track") {
        return {
            eligible: false,
            reason: "playback_not_track",
        };
    }
    if (input.isListenTogether) {
        return {
            eligible: false,
            reason: "listen_together_active",
        };
    }
    if (!input.currentTrackId || input.currentTrackId !== input.targetTrackId) {
        return {
            eligible: false,
            reason: "track_mismatch",
        };
    }
    if (input.activeSegmentedTrackId === input.targetTrackId) {
        return {
            eligible: false,
            reason: "already_segmented_active",
        };
    }
    if (input.attemptedTrackId === input.targetTrackId) {
        return {
            eligible: false,
            reason: "already_attempted_this_track",
        };
    }

    return {
        eligible: true,
        reason: "eligible",
    };
}
