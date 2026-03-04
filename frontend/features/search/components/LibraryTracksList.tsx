"use client";

import { useCallback } from "react";
import { Play, Pause } from "lucide-react";
import Link from "next/link";
import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { api } from "@/lib/api";
import { formatTime } from "@/utils/formatTime";
import { getArtistHref } from "@/utils/artistRoute";
import { TrackList } from "@/components/track";
import type { TrackRowItem, TrackRowSlots, RowState } from "@/components/track";
import type { LibraryTrack } from "../types";

interface LibraryTracksListProps {
    tracks: LibraryTrack[];
    limit?: number | null;
}

function toRowItem(track: LibraryTrack): TrackRowItem {
    return {
        id: track.id,
        title: track.title,
        displayTitle: track.displayTitle,
        artistName: track.album.artist.name,
        duration: track.duration,
        coverArtUrl: track.album.coverUrl ? api.getCoverArtUrl(track.album.coverUrl, 48) : null,
    };
}

/**
 * Renders the LibraryTracksList component.
 */
export function LibraryTracksList({ tracks, limit = 10 }: LibraryTracksListProps) {
    const { currentTrack } = useAudioState();
    const { isPlaying } = useAudioPlayback();
    const { playTracks, pause, resume } = useAudioControls();
    const allTracks = tracks ?? [];
    const visibleTracks =
        typeof limit === "number" ? allTracks.slice(0, limit) : allTracks;

    const handlePlay = useCallback(
        (track: LibraryTrack, index: number) => {
            if (currentTrack?.id === track.id) {
                if (isPlaying) {
                    pause();
                } else {
                    resume();
                }
            } else {
                const formattedTracks = allTracks.map((t) => ({
                    id: t.id,
                    title: t.title,
                    displayTitle: t.displayTitle,
                    duration: t.duration,
                    artist: { id: t.album.artist.id, name: t.album.artist.name },
                    album: { id: t.album.id, title: t.album.title, coverArt: t.album.coverUrl },
                }));
                playTracks(formattedTracks, index);
            }
        },
        [allTracks, currentTrack?.id, isPlaying, playTracks, pause, resume],
    );

    const rowSlots = useCallback(
        (track: LibraryTrack, index: number, state: RowState): TrackRowSlots => {
            const isCurrentTrack = currentTrack?.id === track.id;
            const isPlayingThis = isCurrentTrack && isPlaying;
            const artistHref = getArtistHref({
                id: track.album.artist.id,
                mbid: track.album.artist.mbid,
                name: track.album.artist.name,
            }) || "/artist";

            return {
                leadingColumn: (
                    <div className="w-8 h-8 flex items-center justify-center flex-shrink-0">
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
                    </div>
                ),
                artistContent: (
                    <p className="text-xs text-gray-400 truncate">
                        <Link
                            href={artistHref}
                            className="hover:underline hover:text-white"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {track.album.artist.name}
                        </Link>
                        <span className="mx-1">&bull;</span>
                        <Link
                            href={`/album/${track.album.id}`}
                            className="hover:underline hover:text-white"
                            onClick={(e) => e.stopPropagation()}
                        >
                            {track.album.title}
                        </Link>
                    </p>
                ),
                trailingActions: (
                    <span className="text-sm text-gray-400 flex-shrink-0">
                        {formatTime(track.duration)}
                    </span>
                ),
            };
        },
        [currentTrack?.id, isPlaying],
    );

    if (allTracks.length === 0) {
        return null;
    }

    return (
        <TrackList
            items={visibleTracks}
            toRowItem={toRowItem}
            onPlay={handlePlay}
            rowSlots={rowSlots}
            rowClassName="grid-cols-[auto_1fr_auto]"
            className="space-y-1"
            preferenceMode={null}
        />
    );
}
