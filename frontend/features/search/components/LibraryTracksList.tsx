"use client";

import { Play, Pause } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";
import { formatTime } from "@/utils/formatTime";
import { useQueuedTrackIds } from "@/hooks/useQueuedTrackIds";
import { getArtistHref } from "@/utils/artistRoute";
import type { LibraryTrack } from "../types";

interface LibraryTracksListProps {
    tracks: LibraryTrack[];
    limit?: number | null;
}

export function LibraryTracksList({ tracks, limit = 10 }: LibraryTracksListProps) {
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { playTracks, pause, resume } = useAudioControls();
    const queuedTrackIds = useQueuedTrackIds();

    if (!tracks || tracks.length === 0) {
        return null;
    }

    const visibleTracks =
        typeof limit === "number" ? tracks.slice(0, limit) : tracks;

    const handlePlayTrack = (track: LibraryTrack, index: number) => {
        // Format tracks for playback
        const formattedTracks = tracks.map((t) => ({
            id: t.id,
            title: t.title,
            displayTitle: t.displayTitle,
            duration: t.duration,
            artist: {
                id: t.album.artist.id,
                name: t.album.artist.name,
            },
            album: {
                id: t.album.id,
                title: t.album.title,
                coverArt: t.album.coverUrl,
            },
        }));

        if (currentTrack?.id === track.id) {
            // Toggle play/pause if clicking the same track
            if (isPlaying) {
                pause();
            } else {
                resume();
            }
        } else {
            // Play from this track
            playTracks(formattedTracks, index);
        }
    };

    return (
        <div className="space-y-1">
            {visibleTracks.map((track, index) => {
                const isCurrentTrack = currentTrack?.id === track.id;
                const isPlayingThis = isCurrentTrack && isPlaying;
                const isInQueue = queuedTrackIds.has(track.id);
                const coverUrl = track.album.coverUrl
                    ? api.getCoverArtUrl(track.album.coverUrl, 48)
                    : null;
                const artistHref =
                    getArtistHref({
                        id: track.album.artist.id,
                        mbid: track.album.artist.mbid,
                        name: track.album.artist.name,
                    }) || "/artist";

                return (
                    <div
                        key={track.id}
                        className={cn(
                            "flex items-center gap-3 p-2 rounded-md group transition-colors",
                            isCurrentTrack ?
                                "bg-white/10"
                            : isInQueue ?
                                "bg-[#3b82f6]/[0.06]"
                            :   "hover:bg-white/5"
                        )}
                    >
                        {/* Play Button / Track Number */}
                        <button
                            onClick={() => handlePlayTrack(track, index)}
                            className="w-8 h-8 flex items-center justify-center flex-shrink-0"
                        >
                            {isPlayingThis ? (
                                <Pause className="w-4 h-4 text-[#3b82f6]" />
                            ) : isCurrentTrack ? (
                                <Play className="w-4 h-4 text-[#3b82f6] ml-0.5" />
                            ) : (
                                <>
                                    <span className="text-sm text-gray-400 group-hover:hidden">
                                        {index + 1}
                                    </span>
                                    <Play className="w-4 h-4 text-white hidden group-hover:block ml-0.5" />
                                </>
                            )}
                        </button>

                        {/* Cover Art */}
                        <div className="w-10 h-10 bg-[#282828] rounded overflow-hidden flex-shrink-0">
                            {coverUrl ? (
                                <Image
                                    src={coverUrl}
                                    alt={track.album.title}
                                    width={40}
                                    height={40}
                                    sizes="40px"
                                    className="object-cover w-full h-full"
                                    unoptimized
                                />
                            ) : (
                                <div className="w-full h-full flex items-center justify-center">
                                    <span className="text-gray-500 text-xs">
                                        ♪
                                    </span>
                                </div>
                            )}
                        </div>

                        {/* Track Info */}
                        <div className="flex-1 min-w-0">
                            <p
                                className={cn(
                                    "text-sm font-medium flex items-center gap-2 min-w-0",
                                    isCurrentTrack
                                        ? "text-[#3b82f6]"
                                        : "text-white"
                                )}
                            >
                                <span className="truncate">{track.title}</span>
                                {isInQueue && (
                                    <span className="shrink-0 text-[10px] bg-[#3b82f6]/15 text-[#93c5fd] px-1.5 py-0.5 rounded border border-[#3b82f6]/30 font-medium">
                                        IN QUEUE
                                    </span>
                                )}
                            </p>
                            <p className="text-xs text-gray-400 truncate">
                                <Link
                                    href={artistHref}
                                    className="hover:underline hover:text-white"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {track.album.artist.name}
                                </Link>
                                <span className="mx-1">•</span>
                                <Link
                                    href={`/album/${track.album.id}`}
                                    className="hover:underline hover:text-white"
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {track.album.title}
                                </Link>
                            </p>
                        </div>

                        {/* Duration */}
                        <span className="text-sm text-gray-400 flex-shrink-0">
                            {formatTime(track.duration)}
                        </span>
                    </div>
                );
            })}
        </div>
    );
}
