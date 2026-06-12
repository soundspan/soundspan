"use client";

import { useCallback } from "react";
import { Track } from "../types";
import { EmptyState } from "@/components/ui/EmptyState";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import Link from "next/link";
import { AudioLines, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { getArtistHref } from "@/utils/artistRoute";
import { TrackMenuButton } from "@/components/ui/TrackOverflowMenu";
import { TrackList, TrackListHeader } from "@/components/track";
import type { TrackRowItem, OverflowConfig, TrackRowSlots } from "@/components/track";

interface TracksListProps {
    tracks: Track[];
    onPlay: (tracks: Track[], startIndex?: number) => void;
    onDelete: (trackId: string, trackTitle: string) => void;
    canDelete?: boolean;
    isLoading?: boolean;
}

function toRowItem(track: Track): TrackRowItem {
    return {
        id: track.id,
        title: track.title,
        displayTitle: track.displayTitle,
        artistName: track.album?.artist?.name ?? "",
        duration: track.duration,
        coverArtUrl: track.album?.coverArt ? api.getCoverArtUrl(track.album.coverArt, 80) : null,
    };
}

/**
 * Renders the TracksList component.
 */
export function TracksList({
    tracks,
    onPlay,
    onDelete,
    canDelete = false,
    isLoading = false,
}: TracksListProps) {
    const handlePlay = useCallback(
        (_item: Track, index: number) => onPlay(tracks, index),
        [tracks, onPlay],
    );

    const rowSlots = useCallback(
        (track: Track): TrackRowSlots => ({
            artistContent: track.album?.artist ? (() => {
                const href = getArtistHref({ id: track.album!.artist!.id, name: track.album!.artist!.name });
                return (
                    <p className="text-xs text-gray-400 truncate">
                        {href ? (
                            <Link
                                href={href}
                                className="hover:underline hover:text-white"
                                onClick={(e) => e.stopPropagation()}
                            >
                                {track.album!.artist!.name}
                            </Link>
                        ) : track.album!.artist!.name}
                    </p>
                );
            })() : undefined,
            middleColumns: (
                <div className="hidden md:block min-w-0">
                    <p className="text-sm text-gray-400 truncate">
                        {track.album?.title}
                    </p>
                </div>
            ),
        }),
        [],
    );

    const rowOverflow = useCallback(
        (track: Track): OverflowConfig => ({
            track: {
                id: track.id,
                title: track.displayTitle ?? track.title,
                artist: track.album?.artist ? { name: track.album.artist.name, id: track.album.artist.id } : { name: "" },
                album: { title: track.album?.title ?? "", coverArt: track.album?.coverArt, id: track.album?.id },
                duration: track.duration,
            },
            extraItemsAfter: canDelete ? (
                <TrackMenuButton
                    onClick={(e) => {
                        e.stopPropagation();
                        onDelete(track.id, track.title);
                    }}
                    icon={<Trash2 className="h-4 w-4" />}
                    label="Delete track"
                    className="text-red-400 hover:text-red-300"
                />
            ) : undefined,
        }),
        [canDelete, onDelete],
    );

    return (
        <TrackList
            items={tracks}
            toRowItem={toRowItem}
            onPlay={handlePlay}
            rowSlots={rowSlots}
            rowOverflow={rowOverflow}
            rowClassName="grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_1fr_auto]"
            tvSection="library-tracks"
            preferenceMode="both"
            isLoading={isLoading}
            loadingState={
                <div className="flex items-center justify-center min-h-[400px]">
                    <GradientSpinner size="md" />
                </div>
            }
            emptyState={
                <EmptyState
                    icon={<AudioLines className="w-12 h-12" />}
                    title="No songs yet"
                    description="Your library is empty. Sync your music to get started."
                />
            }
            header={
                <TrackListHeader
                    className="grid-cols-[auto_1fr_1fr_auto] gap-3"
                    columns={[
                        { label: "#", className: "w-8 text-center" },
                        { label: "Title" },
                        { label: "Album" },
                        { label: "", className: "w-[230px]" },
                    ]}
                />
            }
        />
    );
}
