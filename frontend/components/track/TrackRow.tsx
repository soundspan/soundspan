"use client";

import { AudioLines, Music, Play } from "lucide-react";
import { cn } from "@/utils/cn";
import { formatTime } from "@/utils/formatTime";
import { CachedImage } from "@/components/ui/CachedImage";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { buildPreferenceMetadata } from "@/hooks/useTrackPreference";
import { InQueueBadge } from "./badges";
import type { TrackRowProps } from "./types";

const DEFAULT_ACCENT = "#3b82f6";

/**
 * Renders the TrackRow component.
 *
 * Reusable row for track lists. Provides sensible defaults
 * (track number, cover art, title/artist, duration, preferences, overflow)
 * with composition slots for per-surface customisation.
 *
 * Not wrapped in React.memo because `slots` and `onPlay` are new references
 * each render (created by the parent TrackList's map), so memoization would
 * never prevent a re-render while adding comparison overhead.
 */
export function TrackRow({
    item,
    index,
    isPlaying = false,
    isInQueue = false,
    onPlay,
    className,
    accentColor = DEFAULT_ACCENT,
    showCoverArt = true,
    preferenceMode = "both",
    overflowProps = null,
    slots = {},
}: TrackRowProps) {
    const {
        leadingColumn,
        titleBadges,
        artistContent,
        subtitleExtra,
        middleColumns,
        trailingActions,
        rowClassName,
    } = slots;

    return (
        <div
            data-tv-card
            data-tv-card-index={index}
            onClick={onPlay}
            tabIndex={0}
            onKeyDown={(e) => {
                if (e.key === "Enter" && onPlay) {
                    e.preventDefault();
                    onPlay();
                }
            }}
            className={cn(
                "grid items-center gap-2 px-1 md:gap-4 md:px-4 py-3 rounded-md hover:bg-white/5 transition-colors group cursor-pointer",
                className,
                isPlaying && "bg-white/5",
                isInQueue && !isPlaying && "bg-[#3b82f6]/[0.06]",
                rowClassName,
            )}
        >
            {/* Leading column: track number or custom */}
            {leadingColumn !== undefined ? (
                leadingColumn
            ) : (
                <div className="w-8 flex items-center justify-center">
                    <span
                        className={cn(
                            "text-sm group-hover:hidden",
                            isPlaying ? "font-bold" : "text-gray-500",
                        )}
                        style={isPlaying ? { color: accentColor } : undefined}
                    >
                        {isPlaying ? (
                            <AudioLines
                                className="w-4 h-4"
                                style={{ color: accentColor }}
                            />
                        ) : (
                            index + 1
                        )}
                    </span>
                    <Play className="w-4 h-4 text-white hidden group-hover:block fill-current" />
                </div>
            )}

            {/* Cover art + Title/Artist */}
            <div className="flex items-center gap-3 min-w-0">
                {showCoverArt && (
                    <div className="relative w-10 h-10 bg-[#282828] rounded flex items-center justify-center overflow-hidden shrink-0">
                        {item.coverArtUrl ? (
                            <CachedImage
                                src={item.coverArtUrl}
                                alt={item.displayTitle ?? item.title}
                                fill
                                sizes="40px"
                                className="object-cover"
                            />
                        ) : (
                            <Music className="w-4 h-4 text-gray-600" />
                        )}
                    </div>
                )}
                <div className="min-w-0">
                    <h3
                        className={cn(
                            "text-sm md:text-base font-medium flex items-center gap-2 min-w-0",
                            !isPlaying && "text-white",
                        )}
                        style={isPlaying ? { color: accentColor } : undefined}
                    >
                        <span className="truncate">
                            {item.displayTitle ?? item.title}
                        </span>
                        {titleBadges}
                        {isInQueue && <InQueueBadge />}
                    </h3>
                    {artistContent !== undefined ? (
                        artistContent
                    ) : (
                        <p className="text-xs md:text-sm text-gray-400 truncate">
                            {item.artistName}
                        </p>
                    )}
                    {subtitleExtra}
                </div>
            </div>

            {/* Middle columns (e.g. album, tier, source) */}
            {middleColumns}

            {/* Trailing actions: duration + prefs + overflow, or custom */}
            {trailingActions !== undefined ? (
                trailingActions
            ) : (
                <div className="flex items-center gap-1">
                    <span className="text-xs text-gray-500 w-10 text-right tabular-nums">
                        {formatTime(item.duration)}
                    </span>
                    {preferenceMode && (
                        <TrackPreferenceButtons
                            trackId={item.id}
                            mode={preferenceMode}
                            buttonSizeClassName="h-8 w-8"
                            iconSizeClassName="h-4 w-4"
                            metadata={buildPreferenceMetadata({ id: item.id, title: item.title, artist: item.artistName, duration: item.duration })}
                        />
                    )}
                    {overflowProps && (
                        <TrackOverflowMenu {...overflowProps} />
                    )}
                </div>
            )}
        </div>
    );
}
