import React, { useCallback, useState } from "react";
import { Play, Plus, ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { Track, Artist } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { formatTime } from "@/utils/formatTime";
import { formatNumber } from "@/utils/formatNumber";
import { TidalBadge } from "@/components/ui/TidalBadge";
import { YouTubeBadge } from "@/components/ui/YouTubeBadge";
import { TrackList, LoadingBadge } from "@/components/track";
import type { TrackRowItem, TrackRowSlots, RowState } from "@/components/track";
import { TrackOverflowMenu } from "@/components/ui/TrackOverflowMenu";
import { TrackPreferenceButtons } from "@/components/player/TrackPreferenceButtons";
import { buildPreferenceMetadata } from "@/hooks/useTrackPreference";

/** Default number of popular tracks shown in collapsed state. */
export const POPULAR_COLLAPSED_COUNT = 5;

interface PopularTracksProps {
    tracks: Track[];
    artist: Artist;
    currentTrackId: string | undefined;
    colors: ColorPalette | null;
    onPlayTrack: (track: Track) => void;
    isProviderMatching?: boolean;
    popularHref?: string;
    onAddAllToQueue?: (visibleTracks: Track[]) => void;
}

function toRowItem(track: Track): TrackRowItem {
    return {
        id: track.id,
        title: track.title,
        displayTitle: track.displayTitle,
        artistName: track.artist?.name ?? "",
        duration: track.duration,
        coverArtUrl: track.album?.coverArt ? api.getCoverArtUrl(track.album.coverArt, 80) : null,
    };
}

export const PopularTracks: React.FC<PopularTracksProps> = ({
    tracks,
    artist,
    currentTrackId: _currentTrackId,
    colors: _colors,
    onPlayTrack,
    isProviderMatching = false,
    popularHref,
    onAddAllToQueue,
}) => {
    const [expanded, setExpanded] = useState(false);
    const canExpand = tracks.length > POPULAR_COLLAPSED_COUNT;
    const visibleTracks = expanded ? tracks : tracks.slice(0, POPULAR_COLLAPSED_COUNT);

    const handlePlay = useCallback(
        (track: Track) => {
            const isYtMusic = track.streamSource === "youtube" && !!track.youtubeVideoId;
            const isTidalTrack = track.streamSource === "tidal" && !!track.tidalTrackId;
            const hasLocalFile = typeof track.filePath === "string" && track.filePath.trim().length > 0;
            const isPlayable = hasLocalFile || isTidalTrack || isYtMusic;

            if (!isPlayable) return;
            onPlayTrack(track);
        },
        [onPlayTrack],
    );

    const rowSlots = useCallback(
        (track: Track, _index: number, _state: RowState): TrackRowSlots => {
            const isYtMusic = track.streamSource === "youtube" && !!track.youtubeVideoId;
            const isTidalTrack = track.streamSource === "tidal" && !!track.tidalTrackId;
            const hasLocalFile = typeof track.filePath === "string" && track.filePath.trim().length > 0;
            const isPlayable = hasLocalFile || isTidalTrack || isYtMusic;
            const isUnowned = !track.album?.id || !track.album?.title || track.album.title === "Unknown Album";
            const isAwaitingProviderMatch = isProviderMatching && isUnowned && !hasLocalFile && !isTidalTrack && !isYtMusic;

            return {
                titleBadges: (
                    <>
                        {isTidalTrack && <TidalBadge />}
                        {isYtMusic && <YouTubeBadge />}
                        {isAwaitingProviderMatch && <LoadingBadge />}
                    </>
                ),
                middleColumns: (
                    <div className="hidden md:flex items-center text-sm text-gray-400">
                        {track.playCount !== undefined && track.playCount > 0 && (
                            <span className="flex items-center gap-1">
                                <Play className="w-3 h-3" />
                                {formatNumber(track.playCount)}
                            </span>
                        )}
                    </div>
                ),
                trailingActions: (
                    <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                        {track.duration > 0 && (
                            <span className="text-xs text-gray-500 w-10 text-right tabular-nums">
                                {formatTime(track.duration)}
                            </span>
                        )}
                        <TrackPreferenceButtons
                            trackId={track.id}
                            mode="both"
                            buttonSizeClassName="h-8 w-8"
                            iconSizeClassName="h-4 w-4"
                            metadata={buildPreferenceMetadata(track)}
                        />
                        {isPlayable && (
                            <TrackOverflowMenu
                                track={{
                                    id: track.id,
                                    title: track.displayTitle ?? track.title,
                                    artist: { name: track.artist?.name ?? artist.name, id: track.artist?.id ?? artist.id },
                                    album: track.album ? { title: track.album.title ?? "", id: track.album.id, coverArt: track.album.coverArt } : { title: "" },
                                    duration: track.duration,
                                    streamSource: track.streamSource === "tidal" || track.streamSource === "youtube" ? track.streamSource : undefined,
                                }}
                            />
                        )}
                    </div>
                ),
                rowClassName: !isPlayable && !isAwaitingProviderMatch ? "opacity-50" : undefined,
            };
        },
        [artist, isProviderMatching],
    );

    return (
        <section id="popular" className="scroll-mt-28">
            <div className="mb-4 flex items-center gap-2">
                <h2 className="text-xl font-bold">
                    {popularHref ? (
                        <Link
                            href={popularHref}
                            className="inline-flex items-center hover:text-[#3b82f6] transition-colors"
                        >
                            Popular
                        </Link>
                    ) : (
                        "Popular"
                    )}
                </h2>
                {onAddAllToQueue && (
                    <button
                        onClick={() => onAddAllToQueue(visibleTracks)}
                        className="h-7 w-7 rounded-full hover:bg-white/10 flex items-center justify-center text-white/50 hover:text-white transition-colors"
                        title="Add visible popular tracks to queue"
                    >
                        <Plus className="w-4 h-4" />
                    </button>
                )}
            </div>
            <TrackList
                items={visibleTracks}
                toRowItem={toRowItem}
                onPlay={handlePlay}
                rowSlots={rowSlots}
                rowClassName="grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(80px,1fr)_auto]"
                preferenceMode="both"
                tvSection="tracks"
            />
            {canExpand && (
                <button
                    onClick={() => setExpanded((prev) => !prev)}
                    className="mt-2 flex items-center gap-1 text-sm text-gray-400 hover:text-white transition-colors"
                >
                    {expanded ? (
                        <>
                            <ChevronUp className="w-4 h-4" />
                            Show less
                        </>
                    ) : (
                        <>
                            <ChevronDown className="w-4 h-4" />
                            See more
                        </>
                    )}
                </button>
            )}
        </section>
    );
};
