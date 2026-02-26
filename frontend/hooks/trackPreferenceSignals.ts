import type { TrackPreferenceSignal } from "@/lib/api";

export function getNextTrackPreferenceSignal(
    currentSignal: TrackPreferenceSignal
): TrackPreferenceSignal {
    return currentSignal === "thumbs_up" ? "clear" : "thumbs_up";
}
