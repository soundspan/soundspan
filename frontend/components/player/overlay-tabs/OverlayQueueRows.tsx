"use client";

import { memo } from "react";
import Image from "next/image";
import { Music as MusicIcon, X } from "lucide-react";
import { cn } from "@/utils/cn";
import { formatTime } from "@/utils/formatTime";
import { api } from "@/lib/api";
import { resolvePlaybackQualityBadgeFromStreamSource } from "@/hooks/useStreamBitrate";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { buildPreferenceMetadata } from "@/hooks/useTrackPreference";
import {
    TrackOverflowMenu,
    TrackMenuButton,
} from "@/components/ui/TrackOverflowMenu";
import type { EpisodeQueueItem, TrackQueueItem } from "@/lib/queue-item";

interface QueueRowSharedProps {
    queueIndex: number;
    isCurrentTrack: boolean;
    isPlayedTrack: boolean;
    onPlayFromQueue: (index: number) => void;
    onRemoveFromQueue: (index: number) => void;
}

function queueRowClassName(isCurrentTrack: boolean, isPlayedTrack: boolean) {
    return cn(
        "mb-1.5 flex items-center gap-2 px-2 py-2 transition-colors",
        isCurrentTrack
            ? "rounded-md border border-brand-hover/35 bg-brand-hover/10"
            : isPlayedTrack
              ? "rounded-md bg-white/[0.03] hover:bg-white/[0.06]"
              : "hover:bg-white/[0.06]",
    );
}

function QueuePositionNumber({
    queueIndex,
    isCurrentTrack,
}: {
    queueIndex: number;
    isCurrentTrack: boolean;
}) {
    return (
        <span
            className={cn(
                "w-5 flex-shrink-0 text-center text-[11px] tabular-nums",
                isCurrentTrack ? "text-brand-hover" : "text-gray-400",
            )}
        >
            {queueIndex + 1}
        </span>
    );
}

function QueueRowDuration({
    duration,
    isCurrentTrack,
}: {
    duration: number;
    isCurrentTrack: boolean;
}) {
    return (
        <span
            className={cn(
                "text-[11px] tabular-nums",
                isCurrentTrack ? "text-brand-hover" : "text-gray-400",
            )}
        >
            {formatTime(duration)}
        </span>
    );
}

function QueueRemoveButton({
    queueIndex,
    onRemoveFromQueue,
    className,
}: {
    queueIndex: number;
    onRemoveFromQueue: (index: number) => void;
    className?: string;
}) {
    return (
        <button
            onClick={(e) => {
                e.stopPropagation();
                onRemoveFromQueue(queueIndex);
            }}
            className={cn(
                "h-7 w-7 flex items-center justify-center rounded-full text-gray-400 hover:bg-white/10 hover:text-white transition-colors",
                className,
            )}
            title="Remove from queue"
            aria-label="Remove from queue"
        >
            <X className="h-3.5 w-3.5" />
        </button>
    );
}

function PlayedPill() {
    return (
        <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-gray-400">
            Played
        </span>
    );
}

export const OverlayQueueEpisodeRow = memo(function OverlayQueueEpisodeRow({
    item,
    queueIndex,
    isCurrentTrack,
    isPlayedTrack,
    onPlayFromQueue,
    onRemoveFromQueue,
}: QueueRowSharedProps & { item: EpisodeQueueItem }) {
    return (
        <div
            data-queue-index={queueIndex}
            className={queueRowClassName(isCurrentTrack, isPlayedTrack)}
        >
            <QueuePositionNumber
                queueIndex={queueIndex}
                isCurrentTrack={isCurrentTrack}
            />
            <button
                onClick={() => {
                    if (!isCurrentTrack) onPlayFromQueue(queueIndex);
                }}
                className={cn(
                    "flex min-w-0 flex-1 items-center gap-3 text-left",
                    isCurrentTrack && "cursor-default",
                )}
                title={isCurrentTrack ? "Now playing" : "Play this episode now"}
            >
                <div className="relative h-11 w-11 flex-shrink-0 overflow-hidden rounded bg-surface-hover">
                    {item.coverUrl ? (
                        <Image
                            src={item.coverUrl}
                            alt={item.podcastTitle}
                            fill
                            sizes="44px"
                            className="object-cover"
                            unoptimized
                        />
                    ) : (
                        <div className="flex h-full w-full items-center justify-center">
                            <MusicIcon className="h-4 w-4 text-gray-400" />
                        </div>
                    )}
                </div>
                <div className="min-w-0">
                    <p
                        className={cn(
                            "min-w-0 truncate text-sm",
                            isCurrentTrack ? "text-brand-hover" : "text-white",
                        )}
                    >
                        {item.title}
                    </p>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                        <p className="min-w-0 truncate text-xs text-gray-400">
                            {item.podcastTitle || "Podcast"}
                        </p>
                        {isCurrentTrack && (
                            <span className="inline-flex shrink-0 items-center rounded-full border border-brand-hover/40 bg-brand-hover/12 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-hover">
                                Playing
                            </span>
                        )}
                        {isPlayedTrack && !isCurrentTrack && <PlayedPill />}
                    </div>
                </div>
            </button>
            <QueueRowDuration
                duration={item.duration || 0}
                isCurrentTrack={isCurrentTrack}
            />
            {!isCurrentTrack && (
                <QueueRemoveButton
                    queueIndex={queueIndex}
                    onRemoveFromQueue={onRemoveFromQueue}
                    className="ml-1"
                />
            )}
        </div>
    );
});

