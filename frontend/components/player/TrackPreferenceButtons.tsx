"use client";

import { Heart } from "lucide-react";
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
    resolveFromQuery?: boolean;
}

interface FilledHeartIconProps {
    className?: string;
    "data-icon"?: string;
}

function HeartFilledIcon({ className, "data-icon": dataIcon }: FilledHeartIconProps) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="currentColor"
            className={className}
            aria-hidden="true"
            data-icon={dataIcon}
        >
            <path d="M12 21.35 10.55 20.03C5.4 15.36 2 12.27 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.77-3.4 6.86-8.55 11.53z" />
        </svg>
    );
}

interface TrackPreferenceButtonsContentProps {
    className?: string;
    buttonSizeClassName: string;
    iconSizeClassName: string;
    preferenceSignal: TrackPreferenceSignal;
    isPreferenceSaving: boolean;
    canSetTrackPreference: boolean;
    onLikeToggle: () => Promise<unknown> | unknown;
}

function TrackPreferenceButtonsContent({
    className,
    buttonSizeClassName,
    iconSizeClassName,
    preferenceSignal,
    isPreferenceSaving,
    canSetTrackPreference,
    onLikeToggle,
}: TrackPreferenceButtonsContentProps) {
    const isLiked = preferenceSignal === "thumbs_up";
    const label = isLiked ? "Unlike" : "Like";

    const baseButtonClass = cn(
        "inline-flex items-center justify-center bg-transparent p-0 transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40",
        buttonSizeClassName
    );

    return (
        <div className={cn("flex items-center gap-2", className)}>
            <button
                type="button"
                onClick={(event) => {
                    event.stopPropagation();
                    void onLikeToggle();
                }}
                className={cn(
                    baseButtonClass,
                    isLiked ?
                        "text-white"
                    :   "text-white/70 hover:text-white"
                )}
                disabled={!canSetTrackPreference || isPreferenceSaving}
                aria-label={label}
                aria-pressed={isLiked}
                title={label}
            >
                {isLiked ? (
                    <HeartFilledIcon
                        className={iconSizeClassName}
                        data-icon="heart-filled"
                    />
                ) : (
                    <Heart
                        className={iconSizeClassName}
                        data-icon="heart-outline"
                    />
                )}
            </button>
        </div>
    );
}

function TrackPreferenceButtonsControlled({
    trackId,
    className,
    buttonSizeClassName,
    iconSizeClassName,
    signal,
    isSaving,
    onToggleThumbsUp,
}: TrackPreferenceButtonsProps) {
    const canSetTrackPreference =
        Boolean(trackId) ||
        Boolean(onToggleThumbsUp);

    return (
        <TrackPreferenceButtonsContent
            className={className}
            buttonSizeClassName={buttonSizeClassName ?? "h-11 w-11"}
            iconSizeClassName={iconSizeClassName ?? "h-6 w-6"}
            preferenceSignal={signal ?? "clear"}
            isPreferenceSaving={isSaving ?? false}
            canSetTrackPreference={canSetTrackPreference}
            onLikeToggle={onToggleThumbsUp ?? (() => undefined)}
        />
    );
}

function TrackPreferenceButtonsWithQuery({
    trackId,
    className,
    buttonSizeClassName,
    iconSizeClassName,
    signal,
    isSaving,
    onToggleThumbsUp,
}: TrackPreferenceButtonsProps) {

    const {
        signal: queriedSignal,
        isSaving: queriedIsSaving,
        toggleLike: queriedToggleLike,
    } = useTrackPreference(trackId);

    const preferenceSignal = signal ?? queriedSignal;
    const isPreferenceSaving = isSaving ?? queriedIsSaving;
    const canSetTrackPreference =
        Boolean(trackId) ||
        Boolean(onToggleThumbsUp);

    return (
        <TrackPreferenceButtonsContent
            className={className}
            buttonSizeClassName={buttonSizeClassName ?? "h-11 w-11"}
            iconSizeClassName={iconSizeClassName ?? "h-6 w-6"}
            preferenceSignal={preferenceSignal}
            isPreferenceSaving={isPreferenceSaving}
            canSetTrackPreference={canSetTrackPreference}
            onLikeToggle={onToggleThumbsUp ?? queriedToggleLike}
        />
    );
}

export function TrackPreferenceButtons(props: TrackPreferenceButtonsProps) {
    if (props.resolveFromQuery === false) {
        return <TrackPreferenceButtonsControlled {...props} />;
    }
    return <TrackPreferenceButtonsWithQuery {...props} />;
}
