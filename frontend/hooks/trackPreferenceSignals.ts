import type { TrackPreferenceSignal } from "@/lib/api";

export type TrackPreferenceToggleTarget = "thumbs_up" | "thumbs_down";

export function getNextTrackPreferenceSignal(
    currentSignal: TrackPreferenceSignal,
    target: TrackPreferenceToggleTarget
): TrackPreferenceSignal {
    if (target === "thumbs_up") {
        return currentSignal === "thumbs_up" ? "clear" : "thumbs_up";
    }

    return currentSignal === "thumbs_down" ? "clear" : "thumbs_down";
}
