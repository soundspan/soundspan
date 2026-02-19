"use client";

import { memo } from "react";
import { Track } from "../types";
import { EmptyState } from "@/components/ui/EmptyState";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { CachedImage } from "@/components/ui/CachedImage";
import Link from "next/link";
import { AudioLines, Trash2, Play } from "lucide-react";
import { cn } from "@/utils/cn";
import { formatTime } from "@/utils/formatTime";
import { api } from "@/lib/api";
import { getArtistHref } from "@/utils/artistRoute";
import { useAudioState } from "@/lib/audio-state-context";
import { useQueuedTrackIds } from "@/hooks/useQueuedTrackIds";
import { TrackOverflowMenu, TrackMenuButton } from "@/components/ui/TrackOverflowMenu";

interface TracksListProps {
    tracks: Track[];
    onPlay: (tracks: Track[], startIndex?: number) => void;
    onDelete: (trackId: string, trackTitle: string) => void;
    canDelete?: boolean;
    isLoading?: boolean;
}


interface TrackRowProps {
    track: Track;
    index: number;
    isCurrentlyPlaying: boolean;
    isInQueue: boolean;
    onPlayTrack: () => void;
    onDelete: (trackId: string, trackTitle: string) => void;
    canDelete: boolean;
}

const TrackRow = memo(
    function TrackRow({
        track,
        index,
        isCurrentlyPlaying,
        isInQueue,
        onPlayTrack,
        onDelete,
        canDelete,
    }: TrackRowProps) {
        const overflowTrack = {
            id: track.id,
            title: track.displayTitle ?? track.title,
            artist: track.album?.artist ? { name: track.album.artist.name, id: track.album.artist.id } : { name: "" },
            album: { title: track.album?.title ?? "", coverArt: track.album?.coverArt, id: track.album?.id },
            duration: track.duration,
        };

        return (
            <div
                key={track.id}
                onClick={onPlayTrack}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
                className={cn(
                    "grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_1fr_auto] items-center gap-3 px-3 py-2 rounded-md hover:bg-white/5 transition-colors group cursor-pointer",
                    isCurrentlyPlaying && "bg-white/5",
                    isInQueue && !isCurrentlyPlaying && "bg-[#3b82f6]/[0.06]"
                )}
            >
                {/* Track number / Play icon */}
                <div className="w-8 flex items-center justify-center">
                    <span
                        className={cn(
                            "text-sm group-hover:hidden",
                            isCurrentlyPlaying ? "text-[#3b82f6]" : (
                                "text-gray-500"
                            ),
                        )}
                    >
                        {isCurrentlyPlaying ?
                            <AudioLines className="w-4 h-4 text-[#3b82f6]" />
                        :   index + 1}
                    </span>
                    <Play className="w-4 h-4 text-white hidden group-hover:block fill-current" />
                </div>

                {/* Cover + Title/Artist */}
                <div className="flex items-center gap-3 min-w-0">
                    <div className="relative w-10 h-10 bg-[#282828] rounded flex items-center justify-center overflow-hidden shrink-0">
                        {track.album?.coverArt ?
                            <CachedImage
                                src={api.getCoverArtUrl(
                                    track.album.coverArt,
                                    80,
                                )}
                                alt={track.title}
                                fill
                                sizes="40px"
                                className="object-cover"
                            />
                        :   <AudioLines className="w-4 h-4 text-gray-600" />}
                    </div>
                    <div className="min-w-0">
                        <h3
                            className={cn(
                                "text-sm font-medium flex items-center gap-2 min-w-0",
                                isCurrentlyPlaying ? "text-[#3b82f6]" : (
                                    "text-white"
                                ),
                            )}
                        >
                            <span className="truncate">
                                {track.displayTitle ?? track.title}
                            </span>
                            {isInQueue && (
                                <span className="shrink-0 text-[10px] bg-[#3b82f6]/15 text-[#93c5fd] px-1.5 py-0.5 rounded border border-[#3b82f6]/30 font-medium">
                                    IN QUEUE
                                </span>
                            )}
                        </h3>
                        <p className="text-xs text-gray-400 truncate">
                            {track.album?.artist ? (() => {
                                const href = getArtistHref({ id: track.album!.artist!.id, name: track.album!.artist!.name });
                                return href ? (
                                    <Link
                                        href={href}
                                        className="hover:underline hover:text-white"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        {track.album!.artist!.name}
                                    </Link>
                                ) : track.album!.artist!.name;
                            })() : null}
                        </p>
                    </div>
                </div>

                {/* Album - hidden on mobile */}
                <div className="hidden md:block min-w-0">
                    <p className="text-sm text-gray-400 truncate">
                        {track.album?.title}
                    </p>
                </div>

                {/* Actions + Duration */}
                <div className="flex items-center gap-1">
                    <span className="text-xs text-gray-500 w-10 text-right">
                        {formatTime(track.duration)}
                    </span>
                    <TrackOverflowMenu
                        track={overflowTrack}
                        extraItemsAfter={canDelete ? (
                            <TrackMenuButton
                                onClick={(e) => {
                                    e.stopPropagation();
                                    onDelete(track.id, track.title);
                                }}
                                icon={<Trash2 className="h-4 w-4" />}
                                label="Delete track"
                                className="text-red-400 hover:text-red-300"
                            />
                        ) : undefined}
                    />
                </div>
            </div>
        );
    },
    (prevProps, nextProps) => {
        return (
            prevProps.track.id === nextProps.track.id &&
            prevProps.isCurrentlyPlaying === nextProps.isCurrentlyPlaying &&
            prevProps.isInQueue === nextProps.isInQueue &&
            prevProps.index === nextProps.index
        );
    },
);

export function TracksList({
    tracks,
    onPlay,
    onDelete,
    canDelete = false,
    isLoading = false,
}: TracksListProps) {
    const { currentTrack } = useAudioState();
    const queuedTrackIds = useQueuedTrackIds();
    const currentTrackId = currentTrack?.id;

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (tracks.length === 0) {
        return (
            <EmptyState
                icon={<AudioLines className="w-12 h-12" />}
                title="No songs yet"
                description="Your library is empty. Sync your music to get started."
            />
        );
    }

    return (
        <>
            {/* Header row */}
            <div className="grid grid-cols-[auto_1fr_auto] md:grid-cols-[auto_1fr_1fr_auto] items-center gap-3 px-3 py-2 border-b border-white/10 text-xs text-gray-500 uppercase tracking-wider">
                <div className="w-8 text-center">#</div>
                <div>Title</div>
                <div className="hidden md:block">Album</div>
                <div className="w-[140px] text-right pr-2">Duration</div>
            </div>

            <div data-tv-section="library-tracks">
                {tracks.map((track, index) => {
                    const isCurrentlyPlaying = currentTrackId === track.id;
                    const isInQueue = queuedTrackIds.has(track.id);
                    return (
                        <TrackRow
                            key={track.id}
                            track={track}
                            index={index}
                            isCurrentlyPlaying={isCurrentlyPlaying}
                            isInQueue={isInQueue}
                            onPlayTrack={() => onPlay(tracks, index)}
                            onDelete={onDelete}
                            canDelete={canDelete}
                        />
                    );
                })}
            </div>
        </>
    );
}
