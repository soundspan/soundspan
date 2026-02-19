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

interface FilledThumbIconProps {
    className?: string;
    "data-icon"?: string;
}

function ThumbsUpFilledIcon({ className, "data-icon": dataIcon }: FilledThumbIconProps) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            className={className}
            aria-hidden="true"
            data-icon={dataIcon}
        >
            <path d="M1 21h4V9H1v12zm21-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L13.17 1 6.59 7.59A1.996 1.996 0 0 0 6 9v10c0 1.1.9 2 2 2h9c.8 0 1.52-.48 1.84-1.21l3.02-7.05c.09-.24.14-.49.14-.74v-2z" />
        </svg>
    );
}

function ThumbsDownFilledIcon({
    className,
    "data-icon": dataIcon,
}: FilledThumbIconProps) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            className={className}
            aria-hidden="true"
            data-icon={dataIcon}
        >
            <path d="M15 3H6c-.8 0-1.52.48-1.84 1.21l-3.02 7.05A1.986 1.986 0 0 0 1 12v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.58-6.59c.37-.36.59-.86.59-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z" />
        </svg>
    );
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
        "inline-flex items-center justify-center bg-transparent p-0 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
        buttonSizeClassName
    );

    return (
        <div className={cn("flex items-center gap-2", className)}>
            {mode !== "up-only" && (
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        void toggleThumbsDown();
                    }}
                    className={cn(
                        baseButtonClass,
                        isThumbsDown ?
                            "text-white"
                        :   "text-white/70 hover:text-white"
                    )}
                    disabled={!canSetTrackPreference || isPreferenceSaving}
                    aria-label="Thumbs down"
                    aria-pressed={isThumbsDown}
                    title="Thumbs down"
                >
                    {isThumbsDown ? (
                        <ThumbsDownFilledIcon
                            className={iconSizeClassName}
                            data-icon="thumbs-down-filled"
                        />
                    ) : (
                        <ThumbsDown
                            className={iconSizeClassName}
                            data-icon="thumbs-down-outline"
                        />
                    )}
                </button>
            )}

            {mode !== "down-only" && (
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        void toggleThumbsUp();
                    }}
                    className={cn(
                        baseButtonClass,
                        isThumbsUp ?
                            "text-white"
                        :   "text-white/70 hover:text-white"
                    )}
                    disabled={!canSetTrackPreference || isPreferenceSaving}
                    aria-label="Thumbs up"
                    aria-pressed={isThumbsUp}
                    title="Thumbs up"
                >
                    {isThumbsUp ? (
                        <ThumbsUpFilledIcon
                            className={iconSizeClassName}
                            data-icon="thumbs-up-filled"
                        />
                    ) : (
                        <ThumbsUp
                            className={iconSizeClassName}
                            data-icon="thumbs-up-outline"
                        />
                    )}
                </button>
            )}
        </div>
    );
}
