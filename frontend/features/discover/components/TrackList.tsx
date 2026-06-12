import { useCallback } from "react";
import Link from "next/link";
import { cn } from "@/utils/cn";
import { DiscoverTrack } from "../types";
import { api } from "@/lib/api";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { TrackList as SharedTrackList, TrackListHeader } from "@/components/track";
import type { TrackRowItem, TrackRowSlots, OverflowConfig, RowState } from "@/components/track";
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

function toRowItem(track: DiscoverTrack): TrackRowItem {
    return {
        id: track.id,
        title: track.title,
        artistName: track.artist,
        duration: track.duration,
        coverArtUrl: (track.coverUrl || track.albumId)
            ? api.getCoverArtUrl(track.coverUrl || track.albumId, 80)
            : null,
    };
}

/**
 * Renders the TrackList component.
 */
export function TrackList({
    tracks,
    isMatching,
    currentTrack,
    isPlaying,
    onPlayTrack,
    onTogglePlay,
}: TrackListProps) {
    const handlePlay = useCallback(
        (_track: DiscoverTrack, index: number) => {
            const track = tracks[index];
            const isTrackPlaying = currentTrack?.id === track.id;
            if (isTrackPlaying && isPlaying) {
                onTogglePlay();
            } else {
                onPlayTrack(index);
            }
        },
        [tracks, currentTrack?.id, isPlaying, onPlayTrack, onTogglePlay],
    );

    const rowSlots = useCallback(
        (track: DiscoverTrack, _index: number, _state: RowState): TrackRowSlots => {
            const sourceBadge = getSourceBadge(track, isMatching);
            return {
                artistContent: (
                    <p className="text-xs text-gray-400 truncate">
                        <Link
                            href={`/artist/${encodeURIComponent(track.artist)}`}
                            className="hover:underline hover:text-white"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {track.artist}
                        </Link>
                    </p>
                ),
                subtitleExtra: (
                    <div className="md:hidden mt-1">
                        {sourceBadge}
                    </div>
                ),
                middleColumns: (
                    <>
                        <p className="hidden md:flex items-center text-sm text-gray-400 truncate">
                            {track.album}
                        </p>
                        <div className="hidden md:flex items-center justify-center">
                            <span
                                className={cn(
                                    "px-2 py-0.5 rounded-full text-xs font-medium bg-white/5",
                                    tierColors[track.tier],
                                )}
                            >
                                {tierLabels[track.tier]?.split(" ")[0]}
                            </span>
                        </div>
                        <div className="hidden md:flex items-center justify-center">
                            {sourceBadge}
                        </div>
                    </>
                ),
            };
        },
        [isMatching],
    );

    const rowOverflow = useCallback(
        (track: DiscoverTrack): OverflowConfig => ({
            track: {
                id: track.id,
                title: track.title,
                artist: { name: track.artist, id: track.artistId ?? undefined },
                album: { title: track.album, id: track.albumId, coverArt: track.coverUrl ?? track.albumId ?? undefined },
                duration: track.duration,
                streamSource: track.streamSource,
            },
            showGoToAlbum: !!track.albumId,
        }),
        [],
    );

    return (
        <div className="w-full">
            <SharedTrackList
                items={tracks}
                toRowItem={toRowItem}
                onPlay={handlePlay}
                rowSlots={rowSlots}
                rowOverflow={rowOverflow}
                rowClassName="grid-cols-[28px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,2fr)_80px_90px_80px]"
                preferenceMode="up-only"
                header={
                    <TrackListHeader
                        className="grid-cols-[40px_minmax(200px,4fr)_minmax(100px,2fr)_80px_90px_80px] gap-4 mb-2"
                        columns={[
                            { label: "#", className: "text-center" },
                            { label: "Title" },
                            { label: "Album" },
                            { label: "Match", className: "text-center" },
                            { label: "Source", className: "text-center" },
                            { label: "" },
                        ]}
                    />
                }
            />
        </div>
    );
}