export const OverlayQueueTrackRow = memo(function OverlayQueueTrackRow({
    track,
    queueIndex,
    isCurrentTrack,
    isPlayedTrack,
    onPlayFromQueue,
    onRemoveFromQueue,
}: QueueRowSharedProps & { track: TrackQueueItem }) {
    const qualityBadge = resolvePlaybackQualityBadgeFromStreamSource(
        track.streamSource,
    );
    return (
        <div
            data-queue-index={queueIndex}
            className={queueRowClassName(isCurrentTrack, isPlayedTrack)}
        >
            <QueuePositionNumber
                queueIndex={queueIndex}
                isCurrentTrack={isCurrentTrack}
            />
            <button
                onClick={() => {
                    if (!isCurrentTrack) onPlayFromQueue(queueIndex);
                }}
                className={cn(
                    "flex min-w-0 flex-1 items-center gap-3 text-left",
                    isCurrentTrack && "cursor-default",
                )}
                title={isCurrentTrack ? "Now playing" : "Play this track now"}
            >
                <div className="relative h-11 w-11 flex-shrink-0 overflow-hidden rounded bg-surface-hover">
                    {track.album?.coverArt ? (
                        <Image
                            src={api.getCoverArtUrl(track.album.coverArt, 100)}
                            alt={track.album.title}
                            fill
                            sizes="44px"
                            className="object-cover"
                            unoptimized
                        />
                    ) : (
                        <div className="flex h-full w-full items-center justify-center">
                            <MusicIcon className="h-4 w-4 text-gray-400" />
                        </div>
                    )}
                </div>
                <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-1.5">
                        <p
                            className={cn(
                                "min-w-0 truncate text-sm",
                                isCurrentTrack
                                    ? "text-brand-hover"
                                    : "text-white",
                            )}
                        >
                            {track.displayTitle ?? track.title}
                        </p>
                        {qualityBadge?.variant === "tidal" && <TidalBadge />}
                        {qualityBadge?.variant === "youtube" && (
                            <YouTubeBadge />
                        )}
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                        <p className="min-w-0 truncate text-xs text-gray-400">
                            {track.artist?.name || "Unknown artist"}
                        </p>
                        {isCurrentTrack && (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-brand-hover/40 bg-brand-hover/12 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-hover">
                                <span className="inline-flex items-end gap-0.5">
                                    <span className="h-2 w-0.5 animate-bounce rounded-full bg-brand-hover [animation-delay:-0.2s]" />
                                    <span className="h-2.5 w-0.5 animate-bounce rounded-full bg-brand-hover" />
                                    <span className="h-1.5 w-0.5 animate-bounce rounded-full bg-brand-hover [animation-delay:-0.35s]" />
                                </span>
                                Playing
                            </span>
                        )}
                        {isPlayedTrack && !isCurrentTrack && <PlayedPill />}
                    </div>
                </div>
            </button>
            <QueueRowDuration
                duration={track.duration || 0}
                isCurrentTrack={isCurrentTrack}
            />
            <div className="ml-1 flex items-center gap-1">
                <TrackPreferenceButtons
                    trackId={track.id}
                    mode="up-only"
                    buttonSizeClassName="h-10 w-10"
                    iconSizeClassName="h-5 w-5"
                    metadata={buildPreferenceMetadata(track)}
                />
                <TrackOverflowMenu
                    track={track}
                    showPlayNext={false}
                    showAddToQueue={false}
                    triggerClassName="!opacity-100"
                    extraItemsAfter={
                        !isCurrentTrack ? (
                            <TrackMenuButton
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onRemoveFromQueue(queueIndex);
                                }}
                                icon={<X className="h-4 w-4" />}
                                label="Remove from queue"
                                className="text-red-400 hover:text-red-300"
                            />
                        ) : undefined
                    }
                />
                {!isCurrentTrack && (
                    <QueueRemoveButton
                        queueIndex={queueIndex}
                        onRemoveFromQueue={onRemoveFromQueue}
                    />
                )}
            </div>
        </div>
    );
});
