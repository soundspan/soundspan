"use client";

import { ThumbsDown, ThumbsUp } from "lucide-react";
import { useTrackPreference } from "@/hooks/useTrackPreference";
import { cn } from "@/utils/cn";

interface TrackPreferenceButtonsProps {
    trackId?: string | null;
    className?: string;
    buttonSizeClassName?: string;
    iconSizeClassName?: string;
    mode?: "both" | "up-only" | "down-only";
}

export function TrackPreferenceButtons({
    trackId,
    className,
    buttonSizeClassName = "h-8 w-8",
    iconSizeClassName = "h-4 w-4",
    mode = "both",
}: TrackPreferenceButtonsProps) {
    const {
        signal: preferenceSignal,
        isSaving: isPreferenceSaving,
        toggleThumbsUp,
        toggleThumbsDown,
    } = useTrackPreference(trackId);

    const canSetTrackPreference = Boolean(trackId);
    const isThumbsUp = preferenceSignal === "thumbs_up";
    const isThumbsDown = preferenceSignal === "thumbs_down";

    const baseButtonClass = cn(
        "inline-flex items-center justify-center rounded-full border bg-transparent transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
        buttonSizeClassName
    );

    return (
        <div className={cn("flex items-center gap-2", className)}>
            {mode !== "up-only" && (
                <button
                    onClick={(event) => {
                        event.stopPropagation();
                        void toggleThumbsDown();
                    }}
                    className={cn(
                        baseButtonClass,
                        isThumbsDown ?
                            "border-white text-white"
                        :   "border-white/55 text-white/70 hover:border-white hover:text-white"
                    )}
                    disabled={!canSetTrackPreference || isPreferenceSaving}
                    aria-label="Thumbs down"
                    aria-pressed={isThumbsDown}
                    title="Thumbs down"
                >
                    <ThumbsDown className={iconSizeClassName} />
                </button>
            )}

            {mode !== "down-only" && (
                <button
                    onClick={(event) => {
                        event.stopPropagation();
                        void toggleThumbsUp();
                    }}
                    className={cn(
                        baseButtonClass,
                        isThumbsUp ?
                            "border-white text-white"
                        :   "border-white/55 text-white/70 hover:border-white hover:text-white"
                    )}
                    disabled={!canSetTrackPreference || isPreferenceSaving}
                    aria-label="Thumbs up"
                    aria-pressed={isThumbsUp}
                    title="Thumbs up"
                >
                    <ThumbsUp className={iconSizeClassName} />
                </button>
            )}
        </div>
    );
}
