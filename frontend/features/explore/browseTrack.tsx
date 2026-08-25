"use client";

import { useCallback } from "react";
import { api } from "@/lib/api";
import type { Track } from "@/lib/audio-state-context";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { TrackList, TrackListHeader } from "@/components/track";
import type {
    TrackRowItem,
    TrackRowSlots,
    OverflowConfig,
} from "@/components/track";

// -- Types -------------------------------------------------------------------

/** One track of a TIDAL browse collection (playlist or mix). */
export interface TidalBrowseTrack {
    trackId: number;
    title: string;
    artist: string;
    artists: string[];
    album: string;
    duration: number;
    isrc: string | null;
    thumbnailUrl: string | null;
}

/** A browsable TIDAL collection (playlist or mix) with its tracks. */
export interface TidalBrowseCollection {
    id: string;
    title: string;
    trackCount: number;
    thumbnailUrl: string | null;
    tracks: TidalBrowseTrack[];
}

// -- Mappers -----------------------------------------------------------------

/** Map a browse track to the queue's Track shape. */
export function browseTrackToQueueTrack(t: TidalBrowseTrack): Track {
    return {
        id: `tidal:${t.trackId}`,
        title: t.title,
        artist: { name: t.artist },
        album: { title: t.album, coverArt: t.thumbnailUrl || undefined },
        duration: t.duration,
        streamSource: "tidal",
        tidalTrackId: t.trackId,
    };
}

/** Map a browse track to a TrackList row item. */
export function browseToRowItem(track: TidalBrowseTrack): TrackRowItem {
    return {
        id: `tidal:${track.trackId}`,
        title: track.title,
        artistName: track.artist,
        duration: track.duration,
        coverArtUrl: track.thumbnailUrl
            ? api.getTidalBrowseImageUrl(track.thumbnailUrl)
            : null,
    };
}

// -- List --------------------------------------------------------------------

/** Track listing for a TIDAL browse collection page. */
export function BrowseTrackList({
    tracks,
    onPlayTrack,
}: {
    tracks: TidalBrowseTrack[];
    onPlayTrack: (index: number) => void;
}) {
    const handlePlay = useCallback(
        (_track: TidalBrowseTrack, index: number) => {
            if (tracks[index]?.trackId) {
                onPlayTrack(index);
            }
        },
        [tracks, onPlayTrack],
    );

    const rowSlots = useCallback(
        (track: TidalBrowseTrack): TrackRowSlots => ({
            titleBadges: <TidalBadge />,
            middleColumns: (
                <p className="hidden md:flex items-center text-sm text-gray-400 truncate">
                    {track.album}
                </p>
            ),
            rowClassName: !track.trackId
                ? "opacity-60 cursor-not-allowed"
                : undefined,
        }),
        [],
    );

    const rowOverflow = useCallback(
        (track: TidalBrowseTrack): OverflowConfig | null => {
            if (!track.trackId) return null;
            return {
                track: browseTrackToQueueTrack(track),
                showGoToArtist: false,
                showGoToAlbum: false,
                showMatchVibe: false,
                showStartRadio: false,
            };
        },
        [],
    );

    return (
        <div className="w-full">
            <TrackList
                items={tracks}
                toRowItem={browseToRowItem}
                onPlay={handlePlay}
                rowSlots={rowSlots}
                rowOverflow={rowOverflow}
                rowClassName="grid-cols-[28px_1fr_auto] md:grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto]"
                accentColor="#00BFFF"
                preferenceMode="up-only"
                header={
                    <TrackListHeader
                        className="grid-cols-[40px_minmax(200px,2fr)_minmax(100px,1fr)_auto] gap-4 mb-2"
                        columns={[
                            { label: "#", className: "text-center" },
                            { label: "Title" },
                            { label: "Album" },
                            { label: "" },
                        ]}
                    />
                }
            />
        </div>
    );
}
