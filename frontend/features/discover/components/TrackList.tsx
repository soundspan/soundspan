import { Play, Music } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { cn } from "@/utils/cn";
import { DiscoverTrack } from "../types";
import { api } from "@/lib/api";
import { formatTime } from "@/utils/formatTime";
import { useQueuedTrackIds } from "@/hooks/useQueuedTrackIds";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import type { ReactNode } from "react";

const tierColors: Record<string, string> = {
    high: "text-green-400",
    medium: "text-yellow-400",
    explore: "text-orange-400",
    wildcard: "text-[#5b5bff]",
    low: "text-orange-400",
    wild: "text-[#5b5bff]",
};

const tierLabels: Record<string, string> = {
    high: "High Match",
    medium: "Medium Match",
    explore: "Explore",
    wildcard: "Wild Card",
    low: "Explore",
    wild: "Wild Card",
};

interface TrackListProps {
    tracks: DiscoverTrack[];
    isMatching: boolean;
    currentTrack?: { id: string } | null;
    isPlaying: boolean;
    onPlayTrack: (index: number) => void;
    onTogglePlay: () => void;
}

function getSourceBadge(
    track: DiscoverTrack,
    isMatching: boolean,
    extraClassName?: string,
): ReactNode {
    if (track.sourceType === "tidal") {
        return <TidalBadge className={extraClassName} />;
    }

    if (track.sourceType === "youtube") {
        return <YouTubeBadge className={extraClassName} />;
    }

    let label: string;
    let badgeClassName: string;

    if (!track.available) {
        if (isMatching) {
            label = "LOADING";
            badgeClassName = "bg-gray-500/20 text-gray-300 border border-gray-400/30 animate-pulse";
        } else {
            label = "PREVIEW";
            badgeClassName = "bg-blue-500/20 text-blue-400 border border-blue-500/30";
        }
    } else {
        label = "Local";
        badgeClassName = "bg-emerald-500/20 text-emerald-400";
    }

    return (
        <span className={cn("shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded", badgeClassName, extraClassName)}>
            {label}
        </span>
    );
}

export function TrackList({
    tracks,
    isMatching,
    currentTrack,
    isPlaying,
    onPlayTrack,
    onTogglePlay,
}: TrackListProps) {
    const queuedTrackIds = useQueuedTrackIds();

    return (
        <div className="w-full">
            {/* Table Header */}
            <div className="hidden md:grid grid-cols-[40px_minmax(200px,4fr)_minmax(100px,2fr)_80px_90px_80px] gap-4 px-4 py-2 text-xs text-gray-400 uppercase tracking-wider border-b border-white/10 mb-2">
                <span className="text-center">#</span>
                <span>Title</span>
                <span>Album</span>
                <span className="text-center">Match</span>
                <span className="text-center">Source</span>
                <span className="text-right">Duration</span>
            </div>

            {/* Track Rows */}
            <div>
                {tracks.map((track, index) => {
                    const isTrackPlaying = currentTrack?.id === track.id;
                    const isInQueue = queuedTrackIds.has(track.id);
                    const sourceBadge = getSourceBadge(track, isMatching);
                    return (
                        <div
                            key={track.id}
                            onClick={() =>
                                isTrackPlaying && isPlaying
                                    ? onTogglePlay()
                                    : onPlayTrack(index)
                            }
                            className={cn(
                                "grid grid-cols-[28px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,2fr)_80px_90px_80px] gap-2 px-1 md:gap-4 md:px-4 py-2 rounded-md hover:bg-white/5 transition-colors group cursor-pointer",
                                isTrackPlaying && "bg-white/10",
                                isInQueue && !isTrackPlaying && "bg-[#3b82f6]/[0.06]"
                            )}
                        >
                            {/* Track Number / Play Icon */}
                            <div className="flex items-center justify-center">
                                <span
                                    className={cn(
                                        "text-sm group-hover:hidden",
                                        isTrackPlaying
                                            ? "text-[#3b82f6]"
                                            : "text-gray-400"
                                    )}
                                >
                                    {isTrackPlaying && isPlaying ? (
                                        <Music className="w-4 h-4 text-[#3b82f6] animate-pulse" />
                                    ) : (
                                        index + 1
                                    )}
                                </span>
                                <Play className="w-4 h-4 text-white hidden group-hover:block" />
                            </div>

                            {/* Title + Artist */}
                            <div className="flex items-center gap-3 min-w-0">
                                <div className="w-10 h-10 bg-[#282828] rounded shrink-0 overflow-hidden">
                                    {(track.coverUrl || track.albumId) ? (
                                        <Image
                                            src={api.getCoverArtUrl(
                                                track.coverUrl || track.albumId,
                                                80
                                            )}
                                            alt={track.album}
                                            width={40}
                                            height={40}
                                            sizes="40px"
                                            className="object-cover"
                                            unoptimized
                                        />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center">
                                            <Music className="w-5 h-5 text-gray-600" />
                                        </div>
                                    )}
                                </div>
                                <div className="min-w-0">
                                    <p
                                        className={cn(
                                            "text-sm font-medium flex items-center gap-2 min-w-0",
                                            isTrackPlaying
                                                ? "text-[#3b82f6]"
                                                : "text-white"
                                        )}
                                    >
                                        <span className="truncate">
                                            {track.title}
                                        </span>
                                        {isInQueue && (
                                            <span className="shrink-0 text-[10px] bg-[#3b82f6]/15 text-[#93c5fd] px-1.5 py-0.5 rounded border border-[#3b82f6]/30 font-medium">
                                                IN QUEUE
                                            </span>
                                        )}
                                    </p>
                                    <p className="text-xs text-gray-400 truncate">
                                        <Link
                                            href={`/artist/${encodeURIComponent(track.artist)}`}
                                            className="hover:underline hover:text-white"
                                            onClick={(e) => e.stopPropagation()}
                                        >
                                            {track.artist}
                                        </Link>
                                    </p>
                                    <div className="md:hidden mt-1">
                                        {sourceBadge}
                                    </div>
                                </div>
                            </div>

                            {/* Album (hidden on mobile) */}
                            <p className="hidden md:flex items-center text-sm text-gray-400 truncate">
                                {track.album}
                            </p>

                            {/* Tier Badge (hidden on mobile) */}
                            <div className="hidden md:flex items-center justify-center">
                                <span
                                    className={cn(
                                        "px-2 py-0.5 rounded-full text-xs font-medium bg-white/5",
                                        tierColors[track.tier]
                                    )}
                                >
                                    {tierLabels[track.tier]?.split(" ")[0]}
                                </span>
                            </div>

                            <div className="hidden md:flex items-center justify-center">
                                {sourceBadge}
                            </div>

                            <div className="flex items-center justify-end gap-1">
                                <span className="hidden sm:inline text-xs text-gray-500 w-10 text-right tabular-nums">
                                    {formatTime(track.duration)}
                                </span>
                                <TrackPreferenceButtons
                                    trackId={track.id}
                                    mode="up-only"
                                    buttonSizeClassName="h-8 w-8"
                                    iconSizeClassName="h-4 w-4"
                                />
                                <TrackOverflowMenu
                                    track={{
                                        id: track.id,
                                        title: track.title,
                                        artist: { name: track.artist, id: track.artistId ?? undefined },
                                        album: { title: track.album, id: track.albumId, coverArt: track.coverUrl ?? track.albumId ?? undefined },
                                        duration: track.duration,
                                        streamSource: track.streamSource,
                                    }}
                                    showGoToAlbum={!!track.albumId}
                                />
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
