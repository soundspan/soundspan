import type { TrackPreferenceSignal } from "@/lib/api";

/**
 * Executes getNextTrackPreferenceSignal.
 */
export function getNextTrackPreferenceSignal(
    currentSignal: TrackPreferenceSignal
): TrackPreferenceSignal {
    return currentSignal === "thumbs_up" ? "clear" : "thumbs_up";
}
