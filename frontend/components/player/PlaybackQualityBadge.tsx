"use client";

import type { PlaybackQualityBadge as PlaybackQualityBadgeValue } from "@/hooks/useStreamBitrate";
import { cn } from "@/utils/cn";

type PlaybackQualityBadgeSize = "mini" | "full";

const PLAYBACK_QUALITY_BADGE_TONE_CLASS: Record<
    PlaybackQualityBadgeValue["variant"],
    string
> = {
    tidal: "bg-[#00BFFF]/20 text-[#00BFFF]",
    youtube: "bg-red-500/20 text-red-400",
    local: "bg-emerald-500/20 text-emerald-400",
};

const PLAYBACK_QUALITY_BADGE_SIZE_CLASS: Record<
    PlaybackQualityBadgeSize,
    string
> = {
    mini: "max-w-[45vw] flex-shrink-0 overflow-hidden text-ellipsis whitespace-nowrap rounded px-1 py-0.5 text-[9px] font-bold leading-none",
    full: "inline-flex max-w-full items-center overflow-hidden text-ellipsis whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-bold",
};

export const getPlaybackQualityBadgeToneClassName = (
    variant: PlaybackQualityBadgeValue["variant"]
): string => {
    return PLAYBACK_QUALITY_BADGE_TONE_CLASS[variant];
};

interface PlaybackQualityBadgeProps {
    badge: PlaybackQualityBadgeValue;
    size: PlaybackQualityBadgeSize;
    className?: string;
    showTitle?: boolean;
}

export function PlaybackQualityBadge({
    badge,
    size,
    className,
    showTitle = true,
}: PlaybackQualityBadgeProps) {
    return (
        <span
            className={cn(
                PLAYBACK_QUALITY_BADGE_SIZE_CLASS[size],
                getPlaybackQualityBadgeToneClassName(badge.variant),
                className
            )}
            title={showTitle ? badge.label : undefined}
        >
            {badge.label}
        </span>
    );
}
