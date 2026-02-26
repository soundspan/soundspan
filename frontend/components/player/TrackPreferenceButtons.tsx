"use client";

import { ThumbsDown, ThumbsUp } from "lucide-react";
import { type TrackPreferenceSignal } from "@/lib/api";
import { useTrackPreference } from "@/hooks/useTrackPreference";
import { cn } from "@/utils/cn";

interface TrackPreferenceButtonsProps {
    trackId?: string | null;
    className?: string;
    buttonSizeClassName?: string;
    iconSizeClassName?: string;
    mode?: "both" | "up-only" | "down-only";
    signal?: TrackPreferenceSignal;
    isSaving?: boolean;
    onToggleThumbsUp?: () => Promise<unknown> | unknown;
    onToggleThumbsDown?: () => Promise<unknown> | unknown;
    resolveFromQuery?: boolean;
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

interface TrackPreferenceButtonsContentProps {
    className?: string;
    buttonSizeClassName: string;
    iconSizeClassName: string;
    mode: "both" | "up-only" | "down-only";
    preferenceSignal: TrackPreferenceSignal;
    isPreferenceSaving: boolean;
    canSetTrackPreference: boolean;
    onThumbsUpToggle: () => Promise<unknown> | unknown;
    onThumbsDownToggle: () => Promise<unknown> | unknown;
}

function TrackPreferenceButtonsContent({
    className,
    buttonSizeClassName,
    iconSizeClassName,
    mode,
    preferenceSignal,
    isPreferenceSaving,
    canSetTrackPreference,
    onThumbsUpToggle,
    onThumbsDownToggle,
}: TrackPreferenceButtonsContentProps) {
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
                        void onThumbsDownToggle();
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
                        void onThumbsUpToggle();
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

function TrackPreferenceButtonsControlled({
    trackId,
    className,
    buttonSizeClassName,
    iconSizeClassName,
    mode,
    signal,
    isSaving,
    onToggleThumbsUp,
    onToggleThumbsDown,
}: TrackPreferenceButtonsProps) {
    const canSetTrackPreference =
        Boolean(trackId) ||
        Boolean(onToggleThumbsUp) ||
        Boolean(onToggleThumbsDown);

    return (
        <TrackPreferenceButtonsContent
            className={className}
            buttonSizeClassName={buttonSizeClassName ?? "h-11 w-11"}
            iconSizeClassName={iconSizeClassName ?? "h-6 w-6"}
            mode={mode ?? "both"}
            preferenceSignal={signal ?? "clear"}
            isPreferenceSaving={isSaving ?? false}
            canSetTrackPreference={canSetTrackPreference}
            onThumbsUpToggle={onToggleThumbsUp ?? (() => undefined)}
            onThumbsDownToggle={onToggleThumbsDown ?? (() => undefined)}
        />
    );
}

function TrackPreferenceButtonsWithQuery({
    trackId,
    className,
    buttonSizeClassName,
    iconSizeClassName,
    mode,
    signal,
    isSaving,
    onToggleThumbsUp,
    onToggleThumbsDown,
}: TrackPreferenceButtonsProps) {

    const {
        signal: queriedSignal,
        isSaving: queriedIsSaving,
        toggleThumbsUp: queriedToggleThumbsUp,
        toggleThumbsDown: queriedToggleThumbsDown,
    } = useTrackPreference(trackId);

    const preferenceSignal = signal ?? queriedSignal;
    const isPreferenceSaving = isSaving ?? queriedIsSaving;
    const canSetTrackPreference =
        Boolean(trackId) ||
        Boolean(onToggleThumbsUp) ||
        Boolean(onToggleThumbsDown);

    return (
        <TrackPreferenceButtonsContent
            className={className}
            buttonSizeClassName={buttonSizeClassName ?? "h-11 w-11"}
            iconSizeClassName={iconSizeClassName ?? "h-6 w-6"}
            mode={mode ?? "both"}
            preferenceSignal={preferenceSignal}
            isPreferenceSaving={isPreferenceSaving}
            canSetTrackPreference={canSetTrackPreference}
            onThumbsUpToggle={onToggleThumbsUp ?? queriedToggleThumbsUp}
            onThumbsDownToggle={onToggleThumbsDown ?? queriedToggleThumbsDown}
        />
    );
}

export function TrackPreferenceButtons(props: TrackPreferenceButtonsProps) {
    if (props.resolveFromQuery === false) {
        return <TrackPreferenceButtonsControlled {...props} />;
    }
    return <TrackPreferenceButtonsWithQuery {...props} />;
}
